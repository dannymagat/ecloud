/**
 * Test dependency builders. Unit tests get a database handle pointing at a closed port (every
 * query fails fast, which is exactly the "backend unavailable" path); integration tests get the
 * dev-stack `ecloud_test` database through the RLS app role and the platform role.
 */
import { createDb, hashPassword, type Db } from '@ecloud/db';
import { createLogger, newId } from '@ecloud/shared';
import { getTestAppDatabaseUrl, getTestDatabaseUrl } from '@ecloud/testing';
import { sql } from 'kysely';
import { loadApiConfig, type ApiConfig } from '../config.js';
import type { AppDeps } from '../context.js';
import { MemoryKv } from '../kv.js';

export const TEST_ORIGIN = 'http://admin.test.local';
export const TEST_INTERNAL_TOKEN = 'test_internal_token_0123456789abcdef';

export function testConfig(overrides: Record<string, string> = {}): ApiConfig {
  return loadApiConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    KV_DRIVER: 'memory',
    PUBLIC_ADMIN_ORIGIN: TEST_ORIGIN,
    INTERNAL_API_TOKEN: TEST_INTERNAL_TOKEN,
    ARGON2_MEMORY_KIB: '8192',
    // D-046: the test suites exercise the MFA flows (the pre-D-046 behaviour); the production
    // default is `off`. Tests of the off mode override this.
    ADMIN_MFA_MODE: 'required',
    DATABASE_URL: 'postgres://nobody:nothing@127.0.0.1:1/none',
    DATABASE_URL_PLATFORM: 'postgres://nobody:nothing@127.0.0.1:1/none',
    ...overrides,
  });
}

export function unitDeps(overrides: Partial<AppDeps> = {}): AppDeps {
  const config = testConfig();
  return {
    config,
    logger: createLogger({ name: 'api-test', level: 'silent' }),
    db: createDb(config.base.database.url, { connectionTimeoutMillis: 200, max: 1 }),
    dbPlatform: createDb(config.base.database.platformUrl, {
      connectionTimeoutMillis: 200,
      max: 1,
    }),
    kv: new MemoryKv(),
    ...overrides,
  };
}

export function integrationDeps(): AppDeps {
  const platformUrl = getTestDatabaseUrl();
  const appUrl = getTestAppDatabaseUrl();
  if (platformUrl === undefined || appUrl === undefined) {
    throw new Error('ECLOUD_TEST_DATABASE_URL is required for integration deps');
  }
  const config = testConfig({ DATABASE_URL: appUrl, DATABASE_URL_PLATFORM: platformUrl });
  return {
    config,
    logger: createLogger({ name: 'api-itest', level: 'silent' }),
    db: createDb(appUrl, { max: 5, applicationName: 'ecloud-api-itest' }),
    dbPlatform: createDb(platformUrl, { max: 5, applicationName: 'ecloud-api-itest-platform' }),
    kv: new MemoryKv(),
  };
}

export async function closeDeps(deps: AppDeps): Promise<void> {
  await Promise.allSettled([deps.db.destroy(), deps.dbPlatform.destroy(), deps.kv.close()]);
}

let counter = 0;
export function unique(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${String(counter)}-${Math.random().toString(36).slice(2, 6)}`;
}

export async function templateRoleId(db: Db, key: string): Promise<string> {
  const row = await db
    .selectFrom('roles')
    .select('id')
    .where('key', '=', key)
    .where('organization_id', 'is', null)
    .executeTakeFirstOrThrow();
  return row.id;
}

/** Creates organization + site through the platform connection. */
export async function createTenant(
  db: Db,
): Promise<{ orgId: string; siteId: string; siteId2: string }> {
  const orgId = newId();
  const siteId = newId();
  const siteId2 = newId();
  await db
    .insertInto('organizations')
    .values({ id: orgId, slug: unique('org').toLowerCase().slice(0, 60), name: 'Test Org' })
    .execute();
  await db
    .insertInto('sites')
    .values([
      {
        id: siteId,
        organization_id: orgId,
        slug: 'site-a',
        name: 'Site A',
        timezone: 'Asia/Dubai',
      },
      { id: siteId2, organization_id: orgId, slug: 'site-b', name: 'Site B', timezone: 'UTC' },
    ])
    .execute();
  return { orgId, siteId, siteId2 };
}

export interface AdminFixture {
  id: string;
  email: string;
  password: string;
}

const PASSWORD = 'correct horse battery staple 42';
let cachedHash: Promise<string> | undefined;

export async function createAdmin(
  db: Db,
  bindings: {
    template: string;
    scope: 'platform' | 'organization' | 'site';
    orgId?: string;
    siteId?: string;
  }[],
): Promise<AdminFixture> {
  cachedHash ??= hashPassword(PASSWORD, { memoryKib: 8192 });
  const id = newId();
  const email = `${unique('admin')}@example.test`.toLowerCase();
  await db
    .insertInto('administrators')
    .values({
      id,
      email,
      display_name: 'Test Admin',
      password_hash: await cachedHash,
      status: 'active',
    })
    .execute();
  for (const b of bindings) {
    await db
      .insertInto('role_bindings')
      .values({
        id: newId(),
        administrator_id: id,
        role_id: await templateRoleId(db, b.template),
        scope_type: b.scope,
        organization_id: b.scope === 'platform' ? null : (b.orgId ?? null),
        site_id: b.scope === 'site' ? (b.siteId ?? null) : null,
      })
      .execute();
  }
  return { id, email, password: PASSWORD };
}

export async function countAudit(db: Db, action: string, targetId: string): Promise<number> {
  const result = await sql<{ n: number }>`
    SELECT count(*)::int AS n FROM audit_logs WHERE action = ${action} AND target_id = ${targetId}
  `.execute(db);
  return result.rows[0]?.n ?? 0;
}
