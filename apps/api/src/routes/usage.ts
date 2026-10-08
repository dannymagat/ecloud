/**
 * Usage views (Phase 8 P8-A; API_ARCHITECTURE.md "P8-A" items 5, 6, 9): per user / client device
 * / voucher / site / organization over site-local day and month buckets (Q65) and total, top-N,
 * quota position against the policy the worker evaluates, CSV export (`report:export`).
 *
 * Every response carries the freshness fields: usage comes from RADIUS accounting, which reaches
 * ECLOUD at the NAS interim interval, so figures always lag (spec §6).
 */
import { ForbiddenError, NotFoundError, ValidationError } from '@ecloud/shared';
import type { DbTransaction, UsagePeriodType } from '@ecloud/db';
import { sql } from 'kysely';
import { z } from 'zod';
import {
  bucketStart,
  currentPeriodEndsAt,
  currentPeriodStart,
  freshnessOf,
  periodEndKey,
  quotaPeriods,
  seriesRange,
  type PeriodType,
} from '../accounting-views.js';
import { writeAudit } from '../audit.js';
import { evaluate, permittedSites } from '../auth/authorize.js';
import type { AppDeps, RequestContext } from '../context.js';
import { consumeExportBudget, refuseWhileImpersonating } from '../export-guard.js';
import { OrgParams, problemResponses } from '../http/common.js';
import { toCsv } from '../http/csv.js';
import { UnprocessableError } from '../http/errors.js';
import { defineRoute, type AnyRouteSpec } from '../http/route.js';
import { inTenant, requireOnSite } from '../tenant.js';

const TAG = ['usage'];
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
const PERIOD = z.enum(['daily', 'monthly', 'total']);
export const USAGE_EXPORT_MAX_ROWS = 50_000;

const UsageQuery = z
  .object({
    subject_type: z.enum(['user', 'client_device', 'voucher', 'site', 'organization']),
    subject_id: z.uuid().optional(),
    period: PERIOD.default('daily'),
    from: DATE.optional(),
    to: DATE.optional(),
  })
  .refine((q) => q.subject_type === 'organization' || q.subject_id !== undefined, {
    message: 'subject_id is required unless subject_type is organization',
    path: ['subject_id'],
  });

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

const UsageReportSchema = z
  .object({
    subject_type: z.string(),
    subject_id: z.string().nullable(),
    label: z.string().nullable(),
    period: PERIOD,
    timezone: z.string(),
    series: z.array(
      CountersSchema.extend({ period_start: z.string(), period_end: z.string().nullable() }),
    ),
    total: CountersSchema,
    current: CountersSchema.extend({
      period_start: z.string(),
      period_end: z.string().nullable(),
    }).nullable(),
    current_unavailable_reason: z.string().nullable(),
    label_basis: z.string(),
    quota: z
      .object({
        policy_id: z.string(),
        policy_name: z.string(),
        policy_source: z.enum(['open_session', 'last_session']),
        periods: z.array(
          z.object({
            period: PERIOD,
            limit_bytes: z.number(),
            used_bytes: z.number(),
            remaining_bytes: z.number(),
            exceeded: z.boolean(),
            period_start: z.string(),
            period_end: z.string().nullable(),
          }),
        ),
      })
      .nullable(),
    ...FreshnessFields,
  })
  .meta({
    id: 'UsageReport',
    description:
      'Usage of one subject over site-local periods with quota position and freshness (P8-A).',
  });

const TopSchema = z
  .object({
    subject_type: z.enum(['user', 'client_device', 'site']),
    period: PERIOD,
    /** Null when the default period was resolved per site and the site-local labels differ. */
    period_start: z.string().nullable(),
    label_basis: z.string(),
    data: z.array(
      CountersSchema.extend({
        rank: z.number(),
        subject_id: z.string(),
        label: z.string().nullable(),
        period_start: z.string(),
        last_accounting_at: z.string().nullable(),
      }),
    ),
    ...FreshnessFields,
  })
  .meta({ id: 'UsageTop' });

interface CounterRow {
  period_start: string;
  bytes_in: number;
  bytes_out: number;
  session_count: number;
  session_time_s: number;
  updated_at: Date;
}

function counters(
  r: Pick<CounterRow, 'bytes_in' | 'bytes_out' | 'session_count' | 'session_time_s'>,
) {
  const bytesIn = Number(r.bytes_in);
  const bytesOut = Number(r.bytes_out);
  return {
    bytes_in: bytesIn,
    bytes_out: bytesOut,
    bytes_total: bytesIn + bytesOut,
    session_count: Number(r.session_count),
    session_time_s: Number(r.session_time_s),
  };
}

