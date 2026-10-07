/**
 * Tenant scoping helpers (DATABASE_DESIGN.md §8, MULTITENANCY.md §2).
 *
 * Every tenant-scoped table has FORCE ROW LEVEL SECURITY with
 *   organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid
 * so a query outside `withTenant()` on the `ecloud_app` connection returns no rows (fail closed).
 * `set_config(..., true)` is the parameterised form of `SET LOCAL`: the value lives only inside
 * the transaction, which is what keeps pooled connections (and PgBouncer transaction mode) safe.
 */
import { isUuid } from '@ecloud/shared';
import { sql } from 'kysely';
import type { Db, DbTransaction } from './client.js';
import type { AuditActorType } from './schema.js';

export const CURRENT_ORG_GUC = 'app.current_org';
export const CURRENT_SITE_GUC = 'app.current_site';

export class TenancyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TenancyError';
  }
}

/**
 * Runs `fn` inside a transaction whose RLS context is `organizationId`. All reads and writes
 * through `trx` are restricted to that tenant; inserts with a foreign `organization_id` fail.
 */
export async function withTenant<T>(
  db: Db,
  organizationId: string,
  fn: (trx: DbTransaction) => Promise<T>,
): Promise<T> {
  if (!isUuid(organizationId)) {
    throw new TenancyError('withTenant requires a UUID organizationId');
  }
  return db.transaction().execute(async (trx) => {
    await sql`SELECT set_config(${CURRENT_ORG_GUC}, ${organizationId}, true)`.execute(trx);
    return fn(trx);
  });
}

/**
 * Like {@link withTenant} and additionally publishes `app.current_site` for the duration of
 * the transaction. Site is NOT an RLS boundary (MULTITENANCY.md §4.4: site bindings are
 * enforced by the authorization layer); the GUC is informational for triggers/diagnostics.
 */
export async function withSite<T>(
  db: Db,
  organizationId: string,
  siteId: string,
  fn: (trx: DbTransaction) => Promise<T>,
): Promise<T> {
  if (!isUuid(siteId)) throw new TenancyError('withSite requires a UUID siteId');
  return withTenant(db, organizationId, async (trx) => {
    await sql`SELECT set_config(${CURRENT_SITE_GUC}, ${siteId}, true)`.execute(trx);
    return fn(trx);
  });
}

export interface PlatformAccess {
  /** Why this work needs cross-tenant visibility (stored in audit_logs.after.reason). */
  reason: string;
  actorType?: AuditActorType;
  actorId?: string | null;
  /** The tenant being inspected, when there is one (platform support inspecting org X). */
  organizationId?: string | null;
  requestId?: string | null;
  ip?: string | null;
  /**
   * Write the `platform:access` audit row (default true). Pass `false` only for high-frequency
   * system paths that are audited elsewhere (e.g. the accounting drain loop) — never for a
   * human-initiated action.
   */
  audit?: boolean;
}

const bypassChecked = new WeakMap<Db, Promise<void>>();

async function assertBypassRls(db: Db): Promise<void> {
  let pending = bypassChecked.get(db);
  if (pending === undefined) {
    pending = (async () => {
      const result = await sql<{ rolbypassrls: boolean }>`
        SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user
      `.execute(db);
      if (result.rows[0]?.rolbypassrls !== true) {
        throw new TenancyError(
          'withPlatform requires a BYPASSRLS connection (DATABASE_URL_PLATFORM); the current role is subject to RLS',
        );
      }
    })();
    bypassChecked.set(db, pending);
    pending.catch(() => bypassChecked.delete(db));
  }
  await pending;
}

/**
 * Runs `fn` on the platform (BYPASSRLS) connection with no tenant filter. Refuses to run on an
 * RLS-enforced connection. Writes an `audit_logs` row (`actor_type` default `system`,
 * `action = 'platform:access'`) in the same transaction unless `audit: false`.
 */
export async function withPlatform<T>(
  dbPlatform: Db,
  access: PlatformAccess,
  fn: (trx: DbTransaction) => Promise<T>,
): Promise<T> {
  if (access.reason.trim() === '') throw new TenancyError('withPlatform requires a reason');
  if (
    access.organizationId !== undefined &&
    access.organizationId !== null &&
    !isUuid(access.organizationId)
  ) {
    throw new TenancyError('withPlatform organizationId must be a UUID');
  }
  await assertBypassRls(dbPlatform);
  return dbPlatform.transaction().execute(async (trx) => {
    // Make sure no tenant GUC leaks in from a misconfigured pool; platform work is unscoped.
    await sql`SELECT set_config(${CURRENT_ORG_GUC}, '', true)`.execute(trx);
    if (access.audit !== false) {
      await trx
        .insertInto('audit_logs')
        .values({
          organization_id: access.organizationId ?? null,
          actor_type: access.actorType ?? 'system',
          actor_id: access.actorId ?? null,
          action: 'platform:access',
          target_type: access.organizationId ? 'organization' : null,
          target_id: access.organizationId ?? null,
          after: { reason: access.reason },
          request_id: access.requestId ?? null,
          ip: access.ip ?? null,
        })
        .execute();
    }
    return fn(trx);
  });
}
