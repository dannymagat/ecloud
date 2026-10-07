/**
 * Policies (intent only, POLICY_ENGINE.md §1), policy assignments and the simulate / dry-run
 * endpoint (§6.4). Validation uses `validatePolicy` (the eleven rules of §1.3); a change of an
 * enforcement field bumps `version` (rule 11).
 */
import { listCapabilities, getAdapter } from '@ecloud/adapters';
import {
  ADAPTER_KEYS,
  enforcementFieldsDiffer,
  simulate,
  toJsonValue,
  validatePolicy,
  type Subject,
} from '@ecloud/policy-engine';
import { NotFoundError, ValidationError, newId } from '@ecloud/shared';
import { z } from 'zod';
import { writeAudit } from '../audit.js';
import { permittedSites } from '../auth/authorize.js';
import type { AppDeps } from '../context.js';
import {
  OrgIdParams,
  OrgParams,
  PageSchema,
  PaginationQuery,
  ResourceSchema,
  checkIfMatch,
  decodeCursor,
  etagOf,
  problemResponses,
  toPage,
} from '../http/common.js';
import { defineRoute, type AnyRouteSpec } from '../http/route.js';
import { intentsFor, loadResolutionInput, policyRowToIntent } from '../policy-data.js';
import { assertRef, inTenant, requireOnSite } from '../tenant.js';
import { loose, type Row } from './crud.js';

const positiveInt = z.number().int().positive();
const bytes = z.union([z.number().int().positive(), z.string().regex(/^[1-9][0-9]*$/)]);
const instant = z.iso.datetime({ offset: true });

const intentFields = {
  description: z.string().max(2000).optional(),
  site_id: z.uuid().nullable().optional(),
  status: z.enum(['draft', 'active', 'retired']).optional(),
  priority: z.number().int().min(0).max(10_000).optional(),
  is_default: z.boolean().optional(),
  download_rate_kbps: positiveInt.nullable().optional(),
  upload_rate_kbps: positiveInt.nullable().optional(),
  burst_download_kbps: positiveInt.nullable().optional(),
  burst_upload_kbps: positiveInt.nullable().optional(),
  burst_duration_s: positiveInt.nullable().optional(),
  quota_daily_bytes: bytes.nullable().optional(),
  quota_monthly_bytes: bytes.nullable().optional(),
  quota_total_bytes: bytes.nullable().optional(),
  session_timeout_s: positiveInt.nullable().optional(),
  idle_timeout_s: positiveInt.nullable().optional(),
  max_concurrent_sessions: positiveInt.nullable().optional(),
  max_devices: positiveInt.nullable().optional(),
  valid_from: instant.nullable().optional(),
  valid_until: instant.nullable().optional(),
  vlan_id: z.number().int().min(1).max(4094).nullable().optional(),
  schedule_id: z.uuid().nullable().optional(),
};

const PolicyCreate = z.strictObject({
  name: z.string().trim().min(1).max(200),
  scope_type: z.enum(['user', 'group', 'site', 'temporary']),
  ...intentFields,
});
const PolicyUpdate = z.strictObject({
  name: z.string().trim().min(1).max(200).optional(),
  scope_type: z.enum(['user', 'group', 'site', 'temporary']).optional(),
  ...intentFields,
});

const COLUMNS = [
  'name',
  'description',
  'scope_type',
  'site_id',
  'status',
  'priority',
  'is_default',
  'download_rate_kbps',
  'upload_rate_kbps',
  'burst_download_kbps',
  'burst_upload_kbps',
  'burst_duration_s',
  'quota_daily_bytes',
  'quota_monthly_bytes',
  'quota_total_bytes',
  'session_timeout_s',
  'idle_timeout_s',
  'max_concurrent_sessions',
  'max_devices',
  'valid_from',
  'valid_until',
  'vlan_id',
  'schedule_id',
] as const;

const TARGET_COLUMN = {
  user: 'user_id',
  user_group: 'user_group_id',
  site: 'site_id',
  client_device: 'client_device_id',
  voucher_batch: 'voucher_batch_id',
} as const;

const TARGET_TABLE = {
  user: 'users',
  user_group: 'user_groups',
  site: 'sites',
  client_device: 'client_devices',
  voucher_batch: 'voucher_batches',
} as const;