function maxDate(dates: readonly (Date | null | undefined)[]): Date | null {
  let out: Date | null = null;
  for (const d of dates) if (d instanceof Date && (out === null || d > out)) out = d;
  return out;
}

type Subject =
  | { type: 'site'; id: string; label: string; siteId: string; timeZone: string }
  | {
      type: 'user' | 'client_device' | 'voucher';
      id: string;
      label: string | null;
      siteId: string | null;
      timeZone: string;
    }
  | { type: 'organization'; id: null; label: string | null; siteIds: string[]; timeZone: string };

async function newestSessionTimeZone(
  trx: DbTransaction,
  column: 'user_id' | 'client_device_id' | 'voucher_id',
  id: string,
): Promise<string | null> {
  const r = await trx
    .selectFrom('sessions as s')
    .innerJoin('sites as st', 'st.id', 's.site_id')
    .select('st.timezone')
    .where(`s.${column}`, '=', id)
    .orderBy('s.started_at', 'desc')
    .limit(1)
    .executeTakeFirst();
  return r?.timezone ?? null;
}

async function siteTimeZone(trx: DbTransaction, siteId: string | null): Promise<string | null> {
  if (siteId === null) return null;
  const r = await trx
    .selectFrom('sites')
    .select('timezone')
    .where('id', '=', siteId)
    .executeTakeFirst();
  return r?.timezone ?? null;
}

/** Loads the subject and enforces the site check (404 outside the caller's scope, G9). */
async function loadSubject(
  trx: DbTransaction,
  ctx: RequestContext,
  orgId: string,
  type: 'user' | 'client_device' | 'voucher' | 'site' | 'organization',
  id: string | undefined,
): Promise<Subject> {
  if (type === 'organization') {
    requireOnSite(ctx, 'accounting:read', orgId, null, 'organization');
    const org = await trx
      .selectFrom('organizations')
      .select('name')
      .where('id', '=', orgId)
      .executeTakeFirst();
    const sites = await trx.selectFrom('sites').select(['id', 'timezone']).execute();
    const zones = [...new Set(sites.map((s) => s.timezone))];
    return {
      type,
      id: null,
      label: org?.name ?? null,
      siteIds: sites.map((s) => s.id),
      timeZone: zones.length === 1 ? (zones[0] as string) : zones.length === 0 ? 'UTC' : 'mixed',
    };
  }
  const subjectId = id as string;
  if (type === 'site') {
    const s = await trx
      .selectFrom('sites')
      .select(['id', 'name', 'timezone'])
      .where('id', '=', subjectId)
      .executeTakeFirst();
    if (s === undefined) throw new NotFoundError('site', subjectId);
    requireOnSite(ctx, 'accounting:read', orgId, s.id, 'site');
    return { type, id: s.id, label: s.name, siteId: s.id, timeZone: s.timezone };
  }
  if (type === 'user') {
    const u = await trx
      .selectFrom('users')
      .select(['id', 'username', 'site_id'])
      .where('id', '=', subjectId)
      .executeTakeFirst();
    if (u === undefined) throw new NotFoundError('user', subjectId);
    requireOnSite(ctx, 'accounting:read', orgId, u.site_id, 'user');
    const tz =
      (await siteTimeZone(trx, u.site_id)) ?? (await newestSessionTimeZone(trx, 'user_id', u.id));
    return { type, id: u.id, label: u.username, siteId: u.site_id, timeZone: tz ?? 'UTC' };
  }
  if (type === 'client_device') {
    const d = await trx
      .selectFrom('client_devices')
      .select(['id', 'mac'])
      .where('id', '=', subjectId)
      .executeTakeFirst();
    if (d === undefined) throw new NotFoundError('client_device', subjectId);
    requireOnSite(ctx, 'accounting:read', orgId, null, 'client_device');
    const tz = await newestSessionTimeZone(trx, 'client_device_id', d.id);
    return { type, id: d.id, label: d.mac, siteId: null, timeZone: tz ?? 'UTC' };
  }
  const v = await trx
    .selectFrom('vouchers as v')
    .innerJoin('voucher_batches as b', 'b.id', 'v.batch_id')
    .select(['v.id', 'v.code_hint', 'b.site_id'])
    .where('v.id', '=', subjectId)
    .executeTakeFirst();
  if (v === undefined) throw new NotFoundError('voucher', subjectId);
  requireOnSite(ctx, 'accounting:read', orgId, v.site_id, 'voucher');
  const tz =
    (await siteTimeZone(trx, v.site_id)) ?? (await newestSessionTimeZone(trx, 'voucher_id', v.id));
  return { type, id: v.id, label: v.code_hint, siteId: v.site_id, timeZone: tz ?? 'UTC' };
}

