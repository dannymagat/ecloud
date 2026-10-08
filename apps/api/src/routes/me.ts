/**
 * Self-service session management (API_ARCHITECTURE.md §3.2 "Auth & self"): an administrator
 * lists their own live admin sessions and revokes any of them (e.g. a forgotten browser).
 * Scope-less: only the caller's own rows are ever visible. Token hashes are never returned.
 */
import { withPlatform } from '@ecloud/db';
import { NotFoundError } from '@ecloud/shared';
import { z } from 'zod';
import { writeAudit } from '../audit.js';
import { clearSessionCookie } from '../auth/middleware.js';
import { AUTHN_ACCESS } from '../auth/principal.js';
import type { AppDeps, Principal } from '../context.js';
import { IdParams, problemResponses } from '../http/common.js';
import { defineRoute, type AnyRouteSpec } from '../http/route.js';

const TAG = ['auth'];

const SessionView = z.object({
  id: z.string(),
  current: z.boolean(),
  created_at: z.string(),
  last_seen_at: z.string().nullable(),
  expires_at: z.string(),
  ip: z.string().nullable(),
  user_agent: z.string().nullable(),
  impersonating_organization_id: z.string().nullable(),
  mfa_verified: z.boolean(),
});

export function meRoutes(deps: AppDeps): AnyRouteSpec[] {
  const now = deps.now ?? (() => new Date());

  const list = defineRoute({
    method: 'get',
    path: '/api/v1/me/sessions',
    summary: 'List my live admin sessions',
    tags: TAG,
    auth: 'session',
    responses: {
      200: {
        description: 'Sessions (newest first)',
        schema: z.object({ data: z.array(SessionView) }),
      },
      ...problemResponses,
    },
    handler: async ({ ctx }) => {
      const principal = ctx.principal as Extract<Principal, { kind: 'admin' }>;
      const at = now();
      const rows = await withPlatform(deps.dbPlatform, AUTHN_ACCESS, (trx) =>
        trx
          .selectFrom('admin_sessions')
          .select([
            'id',
            'created_at',
            'last_seen_at',
            'expires_at',
            'ip',
            'user_agent',
            'impersonating_organization_id',
            'mfa_verified_at',
          ])
          .where('administrator_id', '=', principal.administratorId)
          .where('revoked_at', 'is', null)
          .where('expires_at', '>', at)
          .orderBy('created_at', 'desc')
          .limit(200)
          .execute(),
      );
      const idleMs = deps.config.session.idleSeconds * 1000;
      const data = rows
        .filter((r) => (r.last_seen_at ?? r.created_at).getTime() + idleMs > at.getTime())
        .map((r) => ({
          id: r.id,
          current: r.id === principal.sessionId,
          created_at: r.created_at.toISOString(),
          last_seen_at: r.last_seen_at?.toISOString() ?? null,
          expires_at: r.expires_at.toISOString(),
          ip: r.ip,
          user_agent: r.user_agent,
          impersonating_organization_id: r.impersonating_organization_id,
          mfa_verified: r.mfa_verified_at !== null,
        }));
      return { status: 200, body: { data } };
    },
  });

  const revoke = defineRoute({
    method: 'delete',
    path: '/api/v1/me/sessions/:id',
    summary: 'Revoke one of my sessions (the current one logs me out)',
    tags: TAG,
    auth: 'session',
    params: IdParams,
    responses: { 204: { description: 'Revoked' }, ...problemResponses },
    handler: async ({ params, res, ctx }) => {
      const principal = ctx.principal as Extract<Principal, { kind: 'admin' }>;
      const at = now();
      await withPlatform(deps.dbPlatform, AUTHN_ACCESS, async (trx) => {
        const revoked = await trx
          .updateTable('admin_sessions')
          .set({ revoked_at: at })
          .where('id', '=', params.id)
          .where('administrator_id', '=', principal.administratorId)
          .where('revoked_at', 'is', null)
          .returning('id')
          .executeTakeFirst();
        if (revoked === undefined) throw new NotFoundError('session', params.id);
        await writeAudit(trx, ctx, {
          organizationId: principal.impersonation?.organizationId ?? null,
          action: 'auth:session:revoke',
          targetType: 'admin_session',
          targetId: params.id,
          after: { current: params.id === principal.sessionId },
        });
      });
      if (params.id === principal.sessionId) clearSessionCookie(deps, res);
      return { status: 204 };
    },
  });

  return [list, revoke];
}