const AssignmentCreate = z.strictObject({
  policy_id: z.uuid(),
  target_type: z.enum(['user', 'user_group', 'site', 'client_device', 'voucher_batch']),
  target_id: z.uuid(),
  effective_from: instant.optional(),
  effective_until: instant.nullable().optional(),
  priority: z.number().int().min(0).max(10_000).optional(),
  note: z.string().max(500).nullable().optional(),
});

const SimulateQuery = z
  .object({
    user_id: z.uuid().optional(),
    client_device_id: z.uuid().optional(),
    site_id: z.uuid().optional(),
    mac: z.string().max(32).optional(),
    at: instant.optional(),
    adapter: z.enum(ADAPTER_KEYS).optional(),
  })
  .refine((q) => q.user_id !== undefined || q.client_device_id !== undefined, {
    message: 'user_id or client_device_id is required',
  });

function pick(body: Row): Row {
  const out: Row = {};
  for (const column of COLUMNS) if (body[column] !== undefined) out[column] = body[column];
  return out;
}

function validationFromIssues(
  issues: readonly { path: string; message: string; rule: number }[],
): ValidationError {
  return new ValidationError(
    issues.map((i) => ({
      path: `body.${i.path}`,
      message: `${i.message} (rule ${String(i.rule)})`,
    })),
  );
}

