/**
 * Policy-change propagation to live sessions (Phase 7 P7-A; POLICY_ENGINE.md §5.3,
 * API_ARCHITECTURE.md "Session-enforcement API contract").
 *
 * 1. Candidate open sessions (`authorized|active`) are those a target of the changed policy /
 *    assignment can reach (every open session when the organization default is involved).
 * 2. Each candidate is re-resolved with the subject facts stored at authorize
 *    (`policy_translations.input_snapshot.facts`; older rows fall back to the session columns)
 *    and is affected when the resolution hash differs from the hash stored at authorize.
 * 3. Per affected session a strategy is chosen from the NAS adapter's evidence
 *    (`chooseEnforcementStrategy`): today always `next_reauth` (or `none` for a NAS without an
 *    engine adapter) because no CoA / Disconnect is lab-validated (D-006, D-028 V12).
 * 4. `propagateImpact` records one `session_enforcement` row per affected session (superseding a
 *    pending one), outbox `policy.changed` + `session.enforcement_pending`, and one audit row —
 *    all in the caller's tenant transaction, i.e. atomically with the change itself.
 *
 * Runs inside `withTenant()` (RLS scopes every query).
 */
import { dynamicAuthorizationEvidence } from '@ecloud/adapters';
import {
  lockSessionEnforcement,
  triggersOf,
  type DbTransaction,
  type SessionEnforcementTrigger,
} from '@ecloud/db';
import {
  ENFORCEMENT_STRATEGIES,
  chooseEnforcementStrategy,
  expectedReauthBy,
  resolveEffectivePolicy,
  type EnforcementStrategy,
  type PolicyIntent,
  type ResolutionInput,
  type Subject,
} from '@ecloud/policy-engine';
import { newId } from '@ecloud/shared';
import { sql } from 'kysely';
import { writeAudit } from './audit.js';
import type { AppDeps, RequestContext } from './context.js';
import { loadResolutionInput } from './policy-data.js';

/** Upper bound of sessions re-resolved for one change (pilot scale; flagged when reached). */
export const MAX_EVALUATED_SESSIONS = 2000;

export type ImpactScope =
  | { readonly kind: 'all' }
  | {
      readonly kind: 'targets';
      readonly userIds: readonly string[];
      readonly groupIds: readonly string[];
      readonly deviceIds: readonly string[];
      readonly batchIds: readonly string[];
      readonly siteIds: readonly string[];
    };

const EMPTY_TARGETS = {
  kind: 'targets' as const,
  userIds: [],
  groupIds: [],
  deviceIds: [],
  batchIds: [],
  siteIds: [],
};

export interface AssignmentTarget {
  readonly target_type: string;
  readonly user_id?: string | null;
  readonly user_group_id?: string | null;
  readonly client_device_id?: string | null;
  readonly voucher_batch_id?: string | null;
  readonly site_id?: string | null;
}

export function scopeOfAssignments(assignments: readonly AssignmentTarget[]): ImpactScope {
  const userIds = new Set<string>();
  const groupIds = new Set<string>();
  const deviceIds = new Set<string>();
  const batchIds = new Set<string>();
  const siteIds = new Set<string>();
  for (const a of assignments) {
    if (a.target_type === 'user' && a.user_id) userIds.add(a.user_id);
    else if (a.target_type === 'user_group' && a.user_group_id) groupIds.add(a.user_group_id);
    else if (a.target_type === 'client_device' && a.client_device_id)
      deviceIds.add(a.client_device_id);
    else if (a.target_type === 'voucher_batch' && a.voucher_batch_id)
      batchIds.add(a.voucher_batch_id);
    else if (a.target_type === 'site' && a.site_id) siteIds.add(a.site_id);
  }
  return {
    kind: 'targets',
    userIds: [...userIds],
    groupIds: [...groupIds],
    deviceIds: [...deviceIds],
    batchIds: [...batchIds],
    siteIds: [...siteIds],
  };
}

