/**
 * On-demand reports (Phase 9 P9-A; API_ARCHITECTURE.md "P9-A" items 3–5): usage by site, auth
 * outcomes, session summary and observed NAS activity over site-local periods (Q65), as JSON
 * (`report:read`) and CSV (`report:export`). The CSV path reuses the P8 export guard: refused
 * while impersonating (D-027), Read Only lacks `report:export` (Q75), 10 exports / hour /
 * principal consumed only after every refusal check, formula-injection-safe CSV, audited.
 */
import type { DbTransaction } from '@ecloud/db';
import { NotFoundError } from '@ecloud/shared';
import { sql } from 'kysely';
import { z } from 'zod';
import { freshnessOf, seriesRange, type Freshness } from '../accounting-views.js';
import { writeAudit } from '../audit.js';
import type { AppDeps, RequestContext } from '../context.js';
import {
  NAS_SCAN_CAP,
  boundsValues,
  dayWindow,
  localDateOf,
  nasActivity,
  placedIn,
  reasonCode,
  resolveScope,
  siteFilter,
  toCount,
  type ReportScope,
} from '../dashboard-queries.js';
import {
  MAX_DAY_BUCKETS,
  activityDefinition,
  activityThresholds,
  resolveDayRange,
  type ActivityThresholds,
} from '../dashboard-views.js';
import {
  assertExportBudgetAvailable,
  consumeExportBudget,
  refuseWhileImpersonating,
} from '../export-guard.js';
import { OrgParams, problemResponses } from '../http/common.js';
import { toCsv } from '../http/csv.js';
import { UnprocessableError } from '../http/errors.js';
import { defineRoute, type AnyRouteSpec } from '../http/route.js';
import { inTenant } from '../tenant.js';

const TAG = ['reports'];
/** JSON responses: beyond this the caller narrows the range or exports. */
export const REPORT_JSON_MAX_ROWS = 10_000;
/** CSV exports (same cap as the P8 usage export). */
export const REPORT_EXPORT_MAX_ROWS = 50_000;

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');

/** Union of every report's parameters; each report reads the ones it declares. */
const ReportParams = z.object({
  site_id: z.uuid().optional(),
  from: DATE.optional(),
  to: DATE.optional(),
  period: z.enum(['daily', 'monthly']).optional(),
});
type ReportParamsInput = z.output<typeof ReportParams>;

type ColumnType = 'string' | 'number' | 'date' | 'datetime';
interface ColumnDef {
  key: string;
  label: string;
  type: ColumnType;
  unit: string | null;
}
interface ParamDef {
  name: string;
  type: string;
  required: boolean;
  default: string | null;
  description: string;
}

interface RunContext {
  trx: DbTransaction;
  scope: ReportScope;
  params: ReportParamsInput;
  at: Date;
  cap: number;
  thresholds: ActivityThresholds;
}

interface RunResult {
  rows: Record<string, unknown>[];
  resolved: Record<string, unknown>;
  timezone: string;
  label_basis: string;
  notes: string[];
  /** Newest accounting reflected (usage / session reports), undefined when not applicable. */
  lastAccounting?: Date | null;
}

interface ReportDef {
  key: string;
  title: string;
  description: string;
  params: ParamDef[];
  columns: ColumnDef[];
  run: (c: RunContext) => Promise<RunResult>;
}

const col = (
  key: string,
  label: string,
  type: ColumnType,
  unit: string | null = null,
): ColumnDef => ({
  key,
  label,
  type,
  unit,
});

const SITE_PARAM: ParamDef = {
  name: 'site_id',
  type: 'uuid',
  required: false,
  default: null,
  description: 'Restrict to one site (default: every site the caller may read)',
};
const dateParams = (defaultText: string, max: string): ParamDef[] => [
  {
    name: 'from',
    type: 'date',
    required: false,
    default: null,
    description: `First local day YYYY-MM-DD, inclusive (default: ${defaultText}; ${max})`,
  },
  {
    name: 'to',
    type: 'date',
    required: false,
    default: null,
    description: 'Last local day YYYY-MM-DD, inclusive (default: today)',
  },
];

const singleTz = (scope: ReportScope) => (scope.timezone === 'mixed' ? 'UTC' : scope.timezone);
const localBasis = (scope: ReportScope) =>
  scope.timezone === 'mixed'
    ? 'site-local dates: each site counts its own local days (Q65)'
    : `local dates in ${scope.timezone} (Q65)`;

