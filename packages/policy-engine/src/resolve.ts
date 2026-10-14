/**
 * Policy resolution (POLICY_ENGINE.md §2): candidate ordering, single-winner field-level
 * fall-through merge, schedule / quota / concurrency / validity evaluation, snapshot + trace.
 *
 * Pure function of `(input, input.now)`: the caller (api/worker) loads rows and counters; nothing
 * here touches a database or the network.
 */
import type { AdapterFieldStatus } from '@ecloud/shared';
import {
  INTENT_COLUMNS,
  type ConcurrencyMode,
  type EnforcementFields,
  type IntentColumn,
  type PolicyIntent,
  type QuotaDirection,
  type Schedule,
} from './intent.js';
import {
  isInWindow,
  nextBoundary,
  nextLocalMidnight,
  nextLocalMonthStart,
  nextLocalWeekStart,
  secondsUntil,
  type ScheduleWindow,
} from './schedule.js';
import { snapshotHash, toJsonValue, type JsonValue } from './snapshot.js';

export const ASSIGNMENT_TARGET_TYPES = [
  'user',
  'user_group',
  'site',
  'client_device',
  'voucher_batch',
] as const;
export type AssignmentTargetType = (typeof ASSIGNMENT_TARGET_TYPES)[number];

/** One `policy_assignments` row (DATABASE_DESIGN.md §3.4). */
export interface PolicyAssignment {
  readonly id: string;
  readonly policy_id: string;
  readonly target_type: AssignmentTargetType;
  readonly user_id?: string | null;
  readonly user_group_id?: string | null;
  readonly site_id?: string | null;
  readonly client_device_id?: string | null;
  readonly voucher_batch_id?: string | null;
  readonly effective_from: Date;
  readonly effective_until: Date | null;
  readonly priority: number;
}

export interface Candidate {
  readonly assignment: PolicyAssignment;
  readonly policy: PolicyIntent;
}

/** Voucher facts the AAA identity step resolved (DATABASE_DESIGN.md §3.6). */
export interface VoucherContext {
  readonly batch_id: string;
  readonly expires_at?: Date | null;
  readonly activated_at?: Date | null;
  readonly duration_s?: number | null;
  readonly batch_valid_from?: Date | null;
  readonly batch_valid_until?: Date | null;
}

export type Subject =
  | { readonly kind: 'user'; readonly user_id: string }
  | { readonly kind: 'voucher'; readonly user_id: string | null; readonly voucher: VoucherContext }
  | { readonly kind: 'client_device'; readonly client_device_id: string };

export interface UsageBytes {
  /** Acct-Input-Octets: traffic the client uploaded. */
  readonly bytes_in: bigint;
  /** Acct-Output-Octets: traffic the client downloaded. */
  readonly bytes_out: bigint;
  /** Acct-Session-Time accumulated in this period; 0 when the caller does not track it. */
  readonly session_time_s?: bigint;
}

export type QuotaPeriod = 'daily' | 'weekly' | 'monthly' | 'total';

export type UsageCounters = Partial<Record<QuotaPeriod, UsageBytes>>;

export interface ActiveSessionRef {
  readonly id: string;
  readonly mac: string;
  readonly user_id?: string | null;
  readonly client_device_id?: string | null;
  readonly started_at: Date;
  /** Last accounting record time (for the unreported-bytes estimate, §5.1). */
  readonly last_update_at?: Date | null;
  readonly nas_client_id?: string | null;
  /** `disconnect` status of the adapter behind that session's NAS (for `disconnect_oldest`). */
  readonly disconnect_status?: AdapterFieldStatus | null;
}

export interface TenantResolutionSettings {
  /** §2.4, default 0, max 900. */
  readonly schedule_grace_s?: number;
  /** §2.5 drain-time floor, default 300. */
  readonly min_session_s?: number;
  /** §2.6, default `reject`. */
  readonly default_concurrency_mode?: ConcurrencyMode;
  /** §2.4: policy forced on top when out of window (e.g. "after-hours 1 Mbit/s"). */
  readonly out_of_window_policy?: PolicyIntent | null;
  /** §2.5 (PROPOSED): clip Session-Timeout to the next quota period reset. Default true. */
  readonly clip_session_to_quota_reset?: boolean;
}

export type ResolutionTrigger = 'authorize' | 'coa' | 'preview' | 'config_push';

export interface ResolutionInput {
  readonly now: Date;
  /** Site IANA zone (`sites.timezone`): quota reset clock; schedule fallback zone. */
  readonly timeZone: string;
  readonly organization_id: string;
  readonly site_id: string | null;
  readonly subject: Subject;
  readonly client_device_id?: string | null;
  /** `Calling-Station-Id`, any case/separator; normalised for device counting. */
  readonly mac?: string | null;
  readonly group_ids?: readonly string[];
  /** Assignments (with their policies) that may apply; the engine re-checks every filter. */
  readonly candidates: readonly Candidate[];
  /**
   * Migration 043: the platform fallback, loaded only when it is enabled. Used ONLY when no
   * candidate and no organization default applied — anything an operator chose outranks it.
   * Null when the feature is off, which restores the previous `no_policy` rejection exactly.
   */
  readonly platform_default?: PolicyIntent | null;
  /** `policies.is_default` row of the organization, synthetic lowest layer. */
  readonly default_policy?: PolicyIntent | null;
  readonly usage?: UsageCounters;
  readonly active_sessions?: readonly ActiveSessionRef[];
  readonly tenant?: TenantResolutionSettings;
  readonly trigger?: ResolutionTrigger;
}