/** Scope of a policy: every assignment target, or all sessions when it is / was the default. */
export async function scopeOfPolicy(
  trx: DbTransaction,
  policyId: string,
  involvesDefault: boolean,
): Promise<ImpactScope> {
  if (involvesDefault) return { kind: 'all' };
  const assignments = await trx
    .selectFrom('policy_assignments')
    .select([
      'target_type',
      'user_id',
      'user_group_id',
      'client_device_id',
      'voucher_batch_id',
      'site_id',
    ])
    .where('policy_id', '=', policyId)
    .execute();
  return assignments.length === 0 ? EMPTY_TARGETS : scopeOfAssignments(assignments);
}

interface OpenSession {
  id: string;
  site_id: string;
  nas_client_id: string;
  user_id: string | null;
  client_device_id: string | null;
  voucher_id: string | null;
  mac: string | null;
  started_at: Date;
  status: string;
  policy_id: string | null;
  adapter_key: string | null;
  timezone: string;
  user_group_id: string | null;
  voucher_batch_id: string | null;
}

async function openSessions(trx: DbTransaction, scope: ImpactScope): Promise<OpenSession[]> {
  if (
    scope.kind === 'targets' &&
    scope.userIds.length +
      scope.groupIds.length +
      scope.deviceIds.length +
      scope.batchIds.length +
      scope.siteIds.length ===
      0
  ) {
    return [];
  }
  let q = trx
    .selectFrom('sessions as s')
    .innerJoin('nas_clients as n', 'n.id', 's.nas_client_id')
    .innerJoin('sites as st', 'st.id', 's.site_id')
    .leftJoin('users as u', 'u.id', 's.user_id')
    .leftJoin('vouchers as v', 'v.id', 's.voucher_id')
    .select([
      's.id',
      's.site_id',
      's.nas_client_id',
      's.user_id',
      's.client_device_id',
      's.voucher_id',
      's.mac',
      's.started_at',
      's.status',
      's.policy_id',
      'n.adapter_key',
      'st.timezone',
      'u.user_group_id',
      'v.batch_id as voucher_batch_id',
    ])
    .where('s.status', 'in', ['authorized', 'active']);
  if (scope.kind === 'targets') {
    q = q.where((eb) => {
      const ors = [];
      if (scope.userIds.length > 0) ors.push(eb('s.user_id', 'in', [...scope.userIds]));
      if (scope.groupIds.length > 0) ors.push(eb('u.user_group_id', 'in', [...scope.groupIds]));
      if (scope.deviceIds.length > 0)
        ors.push(eb('s.client_device_id', 'in', [...scope.deviceIds]));
      if (scope.batchIds.length > 0) ors.push(eb('v.batch_id', 'in', [...scope.batchIds]));
      if (scope.siteIds.length > 0) ors.push(eb('s.site_id', 'in', [...scope.siteIds]));
      return eb.or(ors);
    });
  }
  return q.orderBy('s.started_at').orderBy('s.id').execute();
}

/** What AAA stored for a session at authorize (`policy_translations`, trigger `authorize`). */
export interface AuthorizeSnapshot {
  hash: string | null;
  facts: Record<string, unknown> | null;
  effective: Record<string, unknown> | null;
  emitted: Record<string, unknown>[];
  unsupported: Record<string, unknown>[];
  adapterKey: string | null;
  adapterVersion: string | null;
  policyId: string | null;
  policyVersion: number | null;
  createdAt: Date;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function asList(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v)
    ? v.filter((x) => asRecord(x) !== null).map((x) => x as Record<string, unknown>)
    : [];
}

