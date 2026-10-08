/**
 * Quota re-evaluation and breach handling (POLICY_ENGINE.md §2.5, §5.1, §5.2).
 *
 * D-006: Disconnect is REQUIRES_DEVICE_TEST everywhere. A breach enqueues `coa.disconnect`
 * only when ECLOUD_COA_ENABLED=true AND the adapter declares a Disconnect target whose status
 * is not UNSUPPORTED / ECLOUD_SIDE_ONLY AND the NAS is not marked `coa_supported = false`.
 * Otherwise the session is marked "enforcement pending" and the NAS-side octet limit /
 * Session-Timeout plus deny-at-next-auth remain the enforcement (§5.2 right-hand column).
 */
import type { DisconnectDescription } from '@ecloud/adapters';
import { withPlatform, type Db, type UsagePeriodType } from '@ecloud/db';
import type { Logger } from '@ecloud/shared';
import { periodStarts } from '../accounting/normalize.js';
import { resolveAdapter } from '../nas-adapter.js';
import { emitEvent } from '../events.js';
import type { WorkerState } from '../infra/state.js';
import { recordRuntimeEnforcement } from './enforcement.js';

export const ENFORCE_REASON = 'worker:policy.enforce';
/** Breach markers outlive the longest period (monthly) so one breach yields one event. */
export const BREACH_MARKER_TTL_S = 40 * 24 * 3600;

export interface QuotaLimits {
  daily: number | null;
  monthly: number | null;
  total: number | null;
}

export interface PeriodUsage {
  bytesIn: number;
  bytesOut: number;
}

export type UsageByPeriod = Partial<Record<UsagePeriodType, PeriodUsage>>;

export interface QuotaBreach {
  period: UsagePeriodType;
  limit: number;
  used: number;
}

const PERIODS: readonly UsagePeriodType[] = ['daily', 'monthly', 'total'];

/** §2.5: a period is breached when bytes_in + bytes_out >= its limit. Limits <= 0 are ignored. */
export function evaluateQuota(limits: QuotaLimits, usage: UsageByPeriod): QuotaBreach[] {
  const breaches: QuotaBreach[] = [];
  for (const period of PERIODS) {
    const limit = limits[period];
    if (limit === null || limit <= 0) continue;
    const u = usage[period];
    const used = u === undefined ? 0 : u.bytesIn + u.bytesOut;
    if (used >= limit) breaches.push({ period, limit, used });
  }
  return breaches;
}

export type EnforcementDecision =
  | { action: 'disconnect' }
  | {
      action: 'pending';
      reason: 'coa_disabled' | 'disconnect_unsupported' | 'nas_coa_unsupported' | 'unknown_adapter';
    };

export function decideEnforcement(input: {
  coaEnabled: boolean;
  disconnect: Pick<DisconnectDescription, 'status' | 'target'> | null;
  nasCoaSupported: boolean | null;
}): EnforcementDecision {
  if (input.disconnect === null) return { action: 'pending', reason: 'unknown_adapter' };
  if (
    input.disconnect.target === 'none' ||
    input.disconnect.status === 'UNSUPPORTED' ||
    input.disconnect.status === 'ECLOUD_SIDE_ONLY'
  ) {
    return { action: 'pending', reason: 'disconnect_unsupported' };
  }
  if (input.nasCoaSupported === false) return { action: 'pending', reason: 'nas_coa_unsupported' };
  if (!input.coaEnabled) return { action: 'pending', reason: 'coa_disabled' };
  return { action: 'disconnect' };
}

export function describeAdapterDisconnect(adapterKey: string | null): DisconnectDescription | null {
  return resolveAdapter(adapterKey)?.describeDisconnect() ?? null;
}

export interface EnforceDeps {
  db: Db;
  state: WorkerState;
  logger: Logger;
  coaEnabled: boolean;
  /** Enqueues the dispatcher job for a committed `session_actions` row. */
  enqueueDisconnect: (sessionActionId: string) => Promise<void>;
  now?: () => Date;
}

export interface EnforceResult {
  evaluated: number;
  breaches: number;
  disconnectsQueued: number;
  pending: number;
  pendingCleared: number;
}

