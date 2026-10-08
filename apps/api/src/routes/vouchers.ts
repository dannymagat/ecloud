/**
 * Voucher batches (DATABASE_DESIGN.md §3.6, SECURITY_ARCHITECTURE.md §5.5): codes from a
 * 32-symbol alphabet, stored as HMAC-SHA-256 with the server pepper (`code_hash`), last three
 * characters as `code_hint`, plaintext returned ONCE in the create response (hash-only default
 * of A6 Q4: `code_enc` stays NULL, so there is no re-print).
 */
import { NotFoundError, newId } from '@ecloud/shared';
import { z } from 'zod';
import { writeAudit } from '../audit.js';
import { permittedSites } from '../auth/authorize.js';
import { EXPORT_LIMIT, hitLimitFailOpen } from '../auth/rate-limit.js';
import type { AppDeps } from '../context.js';
import { hmacSha256Hex, normalizeVoucherCode, randomVoucherCode } from '../crypto.js';
import {
  OrgIdParams,
  OrgParams,
  PageSchema,
  PaginationQuery,
  ResourceSchema,
  decodeCursor,
  problemResponses,
  toPage,
} from '../http/common.js';
import { toCsv } from '../http/csv.js';
import { defineRoute, type AnyRouteSpec } from '../http/route.js';
import { assertRef, inTenant, requireOnSite } from '../tenant.js';

/** Synchronous generation cap (API_ARCHITECTURE.md allows ≤ 5000 with async > 500; async is Phase 4+). */
export const MAX_SYNC_VOUCHERS = 1000;

const instant = z.iso.datetime({ offset: true });

const BatchCreate = z
  .strictObject({
    name: z.string().trim().min(1).max(200),
    site_id: z.uuid().nullable().optional(),
    policy_id: z.uuid().nullable().optional(),
    count: z.number().int().min(1).max(MAX_SYNC_VOUCHERS),
    code_length: z.number().int().min(8).max(16).default(10),
    valid_from: instant.nullable().optional(),
    valid_until: instant.nullable().optional(),
    duration_s: z.number().int().positive().nullable().optional(),
    /**
     * D-037: count limit (number of logins). Default: none when `duration_s` is set (re-login
     * until the voucher expires), 1 otherwise. With both set, both limits apply.
     */
    max_uses: z.number().int().positive().max(1000).nullable().optional(),
    max_devices: z.number().int().positive().max(100).optional(),
  })
  .refine(
    (b) => !b.valid_from || !b.valid_until || new Date(b.valid_until) > new Date(b.valid_from),
    { message: 'valid_until must be after valid_from', path: ['valid_until'] },
  )
  .refine((b) => !(b.max_uses === null && (b.duration_s ?? null) === null), {
    message: 'a voucher needs duration_s or max_uses (or both)',
    path: ['max_uses'],
  });

/** D-037 default: count limit 1 unless the voucher is time-limited. */
export function effectiveMaxUses(
  durationS: number | null | undefined,
  maxUses: number | null | undefined,
): number | null {
  if (maxUses !== undefined) return maxUses;
  return durationS === null || durationS === undefined ? 1 : null;
}

export function voucherHash(pepper: string, code: string): string {
  return hmacSha256Hex(pepper, normalizeVoucherCode(code));
}