export async function loadAuthorizeSnapshots(
  trx: DbTransaction,
  sessionIds: readonly string[],
): Promise<Map<string, AuthorizeSnapshot>> {
  const out = new Map<string, AuthorizeSnapshot>();
  if (sessionIds.length === 0) return out;
  const rows = await trx
    .selectFrom('policy_translations')
    .select([
      'session_id',
      'input_snapshot',
      'emitted',
      'unsupported',
      'adapter_type_key',
      'adapter_version',
      'policy_id',
      'policy_version',
      'created_at',
    ])
    .where('session_id', 'in', [...sessionIds])
    .where('trigger', '=', 'authorize')
    .orderBy('created_at')
    .execute();
  for (const r of rows) {
    if (r.session_id === null) continue;
    const snap = asRecord(r.input_snapshot);
    out.set(r.session_id, {
      hash: typeof snap?.hash === 'string' ? snap.hash : null,
      facts: asRecord(snap?.facts),
      effective: asRecord(snap?.effective),
      emitted: asList(r.emitted),
      unsupported: asList(r.unsupported),
      adapterKey: r.adapter_type_key,
      adapterVersion: r.adapter_version,
      policyId: r.policy_id,
      policyVersion: r.policy_version,
      createdAt: r.created_at,
    });
  }
  return out;
}

/** Session-Timeout value actually sent to the NAS at authorize (non-experimental), else null. */
export function sessionTimeoutSent(snapshot: AuthorizeSnapshot | undefined): number | null {
  const a = snapshot?.emitted.find((x) => x.name === 'Session-Timeout' && x.experimental !== true);
  const v = a === undefined ? null : Number(a.value);
  return v !== null && Number.isFinite(v) && v > 0 ? v : null;
}

async function subjectOf(
  trx: DbTransaction,
  s: OpenSession,
  facts: Record<string, unknown> | null,
): Promise<Subject | null> {
  const kind =
    typeof facts?.subject_kind === 'string'
      ? facts.subject_kind
      : s.voucher_id !== null
        ? 'voucher'
        : s.user_id !== null
          ? 'user'
          : s.client_device_id !== null
            ? 'client_device'
            : null;
  if (kind === 'user' && s.user_id !== null) return { kind: 'user', user_id: s.user_id };
  if (kind === 'client_device' && s.client_device_id !== null)
    return { kind: 'client_device', client_device_id: s.client_device_id };
  if (kind === 'voucher' && s.voucher_id !== null) {
    const v = await trx
      .selectFrom('vouchers as v')
      .innerJoin('voucher_batches as b', 'b.id', 'v.batch_id')
      .select([
        'v.bound_user_id',
        'v.expires_at',
        'v.activated_at',
        'b.id as batch_id',
        'b.duration_s',
        'b.valid_from',
        'b.valid_until',
      ])
      .where('v.id', '=', s.voucher_id)
      .executeTakeFirst();
    if (v === undefined) return null;
    return {
      kind: 'voucher',
      user_id: v.bound_user_id,
      voucher: {
        batch_id: v.batch_id,
        expires_at: v.expires_at,
        activated_at: v.activated_at,
        duration_s: v.duration_s,
        batch_valid_from: v.valid_from,
        batch_valid_until: v.valid_until,
      },
    };
  }
  return null;
}

export interface ImpactedSession {
  readonly session_id: string;
  readonly site_id: string;
  readonly nas_client_id: string;
  readonly adapter_key: string | null;
  readonly strategy: EnforcementStrategy;
  readonly state: 'pending' | 'unsupported';
  readonly reason: string;
  readonly previous_hash: string | null;
  /** Null for a session beyond the evaluation cap (not re-resolved, treated as affected). */
  readonly target_hash: string | null;
  readonly policy_id: string | null;
  readonly expected_apply_by: Date | null;
  /** True when the session was not re-resolved because the cap was reached (review fix 3). */
  readonly unevaluated: boolean;
}

export interface Impact {
  readonly evaluated: number;
  /** Re-resolved and changed, plus every session beyond the cap (conservatively affected). */
  readonly affected: readonly ImpactedSession[];
  /** Evaluated sessions whose effective result equals their authorize snapshot again. */
  readonly unaffected: readonly string[];
  /** Sessions in scope beyond the cap: never dropped, recorded as affected without resolution. */
  readonly unevaluated: number;
  readonly truncated: boolean;
  readonly byStrategy: Readonly<Record<EnforcementStrategy, number>>;
  /** Longest wait until a `next_reauth` change applies (s from now), when every one is bounded. */
  readonly maxApplyLatencyS: number | null;
}

