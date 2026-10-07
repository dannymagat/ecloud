/**
 * Access management (API_ARCHITECTURE.md §3.2 "structure & access", MULTITENANCY.md §4.3–§4.6):
 * roles (templates read-only, custom roles CRUD), role bindings, API keys, administrators and
 * invitations. Escalation guard: a principal may only grant a role (binding, invitation, API
 * key) whose every permission it already holds in the target scope. D-027: API-key creation and
 * binding/invitation changes are refused while impersonating.
 */
import type { DbTransaction } from '@ecloud/db';
import {
  ForbiddenError,
  NotFoundError,
  getPermission,
  isKnownPermission,
  newId,
  ValidationError,
} from '@ecloud/shared';
import { z } from 'zod';
import { writeAudit } from '../audit.js';
import { holdsAll } from '../auth/authorize.js';
import { requestIsImpersonating } from '../auth/middleware.js';
import type { AppDeps, RequestContext } from '../context.js';
import { randomAlnum, randomToken, sha256Hex } from '../crypto.js';
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
import { ImpersonationForbiddenError, UnprocessableError } from '../http/errors.js';
import { defineRoute, type AnyRouteSpec } from '../http/route.js';
import { assertRef, inTenant } from '../tenant.js';

const INVITATION_TTL_S = 7 * 24 * 3600;
const MAX_API_KEY_LIFETIME_MS = 366 * 24 * 3600 * 1000;

const permissionList = z
  .array(z.string())
  .max(200)
  .transform((keys, ctx) => {
    const out = new Set<string>();
    for (const key of keys) {
      const normalized = key.trim().replaceAll('.', ':');
      if (!isKnownPermission(normalized)) {
        ctx.addIssue({ code: 'custom', message: `unknown permission ${key}` });
        continue;
      }
      if (getPermission(normalized)?.platformOnly) {
        ctx.addIssue({ code: 'custom', message: `platform-only permission ${key}` });
        continue;
      }
      out.add(normalized);
    }
    return [...out].sort();
  });

const RoleCreate = z
  .strictObject({
    key: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/),
    name: z.string().trim().min(1).max(200),
    description: z.string().max(1000).optional(),
    permissions: permissionList.optional(),
    from_template: z
      .string()
      .regex(/^[a-z][a-z0-9_]{1,63}$/)
      .optional(),
  })
  .refine((b) => b.permissions !== undefined || b.from_template !== undefined, {
    message: 'permissions or from_template is required',
  });

const RoleUpdate = z.strictObject({
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(1000).optional(),
  permissions: permissionList.optional(),
});

const scopeFields = {
  scope_type: z.enum(['organization', 'site']),
  site_id: z.uuid().nullable().optional(),
};

function scopeRefine<T extends { scope_type: 'organization' | 'site'; site_id?: string | null }>(
  b: T,
): boolean {
  return b.scope_type === 'site' ? typeof b.site_id === 'string' : !b.site_id;
}
const scopeMessage = { message: 'site_id is required for site scope and forbidden otherwise' };

const BindingCreate = z
  .strictObject({
    administrator_id: z.uuid(),
    role_id: z.uuid(),
    ...scopeFields,
    expires_at: z.iso.datetime({ offset: true }).nullable().optional(),
  })
  .refine(scopeRefine, scopeMessage);

const ApiKeyCreate = z
  .strictObject({
    name: z.string().trim().min(1).max(200),
    role_id: z.uuid(),
    ...scopeFields,
    allowed_cidrs: z
      .array(z.union([z.cidrv4(), z.cidrv6()]))
      .max(50)
      .nullable()
      .optional(),
    expires_at: z.iso.datetime({ offset: true }).nullable().optional(),
  })
  .refine(scopeRefine, scopeMessage);

const InvitationCreate = z
  .strictObject({
    email: z.string().trim().toLowerCase().max(320).pipe(z.email()),
    role_id: z.uuid(),
    ...scopeFields,
  })
  .refine(scopeRefine, scopeMessage);

