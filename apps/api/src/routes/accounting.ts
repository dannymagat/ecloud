/**
 * Normalised accounting records (Phase 8 P8-A; API_ARCHITECTURE.md "P8-A" items 7, 8): a paged,
 * time-bounded query (≤ 31 days, so the planner prunes to at most two monthly partitions) and a
 * streamed CSV export (`accounting:export`; Read Only lacks it per Q75; refused while
 * impersonating per the D-027 default; audited before the first byte).
 *
 * `accounting_records` has no site column: site scoping goes through the record's session. A
 * record without a resolved session is visible to organization-level grants only.
 */
import { ValidationError } from '@ecloud/shared';
import type { DbTransaction } from '@ecloud/db';
import { sql } from 'kysely';
import { z } from 'zod';
import { decodeTimeCursor, encodeTimeCursor } from '../accounting-views.js';
import { writeAudit } from '../audit.js';
import { permittedSites } from '../auth/authorize.js';
import type { AppDeps, RequestContext } from '../context.js';
import { consumeExportBudget, refuseWhileImpersonating } from '../export-guard.js';
import { OrgParams, problemResponses } from '../http/common.js';
import { toCsv } from '../http/csv.js';
import { UnprocessableError } from '../http/errors.js';
import { defineRoute, type AnyRouteSpec } from '../http/route.js';
import { inTenant } from '../tenant.js';
import { tsText } from './sessions.js';

const TAG = ['accounting'];
export const MAX_RANGE_MS = 31 * 86_400_000;
export const EXPORT_MAX_ROWS = 100_000;
export const EXPORT_BATCH = 1000;

const Filters = z.object({
  from: z.iso.datetime({ offset: true }),
  to: z.iso.datetime({ offset: true }),
  session_id: z.uuid().optional(),
  site_id: z.uuid().optional(),
  username: z.string().min(1).max(253).optional(),
  acct_session_id: z.string().min(1).max(253).optional(),
  status_type: z.enum(['start', 'interim', 'stop', 'accounting_on', 'accounting_off']).optional(),
  nas_ip: z.union([z.ipv4(), z.ipv6()]).optional(),
  calling_station_id: z.string().min(1).max(64).optional(),
});
type FilterInput = z.output<typeof Filters>;

const RECORD_COLUMNS = [
  'a.id',
  'a.received_at',
  'a.event_time',
  'a.status_type',
  'a.acct_session_id',
  'a.acct_unique_id',
  'a.nas_ip',
  'a.nas_identifier',
  'a.username',
  'a.calling_station_id',
  'a.called_station_id',
  'a.framed_ip',
  'a.input_octets',
  'a.output_octets',
  'a.session_time_s',
  'a.terminate_cause',
  'a.session_id',
  'a.raw',
] as const;

/** Validated `[from, to)` window: required, ordered, at most 31 days. */
export function timeWindow(from: string, to: string): { from: Date; to: Date } {
  const f = new Date(from);
  const t = new Date(to);
  if (t.getTime() <= f.getTime()) {
    throw new ValidationError([{ path: 'query.to', message: 'to must be after from' }]);
  }
  if (t.getTime() - f.getTime() > MAX_RANGE_MS) {
    throw new ValidationError([
      {
        path: 'query.to',
        message: 'the time range may span at most 31 days (partition-friendly bound)',
      },
    ]);
  }
  return { from: f, to: t };
}

function filtered(
  trx: DbTransaction,
  f: FilterInput,
  window: { from: Date; to: Date },
  sites: 'all' | string[],
) {
  let q = trx
    .selectFrom('accounting_records as a')
    .where('a.received_at', '>=', window.from)
    .where('a.received_at', '<', window.to);
  // Site scoping via the session (records have no site column).
  if (sites !== 'all' || f.site_id !== undefined) {
    q = q.where((eb) => {
      let sub = eb.selectFrom('sessions as s').select('s.id').whereRef('s.id', '=', 'a.session_id');
      if (sites !== 'all') sub = sub.where('s.site_id', 'in', sites);
      if (f.site_id !== undefined) sub = sub.where('s.site_id', '=', f.site_id);
      return eb.exists(sub);
    });
  }
  if (f.session_id) q = q.where('a.session_id', '=', f.session_id);
  if (f.username) q = q.where('a.username', '=', f.username);
  if (f.acct_session_id) q = q.where('a.acct_session_id', '=', f.acct_session_id);
  if (f.status_type) q = q.where('a.status_type', '=', f.status_type);
  if (f.nas_ip) q = q.where('a.nas_ip', '=', f.nas_ip);
  if (f.calling_station_id) q = q.where('a.calling_station_id', '=', f.calling_station_id);
  return q;
}

