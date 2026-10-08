/**
 * Runtime enforcement loop, ECLOUD side (Phase 7 P7-A; POLICY_ENGINE.md §5.1–5.4, D-028 staged
 * items 6–8: quotas, concurrency, schedules).
 *
 * - `recordRuntimeEnforcement`: one `session_enforcement` row per (session, breach trigger) while
 *   pending, strategy from the NAS adapter's evidence (`chooseEnforcementStrategy`: `next_reauth`
 *   today — no Disconnect / CoA is lab-validated, D-006), outbox `session.enforcement_pending`.
 * - `enforceRuntimeLimits`: schedule end (an open session whose authorize-time schedule window has
 *   closed) and late-detected concurrency (racing authorizations over `max_concurrent_sessions` /
 *   `max_devices`, §5.1) → pending `next_reauth`; the next Access-Request is then rejected by the
 *   resolver (schedule / concurrency) — the device-side Session-Timeout (clipped to the window end
 *   at authorize) is the only thing that ends the live session before that.
 * - `resolveClosedEnforcement`: a pending row whose session has ended becomes `applied` (the next
 *   authorization resolves the current policy).
 * All writes go through `withPlatform(…, 'worker:policy.enforce')`.
 */
import { dynamicAuthorizationEvidence } from '@ecloud/adapters';
import {
  lockSessionEnforcement,
  triggersOf,
  withPlatform,
  type Db,
  type DbTransaction,
  type SessionEnforcementTrigger,
} from '@ecloud/db';
import {
  ScheduleSchema,
  chooseEnforcementStrategy,
  expectedReauthBy,
  isInWindow,
  type StrategyDecision,
} from '@ecloud/policy-engine';
import { newId, type Logger } from '@ecloud/shared';
import { sql } from 'kysely';
import { emitEvent } from '../events.js';

export const RUNTIME_ENFORCE_REASON = 'worker:policy.enforce';

export function strategyFor(adapterKey: string | null, coaEnabled: boolean): StrategyDecision {
  const evidence = dynamicAuthorizationEvidence(adapterKey);
  return chooseEnforcementStrategy({
    adapterKey: evidence === null ? null : adapterKey,
    coaChange: evidence?.coaChange ?? null,
    disconnect: evidence?.disconnect ?? null,
    dispatcherEnabled: coaEnabled,
  });
}

interface AuthorizeSnapshotRow {
  emitted: unknown;
  input_snapshot: unknown;
}

async function authorizeSnapshot(
  trx: DbTransaction,
  sessionId: string,
): Promise<AuthorizeSnapshotRow | undefined> {
  return trx
    .selectFrom('policy_translations')
    .select(['emitted', 'input_snapshot'])
    .where('session_id', '=', sessionId)
    .where('trigger', '=', 'authorize')
    .orderBy('created_at', 'desc')
    .executeTakeFirst();
}

/** Non-experimental Session-Timeout value sent at authorize, else null. */
export function sentSessionTimeout(emitted: unknown): number | null {
  if (!Array.isArray(emitted)) return null;
  for (const a of emitted as Record<string, unknown>[]) {
    if (a?.name === 'Session-Timeout' && a.experimental !== true) {
      const v = Number(a.value);
      return Number.isFinite(v) && v > 0 ? v : null;
    }
  }
  return null;
}

export interface RuntimeEnforcementInput {
  organizationId: string;
  siteId: string;
  sessionId: string;
  startedAt: Date;
  adapterKey: string | null;
  trigger: Extract<SessionEnforcementTrigger, 'quota_breach' | 'schedule_end' | 'concurrency'>;
  /** What was breached, e.g. "quota_daily: 1200 >= 1000 bytes". */
  breach: string;
  policyId: string | null;
  coaEnabled: boolean;
  detail?: Record<string, unknown>;
  now: Date;
}