interface RoleWithPermissions {
  id: string;
  organization_id: string | null;
  key: string;
  name: string;
  is_template: boolean;
  permissions: string[];
}

/** Role visible to the tenant (own custom role or platform template) with its permission keys. */
async function loadRole(
  trx: DbTransaction,
  roleId: string,
  orgId: string,
): Promise<RoleWithPermissions> {
  const role = await trx
    .selectFrom('roles')
    .select(['id', 'organization_id', 'key', 'name', 'is_template'])
    .where('id', '=', roleId)
    .where((eb) =>
      eb.or([
        eb('organization_id', '=', orgId),
        eb.and([eb('organization_id', 'is', null), eb('is_template', '=', true)]),
      ]),
    )
    .executeTakeFirst();
  if (role === undefined) throw new NotFoundError('role', roleId);
  const permissions = await trx
    .selectFrom('role_permissions')
    .select('permission_key')
    .where('role_id', '=', roleId)
    .execute();
  return { ...role, permissions: permissions.map((p) => p.permission_key).sort() };
}

function assertGrantable(
  ctx: RequestContext,
  role: RoleWithPermissions,
  orgId: string,
  siteId: string | null,
): void {
  if (role.permissions.some((key) => getPermission(key)?.platformOnly === true)) {
    throw new UnprocessableError(
      'Roles with platform-only permissions cannot be granted in a tenant.',
    );
  }
  if (!holdsAll(ctx.principal, role.permissions, { organizationId: orgId, siteId })) {
    throw new ForbiddenError({
      detail: 'You can only grant roles whose permissions you hold in that scope.',
    });
  }
}

function denyWhileImpersonating(ctx: RequestContext, action: string): void {
  if (ctx.principal?.kind === 'admin' && ctx.principal.impersonation !== null) {
    throw new ImpersonationForbiddenError(action);
  }
}

function actorAdminId(ctx: RequestContext): string | null {
  return ctx.principal?.kind === 'admin' && ctx.principal.impersonation === null
    ? ctx.principal.administratorId
    : null;
}

