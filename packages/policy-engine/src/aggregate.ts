/**
 * Group and site aggregate limits (migration 042, BANDWIDTH_MANAGEMENT_REQUIREMENTS.md §7).
 *
 * THE HONEST PART FIRST, because it is the whole point of this module.
 *
 * A shared bandwidth pool — "all guests together within 100 Mbit/s" — cannot be enforced by any
 * gateway this platform integrates. RADIUS has no attribute for it; `WISPr-Bandwidth-Max-Down`
 * is per session, and sending the pool figure to N members caps each of them at the pool rather
 * than all of them within it. Enforcement would need a parent queue or a controller bandwidth
 * group at the enforcement point, and none of the nine adapters declares one.
 *
 * So the rate pool is OBSERVED, never applied: the measured total is reported beside the
 * configured pool, an operator can see it being exceeded, and the capability matrix says
 * UNSUPPORTED. §7 says not to label independent gateway caps as a shared pool and §15 says to
 * expose unsupported scope honestly; a module that quietly emitted the pool as a per-session
 * rate would violate both while appearing to work.
 *
 * What IS enforced here, by EZECLOUD rather than by a gateway, in the same way the per-subject
 * limits already are:
 *   - a shared data allowance, counted from `usage_counters` with a `user_group` or `site`
 *     subject, denying at the next Access-Request when it is spent;
 *   - a ceiling on simultaneously active members or sessions, counted at authorize time.
 *
 * Individual overrides cannot escape any of this. §10 is explicit: "Regardless of individual
 * overrides, applicable site and group aggregate limits remain enforced." That is why these
 * limits are evaluated here, after policy resolution and independently of it — an `unlimited`
 * declaration (migration 039) lifts a per-session cap and has no effect on a pool.
 *
 * Pure; no I/O. The caller loads the counters and the active-session facts.
 */

/** Which aggregate a decision came from, for display and for the trace. */
export type AggregateLevel = 'user_group' | 'site';

export type AggregatePeriod = 'daily' | 'weekly' | 'monthly' | 'total';

export interface AggregateLimits {
  /** Observed only; see the module comment. Null when no pool is configured. */
  readonly download_kbps: number | null;
  readonly upload_kbps: number | null;
  readonly quota_daily_bytes: bigint | null;
  readonly quota_weekly_bytes: bigint | null;
  readonly quota_monthly_bytes: bigint | null;
  readonly quota_total_bytes: bigint | null;
  /** Distinct subjects with at least one active session. */
  readonly max_active_members: number | null;
  readonly max_active_sessions: number | null;
}

export interface AggregateUsage {
  /** Bytes consumed by the whole group or site, per period. */
  readonly bytes: Partial<Record<AggregatePeriod, bigint>>;
  /** Distinct members with an active session right now, excluding the one being authorized. */
  readonly active_members: number;
  readonly active_sessions: number;
  /**
   * Sum of the resolved per-session rates of everyone currently online, kbit/s. The best
   * available estimate of pool consumption: it is what has been GRANTED, not what is flowing,
   * because nothing in the accounting stream reports an instantaneous rate. Reported as such.
   */
  readonly granted_download_kbps: number;
  readonly granted_upload_kbps: number;
}

export interface AggregateInput {
  readonly level: AggregateLevel;
  /** Identifier of the group or site, for the trace and the enumeration. */
  readonly id: string;
  readonly limits: AggregateLimits;
  readonly usage: AggregateUsage;
  /** True when the subject being authorized already has an active session in this aggregate. */
  readonly subjectAlreadyActive: boolean;
}

export type AggregateReason =
  | 'aggregate_quota_daily'
  | 'aggregate_quota_weekly'
  | 'aggregate_quota_monthly'
  | 'aggregate_quota_total'
  | 'aggregate_members'
  | 'aggregate_sessions';

/** One configured pool and what is actually happening against it. Never an enforcement. */
export interface PoolObservation {
  readonly level: AggregateLevel;
  readonly id: string;
  readonly configured_download_kbps: number | null;
  readonly configured_upload_kbps: number | null;
  readonly granted_download_kbps: number;
  readonly granted_upload_kbps: number;
  /** True when the granted total already exceeds the configured pool. */
  readonly over_download: boolean;
  readonly over_upload: boolean;
  /**
   * Always 'unsupported' on the present fleet. A field rather than a comment so the value
   * travels into the API response and the operator sees it next to the numbers.
   */
  readonly enforcement: 'unsupported';
  readonly note: string;
}

