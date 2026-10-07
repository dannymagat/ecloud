/**
 * Platform routes (API_ARCHITECTURE.md §3.2 "Platform"): organizations, adapter capability
 * matrix, support impersonation (D-027 / MULTITENANCY.md §4.5). All run on the platform
 * connection via `withPlatform(reason)`, which writes the `platform:access` audit row.
 */
import { listAdapters } from '@ecloud/adapters';
import { withPlatform } from '@ecloud/db';
import { ForbiddenError, NotFoundError, POLICY_FIELDS, newId } from '@ecloud/shared';
import { z } from 'zod';
import { DB_ADAPTER_TYPE_MAP } from '../adapter-map.js';
import { writeAudit } from '../audit.js';
import { evaluate } from '../auth/authorize.js';
import {
  parentCookieName,
  parseCookies,
  setSessionCookie,
  clearSessionCookie,
} from '../auth/middleware.js';
import { AUTHN_ACCESS } from '../auth/principal.js';
import { createAdminSession, revokeSessionByToken } from '../auth/sessions.js';
import type { AppDeps, Principal } from '../context.js';
import {
  IdParams,
  OrgParams,
  PageSchema,
  PaginationQuery,
  ResourceSchema,
  checkIfMatch,
  decodeCursor,
  definedOnly,
  etagOf,
  problemResponses,
  toPage,
} from '../http/common.js';
import { ImpersonationForbiddenError } from '../http/errors.js';
import { defineRoute, type AnyRouteSpec } from '../http/route.js';
import { inPlatform, inTenant } from '../tenant.js';

const TAG = ['platform'];

const slug = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/, 'lowercase letters, digits and dashes');

const limits = {
  max_sites: z.number().int().positive().nullable().optional(),
  max_devices: z.number().int().positive().nullable().optional(),
  max_users: z.number().int().positive().nullable().optional(),
  max_concurrent_sessions: z.number().int().positive().nullable().optional(),
};

const CreateOrganization = z.strictObject({
  slug,
  name: z.string().trim().min(1).max(200),
  settings: z.record(z.string(), z.unknown()).optional(),
  ...limits,
});

const UpdateOrganization = z.strictObject({
  name: z.string().trim().min(1).max(200).optional(),
  status: z.enum(['active', 'suspended', 'archived']).optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
  ...limits,
});

const TenantOrganizationUpdate = z.strictObject({
  name: z.string().trim().min(1).max(200).optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
});

const ImpersonateBody = z.strictObject({
  organizationId: z.uuid(),
  reason: z.string().trim().min(5).max(500),
  ttlMinutes: z.number().int().min(1).max(60).default(30),
});