export function policyRoutes(deps: AppDeps): AnyRouteSpec[] {
  const now = deps.now ?? (() => new Date());

  const list = defineRoute({
    method: 'get',
    path: '/api/v1/orgs/:orgId/policies',
    summary: 'List policies',
    tags: ['policies'],
    auth: 'principal',
    permission: 'policy:read',
    scope: 'organization',
    params: OrgParams,
    query: PaginationQuery.extend({ status: z.enum(['draft', 'active', 'retired']).optional() }),
    responses: { 200: { description: 'Policies', schema: PageSchema }, ...problemResponses },
    handler: async ({ params, query }) => {
      const cursor = decodeCursor(query.cursor);
      const rows = await inTenant(deps, params.orgId, (trx) => {
        let q = trx.selectFrom('policies').selectAll().where('deleted_at', 'is', null);
        if (query.status) q = q.where('status', '=', query.status);
        if (typeof cursor === 'string') q = q.where('id', '>', cursor);
        return q
          .orderBy('id')
          .limit(query.limit + 1)
          .execute();
      });
      return { status: 200, body: toPage(rows, query.limit, (r) => r.id) };
    },
  });

  const get = defineRoute({
    method: 'get',
    path: '/api/v1/orgs/:orgId/policies/:id',
    summary: 'Get a policy',
    tags: ['policies'],
    auth: 'principal',
    permission: 'policy:read',
    scope: 'organization',
    params: OrgIdParams,
    responses: { 200: { description: 'Policy', schema: ResourceSchema }, ...problemResponses },
    handler: async ({ params }) => {
      const row = await inTenant(deps, params.orgId, (trx) =>
        trx
          .selectFrom('policies')
          .selectAll()
          .where('id', '=', params.id)
          .where('deleted_at', 'is', null)
          .executeTakeFirst(),
      );
      if (row === undefined) throw new NotFoundError('policy', params.id);
      return { status: 200, body: row, headers: { ETag: etagOf(row.updated_at) } };
    },
  });

  const create = defineRoute({
    method: 'post',
    path: '/api/v1/orgs/:orgId/policies',
    summary: 'Create a policy (validated against POLICY_ENGINE.md §1.3)',
    tags: ['policies'],
    auth: 'principal',
    permission: 'policy:create',
    scope: 'organization',
    params: OrgParams,
    body: PolicyCreate,
    idempotency: 'optional',
    responses: {
      201: { description: 'Created (with validation warnings)', schema: ResourceSchema },
      ...problemResponses,
    },
    handler: async ({ params, body, ctx }) => {
      const id = newId();
      const result = await inTenant(deps, params.orgId, async (trx) => {
        if (body.site_id) await assertRef(trx, 'sites', body.site_id, 'site');
        let schedule = null;
        if (body.schedule_id) {
          await assertRef(trx, 'schedules', body.schedule_id, 'schedule');
          schedule =
            (await trx
              .selectFrom('schedules')
              .select(['id', 'name', 'timezone', 'rules'])
              .where('id', '=', body.schedule_id)
              .executeTakeFirst()) ?? null;
        }
        const existingDefault = await trx
          .selectFrom('policies')
          .select('id')
          .where('is_default', '=', true)
          .where('deleted_at', 'is', null)
          .executeTakeFirst();
        const validation = validatePolicy(
          { ...body, id, organization_id: params.orgId, version: 1, schedule },
          { now: now(), existingDefaultPolicyId: existingDefault?.id ?? null },
        );
        if (!validation.ok) throw validationFromIssues(validation.errors);
        const row = await trx
          .insertInto('policies')
          .values({ ...pick(body), id, organization_id: params.orgId } as never)
          .returningAll()
          .executeTakeFirstOrThrow();
        await writeAudit(trx, ctx, {
          organizationId: params.orgId,
          action: 'policy:create',
          targetType: 'policy',
          targetId: id,
          after: row,
        });
        return { row, warnings: validation.warnings };
      });
      return {
        status: 201,
        body: { ...result.row, warnings: result.warnings },
        headers: { ETag: etagOf(result.row.updated_at) },
      };
    },
  });

  const update = defineRoute({
    method: 'patch',
    path: '/api/v1/orgs/:orgId/policies/:id',
    summary: 'Update a policy (If-Match; enforcement changes bump version)',
    tags: ['policies'],
    auth: 'principal',
    permission: 'policy:update',
    scope: 'organization',
    params: OrgIdParams,
    body: PolicyUpdate,
    responses: {
      200: { description: 'Updated', schema: ResourceSchema },
      412: { description: 'If-Match mismatch' },
      ...problemResponses,
    },
    handler: async ({ params, body, req, ctx }) => {
      const result = await inTenant(deps, params.orgId, async (trx) => {
        const before = await trx
          .selectFrom('policies')
          .selectAll()
          .where('id', '=', params.id)
          .where('deleted_at', 'is', null)
          .forUpdate()
          .executeTakeFirst();
        if (before === undefined) throw new NotFoundError('policy', params.id);
        checkIfMatch(req, before.updated_at);
        if (body.site_id) await assertRef(trx, 'sites', body.site_id, 'site');
        if (body.schedule_id) await assertRef(trx, 'schedules', body.schedule_id, 'schedule');
        const [previous] = await intentsFor(trx, [before]);
        const merged: Row = { ...(before as unknown as Row), ...pick(body) };
        const scheduleId = merged.schedule_id as string | null;
        const schedule =
          scheduleId === null
            ? null
            : ((await trx
                .selectFrom('schedules')
                .select(['id', 'name', 'timezone', 'rules'])
                .where('id', '=', scheduleId)
                .executeTakeFirst()) ?? null);
        const assignments = await trx
          .selectFrom('policy_assignments')
          .select(['id', 'effective_until'])
          .where('policy_id', '=', params.id)
          .execute();
        const existingDefault = await trx
          .selectFrom('policies')
          .select('id')
          .where('is_default', '=', true)
          .where('deleted_at', 'is', null)
          .where('id', '!=', params.id)
          .executeTakeFirst();
        // Rule 11: a change of an enforcement field must carry version + 1.
        const unbumped = policyRowToIntentSafe(merged, schedule);
        const bump =
          previous !== undefined &&
          typeof unbumped === 'object' &&
          unbumped !== null &&
          'download_rate_kbps' in unbumped &&
          enforcementFieldsDiffer(previous, unbumped as typeof previous);
        const candidate = bump
          ? policyRowToIntentSafe({ ...merged, version: before.version + 1 }, schedule)
          : unbumped;
        const validation = validatePolicy(candidate, {
          now: now(),
          previous: previous ?? null,
          assignments,
          existingDefaultPolicyId: existingDefault?.id ?? null,
        });
        if (!validation.ok || validation.policy === undefined) {
          throw validationFromIssues(validation.errors);
        }
        const after = await trx
          .updateTable('policies')
          .set({ ...pick(body), ...(bump ? { version: before.version + 1 } : {}) } as never)
          .where('id', '=', params.id)
          .returningAll()
          .executeTakeFirstOrThrow();
        await writeAudit(trx, ctx, {
          organizationId: params.orgId,
          action: 'policy:update',
          targetType: 'policy',
          targetId: params.id,
          before,
          after,
        });
        return { after, warnings: validation.warnings };
      });
      return {
        status: 200,
        body: { ...result.after, warnings: result.warnings },
        headers: { ETag: etagOf(result.after.updated_at) },
      };
    },
  });

  const remove = defineRoute({
    method: 'delete',
    path: '/api/v1/orgs/:orgId/policies/:id',
    summary: 'Delete (soft) a policy',
    tags: ['policies'],
    auth: 'principal',
    permission: 'policy:delete',
    scope: 'organization',
    params: OrgIdParams,
    responses: { 204: { description: 'Deleted' }, ...problemResponses },
    handler: async ({ params, ctx }) => {
      await inTenant(deps, params.orgId, async (trx) => {
        const before = await trx
          .updateTable('policies')
          .set({ deleted_at: now(), status: 'retired', is_default: false })
          .where('id', '=', params.id)
          .where('deleted_at', 'is', null)
          .returningAll()
          .executeTakeFirst();
        if (before === undefined) throw new NotFoundError('policy', params.id);
        await writeAudit(trx, ctx, {
          organizationId: params.orgId,
          action: 'policy:delete',
          targetType: 'policy',
          targetId: params.id,
        });
      });
      return { status: 204 };
    },
  });

  const listAssignments = defineRoute({
    method: 'get',
    path: '/api/v1/orgs/:orgId/policy-assignments',
    summary: 'List policy assignments',
    tags: ['policies'],
    auth: 'principal',
    permission: 'policy_assignment:read',
    scope: 'any-site',
    params: OrgParams,
    query: PaginationQuery.extend({ policy_id: z.uuid().optional() }),
    responses: { 200: { description: 'Assignments', schema: PageSchema }, ...problemResponses },
    handler: async ({ params, query, ctx }) => {
      const sites = permittedSites(ctx.principal, 'policy_assignment:read', params.orgId);
      const cursor = decodeCursor(query.cursor);
      const rows = await inTenant(deps, params.orgId, (trx) => {
        let q = trx.selectFrom('policy_assignments').selectAll();
        if (sites !== 'all') {
          if (sites.length === 0) return Promise.resolve([]);
          q = q.where('site_id', 'in', sites);
        }
        if (query.policy_id) q = q.where('policy_id', '=', query.policy_id);
        if (typeof cursor === 'string') q = q.where('id', '>', cursor);
        return q
          .orderBy('id')
          .limit(query.limit + 1)
          .execute();
      });
      return { status: 200, body: toPage(rows, query.limit, (r) => r.id) };
    },
  });

  const createAssignment = defineRoute({
    method: 'post',
    path: '/api/v1/orgs/:orgId/policy-assignments',
    summary: 'Assign a policy to exactly one target',
    tags: ['policies'],
    auth: 'principal',
    permission: 'policy_assignment:create',
    scope: 'any-site',
    params: OrgParams,
    body: AssignmentCreate,
    idempotency: 'optional',
    responses: { 201: { description: 'Created', schema: ResourceSchema }, ...problemResponses },
    handler: async ({ params, body, ctx }) => {
      const row = await inTenant(deps, params.orgId, async (trx) => {
        await assertRef(trx, 'policies', body.policy_id, 'policy');
        const target = await assertRef(
          trx,
          TARGET_TABLE[body.target_type],
          body.target_id,
          body.target_type,
        );
        const site = body.target_type === 'site' ? body.target_id : target.site_id;
        requireOnSite(ctx, 'policy_assignment:create', params.orgId, site, 'policy_assignment');
        const id = newId();
        const created = await loose(trx)
          .insertInto('policy_assignments')
          .values({
            id,
            organization_id: params.orgId,
            policy_id: body.policy_id,
            target_type: body.target_type,
            [TARGET_COLUMN[body.target_type]]: body.target_id,
            ...(body.effective_from ? { effective_from: body.effective_from } : {}),
            effective_until: body.effective_until ?? null,
            priority: body.priority ?? 100,
            note: body.note ?? null,
            created_by:
              ctx.principal?.kind === 'admin' && ctx.principal.impersonation === null
                ? ctx.principal.administratorId
                : null,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        await writeAudit(trx, ctx, {
          organizationId: params.orgId,
          action: 'policy_assignment:create',
          targetType: 'policy_assignment',
          targetId: id,
          after: created,
        });
        return created;
      });
      return { status: 201, body: row };
    },
  });

  const removeAssignment = defineRoute({
    method: 'delete',
    path: '/api/v1/orgs/:orgId/policy-assignments/:id',
    summary: 'Delete a policy assignment',
    tags: ['policies'],
    auth: 'principal',
    permission: 'policy_assignment:delete',
    scope: 'any-site',
    params: OrgIdParams,
    responses: { 204: { description: 'Deleted' }, ...problemResponses },
    handler: async ({ params, ctx }) => {
      await inTenant(deps, params.orgId, async (trx) => {
        const before = await trx
          .selectFrom('policy_assignments')
          .selectAll()
          .where('id', '=', params.id)
          .executeTakeFirst();
        if (before === undefined) throw new NotFoundError('policy_assignment', params.id);
        requireOnSite(
          ctx,
          'policy_assignment:delete',
          params.orgId,
          before.site_id,
          'policy_assignment',
          'policy_assignment:read',
        );
        await trx.deleteFrom('policy_assignments').where('id', '=', params.id).execute();
        await writeAudit(trx, ctx, {
          organizationId: params.orgId,
          action: 'policy_assignment:delete',
          targetType: 'policy_assignment',
          targetId: params.id,
          before,
        });
      });
      return { status: 204 };
    },
  });

  const simulateRoute = defineRoute({
    method: 'get',
    path: '/api/v1/orgs/:orgId/policies/simulate',
    summary: 'Resolve the effective policy and per-adapter enforceability (dry run)',
    tags: ['policies'],
    auth: 'principal',
    permission: 'policy:preview',
    scope: 'organization',
    params: OrgParams,
    query: SimulateQuery,
    responses: {
      200: { description: 'Resolution + per-adapter field tables', schema: z.looseObject({}) },
      ...problemResponses,
    },
    handler: async ({ params, query }) => {
      const at = query.at ? new Date(query.at) : now();
      const input = await inTenant(deps, params.orgId, async (trx) => {
        let siteId = query.site_id ?? null;
        let timeZone = 'UTC';
        if (siteId !== null) {
          await assertRef(trx, 'sites', siteId, 'site');
          const site = await trx
            .selectFrom('sites')
            .select(['timezone'])
            .where('id', '=', siteId)
            .executeTakeFirstOrThrow();
          timeZone = site.timezone;
        }
        let subject: Subject;
        const groupIds: string[] = [];
        if (query.user_id !== undefined) {
          await assertRef(trx, 'users', query.user_id, 'user');
          const user = await trx
            .selectFrom('users')
            .select(['user_group_id', 'site_id'])
            .where('id', '=', query.user_id)
            .executeTakeFirstOrThrow();
          if (user.user_group_id) groupIds.push(user.user_group_id);
          siteId ??= user.site_id;
          subject = { kind: 'user', user_id: query.user_id };
        } else {
          const deviceId = query.client_device_id as string;
          await assertRef(trx, 'client_devices', deviceId, 'client_device');
          subject = { kind: 'client_device', client_device_id: deviceId };
        }
        return loadResolutionInput(trx, {
          organizationId: params.orgId,
          siteId,
          timeZone,
          now: at,
          subject,
          clientDeviceId: query.client_device_id ?? null,
          mac: query.mac ?? null,
          groupIds,
          voucherBatchId: null,
        });
      });
      const adapters =
        query.adapter === undefined
          ? listCapabilities()
          : [getAdapter(query.adapter).capabilities()];
      const result = simulate({ resolution: { ...input, trigger: 'preview' }, adapters });
      return {
        status: 200,
        body: toJsonValue({
          decision: result.resolution.decision,
          reason_code: result.resolution.reasonCode,
          reason_detail: result.resolution.reasonDetail,
          effective: result.resolution.effective,
          clip: result.resolution.clip,
          trace: result.resolution.trace,
          snapshot: result.resolution.snapshot,
          per_adapter: result.perAdapter.map((a) => ({
            adapter: a.adapter,
            adapter_version: a.adapterVersion,
            decision: a.plan?.decision ?? null,
            reason_code: a.plan?.reasonCode ?? null,
            field_table: a.fieldTable,
            reply_attributes: a.plan?.radiusReplyAttributes ?? [],
            unenforceable: a.plan?.unenforceable ?? [],
          })),
          capabilities_used: result.capabilitiesUsed,
        }),
      };
    },
  });

  // `simulate` must be registered before `/policies/:id` so the literal segment wins.
  return [
    list,
    simulateRoute,
    get,
    create,
    update,
    remove,
    listAssignments,
    createAssignment,
    removeAssignment,
  ];
}

function policyRowToIntentSafe(row: Row, schedule: Row | null): unknown {
  // Feed validatePolicy the raw merged row so schema errors surface as validation problems
  // instead of exceptions from PolicyIntentSchema.parse.
  try {
    return policyRowToIntent(
      row,
      schedule as { id: string; name: string; timezone: string; rules: unknown } | null,
    );
  } catch {
    return { ...row, schedule };
  }
}
