/**
 * Bounded, index-supported aggregate queries of the P9-A dashboard, chart series, reports and
 * the platform summary (API_ARCHITECTURE.md "P9-A", "Performance"). Tenant callers run them
 * inside `withTenant` (RLS is the second lock, MULTITENANCY.md G6); the platform summary runs them
 * under `withPlatform`, grouped by organization. Every query is either a range on an indexed time
 * column, a partial-index count of open rows, or a per-NAS newest-row probe (LIMIT 1).
 */
import type { DbExecutor } from '@ecloud/db';
import { NotFoundError } from '@ecloud/shared';
import { sql, type RawBuilder } from 'kysely';
import { permittedSites } from './auth/authorize.js';
import type { RequestContext } from './context.js';
import {
  classifyActivity,
  newestOf,
  scopeTimeZone,
  type ActivityThresholds,
  type NasActivityStatus,
  siteBounds,
  type SiteBounds,
} from './dashboard-views.js';
import { requireOnSite } from './tenant.js';

export interface SiteRef {
  id: string;
  name: string;
  timezone: string;
}

export interface ReportScope {
  orgId: string;
  /** The site of a site dashboard / site-filtered report, else null. */
  siteId: string | null;
  /** Non-deleted sites the figures cover. */
  sites: SiteRef[];
  /** Organization-level grant and no `site_id`: no site filter at all (deleted sites included). */
  allSites: boolean;
  /** Single site timezone, or `mixed`. */
  timezone: string;
}

/**
 * Sites the caller may read for `permission`: an explicit `site_id` must be readable (404
 * otherwise, G9); without one the caller's permitted sites (all of them for an
 * organization-level grant).
 */
export async function resolveScope(
  trx: DbExecutor,
  ctx: RequestContext,
  orgId: string,
  permission: string,
  siteId: string | undefined,
): Promise<ReportScope> {
  if (siteId !== undefined) {
    const site = await trx
      .selectFrom('sites')
      .select(['id', 'name', 'timezone'])
      .where('id', '=', siteId)
      .where('organization_id', '=', orgId)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    if (site === undefined) throw new NotFoundError('site', siteId);
    requireOnSite(ctx, permission, orgId, site.id, 'site');
    return { orgId, siteId: site.id, sites: [site], allSites: false, timezone: site.timezone };
  }
  const permitted = permittedSites(ctx.principal, permission, orgId);
  let q = trx
    .selectFrom('sites')
    .select(['id', 'name', 'timezone'])
    .where('organization_id', '=', orgId)
    .where('deleted_at', 'is', null);
  if (permitted !== 'all') {
    if (permitted.length === 0) {
      return { orgId, siteId: null, sites: [], allSites: false, timezone: 'UTC' };
    }
    q = q.where('id', 'in', permitted);
  }
  const sites = await q.orderBy('name').orderBy('id').execute();
  return {
    orgId,
    siteId: null,
    sites,
    allSites: permitted === 'all',
    timezone: scopeTimeZone(sites),
  };
}

const n = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));

/**
 * Deleted sites are excluded everywhere (dashboard, series, reports, platform summary): an
 * organization-level scope means "every live site", never "every row of the organization".
 */
function liveSites(orgId: string): RawBuilder<unknown> {
  return sql`SELECT id FROM sites WHERE organization_id = ${orgId} AND deleted_at IS NULL`;
}

/** `col IN (sites of the scope)` (live sites only), or false for an empty scope. */
export function siteFilter(scope: ReportScope, column: string): RawBuilder<boolean> {
  if (scope.allSites) return sql<boolean>`${sql.ref(column)} IN (${liveSites(scope.orgId)})`;
  if (scope.sites.length === 0) return sql<boolean>`false`;
  return sql<boolean>`${sql.ref(column)} IN (${sql.join(scope.sites.map((s) => s.id))})`;
}