/** Layer per POLICY_ENGINE.md §2.2 (0 = temporary … 6 = organization default). */
export const LAYERS = {
  temporary: 0,
  client_device: 1,
  user: 2,
  voucher_batch: 3,
  user_group: 4,
  site: 5,
  organization_default: 6,
  /**
   * Migration 043: the singleton fallback for a NAS nobody has configured. Deliberately the
   * last layer — anything an operator chose, at any level, outranks it.
   */
  platform_default: 7,
} as const;

export type LayerName = keyof typeof LAYERS;

export interface Provenance {
  readonly policy_id: string;
  readonly policy_version: number;
  readonly assignment_id: string | null;
  readonly layer: number;
  readonly layer_name: LayerName | 'out_of_window_override';
  readonly target_type:
    | AssignmentTargetType
    | 'organization_default'
    | 'out_of_window_override'
    | 'platform_default';
}

export type ProvenanceField = IntentColumn | 'schedule';

export interface EffectivePolicy {
  readonly fields: EnforcementFields;
  readonly schedule: Schedule | null;
  readonly provenance: Partial<Record<ProvenanceField, Provenance>>;
  /** Top-ranked candidate (`sessions.policy_id/policy_version`). */
  readonly winner: Provenance | null;
  readonly concurrency_mode: ConcurrencyMode | null;
  readonly critical_fields: readonly string[];
  /**
   * Fields resolved to "no cap" because a layer declared them unlimited (migration 039), sorted.
   * They read as `null` in `fields` — the same absence of a limit — but the distinction matters
   * to a reader: `null` not listed here means no layer had an opinion, while a field listed here
   * means a layer decided. `provenance` says which one.
   */
  readonly unlimited: readonly string[];
}

export interface Clip {
  readonly policy_session_timeout_s: number | null;
  /** Seconds until schedule window end (+ grace). */
  readonly window_end_s: number | null;
  readonly validity_end_s: number | null;
  readonly voucher_end_s: number | null;
  readonly quota_reset_s: number | null;
  /** Remaining quota bytes after subtracting active sessions' estimated unreported usage. */
  readonly remaining_octets: bigint | null;
  readonly remaining_period: QuotaPeriod | null;
  /** Seconds left on the tightest online-time allowance; null when none is set. */
  readonly remaining_time_s: number | null;
  readonly remaining_time_period: QuotaPeriod | null;
  /** §2.5 worst-case drain time, floored at `min_session_s`; null when no rate is set. */
  readonly drain_time_s: number | null;
  readonly min_session_s: number;
}

export type ControlKind =
  | 'session_timer'
  | 'schedule_end'
  | 'quota_watcher'
  | 'online_time_watcher'
  | 'quota_reduced'
  | 'concurrency'
  | 'validity_end'
  | 'voucher_expiry'
  | 'temp_policy_expiry'
  | 'config_push_fallback';

export interface EcloudSideControl {
  readonly kind: ControlKind;
  readonly at?: Date;
  readonly params?: Record<string, JsonValue>;
}

export interface SessionAction {
  readonly kind: 'disconnect';
  readonly session_id: string;
  readonly reason: 'concurrency_disconnect_oldest';
}

export type ReasonCode =
  | 'no_policy'
  | 'voucher_expired'
  | 'voucher_not_yet_valid'
  | 'schedule'
  | 'quota_daily'
  | 'quota_weekly'
  | 'quota_monthly'
  | 'quota_total'
  | 'renewal_required'
  | 'online_time_daily'
  | 'online_time_weekly'
  | 'online_time_monthly'
  | 'online_time_total'
  | 'concurrency_sessions'
  | 'concurrency_devices';

export type TraceEntry =
  | {
      readonly step: 'candidate';
      readonly order: number | null;
      readonly assignment_id: string | null;
      readonly policy_id: string;
      readonly policy_version: number;
      readonly layer: number;
      readonly layer_name: string;
      readonly included: boolean;
      readonly reason?: string;
    }
  | {
      readonly step: 'field';
      readonly field: ProvenanceField;
      readonly value: JsonValue;
      readonly policy_id: string;
      readonly policy_version: number;
      readonly assignment_id: string | null;
      readonly layer: number;
      readonly layer_name: string;
    }
  | {
      readonly step: 'schedule' | 'quota' | 'concurrency' | 'validity' | 'voucher' | 'decision';
      readonly detail: string;
      readonly data?: Record<string, JsonValue>;
    };

export interface ResolutionResult {
  readonly decision: 'accept' | 'reject';
  readonly reasonCode: ReasonCode | null;
  readonly reasonDetail: string | null;
  /**
   * Migration 043: this session was answered by the platform fallback rather than by a policy
   * anyone chose. The caller records it on the session so "which access points are serving the
   * default right now" is one predicate instead of an audit.
   */
  readonly platform_default: boolean;
  readonly effective: EffectivePolicy;
  readonly clip: Clip;
  readonly controls: readonly EcloudSideControl[];
  readonly actions: readonly SessionAction[];
  readonly trace: readonly TraceEntry[];
  readonly snapshot: {
    /** SHA-256 of canonical `{effective, provenance}`: the `policy_version` hash. */
    readonly hash: string;
    readonly policy_id: string | null;
    readonly policy_version: number | null;
  };
  readonly trigger: ResolutionTrigger;
}

const DEFAULT_MIN_SESSION_S = 300;
const MAX_GRACE_S = 900;

export function normalizeMac(mac: string): string {
  return mac.toLowerCase().replace(/[^0-9a-f]/g, '');
}

