/**
 * Pure helpers of the P9-A dashboard & reports (API_ARCHITECTURE.md "P9-A"): observed NAS
 * activity (never a device online/offline state), dashboard windows, zero-filled hour / day
 * buckets in the site timezone (Q65) and their bounds. No I/O.
 */
import { fromLocal, localDateKey, offsetMs, toLocal } from '@ecloud/policy-engine';
import { ValidationError } from '@ecloud/shared';
import { DEFAULT_INTERIM_INTERVAL_S } from './accounting-views.js';

// ------------------------------------------------------------------ observed NAS activity

export type NasActivityStatus = 'active' | 'quiet' | 'silent' | 'never';

export interface ActivityThresholds {
  /** Newest observed activity at most this old → `active` (2 × the NAS interim interval). */
  active_within_s: number;
  /** Newest observed activity at most this old → `quiet`; older → `silent`. */
  quiet_within_s: number;
}

export const QUIET_WITHIN_S = 86_400;

export function activityThresholds(interimIntervalS: number | null): ActivityThresholds {
  return {
    active_within_s: 2 * (interimIntervalS ?? DEFAULT_INTERIM_INTERVAL_S),
    quiet_within_s: QUIET_WITHIN_S,
  };
}

export function activityDefinition(t: ActivityThresholds): string {
  return (
    'Observed RADIUS activity only (ECLOUD has no device telemetry; this is not an online/offline state): ' +
    `active = an Access-Request or accounting record from this NAS within the last ${String(t.active_within_s)} s; ` +
    `quiet = newest activity older than that but within ${String(t.quiet_within_s)} s; ` +
    'silent = newest activity older than that; never = no auth request or accounting record from this NAS is retained.'
  );
}

export function newestOf(...dates: readonly (Date | null | undefined)[]): Date | null {
  let out: Date | null = null;
  for (const d of dates) if (d instanceof Date && (out === null || d > out)) out = d;
  return out;
}

/** Status derived only from what ECLOUD itself observed from the NAS. */
export function classifyActivity(
  now: Date,
  lastActivity: Date | null,
  t: ActivityThresholds,
): NasActivityStatus {
  if (lastActivity === null) return 'never';
  const ageS = (now.getTime() - lastActivity.getTime()) / 1000;
  if (ageS <= t.active_within_s) return 'active';
  if (ageS <= t.quiet_within_s) return 'quiet';
  return 'silent';
}

// ------------------------------------------------------------------ dashboard window

export const DASHBOARD_WINDOWS = { '1h': 3_600, '24h': 86_400, '7d': 604_800 } as const;
export type DashboardWindow = keyof typeof DASHBOARD_WINDOWS;

export function windowBounds(key: DashboardWindow, now: Date): { from: Date; to: Date } {
  return { from: new Date(now.getTime() - DASHBOARD_WINDOWS[key] * 1000), to: now };
}

// ------------------------------------------------------------------ hour buckets (site TZ)

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
export const MAX_HOUR_RANGE_DAYS = 31;
/** 13 months is at most 397 days (Q: "max 13 months daily"). */
export const MAX_DAY_BUCKETS = 397;

/**
 * Instant the site-local hour containing `at` began. Same rule as the worker's drainer writes
 * into `usage_hourly.hour_start` (migration 026), so rollup rows and buckets line up exactly.
 */
export function localHourStart(at: Date, timeZone: string): Date {
  const ms = at.getTime();
  const local = ms + offsetMs(ms, timeZone);
  return new Date(ms - (((local % HOUR_MS) + HOUR_MS) % HOUR_MS));
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Wall-clock label of a local hour: `YYYY-MM-DD HH:00`. */
export function localHourLabel(at: Date, timeZone: string): string {
  const l = toLocal(at, timeZone);
  return `${String(l.year)}-${pad(l.month)}-${pad(l.day)} ${pad(l.hour)}:00`;
}

export interface HourBucket {
  start: Date;
  end: Date;
  label: string;
}

/**
 * Hour buckets covering `[from, to)`: the first starts at the local hour containing `from`, each
 * is one hour long (a DST fall-back hour appears twice, a spring-forward hour is absent).
 */
export function hourBuckets(from: Date, to: Date, timeZone: string): HourBucket[] {
  if (!(to.getTime() > from.getTime())) {
    throw new ValidationError([{ path: 'query.from', message: 'from must be before to' }]);
  }
  if (to.getTime() - from.getTime() > MAX_HOUR_RANGE_DAYS * DAY_MS) {
    throw new ValidationError([
      {
        path: 'query.from',
        message: `hourly series span at most ${String(MAX_HOUR_RANGE_DAYS)} days`,
      },
    ]);
  }
  const out: HourBucket[] = [];
  for (let t = localHourStart(from, timeZone).getTime(); t < to.getTime(); t += HOUR_MS) {
    const start = new Date(t);
    out.push({ start, end: new Date(t + HOUR_MS), label: localHourLabel(start, timeZone) });
  }
  return out;
}

/** Default hourly range: the last 24 h up to `now`. */
export function resolveHourRange(now: Date, from?: string, to?: string): { from: Date; to: Date } {
  const end = to !== undefined ? parseInstant(to, 'query.to') : now;
  const start =
    from !== undefined ? parseInstant(from, 'query.from') : new Date(end.getTime() - DAY_MS);
  return { from: start, to: end };
}

function parseInstant(value: string, path: string): Date {
  const d = new Date(value);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(value) || Number.isNaN(d.getTime())) {
    throw new ValidationError([{ path, message: 'expected an ISO 8601 date-time' }]);
  }
  return d;
}

