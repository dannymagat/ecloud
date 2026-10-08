/**
 * Sessions & accounting (Phase 8, P8-B). Typed view of the P8-A contract documented in
 * API_ARCHITECTURE.md "Implementation notes (P8-A, sessions & accounting)" → "Sessions &
 * accounting API contract (consumed by P8-B admin views)". Every endpoint and optional filter is
 * feature-detected through the live OpenAPI document (`hasOperation` / `hasParameter`), so
 * against an API that does not serve one yet the screen says "Not available in this API version"
 * instead of failing requests.
 *
 * Honesty rules:
 *  - Freshness (spec §6): usage derived from accounting lags by up to the accounting interval;
 *    every usage figure is shown with `measured_at` / `last_accounting_at` / `freshness_s`.
 *  - D-006 / V12: Disconnect and Re-authorize are enabled only when the API reports the
 *    operation available AND its registry evidence is device-enforced (VERIFIED_SUPPORTED with
 *    LAB/PRODUCTION evidence and the API's `device_enforced` flag). Lab mode
 *    (`ECLOUD_COA_ENABLED` without lab evidence) does not enable the buttons. A queued request is
 *    never described as applied on the device.
 *  - Q75 / D-027: exports need `accounting:export` / `report:export` and are hidden while
 *    impersonating (the API refuses them too).
 */
import type { components } from '../api/schema';
import type { Me } from '../api/types';
import { showDeviceEnforced } from './enforcement';
import { can, type PermissionTarget } from './permissions';

type Schemas = components['schemas'];

export const SESSIONS_PATH = '/api/v1/orgs/{orgId}/sessions';
export const SESSION_PATH = '/api/v1/orgs/{orgId}/sessions/{id}';
export const SESSION_DISCONNECT_PATH = '/api/v1/orgs/{orgId}/sessions/{id}/disconnect';
export const SESSION_REAUTHORIZE_PATH = '/api/v1/orgs/{orgId}/sessions/{id}/reauthorize';
export const ACCOUNTING_RECORDS_PATH = '/api/v1/orgs/{orgId}/accounting/records';
export const ACCOUNTING_EXPORT_PATH = '/api/v1/orgs/{orgId}/accounting/export';
export const USAGE_PATH = '/api/v1/orgs/{orgId}/usage';
export const USAGE_TOP_PATH = '/api/v1/orgs/{orgId}/usage/top';
export const USAGE_EXPORT_PATH = '/api/v1/orgs/{orgId}/usage/export';

/** Poll interval for live screens (Q73: polling, not SSE, for the pilot). */
export const POLL_INTERVAL_MS = 30_000;
/** Raw accounting queries are time-bounded (P8-A contract §7: `to − from ≤ 31 days`). */
export const MAX_RECORD_RANGE_DAYS = 31;

export const SESSION_STATES = ['authorized', 'active', 'stopped', 'stale', 'expired'] as const;
export type SessionState = (typeof SESSION_STATES)[number];

export const SESSION_STATE_LABEL: Record<SessionState, string> = {
  authorized: 'Authorized',
  active: 'Active',
  stopped: 'Stopped',
  stale: 'Stale',
  expired: 'Expired',
};

export const SESSION_STATE_HINT: Record<SessionState, string> = {
  authorized: 'Accepted by RADIUS; no accounting received yet',
  active: 'Accounting received; session running',
  stopped: 'Accounting-Stop received',
  stale: 'No interim accounting for several intervals; closed by ECLOUD',
  expired: 'Authorized but no accounting arrived before the authorization TTL',
};

export function sessionStateTone(state: unknown): 'success' | 'info' | 'warning' | 'neutral' {
  switch (state) {
    case 'active':
      return 'success';
    case 'authorized':
      return 'info';
    case 'stale':
    case 'expired':
      return 'warning';
    default:
      return 'neutral';
  }
}

export function sessionStateLabel(state: unknown): string {
  if (typeof state === 'string' && state in SESSION_STATE_LABEL) {
    return SESSION_STATE_LABEL[state as SessionState];
  }
  return typeof state === 'string' && state !== '' ? state : '—';
}

/** Freshness matters only while accounting is expected (authorized / active). */
export function isOpenSession(status: unknown): boolean {
  return status === 'active' || status === 'authorized';
}

// ---------------------------------------------------------------------------------------------
// Freshness
// ---------------------------------------------------------------------------------------------

export interface Freshness {
  /** Server time of the read. */
  measured_at?: string | null;
  /** Newest accounting the figures include (null: none yet). */
  last_accounting_at?: string | null;
  /** `measured_at − last_accounting_at` in seconds (null: none yet). */
  freshness_s?: number | null;
  /** Normal lag: interim interval + drain cadence (seconds). */
  expected_lag_s?: number | null;
}