/**
 * RADIUS events of the scope: NAS (live or soft-deleted) of the scope's sites; an
 * organization-level scope also counts requests without a NAS row (`nas_client_id IS NULL`).
 */
export function nasFilter(scope: ReportScope, column: string): RawBuilder<boolean> {
  const ref = sql.ref(column);
  if (scope.allSites) {
    return sql<boolean>`(${ref} IS NULL OR ${ref} IN (SELECT id FROM nas_clients WHERE site_id IN (${liveSites(scope.orgId)})))`;
  }
  if (scope.sites.length === 0) return sql<boolean>`false`;
  return sql<boolean>`${ref} IN (SELECT id FROM nas_clients WHERE site_id IN (${sql.join(
    scope.sites.map((s) => s.id),
  )}))`;
}

/** Portal attempts of the scope: captive portals of the scope's (live) sites. */
export function portalFilter(scope: ReportScope, column: string): RawBuilder<boolean> {
  const ref = sql.ref(column);
  if (scope.allSites) {
    return sql<boolean>`${ref} IN (SELECT id FROM captive_portals WHERE site_id IN (${liveSites(scope.orgId)}))`;
  }
  if (scope.sites.length === 0) return sql<boolean>`false`;
  return sql<boolean>`${ref} IN (SELECT id FROM captive_portals WHERE site_id IN (${sql.join(
    scope.sites.map((s) => s.id),
  )}))`;
}

/**
 * Reject reasons shown to tenants: only machine reason codes (`^[a-z0-9_]{1,64}$`). Anything
 * else is free text (a FreeRADIUS Module-Failure-Message may echo the User-Name / EAP identity)
 * and is reported as `module_message`, so no subscriber identifier reaches a dashboard or CSV.
 */
export const REASON_CODE_RE = /^[a-z0-9_]{1,64}$/;
export function reasonCode(column: string): RawBuilder<string | null> {
  const ref = sql.ref(column);
  return sql<string | null>`CASE WHEN ${ref} IS NULL THEN NULL
    WHEN ${ref} ~ '^[a-z0-9_]{1,64}$' THEN ${ref} ELSE 'module_message' END`;
}

/** `(VALUES (site_id, from_at, to_at, tz), …) AS v(site_id, from_at, to_at, tz)` */
export function boundsValues(bounds: readonly SiteBounds[]): RawBuilder<unknown> {
  if (bounds.length === 0) {
    // a row that joins nothing (VALUES needs at least one row)
    return sql`(VALUES (NULL::uuid, NULL::timestamptz, NULL::timestamptz, NULL::text)) AS v(site_id, from_at, to_at, tz)`;
  }
  return sql`(VALUES ${sql.join(
    bounds.map(
      (b) =>
        sql`(${b.site_id}::uuid, ${b.from_at.toISOString()}::timestamptz, ${b.to_at.toISOString()}::timestamptz, ${b.timezone}::text)`,
    ),
  )}) AS v(site_id, from_at, to_at, tz)`;
}

// ------------------------------------------------------------------ site-local day windows

/**
 * A local day range `[from, to]` per site (Q65). RADIUS requests without a NAS row are counted
 * only for an organization-level scope, on UTC days; rows of deleted sites are never counted.
 */
export interface DayWindow {
  bounds: SiteBounds[];
  includeUnplaced: boolean;
  utcFrom: Date;
  utcTo: Date;
  /** Overall instant range (index range condition). */
  minFrom: Date;
  maxTo: Date;
}

export function dayWindow(scope: ReportScope, from: string, to: string): DayWindow {
  const bounds = siteBounds(scope.sites, from, to);
  const utcFrom = new Date(`${from}T00:00:00Z`);
  const utcTo = new Date(Date.parse(`${to}T00:00:00Z`) + 86_400_000);
  const starts = [...bounds.map((b) => b.from_at.getTime())];
  const ends = [...bounds.map((b) => b.to_at.getTime())];
  if (scope.allSites || bounds.length === 0) {
    starts.push(utcFrom.getTime());
    ends.push(utcTo.getTime());
  }
  return {
    bounds,
    includeUnplaced: scope.allSites,
    utcFrom,
    utcTo,
    minFrom: new Date(Math.min(...starts)),
    maxTo: new Date(Math.max(...ends)),
  };
}

