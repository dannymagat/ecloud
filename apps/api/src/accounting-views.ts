/**
 * Pure helpers of the P8-A sessions & accounting views (API_ARCHITECTURE.md "P8-A"): freshness
 * fields (spec §6: usage derived from accounting lags by the interim interval), session keyset
 * cursors, period labels in the site timezone (Q65), quota position and the Disconnect /
 * Reauthorize gate (D-006, D-028 V12). No I/O.
 */
import { dynamicAuthorizationEvidence } from '@ecloud/adapters';
import type { MechanismEvidence } from '@ecloud/policy-engine';
import { localDateKey, nextLocalMidnight, nextLocalMonthStart } from '@ecloud/policy-engine';
import { ValidationError } from '@ecloud/shared';
import { encodeCursor, decodeCursor } from './http/common.js';
import { nasAdapter } from './nas-adapter.js';

/** Drain cadence of the worker (`accounting.drain` every 5 s). */
export const DRAIN_CADENCE_S = 5;
/** NAS interim interval assumed when AAA_INTERIM_INTERVAL_S is unset (worker reap default). */
export const DEFAULT_INTERIM_INTERVAL_S = 600;

export interface Freshness {
  measured_at: string;
  last_accounting_at: string | null;
  freshness_s: number | null;
  expected_lag_s: number;
}

export function expectedLagS(interimIntervalS: number | null): number {
  return (interimIntervalS ?? DEFAULT_INTERIM_INTERVAL_S) + DRAIN_CADENCE_S;
}

export function freshnessOf(
  now: Date,
  lastAccountingAt: Date | null,
  interimIntervalS: number | null,
): Freshness {
  return {
    measured_at: now.toISOString(),
    last_accounting_at: lastAccountingAt?.toISOString() ?? null,
    freshness_s:
      lastAccountingAt === null
        ? null
        : Math.max(0, Math.floor((now.getTime() - lastAccountingAt.getTime()) / 1000)),
    expected_lag_s: expectedLagS(interimIntervalS),
  };
}

/** Newest accounting a session row reflects (null before the first accounting packet). */
export function sessionLastAccounting(s: {
  status: string;
  started_at: Date;
  last_interim_at: Date | null;
  stopped_at: Date | null;
}): Date | null {
  if (s.status === 'authorized' || s.status === 'expired') return null;
  const candidates = [s.last_interim_at, s.stopped_at, s.started_at].filter(
    (d): d is Date => d !== null,
  );
  return new Date(Math.max(...candidates.map((d) => d.getTime())));
}

/**
 * Keyset cursor over (timestamp, id). The timestamp travels as the exact UTC text Postgres
 * produced (microseconds, `TS_TEXT`), because a JS Date would truncate microseconds of
 * `DEFAULT now()` columns and skip or repeat rows at a page boundary.
 */
export function encodeTimeCursor(atText: string, id: string | number): string {
  return encodeCursor(`${atText}|${String(id)}`);
}

const CURSOR_TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;

export function decodeTimeCursor(cursor: string | undefined): { at: string; id: string } | null {
  if (cursor === undefined || cursor === '') return null;
  const raw = decodeCursor(cursor);
  if (typeof raw === 'string') {
    const sep = raw.indexOf('|');
    if (sep > 0) {
      const at = raw.slice(0, sep);
      const id = raw.slice(sep + 1);
      if (CURSOR_TS_RE.test(at) && /^[0-9a-f-]{1,36}$/i.test(id)) return { at, id };
    }
  }
  throw new ValidationError([{ path: 'query.cursor', message: 'invalid cursor' }]);
}

// ------------------------------------------------------------------ periods (site TZ, Q65)

export type PeriodType = 'daily' | 'monthly' | 'total';
export const TOTAL_PERIOD_START = '1970-01-01';

function parseDateKey(key: string): { y: number; m: number; d: number } {
  const [y, m, d] = key.split('-').map(Number);
  return { y: y ?? 1970, m: m ?? 1, d: d ?? 1 };
}

function dateKey(y: number, m: number, d: number): string {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.toISOString().slice(0, 10);
}

/** Exclusive end label of a bucket (`2026-10-08` daily → `2026-10-09`); null for total. */
export function periodEndKey(period: PeriodType, start: string): string | null {
  if (period === 'total') return null;
  const { y, m, d } = parseDateKey(start);
  return period === 'daily' ? dateKey(y, m, d + 1) : dateKey(y, m + 1, 1);
}

/** Normalises a requested start label to its bucket start (monthly → day 01). */
export function bucketStart(period: PeriodType, key: string): string {
  if (period === 'total') return TOTAL_PERIOD_START;
  const { y, m, d } = parseDateKey(key);
  return period === 'daily' ? dateKey(y, m, d) : dateKey(y, m, 1);
}