function newest(rows: readonly { last?: unknown }[]): Date | null {
  let out: Date | null = null;
  for (const r of rows) {
    if (r.last instanceof Date && (out === null || r.last > out)) out = r.last;
  }
  return out;
}

function stripLast(row: Record<string, unknown>): Record<string, unknown> {
  const { last: _last, ...rest } = row;
  return rest;
}

const nums = (row: Record<string, unknown>, keys: readonly string[]) => {
  const out: Record<string, unknown> = { ...row };
  for (const k of keys) out[k] = toCount(row[k]);
  return out;
};

// ------------------------------------------------------------------ definitions

const usageBySite: ReportDef = {
  key: 'usage_by_site',
  title: 'Usage by site',
  description:
    'Bytes, sessions and session time per site and site-local day or month, from the site usage counters (migration 024 on).',
  params: [
    {
      name: 'period',
      type: 'enum(daily|monthly)',
      required: false,
      default: 'daily',
      description: 'Bucket size',
    },
    ...dateParams(
      '31 days, or 13 months for monthly',
      `at most ${String(MAX_DAY_BUCKETS)} days / 60 months`,
    ),
    SITE_PARAM,
  ],
  columns: [
    col('site_id', 'Site ID', 'string'),
    col('site_name', 'Site', 'string'),
    col('period_start', 'Period start', 'date'),
    col('bytes_in', 'Bytes in', 'number', 'bytes'),
    col('bytes_out', 'Bytes out', 'number', 'bytes'),
    col('bytes_total', 'Bytes total', 'number', 'bytes'),
    col('session_count', 'Sessions', 'number'),
    col('session_time_s', 'Session time', 'number', 'seconds'),
  ],
  run: async ({ trx, scope, params, at, cap }) => {
    const period = params.period ?? 'daily';
    const range =
      period === 'daily'
        ? resolveDayRange(at, singleTz(scope), 31, MAX_DAY_BUCKETS, params.from, params.to)
        : seriesRange('monthly', at, singleTz(scope), params.from, params.to);
    const r = await sql<Record<string, unknown>>`
      SELECT u.subject_id AS site_id, st.name AS site_name,
             to_char(u.period_start, 'YYYY-MM-DD') AS period_start,
             u.bytes_in, u.bytes_out, u.bytes_in + u.bytes_out AS bytes_total,
             u.session_count, u.session_time_s, u.updated_at AS last
      FROM usage_counters u
      JOIN sites st ON st.id = u.subject_id
      WHERE u.organization_id = ${scope.orgId}
        AND u.subject_type = 'site' AND u.period_type = ${period}
        AND u.period_start >= ${range.from}::date AND u.period_start <= ${range.to}::date
        AND ${siteFilter(scope, 'u.subject_id')}
      ORDER BY u.period_start, st.name, u.subject_id
      LIMIT ${cap + 1}
    `.execute(trx);
    return {
      rows: r.rows.map((x) =>
        nums(x, ['bytes_in', 'bytes_out', 'bytes_total', 'session_count', 'session_time_s']),
      ),
      resolved: { period, from: range.from, to: range.to, site_id: scope.siteId },
      timezone: scope.timezone,
      label_basis: `${localBasis(scope)}; rows only for periods with data`,
      notes: ['Site counters start at migration 024 (no backfill): earlier usage is not included.'],
      lastAccounting: newest(r.rows),
    };
  },
};