function layerOf(c: Candidate): { layer: number; name: LayerName } {
  const a = c.assignment;
  if (
    c.policy.scope_type === 'temporary' ||
    (a.effective_until !== null && (a.target_type === 'client_device' || a.target_type === 'user'))
  ) {
    return { layer: LAYERS.temporary, name: 'temporary' };
  }
  return { layer: LAYERS[a.target_type], name: a.target_type };
}

function targetMatches(a: PolicyAssignment, input: ResolutionInput): boolean {
  const subject = input.subject;
  switch (a.target_type) {
    case 'client_device': {
      const deviceId =
        input.client_device_id ??
        (subject.kind === 'client_device' ? subject.client_device_id : null);
      return deviceId !== null && deviceId !== undefined && a.client_device_id === deviceId;
    }
    case 'user': {
      const userId = subject.kind === 'client_device' ? null : subject.user_id;
      return userId !== null && userId !== undefined && a.user_id === userId;
    }
    case 'voucher_batch':
      return subject.kind === 'voucher' && a.voucher_batch_id === subject.voucher.batch_id;
    case 'user_group':
      return !!a.user_group_id && (input.group_ids ?? []).includes(a.user_group_id);
    case 'site':
      return input.site_id !== null && a.site_id === input.site_id;
    default:
      return false;
  }
}

interface RankedCandidate extends Candidate {
  readonly layer: number;
  readonly layerName: LayerName | 'out_of_window_override';
  readonly synthetic: boolean;
}

function exclusionReason(c: Candidate, input: ResolutionInput): string | null {
  const now = input.now.getTime();
  const a = c.assignment;
  const p = c.policy;
  if (!targetMatches(a, input)) return 'target_mismatch';
  if (a.effective_from.getTime() > now) return 'assignment_not_yet_effective';
  if (a.effective_until !== null && a.effective_until.getTime() <= now) return 'assignment_expired';
  if (p.status !== 'active') return `policy_status_${p.status}`;
  if (p.valid_from !== null && p.valid_from.getTime() > now) return 'policy_not_yet_valid';
  if (p.valid_until !== null && p.valid_until.getTime() <= now) return 'policy_expired';
  if (p.organization_id !== input.organization_id) return 'organization_mismatch';
  return null;
}

function compareRanked(x: RankedCandidate, y: RankedCandidate): number {
  return (
    x.assignment.priority - y.assignment.priority ||
    x.policy.priority - y.policy.priority ||
    x.layer - y.layer ||
    y.assignment.effective_from.getTime() - x.assignment.effective_from.getTime() ||
    (x.assignment.id < y.assignment.id ? -1 : x.assignment.id > y.assignment.id ? 1 : 0)
  );
}

function syntheticDefault(policy: PolicyIntent, input: ResolutionInput): RankedCandidate {
  return {
    policy,
    assignment: {
      id: `default:${policy.id}`,
      policy_id: policy.id,
      target_type: 'site',
      effective_from: new Date(0),
      effective_until: null,
      // Always the lowest layer regardless of explicit priorities (§2.2 "synthetic lowest layer").
      priority: Number.MAX_SAFE_INTEGER,
      site_id: input.site_id,
    },
    layer: LAYERS.organization_default,
    layerName: 'organization_default',
    synthetic: true,
  };
}

/** Migration 043: the platform fallback as a candidate, at the lowest layer there is. */
function platformDefaultCandidate(policy: PolicyIntent): RankedCandidate {
  return {
    policy,
    assignment: {
      id: `platform-default:${policy.id}`,
      policy_id: policy.id,
      target_type: 'site',
      effective_from: new Date(0),
      effective_until: null,
      priority: Number.MAX_SAFE_INTEGER,
      site_id: null,
    },
    layer: LAYERS.platform_default,
    layerName: 'platform_default',
    synthetic: true,
  };
}

function provenanceOf(c: RankedCandidate): Provenance {
  return {
    policy_id: c.policy.id,
    policy_version: c.policy.version,
    assignment_id: c.synthetic ? null : c.assignment.id,
    layer: c.layer,
    layer_name: c.layerName,
    target_type: c.synthetic
      ? c.layerName === 'out_of_window_override'
        ? 'out_of_window_override'
        : c.layerName === 'platform_default'
          ? 'platform_default'
          : 'organization_default'
      : c.assignment.target_type,
  };
}

function emptyFields(): EnforcementFields {
  const out: Record<string, unknown> = {};
  for (const key of INTENT_COLUMNS) out[key] = null;
  return out as unknown as EnforcementFields;
}