/** Current bucket start label of `now` in `timeZone`. */
export function currentPeriodStart(period: PeriodType, now: Date, timeZone: string): string {
  if (period === 'total') return TOTAL_PERIOD_START;
  return bucketStart(period, localDateKey(now, timeZone));
}

/** Instant the current bucket ends (next local midnight / month start); null for total. */
export function currentPeriodEndsAt(period: PeriodType, now: Date, timeZone: string): Date | null {
  if (period === 'daily') return nextLocalMidnight(now, timeZone);
  if (period === 'monthly') return nextLocalMonthStart(now, timeZone);
  return null;
}

export const MAX_BUCKETS: Readonly<Record<Exclude<PeriodType, 'total'>, number>> = {
  daily: 366,
  monthly: 60,
};

/** Number of buckets between two start labels, inclusive. */
export function bucketCount(
  period: Exclude<PeriodType, 'total'>,
  from: string,
  to: string,
): number {
  const a = parseDateKey(from);
  const b = parseDateKey(to);
  if (period === 'monthly') return (b.y - a.y) * 12 + (b.m - a.m) + 1;
  return Math.round((Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d)) / 86_400_000) + 1;
}

/** Default / validated `[from, to]` start labels of a usage series. */
export function seriesRange(
  period: PeriodType,
  now: Date,
  timeZone: string,
  from?: string,
  to?: string,
): { from: string; to: string } {
  if (period === 'total') return { from: TOTAL_PERIOD_START, to: TOTAL_PERIOD_START };
  const end = bucketStart(period, to ?? localDateKey(now, timeZone));
  let start: string;
  if (from !== undefined) start = bucketStart(period, from);
  else {
    const { y, m, d } = parseDateKey(end);
    start = period === 'daily' ? dateKey(y, m, d - 30) : dateKey(y, m - 12, 1);
  }
  if (start > end) {
    throw new ValidationError([{ path: 'query.from', message: 'from must not be after to' }]);
  }
  const n = bucketCount(period, start, end);
  if (n > MAX_BUCKETS[period]) {
    throw new ValidationError([
      {
        path: 'query.from',
        message: `at most ${String(MAX_BUCKETS[period])} ${period} buckets per request`,
      },
    ]);
  }
  return { from: start, to: end };
}

// ------------------------------------------------------------------ quota position

export interface QuotaLimits {
  quota_daily_bytes: number | null;
  quota_monthly_bytes: number | null;
  quota_total_bytes: number | null;
}

export interface QuotaPeriodPosition {
  period: PeriodType;
  limit_bytes: number;
  used_bytes: number;
  remaining_bytes: number;
  exceeded: boolean;
  period_start: string;
  period_end: string | null;
}

/**
 * Same rule as the worker's quota job (POLICY_ENGINE.md §2.5): a period is exceeded when
 * bytes_in + bytes_out >= limit; limits <= 0 / null are not quotas.
 */
export function quotaPeriods(
  limits: QuotaLimits,
  used: Readonly<Partial<Record<PeriodType, number>>>,
  now: Date,
  timeZone: string,
): QuotaPeriodPosition[] {
  const out: QuotaPeriodPosition[] = [];
  const entries: [PeriodType, number | null][] = [
    ['daily', limits.quota_daily_bytes],
    ['monthly', limits.quota_monthly_bytes],
    ['total', limits.quota_total_bytes],
  ];
  for (const [period, limit] of entries) {
    if (limit === null || limit <= 0) continue;
    const u = used[period] ?? 0;
    out.push({
      period,
      limit_bytes: limit,
      used_bytes: u,
      remaining_bytes: Math.max(0, limit - u),
      exceeded: u >= limit,
      period_start: currentPeriodStart(period, now, timeZone),
      period_end: currentPeriodEndsAt(period, now, timeZone)?.toISOString() ?? null,
    });
  }
  return out;
}

// ------------------------------------------------------------------ timeline deltas

/** Per-record counter deltas vs the previous record of the same session (≥ 0, null if unknown). */
export function withDeltas<T extends { input_octets: number | null; output_octets: number | null }>(
  records: readonly T[],
): (T & { delta_input_octets: number | null; delta_output_octets: number | null })[] {
  let prevIn: number | null = null;
  let prevOut: number | null = null;
  return records.map((r) => {
    const dIn = r.input_octets === null ? null : Math.max(0, r.input_octets - (prevIn ?? 0));
    const dOut = r.output_octets === null ? null : Math.max(0, r.output_octets - (prevOut ?? 0));
    if (r.input_octets !== null) prevIn = r.input_octets;
    if (r.output_octets !== null) prevOut = r.output_octets;
    return { ...r, delta_input_octets: dIn, delta_output_octets: dOut };
  });
}

// ------------------------------------------------------------------ Disconnect / Reauthorize gate

