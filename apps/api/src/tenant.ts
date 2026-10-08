/**
 * Tenant execution helpers (API_ARCHITECTURE.md §4 "Permission middleware"): handlers of
 * `/orgs/{orgId}/…` run inside `withTenant(db, orgId)` so RLS is the second lock; platform
 * handlers use `withPlatform(dbPlatform, {reason, …})` which audits the access.
 */
import { withPlatform, withTenant, type DbTransaction } from '@ecloud/db';
import { ForbiddenError, NotFoundError } from '@ecloud/shared';
import { sql } from 'kysely';
import { evaluate } from './auth/authorize.js';
import type { AppDeps, RequestContext } from './context.js';

export function inTenant<T>(
  deps: AppDeps,
  organizationId: string,
  fn: (trx: DbTransaction) => Promise<T>,
): Promise<T> {
  return withTenant(deps.db, organizationId, fn);
}

export function inPlatform<T>(
  deps: AppDeps,
  ctx: RequestContext,
  reason: string,
  fn: (trx: DbTransaction) => Promise<T>,
  organizationId?: string | null,
): Promise<T> {
  const p = ctx.principal;
  return withPlatform(
    deps.dbPlatform,
    {
      reason,
      actorType: p === null ? 'system' : p.kind === 'admin' ? 'administrator' : 'api_key',
      actorId: p === null ? null : p.kind === 'admin' ? p.administratorId : p.apiKeyId,
      organizationId: organizationId ?? null,
      requestId: ctx.requestId,
      ip: ctx.ip,
    },
    fn,
  );
}

/**
 * Object-level check for site-scoped rows: `siteId` null means an organization-level object,
 * which needs an organization (or platform) grant. Unreadable objects are reported as 404 so
 * their existence does not leak (MULTITENANCY.md §5 G9); a readable object the principal may
 * not change is 403.
 */
export function requireOnSite(
  ctx: RequestContext,
  permission: string,
  organizationId: string,
  siteId: string | null,
  resource: string,
  readPermission?: string,
): void {
  const target = { organizationId, siteId };
  if (evaluate(ctx.principal, permission, target)) return;
  if (readPermission !== undefined && evaluate(ctx.principal, readPermission, target)) {
    throw new ForbiddenError();
  }
  throw new NotFoundError(resource);
}

type RefTable =
  | 'sites'
  | 'users'
  | 'user_groups'
  | 'client_devices'
  | 'policies'
  | 'schedules'
  | 'voucher_batches'
  | 'network_devices'
  | 'nas_clients'
  | 'controllers'
  | 'identity_providers';

const SOFT_DELETE: ReadonlySet<RefTable> = new Set([
  'sites',
  'users',
  'client_devices',
  'policies',
  'network_devices',
  'nas_clients',
  'controllers',
]);

/**
 * G9: every foreign key supplied in a request is re-checked inside the tenant transaction.
 * Postgres FK checks ignore RLS, so without this a tenant could reference another tenant's row.
 * Returns the row's `site_id` when the table has one.
 */
export async function assertRef(
  trx: DbTransaction,
  table: RefTable,
  id: string,
  resource: string,
): Promise<{ site_id: string | null }> {
  const softDelete = SOFT_DELETE.has(table) ? sql`AND deleted_at IS NULL` : sql``;
  const hasSite = !['client_devices', 'schedules', 'identity_providers'].includes(table);
  const siteColumn = table === 'sites' ? sql`id` : hasSite ? sql`site_id` : sql`NULL::uuid`;
  const result = await sql<{ site_id: string | null }>`
    SELECT ${siteColumn} AS site_id FROM ${sql.table(table)}
    WHERE id = ${id} AND organization_id = current_setting('app.current_org', true)::uuid ${softDelete}
  `.execute(trx);
  const row = result.rows[0];
  if (row === undefined) throw new NotFoundError(resource, id);
  return row;
}