function recordView(r: Record<string, unknown>): Record<string, unknown> {
  const { cursor_ts: _c, ...rest } = r;
  return rest;
}

const CSV_HEADER = [
  'id',
  'received_at',
  'event_time',
  'status_type',
  'session_id',
  'acct_session_id',
  'acct_unique_id',
  'nas_ip',
  'nas_identifier',
  'username',
  'calling_station_id',
  'called_station_id',
  'framed_ip',
  'input_octets',
  'output_octets',
  'session_time_s',
  'terminate_cause',
] as const;

export function accountingRoutes(deps: AppDeps): AnyRouteSpec[] {
  const now = () => (deps.now ?? (() => new Date()))();

  const records = defineRoute({
    method: 'get',
    path: '/api/v1/orgs/:orgId/accounting/records',
    summary: 'Normalised accounting records in a required time window (≤ 31 days, newest first)',
    tags: TAG,
    auth: 'principal',
    permission: 'accounting:read',
    scope: 'any-site',
    params: OrgParams,
    query: Filters.extend({
      limit: z.coerce.number().int().min(1).max(200).default(50),
      cursor: z.string().max(300).optional(),
    }),
    responses: {
      200: {
        description: 'AccountingRecord page',
        schema: z
          .object({
            data: z.array(z.looseObject({ id: z.number(), received_at: z.string() })),
            next_cursor: z.string().nullable(),
            measured_at: z.string(),
          })
          .meta({ id: 'AccountingRecordPage' }),
      },
      ...problemResponses,
    },
    handler: async ({ params, query, ctx }) => {
      const at = now();
      const window = timeWindow(query.from, query.to);
      const sites = permittedSites(ctx.principal, 'accounting:read', params.orgId);
      const cursor = decodeTimeCursor(query.cursor);
      if (cursor !== null && !/^\d+$/.test(cursor.id)) {
        throw new ValidationError([{ path: 'query.cursor', message: 'invalid cursor' }]);
      }
      const rows =
        sites !== 'all' && sites.length === 0
          ? []
          : await inTenant(deps, params.orgId, (trx) => {
              let q = filtered(trx, query, window, sites)
                .select(RECORD_COLUMNS)
                .select(tsText('a.received_at').as('cursor_ts'));
              if (cursor !== null) {
                q = q.where(
                  sql<boolean>`(a.received_at, a.id) < (${cursor.at}::timestamptz, ${cursor.id}::bigint)`,
                );
              }
              return q
                .orderBy('a.received_at', 'desc')
                .orderBy('a.id', 'desc')
                .limit(query.limit + 1)
                .execute();
            });
      const hasMore = rows.length > query.limit;
      const page = hasMore ? rows.slice(0, query.limit) : rows;
      const last = page[page.length - 1];
      return {
        status: 200,
        body: {
          data: page.map((r) => recordView(r)),
          next_cursor:
            hasMore && last !== undefined ? encodeTimeCursor(last.cursor_ts, last.id) : null,
          measured_at: at.toISOString(),
        },
      };
    },
  });

  const exportRecords = defineRoute({
    method: 'post',
    path: '/api/v1/orgs/:orgId/accounting/export',
    summary: 'Stream accounting records as CSV (accounting:export; refused while impersonating)',
    tags: TAG,
    auth: 'principal',
    permission: 'accounting:export',
    scope: 'any-site',
    params: OrgParams,
    body: Filters,
    responses: {
      200: {
        description: `text/csv (streamed, ascending received_at): ${CSV_HEADER.join(', ')}`,
        schema: z.string(),
        contentType: 'text/csv',
      },
      422: { description: `More than ${String(EXPORT_MAX_ROWS)} rows: narrow the range` },
      429: { description: 'Export rate limit (10 per hour per principal)' },
      ...problemResponses,
    },
    handler: async ({ params, body, ctx }) => {
      refuseWhileImpersonating(ctx, 'accounting:export');
      const window = timeWindow(body.from, body.to);
      const sites = permittedSites(ctx.principal, 'accounting:export', params.orgId);
      const count =
        sites !== 'all' && sites.length === 0
          ? 0
          : await inTenant(deps, params.orgId, async (trx) => {
              const r = await trx
                .selectFrom(
                  filtered(trx, body, window, sites)
                    .select('a.id')
                    .limit(EXPORT_MAX_ROWS + 1)
                    .as('x'),
                )
                .select((eb) => eb.fn.countAll<number>().as('n'))
                .executeTakeFirstOrThrow();
              return Number(r.n);
            });
      if (count > EXPORT_MAX_ROWS) {
        throw new UnprocessableError(
          `The export would exceed ${String(EXPORT_MAX_ROWS)} rows; narrow the time range or add filters.`,
        );
      }
      // Scope, window and row cap passed: only now does the attempt use the export budget.
      await consumeExportBudget(deps, ctx);
      await inTenant(deps, params.orgId, (trx) =>
        writeAudit(trx, ctx, {
          organizationId: params.orgId,
          action: 'accounting:export',
          targetType: 'accounting_records',
          after: { format: 'csv', rows_at_start: count, filters: body },
        }),
      );
      const progress: ExportProgress = { rows: 0, finished: false };
      const stamp = window.from.toISOString().slice(0, 10);
      return {
        status: 200,
        contentType: 'text/csv; charset=utf-8',
        headers: {
          'Content-Disposition': `attachment; filename="accounting-${stamp}.csv"`,
          'Cache-Control': 'no-store',
        },
        stream: withCompletionAudit(
          streamCsv(deps, params.orgId, body, window, sites, progress),
          progress,
          () =>
            inTenant(deps, params.orgId, (trx) =>
              writeAudit(trx, ctx, {
                organizationId: params.orgId,
                action: 'accounting:export_completed',
                targetType: 'accounting_records',
                after: {
                  format: 'csv',
                  rows_at_start: count,
                  rows_emitted: progress.rows,
                  outcome: progress.finished ? 'finished' : 'aborted',
                },
              }),
            ),
          deps,
          ctx,
        ),
      };
    },
  });

  return [records, exportRecords];
}