export function platformRoutes(deps: AppDeps): AnyRouteSpec[] {
  const now = deps.now ?? (() => new Date());

  const list = defineRoute({
    method: 'get',
    path: '/api/v1/platform/organizations',
    summary: 'List organizations',
    tags: TAG,
    auth: 'principal',
    permission: 'tenant:list',
    scope: 'platform',
    query: PaginationQuery.extend({
      status: z.enum(['active', 'suspended', 'archived']).optional(),
    }),
    responses: { 200: { description: 'Organizations', schema: PageSchema }, ...problemResponses },
    handler: async ({ query, ctx }) => {
      const cursor = decodeCursor(query.cursor);
      const rows = await inPlatform(deps, ctx, 'list organizations', (trx) => {
        let q = trx.selectFrom('organizations').selectAll().where('deleted_at', 'is', null);
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

  const create = defineRoute({
    method: 'post',
    path: '/api/v1/platform/organizations',
    summary: 'Create an organization',
    tags: TAG,
    auth: 'principal',
    permission: 'organization:create',
    scope: 'platform',
    body: CreateOrganization,
    idempotency: 'optional',
    responses: { 201: { description: 'Created', schema: ResourceSchema }, ...problemResponses },
    handler: async ({ body, ctx }) => {
      const id = newId();
      const row = await inPlatform(
        deps,
        ctx,
        'create organization',
        async (trx) => {
          const created = await trx
            .insertInto('organizations')
            .values({ id, ...body, settings: body.settings ?? {} })
            .returningAll()
            .executeTakeFirstOrThrow();
          await writeAudit(trx, ctx, {
            organizationId: id,
            action: 'organization:create',
            targetType: 'organization',
            targetId: id,
            after: created,
          });
          return created;
        },
        id,
      );
      return { status: 201, body: row, headers: { ETag: etagOf(row.updated_at) } };
    },
  });

  const get = defineRoute({
    method: 'get',
    path: '/api/v1/platform/organizations/:id',
    summary: 'Get an organization',
    tags: TAG,
    auth: 'principal',
    permission: 'organization:read',
    scope: 'platform',
    params: IdParams,
    responses: {
      200: { description: 'Organization', schema: ResourceSchema },
      ...problemResponses,
    },
    handler: async ({ params, ctx }) => {
      const row = await inPlatform(
        deps,
        ctx,
        'read organization',
        (trx) =>
          trx
            .selectFrom('organizations')
            .selectAll()
            .where('id', '=', params.id)
            .executeTakeFirst(),
        params.id,
      );
      if (row === undefined) throw new NotFoundError('organization', params.id);
      return { status: 200, body: row, headers: { ETag: etagOf(row.updated_at) } };
    },
  });

  const update = defineRoute({
    method: 'patch',
    path: '/api/v1/platform/organizations/:id',
    summary: 'Update an organization (status changes need organization:suspend)',
    tags: TAG,
    auth: 'principal',
    permission: 'organization:update',
    scope: 'platform',
    params: IdParams,
    body: UpdateOrganization,
    responses: { 200: { description: 'Updated', schema: ResourceSchema }, ...problemResponses },
    handler: async ({ params, body, req, ctx }) => {
      if (body.status !== undefined && !evaluate(ctx.principal, 'organization:suspend', {})) {
        throw new ForbiddenError();
      }
      const row = await inPlatform(
        deps,
        ctx,
        'update organization',
        async (trx) => {
          const before = await trx
            .selectFrom('organizations')
            .selectAll()
            .where('id', '=', params.id)
            .where('deleted_at', 'is', null)
            .forUpdate()
            .executeTakeFirst();
          if (before === undefined) throw new NotFoundError('organization', params.id);
          checkIfMatch(req, before.updated_at);
          const after = await trx
            .updateTable('organizations')
            .set(definedOnly(body))
            .where('id', '=', params.id)
            .returningAll()
            .executeTakeFirstOrThrow();
          await writeAudit(trx, ctx, {
            organizationId: params.id,
            action: body.status !== undefined ? 'organization:suspend' : 'organization:update',
            targetType: 'organization',
            targetId: params.id,
            before,
            after,
          });
          return after;
        },
        params.id,
      );
      return { status: 200, body: row, headers: { ETag: etagOf(row.updated_at) } };
    },
  });

  const remove = defineRoute({
    method: 'delete',
    path: '/api/v1/platform/organizations/:id',
    summary: 'Archive (soft-delete) an organization',
    tags: TAG,
    auth: 'principal',
    permission: 'organization:delete',
    scope: 'platform',
    params: IdParams,
    responses: { 204: { description: 'Archived' }, ...problemResponses },
    handler: async ({ params, ctx }) => {
      await inPlatform(
        deps,
        ctx,
        'delete organization',
        async (trx) => {
          const before = await trx
            .updateTable('organizations')
            .set({ status: 'archived', deleted_at: now() })
            .where('id', '=', params.id)
            .where('deleted_at', 'is', null)
            .returningAll()
            .executeTakeFirst();
          if (before === undefined) throw new NotFoundError('organization', params.id);
          await writeAudit(trx, ctx, {
            organizationId: params.id,
            action: 'organization:delete',
            targetType: 'organization',
            targetId: params.id,
            after: { status: 'archived' },
          });
        },
        params.id,
      );
      return { status: 204 };
    },
  });

  const tenantGet = defineRoute({
    method: 'get',
    path: '/api/v1/orgs/:orgId',
    summary: 'Get the current organization',
    tags: ['organization'],
    auth: 'principal',
    permission: 'organization:read',
    scope: 'organization',
    params: OrgParams,
    responses: {
      200: { description: 'Organization', schema: ResourceSchema },
      ...problemResponses,
    },
    handler: async ({ params }) => {
      const row = await inTenant(deps, params.orgId, (trx) =>
        trx
          .selectFrom('organizations')
          .selectAll()
          .where('id', '=', params.orgId)
          .where('deleted_at', 'is', null)
          .executeTakeFirst(),
      );
      if (row === undefined) throw new NotFoundError('organization', params.orgId);
      return { status: 200, body: row, headers: { ETag: etagOf(row.updated_at) } };
    },
  });

  const tenantUpdate = defineRoute({
    method: 'patch',
    path: '/api/v1/orgs/:orgId',
    summary: 'Update the current organization (settings need organization:settings:update)',
    tags: ['organization'],
    auth: 'principal',
    permission: 'organization:update',
    scope: 'organization',
    params: OrgParams,
    body: TenantOrganizationUpdate,
    responses: { 200: { description: 'Updated', schema: ResourceSchema }, ...problemResponses },
    handler: async ({ params, body, req, ctx }) => {
      if (
        body.settings !== undefined &&
        !evaluate(ctx.principal, 'organization:settings:update', { organizationId: params.orgId })
      ) {
        throw new ForbiddenError();
      }
      const row = await inTenant(deps, params.orgId, async (trx) => {
        const before = await trx
          .selectFrom('organizations')
          .selectAll()
          .where('id', '=', params.orgId)
          .where('deleted_at', 'is', null)
          .forUpdate()
          .executeTakeFirst();
        if (before === undefined) throw new NotFoundError('organization', params.orgId);
        checkIfMatch(req, before.updated_at);
        const after = await trx
          .updateTable('organizations')
          .set(definedOnly(body))
          .where('id', '=', params.orgId)
          .returningAll()
          .executeTakeFirstOrThrow();
        await writeAudit(trx, ctx, {
          organizationId: params.orgId,
          action:
            body.settings !== undefined ? 'organization:settings:update' : 'organization:update',
          targetType: 'organization',
          targetId: params.orgId,
          before,
          after,
        });
        return after;
      });
      return { status: 200, body: row, headers: { ETag: etagOf(row.updated_at) } };
    },
  });

  const adapters = defineRoute({
    method: 'get',
    path: '/api/v1/platform/adapters',
    summary: 'NAS adapter capability matrix (four-state statuses, D-028)',
    tags: TAG,
    auth: 'principal',
    permission: 'platform:health:read',
    scope: 'platform',
    responses: {
      200: {
        description: 'Adapters with per-field status and evidence',
        schema: z.object({ adapters: z.array(z.looseObject({ key: z.string() })) }),
      },
      ...problemResponses,
    },
    handler: async ({ ctx }) => {
      const adapterTypes = await inPlatform(deps, ctx, 'read adapter types', (trx) =>
        trx.selectFrom('adapter_types').selectAll().orderBy('key').execute(),
      );
      const body = {
        adapters: listAdapters().map((adapter) => {
          const caps = adapter.capabilities();
          return {
            key: caps.key,
            version: caps.version,
            portal_type: caps.portalType,
            granularity: caps.granularity,
            fields: POLICY_FIELDS.map((field) => ({
              field,
              status: caps.fields[field].status,
              evidence: caps.fields[field].evidence,
              ...(caps.fields[field].note ? { note: caps.fields[field].note } : {}),
            })),
            disconnect: {
              status: caps.disconnect.status,
              evidence: caps.disconnect.evidence,
              target: caps.disconnect.target,
            },
            coa_change: { status: caps.coaChange.status, evidence: caps.coaChange.evidence },
            mac_auth: { status: caps.macAuth.status, evidence: caps.macAuth.evidence },
            attributes: Object.values(caps.attributes).map((a) => ({
              name: a.name,
              status: a.status,
              evidence: a.evidence,
            })),
          };
        }),
        adapter_types: adapterTypes.map((t) => ({
          ...t,
          engine_adapter: DB_ADAPTER_TYPE_MAP[t.key] ?? null,
        })),
      };
      return { status: 200, body };
    },
  });

  const impersonate = defineRoute({
    method: 'post',
    path: '/api/v1/platform/support/impersonate',
    summary: 'Start a time-limited, audited impersonation of an organization (D-027)',
    tags: TAG,
    auth: 'session',
    permission: 'tenant:impersonate',
    scope: 'platform',
    body: ImpersonateBody,
    responses: {
      201: {
        description: 'Impersonation session started (cookie replaced; parent kept)',
        schema: z.object({ organization_id: z.string(), expires_at: z.string() }),
      },
      ...problemResponses,
    },
    handler: async ({ body, req, res, ctx }) => {
      const principal = ctx.principal as Extract<Principal, { kind: 'admin' }>;
      if (principal.impersonation !== null) {
        throw new ImpersonationForbiddenError('Starting a nested impersonation');
      }
      const at = now();
      const ttlSeconds = body.ttlMinutes * 60;
      const session = await inPlatform(
        deps,
        ctx,
        `impersonation: ${body.reason}`,
        async (trx) => {
          const org = await trx
            .selectFrom('organizations')
            .select(['id'])
            .where('id', '=', body.organizationId)
            .where('deleted_at', 'is', null)
            .executeTakeFirst();
          if (org === undefined) throw new NotFoundError('organization', body.organizationId);
          const s = await createAdminSession(trx, {
            administratorId: principal.administratorId,
            ttlSeconds,
            now: at,
            ip: ctx.ip,
            userAgent: ctx.userAgent,
            impersonatingOrganizationId: body.organizationId,
            impersonationReason: body.reason,
          });
          await writeAudit(trx, ctx, {
            organizationId: body.organizationId,
            action: 'tenant:impersonate',
            targetType: 'organization',
            targetId: body.organizationId,
            after: {
              reason: body.reason,
              ttl_minutes: body.ttlMinutes,
              impersonation_session_id: s.id,
              expires_at: s.expiresAt,
            },
          });
          return s;
        },
        body.organizationId,
      );
      const cookies = parseCookies(req.get('Cookie'));
      const parent = cookies.get(deps.config.session.cookieName);
      if (parent !== undefined) {
        setSessionCookie(
          deps,
          res,
          parent,
          deps.config.session.ttlSeconds,
          parentCookieName(deps.config.session.cookieName),
        );
      }
      setSessionCookie(deps, res, session.token, ttlSeconds);
      return {
        status: 201,
        body: {
          organization_id: body.organizationId,
          expires_at: session.expiresAt.toISOString(),
        },
        headers: { 'X-ECLOUD-Impersonating': body.organizationId },
      };
    },
  });

  const stopImpersonation = defineRoute({
    method: 'delete',
    path: '/api/v1/platform/support/impersonate',
    summary: 'End the current impersonation and restore the parent session',
    tags: TAG,
    auth: 'session',
    responses: { 204: { description: 'Impersonation ended' }, ...problemResponses },
    handler: async ({ req, res, ctx }) => {
      const principal = ctx.principal as Extract<Principal, { kind: 'admin' }>;
      if (principal.impersonation === null) {
        throw new NotFoundError('impersonation');
      }
      const organizationId = principal.impersonation.organizationId;
      const cookies = parseCookies(req.get('Cookie'));
      const name = deps.config.session.cookieName;
      const token = cookies.get(name);
      const at = now();
      await withPlatform(deps.dbPlatform, AUTHN_ACCESS, async (trx) => {
        if (token) await revokeSessionByToken(trx, token, at);
        await writeAudit(trx, ctx, {
          organizationId,
          action: 'tenant:impersonate:end',
          targetType: 'organization',
          targetId: organizationId,
          after: { impersonation_session_id: principal.sessionId },
        });
      });
      const parent = cookies.get(parentCookieName(name));
      if (parent !== undefined && parent !== '') {
        setSessionCookie(deps, res, parent, deps.config.session.ttlSeconds);
      } else {
        clearSessionCookie(deps, res);
      }
      clearSessionCookie(deps, res, parentCookieName(name));
      res.removeHeader('X-ECLOUD-Impersonating');
      return { status: 204 };
    },
  });

  return [
    list,
    create,
    get,
    update,
    remove,
    tenantGet,
    tenantUpdate,
    adapters,
    impersonate,
    stopImpersonation,
  ];
}