/**
 * Records a runtime breach on the session's single pending row (review fix 1):
 * - no pending row → insert one (`detail.triggers = [trigger]`) + outbox event;
 * - a pending row exists (any trigger: quota, schedule, concurrency or a policy change) → it is
 *   KEPT; the trigger is merged into `detail.triggers` and `detail.breaches`; the outbox event is
 *   emitted only when the trigger set actually changed. Nothing is ever superseded here, so
 *   simultaneous breaches cannot ping-pong and a pending policy change is never lost.
 * Serialised per session with the API writer (advisory lock, review fix 4). Returns true when the
 * trigger set changed (new row or new trigger).
 */
export async function recordRuntimeEnforcement(
  trx: DbTransaction,
  input: RuntimeEnforcementInput,
): Promise<boolean> {
  await lockSessionEnforcement(trx, [input.sessionId]);
  const existing = await trx
    .selectFrom('session_enforcement')
    .select(['id', 'change_id', 'trigger', 'strategy', 'detail'])
    .where('session_id', '=', input.sessionId)
    .where('state', '=', 'pending')
    .executeTakeFirst();
  if (existing !== undefined) {
    const triggers = triggersOf(existing.trigger, existing.detail);
    if (triggers.includes(input.trigger)) return false;
    const merged = [...triggers, input.trigger];
    await trx
      .updateTable('session_enforcement')
      .set({
        detail: sql`detail || ${JSON.stringify({ triggers: merged })}::jsonb || jsonb_build_object('breaches', coalesce(detail->'breaches', '[]'::jsonb) || ${JSON.stringify([{ trigger: input.trigger, breach: input.breach, at: input.now.toISOString(), ...(input.detail ?? {}) }])}::jsonb)`,
      })
      .where('id', '=', existing.id)
      .execute();
    await emitEvent(trx, 'session.enforcement_pending', input.organizationId, input.siteId, {
      session_id: input.sessionId,
      change_id: existing.change_id,
      trigger: input.trigger,
      triggers: merged,
      strategy: existing.strategy,
      state: 'pending',
      reason: input.breach,
    });
    return true;
  }
  const decision = strategyFor(input.adapterKey, input.coaEnabled);
  const snapshot = await authorizeSnapshot(trx, input.sessionId);
  const expected =
    decision.strategy === 'next_reauth'
      ? expectedReauthBy(input.startedAt, sentSessionTimeout(snapshot?.emitted))
      : null;
  const reason = `${input.breach}; ${decision.reason}`.slice(0, 1000);
  const changeId = newId();
  await trx
    .insertInto('session_enforcement')
    .values({
      organization_id: input.organizationId,
      session_id: input.sessionId,
      change_id: changeId,
      trigger: input.trigger,
      strategy: decision.strategy,
      state: decision.state,
      reason,
      policy_id: input.policyId,
      detail: JSON.stringify({
        triggers: [input.trigger],
        breach: input.breach,
        breaches: [{ trigger: input.trigger, breach: input.breach, at: input.now.toISOString() }],
        ...(input.detail ?? {}),
      }),
      expected_apply_by: expected,
      resolved_at: decision.state === 'pending' ? null : input.now,
    })
    .execute();
  await emitEvent(trx, 'session.enforcement_pending', input.organizationId, input.siteId, {
    session_id: input.sessionId,
    change_id: changeId,
    trigger: input.trigger,
    triggers: [input.trigger],
    strategy: decision.strategy,
    state: decision.state,
    reason,
    expected_apply_by: expected?.toISOString() ?? null,
  });
  return true;
}

export interface RuntimeDeps {
  db: Db;
  logger: Logger;
  coaEnabled: boolean;
  now?: () => Date;
  /** Restrict to one organization (tests on a shared database). */
  organizationId?: string;
}

export interface RuntimeResult {
  evaluated: number;
  scheduleEnded: number;
  concurrencyBreaches: number;
}

interface OpenRow {
  id: string;
  organization_id: string;
  site_id: string;
  user_id: string | null;
  client_device_id: string | null;
  mac: string | null;
  started_at: Date;
  policy_id: string | null;
  adapter_key: string | null;
  input_snapshot: unknown;
}