export interface ImpactOptions {
  readonly organizationId: string;
  readonly now: Date;
  readonly scope: ImpactScope;
  /** Policy that changed: a session without a stored hash is affected only when bound to it. */
  readonly policyId?: string | null;
  /** Preview: rewrite the loaded facts (e.g. substitute the proposed policy) before resolving. */
  readonly transform?: (input: ResolutionInput) => ResolutionInput;
  readonly coaEnabled: boolean;
  /** Re-resolution cap (default MAX_EVALUATED_SESSIONS; `ENFORCEMENT_MAX_SESSIONS`). */
  readonly maxSessions?: number;
}

function strategyOf(adapterKey: string | null, coaEnabled: boolean) {
  const evidence = dynamicAuthorizationEvidence(adapterKey);
  return chooseEnforcementStrategy({
    adapterKey: evidence === null ? null : adapterKey,
    coaChange: evidence?.coaChange ?? null,
    disconnect: evidence?.disconnect ?? null,
    dispatcherEnabled: coaEnabled,
  });
}

/** Cache key of `loadResolutionInput` (review fix 2): everything it reads except the MAC. */
function inputKey(s: OpenSession, subject: Subject, groupIds: readonly string[]): string {
  const subjectKey =
    subject.kind === 'user'
      ? `user:${subject.user_id}`
      : subject.kind === 'client_device'
        ? `device:${subject.client_device_id}`
        : `voucher:${s.voucher_id ?? ''}`;
  return [
    s.site_id,
    s.timezone,
    subjectKey,
    s.client_device_id ?? '',
    [...groupIds].sort().join(','),
    s.voucher_batch_id ?? '',
  ].join('|');
}