/** Counter rows of a subject (organization = the sum of its site rows per period label). */
async function counterRows(
  trx: DbTransaction,
  subject: Subject,
  period: UsagePeriodType,
  starts: { from: string; to: string } | { in: string[] },
): Promise<CounterRow[]> {
  let q = trx
    .selectFrom('usage_counters')
    .select([
      'period_start',
      sql<number>`sum(bytes_in)::bigint`.as('bytes_in'),
      sql<number>`sum(bytes_out)::bigint`.as('bytes_out'),
      sql<number>`sum(session_count)::bigint`.as('session_count'),
      sql<number>`sum(session_time_s)::bigint`.as('session_time_s'),
      sql<Date>`max(updated_at)`.as('updated_at'),
    ])
    .where('period_type', '=', period);
  if (subject.type === 'organization') {
    if (subject.siteIds.length === 0) return [];
    q = q.where('subject_type', '=', 'site').where('subject_id', 'in', subject.siteIds);
  } else {
    q = q.where('subject_type', '=', subject.type).where('subject_id', '=', subject.id);
  }
  if ('in' in starts) q = q.where('period_start', 'in', starts.in);
  else q = q.where('period_start', '>=', starts.from).where('period_start', '<=', starts.to);
  return await q.groupBy('period_start').orderBy('period_start').execute();
}

const PERIODS: readonly PeriodType[] = ['daily', 'monthly', 'total'];

async function quotaPosition(
  trx: DbTransaction,
  subject: Subject,
  current: Map<PeriodType, CounterRow>,
  now: Date,
) {
  if (subject.type === 'site' || subject.type === 'organization') return null;
  const column =
    subject.type === 'user'
      ? 'user_id'
      : subject.type === 'client_device'
        ? 'client_device_id'
        : 'voucher_id';
  const base = trx
    .selectFrom('sessions as s')
    .innerJoin('policies as p', 'p.id', 's.policy_id')
    .select([
      'p.id',
      'p.name',
      'p.quota_daily_bytes',
      'p.quota_monthly_bytes',
      'p.quota_total_bytes',
    ])
    .where(`s.${column}`, '=', subject.id)
    .orderBy('s.started_at', 'desc')
    .limit(1);
  let source: 'open_session' | 'last_session' = 'open_session';
  let policy = await base.where('s.status', 'in', ['authorized', 'active']).executeTakeFirst();
  if (policy === undefined) {
    source = 'last_session';
    policy = await base.executeTakeFirst();
  }
  if (policy === undefined) return null;
  const used: Partial<Record<PeriodType, number>> = {};
  for (const p of PERIODS) {
    const r = current.get(p);
    if (r !== undefined) used[p] = Number(r.bytes_in) + Number(r.bytes_out);
  }
  return {
    policy_id: policy.id,
    policy_name: policy.name,
    policy_source: source,
    periods: quotaPeriods(
      {
        quota_daily_bytes: policy.quota_daily_bytes,
        quota_monthly_bytes: policy.quota_monthly_bytes,
        quota_total_bytes: policy.quota_total_bytes,
      },
      used,
      now,
      subject.timeZone === 'mixed' ? 'UTC' : subject.timeZone,
    ),
  };
}

/** Org-level grant required for subjects whose counters carry no site (users, devices). */
function requireOrgLevel(ctx: RequestContext, permission: string, orgId: string): void {
  if (!evaluate(ctx.principal, permission, { organizationId: orgId })) {
    throw new ForbiddenError({
      detail:
        'Usage by user or client device needs an organization-level grant (their counters carry no site).',
    });
  }
}

