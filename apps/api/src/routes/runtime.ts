/**
 * Runtime read endpoints: sessions and the organization audit log.
 */
import { NotFoundError } from '@ecloud/shared';
import { z } from 'zod';
import { permittedSites } from '../auth/authorize.js';
import type { AppDeps } from '../context.js';
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
import { defineRoute, type AnyRouteSpec } from '../http/route.js';
import { inTenant, requireOnSite } from '../tenant.js';

export function runtimeRoutes(deps: AppDeps): AnyRouteSpec[] {
  const sessions = defineRoute({
    method: 'get',
    path: '/api/v1/orgs/:orgId/sessions',
    summary: 'List sessions (newest first)',
    tags: ['sessions'],
    auth: 'principal',
    permission: 'session:read',
    scope: 'any-site',
    params: OrgParams,
    query: PaginationQuery.extend({
      status: z.enum(['active', 'stopped', 'stale']).optional(),
      site_id: z.uuid().optional(),
      user_id: z.uuid().optional(),
      nas_client_id: z.uuid().optional(),
    }),
    responses: { 200: { description: 'Sessions', schema: PageSchema }, ...problemResponses },
    handler: async ({ params, query, ctx }) => {
      const sites = permittedSites(ctx.principal, 'session:read', params.orgId);
      const cursor = decodeCursor(query.cursor);
      const rows = await inTenant(deps, params.orgId, (trx) => {
        let q = trx
          .selectFrom('sessions as s')
          .leftJoin('nas_clients as n', 'n.id', 's.nas_client_id')
          .leftJoin('policies as p', 'p.id', 's.policy_id')
          .selectAll('s')
          .select(['n.name as nas_name', 'n.coa_supported', 'p.name as policy_name']);
        if (sites !== 'all') {
          if (sites.length === 0) return Promise.resolve([]);
          q = q.where('s.site_id', 'in', sites);
        }
        if (query.status) q = q.where('s.status', '=', query.status);
        if (query.site_id) q = q.where('s.site_id', '=', query.site_id);
        if (query.user_id) q = q.where('s.user_id', '=', query.user_id);
        if (query.nas_client_id) q = q.where('s.nas_client_id', '=', query.nas_client_id);
        if (typeof cursor === 'string') q = q.where('s.id', '<', cursor);
        return q
          .orderBy('s.id', 'desc')
          .limit(query.limit + 1)
          .execute();
      });
      return { status: 200, body: toPage(rows, query.limit, (r) => r.id) };
    },
  });

  const session = defineRoute({
    method: 'get',
    path: '/api/v1/orgs/:orgId/sessions/:id',
    summary: 'Get a session with its actions',
    tags: ['sessions'],
    auth: 'principal',
    permission: 'session:read',
    scope: 'any-site',
    params: OrgIdParams,
    responses: { 200: { description: 'Session', schema: ResourceSchema }, ...problemResponses },
    handler: async ({ params, ctx }) => {
      const body = await inTenant(deps, params.orgId, async (trx) => {
        const row = await trx
          .selectFrom('sessions')
          .selectAll()
          .where('id', '=', params.id)
          .executeTakeFirst();
        if (row === undefined) throw new NotFoundError('session', params.id);
        requireOnSite(ctx, 'session:read', params.orgId, row.site_id, 'session');
        const actions = await trx
          .selectFrom('session_actions')
          .selectAll()
          .where('session_id', '=', params.id)
          .orderBy('created_at')
          .execute();
        return { ...row, session_actions: actions };
      });
      return { status: 200, body };
    },
  });

  const auditLog = defineRoute({
    method: 'get',
    path: '/api/v1/orgs/:orgId/audit-log',
    summary: 'Organization audit log (includes impersonation rows)',
    tags: ['audit'],
    auth: 'principal',
    permission: 'audit_log:read',
    scope: 'organization',
    params: OrgParams,
    query: PaginationQuery.extend({
      action: z.string().max(100).optional(),
      actor_id: z.uuid().optional(),
      target_id: z.uuid().optional(),
      from: z.iso.datetime({ offset: true }).optional(),
      to: z.iso.datetime({ offset: true }).optional(),
    }),
    responses: {
      200: { description: 'Audit rows (newest first)', schema: PageSchema },
      ...problemResponses,
    },
    handler: async ({ params, query }) => {
      const cursor = decodeCursor(query.cursor);
      const rows = await inTenant(deps, params.orgId, (trx) => {
        let q = trx.selectFrom('audit_logs').selectAll();
        if (query.action) q = q.where('action', '=', query.action);
        if (query.actor_id) q = q.where('actor_id', '=', query.actor_id);
        if (query.target_id) q = q.where('target_id', '=', query.target_id);
        if (query.from) q = q.where('created_at', '>=', new Date(query.from));
        if (query.to) q = q.where('created_at', '<', new Date(query.to));
        if (typeof cursor === 'number') q = q.where('id', '<', cursor);
        return q
          .orderBy('id', 'desc')
          .limit(query.limit + 1)
          .execute();
      });
      return { status: 200, body: toPage(rows, query.limit, (r) => r.id) };
    },
  });

  return [sessions, session, auditLog];
}
