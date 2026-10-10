/**
 * Dashboard (Phase 9 P9-A; API_ARCHITECTURE.md "P9-A" items 1, 2, 6): one bounded call per
 * organization / site with session, usage, authentication, enforcement, anomaly and observed NAS
 * activity figures; zero-filled hour / day chart series in the site timezone (Q65); the platform
 * per-organization summary (counts only).
 *
 * ECLOUD has no device telemetry: NAS status is the observed RADIUS activity (active / quiet /
 * silent / never with explicit thresholds), never an online/offline state (spec §8).
 */
import { ValidationError } from '@ecloud/shared';
import { sql, type RawBuilder } from 'kysely';
import { z } from 'zod';
import { freshnessOf } from '../accounting-views.js';
import type { AppDeps } from '../context.js';
import {
  ACTIVE_USERS_DAYS,
  activeUsersSince,
  activityCounts,
  anomalyCounts,
  boundsValues,
  counterSums,
  dayWindow,
  enforcementPending,
  localDateOf,
  nasActivity,
  nasFilter,
  networkDevicesRegistered,
  openSessionCounts,
  placedIn,
  portalFilter,
  portalOutcomes,
  radiusOutcomes,
  resolveScope,
  sessionsStartedSince,
  siteCountersAt,
  siteFilter,
  toCount,
  topRejectReasons,
  usersCreatedSince,
  type CounterSums,
  type OutcomeRow,
  type ReportScope,
} from '../dashboard-queries.js';
import {
  DASHBOARD_WINDOWS,
  MAX_DAY_BUCKETS,
  activityDefinition,
  activityThresholds,
  dayLabels,
  addDays,
  hourBuckets,
  resolveDayRange,
  resolveHourRange,
  siteTodayStarts,
  windowBounds,
} from '../dashboard-views.js';
import { OrgParams, decodeCursor, encodeCursor, problemResponses } from '../http/common.js';
import { defineRoute, type AnyRouteSpec } from '../http/route.js';
import { inPlatform, inTenant } from '../tenant.js';

const TAG = ['dashboard'];
const DASHBOARD_NAS_ROWS = 200;
const TOP_REASONS = 10;

// ------------------------------------------------------------------ schemas

const CountersSchema = z.object({
  bytes_in: z.number(),
  bytes_out: z.number(),
  bytes_total: z.number(),
  session_count: z.number(),
  session_time_s: z.number(),
});
const FreshnessFields = {
  measured_at: z.string(),
  last_accounting_at: z.string().nullable(),
  freshness_s: z.number().nullable(),
  expected_lag_s: z.number(),
};
const SiteRefSchema = z.object({ id: z.string(), name: z.string(), timezone: z.string() });
const ActivityEnum = z.enum(['active', 'quiet', 'silent', 'never']);
const ThresholdsSchema = z.object({ active_within_s: z.number(), quiet_within_s: z.number() });

export const NasActivitySchema = z
  .object({
    nas_client_id: z.string(),
    name: z.string(),
    site_id: z.string(),
    site_name: z.string(),
    nas_ip: z.string(),
    adapter_type_key: z.string(),
    admin_status: z.string(),
    activity: ActivityEnum,
    last_auth_request_at: z.string().nullable(),
    last_accounting_at: z.string().nullable(),
    last_activity_at: z.string().nullable(),
    open_sessions: z.number(),
  })
  .meta({
    id: 'NasActivity',
    description: 'Observed RADIUS activity of one NAS (not a device state).',
  });

const OutcomeCounts = {
  total: z.number(),
  accept: z.number(),
  reject: z.number(),
  error: z.number(),
};