/**
 * Row placement for a `LEFT JOIN boundsValues(…) v`: inside its site's local range, or — for an
 * organization-level scope — a row without a site at all (`siteless`, e.g. no NAS row).
 */
export function placedIn(
  win: DayWindow,
  ts: string,
  siteless: RawBuilder<boolean>,
): RawBuilder<boolean> {
  const t = sql.ref(ts);
  return sql<boolean>`(
    ${t} >= ${win.minFrom.toISOString()}::timestamptz AND ${t} < ${win.maxTo.toISOString()}::timestamptz
    AND ((v.site_id IS NOT NULL AND ${t} >= v.from_at AND ${t} < v.to_at)
      OR (${win.includeUnplaced} AND v.site_id IS NULL AND ${siteless}
          AND ${t} >= ${win.utcFrom.toISOString()}::timestamptz
          AND ${t} < ${win.utcTo.toISOString()}::timestamptz)))`;
}

/** Site-local calendar date of `ts` (UTC for unplaced rows). */
export function localDateOf(ts: string): RawBuilder<string> {
  return sql<string>`to_char((${sql.ref(ts)} AT TIME ZONE COALESCE(v.tz, 'UTC'))::date, 'YYYY-MM-DD')`;
}

// ------------------------------------------------------------------ sessions

/**
 * Open sessions of the scope (partial index 026) with the distinct live subscribers and client
 * MACs among them. Subscribers are joined by primary key (1:1, so the session counts are
 * unchanged); soft-deleted subscribers are not counted. Exported so tests EXPLAIN the real SQL.
 */
export function openSessionCountsQuery(
  scope: ReportScope,
): RawBuilder<{ authorized: string; active: string; users: string; devices: string }> {
  return sql<{ authorized: string; active: string; users: string; devices: string }>`
    SELECT count(*) FILTER (WHERE s.status = 'authorized') AS authorized,
           count(*) FILTER (WHERE s.status = 'active') AS active,
           count(DISTINCT u.id) AS users,
           count(DISTINCT s.mac) AS devices
    FROM sessions s
    LEFT JOIN users u ON u.id = s.user_id AND u.deleted_at IS NULL
    WHERE s.organization_id = ${scope.orgId}
      AND s.status IN ('authorized', 'active')
      AND ${siteFilter(scope, 's.site_id')}
  `;
}

export async function openSessionCounts(
  trx: DbExecutor,
  scope: ReportScope,
): Promise<{ authorized: number; active: number; users: number; devices: number }> {
  const r = await openSessionCountsQuery(scope).execute(trx);
  const row = r.rows[0];
  return {
    authorized: n(row?.authorized),
    active: n(row?.active),
    users: n(row?.users),
    devices: n(row?.devices),
  };
}

// ------------------------------------------------------------------ subscribers (users)

/** Rolling window of the "active users" figure. */
export const ACTIVE_USERS_DAYS = 30;

/**
 * Distinct live subscriber records (`sessions.user_id`, not soft-deleted) with a session started
 * in `[since, now]` or still open: two index-supported branches (org + site + started_at,
 * migration 024; the open partial index, migration 026), then a primary-key join to `users`.
 * Expired authorizations are not sessions (D-036); sessions without a subscriber record are not
 * counted.
 */
