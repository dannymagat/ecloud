/**
 * Dashboard & reports (Phase 9, P9-B). Typed view of the P9-A contract documented in
 * API_ARCHITECTURE.md "Implementation notes (P9-A, dashboard & reports)" → "Dashboard & reports
 * API contract (consumed by P9-B admin views)". Every endpoint is feature-detected through the
 * live OpenAPI document (`hasOperation`), so against an API that does not serve one yet the
 * screen says "Not available in this API version" instead of failing requests.
 *
 * Honesty rules (TASK P9, ECLOUD_MULTI_VENDOR_HOTSPOT.md §8, D-028):
 *  - ECLOUD has no device telemetry. NAS status is the *observed activity* the API derives from
 *    RADIUS requests and accounting ECLOUD itself received (`active|quiet|silent|never`, explicit
 *    thresholds), labelled "last RADIUS / accounting activity". It is never worded as a device
 *    being up or down (`FORBIDDEN_DEVICE_WORDS`, asserted by tests).
 *  - Registered network devices are counted, with "state observed: 0" (ECLOUD observes none).
 *  - Usage lags accounting by up to the interim interval: freshness and label basis are shown.
 *  - Enforcement counts are ECLOUD-side pending records, never "applied on the device".
 *  - Q73: polling (30 s) that stops while the query is in error. Q75 / D-027: CSV export needs
 *    `report:export` and is hidden while impersonating.
 */
import type { components } from '../api/schema';
import { POLL_INTERVAL_MS } from './accounting';

// ---------------------------------------------------------------------------------------------
// Endpoints and permissions (P9-A contract)
// ---------------------------------------------------------------------------------------------

export const DASHBOARD_PATH = '/api/v1/orgs/{orgId}/dashboard';
export const AUTH_SERIES_PATH = '/api/v1/orgs/{orgId}/dashboard/series/auth';
export const USAGE_SERIES_PATH = '/api/v1/orgs/{orgId}/dashboard/series/usage';
export const REPORTS_PATH = '/api/v1/orgs/{orgId}/reports';
export const REPORT_PATH = '/api/v1/orgs/{orgId}/reports/{key}';
export const REPORT_EXPORT_PATH = '/api/v1/orgs/{orgId}/reports/{key}/export';
export const PLATFORM_DASHBOARD_PATH = '/api/v1/platform/dashboard';

/** Dashboard, series and reports (any-site; the API filters to the caller's sites). */
export const DASHBOARD_PERMISSION = 'report:read';
export const REPORT_EXPORT_PERMISSION = 'report:export';
export const PLATFORM_DASHBOARD_PERMISSION = 'platform:health:read';

// ---------------------------------------------------------------------------------------------
// Contract types
// ---------------------------------------------------------------------------------------------

type Schemas = components['schemas'];

/** Generated from the P9-A OpenAPI document (`npm run generate:api -w @ecloud/admin`). */
export type OrgDashboard = Schemas['OrgDashboard'];
export type Counters = OrgDashboard['usage']['today'];
export type SiteRef = OrgDashboard['sites'][number];
export type RejectReason = OrgDashboard['auth']['top_reject_reasons'][number];
export type NasActivity = Schemas['NasActivity'];
export type NasActivityStatus = NasActivity['activity'];
export type NasActivityThresholds = OrgDashboard['nas_activity']['thresholds'];
export type AuthSeries = Schemas['AuthSeries'];
export type AuthBucket = AuthSeries['buckets'][number];
export type UsageSeries = Schemas['UsageSeries'];
export type UsageBucket = UsageSeries['buckets'][number];
export type Granularity = AuthSeries['granularity'];
export type ReportDefinition = Schemas['ReportDefinitions']['data'][number];
export type ReportParam = ReportDefinition['params'][number];
export type ReportColumn = ReportDefinition['columns'][number];
export type ReportResult = Schemas['ReportResult'];
export type PlatformDashboard = Schemas['PlatformDashboard'];
export type PlatformOrgRow = PlatformDashboard['data'][number];

export const DASHBOARD_WINDOWS = [
  '1h',
  '24h',
  '7d',
] as const satisfies readonly OrgDashboard['window']['key'][];
export type DashboardWindow = (typeof DASHBOARD_WINDOWS)[number];
export const DASHBOARD_WINDOW_LABEL: Record<DashboardWindow, string> = {
  '1h': 'Last hour',
  '24h': 'Last 24 hours',
  '7d': 'Last 7 days',
};