const authOutcomes: ReportDef = {
  key: 'auth_outcomes',
  title: 'Authentication outcomes',
  description:
    'RADIUS Access-Request results (auth_events) and captive-portal login attempts per site-local day, method, result and reason code.',
  params: [
    ...dateParams('the last 31 days', `at most ${String(MAX_DAY_BUCKETS)} days`),
    SITE_PARAM,
  ],
  columns: [
    col('period_start', 'Day', 'date'),
    col('site_id', 'Site ID', 'string'),
    col('site_name', 'Site', 'string'),
    col('source', 'Source', 'string'),
    col('method', 'Method', 'string'),
    col('result', 'Result', 'string'),
    col('reason', 'Reason', 'string'),
    col('count', 'Count', 'number'),
    col('lockouts', 'Lockouts triggered', 'number'),
  ],
  run: async ({ trx, scope, params, at, cap }) => {
    const range = resolveDayRange(at, singleTz(scope), 31, MAX_DAY_BUCKETS, params.from, params.to);
    const win = dayWindow(scope, range.from, range.to);
    const r = await sql<Record<string, unknown>>`
      WITH o AS (
        SELECT ${localDateOf('ae.created_at')} AS period_start, v.site_id,
               'radius'::text AS source, ae.auth_method AS method, ae.result,
               ${reasonCode('ae.reason')} AS reason,
               count(*) AS count, 0::bigint AS lockouts
        FROM auth_events ae
        LEFT JOIN nas_clients nc ON nc.id = ae.nas_client_id
        LEFT JOIN ${boundsValues(win.bounds)} ON v.site_id = nc.site_id
        WHERE ae.organization_id = ${scope.orgId} AND ${placedIn(win, 'ae.created_at', sql<boolean>`ae.nas_client_id IS NULL`)}
        GROUP BY 1, 2, 3, 4, 5, 6
        UNION ALL
        SELECT ${localDateOf('p.created_at')} AS period_start, v.site_id,
               'portal'::text AS source, p.method, p.result, ${reasonCode('p.reason')} AS reason,
               count(*) AS count, count(*) FILTER (WHERE p.triggered_lockout) AS lockouts
        FROM portal_login_attempts p
        JOIN captive_portals cp ON cp.id = p.captive_portal_id
        LEFT JOIN ${boundsValues(win.bounds)} ON v.site_id = cp.site_id
        WHERE p.organization_id = ${scope.orgId} AND ${placedIn(win, 'p.created_at', sql<boolean>`false`)}
        GROUP BY 1, 2, 3, 4, 5, 6
      )
      SELECT o.period_start, o.site_id, st.name AS site_name, o.source, o.method, o.result,
             o.reason, o.count, o.lockouts
      FROM o
      LEFT JOIN sites st ON st.id = o.site_id
      ORDER BY o.period_start, st.name NULLS LAST, o.source, o.method NULLS FIRST, o.result,
               o.reason NULLS FIRST
      LIMIT ${cap + 1}
    `.execute(trx);
    return {
      rows: r.rows.map((x) => nums(x, ['count', 'lockouts'])),
      resolved: { from: range.from, to: range.to, site_id: scope.siteId },
      timezone: scope.timezone,
      label_basis: `${localBasis(scope)}; RADIUS requests without a NAS row of the scope on UTC days (organization-level only)`,
      notes: [
        'Portal lockouts are recorded from migration 026 on (attempts that activated a lock).',
        'Reasons are ECLOUD reason codes; free-text RADIUS module messages (which may echo a username) are reported as module_message.',
      ],
    };
  },
};

const sessionSummary: ReportDef = {
  key: 'session_summary',
  title: 'Session summary',
  description:
    'Sessions started per site and site-local day: distinct devices and users, still open, and the traffic / time of those sessions as currently known.',
  params: [
    ...dateParams('the last 31 days', `at most ${String(MAX_DAY_BUCKETS)} days`),
    SITE_PARAM,
  ],
  columns: [
    col('period_start', 'Day', 'date'),
    col('site_id', 'Site ID', 'string'),
    col('site_name', 'Site', 'string'),
    col('sessions_started', 'Sessions started', 'number'),
    col('distinct_devices', 'Distinct devices', 'number'),
    col('distinct_users', 'Distinct users', 'number'),
    col('still_open', 'Still open', 'number'),
    col('bytes_in', 'Bytes in', 'number', 'bytes'),
    col('bytes_out', 'Bytes out', 'number', 'bytes'),
    col('bytes_total', 'Bytes total', 'number', 'bytes'),
    col('session_time_s', 'Session time', 'number', 'seconds'),
    col('avg_session_time_s', 'Average session time', 'number', 'seconds'),
  ],
  run: async ({ trx, scope, params, at, cap }) => {
    const range = resolveDayRange(at, singleTz(scope), 31, MAX_DAY_BUCKETS, params.from, params.to);
    const win = dayWindow(scope, range.from, range.to);
    if (win.bounds.length === 0) {
      return {
        rows: [],
        resolved: { from: range.from, to: range.to, site_id: scope.siteId },
        timezone: scope.timezone,
        label_basis: localBasis(scope),
        notes: [],
        lastAccounting: null,
      };
    }
    const r = await sql<Record<string, unknown>>`
      SELECT to_char((s.started_at AT TIME ZONE v.tz)::date, 'YYYY-MM-DD') AS period_start,
             s.site_id, st.name AS site_name,
             count(*) AS sessions_started,
             count(DISTINCT COALESCE(s.mac::text, s.calling_station_id)) AS distinct_devices,
             count(DISTINCT s.user_id) AS distinct_users,
             count(*) FILTER (WHERE s.status IN ('authorized', 'active')) AS still_open,
             sum(s.input_octets) AS bytes_in, sum(s.output_octets) AS bytes_out,
             sum(s.input_octets + s.output_octets) AS bytes_total,
             sum(s.session_time_s) AS session_time_s,
             round(avg(s.session_time_s)) AS avg_session_time_s,
             max(COALESCE(s.last_interim_at, s.stopped_at, s.started_at))
               FILTER (WHERE s.status IN ('active', 'stopped', 'stale')) AS last
      FROM sessions s
      JOIN ${boundsValues(win.bounds)} ON v.site_id = s.site_id
      JOIN sites st ON st.id = s.site_id
      WHERE s.organization_id = ${scope.orgId}
        AND s.started_at >= ${win.minFrom.toISOString()}::timestamptz
        AND s.started_at < ${win.maxTo.toISOString()}::timestamptz
        AND s.started_at >= v.from_at AND s.started_at < v.to_at
        AND s.status <> 'expired'
      GROUP BY 1, 2, 3
      ORDER BY 1, 3, 2
      LIMIT ${cap + 1}
    `.execute(trx);
    return {
      rows: r.rows.map((x) =>
        nums(x, [
          'sessions_started',
          'distinct_devices',
          'distinct_users',
          'still_open',
          'bytes_in',
          'bytes_out',
          'bytes_total',
          'session_time_s',
          'avg_session_time_s',
        ]),
      ),
      resolved: { from: range.from, to: range.to, site_id: scope.siteId },
      timezone: scope.timezone,
      label_basis: `${localBasis(scope)}; a session counts on the local day it started`,
      notes: [
        'Expired authorizations (never followed by accounting, D-036) are not sessions and are excluded.',
        'Traffic and time are the totals of the sessions that started that day, as last reported by accounting.',
      ],
      lastAccounting: newest(r.rows),
    };
  },
};