export function usageRoutes(deps: AppDeps): AnyRouteSpec[] {
  const now = () => (deps.now ?? (() => new Date()))();

  const usage = defineRoute({
    method: 'get',
    path: '/api/v1/orgs/:orgId/usage',
    summary:
      'Usage of a user / client device / voucher / site / organization (site-local periods, quota, freshness)',
    tags: TAG,
    auth: 'principal',
    permission: 'accounting:read',
    scope: 'any-site',
    params: OrgParams,
    query: UsageQuery,
    responses: {
      200: { description: 'UsageReport', schema: UsageReportSchema },
      ...problemResponses,
    },
    handler: async ({ params, query, ctx }) => {
      const at = now();
      const body = await inTenant(deps, params.orgId, async (trx) => {
        const subject = await loadSubject(
          trx,
          ctx,
          params.orgId,
          query.subject_type,
          query.subject_id,
        );
        const mixed = subject.timeZone === 'mixed';
        const tz = mixed ? 'UTC' : subject.timeZone;
        const range = seriesRange(query.period, at, tz, query.from, query.to);
        const series = await counterRows(trx, subject, query.period, range);
        const currentStarts = PERIODS.map((p) => currentPeriodStart(p, at, tz));
        const currentRows = new Map<PeriodType, CounterRow>();
        for (const [i, p] of PERIODS.entries()) {
          // No single "current" day/month exists across timezones (only `total` is common).
          if (mixed && p !== 'total') continue;
          const rows = await counterRows(trx, subject, p, { in: [currentStarts[i] as string] });
          if (rows[0] !== undefined) currentRows.set(p, rows[0]);
        }
        const cur = currentRows.get(query.period);
        const totals = series.reduce(
          (acc, r) => {
            const c = counters(r);
            acc.bytes_in += c.bytes_in;
            acc.bytes_out += c.bytes_out;
            acc.session_count += c.session_count;
            acc.session_time_s += c.session_time_s;
            return acc;
          },
          { bytes_in: 0, bytes_out: 0, session_count: 0, session_time_s: 0 },
        );
        const last = maxDate([
          ...series.map((r) => r.updated_at),
          ...[...currentRows.values()].map((r) => r.updated_at),
        ]);
        return {
          subject_type: query.subject_type,
          subject_id: subject.id,
          label: subject.label,
          period: query.period,
          timezone: subject.timeZone,
          series: series.map((r) => ({
            period_start: r.period_start,
            period_end: periodEndKey(query.period, r.period_start),
            ...counters(r),
          })),
          total: { ...totals, bytes_total: totals.bytes_in + totals.bytes_out },
          current:
            cur === undefined || mixed
              ? null
              : {
                  period_start: cur.period_start,
                  period_end: currentPeriodEndsAt(query.period, at, tz)?.toISOString() ?? null,
                  ...counters(cur),
                },
          current_unavailable_reason: mixed
            ? 'The organization has sites in several timezones: each site counts its own local day/month, so there is no single current period. Query the sites individually.'
            : null,
          label_basis: mixed
            ? 'period_start labels are site-local dates summed across sites in different timezones (Q65); a label is not one common instant'
            : `period_start labels are local dates in ${tz} (Q65)`,
          quota: await quotaPosition(trx, subject, currentRows, at),
          ...freshnessOf(at, last, deps.config.aaaInterimIntervalS),
        };
      });
      return { status: 200, body };
    },
  });

  const top = defineRoute({
    method: 'get',
    path: '/api/v1/orgs/:orgId/usage/top',
    summary: 'Top-N users / client devices / sites by bytes for one period',
    tags: TAG,
    auth: 'principal',
    permission: 'accounting:read',
    scope: 'any-site',
    params: OrgParams,
    query: z.object({
      subject_type: z.enum(['user', 'client_device', 'site']).default('user'),
      period: PERIOD.default('monthly'),
      period_start: DATE.optional(),
      limit: z.coerce.number().int().min(1).max(100).default(10),
    }),
    responses: { 200: { description: 'UsageTop', schema: TopSchema }, ...problemResponses },
    handler: async ({ params, query, ctx }) => {
      const at = now();
      let sites: 'all' | string[] = 'all';
      if (query.subject_type === 'site')
        sites = permittedSites(ctx.principal, 'accounting:read', params.orgId);
      else requireOrgLevel(ctx, 'accounting:read', params.orgId);
      const result =
        sites !== 'all' && sites.length === 0
          ? { rows: [] as TopRow[], periodStart: null as string | null, basis: 'no permitted site' }
          : await inTenant(deps, params.orgId, (trx) =>
              topRows(trx, params.orgId, query, sites, at),
            );
      const rows = result.rows;
      return {
        status: 200,
        body: {
          subject_type: query.subject_type,
          period: query.period,
          period_start: result.periodStart,
          label_basis: result.basis,
          data: rows.map((r, i) => ({
            rank: i + 1,
            subject_id: r.subject_id,
            label: r.label,
            period_start: r.period_start,
            ...counters(r),
            last_accounting_at: r.updated_at.toISOString(),
          })),
          ...freshnessOf(
            at,
            maxDate(rows.map((r) => r.updated_at)),
            deps.config.aaaInterimIntervalS,
          ),
        },
      };
    },
  });

  const exportUsage = defineRoute({
    method: 'post',
    path: '/api/v1/orgs/:orgId/usage/export',
    summary: 'Export usage counters as CSV (report:export; refused while impersonating)',
    tags: TAG,
    auth: 'principal',
    permission: 'report:export',
    scope: 'any-site',
    params: OrgParams,
    body: z.object({
      subject_type: z.enum(['user', 'client_device', 'site']),
      period: PERIOD.default('daily'),
      from: DATE.optional(),
      to: DATE.optional(),
    }),
    responses: {
      200: { description: 'text/csv usage rows', schema: z.string(), contentType: 'text/csv' },
      422: { description: `More than ${String(USAGE_EXPORT_MAX_ROWS)} rows: narrow the range` },
      429: { description: 'Export rate limit (10 per hour per principal)' },
      ...problemResponses,
    },
    handler: async ({ params, body, ctx }) => {
      refuseWhileImpersonating(ctx, 'report:export');
      const at = now();
      let sites: 'all' | string[] = 'all';
      if (body.subject_type === 'site')
        sites = permittedSites(ctx.principal, 'report:export', params.orgId);
      else requireOrgLevel(ctx, 'report:export', params.orgId);
      const range = seriesRange(body.period, at, 'UTC', body.from, body.to);
      const rows = await inTenant(deps, params.orgId, async (trx) => {
        if (sites !== 'all' && sites.length === 0) {
          await consumeExportBudget(deps, ctx);
          await writeAudit(trx, ctx, {
            organizationId: params.orgId,
            action: 'report:export',
            targetType: 'usage',
            after: { format: 'csv', subject_type: body.subject_type, period: body.period, rows: 0 },
          });
          return [];
        }
        let q = trx
          .selectFrom('usage_counters')
          .select([
            'subject_id',
            'period_start',
            'bytes_in',
            'bytes_out',
            'session_count',
            'session_time_s',
            'updated_at',
          ])
          .where('organization_id', '=', params.orgId)
          .where('subject_type', '=', body.subject_type)
          .where('period_type', '=', body.period)
          .where('period_start', '>=', range.from)
          .where('period_start', '<=', range.to);
        if (sites !== 'all') q = q.where('subject_id', 'in', sites);
        const found = await q
          .orderBy('period_start')
          .orderBy('subject_id')
          .limit(USAGE_EXPORT_MAX_ROWS + 1)
          .execute();
        if (found.length > USAGE_EXPORT_MAX_ROWS) {
          throw new UnprocessableError(
            `The export would exceed ${String(USAGE_EXPORT_MAX_ROWS)} rows; narrow the period range.`,
          );
        }
        // Every refusal above is free; only an export that will be produced uses the budget.
        await consumeExportBudget(deps, ctx);
        const labels = await labelsOf(trx, body.subject_type, [
          ...new Set(found.map((r) => r.subject_id)),
        ]);
        await writeAudit(trx, ctx, {
          organizationId: params.orgId,
          action: 'report:export',
          targetType: 'usage',
          after: {
            format: 'csv',
            subject_type: body.subject_type,
            period: body.period,
            from: range.from,
            to: range.to,
            rows: found.length,
          },
        });
        return found.map((r) => ({ ...r, label: labels.get(r.subject_id) ?? null }));
      });
      const csv = toCsv(
        [
          'subject_type',
          'subject_id',
          'label',
          'period',
          'period_start',
          'bytes_in',
          'bytes_out',
          'bytes_total',
          'session_count',
          'session_time_s',
          'updated_at',
        ],
        rows.map((r) => {
          const c = counters(r);
          return [
            body.subject_type,
            r.subject_id,
            r.label,
            body.period,
            r.period_start,
            c.bytes_in,
            c.bytes_out,
            c.bytes_total,
            c.session_count,
            c.session_time_s,
            r.updated_at,
          ];
        }),
      );
      return {
        status: 200,
        body: csv,
        contentType: 'text/csv; charset=utf-8',
        headers: {
          'Content-Disposition': `attachment; filename="usage-${body.subject_type}-${body.period}-${range.from}-${range.to}.csv"`,
          'Cache-Control': 'no-store',
        },
      };
    },
  });

  return [usage, top, exportUsage];
}