export async function computeImpact(trx: DbTransaction, opts: ImpactOptions): Promise<Impact> {
  const max = Math.max(1, opts.maxSessions ?? MAX_EVALUATED_SESSIONS);
  const sessions = await openSessions(trx, opts.scope);
  const truncated = sessions.length > max;
  const evaluated = truncated ? sessions.slice(0, max) : sessions;
  const remainder = truncated ? sessions.slice(max) : [];
  const snapshots = await loadAuthorizeSnapshots(
    trx,
    sessions.map((s) => s.id),
  );
  const cache = new Map<string, ResolutionInput>();
  const affected: ImpactedSession[] = [];
  const unaffected: string[] = [];
  for (const s of evaluated) {
    const snap = snapshots.get(s.id);
    const subject = await subjectOf(trx, s, snap?.facts ?? null);
    if (subject === null) continue;
    const groupIds = s.user_group_id === null ? [] : [s.user_group_id];
    const key = inputKey(s, subject, groupIds);
    let base = cache.get(key);
    if (base === undefined) {
      base = await loadResolutionInput(trx, {
        organizationId: opts.organizationId,
        siteId: s.site_id,
        timeZone: s.timezone,
        now: opts.now,
        subject,
        clientDeviceId: s.client_device_id,
        mac: s.mac,
        groupIds,
        voucherBatchId: s.voucher_batch_id,
      });
      cache.set(key, base);
    }
    const loaded: ResolutionInput = { ...base, mac: s.mac };
    const input = opts.transform ? opts.transform(loaded) : loaded;
    const resolution = resolveEffectivePolicy({ ...input, trigger: 'preview' });
    const previous = snap?.hash ?? null;
    const target = resolution.snapshot.hash;
    const isAffected =
      previous === null
        ? opts.policyId !== undefined && opts.policyId !== null && s.policy_id === opts.policyId
        : previous !== target;
    if (!isAffected) {
      if (previous !== null) unaffected.push(s.id);
      continue;
    }
    const decision = strategyOf(s.adapter_key, opts.coaEnabled);
    affected.push({
      session_id: s.id,
      site_id: s.site_id,
      nas_client_id: s.nas_client_id,
      adapter_key: s.adapter_key,
      strategy: decision.strategy,
      state: decision.state,
      reason: decision.reason,
      previous_hash: previous,
      target_hash: target,
      policy_id: resolution.snapshot.policy_id,
      expected_apply_by:
        decision.strategy === 'next_reauth'
          ? expectedReauthBy(s.started_at, sessionTimeoutSent(snap))
          : null,
      unevaluated: false,
    });
  }
  // Review fix 3: sessions beyond the cap are never dropped. They are not re-resolved; they are
  // treated as affected (conservative: the next authorization resolves the current policy anyway).
  for (const s of remainder) {
    const snap = snapshots.get(s.id);
    const decision = strategyOf(s.adapter_key, opts.coaEnabled);
    affected.push({
      session_id: s.id,
      site_id: s.site_id,
      nas_client_id: s.nas_client_id,
      adapter_key: s.adapter_key,
      strategy: decision.strategy,
      state: decision.state,
      reason: `not re-resolved (propagation cap ${String(max)} reached), treated as affected; ${decision.reason}`,
      previous_hash: snap?.hash ?? null,
      target_hash: null,
      policy_id: null,
      expected_apply_by:
        decision.strategy === 'next_reauth'
          ? expectedReauthBy(s.started_at, sessionTimeoutSent(snap))
          : null,
      unevaluated: true,
    });
  }
  const byStrategy = Object.fromEntries(ENFORCEMENT_STRATEGIES.map((k) => [k, 0])) as Record<
    EnforcementStrategy,
    number
  >;
  for (const a of affected) byStrategy[a.strategy] += 1;
  const reauth = affected.filter((a) => a.strategy === 'next_reauth');
  const unbounded = reauth.some((a) => a.expected_apply_by === null);
  const maxApplyLatencyS =
    reauth.length === 0 || unbounded
      ? null
      : Math.max(
          0,
          ...reauth.map((a) =>
            Math.ceil(((a.expected_apply_by as Date).getTime() - opts.now.getTime()) / 1000),
          ),
        );
  return {
    evaluated: evaluated.length,
    affected,
    unaffected,
    unevaluated: remainder.length,
    truncated,
    byStrategy,
    maxApplyLatencyS,
  };
}

/** Preview transform: substitute (or drop) one policy everywhere it appears in the loaded facts. */
export function substitutePolicy(
  policyId: string,
  proposed: PolicyIntent | null,
): (input: ResolutionInput) => ResolutionInput {
  return (input) => {
    const candidates = input.candidates.flatMap((c) =>
      c.policy.id !== policyId ? [c] : proposed === null ? [] : [{ ...c, policy: proposed }],
    );
    let defaultPolicy = input.default_policy ?? null;
    if (defaultPolicy?.id === policyId)
      defaultPolicy = proposed !== null && proposed.is_default ? proposed : null;
    else if (proposed?.is_default === true) defaultPolicy = proposed;
    return { ...input, candidates, default_policy: defaultPolicy };
  };
}

export interface PropagationSummary {
  readonly change_id: string | null;
  readonly evaluated_sessions: number;
  readonly affected_sessions: number;
  readonly by_strategy: Readonly<Record<EnforcementStrategy, number>>;
  /** Pending policy-change rows closed because the session is back to its authorize snapshot. */
  readonly reverted_sessions: number;
  /** Affected sessions whose pending runtime-breach row absorbed this change (not superseded). */
  readonly merged_sessions: number;
  /** Sessions beyond the cap, recorded as affected without re-resolution. */
  readonly unevaluated_sessions: number;
  readonly truncated: boolean;
  /** Set when propagation was skipped because nothing enforcement-relevant changed. */
  readonly skipped?: string;
}

const ZERO_STRATEGIES = Object.fromEntries(ENFORCEMENT_STRATEGIES.map((k) => [k, 0])) as Record<
  EnforcementStrategy,
  number
>;