interface CandidateRow {
  session_id: string;
  organization_id: string;
  site_id: string;
  user_id: string | null;
  client_device_id: string | null;
  voucher_id: string | null;
  policy_id: string;
  started_at: Date;
  quota_daily_bytes: number | null;
  quota_monthly_bytes: number | null;
  quota_total_bytes: number | null;
  timezone: string;
  adapter_key: string | null;
  coa_supported: boolean | null;
}

function subjectOf(
  row: CandidateRow,
): { type: 'user' | 'client_device' | 'voucher'; id: string } | null {
  if (row.user_id !== null) return { type: 'user', id: row.user_id };
  if (row.client_device_id !== null) return { type: 'client_device', id: row.client_device_id };
  if (row.voucher_id !== null) return { type: 'voucher', id: row.voucher_id };
  return null;
}

/**
 * Re-evaluates quotas for active sessions bound to a policy (all of them, or `sessionIds`).
 * Sessions without `policy_id` are not evaluated: the binding is written at authorize time.
 */
export async function enforceQuotas(
  deps: EnforceDeps,
  sessionIds?: readonly string[],
): Promise<EnforceResult> {
  const result: EnforceResult = {
    evaluated: 0,
    breaches: 0,
    disconnectsQueued: 0,
    pending: 0,
    pendingCleared: 0,
  };
  if (sessionIds !== undefined && sessionIds.length === 0) return result;
  const now = (deps.now ?? (() => new Date()))();

  const candidates = await withPlatform(
    deps.db,
    { reason: ENFORCE_REASON, audit: false },
    (trx) => {
      let q = trx
        .selectFrom('sessions as se')
        .innerJoin('policies as p', 'p.id', 'se.policy_id')
        .innerJoin('sites as st', 'st.id', 'se.site_id')
        .innerJoin('nas_clients as n', 'n.id', 'se.nas_client_id')
        .select([
          'se.id as session_id',
          'se.organization_id',
          'se.site_id',
          'se.user_id',
          'se.client_device_id',
          'se.voucher_id',
          'p.id as policy_id',
          'se.started_at',
          'p.quota_daily_bytes',
          'p.quota_monthly_bytes',
          'p.quota_total_bytes',
          'st.timezone',
          'n.adapter_key',
          'n.coa_supported',
        ])
        .where('se.status', '=', 'active')
        .where((eb) =>
          eb.or([
            eb('p.quota_daily_bytes', 'is not', null),
            eb('p.quota_monthly_bytes', 'is not', null),
            eb('p.quota_total_bytes', 'is not', null),
          ]),
        );
      if (sessionIds !== undefined) q = q.where('se.id', 'in', [...sessionIds]);
      return q.execute();
    },
  );

  for (const row of candidates as CandidateRow[]) {
    const subject = subjectOf(row);
    if (subject === null) continue;
    result.evaluated += 1;
    const periods = periodStarts(now, row.timezone);
    const counters = await deps.db
      .selectFrom('usage_counters')
      .select(['period_type', 'period_start', 'bytes_in', 'bytes_out'])
      .where('subject_type', '=', subject.type)
      .where('subject_id', '=', subject.id)
      .where((eb) =>
        eb.or([
          eb.and([eb('period_type', '=', 'daily'), eb('period_start', '=', periods.daily)]),
          eb.and([eb('period_type', '=', 'monthly'), eb('period_start', '=', periods.monthly)]),
          eb.and([eb('period_type', '=', 'total'), eb('period_start', '=', periods.total)]),
        ]),
      )
      .execute();
    const usage: UsageByPeriod = {};
    for (const c of counters) usage[c.period_type] = { bytesIn: c.bytes_in, bytesOut: c.bytes_out };
    const breaches = evaluateQuota(
      {
        daily: row.quota_daily_bytes,
        monthly: row.quota_monthly_bytes,
        total: row.quota_total_bytes,
      },
      usage,
    );
    const fresh: QuotaBreach[] = [];
    for (const b of breaches) {
      const key = `quota:${row.session_id}:${b.period}:${periods[b.period]}`;
      if (await deps.state.markOnce(key, BREACH_MARKER_TTL_S)) fresh.push(b);
    }
    if (fresh.length === 0) continue;
    result.breaches += fresh.length;
    const first = fresh[0] as QuotaBreach;
    const decision = decideEnforcement({
      coaEnabled: deps.coaEnabled,
      disconnect: describeAdapterDisconnect(row.adapter_key),
      nasCoaSupported: row.coa_supported,
    });
    const breachText = fresh
      .map((b) => `quota_${b.period}: ${String(b.used)} >= ${String(b.limit)} bytes`)
      .join(', ');
    const runtime = {
      organizationId: row.organization_id,
      siteId: row.site_id,
      sessionId: row.session_id,
      startedAt: row.started_at,
      adapterKey: row.adapter_key,
      trigger: 'quota_breach' as const,
      breach: breachText,
      policyId: row.policy_id,
      coaEnabled: deps.coaEnabled,
      now,
    };
    const breachData = {
      session_id: row.session_id,
      subject_type: subject.type,
      subject_id: subject.id,
      policy_id: row.policy_id,
      breaches: fresh.map((b) => ({
        period: b.period,
        period_start: periods[b.period],
        limit_bytes: b.limit,
        used_bytes: b.used,
      })),
    };
    if (decision.action === 'disconnect') {
      const actionId = await withPlatform(
        deps.db,
        { reason: ENFORCE_REASON, audit: false, organizationId: row.organization_id },
        async (trx) => {
          const action = await trx
            .insertInto('session_actions')
            .values({
              organization_id: row.organization_id,
              session_id: row.session_id,
              action: 'disconnect',
              status: 'pending',
              payload: JSON.stringify({ reason: `quota_${first.period}`, trigger: 'quota' }),
            })
            .returning('id')
            .executeTakeFirstOrThrow();
          await emitEvent(trx, 'quota.exceeded', row.organization_id, row.site_id, {
            ...breachData,
            enforcement: 'disconnect',
            session_action_id: action.id,
          });
          await emitEvent(trx, 'session.disconnect_requested', row.organization_id, row.site_id, {
            session_id: row.session_id,
            session_action_id: action.id,
            reason: `quota_${first.period}`,
          });
          // The strategy relied on stays evidence-based (next_reauth: Disconnect is not
          // lab-validated); the lab-mode Disconnect is an experiment recorded alongside (D-006).
          await recordRuntimeEnforcement(trx, {
            ...runtime,
            detail: { lab_disconnect_action_id: action.id },
          });
          return action.id;
        },
      );
      await deps.enqueueDisconnect(actionId);
      result.disconnectsQueued += 1;
    } else {
      await withPlatform(
        deps.db,
        { reason: ENFORCE_REASON, audit: false, organizationId: row.organization_id },
        async (trx) => {
          await emitEvent(trx, 'quota.exceeded', row.organization_id, row.site_id, {
            ...breachData,
            enforcement: 'pending',
            pending_reason: decision.reason,
          });
          await recordRuntimeEnforcement(trx, {
            ...runtime,
            detail: { pending_reason: decision.reason },
          });
        },
      );
      await deps.state.setPending(row.session_id, {
        reason: decision.reason,
        period: first.period,
        since: now.toISOString(),
      });
      result.pending += 1;
      deps.logger.info(
        { sessionId: row.session_id, period: first.period, reason: decision.reason },
        'quota exceeded; enforcement pending (no Disconnect issued)',
      );
    }
  }

  if (sessionIds === undefined) result.pendingCleared = await clearClosedPending(deps);
  return result;
}

/** Drops "enforcement pending" marks of sessions that are no longer active. */
async function clearClosedPending(deps: EnforceDeps): Promise<number> {
  const pending = Object.keys(await deps.state.listPending());
  if (pending.length === 0) return 0;
  const active = await deps.db
    .selectFrom('sessions')
    .select('id')
    .where('id', 'in', pending)
    .where('status', '=', 'active')
    .execute();
  const stillActive = new Set(active.map((r) => r.id));
  let cleared = 0;
  for (const id of pending) {
    if (stillActive.has(id)) continue;
    await deps.state.clearPending(id);
    cleared += 1;
  }
  return cleared;
}