/** Normal lag assumed when the API does not report `expected_lag_s` (interim 300 s + drain). */
export const DEFAULT_EXPECTED_LAG_S = 305;

export type FreshnessLevel = 'fresh' | 'lagging' | 'stale' | 'none';

/**
 * Within the expected lag (+ 60 s slack) figures are as fresh as accounting allows; up to three
 * times the lag they are lagging; beyond that the NAS has likely stopped reporting (the
 * stale-session threshold is also 3× the interim interval).
 */
export function freshnessLevel(f: Freshness | null | undefined): FreshnessLevel {
  const age = f?.freshness_s;
  if (typeof age !== 'number' || !Number.isFinite(age)) return 'none';
  const lag =
    typeof f?.expected_lag_s === 'number' && f.expected_lag_s > 0
      ? f.expected_lag_s
      : DEFAULT_EXPECTED_LAG_S;
  if (age <= lag + 60) return 'fresh';
  if (age <= lag * 3) return 'lagging';
  return 'stale';
}

export function formatAge(seconds: number): string {
  if (seconds < 60) return `${Math.max(0, Math.round(seconds))} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 120) return `${minutes} min`;
  const hours = Math.round((seconds / 3600) * 10) / 10;
  if (hours < 48) return `${hours} h`;
  return `${Math.round(seconds / 86400)} d`;
}

export function freshnessText(f: Freshness | null | undefined): string {
  const level = freshnessLevel(f);
  if (level === 'none') return 'No accounting received yet';
  const age = formatAge(f!.freshness_s!);
  if (level === 'fresh') return `Last accounting ${age} ago`;
  if (level === 'lagging') return `Last accounting ${age} ago (lagging)`;
  return `Last accounting ${age} ago (NAS may have stopped reporting)`;
}

// ---------------------------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------------------------

/** `OperationAvailability` (P8-A contract §2): registry evidence for one session operation. */
/** Generated from the P8-A OpenAPI document. */
export type OperationAvailability = Schemas['SessionOperationAvailability'];
export type SessionRow = Schemas['SessionSummary'];
export type SessionDetail = Schemas['SessionDetail'];
export type SessionAction = Schemas['SessionAction'];
export type AccountingRecordRow = Schemas['AccountingRecordPage']['data'][number];
export type TimelineRecord = SessionDetail['timeline'][number];
export type AccountingAnomaly = SessionDetail['anomalies'][number];
export type EnforcementRow = SessionDetail['enforcement'][number];

/** Freshness of a session: the API's fields; the detail nests them under `freshness`. */
export function sessionFreshness(row: Freshness & { freshness?: Freshness }): Freshness {
  return row.freshness ?? row;
}

export type SessionOperation = 'disconnect' | 'reauthorize';

export const OPERATION_PERMISSION: Record<SessionOperation, string> = {
  disconnect: 'session:disconnect',
  reauthorize: 'session:coa',
};

export const OPERATION_LABEL: Record<SessionOperation, string> = {
  disconnect: 'Disconnect',
  reauthorize: 'Re-authorize',
};

export interface OperationGate {
  enabled: boolean;
  reason: string;
}

/**
 * Button gate for Disconnect / Re-authorize. Order: permission → endpoint → registry evidence.
 * `available` alone never enables the button (lab mode is available but not lab-validated):
 * the API's `device_enforced` must be true AND its evidence must present as device-enforced
 * (VERIFIED_SUPPORTED with LAB/PRODUCTION evidence, V12).
 */
export function operationGate(input: {
  operation: SessionOperation;
  hasPermission: boolean;
  endpointAvailable: boolean;
  availability: OperationAvailability | undefined;
}): OperationGate {
  const label = OPERATION_LABEL[input.operation];
  const a = input.availability;
  if (!input.hasPermission || a?.permitted === false) {
    return {
      enabled: false,
      reason: `Requires the ${OPERATION_PERMISSION[input.operation]} permission on this session's site.`,
    };
  }
  if (!input.endpointAvailable) {
    return { enabled: false, reason: `${label} is not available in this API version.` };
  }
  if (a === undefined) {
    return {
      enabled: false,
      reason: `Open the session to see the NAS adapter's registry evidence; ${label.toLowerCase()} is offered only where it is lab-validated.`,
    };
  }
  const reason = a.reason.trim() || `${label} is not lab-validated for this NAS adapter.`;
  if (!a.available) return { enabled: false, reason };
  const validated =
    a.device_enforced === true &&
    a.mode !== 'lab' &&
    showDeviceEnforced(a.evidence?.device_enforced, a.evidence?.status, a.evidence?.evidence_level);
  if (!validated) {
    return {
      enabled: false,
      reason:
        a.mode === 'lab'
          ? `${reason} Lab mode accepts this request through the API, but the admin console offers ${label.toLowerCase()} only for lab-validated adapters.`
          : `${label} is not lab-validated for this NAS adapter (${a.evidence?.status ?? 'unknown status'}, ${a.evidence?.evidence_level ?? 'no evidence level'}).`,
    };
  }
  return { enabled: true, reason };
}