async function labelsOf(
  trx: DbTransaction,
  type: 'user' | 'client_device' | 'site',
  ids: readonly string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (ids.length === 0) return out;
  if (type === 'user') {
    const rows = await trx
      .selectFrom('users')
      .select(['id', 'username'])
      .where('id', 'in', [...ids])
      .execute();
    for (const r of rows) out.set(r.id, r.username);
  } else if (type === 'client_device') {
    const rows = await trx
      .selectFrom('client_devices')
      .select(['id', 'mac'])
      .where('id', 'in', [...ids])
      .execute();
    for (const r of rows) out.set(r.id, r.mac);
  } else {
    const rows = await trx
      .selectFrom('sites')
      .select(['id', 'name'])
      .where('id', 'in', [...ids])
      .execute();
    for (const r of rows) out.set(r.id, r.name);
  }
  return out;
}

interface TopRow {
  subject_id: string;
  period_start: string;
  bytes_in: number;
  bytes_out: number;
  session_count: number;
  session_time_s: number;
  updated_at: Date;
  label: string | null;
}

interface TopQuery {
  subject_type: 'user' | 'client_device' | 'site';
  period: PeriodType;
  period_start?: string | undefined;
  limit: number;
}

/**
 * Top-N with site-local period labels (Q65). An explicit `period_start` is matched as a label.
 * Without one: `total` needs none; `site` rows use each site's own current local day/month;
 * user / device rows (bucketed in the TZ of the session's site) use the organization's single
 * site timezone, and a `period_start` is required when the sites span several timezones.
 */