const DashboardSchema = z
  .object({
    organization_id: z.string(),
    site_id: z.string().nullable(),
    sites: z.array(SiteRefSchema),
    timezone: z.string(),
    window: z.object({ key: z.enum(['1h', '24h', '7d']), from: z.string(), to: z.string() }),
    sessions: z.object({
      open: z.number(),
      authorized: z.number(),
      active: z.number(),
      started_today: z.number(),
      started_today_basis: z.string(),
      open_users: z.number(),
      open_devices: z.number(),
      open_distinct_basis: z.string(),
    }),
    users: z.object({
      active_window_days: z.number(),
      active: z.number(),
      active_basis: z.string(),
      new_today: z.number(),
      new_today_basis: z.string(),
    }),
    usage: z.object({
      today: CountersSchema,
      month: CountersSchema,
      label_basis: z.string(),
      source: z.string(),
      ...FreshnessFields,
    }),
    auth: z.object({
      radius: z.object({
        ...OutcomeCounts,
        challenge: z.number(),
        by_method: z.array(
          z.object({ method: z.string().nullable(), ...OutcomeCounts, challenge: z.number() }),
        ),
      }),
      portal: z.object({
        ...OutcomeCounts,
        lockouts: z.number(),
        by_method: z.array(
          z.object({ method: z.string(), ...OutcomeCounts, lockouts: z.number() }),
        ),
      }),
      top_reject_reasons: z.array(
        z.object({ source: z.enum(['radius', 'portal']), reason: z.string(), count: z.number() }),
      ),
    }),
    enforcement: z.object({
      pending: z.number(),
      overdue: z.number(),
      oldest_pending_at: z.string().nullable(),
    }),
    anomalies: z.object({ count: z.number(), estimated_lost_bytes: z.number() }),
    nas_activity: z.object({
      thresholds: ThresholdsSchema,
      definition: z.string(),
      counts: z.object({
        registered: z.number(),
        active: z.number(),
        quiet: z.number(),
        silent: z.number(),
        never: z.number(),
      }),
      data: z.array(NasActivitySchema),
      truncated: z.boolean(),
    }),
    network_devices: z.object({
      registered: z.number(),
      online_status_known: z.literal(0),
      note: z.string(),
    }),
    measured_at: z.string(),
  })
  .meta({ id: 'OrgDashboard', description: 'Organization / site dashboard (P9-A).' });

const AuthCountsSchema = z.object({
  radius_accept: z.number(),
  radius_reject: z.number(),
  radius_challenge: z.number(),
  radius_error: z.number(),
  portal_accept: z.number(),
  portal_reject: z.number(),
  portal_error: z.number(),
  portal_lockouts: z.number(),
});
const BucketFields = { bucket_start: z.string(), bucket_end: z.string(), label: z.string() };
const SeriesFields = {
  granularity: z.enum(['hour', 'day']),
  timezone: z.string(),
  site_id: z.string().nullable(),
  from: z.string(),
  to: z.string(),
  label_basis: z.string(),
};

const AuthSeriesSchema = z
  .object({
    metric: z.literal('auth_outcomes'),
    ...SeriesFields,
    buckets: z.array(AuthCountsSchema.extend(BucketFields)),
    totals: AuthCountsSchema,
    measured_at: z.string(),
  })
  .meta({ id: 'AuthSeries', description: 'Zero-filled authentication outcomes per bucket.' });

const UsageSeriesSchema = z
  .object({
    metric: z.literal('usage'),
    ...SeriesFields,
    source: z.enum(['usage_hourly', 'usage_counters']),
    data_since: z.string(),
    buckets: z.array(CountersSchema.extend(BucketFields)),
    totals: CountersSchema,
    ...FreshnessFields,
  })
  .meta({ id: 'UsageSeries', description: 'Zero-filled usage per bucket.' });

const SeriesQuery = z.object({
  granularity: z.enum(['hour', 'day']).default('hour'),
  site_id: z.uuid().optional(),
  from: z.string().max(40).optional(),
  to: z.string().max(40).optional(),
});

const PlatformDashboardSchema = z
  .object({
    measured_at: z.string(),
    window: z.object({ from: z.string(), to: z.string() }),
    thresholds: ThresholdsSchema,
    definition: z.string(),
    unattributed: z.object({ radius_requests_24h: z.number() }),
    data: z.array(
      z.object({
        organization_id: z.string(),
        name: z.string(),
        slug: z.string(),
        status: z.string(),
        sites: z.number(),
        nas_registered: z.number(),
        nas_activity: z.object({
          active: z.number(),
          quiet: z.number(),
          silent: z.number(),
          never: z.number(),
        }),
        nas_activity_truncated: z.boolean(),
        network_devices_registered: z.number(),
        open_sessions: z.number(),
        sessions_started_24h: z.number(),
        radius_accept_24h: z.number(),
        radius_reject_24h: z.number(),
        portal_attempts_24h: z.number(),
        portal_lockouts_24h: z.number(),
        enforcement_pending: z.number(),
        anomalies_24h: z.number(),
      }),
    ),
    next_cursor: z.string().nullable(),
  })
  .meta({ id: 'PlatformDashboard', description: 'Per-organization counts (no subscriber data).' });

// ------------------------------------------------------------------ helpers

interface GroupRow {
  organization_id: string;
  n: string;
}