export function voucherRoutes(deps: AppDeps): AnyRouteSpec[] {
  const pepper = deps.config.voucherPepper;
  const now = deps.now ?? (() => new Date());

  const list = defineRoute({
    method: 'get',
    path: '/api/v1/orgs/:orgId/voucher-batches',
    summary: 'List voucher batches',
    tags: ['vouchers'],
    auth: 'principal',
    permission: 'voucher:read',
    scope: 'any-site',
    params: OrgParams,
    query: PaginationQuery,
    responses: { 200: { description: 'Batches', schema: PageSchema }, ...problemResponses },
    handler: async ({ params, query, ctx }) => {
      const sites = permittedSites(ctx.principal, 'voucher:read', params.orgId);
      const cursor = decodeCursor(query.cursor);
      const rows = await inTenant(deps, params.orgId, (trx) => {
        let q = trx.selectFrom('voucher_batches').selectAll();
        if (sites !== 'all') {
          if (sites.length === 0) return Promise.resolve([]);
          q = q.where('site_id', 'in', sites);
        }
        if (typeof cursor === 'string') q = q.where('id', '>', cursor);
        return q
          .orderBy('id')
          .limit(query.limit + 1)
          .execute();
      });
      return { status: 200, body: toPage(rows, query.limit, (r) => r.id) };
    },
  });

  const create = defineRoute({
    method: 'post',
    path: '/api/v1/orgs/:orgId/voucher-batches',
    summary: 'Generate a voucher batch (codes returned once)',
    tags: ['vouchers'],
    auth: 'principal',
    permission: 'voucher:create',
    scope: 'any-site',
    params: OrgParams,
    body: BatchCreate,
    idempotency: 'required',
    secretFields: ['codes'],
    responses: {
      201: {
        description: 'Batch with plaintext codes (only in this response)',
        schema: ResourceSchema,
      },
      ...problemResponses,
    },
    handler: async ({ params, body, ctx }) => {
      const result = await inTenant(deps, params.orgId, async (trx) => {
        const siteId = body.site_id ?? null;
        if (siteId !== null) await assertRef(trx, 'sites', siteId, 'site');
        if (body.policy_id) await assertRef(trx, 'policies', body.policy_id, 'policy');
        requireOnSite(ctx, 'voucher:create', params.orgId, siteId, 'voucher_batch');
        const batchId = newId();
        const batch = await trx
          .insertInto('voucher_batches')
          .values({
            id: batchId,
            organization_id: params.orgId,
            site_id: siteId,
            name: body.name,
            policy_id: body.policy_id ?? null,
            count: body.count,
            code_format: `base32-${String(body.code_length)}`,
            valid_from: body.valid_from ?? null,
            valid_until: body.valid_until ?? null,
            duration_s: body.duration_s ?? null,
            max_uses: effectiveMaxUses(body.duration_s, body.max_uses),
            max_devices: body.max_devices ?? 1,
            created_by:
              ctx.principal?.kind === 'admin' && ctx.principal.impersonation === null
                ? ctx.principal.administratorId
                : null,
          })
          .returningAll()
          .executeTakeFirstOrThrow();

        const codes: string[] = [];
        for (let attempt = 0; codes.length < body.count && attempt < 5; attempt += 1) {
          const wanted = body.count - codes.length;
          const fresh = new Map<string, string>();
          while (fresh.size < wanted) {
            const code = randomVoucherCode(body.code_length);
            fresh.set(voucherHash(pepper, code), code);
          }
          const inserted = await trx
            .insertInto('vouchers')
            .values(
              [...fresh.entries()].map(([hash, code]) => ({
                id: newId(),
                organization_id: params.orgId,
                batch_id: batchId,
                code_hash: hash,
                code_hint: code.slice(-3),
              })),
            )
            .onConflict((oc) => oc.column('code_hash').doNothing())
            .returning('code_hash')
            .execute();
          for (const row of inserted) codes.push(fresh.get(row.code_hash) as string);
        }
        if (codes.length < body.count) throw new Error('voucher code generation did not converge');
        await writeAudit(trx, ctx, {
          organizationId: params.orgId,
          action: 'voucher:create',
          targetType: 'voucher_batch',
          targetId: batchId,
          after: { ...batch, generated: codes.length },
        });
        return { batch, codes };
      });
      return { status: 201, body: { ...result.batch, codes: result.codes } };
    },
  });

  const get = defineRoute({
    method: 'get',
    path: '/api/v1/orgs/:orgId/voucher-batches/:id',
    summary: 'Get a voucher batch with counts by status',
    tags: ['vouchers'],
    auth: 'principal',
    permission: 'voucher:read',
    scope: 'any-site',
    params: OrgIdParams,
    responses: { 200: { description: 'Batch', schema: ResourceSchema }, ...problemResponses },
    handler: async ({ params, ctx }) => {
      const result = await inTenant(deps, params.orgId, async (trx) => {
        const batch = await trx
          .selectFrom('voucher_batches')
          .selectAll()
          .where('id', '=', params.id)
          .executeTakeFirst();
        if (batch === undefined) throw new NotFoundError('voucher_batch', params.id);
        requireOnSite(ctx, 'voucher:read', params.orgId, batch.site_id, 'voucher_batch');
        const counts = await trx
          .selectFrom('vouchers')
          .select(['status', (eb) => eb.fn.countAll<number>().as('n')])
          .where('batch_id', '=', params.id)
          .where('deleted_at', 'is', null)
          .groupBy('status')
          .execute();
        return {
          ...batch,
          counts: Object.fromEntries(counts.map((c) => [c.status, Number(c.n)])),
        };
      });
      return { status: 200, body: result };
    },
  });

  const vouchers = defineRoute({
    method: 'get',
    path: '/api/v1/orgs/:orgId/voucher-batches/:id/vouchers',
    summary: 'List vouchers of a batch (code_hint only)',
    tags: ['vouchers'],
    auth: 'principal',
    permission: 'voucher:read',
    scope: 'any-site',
    params: OrgIdParams,
    query: PaginationQuery,
    responses: { 200: { description: 'Vouchers', schema: PageSchema }, ...problemResponses },
    handler: async ({ params, query, ctx }) => {
      const cursor = decodeCursor(query.cursor);
      const rows = await inTenant(deps, params.orgId, async (trx) => {
        const batch = await trx
          .selectFrom('voucher_batches')
          .select(['site_id'])
          .where('id', '=', params.id)
          .executeTakeFirst();
        if (batch === undefined) throw new NotFoundError('voucher_batch', params.id);
        requireOnSite(ctx, 'voucher:read', params.orgId, batch.site_id, 'voucher_batch');
        let q = trx
          .selectFrom('vouchers')
          .select([
            'id',
            'batch_id',
            'code_hint',
            'status',
            'activated_at',
            'expires_at',
            'use_count',
            'bound_user_id',
            'created_at',
            'updated_at',
          ])
          .where('batch_id', '=', params.id)
          .where('deleted_at', 'is', null);
        if (typeof cursor === 'string') q = q.where('id', '>', cursor);
        return q
          .orderBy('id')
          .limit(query.limit + 1)
          .execute();
      });
      return { status: 200, body: toPage(rows, query.limit, (r) => r.id) };
    },
  });

  const revoke = defineRoute({
    method: 'post',
    path: '/api/v1/orgs/:orgId/vouchers/:id/revoke',
    summary: 'Revoke a voucher',
    tags: ['vouchers'],
    auth: 'principal',
    permission: 'voucher:revoke',
    scope: 'any-site',
    params: OrgIdParams,
    idempotency: 'optional',
    responses: { 200: { description: 'Revoked', schema: ResourceSchema }, ...problemResponses },
    handler: async ({ params, ctx }) => {
      const row = await inTenant(deps, params.orgId, async (trx) => {
        const before = await trx
          .selectFrom('vouchers as v')
          .innerJoin('voucher_batches as b', 'b.id', 'v.batch_id')
          .select(['v.id', 'v.status', 'b.site_id'])
          .where('v.id', '=', params.id)
          .where('v.deleted_at', 'is', null)
          .executeTakeFirst();
        if (before === undefined) throw new NotFoundError('voucher', params.id);
        requireOnSite(
          ctx,
          'voucher:revoke',
          params.orgId,
          before.site_id,
          'voucher',
          'voucher:read',
        );
        const after = await trx
          .updateTable('vouchers')
          .set({
            status: 'revoked',
            revoked_by:
              ctx.principal?.kind === 'admin' && ctx.principal.impersonation === null
                ? ctx.principal.administratorId
                : null,
            updated_at: now(),
          })
          .where('id', '=', params.id)
          .returning(['id', 'batch_id', 'status', 'code_hint', 'updated_at'])
          .executeTakeFirstOrThrow();
        await writeAudit(trx, ctx, {
          organizationId: params.orgId,
          action: 'voucher:revoke',
          targetType: 'voucher',
          targetId: params.id,
          before: { status: before.status },
          after: { status: 'revoked' },
        });
        return after;
      });
      return { status: 200, body: row };
    },
  });

  const exportBatch = defineRoute({
    method: 'post',
    path: '/api/v1/orgs/:orgId/voucher-batches/:id/export',
    summary: 'Export a voucher batch as CSV (metadata only: codes are never stored in clear)',
    tags: ['vouchers'],
    auth: 'principal',
    permission: 'voucher:export',
    scope: 'any-site',
    params: OrgIdParams,
    responses: {
      200: {
        description:
          'text/csv: voucher_id, code_hint, status, use_count, activated_at, expires_at, ' +
          'batch limits. Plaintext codes exist only in the batch creation response ' +
          '(DATABASE_DESIGN Q4 hash-only default: code_enc is NULL).',
        schema: z.string(),
        contentType: 'text/csv',
      },
      429: { description: 'Export rate limit (10 per hour per principal)' },
      ...problemResponses,
    },
    handler: async ({ params, ctx }) => {
      const principalId =
        ctx.principal?.kind === 'admin'
          ? ctx.principal.administratorId
          : ctx.principal?.kind === 'api_key'
            ? ctx.principal.apiKeyId
            : 'anonymous';
      await hitLimitFailOpen(
        deps,
        `export:${principalId}`,
        EXPORT_LIMIT.perHour,
        EXPORT_LIMIT.windowSeconds,
      );
      const { batch, rows } = await inTenant(deps, params.orgId, async (trx) => {
        const b = await trx
          .selectFrom('voucher_batches')
          .selectAll()
          .where('id', '=', params.id)
          .executeTakeFirst();
        if (b === undefined) throw new NotFoundError('voucher_batch', params.id);
        requireOnSite(
          ctx,
          'voucher:export',
          params.orgId,
          b.site_id,
          'voucher_batch',
          'voucher:read',
        );
        const vs = await trx
          .selectFrom('vouchers')
          .select(['id', 'code_hint', 'status', 'use_count', 'activated_at', 'expires_at'])
          .where('batch_id', '=', params.id)
          .where('deleted_at', 'is', null)
          .orderBy('id')
          .execute();
        await writeAudit(trx, ctx, {
          organizationId: params.orgId,
          action: 'voucher:export',
          targetType: 'voucher_batch',
          targetId: params.id,
          after: { format: 'csv', rows: vs.length, includes_codes: false },
        });
        return { batch: b, rows: vs };
      });
      const csv = toCsv(
        [
          'voucher_id',
          'batch_id',
          'batch_name',
          'code_hint',
          'status',
          'use_count',
          'max_uses',
          'duration_s',
          'activated_at',
          'expires_at',
          'valid_from',
          'valid_until',
        ],
        rows.map((v) => [
          v.id,
          batch.id,
          batch.name,
          v.code_hint,
          v.status,
          v.use_count,
          batch.max_uses,
          batch.duration_s,
          v.activated_at,
          v.expires_at,
          batch.valid_from,
          batch.valid_until,
        ]),
      );
      return {
        status: 200,
        body: csv,
        contentType: 'text/csv; charset=utf-8',
        headers: {
          'Content-Disposition': `attachment; filename="voucher-batch-${batch.id}.csv"`,
          'Cache-Control': 'no-store',
        },
      };
    },
  });

  return [list, create, get, vouchers, revoke, exportBatch];
}