interface ExportProgress {
  rows: number;
  finished: boolean;
}

/**
 * Wraps the CSV stream so a second audit row records how it ended: `finished` when every batch
 * was produced, `aborted` when the client went away or a batch failed (the pre-stream audit only
 * knows `rows_at_start`). Runs in `finally`, i.e. also on `return()` from a destroyed pipeline.
 */
async function* withCompletionAudit(
  inner: AsyncGenerator<string>,
  progress: ExportProgress,
  record: () => Promise<void>,
  deps: AppDeps,
  ctx: RequestContext,
): AsyncGenerator<string> {
  try {
    yield* inner;
    progress.finished = true;
  } finally {
    await record().catch((err: unknown) => {
      deps.logger.error({ err, requestId: ctx.requestId }, 'export completion audit failed');
    });
  }
}

/**
 * Keyset batches in separate short tenant transactions (no long-lived cursor or transaction
 * holding a pool connection while a slow client downloads).
 */
async function* streamCsv(
  deps: AppDeps,
  orgId: string,
  f: FilterInput,
  window: { from: Date; to: Date },
  sites: 'all' | string[],
  progress: ExportProgress,
): AsyncGenerator<string> {
  yield toCsv(CSV_HEADER, []);
  if (sites !== 'all' && sites.length === 0) return;
  let after: { at: string; id: number } | null = null;
  let emitted = 0;
  for (;;) {
    const cursor = after;
    const batch = await inTenant(deps, orgId, (trx) => {
      let q = filtered(trx, f, window, sites)
        .select(RECORD_COLUMNS)
        .select(tsText('a.received_at').as('cursor_ts'));
      if (cursor !== null) {
        q = q.where(
          sql<boolean>`(a.received_at, a.id) > (${cursor.at}::timestamptz, ${cursor.id}::bigint)`,
        );
      }
      return q.orderBy('a.received_at').orderBy('a.id').limit(EXPORT_BATCH).execute();
    });
    if (batch.length === 0) return;
    const rows = batch.slice(0, Math.max(0, EXPORT_MAX_ROWS - emitted));
    // toCsv emits a header line; strip it for data batches.
    const text = toCsv(
      CSV_HEADER,
      rows.map((r) => CSV_HEADER.map((k) => (r as Record<string, unknown>)[k])),
    );
    yield text.slice(text.indexOf('\r\n') + 2);
    emitted += rows.length;
    progress.rows = emitted;
    const last = batch[batch.length - 1];
    if (batch.length < EXPORT_BATCH || last === undefined || emitted >= EXPORT_MAX_ROWS) return;
    after = { at: last.cursor_ts, id: last.id };
  }
}