function snapshotPart(snapshot: unknown): {
  fields: Record<string, unknown>;
  schedule: unknown;
  overridden: boolean;
} {
  const s =
    typeof snapshot === 'object' && snapshot !== null ? (snapshot as Record<string, unknown>) : {};
  const eff =
    typeof s.effective === 'object' && s.effective !== null
      ? (s.effective as Record<string, unknown>)
      : {};
  const fields =
    typeof eff.fields === 'object' && eff.fields !== null
      ? (eff.fields as Record<string, unknown>)
      : {};
  const provenance =
    typeof eff.provenance === 'object' && eff.provenance !== null
      ? (eff.provenance as Record<string, Record<string, unknown>>)
      : {};
  const overridden = Object.values(provenance).some(
    (p) => p?.layer_name === 'out_of_window_override',
  );
  return { fields, schedule: eff.schedule ?? null, overridden };
}

function limit(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Schedule end and late-detected concurrency over every open (`authorized|active`) session that
 * has an authorize snapshot.
 */
export async function enforceRuntimeLimits(deps: RuntimeDeps): Promise<RuntimeResult> {
  const now = (deps.now ?? (() => new Date()))();
  const result: RuntimeResult = { evaluated: 0, scheduleEnded: 0, concurrencyBreaches: 0 };
  // Review fix 5: one organization at a time (concurrency needs all of a subject's sessions
  // together, and subjects never span organizations), so memory is bounded by the largest tenant.
  const organizations =
    deps.organizationId !== undefined
      ? [deps.organizationId]
      : (
          await withPlatform(deps.db, { reason: RUNTIME_ENFORCE_REASON, audit: false }, (trx) =>
            trx
              .selectFrom('sessions')
              .select('organization_id')
              .distinct()
              .where('status', 'in', ['authorized', 'active'])
              .execute(),
          )
        ).map((r) => r.organization_id);
  for (const organizationId of organizations) {
    await limitsForOrganization(deps, organizationId, now, result);
  }
  return result;
}

async function limitsForOrganization(
  deps: RuntimeDeps,
  organizationId: string,
  now: Date,
  result: RuntimeResult,
): Promise<void> {
  const rows = (await withPlatform(
    deps.db,
    { reason: RUNTIME_ENFORCE_REASON, audit: false },
    (trx) =>
      trx
        .selectFrom('sessions as s')
        .innerJoin('nas_clients as n', 'n.id', 's.nas_client_id')
        .innerJoin('policy_translations as t', (j) =>
          j.onRef('t.session_id', '=', 's.id').on('t.trigger', '=', 'authorize'),
        )
        .select([
          's.id',
          's.organization_id',
          's.site_id',
          's.user_id',
          's.client_device_id',
          's.mac',
          's.started_at',
          's.policy_id',
          'n.adapter_key',
          't.input_snapshot',
        ])
        .where('s.status', 'in', ['authorized', 'active'])
        .where('s.organization_id', '=', organizationId)
        .orderBy('s.started_at')
        .execute(),
  )) as OpenRow[];
  result.evaluated += rows.length;

  const breaches: {
    row: OpenRow;
    trigger: 'schedule_end' | 'concurrency';
    breach: string;
    detail: Record<string, unknown>;
  }[] = [];

  // Schedule end (§2.4): the window the session was accepted into has closed.
  for (const row of rows) {
    const part = snapshotPart(row.input_snapshot);
    if (part.schedule === null || part.overridden) continue;
    const parsed = ScheduleSchema.safeParse(part.schedule);
    if (!parsed.success) continue;
    if (isInWindow(parsed.data, now, parsed.data.timezone) !== null) continue;
    breaches.push({
      row,
      trigger: 'schedule_end',
      breach: `schedule window closed (${parsed.data.timezone}) at or before ${now.toISOString()}`,
      detail: { schedule_id: parsed.data.id ?? null },
    });
  }

  // Concurrency (§2.6, §5.1 late detection): per subject, the newest sessions beyond the limit.
  const bySubject = new Map<string, OpenRow[]>();
  for (const row of rows) {
    const key =
      row.user_id !== null
        ? `user:${row.user_id}`
        : row.client_device_id !== null
          ? `device:${row.client_device_id}`
          : null;
    if (key === null) continue;
    const list = bySubject.get(key) ?? [];
    list.push(row);
    bySubject.set(key, list);
  }
  for (const [subject, list] of bySubject) {
    // Oldest first (query order); the limits are those the newest session was authorized with.
    const newest = list[list.length - 1] as OpenRow;
    const fields = snapshotPart(newest.input_snapshot).fields;
    const maxSessions = limit(fields.max_concurrent_sessions);
    const maxDevices = limit(fields.max_devices);
    const flagged = new Set<string>();
    if (maxSessions !== null && list.length > maxSessions) {
      for (const row of list.slice(maxSessions)) {
        flagged.add(row.id);
        breaches.push({
          row,
          trigger: 'concurrency',
          breach: `concurrency: ${String(list.length)} open sessions > max_concurrent_sessions ${String(maxSessions)} (${subject})`,
          detail: { open_sessions: list.length, max_concurrent_sessions: maxSessions },
        });
      }
    }
    if (maxDevices !== null) {
      const macs: string[] = [];
      for (const row of list) {
        const mac = row.mac ?? `session:${row.id}`;
        if (!macs.includes(mac)) macs.push(mac);
      }
      if (macs.length > maxDevices) {
        const excess = new Set(macs.slice(maxDevices));
        for (const row of list) {
          if (flagged.has(row.id) || !excess.has(row.mac ?? `session:${row.id}`)) continue;
          breaches.push({
            row,
            trigger: 'concurrency',
            breach: `concurrency: ${String(macs.length)} devices > max_devices ${String(maxDevices)} (${subject})`,
            detail: { open_devices: macs.length, max_devices: maxDevices },
          });
        }
      }
    }
  }

  for (const b of breaches) {
    const recorded = await withPlatform(
      deps.db,
      { reason: RUNTIME_ENFORCE_REASON, audit: false, organizationId: b.row.organization_id },
      (trx) =>
        recordRuntimeEnforcement(trx, {
          organizationId: b.row.organization_id,
          siteId: b.row.site_id,
          sessionId: b.row.id,
          startedAt: b.row.started_at,
          adapterKey: b.row.adapter_key,
          trigger: b.trigger,
          breach: b.breach,
          policyId: b.row.policy_id,
          coaEnabled: deps.coaEnabled,
          detail: b.detail,
          now,
        }),
    );
    if (!recorded) continue;
    if (b.trigger === 'schedule_end') result.scheduleEnded += 1;
    else result.concurrencyBreaches += 1;
    deps.logger.info(
      { sessionId: b.row.id, trigger: b.trigger, breach: b.breach },
      'runtime limit breached; enforcement pending (no Disconnect issued)',
    );
  }
}

/** Pending rows of sessions that have ended → `applied` (the next authorization re-resolves). */
export async function resolveClosedEnforcement(
  db: Db,
  now: Date = new Date(),
  organizationId?: string,
): Promise<number> {
  return withPlatform(db, { reason: RUNTIME_ENFORCE_REASON, audit: false }, async (trx) => {
    const updated = await trx
      .updateTable('session_enforcement as e')
      .from('sessions as s')
      .set({
        state: 'applied',
        resolved_at: now,
        detail: sql`e.detail || jsonb_build_object('resolution', 'session_closed', 'session_status', s.status::text, 'session_stopped_at', s.stopped_at)`,
      })
      .whereRef('s.id', '=', 'e.session_id')
      .where('e.state', '=', 'pending')
      .where('s.status', 'in', ['stopped', 'expired'])
      .$if(organizationId !== undefined, (q) =>
        q.where('e.organization_id', '=', organizationId as string),
      )
      .returning('e.id')
      .execute();
    return updated.length;
  });
}