export type SessionOperation = 'disconnect' | 'reauthorize';
export type OperationCode =
  | 'session_not_open'
  | 'no_adapter'
  | 'coa_unsupported'
  | 'nas_coa_disabled'
  | 'dispatcher_disabled';

export interface OperationAvailability {
  operation: SessionOperation;
  permission: 'session:disconnect' | 'session:coa';
  permitted: boolean;
  available: boolean;
  mode: 'validated' | 'lab' | null;
  device_enforced: boolean;
  code: OperationCode | null;
  reason: string;
  evidence: {
    status: string | null;
    evidence_level: string | null;
    device_enforced: boolean;
    declaration: string | null;
  };
  dispatcher_enabled: boolean;
}

export interface OperationInput {
  operation: SessionOperation;
  adapterKey: string | null;
  nasCoaSupported: boolean | null;
  sessionStatus: string;
  dispatcherEnabled: boolean;
  permitted: boolean;
}

const OPEN_STATUSES = new Set(['authorized', 'active']);

function mechanismText(name: string, adapterKey: string, m: MechanismEvidence): string {
  const level = m.evidenceLevel ?? 'no registry evidence';
  return m.deviceEnforced
    ? `${name} is lab-validated for ${adapterKey} (${m.status}, ${level})`
    : `${name} is not lab-validated for ${adapterKey} (${m.status}, ${level})`;
}

/**
 * Whether the API accepts a Disconnect / Reauthorize for a session now, and why not (D-006:
 * never "supported" without LAB evidence; ECLOUD_COA_ENABLED lab mode sends the request but the
 * result is still not device-enforced, V12). Reasons are neutral, user-facing wording.
 */
export function operationAvailability(input: OperationInput): OperationAvailability {
  const permission = input.operation === 'disconnect' ? 'session:disconnect' : 'session:coa';
  const name = input.operation === 'disconnect' ? 'Disconnect' : 'CoA (reauthorize)';
  const adapter = nasAdapter(input.adapterKey);
  const evidence = adapter === null ? null : dynamicAuthorizationEvidence(input.adapterKey);
  const mechanism =
    evidence === null
      ? null
      : input.operation === 'disconnect'
        ? evidence.disconnect
        : evidence.coaChange;
  const caps = adapter?.capabilities() ?? null;
  const declaration =
    caps === null
      ? null
      : input.operation === 'disconnect'
        ? caps.disconnect.evidence
        : caps.coaChange.evidence;
  const base = {
    operation: input.operation,
    permission,
    permitted: input.permitted,
    evidence: {
      status: mechanism?.status ?? null,
      evidence_level: mechanism?.evidenceLevel ?? null,
      device_enforced: mechanism?.deviceEnforced ?? false,
      declaration,
    },
    dispatcher_enabled: input.dispatcherEnabled,
  } as const;
  const refuse = (code: OperationCode, reason: string): OperationAvailability => ({
    ...base,
    available: false,
    mode: null,
    device_enforced: false,
    code,
    reason,
  });

  if (!OPEN_STATUSES.has(input.sessionStatus)) {
    return refuse(
      'session_not_open',
      `The session is ${input.sessionStatus}; only open (authorized or active) sessions can be changed.`,
    );
  }
  if (adapter === null || mechanism === null || input.adapterKey === null) {
    return refuse(
      'no_adapter',
      `${name} is not available: the NAS has no engine adapter, so ECLOUD cannot address it (D-035).`,
    );
  }
  const disconnectTargetNone =
    input.operation === 'disconnect' && adapter.describeDisconnect().target === 'none';
  if (
    mechanism.status === 'UNSUPPORTED' ||
    mechanism.status === 'ECLOUD_SIDE_ONLY' ||
    disconnectTargetNone
  ) {
    return refuse(
      'coa_unsupported',
      `${name} is not supported by ${input.adapterKey} (${mechanism.status}); the session ends at its Session-Timeout or when the client leaves.`,
    );
  }
  if (input.nasCoaSupported === false) {
    return refuse(
      'nas_coa_disabled',
      `${name} is turned off for this NAS (coa_supported = false).`,
    );
  }
  const text = mechanismText(name, input.adapterKey, mechanism);
  if (!input.dispatcherEnabled) {
    return refuse(
      'dispatcher_disabled',
      `${text}; the CoA/Disconnect dispatcher is disabled (ECLOUD_COA_ENABLED=false, D-006). Policy changes apply at the session's next re-authentication.`,
    );
  }
  const validated = mechanism.status === 'VERIFIED_SUPPORTED' && mechanism.deviceEnforced;
  return {
    ...base,
    available: true,
    mode: validated ? 'validated' : 'lab',
    device_enforced: validated,
    code: null,
    reason: validated
      ? `${text}; the request is sent by the dispatcher.`
      : `Lab mode (ECLOUD_COA_ENABLED=true): ${text}; the request is sent for testing and its effect is not reported as device-enforced (V12).`,
  };
}