async function topRows(
  trx: DbTransaction,
  orgId: string,
  query: TopQuery,
  sites: 'all' | string[],
  at: Date,
): Promise<{ rows: TopRow[]; periodStart: string | null; basis: string }> {
  let q = trx
    .selectFrom('usage_counters')
    .select([
      'subject_id',
      'period_start',
      'bytes_in',
      'bytes_out',
      'session_count',
      'session_time_s',
      'updated_at',
    ])
    .where('organization_id', '=', orgId)
    .where('subject_type', '=', query.subject_type)
    .where('period_type', '=', query.period);
  if (sites !== 'all') q = q.where('subject_id', 'in', sites);
  let periodStart: string | null;
  let basis: string;
  if (query.period === 'total' || query.period_start !== undefined) {
    periodStart =
      query.period === 'total'
        ? currentPeriodStart('total', at, 'UTC')
        : bucketStart(query.period, query.period_start as string);
    q = q.where('period_start', '=', periodStart);
    basis =
      query.period === 'total'
        ? 'total since the first accounting'
        : 'period_start is matched as a site-local date label (Q65)';
  } else {
    let siteQ = trx.selectFrom('sites').select(['id', 'timezone']).where('deleted_at', 'is', null);
    if (sites !== 'all') siteQ = siteQ.where('id', 'in', sites);
    const siteRows = await siteQ.execute();
    if (query.subject_type === 'site') {
      if (siteRows.length === 0) return { rows: [], periodStart: null, basis: 'no site' };
      const pairs = siteRows.map((st) => ({
        id: st.id,
        start: currentPeriodStart(query.period, at, st.timezone),
      }));
      q = q.where((eb) =>
        eb.or(
          pairs.map((p) => eb.and([eb('subject_id', '=', p.id), eb('period_start', '=', p.start)])),
        ),
      );
      const labels = [...new Set(pairs.map((p) => p.start))];
      periodStart = labels.length === 1 ? (labels[0] as string) : null;
      basis = "each site's current period in its own timezone (Q65)";
    } else {
      const zones = [...new Set(siteRows.map((st) => st.timezone))];
      if (zones.length > 1) {
        throw new ValidationError([
          {
            path: 'query.period_start',
            message: `period_start is required: the organization's sites span several timezones (${zones.join(', ')}), so there is no single current ${query.period === 'daily' ? 'day' : 'month'}`,
          },
        ]);
      }
      const tz = zones[0] ?? 'UTC';
      periodStart = currentPeriodStart(query.period, at, tz);
      q = q.where('period_start', '=', periodStart);
      basis = `current period in ${tz}, the timezone of every site (Q65)`;
    }
  }
  const found = await q
    .orderBy(sql`bytes_in + bytes_out`, 'desc')
    .orderBy('subject_id')
    .limit(query.limit)
    .execute();
  const labels = await labelsOf(
    trx,
    query.subject_type,
    found.map((r) => r.subject_id),
  );
  return {
    rows: found.map((r) => ({ ...r, label: labels.get(r.subject_id) ?? null })),
    periodStart,
    basis,
  };
}
