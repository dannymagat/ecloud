/**
 * Administrator management (API_ARCHITECTURE.md §3.2): platform list / detail / PATCH,
 * organization detail / PATCH, and the D-038 MFA reset.
 *
 * Administrators are global accounts (`administrators` is a platform table), so every read and
 * write runs on the platform connection (`inPlatform`, audited `platform:access`) with an
 * explicit organization filter where the route is tenant-scoped.
 *
 * Guards (MULTITENANCY.md §4.4, D-027, D-038):
 * - escalation: the caller must hold every permission the target holds, in the target's scopes
 *   (an operator cannot disable an organization admin; an org admin cannot touch a platform
 *   admin);
 * - an organization route may only change an administrator whose bindings all belong to that
 *   organization (a global account shared with another tenant is a platform decision);
 * - nobody changes their own status or resets their own MFA;
 * - while impersonating, administrator changes and MFA resets are refused;
 * - disabling an administrator or resetting MFA revokes all of the target's sessions.
 */
import type { DbTransaction } from '@ecloud/db';
import { ForbiddenError, NotFoundError } from '@ecloud/shared';
import { sql } from 'kysely';
import { z } from 'zod';
import { writeAudit } from '../audit.js';
import { evaluate, holdsAll } from '../auth/authorize.js';
import { loadAdminGrants } from '../auth/principal.js';
import type { AppDeps, Grant, RequestContext } from '../context.js';
import {
  IdParams,
  OrgIdParams,
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
import { inPlatform } from '../tenant.js';

const PLATFORM_TAG = ['platform'];
const ORG_TAG = ['administrators'];

const ADMIN_COLUMNS = [
  'a.id',
  'a.email',
  'a.display_name',
  'a.status',
  'a.mfa_enforced',
  'a.mfa_reenrol_required',
  'a.last_login_at',
  'a.created_at',
  'a.updated_at',
] as const;

const PlatformAdminPatch = z.strictObject({
  display_name: z.string().trim().min(1).max(200).optional(),
  status: z.enum(['active', 'disabled']).optional(),
  mfa_enforced: z.boolean().optional(),
});

const OrgAdminPatch = z.strictObject({
  display_name: z.string().trim().min(1).max(200).optional(),
  status: z.enum(['active', 'disabled']).optional(),
});

const MfaResetBody = z.strictObject({ reason: z.string().trim().min(5).max(500) });

const AdminListQuery = PaginationQuery.extend({
  status: z.enum(['invited', 'active', 'disabled']).optional(),
  q: z.string().trim().min(1).max(320).optional(),
});

type AdminRow = {
  id: string;
  email: string;
  display_name: string;
  status: 'invited' | 'active' | 'disabled';
  mfa_enforced: boolean;
  mfa_reenrol_required: boolean;
  last_login_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

function adminQuery(trx: DbTransaction) {
  return trx
    .selectFrom('administrators as a')
    .select(ADMIN_COLUMNS)
    .select((eb) =>
      eb
        .exists(
          eb
            .selectFrom('mfa_credentials as m')
            .select('m.id')
            .whereRef('m.administrator_id', '=', 'a.id')
            .where('m.verified_at', 'is not', null),
        )
        .as('mfa_enrolled'),
    )
    .where('a.deleted_at', 'is', null);
}

async function bindingsOf(trx: DbTransaction, administratorId: string, organizationId?: string) {
  let q = trx
    .selectFrom('role_bindings as rb')
    .innerJoin('roles as r', 'r.id', 'rb.role_id')
    .select([
      'rb.id',
      'rb.scope_type',
      'rb.organization_id',
      'rb.site_id',
      'rb.expires_at',
      'r.id as role_id',
      'r.key as role_key',
      'r.name as role_name',
    ])
    .where('rb.administrator_id', '=', administratorId);
  if (organizationId !== undefined) q = q.where('rb.organization_id', '=', organizationId);
  return q.orderBy('rb.created_at').execute();
}

/** Escalation guard: the caller holds every permission of every target grant, in its scope. */
function assertOutranks(ctx: RequestContext, targetGrants: readonly Grant[]): void {
  for (const g of targetGrants) {
    const target =
      g.scopeType === 'platform' ? {} : { organizationId: g.organizationId, siteId: g.siteId };
    if (!holdsAll(ctx.principal, g.permissions, target)) {
      throw new ForbiddenError({
        detail: 'You can only manage administrators whose permissions you hold in their scopes.',
      });
    }
  }
}

function callerId(ctx: RequestContext): string | null {
  return ctx.principal?.kind === 'admin' ? ctx.principal.administratorId : null;
}

function denyWhileImpersonating(ctx: RequestContext, action: string): void {
  if (ctx.principal?.kind === 'admin' && ctx.principal.impersonation !== null) {
    throw new ImpersonationForbiddenError(action);
  }
}

async function revokeAllSessions(
  trx: DbTransaction,
  administratorId: string,
  at: Date,
): Promise<number> {
  const revoked = await trx
    .updateTable('admin_sessions')
    .set({ revoked_at: at })
    .where('administrator_id', '=', administratorId)
    .where('revoked_at', 'is', null)
    .returning('id')
    .execute();
  return revoked.length;
}

interface PatchInput {
  display_name?: string | undefined;
  status?: 'active' | 'disabled' | undefined;
  mfa_enforced?: boolean | undefined;
}

/** Shared PATCH core: validates the status transition, writes, revokes sessions, audits. */
async function applyPatch(
  trx: DbTransaction,
  ctx: RequestContext,
  before: AdminRow,
  body: PatchInput,
  at: Date,
  organizationId: string | null,
): Promise<{ row: AdminRow; sessionsRevoked: number }> {
  const statusChange = body.status !== undefined && body.status !== before.status;
  if (statusChange) {
    if (before.id === callerId(ctx)) {
      throw new UnprocessableError('You cannot change the status of your own account.');
    }
    if (before.status === 'invited') {
      throw new UnprocessableError(
        'An invited administrator becomes active by accepting the invitation.',
      );
    }
  }
  const set: Record<string, unknown> = {};
  if (body.display_name !== undefined) set.display_name = body.display_name;
  if (statusChange) set.status = body.status;
  if (body.mfa_enforced !== undefined) set.mfa_enforced = body.mfa_enforced;
  let row = before;
  if (Object.keys(set).length > 0) {
    row = await trx
      .updateTable('administrators')
      .set(set)
      .where('id', '=', before.id)
      .returning([
        'id',
        'email',
        'display_name',
        'status',
        'mfa_enforced',
        'mfa_reenrol_required',
        'last_login_at',
        'created_at',
        'updated_at',
      ])
      .executeTakeFirstOrThrow();
  }
  const sessionsRevoked =
    statusChange && body.status === 'disabled' ? await revokeAllSessions(trx, before.id, at) : 0;
  await writeAudit(trx, ctx, {
    organizationId,
    action: statusChange ? 'administrator:disable' : 'administrator:update',
    targetType: 'administrator',
    targetId: before.id,
    before,
    after: { ...row, sessions_revoked: sessionsRevoked },
  });
  return { row, sessionsRevoked };
}

export function administratorRoutes(deps: AppDeps): AnyRouteSpec[] {
  const now = deps.now ?? (() => new Date());

  // ------------------------------------------------------------------------------ platform
  const platformList = defineRoute({
    method: 'get',
    path: '/api/v1/platform/administrators',
    summary: 'List all administrators (platform)',
    tags: PLATFORM_TAG,
    auth: 'principal',
    permission: 'administrator:read',
    scope: 'platform',
    query: AdminListQuery,
    responses: { 200: { description: 'Administrators', schema: PageSchema }, ...problemResponses },
    handler: async ({ query, ctx }) => {
      const cursor = decodeCursor(query.cursor);
      const rows = await inPlatform(deps, ctx, 'list administrators', async (trx) => {
        let q = adminQuery(trx).select((eb) =>
          eb
            .exists(
              eb
                .selectFrom('role_bindings as rb')
                .select('rb.id')
                .whereRef('rb.administrator_id', '=', 'a.id')
                .where('rb.scope_type', '=', 'platform'),
            )
            .as('platform_bound'),
        );
        if (query.status) q = q.where('a.status', '=', query.status);
        if (query.q) {
          q = q.where(
            sql<boolean>`a.email LIKE ${`${query.q.toLowerCase().replace(/[%_\\]/g, '\\$&')}%`}`,
          );
        }
        if (typeof cursor === 'string') q = q.where('a.id', '>', cursor);
        return q
          .orderBy('a.id')
          .limit(query.limit + 1)
          .execute();
      });
      return { status: 200, body: toPage(rows, query.limit, (r) => r.id) };
    },
  });

  const platformGet = defineRoute({
    method: 'get',
    path: '/api/v1/platform/administrators/:id',
    summary: 'Get an administrator with all role bindings (platform)',
    tags: PLATFORM_TAG,
    auth: 'principal',
    permission: 'administrator:read',
    scope: 'platform',
    params: IdParams,
    responses: {
      200: { description: 'Administrator', schema: ResourceSchema },
      ...problemResponses,
    },
    handler: async ({ params, ctx }) => {
      const body = await inPlatform(deps, ctx, 'read administrator', async (trx) => {
        const admin = await adminQuery(trx).where('a.id', '=', params.id).executeTakeFirst();
        if (admin === undefined) throw new NotFoundError('administrator', params.id);
        return { ...admin, bindings: await bindingsOf(trx, params.id) };
      });
      return { status: 200, body, headers: { ETag: etagOf(body.updated_at) } };
    },
  });

  const platformPatch = defineRoute({
    method: 'patch',
    path: '/api/v1/platform/administrators/:id',
    summary: 'Update or disable an administrator (status change needs administrator:disable)',
    tags: PLATFORM_TAG,
    auth: 'session',
    permission: 'administrator:update',
    scope: 'platform',
    params: IdParams,
    body: PlatformAdminPatch,
    responses: { 200: { description: 'Updated', schema: ResourceSchema }, ...problemResponses },
    handler: async ({ params, body, req, ctx }) => {
      denyWhileImpersonating(ctx, 'administrator:update');
      if (body.status !== undefined && !evaluate(ctx.principal, 'administrator:disable', {})) {
        throw new ForbiddenError();
      }
      const at = now();
      const result = await inPlatform(deps, ctx, 'update administrator', async (trx) => {
        const before = await trx
          .selectFrom('administrators as a')
          .select(ADMIN_COLUMNS)
          .where('a.id', '=', params.id)
          .where('a.deleted_at', 'is', null)
          .forUpdate()
          .executeTakeFirst();
        if (before === undefined) throw new NotFoundError('administrator', params.id);
        checkIfMatch(req, before.updated_at);
        assertOutranks(ctx, await loadAdminGrants(trx, params.id, at));
        return applyPatch(trx, ctx, before, body, at, null);
      });
      return {
        status: 200,
        body: { ...result.row, sessions_revoked: result.sessionsRevoked },
        headers: { ETag: etagOf(result.row.updated_at) },
      };
    },
  });

  const mfaReset = defineRoute({
    method: 'post',
    path: '/api/v1/platform/administrators/:id/mfa/reset',
    summary: 'Reset a lost MFA factor: remove credentials, revoke sessions, force re-enrolment',
    tags: PLATFORM_TAG,
    auth: 'session',
    permission: 'administrator:mfa_reset',
    scope: 'platform',
    params: IdParams,
    body: MfaResetBody,
    idempotency: 'optional',
    responses: {
      200: {
        description: 'MFA reset; the administrator must enrol a new factor at next login',
        schema: z.object({
          administrator_id: z.string(),
          mfa_reenrol_required: z.literal(true),
          credentials_removed: z.number().int(),
          sessions_revoked: z.number().int(),
        }),
      },
      ...problemResponses,
    },
    handler: async ({ params, body, ctx }) => {
      denyWhileImpersonating(ctx, 'administrator:mfa_reset');
      if (params.id === callerId(ctx)) {
        throw new UnprocessableError(
          'You cannot reset your own MFA; use a recovery code or ask another platform super admin.',
        );
      }
      const at = now();
      const result = await inPlatform(deps, ctx, `mfa reset: ${body.reason}`, async (trx) => {
        const target = await trx
          .selectFrom('administrators')
          .select(['id', 'status'])
          .where('id', '=', params.id)
          .where('deleted_at', 'is', null)
          .forUpdate()
          .executeTakeFirst();
        if (target === undefined) throw new NotFoundError('administrator', params.id);
        assertOutranks(ctx, await loadAdminGrants(trx, params.id, at));
        const removed = await trx
          .deleteFrom('mfa_credentials')
          .where('administrator_id', '=', params.id)
          .returning('id')
          .execute();
        await trx
          .updateTable('administrators')
          .set({ mfa_reenrol_required: true })
          .where('id', '=', params.id)
          .execute();
        const sessionsRevoked = await revokeAllSessions(trx, params.id, at);
        await writeAudit(trx, ctx, {
          organizationId: null,
          action: 'administrator:mfa_reset',
          targetType: 'administrator',
          targetId: params.id,
          after: {
            reason: body.reason,
            credentials_removed: removed.length,
            sessions_revoked: sessionsRevoked,
            mfa_reenrol_required: true,
          },
        });
        return { credentials_removed: removed.length, sessions_revoked: sessionsRevoked };
      });
      return {
        status: 200,
        body: { administrator_id: params.id, mfa_reenrol_required: true, ...result },
      };
    },
  });

  // -------------------------------------------------------------------------- organization
  async function loadOrgAdmin(trx: DbTransaction, orgId: string, id: string, lock: boolean) {
    let q = trx
      .selectFrom('administrators as a')
      .select(ADMIN_COLUMNS)
      .where('a.id', '=', id)
      .where('a.deleted_at', 'is', null)
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom('role_bindings as rb')
            .select('rb.id')
            .whereRef('rb.administrator_id', '=', 'a.id')
            .where('rb.organization_id', '=', orgId),
        ),
      );
    if (lock) q = q.forUpdate();
    const row = await q.executeTakeFirst();
    // No binding in this organization → not visible from it (no existence leak, G9).
    if (row === undefined) throw new NotFoundError('administrator', id);
    return row;
  }

  const orgGet = defineRoute({
    method: 'get',
    path: '/api/v1/orgs/:orgId/administrators/:id',
    summary: 'Get an administrator of this organization with its bindings here',
    tags: ORG_TAG,
    auth: 'principal',
    permission: 'administrator:read',
    scope: 'organization',
    params: OrgIdParams,
    responses: {
      200: { description: 'Administrator', schema: ResourceSchema },
      ...problemResponses,
    },
    handler: async ({ params, ctx }) => {
      const body = await inPlatform(
        deps,
        ctx,
        'read organization administrator',
        async (trx) => {
          const admin = await loadOrgAdmin(trx, params.orgId, params.id, false);
          const mfa = await trx
            .selectFrom('mfa_credentials')
            .select('id')
            .where('administrator_id', '=', params.id)
            .where('verified_at', 'is not', null)
            .executeTakeFirst();
          return {
            ...admin,
            mfa_enrolled: mfa !== undefined,
            bindings: await bindingsOf(trx, params.id, params.orgId),
          };
        },
        params.orgId,
      );
      return { status: 200, body, headers: { ETag: etagOf(body.updated_at) } };
    },
  });

  const orgPatch = defineRoute({
    method: 'patch',
    path: '/api/v1/orgs/:orgId/administrators/:id',
    summary:
      'Update or disable an administrator bound only to this organization ' +
      '(status change needs administrator:disable)',
    tags: ORG_TAG,
    auth: 'session',
    permission: 'administrator:update',
    scope: 'organization',
    params: OrgIdParams,
    body: OrgAdminPatch,
    responses: { 200: { description: 'Updated', schema: ResourceSchema }, ...problemResponses },
    handler: async ({ params, body, req, ctx }) => {
      denyWhileImpersonating(ctx, 'administrator:update');
      if (
        body.status !== undefined &&
        !evaluate(ctx.principal, 'administrator:disable', { organizationId: params.orgId })
      ) {
        throw new ForbiddenError();
      }
      const at = now();
      const result = await inPlatform(
        deps,
        ctx,
        'update organization administrator',
        async (trx) => {
          const before = await loadOrgAdmin(trx, params.orgId, params.id, true);
          checkIfMatch(req, before.updated_at);
          const grants = await loadAdminGrants(trx, params.id, at);
          const foreign = await trx
            .selectFrom('role_bindings')
            .select('id')
            .where('administrator_id', '=', params.id)
            .where((eb) =>
              eb.or([eb('organization_id', 'is', null), eb('organization_id', '!=', params.orgId)]),
            )
            .executeTakeFirst();
          if (foreign !== undefined) {
            throw new ForbiddenError({
              detail:
                'This administrator also holds bindings outside this organization; ' +
                'ask a platform administrator.',
            });
          }
          assertOutranks(ctx, grants);
          return applyPatch(trx, ctx, before, body, at, params.orgId);
        },
        params.orgId,
      );
      return {
        status: 200,
        body: { ...result.row, sessions_revoked: result.sessionsRevoked },
        headers: { ETag: etagOf(result.row.updated_at) },
      };
    },
  });

  return [platformList, platformGet, platformPatch, mfaReset, orgGet, orgPatch];
}