const nasActivityReport: ReportDef = {
  key: 'nas_activity',
  title: 'NAS activity (observed)',
  description:
    'Per NAS: newest RADIUS auth request and accounting record seen by ECLOUD, the observed-activity status, open sessions and window counts. Not a device online/offline state.',
  params: [...dateParams('the last 7 days', 'at most 31 days'), SITE_PARAM],
  columns: [
    col('nas_client_id', 'NAS ID', 'string'),
    col('name', 'NAS', 'string'),
    col('site_id', 'Site ID', 'string'),
    col('site_name', 'Site', 'string'),
    col('nas_ip', 'NAS IP', 'string'),
    col('adapter_type_key', 'Adapter', 'string'),
    col('admin_status', 'Admin status', 'string'),
    col('activity', 'Observed activity', 'string'),
    col('last_auth_request_at', 'Last auth request', 'datetime'),
    col('last_accounting_at', 'Last accounting', 'datetime'),
    col('last_activity_at', 'Last activity', 'datetime'),
    col('open_sessions', 'Open sessions', 'number'),
    col('auth_accept', 'Auth accepts (window)', 'number'),
    col('auth_reject', 'Auth rejects (window)', 'number'),
    col('sessions_started', 'Sessions started (window)', 'number'),
  ],
  run: async ({ trx, scope, params, at, cap, thresholds }) => {
    const range = resolveDayRange(at, singleTz(scope), 7, 31, params.from, params.to);
    const win = dayWindow(scope, range.from, range.to);
    const nas = await nasActivity(
      trx,
      [scope.orgId],
      scope,
      at,
      thresholds,
      Math.min(cap, NAS_SCAN_CAP),
    );
    const auth = new Map<string, { accept: number; reject: number }>();
    const started = new Map<string, number>();
    if (nas.rows.length > 0 && win.bounds.length > 0) {
      const a = await sql<{ nas_client_id: string; accept: string; reject: string }>`
        SELECT ae.nas_client_id,
               count(*) FILTER (WHERE ae.result = 'accept') AS accept,
               count(*) FILTER (WHERE ae.result = 'reject') AS reject
        FROM auth_events ae
        JOIN nas_clients nc ON nc.id = ae.nas_client_id
        JOIN ${boundsValues(win.bounds)} ON v.site_id = nc.site_id
        WHERE ae.organization_id = ${scope.orgId}
          AND ae.created_at >= ${win.minFrom.toISOString()}::timestamptz
          AND ae.created_at < ${win.maxTo.toISOString()}::timestamptz
          AND ae.created_at >= v.from_at AND ae.created_at < v.to_at
        GROUP BY 1
      `.execute(trx);
      for (const x of a.rows) {
        auth.set(x.nas_client_id, { accept: toCount(x.accept), reject: toCount(x.reject) });
      }
      const s = await sql<{ nas_client_id: string; n: string }>`
        SELECT s.nas_client_id, count(*) AS n
        FROM sessions s
        JOIN ${boundsValues(win.bounds)} ON v.site_id = s.site_id
        WHERE s.organization_id = ${scope.orgId}
          AND s.started_at >= ${win.minFrom.toISOString()}::timestamptz
          AND s.started_at < ${win.maxTo.toISOString()}::timestamptz
          AND s.started_at >= v.from_at AND s.started_at < v.to_at
          AND s.status <> 'expired'
        GROUP BY 1
      `.execute(trx);
      for (const x of s.rows) started.set(x.nas_client_id, toCount(x.n));
    }
    const rows = nas.rows.map((r) => {
      const { organization_id: _org, ...rest } = r;
      return {
        ...rest,
        auth_accept: auth.get(r.nas_client_id)?.accept ?? 0,
        auth_reject: auth.get(r.nas_client_id)?.reject ?? 0,
        sessions_started: started.get(r.nas_client_id) ?? 0,
      };
    });
    const notes = [activityDefinition(thresholds)];
    if (nas.truncated) {
      notes.push(`More than ${String(Math.min(cap, NAS_SCAN_CAP))} NAS: narrow with site_id.`);
    }
    return {
      rows,
      resolved: {
        from: range.from,
        to: range.to,
        site_id: scope.siteId,
        active_within_s: thresholds.active_within_s,
        quiet_within_s: thresholds.quiet_within_s,
      },
      timezone: scope.timezone,
      label_basis: `window counts over ${localBasis(scope)}; activity relative to measured_at`,
      notes,
    };
  },
};