/** 202 body of disconnect / reauthorize (P8-A contract §3). */
export type SessionOperationAccepted = Schemas['SessionOperationAccepted'];

/** Plain message for a rate-limited (429) operation request. */
export const TOO_MANY_ATTEMPTS = 'Too many attempts. Please wait a minute and try again.';

export function queuedMessage(
  operation: SessionOperation,
  result: { session_action?: Pick<SessionAction, 'id'>; deduplicated?: boolean },
): string {
  const id = result.session_action?.id;
  const head = result.deduplicated
    ? `A ${OPERATION_LABEL[operation].toLowerCase()} request for this session is already pending`
    : `${OPERATION_LABEL[operation]} request queued`;
  return `${head}${id ? ` (action ${id})` : ''}. This records that ECLOUD sent the request; it is not a confirmation from the device.`;
}

// ---------------------------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------------------------

export const USAGE_PERIODS = ['daily', 'monthly', 'total'] as const;
export type UsagePeriod = (typeof USAGE_PERIODS)[number];
export const USAGE_PERIOD_LABEL: Record<UsagePeriod, string> = {
  daily: 'Day (site time)',
  monthly: 'Month (site time)',
  total: 'Total',
};

/** Subjects of the top-N ranking (`/usage/top`). */
export const TOP_SUBJECTS = ['user', 'client_device', 'site'] as const;
export type TopSubject = (typeof TOP_SUBJECTS)[number];
export const SUBJECT_LABEL: Record<TopSubject | 'organization' | 'voucher', string> = {
  user: 'Users',
  client_device: 'Client devices',
  site: 'Sites',
  organization: 'Organization',
  voucher: 'Vouchers',
};

/** Generated from the P8-A OpenAPI document (`UsageReport`, `UsageTop`). */
export type UsageReport = Schemas['UsageReport'];
export type TopReport = Schemas['UsageTop'];
export type TopRow = TopReport['data'][number];
export type UsageCounters = UsageReport['total'];
export type UsageBucket = UsageReport['series'][number];
export type QuotaPosition = NonNullable<UsageReport['quota']>;
export type QuotaPeriod = QuotaPosition['periods'][number];

export function toNumber(value: unknown): number {
  const n = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : NaN;
  return Number.isFinite(n) ? n : 0;
}

export function totalBytes(row: UsageCounters): number {
  return row.bytes_total !== undefined
    ? toNumber(row.bytes_total)
    : toNumber(row.bytes_in) + toNumber(row.bytes_out);
}

/** Used share of a quota as a 0–100 percentage (capped), or null when the limit is 0/absent. */
export function quotaPercent(q: Pick<QuotaPeriod, 'limit_bytes' | 'used_bytes'>): number | null {
  const limit = toNumber(q.limit_bytes);
  if (limit <= 0) return null;
  return Math.min(100, Math.round((toNumber(q.used_bytes) / limit) * 1000) / 10);
}

// ---------------------------------------------------------------------------------------------
// Accounting records + export
// ---------------------------------------------------------------------------------------------

/** Validates a record-browser time window (both bounds required, ordered, ≤ 31 days). */
export function validateRange(
  fromIso: string | null,
  toIso: string | null,
  maxDays = MAX_RECORD_RANGE_DAYS,
): string | null {
  if (!fromIso || !toIso) return 'Both "From" and "To" are required.';
  const from = Date.parse(fromIso);
  const to = Date.parse(toIso);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return 'Invalid date.';
  if (to <= from) return '"To" must be after "From".';
  if (to - from > maxDays * 86_400_000) return `The time window may span at most ${maxDays} days.`;
  return null;
}

/**
 * Export visibility (Q75, D-027): an administrator holding the permission in the organization
 * (any site), and not impersonating.
 */
export function canExport(
  me: Me | null | undefined,
  permission: 'accounting:export' | 'report:export',
  target: PermissionTarget,
): boolean {
  if (!me || me.kind !== 'admin') return false;
  if (me.impersonation) return false;
  return can(me, permission, target);
}

export function exportFileName(prefix: string, from: string, to: string): string {
  const day = (iso: string) => iso.slice(0, 10);
  return `${prefix}-${day(from)}_${day(to)}.csv`;
}