export function activeUsersQuery(scope: ReportScope, since: Date): RawBuilder<{ n: string }> {
  return sql<{ n: string }>`
    SELECT count(DISTINCT x.user_id) AS n FROM (
      SELECT user_id FROM sessions
      WHERE organization_id = ${scope.orgId}
        AND started_at >= ${since.toISOString()}::timestamptz
        AND status <> 'expired'
        AND user_id IS NOT NULL
        AND ${siteFilter(scope, 'site_id')}
      UNION ALL
      SELECT user_id FROM sessions
      WHERE organization_id = ${scope.orgId}
        AND status IN ('authorized', 'active')
        AND user_id IS NOT NULL
        AND ${siteFilter(scope, 'site_id')}
    ) x
    JOIN users u ON u.id = x.user_id AND u.deleted_at IS NULL
  `;
}

export async function activeUsersSince(
  trx: DbExecutor,
  scope: ReportScope,
  since: Date,
): Promise<number> {
  const r = await activeUsersQuery(scope, since).execute(trx);
  return n(r.rows[0]?.n);
}

/**
 * Live subscriber records created since their site's local midnight (Q65, as
 * `sessionsStartedSince`). Subscribers without a site belong to the whole organization: they are
 * counted only for an organization-level scope, from UTC midnight (the convention for rows
 * without a site, see `dayWindow`). Bounded by the organization (RLS + `organization_id`
 * prefix of the users indexes) and the creation instant. Null when nothing can match.
 */
export function usersCreatedQuery(
  scope: ReportScope,
  starts: readonly { site_id: string; since: Date }[],
  utcMidnight: Date,
): RawBuilder<{ n: string }> | null {
  const includeSiteless = scope.allSites;
  if (starts.length === 0 && !includeSiteless) return null;
  const minSince = new Date(
    Math.min(
      ...starts.map((s) => s.since.getTime()),
      ...(includeSiteless ? [utcMidnight.getTime()] : []),
    ),
  );
  const values =
    starts.length === 0
      ? sql`(VALUES (NULL::uuid, NULL::timestamptz)) AS v(site_id, since)`
      : sql`(VALUES ${sql.join(
          starts.map((t) => sql`(${t.site_id}::uuid, ${t.since.toISOString()}::timestamptz)`),
        )}) AS v(site_id, since)`;
  return sql<{ n: string }>`
    SELECT count(*) AS n
    FROM users u
    LEFT JOIN ${values} ON v.site_id = u.site_id
    WHERE u.organization_id = ${scope.orgId}
      AND u.deleted_at IS NULL
      AND u.created_at >= ${minSince.toISOString()}::timestamptz
      AND ((v.site_id IS NOT NULL AND u.created_at >= v.since)
        OR (${includeSiteless} AND u.site_id IS NULL
            AND u.created_at >= ${utcMidnight.toISOString()}::timestamptz))
  `;
}

export async function usersCreatedSince(
  trx: DbExecutor,
  scope: ReportScope,
  starts: readonly { site_id: string; since: Date }[],
  utcMidnight: Date,
): Promise<number> {
  const q = usersCreatedQuery(scope, starts, utcMidnight);
  if (q === null) return 0;
  const r = await q.execute(trx);
  return n(r.rows[0]?.n);
}

/** Sessions (not mere expired authorizations) started since each site's local midnight. */
export async function sessionsStartedSince(
  trx: DbExecutor,
  orgId: string,
  starts: readonly { site_id: string; since: Date }[],
): Promise<number> {
  if (starts.length === 0) return 0;
  const r = await sql<{ n: string }>`
    SELECT count(*) AS n
    FROM sessions s
    JOIN (VALUES ${sql.join(
      starts.map((t) => sql`(${t.site_id}::uuid, ${t.since.toISOString()}::timestamptz)`),
    )}) AS v(site_id, since) ON v.site_id = s.site_id
    WHERE s.organization_id = ${orgId}
      AND s.started_at >= v.since
      AND s.status <> 'expired'
  `.execute(trx);
  return n(r.rows[0]?.n);
}

// ------------------------------------------------------------------ usage (site counters)

export interface CounterSums {
  bytes_in: number;
  bytes_out: number;
  bytes_total: number;
  session_count: number;
  session_time_s: number;
}