function summariseRadius(rows: readonly OutcomeRow[]) {
  const total = { total: 0, accept: 0, reject: 0, challenge: 0, error: 0 };
  const byMethod = new Map<string | null, typeof total>();
  for (const r of rows) {
    const m = byMethod.get(r.method) ?? { total: 0, accept: 0, reject: 0, challenge: 0, error: 0 };
    for (const t of [total, m]) {
      t.total += r.count;
      if (
        r.result === 'accept' ||
        r.result === 'reject' ||
        r.result === 'challenge' ||
        r.result === 'error'
      ) {
        t[r.result] += r.count;
      }
    }
    byMethod.set(r.method, m);
  }
  return {
    ...total,
    by_method: [...byMethod.entries()]
      .map(([method, c]) => ({ method, ...c }))
      .sort((a, b) => b.total - a.total || String(a.method).localeCompare(String(b.method))),
  };
}

function summarisePortal(rows: readonly OutcomeRow[]) {
  const total = { total: 0, accept: 0, reject: 0, error: 0, lockouts: 0 };
  const byMethod = new Map<string, typeof total>();
  for (const r of rows) {
    const key = r.method ?? 'unknown';
    const m = byMethod.get(key) ?? { total: 0, accept: 0, reject: 0, error: 0, lockouts: 0 };
    for (const t of [total, m]) {
      t.total += r.count;
      t.lockouts += r.lockouts;
      if (r.result === 'accept' || r.result === 'reject' || r.result === 'error')
        t[r.result] += r.count;
    }
    byMethod.set(key, m);
  }
  return {
    ...total,
    by_method: [...byMethod.entries()]
      .map(([method, c]) => ({ method, ...c }))
      .sort((a, b) => b.total - a.total || a.method.localeCompare(b.method)),
  };
}

function withoutOrganization<T extends { organization_id: string }>(
  row: T,
): Omit<T, 'organization_id'> {
  const out: Partial<T> = { ...row };
  delete out.organization_id;
  return out as Omit<T, 'organization_id'>;
}

type AuthCounts = z.output<typeof AuthCountsSchema>;
const zeroAuth = (): AuthCounts => ({
  radius_accept: 0,
  radius_reject: 0,
  radius_challenge: 0,
  radius_error: 0,
  portal_accept: 0,
  portal_reject: 0,
  portal_error: 0,
  portal_lockouts: 0,
});

function addAuth(
  target: AuthCounts,
  source: 'radius' | 'portal',
  result: string,
  count: number,
  lockouts: number,
): void {
  const key = `${source}_${result}` as keyof AuthCounts;
  if (key in target) target[key] += count;
  if (source === 'portal') target.portal_lockouts += lockouts;
}

const zeroCounters = (): CounterSums => counterSums({});

function addCounters(target: CounterSums, r: CounterSums): void {
  target.bytes_in += r.bytes_in;
  target.bytes_out += r.bytes_out;
  target.bytes_total += r.bytes_total;
  target.session_count += r.session_count;
  target.session_time_s += r.session_time_s;
}

/** Hourly series need one timezone: a site, or a scope whose sites share one. */
export function hourlyTimeZone(scope: ReportScope): string {
  if (scope.timezone === 'mixed') {
    throw new ValidationError([
      {
        path: 'query.site_id',
        message: `site_id is required for hourly series: the sites span several timezones (${[
          ...new Set(scope.sites.map((s) => s.timezone)),
        ].join(', ')})`,
      },
    ]);
  }
  return scope.timezone;
}

interface ResolvedSeries<T> {
  timezone: string;
  from: string;
  to: string;
  label_basis: string;
  buckets: (T & { bucket_start: string; bucket_end: string; label: string })[];
}

// ------------------------------------------------------------------ routes