export interface AggregateEvaluation {
  readonly reject: AggregateReason | null;
  readonly detail: string | null;
  readonly level: AggregateLevel | null;
  /** Null when no pool is configured at this level. */
  readonly pool: PoolObservation | null;
  readonly quota: Partial<
    Record<AggregatePeriod, { limit: bigint; used: bigint; remaining: bigint }>
  >;
}

const POOL_NOTE =
  'a shared rate pool has no enforcement point on any integrated adapter (no parent queue, no controller bandwidth group); the figure is observed from granted session rates and displayed, never applied';

function observePool(input: AggregateInput): PoolObservation | null {
  const { download_kbps, upload_kbps } = input.limits;
  if (download_kbps === null && upload_kbps === null) return null;
  return {
    level: input.level,
    id: input.id,
    configured_download_kbps: download_kbps,
    configured_upload_kbps: upload_kbps,
    granted_download_kbps: input.usage.granted_download_kbps,
    granted_upload_kbps: input.usage.granted_upload_kbps,
    over_download: download_kbps !== null && input.usage.granted_download_kbps > download_kbps,
    over_upload: upload_kbps !== null && input.usage.granted_upload_kbps > upload_kbps,
    enforcement: 'unsupported',
    note: POOL_NOTE,
  };
}

/**
 * Evaluates one aggregate level.
 *
 * The concurrency check counts the subject being authorized only when it is not already active:
 * a guest reconnecting a second device must not be refused because their own first session
 * filled the last member slot, since a member who is already online occupies one slot however
 * many devices they bring.
 */
export function evaluateAggregate(input: AggregateInput): AggregateEvaluation {
  const pool = observePool(input);
  const { limits, usage } = input;

  const periods: [AggregatePeriod, bigint | null][] = [
    ['daily', limits.quota_daily_bytes],
    ['weekly', limits.quota_weekly_bytes],
    ['monthly', limits.quota_monthly_bytes],
    ['total', limits.quota_total_bytes],
  ];
  const quota: AggregateEvaluation['quota'] = {};
  for (const [period, limit] of periods) {
    if (limit === null) continue;
    const used = usage.bytes[period] ?? 0n;
    const left = limit - used;
    quota[period] = { limit, used, remaining: left > 0n ? left : 0n };
    if (used >= limit) {
      return {
        reject: `aggregate_quota_${period}` as AggregateReason,
        detail: `${input.level} ${input.id}: ${String(used)} of ${String(limit)} shared bytes used`,
        level: input.level,
        pool,
        quota,
      };
    }
  }

  const addedMember = input.subjectAlreadyActive ? 0 : 1;
  if (
    limits.max_active_members !== null &&
    usage.active_members + addedMember > limits.max_active_members
  ) {
    return {
      reject: 'aggregate_members',
      detail: `${input.level} ${input.id}: ${String(usage.active_members)} of ${String(limits.max_active_members)} members already active`,
      level: input.level,
      pool,
      quota,
    };
  }
  // A session is always added, even for a member who is already online: this is a new one.
  if (
    limits.max_active_sessions !== null &&
    usage.active_sessions + 1 > limits.max_active_sessions
  ) {
    return {
      reject: 'aggregate_sessions',
      detail: `${input.level} ${input.id}: ${String(usage.active_sessions)} of ${String(limits.max_active_sessions)} sessions already active`,
      level: input.level,
      pool,
      quota,
    };
  }

  return { reject: null, detail: null, level: null, pool, quota };
}

/**
 * Evaluates every applicable level, innermost first.
 *
 * Order matters for the message, not the outcome: a guest refused by both their group and their
 * site should be told about the group, which is the one an operator can act on. The outcome is
 * the same either way, because any single breach refuses.
 */
export function evaluateAggregates(inputs: readonly AggregateInput[]): AggregateEvaluation[] {
  return inputs.map(evaluateAggregate);
}

/** The first refusal across levels, or null when every aggregate permits the session. */
export function firstAggregateRejection(
  evaluations: readonly AggregateEvaluation[],
): AggregateEvaluation | null {
  return evaluations.find((e) => e.reject !== null) ?? null;
}