/** Summary of a mutation that cannot change any session's effective result (review fix 2). */
export function skippedPropagation(reason: string): PropagationSummary {
  return {
    change_id: null,
    evaluated_sessions: 0,
    affected_sessions: 0,
    by_strategy: ZERO_STRATEGIES,
    reverted_sessions: 0,
    merged_sessions: 0,
    unevaluated_sessions: 0,
    truncated: false,
    skipped: reason,
  };
}

/** Triggers of `session_enforcement` rows written by policy / assignment changes. */
const POLICY_TRIGGERS: readonly SessionEnforcementTrigger[] = [
  'policy_update',
  'policy_delete',
  'assignment_create',
  'assignment_delete',
];
const RUNTIME_TRIGGERS = ['quota_breach', 'schedule_end', 'concurrency'];

export interface PropagateOptions {
  readonly organizationId: string;
  readonly trigger: SessionEnforcementTrigger;
  readonly policyId: string | null;
  readonly targetType: 'policy' | 'policy_assignment';
  readonly targetId: string;
  readonly now: Date;
}

const INSERT_CHUNK = 500;

function chunks<T>(list: readonly T[], size = INSERT_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/**
 * Records an impact (rows, outbox, audit) in the caller's tenant transaction. Per affected
 * session: a pending policy-change row is superseded by the new one; a pending row that carries
 * a runtime breach (quota / schedule / concurrency) is KEPT and the change is merged into its
 * `detail.triggers` / `detail.policy_changes` (review fix 1). Serialised per session with the
 * worker writer by advisory locks (review fix 4); inserts are batched.
 */
export async function propagateImpact(
  trx: DbTransaction,
  ctx: RequestContext,
  impact: Impact,
  opts: PropagateOptions,
): Promise<PropagationSummary> {
  const changeId = newId();
  const affectedIds = impact.affected.map((a) => a.session_id);
  await lockSessionEnforcement(trx, [...affectedIds, ...impact.unaffected]);

  // A change that brings a session back to the policy it was authorized with closes its pending
  // policy-change row (nothing left to apply). Rows carrying a runtime breach are not touched.
  const reverted =
    impact.unaffected.length === 0
      ? []
      : await trx
          .updateTable('session_enforcement')
          .set({
            state: 'superseded',
            resolved_at: opts.now,
            detail: sql`detail || ${JSON.stringify({ resolution: 'reverted', change_id: changeId })}::jsonb`,
          })
          .where('session_id', 'in', [...impact.unaffected])
          .where('state', '=', 'pending')
          .where('trigger', 'in', [...POLICY_TRIGGERS])
          .where(
            sql<boolean>`NOT coalesce(detail->'triggers', '[]'::jsonb) ?| ${sql.val(RUNTIME_TRIGGERS)}::text[]`,
          )
          .returning('session_id')
          .execute();

  let merged = 0;
  const toInsert: ImpactedSession[] = [];
  if (affectedIds.length > 0) {
    const pending = await trx
      .selectFrom('session_enforcement')
      .select(['id', 'session_id', 'trigger', 'detail'])
      .where('session_id', 'in', affectedIds)
      .where('state', '=', 'pending')
      .execute();
    const bySession = new Map(pending.map((p) => [p.session_id, p]));
    const supersede: string[] = [];
    for (const a of impact.affected) {
      const p = bySession.get(a.session_id);
      if (p === undefined) {
        toInsert.push(a);
        continue;
      }
      const triggers = triggersOf(p.trigger, p.detail);
      if (triggers.some((t) => RUNTIME_TRIGGERS.includes(t))) {
        const change = {
          change_id: changeId,
          trigger: opts.trigger,
          policy_id: opts.policyId,
          target_hash: a.target_hash,
          at: opts.now.toISOString(),
        };
        await trx
          .updateTable('session_enforcement')
          .set({
            detail: sql`detail || ${JSON.stringify({ triggers: [...new Set([...triggers, opts.trigger])] })}::jsonb || jsonb_build_object('policy_changes', coalesce(detail->'policy_changes', '[]'::jsonb) || ${JSON.stringify([change])}::jsonb)`,
          })
          .where('id', '=', p.id)
          .execute();
        merged += 1;
      } else {
        supersede.push(p.id);
        toInsert.push(a);
      }
    }
    for (const ids of chunks(supersede)) {
      await trx
        .updateTable('session_enforcement')
        .set({ state: 'superseded', resolved_at: opts.now })
        .where('id', 'in', ids)
        .execute();
    }
  }

  const summary: PropagationSummary = {
    change_id: changeId,
    evaluated_sessions: impact.evaluated,
    affected_sessions: impact.affected.length,
    by_strategy: impact.byStrategy,
    reverted_sessions: reverted.length,
    merged_sessions: merged,
    unevaluated_sessions: impact.unevaluated,
    truncated: impact.truncated,
  };
  if (impact.affected.length === 0 && reverted.length === 0) return summary;

  const createdBy =
    ctx.principal?.kind === 'admin' && ctx.principal.impersonation === null
      ? ctx.principal.administratorId
      : null;
  for (const batch of chunks(toInsert)) {
    await trx
      .insertInto('session_enforcement')
      .values(
        batch.map((a) => ({
          organization_id: opts.organizationId,
          session_id: a.session_id,
          change_id: changeId,
          trigger: opts.trigger,
          strategy: a.strategy,
          state: a.state,
          reason: a.reason.slice(0, 1000),
          policy_id: opts.policyId,
          previous_hash: a.previous_hash,
          target_hash: a.target_hash,
          detail: JSON.stringify({
            triggers: [opts.trigger],
            resolved_winner_policy_id: a.policy_id,
            ...(a.unevaluated ? { unevaluated: true, truncated: true } : {}),
          }),
          expected_apply_by: a.expected_apply_by,
          created_by: createdBy,
          resolved_at: a.state === 'pending' ? null : opts.now,
        })),
      )
      .execute();
  }
  for (const batch of chunks(impact.affected)) {
    await trx
      .insertInto('outbox')
      .values(
        batch.map((a) => ({
          organization_id: opts.organizationId,
          event: 'session.enforcement_pending',
          request_id: ctx.requestId,
          payload: JSON.stringify({
            site_id: a.site_id,
            data: {
              session_id: a.session_id,
              change_id: changeId,
              trigger: opts.trigger,
              strategy: a.strategy,
              state: a.state,
              reason: a.reason,
              unevaluated: a.unevaluated,
              expected_apply_by: a.expected_apply_by?.toISOString() ?? null,
            },
          }),
        })),
      )
      .execute();
  }
  await trx
    .insertInto('outbox')
    .values({
      organization_id: opts.organizationId,
      event: 'policy.changed',
      request_id: ctx.requestId,
      payload: JSON.stringify({
        site_id: null,
        data: {
          ...summary,
          trigger: opts.trigger,
          policy_id: opts.policyId,
          target_type: opts.targetType,
          target_id: opts.targetId,
        },
      }),
    })
    .execute();
  await writeAudit(trx, ctx, {
    organizationId: opts.organizationId,
    action: 'session_enforcement:propagate',
    targetType: opts.targetType,
    targetId: opts.targetId,
    after: { ...summary, trigger: opts.trigger, policy_id: opts.policyId },
  });
  return summary;
}

/** `computeImpact` + `propagateImpact` for a mutation handler. */
export async function propagateChange(
  trx: DbTransaction,
  deps: AppDeps,
  ctx: RequestContext,
  opts: PropagateOptions & { readonly scope: ImpactScope },
): Promise<PropagationSummary> {
  const impact = await computeImpact(trx, {
    organizationId: opts.organizationId,
    now: opts.now,
    scope: opts.scope,
    policyId: opts.policyId,
    coaEnabled: deps.config.coaEnabled,
    maxSessions: deps.config.enforcementMaxSessions,
  });
  return propagateImpact(trx, ctx, impact, opts);
}