export function counterSums(r: {
  bytes_in?: unknown;
  bytes_out?: unknown;
  session_count?: unknown;
  session_time_s?: unknown;
}): CounterSums {
  const bytesIn = n(r.bytes_in);
  const bytesOut = n(r.bytes_out);
  return {
    bytes_in: bytesIn,
    bytes_out: bytesOut,
    bytes_total: bytesIn + bytesOut,
    session_count: n(r.session_count),
    session_time_s: n(r.session_time_s),
  };
}

/** Sum of the `site` counters at each site's own period label (PK lookups). */
export async function siteCountersAt(
  trx: DbExecutor,
  orgId: string,
  period: 'daily' | 'monthly',
  labels: readonly { site_id: string; label: string }[],
): Promise<{ sums: CounterSums; lastUpdated: Date | null }> {
  if (labels.length === 0) return { sums: counterSums({}), lastUpdated: null };
  const r = await sql<{
    bytes_in: string | null;
    bytes_out: string | null;
    session_count: string | null;
    session_time_s: string | null;
    last_updated: Date | null;
  }>`
    SELECT sum(u.bytes_in) AS bytes_in, sum(u.bytes_out) AS bytes_out,
           sum(u.session_count) AS session_count, sum(u.session_time_s) AS session_time_s,
           max(u.updated_at) AS last_updated
    FROM usage_counters u
    JOIN (VALUES ${sql.join(
      labels.map((l) => sql`(${l.site_id}::uuid, ${l.label}::date)`),
    )}) AS v(site_id, label) ON v.site_id = u.subject_id AND v.label = u.period_start
    WHERE u.organization_id = ${orgId}
      AND u.subject_type = 'site'
      AND u.period_type = ${period}
  `.execute(trx);
  const row = r.rows[0];
  return { sums: counterSums(row ?? {}), lastUpdated: row?.last_updated ?? null };
}

// ------------------------------------------------------------------ authentication outcomes

export interface OutcomeRow {
  method: string | null;
  result: string;
  count: number;
  lockouts: number;
}

export async function radiusOutcomes(
  trx: DbExecutor,
  scope: ReportScope,
  from: Date,
  to: Date,
): Promise<OutcomeRow[]> {
  const r = await sql<{ method: string | null; result: string; count: string }>`
    SELECT auth_method AS method, result, count(*) AS count
    FROM auth_events
    WHERE organization_id = ${scope.orgId}
      AND created_at >= ${from.toISOString()}::timestamptz
      AND created_at < ${to.toISOString()}::timestamptz
      AND ${nasFilter(scope, 'nas_client_id')}
    GROUP BY auth_method, result
  `.execute(trx);
  return r.rows.map((x) => ({
    method: x.method,
    result: x.result,
    count: n(x.count),
    lockouts: 0,
  }));
}

export async function portalOutcomes(
  trx: DbExecutor,
  scope: ReportScope,
  from: Date,
  to: Date,
): Promise<OutcomeRow[]> {
  const r = await sql<{ method: string; result: string; count: string; lockouts: string }>`
    SELECT method, result, count(*) AS count, count(*) FILTER (WHERE triggered_lockout) AS lockouts
    FROM portal_login_attempts
    WHERE organization_id = ${scope.orgId}
      AND created_at >= ${from.toISOString()}::timestamptz
      AND created_at < ${to.toISOString()}::timestamptz
      AND ${portalFilter(scope, 'captive_portal_id')}
    GROUP BY method, result
  `.execute(trx);
  return r.rows.map((x) => ({
    method: x.method,
    result: x.result,
    count: n(x.count),
    lockouts: n(x.lockouts),
  }));
}

export interface ReasonRow {
  source: 'radius' | 'portal';
  reason: string;
  count: number;
}