/** §2.3: single winner, field-level fall-through. */
export function merge(ordered: readonly RankedCandidate[], trace: TraceEntry[]): EffectivePolicy {
  const fields = emptyFields() as Record<IntentColumn, unknown>;
  const provenance: Partial<Record<ProvenanceField, Provenance>> = {};
  let schedule: Schedule | null = null;
  let concurrencyMode: ConcurrencyMode | null = null;
  const critical = new Set<string>();
  // §2.3 with the third state (migration 039). Fall-through stops at the first layer that has an
  // opinion, and declaring a field unlimited IS an opinion — otherwise a deliberate "no cap" on
  // a user policy would be silently overwritten by the group cap one layer down, which is the
  // bug this state exists to prevent.
  const resolved = new Set<IntentColumn>();
  const unlimited = new Set<string>();
  for (const c of ordered) {
    const prov = provenanceOf(c);
    const declaredUnlimited = new Set<string>(c.policy.unlimited_fields);
    for (const field of INTENT_COLUMNS) {
      if (resolved.has(field)) continue;
      const value = c.policy[field];
      if (declaredUnlimited.has(field)) {
        resolved.add(field);
        unlimited.add(field);
        provenance[field] = prov;
        trace.push({
          step: 'field',
          field,
          value: 'unlimited',
          policy_id: prov.policy_id,
          policy_version: prov.policy_version,
          assignment_id: prov.assignment_id,
          layer: prov.layer,
          layer_name: prov.layer_name,
        });
        continue;
      }
      if (value !== null) {
        resolved.add(field);
        fields[field] = value;
        provenance[field] = prov;
        trace.push({
          step: 'field',
          field,
          value: toJsonValue(value),
          policy_id: prov.policy_id,
          policy_version: prov.policy_version,
          assignment_id: prov.assignment_id,
          layer: prov.layer,
          layer_name: prov.layer_name,
        });
      }
    }
    // A layer that declares the schedule unlimited means "no time restriction here", so no
    // lower layer's schedule applies either.
    if (schedule === null && !unlimited.has('schedule_id') && c.policy.schedule !== null) {
      schedule = c.policy.schedule;
      provenance.schedule = prov;
      trace.push({
        step: 'field',
        field: 'schedule',
        value: toJsonValue(c.policy.schedule),
        policy_id: prov.policy_id,
        policy_version: prov.policy_version,
        assignment_id: prov.assignment_id,
        layer: prov.layer,
        layer_name: prov.layer_name,
      });
    }
    if (concurrencyMode === null && c.policy.concurrency_mode !== null)
      concurrencyMode = c.policy.concurrency_mode;
    for (const f of c.policy.critical_fields) critical.add(f);
  }
  // `schedule_id` without the joined schedule would be unenforceable; keep them consistent.
  if (schedule === null) fields.schedule_id = null;
  const first = ordered[0];
  return {
    fields: fields as unknown as EnforcementFields,
    schedule,
    provenance,
    winner: first ? provenanceOf(first) : null,
    concurrency_mode: concurrencyMode,
    critical_fields: [...critical].sort(),
    unlimited: [...unlimited].sort(),
  };
}

/** §2.2: filter, rank and order the candidates (with the synthetic organization default). */
export function rankCandidates(input: ResolutionInput, trace: TraceEntry[]): RankedCandidate[] {
  const ranked: RankedCandidate[] = [];
  for (const c of input.candidates) {
    const reason = exclusionReason(c, input);
    const { layer, name } = layerOf(c);
    if (reason) {
      trace.push({
        step: 'candidate',
        order: null,
        assignment_id: c.assignment.id,
        policy_id: c.policy.id,
        policy_version: c.policy.version,
        layer,
        layer_name: name,
        included: false,
        reason,
      });
      continue;
    }
    ranked.push({ ...c, layer, layerName: name, synthetic: false });
  }
  const def = input.default_policy;
  if (def) {
    const now = input.now.getTime();
    const invalid =
      def.status !== 'active'
        ? `policy_status_${def.status}`
        : def.valid_until !== null && def.valid_until.getTime() <= now
          ? 'policy_expired'
          : def.valid_from !== null && def.valid_from.getTime() > now
            ? 'policy_not_yet_valid'
            : null;
    if (invalid) {
      trace.push({
        step: 'candidate',
        order: null,
        assignment_id: null,
        policy_id: def.id,
        policy_version: def.version,
        layer: LAYERS.organization_default,
        layer_name: 'organization_default',
        included: false,
        reason: invalid,
      });
    } else {
      ranked.push(syntheticDefault(def, input));
    }
  }
  ranked.sort(compareRanked);
  ranked.forEach((c, i) =>
    trace.push({
      step: 'candidate',
      order: i,
      assignment_id: c.synthetic ? null : c.assignment.id,
      policy_id: c.policy.id,
      policy_version: c.policy.version,
      layer: c.layer,
      layer_name: c.layerName,
      included: true,
    }),
  );
  return ranked;
}

interface VoucherEvaluation {
  readonly reject: ReasonCode | null;
  readonly detail: string | null;
  readonly endsAt: Date | null;
}

function evaluateVoucher(input: ResolutionInput): VoucherEvaluation {
  if (input.subject.kind !== 'voucher') return { reject: null, detail: null, endsAt: null };
  const v = input.subject.voucher;
  const now = input.now.getTime();
  if (v.batch_valid_from && v.batch_valid_from.getTime() > now)
    return {
      reject: 'voucher_not_yet_valid',
      detail: 'voucher batch valid_from is in the future',
      endsAt: null,
    };
  const ends: Date[] = [];
  if (v.batch_valid_until) ends.push(v.batch_valid_until);
  if (v.expires_at) ends.push(v.expires_at);
  else if (v.duration_s !== null && v.duration_s !== undefined) {
    // Not yet activated: first use starts the clock now (vouchers.expires_at computed on activation).
    const base = v.activated_at ?? input.now;
    ends.push(new Date(base.getTime() + v.duration_s * 1000));
  }
  if (ends.length === 0) return { reject: null, detail: null, endsAt: null };
  const endsAt = ends.reduce((a, b) => (a.getTime() <= b.getTime() ? a : b));
  if (endsAt.getTime() <= now)
    return { reject: 'voucher_expired', detail: 'voucher validity ended', endsAt };
  return { reject: null, detail: null, endsAt };
}

interface QuotaEvaluation {
  readonly reject: ReasonCode | null;
  readonly detail: string | null;
  readonly remaining: bigint | null;
  readonly period: QuotaPeriod | null;
  readonly limits: Partial<Record<QuotaPeriod, { limit: bigint; used: bigint; remaining: bigint }>>;
}

/** Octets an allowance has consumed, per its direction (migration 036). */
function usedOctets(usage: UsageBytes, direction: QuotaDirection): bigint {
  return direction === 'upload'
    ? usage.bytes_in
    : direction === 'download'
      ? usage.bytes_out
      : usage.bytes_in + usage.bytes_out;
}