// ------------------------------------------------------------------ day labels (site TZ)

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseLabel(label: string, path: string): { y: number; m: number; d: number } {
  const [y, m, d] = label.split('-').map(Number);
  const dt = new Date(Date.UTC(y ?? 0, (m ?? 1) - 1, d ?? 1));
  if (!DATE_RE.test(label) || dt.toISOString().slice(0, 10) !== label) {
    throw new ValidationError([{ path, message: 'expected a calendar date YYYY-MM-DD' }]);
  }
  return { y: y as number, m: m as number, d: d as number };
}

export function addDays(label: string, days: number): string {
  const { y, m, d } = parseLabel(label, 'date');
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** Instant of local midnight at the start of `label` in `timeZone`. */
export function localMidnight(label: string, timeZone: string): Date {
  const { y, m, d } = parseLabel(label, 'date');
  return fromLocal(timeZone, y, m, d, 0, 0);
}

/** Inclusive list of day labels. */
export function dayLabels(from: string, to: string): string[] {
  const out: string[] = [];
  for (let l = from; l <= to; l = addDays(l, 1)) out.push(l);
  return out;
}

/**
 * Validated inclusive `[from, to]` day labels. Defaults: `defaultDays` days ending today in
 * `timeZone` (UTC when the scope spans several timezones).
 */
export function resolveDayRange(
  now: Date,
  timeZone: string,
  defaultDays: number,
  maxDays: number,
  from?: string,
  to?: string,
): { from: string; to: string } {
  if (from !== undefined) parseLabel(from, 'query.from');
  if (to !== undefined) parseLabel(to, 'query.to');
  const end = to ?? localDateKey(now, timeZone);
  const start = from ?? addDays(end, -(defaultDays - 1));
  if (start > end) {
    throw new ValidationError([{ path: 'query.from', message: 'from must not be after to' }]);
  }
  const n = Math.round((Date.parse(end) - Date.parse(start)) / DAY_MS) + 1;
  if (n > maxDays) {
    throw new ValidationError([
      { path: 'query.from', message: `at most ${String(maxDays)} days per request` },
    ]);
  }
  return { from: start, to: end };
}

/** Inclusive list of month labels (`YYYY-MM-01`). */
export function monthLabels(from: string, to: string): string[] {
  const out: string[] = [];
  const a = parseLabel(from, 'query.from');
  const b = parseLabel(to, 'query.to');
  let y = a.y;
  let m = a.m;
  while (y < b.y || (y === b.y && m <= b.m)) {
    out.push(`${String(y)}-${pad(m)}-01`);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
}

/** Per-site instant bounds of an inclusive local day range. */
export interface SiteBounds {
  site_id: string;
  timezone: string;
  from_at: Date;
  to_at: Date;
}

export function siteBounds(
  sites: readonly { id: string; timezone: string }[],
  from: string,
  to: string,
): SiteBounds[] {
  const after = addDays(to, 1);
  return sites.map((s) => ({
    site_id: s.id,
    timezone: s.timezone,
    from_at: localMidnight(from, s.timezone),
    to_at: localMidnight(after, s.timezone),
  }));
}

/** Local midnights of `now` per site (sessions started "today", Q65). */
export function siteTodayStarts(
  sites: readonly { id: string; timezone: string }[],
  now: Date,
): { site_id: string; since: Date; label: string }[] {
  return sites.map((s) => {
    const label = localDateKey(now, s.timezone);
    return { site_id: s.id, since: localMidnight(label, s.timezone), label };
  });
}

/** The scope's single timezone, or `mixed`. */
export function scopeTimeZone(sites: readonly { timezone: string }[]): string {
  const zones = [...new Set(sites.map((s) => s.timezone))];
  if (zones.length === 0) return 'UTC';
  return zones.length === 1 ? (zones[0] as string) : 'mixed';
}