export async function topRejectReasons(
  trx: DbExecutor,
  scope: ReportScope,
  from: Date,
  to: Date,
  limit: number,
): Promise<ReasonRow[]> {
  const r = await sql<{ source: 'radius' | 'portal'; reason: string; count: string }>`
    (SELECT 'radius' AS source, COALESCE(${reasonCode('reason')}, 'unspecified') AS reason,
            count(*) AS count
     FROM auth_events
     WHERE organization_id = ${scope.orgId} AND result = 'reject'
       AND created_at >= ${from.toISOString()}::timestamptz
       AND created_at < ${to.toISOString()}::timestamptz
       AND ${nasFilter(scope, 'nas_client_id')}
     GROUP BY 2 ORDER BY 3 DESC, 2 LIMIT ${limit})
    UNION ALL
    (SELECT 'portal' AS source, COALESCE(${reasonCode('reason')}, 'unspecified') AS reason,
            count(*) AS count
     FROM portal_login_attempts
     WHERE organization_id = ${scope.orgId} AND result = 'reject'
       AND created_at >= ${from.toISOString()}::timestamptz
       AND created_at < ${to.toISOString()}::timestamptz
       AND ${portalFilter(scope, 'captive_portal_id')}
     GROUP BY 2 ORDER BY 3 DESC, 2 LIMIT ${limit})
  `.execute(trx);
  return r.rows
    .map((x) => ({ source: x.source, reason: x.reason, count: n(x.count) }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason))
    .slice(0, limit);
}

// ------------------------------------------------------------------ enforcement / anomalies

export async function enforcementPending(
  trx: DbExecutor,
  scope: ReportScope,
  now: Date,
): Promise<{ pending: number; overdue: number; oldest_pending_at: string | null }> {
  const r = await sql<{ pending: string; overdue: string; oldest: Date | null }>`
    SELECT count(*) AS pending,
           count(*) FILTER (WHERE se.expected_apply_by < ${now.toISOString()}::timestamptz) AS overdue,
           min(se.created_at) AS oldest
    FROM session_enforcement se
    JOIN sessions s ON s.id = se.session_id
    WHERE se.organization_id = ${scope.orgId}
      AND se.state = 'pending'
      AND ${siteFilter(scope, 's.site_id')}
  `.execute(trx);
  const row = r.rows[0];
  return {
    pending: n(row?.pending),
    overdue: n(row?.overdue),
    oldest_pending_at: row?.oldest?.toISOString() ?? null,
  };
}

export async function anomalyCounts(
  trx: DbExecutor,
  scope: ReportScope,
  from: Date,
  to: Date,
): Promise<{ count: number; estimated_lost_bytes: number }> {
  const r = await sql<{ count: string; lost: string | null }>`
    SELECT count(*) AS count, sum(a.estimated_lost_bytes) AS lost
    FROM accounting_anomalies a
    JOIN sessions s ON s.id = a.session_id
    WHERE a.organization_id = ${scope.orgId}
      AND a.created_at >= ${from.toISOString()}::timestamptz
      AND a.created_at < ${to.toISOString()}::timestamptz
      AND ${siteFilter(scope, 's.site_id')}
  `.execute(trx);
  return { count: n(r.rows[0]?.count), estimated_lost_bytes: n(r.rows[0]?.lost) };
}

// ------------------------------------------------------------------ observed NAS activity

/** NAS rows examined per request; beyond it the activity block says `truncated`. */
export const NAS_SCAN_CAP = 2_000;

export interface NasActivity {
  organization_id: string;
  nas_client_id: string;
  name: string;
  site_id: string;
  site_name: string;
  nas_ip: string;
  adapter_type_key: string;
  admin_status: string;
  activity: NasActivityStatus;
  last_auth_request_at: string | null;
  last_accounting_at: string | null;
  last_activity_at: string | null;
  open_sessions: number;
}