interface TimeQuotaEvaluation {
  readonly reject: ReasonCode | null;
  readonly detail: string | null;
  /** Seconds left on the tightest allowance, or null when none is set. */
  readonly remaining: number | null;
  readonly period: QuotaPeriod | null;
  readonly limits: Partial<Record<QuotaPeriod, { limit: number; used: number; remaining: number }>>;
}

/**
 * Cumulative online time (migration 036), the allowance the data quota cannot express: a guest
 * on a 2 h/day plan who downloads nothing has still used their plan.
 *
 * The counter is `usage_counters.session_time_s`, which the drain has been advancing since
 * migration 007 — summed across the subject's devices, so two phones connected at once consume
 * the allowance twice as fast. That is the behaviour an operator selling "2 hours" expects, and
 * it is the one displayed.
 *
 * Unlike the data quota there is no estimate of unreported time: the remaining allowance clips
 * Session-Timeout, so the NAS closes the session at the boundary whether or not an interim
 * update arrives first. Overshoot is therefore bounded by the NAS honouring Session-Timeout,
 * not by the accounting interval.
 */
function evaluateTimeQuota(fields: EnforcementFields, input: ResolutionInput): TimeQuotaEvaluation {
  const periods: [QuotaPeriod, number | null][] = [
    ['daily', fields.online_time_daily_s],
    ['weekly', fields.online_time_weekly_s],
    ['monthly', fields.online_time_monthly_s],
    ['total', fields.online_time_total_s],
  ];
  let remaining: number | null = null;
  let period: QuotaPeriod | null = null;
  const limits: TimeQuotaEvaluation['limits'] = {};
  for (const [p, limit] of periods) {
    if (limit === null) continue;
    const used = Number(input.usage?.[p]?.session_time_s ?? 0n);
    const left = limit - used;
    limits[p] = { limit, used, remaining: left > 0 ? left : 0 };
    if (used >= limit)
      return {
        reject: `online_time_${p}` as ReasonCode,
        detail: `${String(used)} of ${String(limit)} seconds online`,
        remaining: 0,
        period: p,
        limits,
      };
    if (remaining === null || left < remaining) {
      remaining = left;
      period = p;
    }
  }
  return { reject: null, detail: null, remaining, period, limits };
}

function evaluateQuota(
  fields: EnforcementFields,
  input: ResolutionInput,
  subjectSessions: readonly ActiveSessionRef[],
): QuotaEvaluation {
  const periods: [QuotaPeriod, bigint | null][] = [
    ['daily', fields.quota_daily_bytes],
    ['weekly', fields.quota_weekly_bytes],
    ['monthly', fields.quota_monthly_bytes],
    ['total', fields.quota_total_bytes],
  ];
  // Which octets the allowance counts (migration 036). `combined` when no layer set a direction,
  // so every policy written before this field existed keeps its previous meaning exactly.
  const direction = fields.quota_direction ?? 'combined';
  let remaining: bigint | null = null;
  let period: QuotaPeriod | null = null;
  const limits: QuotaEvaluation['limits'] = {};
  for (const [p, limit] of periods) {
    if (limit === null) continue;
    const usage = input.usage?.[p];
    const used = usage ? usedOctets(usage, direction) : 0n;
    const left = limit - used;
    limits[p] = { limit, used, remaining: left > 0n ? left : 0n };
    if (used >= limit)
      return {
        reject: `quota_${p}`,
        detail: `${used} of ${limit} bytes used`,
        remaining: 0n,
        period: p,
        limits,
      };
    if (remaining === null || left < remaining) {
      remaining = left;
      period = p;
    }
  }
  if (remaining === null)
    return { reject: null, detail: null, remaining: null, period: null, limits };
  // §5.1: subtract what active sessions may have consumed since their last accounting record.
  // Only the rate in the counted direction can consume a directional allowance.
  const countedKbps =
    direction === 'upload'
      ? (fields.upload_rate_kbps ?? 0)
      : direction === 'download'
        ? (fields.download_rate_kbps ?? 0)
        : (fields.download_rate_kbps ?? 0) + (fields.upload_rate_kbps ?? 0);
  const rateBps = countedKbps * 1000;
  let estimated = 0n;
  if (rateBps > 0) {
    for (const s of subjectSessions) {
      const since = Math.max(
        0,
        Math.floor((input.now.getTime() - (s.last_update_at ?? s.started_at).getTime()) / 1000),
      );
      const bytes = BigInt(Math.floor((rateBps / 8) * since));
      estimated += bytes < remaining ? bytes : remaining;
    }
  }
  const adjusted = remaining - estimated;
  if (adjusted <= 0n) {
    return {
      reject: `quota_${period as QuotaPeriod}`,
      detail: `remaining ${remaining} bytes fully reserved by ${subjectSessions.length} active session(s) (estimated unreported usage ${estimated})`,
      remaining: 0n,
      period,
      limits,
    };
  }
  return { reject: null, detail: null, remaining: adjusted, period, limits };
}

interface ConcurrencyEvaluation {
  readonly reject: ReasonCode | null;
  readonly detail: string | null;
  readonly actions: SessionAction[];
  readonly sessions: number;
  readonly devices: number;
}