export const REPORTS: readonly ReportDef[] = [
  usageBySite,
  authOutcomes,
  sessionSummary,
  nasActivityReport,
];

function reportOf(key: string): ReportDef {
  const def = REPORTS.find((r) => r.key === key);
  if (def === undefined) throw new NotFoundError('report', key);
  return def;
}

const ColumnSchema = z.object({
  key: z.string(),
  label: z.string(),
  type: z.enum(['string', 'number', 'date', 'datetime']),
  unit: z.string().nullable(),
});

const ReportListSchema = z
  .object({
    data: z.array(
      z.object({
        key: z.string(),
        title: z.string(),
        description: z.string(),
        params: z.array(
          z.object({
            name: z.string(),
            type: z.string(),
            required: z.boolean(),
            default: z.string().nullable(),
            description: z.string(),
          }),
        ),
        columns: z.array(ColumnSchema),
        export_permission: z.literal('report:export'),
      }),
    ),
  })
  .meta({ id: 'ReportDefinitions' });

const ReportResultSchema = z
  .object({
    report: z.string(),
    title: z.string(),
    params: z.record(z.string(), z.unknown()),
    timezone: z.string(),
    label_basis: z.string(),
    columns: z.array(ColumnSchema),
    rows: z.array(z.record(z.string(), z.unknown())),
    row_count: z.number(),
    measured_at: z.string(),
    notes: z.array(z.string()),
    freshness: z
      .object({
        measured_at: z.string(),
        last_accounting_at: z.string().nullable(),
        freshness_s: z.number().nullable(),
        expected_lag_s: z.number(),
      })
      .nullable(),
  })
  .meta({ id: 'ReportResult' });

const KeyParams = OrgParams.extend({ key: z.string().min(1).max(64) });

async function runReport(
  deps: AppDeps,
  ctx: RequestContext,
  trx: DbTransaction,
  def: ReportDef,
  orgId: string,
  params: ReportParamsInput,
  permission: 'report:read' | 'report:export',
  at: Date,
  cap: number,
): Promise<RunResult & { freshness: Freshness | null }> {
  const scope = await resolveScope(trx, ctx, orgId, permission, params.site_id);
  const result = await def.run({
    trx,
    scope,
    params,
    at,
    cap,
    thresholds: activityThresholds(deps.config.aaaInterimIntervalS),
  });
  if (result.rows.length > cap) {
    throw new UnprocessableError(
      `The report would exceed ${String(cap)} rows; narrow the period or the site${
        permission === 'report:read' ? ', or export it as CSV' : ''
      }.`,
      { max_rows: cap },
    );
  }
  return {
    ...result,
    rows: result.rows.map(stripLast),
    freshness:
      result.lastAccounting === undefined
        ? null
        : freshnessOf(at, result.lastAccounting, deps.config.aaaInterimIntervalS),
  };
}