export function dashboardRoutes(deps: AppDeps): AnyRouteSpec[] {
  const now = () => (deps.now ?? (() => new Date()))();
  const thresholds = () => activityThresholds(deps.config.aaaInterimIntervalS);

  const dashboard = defineRoute({
    method: 'get',
    path: '/api/v1/orgs/:orgId/dashboard',
    summary:
      'Organization or site dashboard (sessions, usage, auth outcomes, observed NAS activity)',
    tags: TAG,
    auth: 'principal',
    permission: 'report:read',
    scope: 'any-site',
    params: OrgParams,
    query: z.object({
      site_id: z.uuid().optional(),
      window: z.enum(['1h', '24h', '7d']).default('24h'),
    }),
    responses: { 200: { description: 'Dashboard', schema: DashboardSchema }, ...problemResponses },
    handler: async ({ params, query, ctx }) => {
      const at = now();
      const t = thresholds();
      const win = windowBounds(query.window, at);
      const body = await inTenant(deps, params.orgId, async (trx) => {
        const scope = await resolveScope(trx, ctx, params.orgId, 'report:read', query.site_id);
        const todays = siteTodayStarts(scope.sites, at);
        const months = todays.map((d) => ({
          site_id: d.site_id,
          label: `${d.label.slice(0, 7)}-01`,
        }));
        const open = await openSessionCounts(trx, scope);
        const startedToday = await sessionsStartedSince(trx, scope.orgId, todays);
        const activeUsers = await activeUsersSince(
          trx,
          scope,
          new Date(at.getTime() - ACTIVE_USERS_DAYS * 86_400_000),
        );
        const newUsers = await usersCreatedSince(
          trx,
          scope,
          todays,
          new Date(`${at.toISOString().slice(0, 10)}T00:00:00Z`),
        );
        const usageToday = await siteCountersAt(
          trx,
          scope.orgId,
          'daily',
          todays.map((d) => ({ site_id: d.site_id, label: d.label })),
        );
        const usageMonth = await siteCountersAt(trx, scope.orgId, 'monthly', months);
        const radius = await radiusOutcomes(trx, scope, win.from, win.to);
        const portal = await portalOutcomes(trx, scope, win.from, win.to);
        const reasons = await topRejectReasons(trx, scope, win.from, win.to, TOP_REASONS);
        const enforcement = await enforcementPending(trx, scope, at);
        const anomalies = await anomalyCounts(trx, scope, win.from, win.to);
        const nas = await nasActivity(trx, [scope.orgId], scope, at, t);
        const devices = await networkDevicesRegistered(trx, scope);
        const lastUsage =
          usageToday.lastUpdated === null
            ? usageMonth.lastUpdated
            : usageMonth.lastUpdated === null || usageToday.lastUpdated > usageMonth.lastUpdated
              ? usageToday.lastUpdated
              : usageMonth.lastUpdated;
        return {
          organization_id: scope.orgId,
          site_id: scope.siteId,
          sites: scope.sites,
          timezone: scope.timezone,
          window: { key: query.window, from: win.from.toISOString(), to: win.to.toISOString() },
          sessions: {
            open: open.authorized + open.active,
            authorized: open.authorized,
            active: open.active,
            started_today: startedToday,
            started_today_basis:
              "sessions (not expired authorizations) started since each site's local midnight (Q65)",
            open_users: open.users,
            open_devices: open.devices,
            open_distinct_basis:
              'distinct live (not deleted) subscriber records (open_users) and client MAC addresses (open_devices) of the open sessions; sessions without a subscriber record or MAC are not counted',
          },
          users: {
            active_window_days: ACTIVE_USERS_DAYS,
            active: activeUsers,
            active_basis: `distinct live (not deleted) subscriber records with a session started in the last ${String(ACTIVE_USERS_DAYS)} days (rolling) or still open`,
            new_today: newUsers,
            new_today_basis:
              "subscriber records created since their site's local midnight (Q65); subscribers without a site count from UTC midnight, in the organization-wide view only",
          },
          usage: {
            today: usageToday.sums,
            month: usageMonth.sums,
            label_basis: "each site's current local day / month (Q65)",
            source: 'usage_counters (site rows, migration 024)',
            ...freshnessOf(at, lastUsage, deps.config.aaaInterimIntervalS),
          },
          auth: {
            radius: summariseRadius(radius),
            portal: summarisePortal(portal),
            top_reject_reasons: reasons,
          },
          enforcement,
          anomalies,
          nas_activity: {
            thresholds: t,
            definition: activityDefinition(t),
            counts: { registered: nas.rows.length, ...activityCounts(nas.rows) },
            data: nas.rows.slice(0, DASHBOARD_NAS_ROWS).map(withoutOrganization),
            truncated: nas.truncated || nas.rows.length > DASHBOARD_NAS_ROWS,
          },
          network_devices: {
            registered: devices,
            online_status_known: 0 as const,
            note: 'ECLOUD does not observe access point or device state; registered devices are listed, their online status is unknown.',
          },
          measured_at: at.toISOString(),
        };
      });
      return { status: 200, body };
    },
  });

  const authSeries = defineRoute({
    method: 'get',
    path: '/api/v1/orgs/:orgId/dashboard/series/auth',
    summary: 'Authentication outcomes per hour / day (zero-filled, site timezone)',
    tags: TAG,
    auth: 'principal',
    permission: 'report:read',
    scope: 'any-site',
    params: OrgParams,
    query: SeriesQuery,
    responses: {
      200: { description: 'Auth series', schema: AuthSeriesSchema },
      ...problemResponses,
    },
    handler: async ({ params, query, ctx }) => {
      const at = now();
      const body = await inTenant(deps, params.orgId, async (trx) => {
        const scope = await resolveScope(trx, ctx, params.orgId, 'report:read', query.site_id);
        let series: ResolvedSeries<AuthCounts>;
        if (query.granularity === 'hour') {
          const tz = hourlyTimeZone(scope);
          const range = resolveHourRange(at, query.from, query.to);
          const hb = hourBuckets(range.from, range.to, tz);
          const origin = (hb[0] as (typeof hb)[number]).start;
          const end = (hb[hb.length - 1] as (typeof hb)[number]).end;
          const byStart = new Map(
            hb.map((b) => [
              b.start.getTime(),
              {
                ...zeroAuth(),
                bucket_start: b.start.toISOString(),
                bucket_end: b.end.toISOString(),
                label: b.label,
              },
            ]),
          );
          const radius = await sql<{ b: Date; result: string; count: string }>`
            SELECT date_bin('1 hour', created_at, ${origin.toISOString()}::timestamptz) AS b,
                   result, count(*) AS count
            FROM auth_events
            WHERE organization_id = ${scope.orgId}
              AND created_at >= ${origin.toISOString()}::timestamptz
              AND created_at < ${end.toISOString()}::timestamptz
              AND ${nasFilter(scope, 'nas_client_id')}
            GROUP BY 1, 2
          `.execute(trx);
          const portal = await sql<{ b: Date; result: string; count: string; lockouts: string }>`
            SELECT date_bin('1 hour', created_at, ${origin.toISOString()}::timestamptz) AS b,
                   result, count(*) AS count, count(*) FILTER (WHERE triggered_lockout) AS lockouts
            FROM portal_login_attempts
            WHERE organization_id = ${scope.orgId}
              AND created_at >= ${origin.toISOString()}::timestamptz
              AND created_at < ${end.toISOString()}::timestamptz
              AND ${portalFilter(scope, 'captive_portal_id')}
            GROUP BY 1, 2
          `.execute(trx);
          for (const r of radius.rows) {
            const b = byStart.get(new Date(r.b).getTime());
            if (b) addAuth(b, 'radius', r.result, toCount(r.count), 0);
          }
          for (const r of portal.rows) {
            const b = byStart.get(new Date(r.b).getTime());
            if (b) addAuth(b, 'portal', r.result, toCount(r.count), toCount(r.lockouts));
          }
          series = {
            timezone: tz,
            from: origin.toISOString(),
            to: end.toISOString(),
            label_basis: `local hours in ${tz}; bucket_start / bucket_end are instants`,
            buckets: [...byStart.values()],
          };
        } else {
          const range = resolveDayRange(
            at,
            scope.timezone === 'mixed' ? 'UTC' : scope.timezone,
            31,
            MAX_DAY_BUCKETS,
            query.from,
            query.to,
          );
          const win = dayWindow(scope, range.from, range.to);
          const byDay = new Map(
            dayLabels(range.from, range.to).map((d) => [
              d,
              { ...zeroAuth(), bucket_start: d, bucket_end: addDays(d, 1), label: d },
            ]),
          );
          const radius = await sql<{ d: string; result: string; count: string }>`
            SELECT ${localDateOf('ae.created_at')} AS d, ae.result, count(*) AS count
            FROM auth_events ae
            LEFT JOIN nas_clients nc ON nc.id = ae.nas_client_id
            LEFT JOIN ${boundsValues(win.bounds)} ON v.site_id = nc.site_id
            WHERE ae.organization_id = ${scope.orgId}
              AND ${placedIn(win, 'ae.created_at', sql<boolean>`ae.nas_client_id IS NULL`)}
            GROUP BY 1, 2
          `.execute(trx);
          const portal = await sql<{ d: string; result: string; count: string; lockouts: string }>`
            SELECT ${localDateOf('p.created_at')} AS d, p.result, count(*) AS count,
                   count(*) FILTER (WHERE p.triggered_lockout) AS lockouts
            FROM portal_login_attempts p
            JOIN captive_portals cp ON cp.id = p.captive_portal_id
            LEFT JOIN ${boundsValues(win.bounds)} ON v.site_id = cp.site_id
            WHERE p.organization_id = ${scope.orgId}
              AND ${placedIn(win, 'p.created_at', sql<boolean>`false`)}
            GROUP BY 1, 2
          `.execute(trx);
          for (const r of radius.rows) {
            const b = byDay.get(r.d);
            if (b) addAuth(b, 'radius', r.result, toCount(r.count), 0);
          }
          for (const r of portal.rows) {
            const b = byDay.get(r.d);
            if (b) addAuth(b, 'portal', r.result, toCount(r.count), toCount(r.lockouts));
          }
          series = {
            timezone: scope.timezone,
            from: range.from,
            to: range.to,
            label_basis:
              scope.timezone === 'mixed'
                ? 'site-local dates: each site counts its own local days (Q65); rows without a site of the scope on UTC days'
                : `local dates in ${scope.timezone} (Q65)`,
            buckets: [...byDay.values()],
          };
        }
        const totals = zeroAuth();
        for (const b of series.buckets) {
          for (const k of Object.keys(totals) as (keyof AuthCounts)[]) totals[k] += b[k];
        }
        return {
          metric: 'auth_outcomes' as const,
          granularity: query.granularity,
          site_id: scope.siteId,
          ...series,
          totals,
          measured_at: at.toISOString(),
        };
      });
      return { status: 200, body };
    },
  });

  const usageSeries = defineRoute({
    method: 'get',
    path: '/api/v1/orgs/:orgId/dashboard/series/usage',
    summary: 'Usage per hour / day (zero-filled, site timezone, with freshness)',
    tags: TAG,
    auth: 'principal',
    permission: 'report:read',
    scope: 'any-site',
    params: OrgParams,
    query: SeriesQuery,
    responses: {
      200: { description: 'Usage series', schema: UsageSeriesSchema },
      ...problemResponses,
    },
    handler: async ({ params, query, ctx }) => {
      const at = now();
      const body = await inTenant(deps, params.orgId, async (trx) => {
        const scope = await resolveScope(trx, ctx, params.orgId, 'report:read', query.site_id);
        let series: ResolvedSeries<CounterSums>;
        let lastUpdated: Date | null = null;
        let source: 'usage_hourly' | 'usage_counters';
        let dataSince: string;
        if (query.granularity === 'hour') {
          const tz = hourlyTimeZone(scope);
          const range = resolveHourRange(at, query.from, query.to);
          const hb = hourBuckets(range.from, range.to, tz);
          const origin = (hb[0] as (typeof hb)[number]).start;
          const end = (hb[hb.length - 1] as (typeof hb)[number]).end;
          const byStart = new Map(
            hb.map((b) => [
              b.start.getTime(),
              {
                ...zeroCounters(),
                bucket_start: b.start.toISOString(),
                bucket_end: b.end.toISOString(),
                label: b.label,
              },
            ]),
          );
          const rows = await sql<{
            b: Date;
            bytes_in: string;
            bytes_out: string;
            session_count: string;
            session_time_s: string;
            last_updated: Date;
          }>`
            SELECT date_bin('1 hour', hour_start, ${origin.toISOString()}::timestamptz) AS b,
                   sum(bytes_in) AS bytes_in, sum(bytes_out) AS bytes_out,
                   sum(session_count) AS session_count, sum(session_time_s) AS session_time_s,
                   max(updated_at) AS last_updated
            FROM usage_hourly
            WHERE organization_id = ${scope.orgId}
              AND hour_start >= ${origin.toISOString()}::timestamptz
              AND hour_start < ${end.toISOString()}::timestamptz
              AND ${siteFilter(scope, 'site_id')}
            GROUP BY 1
          `.execute(trx);
          for (const r of rows.rows) {
            const b = byStart.get(new Date(r.b).getTime());
            if (b) addCounters(b, counterSums(r));
            if (lastUpdated === null || r.last_updated > lastUpdated) lastUpdated = r.last_updated;
          }
          source = 'usage_hourly';
          dataSince =
            'migration 026: the drainer writes hourly site rows for accounting it processes after 026 (no backfill)';
          series = {
            timezone: tz,
            from: origin.toISOString(),
            to: end.toISOString(),
            label_basis: `local hours in ${tz}; bytes are attributed to the hour of the accounting event that reported them`,
            buckets: [...byStart.values()],
          };
        } else {
          const range = resolveDayRange(
            at,
            scope.timezone === 'mixed' ? 'UTC' : scope.timezone,
            31,
            MAX_DAY_BUCKETS,
            query.from,
            query.to,
          );
          const byDay = new Map(
            dayLabels(range.from, range.to).map((d) => [
              d,
              { ...zeroCounters(), bucket_start: d, bucket_end: addDays(d, 1), label: d },
            ]),
          );
          const rows = await sql<{
            d: string;
            bytes_in: string;
            bytes_out: string;
            session_count: string;
            session_time_s: string;
            last_updated: Date;
          }>`
            SELECT to_char(period_start, 'YYYY-MM-DD') AS d,
                   sum(bytes_in) AS bytes_in, sum(bytes_out) AS bytes_out,
                   sum(session_count) AS session_count, sum(session_time_s) AS session_time_s,
                   max(updated_at) AS last_updated
            FROM usage_counters
            WHERE organization_id = ${scope.orgId}
              AND subject_type = 'site' AND period_type = 'daily'
              AND period_start >= ${range.from}::date AND period_start <= ${range.to}::date
              AND ${siteFilter(scope, 'subject_id')}
            GROUP BY 1
          `.execute(trx);
          for (const r of rows.rows) {
            const b = byDay.get(r.d);
            if (b) addCounters(b, counterSums(r));
            if (lastUpdated === null || r.last_updated > lastUpdated) lastUpdated = r.last_updated;
          }
          source = 'usage_counters';
          dataSince =
            'migration 024: site counters exist for accounting drained after 024 (no backfill)';
          series = {
            timezone: scope.timezone,
            from: range.from,
            to: range.to,
            label_basis:
              scope.timezone === 'mixed'
                ? 'site-local dates: each site counts its own local days (Q65)'
                : `local dates in ${scope.timezone} (Q65)`,
            buckets: [...byDay.values()],
          };
        }
        const totals = zeroCounters();
        for (const b of series.buckets) addCounters(totals, b);
        return {
          metric: 'usage' as const,
          granularity: query.granularity,
          site_id: scope.siteId,
          ...series,
          source,
          data_since: dataSince,
          totals,
          ...freshnessOf(at, lastUpdated, deps.config.aaaInterimIntervalS),
        };
      });
      return { status: 200, body };
    },
  });

  const platformDashboard = defineRoute({
    method: 'get',
    path: '/api/v1/platform/dashboard',
    summary: 'Per-organization operational counts for platform administrators (no subscriber data)',
    tags: TAG,
    auth: 'principal',
    permission: 'platform:health:read',
    scope: 'platform',
    query: z.object({
      limit: z.coerce.number().int().min(1).max(50).default(25),
      cursor: z.string().max(200).optional(),
      status: z.enum(['active', 'suspended', 'archived']).optional(),
      organization_id: z.uuid().optional(),
    }),
    responses: {
      200: { description: 'Platform dashboard', schema: PlatformDashboardSchema },
      ...problemResponses,
    },
    handler: async ({ query, ctx }) => {
      const at = now();
      const t = thresholds();
      const from = new Date(at.getTime() - DASHBOARD_WINDOWS['24h'] * 1000);
      const cursor = decodeCursor(query.cursor);
      const body = await inPlatform(deps, ctx, 'platform dashboard (counts)', async (trx) => {
        let oq = trx
          .selectFrom('organizations')
          .select(['id', 'name', 'slug', 'status'])
          .where('deleted_at', 'is', null);
        if (query.status) oq = oq.where('status', '=', query.status);
        if (query.organization_id) oq = oq.where('id', '=', query.organization_id);
        if (typeof cursor === 'string') oq = oq.where('id', '>', cursor);
        const orgsPlus = await oq
          .orderBy('id')
          .limit(query.limit + 1)
          .execute();
        const orgs = orgsPlus.slice(0, query.limit);
        const ids = orgs.map((o) => o.id);
        const fromIso = from.toISOString();
        const toIso = at.toISOString();
        const unattributed = await sql<{ n: string }>`
          SELECT count(*) AS n FROM auth_events
          WHERE organization_id IS NULL
            AND created_at >= ${fromIso}::timestamptz AND created_at < ${toIso}::timestamptz
        `.execute(trx);
        const empty = {
          measured_at: toIso,
          window: { from: fromIso, to: toIso },
          thresholds: t,
          definition: activityDefinition(t),
          unattributed: { radius_requests_24h: toCount(unattributed.rows[0]?.n) },
          data: [],
          next_cursor: null,
        };
        if (ids.length === 0) return empty;
        const idList = sql.join(ids);
        const grouped = async (q: RawBuilder<{ organization_id: string; n: string }>) => {
          const r = await q.execute(trx);
          return new Map(r.rows.map((x) => [x.organization_id, toCount(x.n)]));
        };
        const sites = await grouped(sql<GroupRow>`
          SELECT organization_id, count(*) AS n FROM sites
          WHERE organization_id IN (${idList}) AND deleted_at IS NULL GROUP BY 1`);
        const devices = await grouped(sql<GroupRow>`
          SELECT organization_id, count(*) AS n FROM network_devices
          WHERE organization_id IN (${idList}) AND deleted_at IS NULL
            AND site_id IN (SELECT id FROM sites WHERE deleted_at IS NULL AND organization_id IN (${idList})) GROUP BY 1`);
        const open = await grouped(sql<GroupRow>`
          SELECT organization_id, count(*) AS n FROM sessions
          WHERE organization_id IN (${idList}) AND status IN ('authorized', 'active')
            AND site_id IN (SELECT id FROM sites WHERE deleted_at IS NULL AND organization_id IN (${idList})) GROUP BY 1`);
        const started = await grouped(sql<GroupRow>`
          SELECT organization_id, count(*) AS n FROM sessions
          WHERE organization_id IN (${idList}) AND status <> 'expired'
            AND site_id IN (SELECT id FROM sites WHERE deleted_at IS NULL AND organization_id IN (${idList}))
            AND started_at >= ${fromIso}::timestamptz AND started_at < ${toIso}::timestamptz
          GROUP BY 1`);
        const accepts = await grouped(sql<GroupRow>`
          SELECT organization_id, count(*) AS n FROM auth_events
          WHERE organization_id IN (${idList}) AND result = 'accept'
            AND (nas_client_id IS NULL OR nas_client_id IN
              (SELECT id FROM nas_clients WHERE site_id IN (SELECT id FROM sites WHERE deleted_at IS NULL AND organization_id IN (${idList}))))
            AND created_at >= ${fromIso}::timestamptz AND created_at < ${toIso}::timestamptz
          GROUP BY 1`);
        const rejects = await grouped(sql<GroupRow>`
          SELECT organization_id, count(*) AS n FROM auth_events
          WHERE organization_id IN (${idList}) AND result = 'reject'
            AND (nas_client_id IS NULL OR nas_client_id IN
              (SELECT id FROM nas_clients WHERE site_id IN (SELECT id FROM sites WHERE deleted_at IS NULL AND organization_id IN (${idList}))))
            AND created_at >= ${fromIso}::timestamptz AND created_at < ${toIso}::timestamptz
          GROUP BY 1`);
        const portal = await grouped(sql<GroupRow>`
          SELECT organization_id, count(*) AS n FROM portal_login_attempts
          WHERE organization_id IN (${idList})
            AND captive_portal_id IN (SELECT id FROM captive_portals WHERE site_id IN (SELECT id FROM sites WHERE deleted_at IS NULL AND organization_id IN (${idList})))
            AND created_at >= ${fromIso}::timestamptz AND created_at < ${toIso}::timestamptz
          GROUP BY 1`);
        const lockouts = await grouped(sql<GroupRow>`
          SELECT organization_id, count(*) AS n FROM portal_login_attempts
          WHERE organization_id IN (${idList}) AND triggered_lockout
            AND captive_portal_id IN (SELECT id FROM captive_portals WHERE site_id IN (SELECT id FROM sites WHERE deleted_at IS NULL AND organization_id IN (${idList})))
            AND created_at >= ${fromIso}::timestamptz AND created_at < ${toIso}::timestamptz
          GROUP BY 1`);
        const pending = await grouped(sql<GroupRow>`
          SELECT se.organization_id, count(*) AS n FROM session_enforcement se
          JOIN sessions s ON s.id = se.session_id
          WHERE se.organization_id IN (${idList}) AND se.state = 'pending'
            AND s.site_id IN (SELECT id FROM sites WHERE deleted_at IS NULL AND organization_id IN (${idList})) GROUP BY 1`);
        const anomalies = await grouped(sql<GroupRow>`
          SELECT a.organization_id, count(*) AS n FROM accounting_anomalies a
          JOIN sessions s ON s.id = a.session_id
          WHERE a.organization_id IN (${idList})
            AND a.created_at >= ${fromIso}::timestamptz AND a.created_at < ${toIso}::timestamptz
            AND s.site_id IN (SELECT id FROM sites WHERE deleted_at IS NULL AND organization_id IN (${idList}))
          GROUP BY 1`);
        const nas = await nasActivity(trx, ids, null, at, t);
        const last = nas.rows[nas.rows.length - 1];
        return {
          ...empty,
          data: orgs.map((o) => {
            const own = nas.rows.filter((r) => r.organization_id === o.id);
            return {
              organization_id: o.id,
              name: o.name,
              slug: o.slug,
              status: o.status,
              sites: sites.get(o.id) ?? 0,
              nas_registered: own.length,
              nas_activity: activityCounts(own),
              // the scan cap cut this organization's NAS list (only the last one can be cut)
              nas_activity_truncated: nas.truncated && last?.organization_id === o.id,
              network_devices_registered: devices.get(o.id) ?? 0,
              open_sessions: open.get(o.id) ?? 0,
              sessions_started_24h: started.get(o.id) ?? 0,
              radius_accept_24h: accepts.get(o.id) ?? 0,
              radius_reject_24h: rejects.get(o.id) ?? 0,
              portal_attempts_24h: portal.get(o.id) ?? 0,
              portal_lockouts_24h: lockouts.get(o.id) ?? 0,
              enforcement_pending: pending.get(o.id) ?? 0,
              anomalies_24h: anomalies.get(o.id) ?? 0,
            };
          }),
          next_cursor:
            orgsPlus.length > query.limit && orgs.length > 0
              ? encodeCursor((orgs[orgs.length - 1] as (typeof orgs)[number]).id)
              : null,
        };
      });
      return { status: 200, body };
    },
  });

  return [dashboard, authSeries, usageSeries, platformDashboard];
}