function evaluateConcurrency(
  effective: EffectivePolicy,
  input: ResolutionInput,
  subjectSessions: readonly ActiveSessionRef[],
): ConcurrencyEvaluation {
  const f = effective.fields;
  const macs = new Set(subjectSessions.map((s) => normalizeMac(s.mac)));
  const myMac = input.mac ? normalizeMac(input.mac) : null;
  let breach: 'sessions' | 'devices' | null = null;
  if (f.max_concurrent_sessions !== null && subjectSessions.length >= f.max_concurrent_sessions)
    breach = 'sessions';
  else if (
    f.max_devices !== null &&
    (myMac === null || !macs.has(myMac)) &&
    macs.size >= f.max_devices
  )
    breach = 'devices';
  const base = { sessions: subjectSessions.length, devices: macs.size };
  if (!breach) return { reject: null, detail: null, actions: [], ...base };
  const mode = effective.concurrency_mode ?? input.tenant?.default_concurrency_mode ?? 'reject';
  if (mode === 'disconnect_oldest' && subjectSessions.length > 0) {
    const oldest = [...subjectSessions].sort(
      (a, b) => a.started_at.getTime() - b.started_at.getTime(),
    )[0];
    if (oldest && oldest.disconnect_status === 'VERIFIED_SUPPORTED') {
      return {
        reject: null,
        detail: `disconnect_oldest: session ${oldest.id}`,
        actions: [
          { kind: 'disconnect', session_id: oldest.id, reason: 'concurrency_disconnect_oldest' },
        ],
        ...base,
      };
    }
    return {
      reject: `concurrency_${breach}`,
      detail: `disconnect_oldest requested but Disconnect is not VERIFIED_SUPPORTED on the oldest session's adapter (${oldest?.disconnect_status ?? 'unknown'})`,
      actions: [],
      ...base,
    };
  }
  return {
    reject: `concurrency_${breach}`,
    detail:
      breach === 'sessions'
        ? `${subjectSessions.length} active session(s) >= max_concurrent_sessions ${f.max_concurrent_sessions}`
        : `${macs.size} active device(s) >= max_devices ${f.max_devices}`,
    actions: [],
    ...base,
  };
}

function subjectSessionsOf(input: ResolutionInput): readonly ActiveSessionRef[] {
  const all = input.active_sessions ?? [];
  const s = input.subject;
  if (s.kind === 'client_device')
    return all.filter((x) => !x.client_device_id || x.client_device_id === s.client_device_id);
  if (s.user_id === null || s.user_id === undefined) return all;
  return all.filter((x) => !x.user_id || x.user_id === s.user_id);
}

function drainTime(
  remaining: bigint | null,
  fields: EnforcementFields,
  minSessionS: number,
): number | null {
  if (remaining === null) return null;
  const rateKbps = (fields.download_rate_kbps ?? 0) + (fields.upload_rate_kbps ?? 0);
  if (rateKbps <= 0) return null;
  const seconds = Math.ceil((Number(remaining) * 8) / (rateKbps * 1000));
  return Math.max(minSessionS, seconds);
}

function finish(
  input: ResolutionInput,
  effective: EffectivePolicy,
  clip: Clip,
  controls: EcloudSideControl[],
  actions: SessionAction[],
  trace: TraceEntry[],
  decision: 'accept' | 'reject',
  reasonCode: ReasonCode | null,
  reasonDetail: string | null,
): ResolutionResult {
  trace.push({
    step: 'decision',
    detail: decision,
    data: reasonCode ? { reasonCode, reasonDetail } : {},
  });
  return {
    decision,
    reasonCode,
    reasonDetail,
    // Derived from the winning layer rather than threaded through as a flag: one source of
    // truth, so the recorded value and the displayed provenance can never disagree.
    platform_default: effective.winner?.layer_name === 'platform_default',
    effective,
    clip,
    controls,
    actions,
    trace,
    snapshot: {
      hash: snapshotHash({
        effective: effective.fields,
        schedule: effective.schedule,
        provenance: effective.provenance,
      }),
      policy_id: effective.winner?.policy_id ?? null,
      policy_version: effective.winner?.policy_version ?? null,
    },
    trigger: input.trigger ?? 'authorize',
  };
}

/**
 * `resolve(ctx)` of POLICY_ENGINE.md §2.7. Rejections carry a `reasonCode`; an accept carries the
 * effective intent, clip bounds for `Session-Timeout`, EZECLOUD-side controls to arm and a
 * per-field trace for the simulate endpoint.
 */