export function reportRoutes(deps: AppDeps): AnyRouteSpec[] {
  const now = () => (deps.now ?? (() => new Date()))();

  const list = defineRoute({
    method: 'get',
    path: '/api/v1/orgs/:orgId/reports',
    summary: 'Available report definitions (parameters and columns)',
    tags: TAG,
    auth: 'principal',
    permission: 'report:read',
    scope: 'any-site',
    params: OrgParams,
    responses: {
      200: { description: 'Report definitions', schema: ReportListSchema },
      ...problemResponses,
    },
    handler: () =>
      Promise.resolve({
        status: 200,
        body: {
          data: REPORTS.map((r) => ({
            key: r.key,
            title: r.title,
            description: r.description,
            params: r.params,
            columns: r.columns,
            export_permission: 'report:export' as const,
          })),
        },
      }),
  });

  const get = defineRoute({
    method: 'get',
    path: '/api/v1/orgs/:orgId/reports/:key',
    summary: 'Run a report (JSON)',
    tags: TAG,
    auth: 'principal',
    permission: 'report:read',
    scope: 'any-site',
    params: KeyParams,
    query: ReportParams,
    responses: {
      200: { description: 'Report rows', schema: ReportResultSchema },
      422: { description: `More than ${String(REPORT_JSON_MAX_ROWS)} rows: narrow or export` },
      ...problemResponses,
    },
    handler: async ({ params, query, ctx }) => {
      const def = reportOf(params.key);
      const at = now();
      const result = await inTenant(deps, params.orgId, (trx) =>
        runReport(
          deps,
          ctx,
          trx,
          def,
          params.orgId,
          query,
          'report:read',
          at,
          REPORT_JSON_MAX_ROWS,
        ),
      );
      return {
        status: 200,
        body: {
          report: def.key,
          title: def.title,
          params: result.resolved,
          timezone: result.timezone,
          label_basis: result.label_basis,
          columns: def.columns,
          rows: result.rows,
          row_count: result.rows.length,
          measured_at: at.toISOString(),
          notes: result.notes,
          freshness: result.freshness,
        },
      };
    },
  });

  const exportReport = defineRoute({
    method: 'post',
    path: '/api/v1/orgs/:orgId/reports/:key/export',
    summary: 'Export a report as CSV (report:export; refused while impersonating)',
    tags: TAG,
    auth: 'principal',
    permission: 'report:export',
    scope: 'any-site',
    params: KeyParams,
    body: ReportParams,
    responses: {
      200: { description: 'text/csv report rows', schema: z.string(), contentType: 'text/csv' },
      422: { description: `More than ${String(REPORT_EXPORT_MAX_ROWS)} rows: narrow the range` },
      429: { description: 'Export rate limit (10 per hour per principal, shared with P8 exports)' },
      ...problemResponses,
    },
    handler: async ({ params, body, ctx }) => {
      refuseWhileImpersonating(ctx, 'report:export');
      const def = reportOf(params.key);
      // Budget already spent → 429 before the report query runs (nothing consumed here).
      await assertExportBudgetAvailable(deps, ctx);
      const at = now();
      const result = await inTenant(deps, params.orgId, async (trx) => {
        const r = await runReport(
          deps,
          ctx,
          trx,
          def,
          params.orgId,
          body,
          'report:export',
          at,
          REPORT_EXPORT_MAX_ROWS,
        );
        // Every refusal above is free; only an export that will be produced uses the budget.
        await consumeExportBudget(deps, ctx);
        await writeAudit(trx, ctx, {
          organizationId: params.orgId,
          action: 'report:export',
          targetType: 'report',
          after: { format: 'csv', report: def.key, params: r.resolved, rows: r.rows.length },
        });
        return r;
      });
      const csv = toCsv(
        def.columns.map((c) => c.key),
        result.rows.map((row) => def.columns.map((c) => row[c.key])),
      );
      const stamp = at.toISOString().slice(0, 10);
      return {
        status: 200,
        body: csv,
        contentType: 'text/csv; charset=utf-8',
        headers: {
          'Content-Disposition': `attachment; filename="report-${def.key}-${stamp}.csv"`,
          'Cache-Control': 'no-store',
        },
      };
    },
  });

  return [list, get, exportReport];
}
