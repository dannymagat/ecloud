/**
 * Runtime read endpoints: the organization audit log. (Sessions moved to routes/sessions.ts in
 * P8-A.)
 */
import { z } from 'zod';
import type { AppDeps } from '../context.js';
import {
  OrgParams,
  PageSchema,
  PaginationQuery,
  decodeCursor,
  problemResponses,
  toPage,
} from '../http/common.js';
import { defineRoute, type AnyRouteSpec } from '../http/route.js';
import { inTenant } from '../tenant.js';

export function runtimeRoutes(deps: AppDeps): AnyRouteSpec[] {
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

  return [auditLog];
}