/**
 * Per live NAS of a live site: newest Access-Request (auth_events by organization + NAS id,
 * index 026), newest accounting record (accounting_records carry no NAS id: matched by
 * organization + NAS IP and only from the NAS row's creation on, so a reused IP never inherits a
 * deleted NAS's activity; index 026) and open sessions
 * (partial index 026). Each probe is `ORDER BY … DESC LIMIT 1` per partition.
 */
export async function nasActivity(
  trx: DbExecutor,
  orgIds: readonly string[],
  scope: ReportScope | null,
  now: Date,
  thresholds: ActivityThresholds,
  cap: number = NAS_SCAN_CAP,
): Promise<{ rows: NasActivity[]; truncated: boolean }> {
  if (orgIds.length === 0) return { rows: [], truncated: false };
  const filter = scope === null ? sql<boolean>`true` : siteFilter(scope, 'n.site_id');
  const r = await sql<{
    organization_id: string;
    id: string;
    name: string;
    site_id: string;
    site_name: string;
    nas_ip: string;
    adapter_type_key: string;
    status: string;
    last_auth: Date | null;
    last_acct: Date | null;
    open_sessions: string;
  }>`
    SELECT n.organization_id, n.id, n.name, n.site_id, st.name AS site_name,
           host(n.nas_ip) AS nas_ip, n.adapter_type_key, n.status,
           (SELECT ae.created_at FROM auth_events ae
             WHERE ae.organization_id = n.organization_id AND ae.nas_client_id = n.id
             ORDER BY ae.created_at DESC LIMIT 1) AS last_auth,
           (SELECT ar.received_at FROM accounting_records ar
             WHERE ar.organization_id = n.organization_id AND ar.nas_ip = n.nas_ip
               AND ar.received_at >= n.created_at
             ORDER BY ar.received_at DESC LIMIT 1) AS last_acct,
           (SELECT count(*) FROM sessions s
             WHERE s.organization_id = n.organization_id AND s.site_id = n.site_id
               AND s.nas_client_id = n.id AND s.status IN ('authorized', 'active')) AS open_sessions
    FROM nas_clients n
    JOIN sites st ON st.id = n.site_id AND st.deleted_at IS NULL
    WHERE n.organization_id IN (${sql.join([...orgIds])})
      AND n.deleted_at IS NULL
      AND ${filter}
    ORDER BY n.organization_id, st.name, n.name, n.id
    LIMIT ${cap + 1}
  `.execute(trx);
  const truncated = r.rows.length > cap;
  const rows = r.rows.slice(0, cap).map((x) => {
    const last = newestOf(x.last_auth, x.last_acct);
    return {
      organization_id: x.organization_id,
      nas_client_id: x.id,
      name: x.name,
      site_id: x.site_id,
      site_name: x.site_name,
      nas_ip: x.nas_ip,
      adapter_type_key: x.adapter_type_key,
      admin_status: x.status,
      activity: classifyActivity(now, last, thresholds),
      last_auth_request_at: x.last_auth?.toISOString() ?? null,
      last_accounting_at: x.last_acct?.toISOString() ?? null,
      last_activity_at: last?.toISOString() ?? null,
      open_sessions: n(x.open_sessions),
    };
  });
  return { rows, truncated };
}

export function activityCounts(rows: readonly { activity: NasActivityStatus }[]): {
  active: number;
  quiet: number;
  silent: number;
  never: number;
} {
  const c = { active: 0, quiet: 0, silent: 0, never: 0 };
  for (const r of rows) c[r.activity] += 1;
  return c;
}

export async function networkDevicesRegistered(
  trx: DbExecutor,
  scope: ReportScope,
): Promise<number> {
  const r = await sql<{ n: string }>`
    SELECT count(*) AS n FROM network_devices
    WHERE organization_id = ${scope.orgId} AND deleted_at IS NULL
      AND ${siteFilter(scope, 'site_id')}
  `.execute(trx);
  return n(r.rows[0]?.n);
}

export { n as toCount };