export const PLATFORM_STATUSES = ['active', 'suspended', 'archived'] as const;

// ---------------------------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------------------------

export function num(value: unknown): number {
  const n = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : NaN;
  return Number.isFinite(n) ? n : 0;
}

/** Number, or null when the API did not provide the figure (rendered "—", never as 0). */
export function numOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
}

export function bytesTotal(c: Partial<Counters> | null | undefined): number {
  if (!c) return 0;
  return c.bytes_total !== undefined && c.bytes_total !== null
    ? num(c.bytes_total)
    : num(c.bytes_in) + num(c.bytes_out);
}

/** Compact figure for tiles: 1,284 / 12.9K / 4.2M. */
export function formatCount(value: unknown): string {
  const n = numOrNull(value);
  if (n === null) return '—';
  const abs = Math.abs(n);
  if (abs < 10_000) return Math.round(n).toLocaleString('en-US');
  if (abs < 1_000_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}K`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}

/** Exact figure for table cells (thousands separators). */
export function formatExact(value: unknown): string {
  const n = numOrNull(value);
  return n === null ? '—' : n.toLocaleString('en-US');
}

export function formatPercent(part: number, whole: number): string {
  if (whole <= 0) return '—';
  return `${Math.round((part / whole) * 1000) / 10}%`;
}

/** Binary unit (1, KB, MB, GB, TB) for "nice" byte-axis ticks. */
export function byteTickUnit(max: number): number {
  if (!(max >= 1024)) return 1;
  return 1024 ** Math.min(4, Math.floor(Math.log(max) / Math.log(1024)));
}

// ---------------------------------------------------------------------------------------------
// NAS activity (observed by ECLOUD; NOT device state)
// ---------------------------------------------------------------------------------------------

export const NAS_ACTIVITY_STATUSES: readonly NasActivityStatus[] = [
  'active',
  'quiet',
  'silent',
  'never',
];

export const NAS_ACTIVITY_LABEL: Record<NasActivityStatus, string> = {
  active: 'Recent activity',
  quiet: 'Quiet',
  silent: 'Silent',
  never: 'No activity seen',
};

export function isNasActivityStatus(value: unknown): value is NasActivityStatus {
  return value === 'active' || value === 'quiet' || value === 'silent' || value === 'never';
}

export function nasActivityTone(status: unknown): 'success' | 'neutral' | 'warning' | 'info' {
  switch (status) {
    case 'active':
      return 'success';
    case 'quiet':
      return 'neutral';
    case 'silent':
      return 'warning';
    default:
      return 'info';
  }
}

export function formatSeconds(seconds: number): string {
  if (seconds > 0 && seconds % 86400 === 0) return `${seconds / 86400} d`;
  if (seconds > 0 && seconds % 3600 === 0) return `${seconds / 3600} h`;
  if (seconds > 0 && seconds % 60 === 0) return `${seconds / 60} min`;
  return `${seconds} s`;
}

/** Plain-language definition of each status from the API's thresholds (contract table). */
export function nasActivityDefinitions(
  t: Partial<NasActivityThresholds> | null | undefined,
): Record<NasActivityStatus, string> {
  const active = formatSeconds(num(t?.active_within_s));
  const quiet = formatSeconds(num(t?.quiet_within_s));
  return {
    active: `Newest RADIUS request or accounting record at most ${active} old.`,
    quiet: `Newest RADIUS / accounting activity older than ${active} but at most ${quiet} old.`,
    silent: `No RADIUS / accounting activity for more than ${quiet}.`,
    never: 'No RADIUS request or accounting record from this NAS is retained.',
  };
}

export const NAS_ACTIVITY_EXPLAINER =
  'Status reflects only the RADIUS requests and accounting ECLOUD has received from each NAS. ECLOUD does not monitor access points, so this says nothing about whether a device is reachable: a NAS without clients is legitimately quiet or silent.';

/**
 * Words that would claim device state or device enforcement ECLOUD has no evidence for. Tests
 * assert none appears in the rendered dashboard / reports / platform summary.
 */
export const FORBIDDEN_DEVICE_WORDS: readonly RegExp[] = [
  // "Online Users" / "Online sessions" (owner-approved, admin redesign cycle 1) describe
  // subscriber sessions ECLOUD holds, not device state; every other "online" stays forbidden.
  /\bonline\b(?!\s+(users?|sessions?)\b)/i,
  /\boffline\b/i,
  /\bapplied on (the )?device\b/i,
  /\benforced (on|by) (the )?device\b/i,
];

// ---------------------------------------------------------------------------------------------
// Chart windows (P9-A AC 2: hour ≤ 31 days, day ≤ 13 months; zero-filled by the API)
// ---------------------------------------------------------------------------------------------

export interface ChartWindow {
  key: string;
  label: string;
  granularity: Granularity;
  /** Hours (hour) or local days (day); `null` = the API default range. */
  span: number | null;
}

export const CHART_WINDOWS: readonly ChartWindow[] = [
  { key: '24h', label: 'Last 24 hours, hourly', granularity: 'hour', span: null },
  { key: '7d', label: 'Last 7 days, hourly', granularity: 'hour', span: 7 * 24 },
  { key: '31d', label: 'Last 31 days, daily', granularity: 'day', span: null },
  { key: '13m', label: 'Last 13 months, daily', granularity: 'day', span: 396 },
];

/** Today's date label (`YYYY-MM-DD`) in `timeZone` (UTC for 'mixed' / invalid zones). */
export function localDateLabel(now: Date, timeZone: string | null | undefined): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timeZone && timeZone !== 'mixed' ? timeZone : 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

function addDays(label: string, days: number): string {
  const d = new Date(`${label}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Query for a chart window. Hourly: ISO instants ending at the next whole hour. Daily: inclusive
 * `YYYY-MM-DD` labels ending today in the scope's time zone. `{}` = the API default range.
 */
export function chartRange(
  w: ChartWindow,
  timeZone: string | null | undefined,
  now: Date = new Date(),
): { from?: string; to?: string } {
  if (w.span === null) return {};
  if (w.granularity === 'hour') {
    const end = new Date(now);
    end.setUTCMinutes(0, 0, 0);
    end.setUTCHours(end.getUTCHours() + 1);
    return {
      from: new Date(end.getTime() - w.span * 3_600_000).toISOString(),
      to: end.toISOString(),
    };
  }
  const to = localDateLabel(now, timeZone);
  return { from: addDays(to, -(w.span - 1)), to };
}

/** Axis label from the API's bucket label ('YYYY-MM-DD HH:00' local, or 'YYYY-MM-DD'). */
export function axisLabel(label: string, granularity: Granularity): string {
  if (granularity === 'hour') {
    const m = /^\d{4}-(\d{2})-(\d{2})[ T](\d{2}:\d{2})/.exec(label);
    return m ? `${m[2]}/${m[1]} ${m[3]}` : label;
  }
  const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(label);
  return m ? `${m[2]}/${m[1]}` : label;
}

// ---------------------------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------------------------

export const REPORT_PERIODS = ['daily', 'monthly'] as const;

/** Form value → API param: monthly `<input type="month">` gives `YYYY-MM`, labels use day 01. */
export function reportParamValue(name: string, value: string, period: string): string | undefined {
  if (value === '') return undefined;
  if ((name === 'from' || name === 'to') && period === 'monthly' && /^\d{4}-\d{2}$/.test(value)) {
    return `${value}-01`;
  }
  return value;
}

export function buildReportParams(
  def: Pick<ReportDefinition, 'params'>,
  values: Record<string, string>,
): Record<string, string> {
  const period = values.period ?? '';
  const out: Record<string, string> = {};
  for (const p of def.params) {
    const v = reportParamValue(p.name, values[p.name] ?? '', period);
    if (v !== undefined) out[p.name] = v;
  }
  return out;
}

/** Client-side check before a run: required params present, `to` not before `from`. */
export function validateReportParams(
  def: Pick<ReportDefinition, 'params'>,
  values: Record<string, string>,
): string | null {
  for (const p of def.params) {
    if (p.required && !values[p.name] && (p.default === null || p.default === undefined)) {
      return `"${p.name}" is required.`;
    }
  }
  const from = values.from;
  const to = values.to;
  if (from && to && to < from) return '"To" must not be before "From".';
  return null;
}

/**
 * `refetchInterval` for live dashboard queries (Q73): poll every 30 s, stop while the query is in
 * error (403 / 5xx); a user action or remount retries. The explicit parameter type keeps TanStack
 * Query's data inference intact.
 */
export function pollUnlessError(q: { state: { status: string } }): number | false {
  return q.state.status === 'error' ? false : POLL_INTERVAL_MS;
}