export function resolveEffectivePolicy(input: ResolutionInput): ResolutionResult {
  const trace: TraceEntry[] = [];
  const controls: EcloudSideControl[] = [];
  const minSessionS = input.tenant?.min_session_s ?? DEFAULT_MIN_SESSION_S;
  const grace = Math.min(MAX_GRACE_S, Math.max(0, input.tenant?.schedule_grace_s ?? 0));
  const emptyClip: Clip = {
    policy_session_timeout_s: null,
    window_end_s: null,
    validity_end_s: null,
    voucher_end_s: null,
    quota_reset_s: null,
    remaining_octets: null,
    remaining_time_s: null,
    remaining_time_period: null,
    remaining_period: null,
    drain_time_s: null,
    min_session_s: minSessionS,
  };

  // Voucher validity first: an expired voucher never reaches policy evaluation.
  const voucher = evaluateVoucher(input);
  if (voucher.reject) {
    trace.push({ step: 'voucher', detail: voucher.detail ?? voucher.reject });
    const empty = merge([], trace);
    return finish(
      input,
      empty,
      emptyClip,
      controls,
      [],
      trace,
      'reject',
      voucher.reject,
      voucher.detail,
    );
  }
  if (voucher.endsAt) {
    trace.push({
      step: 'voucher',
      detail: `voucher validity ends ${voucher.endsAt.toISOString()}`,
    });
  }

  let ordered = rankCandidates(input, trace);
  let platformDefault = false;
  if (ordered.length === 0 && input.platform_default) {
    // Migration 043. Reached only when nothing an operator configured applied, so it cannot
    // override a choice; it answers where there was no answer. Recorded as its own layer rather
    // than dressed as an organization default, because a fallback that looks like a deliberate
    // assignment is the failure this feature has to avoid: at generous limits nobody complains
    // and a forgotten access point would serve real guests for months unnoticed.
    ordered = [platformDefaultCandidate(input.platform_default)];
    platformDefault = true;
    trace.push({
      step: 'candidate',
      order: 0,
      assignment_id: null,
      policy_id: input.platform_default.id,
      policy_version: input.platform_default.version,
      layer: LAYERS.platform_default,
      layer_name: 'platform_default',
      included: true,
    });
  }
  let effective = merge(ordered, trace);
  if (ordered.length === 0) {
    const excluded = trace.filter((t) => t.step === 'candidate' && !t.included);
    const detail =
      excluded.length > 0
        ? `no applicable policy (${excluded.length} candidate(s) excluded: ${[...new Set(excluded.map((t) => (t.step === 'candidate' ? t.reason : '')))].join(', ')})`
        : 'no applicable policy and no organization default';
    return finish(input, effective, emptyClip, controls, [], trace, 'reject', 'no_policy', detail);
  }

  // Temporary layers: arm expiry re-resolution at the earliest effective_until that contributed.
  const contributing = new Set(Object.values(effective.provenance).map((p) => p.assignment_id));
  const tempEnds = ordered
    .filter(
      (c) =>
        !c.synthetic && c.assignment.effective_until !== null && contributing.has(c.assignment.id),
    )
    .map((c) => c.assignment.effective_until as Date)
    .sort((a, b) => a.getTime() - b.getTime());
  if (tempEnds[0]) controls.push({ kind: 'temp_policy_expiry', at: tempEnds[0] });

  // Validity clip (§2.7).
  let validityEndS: number | null = null;
  if (effective.fields.valid_until !== null) {
    validityEndS = secondsUntil(effective.fields.valid_until, input.now);
    controls.push({ kind: 'validity_end', at: effective.fields.valid_until });
    trace.push({ step: 'validity', detail: `valid_until in ${validityEndS}s` });
  }
  let voucherEndS: number | null = null;
  if (voucher.endsAt) {
    voucherEndS = secondsUntil(voucher.endsAt, input.now);
    controls.push({ kind: 'voucher_expiry', at: voucher.endsAt });
  }

  // Schedule (§2.4).
  let windowEndS: number | null = null;
  if (effective.schedule) {
    const tz = effective.schedule.timezone || input.timeZone;
    let window: ScheduleWindow | null = isInWindow(effective.schedule, input.now, tz);
    if (!window && grace > 0) {
      const next = nextBoundary(effective.schedule, input.now, tz);
      if (next && next.kind === 'start' && secondsUntil(next.at, input.now) <= grace) {
        window = next.window;
        trace.push({
          step: 'schedule',
          detail: `within ${grace}s grace before window start ${next.at.toISOString()}`,
        });
      }
    }
    if (window) {
      const endWithGrace = new Date(window.endsAt.getTime() + grace * 1000);
      windowEndS = secondsUntil(endWithGrace, input.now);
      controls.push({
        kind: 'schedule_end',
        at: endWithGrace,
        params: { window_end: window.endsAt.toISOString(), grace_s: grace, timezone: tz },
      });
      trace.push({
        step: 'schedule',
        detail: `in window ${window.rule.start}-${window.rule.end} (${window.localDate} ${tz}), ends ${window.endsAt.toISOString()}`,
      });
    } else if (input.tenant?.out_of_window_policy) {
      const forced = input.tenant.out_of_window_policy;
      trace.push({
        step: 'schedule',
        detail: `out of window; forcing out_of_window_policy ${forced.id} on top`,
      });
      const override: RankedCandidate = {
        policy: { ...forced, schedule: null, schedule_id: null },
        assignment: {
          id: `out_of_window:${forced.id}`,
          policy_id: forced.id,
          target_type: 'site',
          effective_from: new Date(0),
          effective_until: null,
          priority: Number.MIN_SAFE_INTEGER,
        },
        layer: -1,
        layerName: 'out_of_window_override',
        synthetic: true,
      };
      const originalSchedule = effective.schedule;
      effective = merge([override, ...ordered], trace);
      // The after-hours session ends when the regular window opens so the client re-auths into it.
      const next = nextBoundary(originalSchedule, input.now, tz);
      if (next) {
        windowEndS = secondsUntil(next.at, input.now);
        controls.push({
          kind: 'schedule_end',
          at: next.at,
          params: { reason: 'out_of_window_override_ends', timezone: tz },
        });
      }
    } else {
      trace.push({ step: 'schedule', detail: 'out of window, no out_of_window_policy' });
      const next = nextBoundary(effective.schedule, input.now, tz);
      return finish(
        input,
        effective,
        { ...emptyClip, validity_end_s: validityEndS, voucher_end_s: voucherEndS },
        controls,
        [],
        trace,
        'reject',
        'schedule',
        next
          ? `outside schedule window; next window starts ${next.at.toISOString()}`
          : 'outside schedule window',
      );
    }
  }

  // Quota (§2.5).
  const subjectSessions = subjectSessionsOf(input);
  const quota = evaluateQuota(effective.fields, input, subjectSessions);
  trace.push({
    step: 'quota',
    detail: quota.reject
      ? `exhausted (${quota.detail})`
      : quota.remaining === null
        ? 'no quota'
        : `remaining ${quota.remaining} bytes (${quota.period})`,
    data: toJsonValue(quota.limits) as Record<string, JsonValue>,
  });
  const timeQuota = evaluateTimeQuota(effective.fields, input);
  trace.push({
    step: 'quota',
    detail: timeQuota.reject
      ? `online time exhausted (${timeQuota.detail ?? ''})`
      : timeQuota.remaining === null
        ? 'no online-time quota'
        : `online time remaining ${String(timeQuota.remaining)} s (${timeQuota.period ?? ''})`,
    data: toJsonValue(timeQuota.limits) as Record<string, JsonValue>,
  });
  // §2.5 exhaustion action (migration 037). Data and online time are the same kind of promise
  // to the guest, so one action governs both; whichever ran out first supplies the reason.
  const exhaustion = timeQuota.reject
    ? { reason: timeQuota.reject, detail: timeQuota.detail }
    : quota.reject
      ? { reason: quota.reject, detail: quota.detail }
      : null;
  const action = effective.fields.quota_exhaustion_action ?? 'deny';
  // `reduce_speed` keeps the guest online at the reduced rate. The spent allowance must then
  // stop clipping anything: a remainder of zero would otherwise drive Session-Timeout to its
  // floor and the drain-time bound to nothing, cutting a session that policy says may continue.
  const reduced = exhaustion !== null && action === 'reduce_speed';
  if (reduced) {
    effective = {
      ...effective,
      fields: {
        ...effective.fields,
        download_rate_kbps:
          effective.fields.reduced_download_rate_kbps ?? effective.fields.download_rate_kbps,
        upload_rate_kbps:
          effective.fields.reduced_upload_rate_kbps ?? effective.fields.upload_rate_kbps,
      },
    };
    trace.push({
      step: 'quota',
      detail: `exhausted (${exhaustion?.detail ?? ''}); reduce_speed: continuing at ${String(
        effective.fields.download_rate_kbps,
      )}/${String(effective.fields.upload_rate_kbps)} kbit/s down/up`,
    });
    controls.push({
      kind: 'quota_reduced',
      params: {
        reason: exhaustion?.reason ?? null,
        download_rate_kbps: effective.fields.download_rate_kbps,
        upload_rate_kbps: effective.fields.upload_rate_kbps,
      },
    });
  }
  const clipBase: Clip = {
    policy_session_timeout_s: effective.fields.session_timeout_s,
    window_end_s: windowEndS,
    validity_end_s: validityEndS,
    voucher_end_s: voucherEndS,
    quota_reset_s: null,
    remaining_octets: reduced ? null : quota.remaining,
    remaining_period: reduced ? null : quota.period,
    remaining_time_s: reduced ? null : timeQuota.remaining,
    remaining_time_period: reduced ? null : timeQuota.period,
    drain_time_s: reduced ? null : drainTime(quota.remaining, effective.fields, minSessionS),
    min_session_s: minSessionS,
  };
  if (exhaustion !== null && !reduced) {
    // `require_renewal` is still a denial; it differs in the reason, so the portal can offer a
    // renewal instead of a dead end. The original allowance is named in the detail either way.
    return finish(
      input,
      effective,
      clipBase,
      controls,
      [],
      trace,
      'reject',
      action === 'require_renewal' ? 'renewal_required' : exhaustion.reason,
      action === 'require_renewal'
        ? `${exhaustion.reason}: ${exhaustion.detail ?? 'allowance exhausted'}`
        : exhaustion.detail,
    );
  }
  if (!reduced && timeQuota.remaining !== null) {
    controls.push({
      kind: 'online_time_watcher',
      params: {
        remaining_s: timeQuota.remaining,
        period: timeQuota.period,
        limits: toJsonValue(timeQuota.limits),
      },
    });
  }
  let quotaResetS: number | null = null;
  if (!reduced && quota.remaining !== null) {
    controls.push({
      kind: 'quota_watcher',
      params: {
        limit: quota.remaining.toString(),
        period: quota.period,
        limits: toJsonValue(quota.limits),
      },
    });
    if (input.tenant?.clip_session_to_quota_reset !== false) {
      const resetAt =
        effective.fields.quota_daily_bytes !== null
          ? nextLocalMidnight(input.now, input.timeZone)
          : effective.fields.quota_weekly_bytes !== null
            ? nextLocalWeekStart(input.now, input.timeZone)
            : effective.fields.quota_monthly_bytes !== null
              ? nextLocalMonthStart(input.now, input.timeZone)
              : null;
      if (resetAt) quotaResetS = secondsUntil(resetAt, input.now);
    }
  }

  // Concurrency (§2.6).
  const concurrency = evaluateConcurrency(effective, input, subjectSessions);
  if (effective.fields.max_concurrent_sessions !== null || effective.fields.max_devices !== null) {
    controls.push({
      kind: 'concurrency',
      params: {
        active_sessions: concurrency.sessions,
        active_devices: concurrency.devices,
        max_concurrent_sessions: effective.fields.max_concurrent_sessions,
        max_devices: effective.fields.max_devices,
      },
    });
  }
  trace.push({
    step: 'concurrency',
    detail: concurrency.reject
      ? `breach (${concurrency.detail})`
      : (concurrency.detail ??
        `ok (${concurrency.sessions} sessions, ${concurrency.devices} devices)`),
  });
  const clip: Clip = { ...clipBase, quota_reset_s: quotaResetS };
  if (concurrency.reject) {
    return finish(
      input,
      effective,
      clip,
      controls,
      [],
      trace,
      'reject',
      concurrency.reject,
      concurrency.detail,
    );
  }
  return finish(input, effective, clip, controls, concurrency.actions, trace, 'accept', null, null);
}