export function accessRoutes(deps: AppDeps): AnyRouteSpec[] {
  const now = deps.now ?? (() => new Date());

  // ------------------------------------------------------------------------------- roles
  const listRoles = defineRoute({
    method: 'get',
    path: '/api/v1/orgs/:orgId/roles',
    summary: 'List role templates and custom roles',
    tags: ['roles'],
    auth: 'principal',
    permission: 'role:read',
    scope: 'organization',
    params: OrgParams,
    responses: { 200: { description: 'Roles', schema: PageSchema }, ...problemResponses },
    handler: async ({ params }) => {
      const data = await inTenant(deps, params.orgId, async (trx) => {
        const roles = await trx
          .selectFrom('roles')
          .selectAll()
          .where((eb) =>
            eb.or([eb('organization_id', '=', params.orgId), eb('is_template', '=', true)]),
          )
          .orderBy('is_template', 'desc')
          .orderBy('key')
          .execute();
        const perms = await trx
          .selectFrom('role_permissions')
          .select(['role_id', 'permission_key'])
          .where(
            'role_id',
            'in',
            roles.length === 0 ? ['00000000-0000-0000-0000-000000000000'] : roles.map((r) => r.id),
          )
          .execute();
        return roles.map((r) => ({
          ...r,
          permissions: perms
            .filter((p) => p.role_id === r.id)
            .map((p) => p.permission_key)
            .sort(),
        }));
      });
      return { status: 200, body: { data, next_cursor: null } };
    },
  });

  const getRole = defineRoute({
    method: 'get',
    path: '/api/v1/orgs/:orgId/roles/:id',
    summary: 'Get a role with its permissions',
    tags: ['roles'],
    auth: 'principal',
    permission: 'role:read',
    scope: 'organization',
    params: OrgIdParams,
    responses: { 200: { description: 'Role', schema: ResourceSchema }, ...problemResponses },
    handler: async ({ params }) => {
      const role = await inTenant(deps, params.orgId, (trx) =>
        loadRole(trx, params.id, params.orgId),
      );
      return { status: 200, body: role };
    },
  });

  const createRole = defineRoute({
    method: 'post',
    path: '/api/v1/orgs/:orgId/roles',
    summary: 'Create a custom role (optionally copied from a template)',
    tags: ['roles'],
    auth: 'principal',
    permission: 'role:create',
    scope: 'organization',
    params: OrgParams,
    body: RoleCreate,
    idempotency: 'optional',
    responses: { 201: { description: 'Created', schema: ResourceSchema }, ...problemResponses },
    handler: async ({ params, body, ctx }) => {
      const role = await inTenant(deps, params.orgId, async (trx) => {
        let permissions = body.permissions ?? [];
        let templateKey: string | null = null;
        let templateVersion = 1;
        if (body.from_template !== undefined) {
          const template = await trx
            .selectFrom('roles')
            .select(['id', 'key', 'template_version'])
            .where('key', '=', body.from_template)
            .where('organization_id', 'is', null)
            .where('is_template', '=', true)
            .executeTakeFirst();
          if (template === undefined) throw new NotFoundError('role template', body.from_template);
          templateKey = template.key;
          templateVersion = template.template_version;
          if (body.permissions === undefined) {
            const rows = await trx
              .selectFrom('role_permissions')
              .select('permission_key')
              .where('role_id', '=', template.id)
              .execute();
            permissions = rows
              .map((r) => r.permission_key)
              .filter((k) => getPermission(k)?.platformOnly !== true);
          }
        }
        const id = newId();
        const created = await trx
          .insertInto('roles')
          .values({
            id,
            organization_id: params.orgId,
            key: body.key,
            name: body.name,
            description: body.description ?? '',
            is_template: false,
            template_key: templateKey,
            template_version: templateVersion,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        if (permissions.length > 0) {
          await trx
            .insertInto('role_permissions')
            .values(permissions.map((permission_key) => ({ role_id: id, permission_key })))
            .execute();
        }
        await writeAudit(trx, ctx, {
          organizationId: params.orgId,
          action: 'role:create',
          targetType: 'role',
          targetId: id,
          after: { ...created, permissions },
        });
        return { ...created, permissions };
      });
      return { status: 201, body: role, headers: { ETag: etagOf(role.updated_at) } };
    },
  });

  const updateRole = defineRoute({
    method: 'patch',
    path: '/api/v1/orgs/:orgId/roles/:id',
    summary: 'Update a custom role (templates are read-only for tenants)',
    tags: ['roles'],
    auth: 'principal',
    permission: 'role:update',
    scope: 'organization',
    params: OrgIdParams,
    body: RoleUpdate,
    responses: { 200: { description: 'Updated', schema: ResourceSchema }, ...problemResponses },
    handler: async ({ params, body, req, ctx }) => {
      const role = await inTenant(deps, params.orgId, async (trx) => {
        const before = await trx
          .selectFrom('roles')
          .selectAll()
          .where('id', '=', params.id)
          .where('organization_id', '=', params.orgId)
          .forUpdate()
          .executeTakeFirst();
        if (before === undefined) throw new NotFoundError('role', params.id);
        checkIfMatch(req, before.updated_at);
        const beforePerms = await loadRole(trx, params.id, params.orgId);
        if (body.permissions !== undefined) {
          // Adding permissions to a role you could then hold or hand out is an escalation path.
          const added = body.permissions.filter((p) => !beforePerms.permissions.includes(p));
          if (!holdsAll(ctx.principal, added, { organizationId: params.orgId })) {
            throw new ForbiddenError({ detail: 'You can only add permissions you hold.' });
          }
          await trx.deleteFrom('role_permissions').where('role_id', '=', params.id).execute();
          if (body.permissions.length > 0) {
            await trx
              .insertInto('role_permissions')
              .values(
                body.permissions.map((permission_key) => ({ role_id: params.id, permission_key })),
              )
              .execute();
          }
        }
        const after = await trx
          .updateTable('roles')
          .set({
            ...(body.name !== undefined ? { name: body.name } : {}),
            ...(body.description !== undefined ? { description: body.description } : {}),
            updated_at: now(),
          })
          .where('id', '=', params.id)
          .returningAll()
          .executeTakeFirstOrThrow();
        const permissions = body.permissions ?? beforePerms.permissions;
        await writeAudit(trx, ctx, {
          organizationId: params.orgId,
          action: 'role:update',
          targetType: 'role',
          targetId: params.id,
          before: beforePerms,
          after: { ...after, permissions },
        });
        return { ...after, permissions };
      });
      return { status: 200, body: role, headers: { ETag: etagOf(role.updated_at) } };
    },
  });

  const deleteRole = defineRoute({
    method: 'delete',
    path: '/api/v1/orgs/:orgId/roles/:id',
    summary: 'Delete a custom role',
    tags: ['roles'],
    auth: 'principal',
    permission: 'role:delete',
    scope: 'organization',
    params: OrgIdParams,
    responses: { 204: { description: 'Deleted' }, ...problemResponses },
    handler: async ({ params, ctx }) => {
      await inTenant(deps, params.orgId, async (trx) => {
        const before = await trx
          .deleteFrom('roles')
          .where('id', '=', params.id)
          .where('organization_id', '=', params.orgId)
          .returningAll()
          .executeTakeFirst();
        if (before === undefined) throw new NotFoundError('role', params.id);
        await writeAudit(trx, ctx, {
          organizationId: params.orgId,
          action: 'role:delete',
          targetType: 'role',
          targetId: params.id,
          before,
        });
      });
      return { status: 204 };
    },
  });

  // ------------------------------------------------------------------------- role bindings
  const listBindings = defineRoute({
    method: 'get',
    path: '/api/v1/orgs/:orgId/role-bindings',
    summary: 'List role bindings of the organization',
    tags: ['roles'],
    auth: 'principal',
    permission: 'administrator:read',
    scope: 'organization',
    params: OrgParams,
    query: PaginationQuery.extend({ administrator_id: z.uuid().optional() }),
    responses: { 200: { description: 'Bindings', schema: PageSchema }, ...problemResponses },
    handler: async ({ params, query }) => {
      const cursor = decodeCursor(query.cursor);
      const rows = await inTenant(deps, params.orgId, (trx) => {
        let q = trx
          .selectFrom('role_bindings as rb')
          .innerJoin('administrators as a', 'a.id', 'rb.administrator_id')
          .innerJoin('roles as r', 'r.id', 'rb.role_id')
          .selectAll('rb')
          .select(['a.email', 'r.key as role_key', 'r.name as role_name']);
        if (query.administrator_id) q = q.where('rb.administrator_id', '=', query.administrator_id);
        if (typeof cursor === 'string') q = q.where('rb.id', '>', cursor);
        return q
          .orderBy('rb.id')
          .limit(query.limit + 1)
          .execute();
      });
      return { status: 200, body: toPage(rows, query.limit, (r) => r.id) };
    },
  });

  const createBinding = defineRoute({
    method: 'post',
    path: '/api/v1/orgs/:orgId/role-bindings',
    summary: 'Grant a role to an administrator in this organization or one of its sites',
    tags: ['roles'],
    auth: 'principal',
    permission: 'administrator:binding:create',
    scope: 'organization',
    params: OrgParams,
    body: BindingCreate,
    idempotency: 'optional',
    responses: { 201: { description: 'Created', schema: ResourceSchema }, ...problemResponses },
    handler: async ({ params, body, ctx }) => {
      denyWhileImpersonating(ctx, 'administrator:binding:create');
      const row = await inTenant(deps, params.orgId, async (trx) => {
        const siteId = body.scope_type === 'site' ? (body.site_id as string) : null;
        if (siteId !== null) await assertRef(trx, 'sites', siteId, 'site');
        const role = await loadRole(trx, body.role_id, params.orgId);
        assertGrantable(ctx, role, params.orgId, siteId);
        const admin = await trx
          .selectFrom('administrators')
          .select(['id', 'status'])
          .where('id', '=', body.administrator_id)
          .where('deleted_at', 'is', null)
          .executeTakeFirst();
        if (admin === undefined || admin.status === 'disabled') {
          throw new NotFoundError('administrator', body.administrator_id);
        }
        const id = newId();
        const created = await trx
          .insertInto('role_bindings')
          .values({
            id,
            administrator_id: body.administrator_id,
            role_id: body.role_id,
            scope_type: body.scope_type,
            organization_id: params.orgId,
            site_id: siteId,
            granted_by: actorAdminId(ctx),
            expires_at: body.expires_at ?? null,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        await writeAudit(trx, ctx, {
          organizationId: params.orgId,
          action: 'administrator:binding:create',
          targetType: 'role_binding',
          targetId: id,
          after: { ...created, role_key: role.key },
        });
        return created;
      });
      return { status: 201, body: row };
    },
  });

  const deleteBinding = defineRoute({
    method: 'delete',
    path: '/api/v1/orgs/:orgId/role-bindings/:id',
    summary: 'Revoke a role binding',
    tags: ['roles'],
    auth: 'principal',
    permission: 'administrator:binding:delete',
    scope: 'organization',
    params: OrgIdParams,
    responses: { 204: { description: 'Revoked' }, ...problemResponses },
    handler: async ({ params, ctx }) => {
      denyWhileImpersonating(ctx, 'administrator:binding:delete');
      await inTenant(deps, params.orgId, async (trx) => {
        const before = await trx
          .selectFrom('role_bindings')
          .selectAll()
          .where('id', '=', params.id)
          .executeTakeFirst();
        if (before === undefined) throw new NotFoundError('role_binding', params.id);
        const role = await loadRole(trx, before.role_id, params.orgId);
        assertGrantable(ctx, role, params.orgId, before.site_id);
        await trx.deleteFrom('role_bindings').where('id', '=', params.id).execute();
        await writeAudit(trx, ctx, {
          organizationId: params.orgId,
          action: 'administrator:binding:delete',
          targetType: 'role_binding',
          targetId: params.id,
          before,
        });
      });
      return { status: 204 };
    },
  });

  // ------------------------------------------------------------------------------ API keys
  const listKeys = defineRoute({
    method: 'get',
    path: '/api/v1/orgs/:orgId/api-keys',
    summary: 'List API keys (never the secret)',
    tags: ['api-keys'],
    auth: 'principal',
    permission: 'api_key:read',
    scope: 'organization',
    params: OrgParams,
    query: PaginationQuery,
    responses: { 200: { description: 'API keys', schema: PageSchema }, ...problemResponses },
    handler: async ({ params, query }) => {
      const cursor = decodeCursor(query.cursor);
      const rows = await inTenant(deps, params.orgId, (trx) => {
        let q = trx
          .selectFrom('api_keys')
          .select([
            'id',
            'organization_id',
            'name',
            'key_prefix',
            'role_id',
            'scope_type',
            'site_id',
            'allowed_cidrs',
            'created_by',
            'last_used_at',
            'expires_at',
            'revoked_at',
            'created_at',
            'updated_at',
          ]);
        if (typeof cursor === 'string') q = q.where('id', '>', cursor);
        return q
          .orderBy('id')
          .limit(query.limit + 1)
          .execute();
      });
      return { status: 200, body: toPage(rows, query.limit, (r) => r.id) };
    },
  });

  const createKey = defineRoute({
    method: 'post',
    path: '/api/v1/orgs/:orgId/api-keys',
    summary: 'Create an API key bound to one role and scope (plaintext returned once)',
    tags: ['api-keys'],
    auth: 'principal',
    permission: 'api_key:create',
    scope: 'organization',
    params: OrgParams,
    body: ApiKeyCreate,
    idempotency: 'required',
    secretFields: ['key'],
    responses: {
      201: { description: 'Created; `key` shown once', schema: ResourceSchema },
      ...problemResponses,
    },
    handler: async ({ params, body, req, ctx }) => {
      if (requestIsImpersonating(req)) throw new ImpersonationForbiddenError('api_key:create');
      if (body.expires_at) {
        const expires = new Date(body.expires_at).getTime();
        if (expires <= now().getTime() || expires - now().getTime() > MAX_API_KEY_LIFETIME_MS) {
          throw new ValidationError([
            {
              path: 'body.expires_at',
              message: 'must be in the future and at most one year ahead',
            },
          ]);
        }
      }
      const result = await inTenant(deps, params.orgId, async (trx) => {
        const siteId = body.scope_type === 'site' ? (body.site_id as string) : null;
        if (siteId !== null) await assertRef(trx, 'sites', siteId, 'site');
        const role = await loadRole(trx, body.role_id, params.orgId);
        assertGrantable(ctx, role, params.orgId, siteId);
        const prefix = `eck_${randomAlnum(12)}`;
        const key = `${prefix}_${randomToken(32)}`;
        const id = newId();
        const created = await trx
          .insertInto('api_keys')
          .values({
            id,
            organization_id: params.orgId,
            created_by: actorAdminId(ctx),
            name: body.name,
            key_prefix: prefix,
            key_hash: sha256Hex(key),
            role_id: body.role_id,
            scope_type: body.scope_type,
            site_id: siteId,
            allowed_cidrs: body.allowed_cidrs ?? null,
            expires_at: body.expires_at ?? null,
          })
          .returning([
            'id',
            'organization_id',
            'name',
            'key_prefix',
            'role_id',
            'scope_type',
            'site_id',
            'allowed_cidrs',
            'expires_at',
            'created_at',
          ])
          .executeTakeFirstOrThrow();
        await writeAudit(trx, ctx, {
          organizationId: params.orgId,
          action: 'api_key:create',
          targetType: 'api_key',
          targetId: id,
          after: created,
        });
        return { ...created, key };
      });
      return { status: 201, body: result };
    },
  });

  const revokeKey = defineRoute({
    method: 'delete',
    path: '/api/v1/orgs/:orgId/api-keys/:id',
    summary: 'Revoke an API key',
    tags: ['api-keys'],
    auth: 'principal',
    permission: 'api_key:revoke',
    scope: 'organization',
    params: OrgIdParams,
    responses: { 204: { description: 'Revoked' }, ...problemResponses },
    handler: async ({ params, ctx }) => {
      await inTenant(deps, params.orgId, async (trx) => {
        const row = await trx
          .updateTable('api_keys')
          .set({ revoked_at: now() })
          .where('id', '=', params.id)
          .where('revoked_at', 'is', null)
          .returning(['id', 'key_prefix', 'name'])
          .executeTakeFirst();
        if (row === undefined) throw new NotFoundError('api_key', params.id);
        await writeAudit(trx, ctx, {
          organizationId: params.orgId,
          action: 'api_key:revoke',
          targetType: 'api_key',
          targetId: params.id,
          before: row,
        });
      });
      return { status: 204 };
    },
  });

  // ------------------------------------------------------------- administrators / invitations
  const listAdmins = defineRoute({
    method: 'get',
    path: '/api/v1/orgs/:orgId/administrators',
    summary: 'Administrators holding a binding in this organization',
    tags: ['administrators'],
    auth: 'principal',
    permission: 'administrator:read',
    scope: 'organization',
    params: OrgParams,
    responses: { 200: { description: 'Administrators', schema: PageSchema }, ...problemResponses },
    handler: async ({ params }) => {
      const data = await inTenant(deps, params.orgId, async (trx) => {
        const bindings = await trx
          .selectFrom('role_bindings')
          .select(['administrator_id'])
          .distinct()
          .execute();
        if (bindings.length === 0) return [];
        return trx
          .selectFrom('administrators')
          .select(['id', 'email', 'display_name', 'status', 'last_login_at', 'created_at'])
          .where(
            'id',
            'in',
            bindings.map((b) => b.administrator_id),
          )
          .where('deleted_at', 'is', null)
          .orderBy('email')
          .execute();
      });
      return { status: 200, body: { data, next_cursor: null } };
    },
  });

  const listInvitations = defineRoute({
    method: 'get',
    path: '/api/v1/orgs/:orgId/invitations',
    summary: 'List invitations',
    tags: ['administrators'],
    auth: 'principal',
    permission: 'administrator:read',
    scope: 'organization',
    params: OrgParams,
    query: PaginationQuery,
    responses: { 200: { description: 'Invitations', schema: PageSchema }, ...problemResponses },
    handler: async ({ params, query }) => {
      const cursor = decodeCursor(query.cursor);
      const rows = await inTenant(deps, params.orgId, (trx) => {
        let q = trx
          .selectFrom('invitations')
          .select([
            'id',
            'email',
            'role_id',
            'scope_type',
            'site_id',
            'invited_by',
            'expires_at',
            'accepted_at',
            'accepted_administrator_id',
            'created_at',
          ]);
        if (typeof cursor === 'string') q = q.where('id', '>', cursor);
        return q
          .orderBy('id')
          .limit(query.limit + 1)
          .execute();
      });
      return { status: 200, body: toPage(rows, query.limit, (r) => r.id) };
    },
  });

  const invite = defineRoute({
    method: 'post',
    path: '/api/v1/orgs/:orgId/invitations',
    summary: 'Invite an administrator (token returned once; no mailer in Phase 3)',
    tags: ['administrators'],
    auth: 'principal',
    permission: 'administrator:invite',
    scope: 'organization',
    params: OrgParams,
    body: InvitationCreate,
    idempotency: 'required',
    secretFields: ['token'],
    responses: {
      201: { description: 'Invitation; `token` shown once', schema: ResourceSchema },
      ...problemResponses,
    },
    handler: async ({ params, body, ctx }) => {
      denyWhileImpersonating(ctx, 'administrator:invite');
      const result = await inTenant(deps, params.orgId, async (trx) => {
        const siteId = body.scope_type === 'site' ? (body.site_id as string) : null;
        if (siteId !== null) await assertRef(trx, 'sites', siteId, 'site');
        const role = await loadRole(trx, body.role_id, params.orgId);
        assertGrantable(ctx, role, params.orgId, siteId);
        const token = randomToken(32);
        const id = newId();
        const created = await trx
          .insertInto('invitations')
          .values({
            id,
            organization_id: params.orgId,
            email: body.email,
            role_id: body.role_id,
            scope_type: body.scope_type,
            site_id: siteId,
            token_hash: sha256Hex(token),
            invited_by: actorAdminId(ctx),
            expires_at: new Date(now().getTime() + INVITATION_TTL_S * 1000),
          })
          .returning([
            'id',
            'email',
            'role_id',
            'scope_type',
            'site_id',
            'expires_at',
            'created_at',
          ])
          .executeTakeFirstOrThrow();
        await writeAudit(trx, ctx, {
          organizationId: params.orgId,
          action: 'administrator:invite',
          targetType: 'invitation',
          targetId: id,
          after: created,
        });
        return { ...created, token };
      });
      return { status: 201, body: result };
    },
  });

  return [
    listRoles,
    getRole,
    createRole,
    updateRole,
    deleteRole,
    listBindings,
    createBinding,
    deleteBinding,
    listKeys,
    createKey,
    revokeKey,
    listAdmins,
    listInvitations,
    invite,
  ];
}
