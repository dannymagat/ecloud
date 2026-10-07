/**
 * Shared database context for the cross-package integration suites. Connects to the test
 * database twice: as the platform role (`ECLOUD_TEST_DATABASE_URL`, BYPASSRLS, owner) and as
 * the RLS-enforced application role (`ECLOUD_TEST_APP_DATABASE_URL` or derived `ecloud_app`).
 * Migrates (idempotently, never with `reset`) and seeds the catalogue first.
 */
import { createDb, createPool, type Db } from '@ecloud/db';
import { getTestAppDatabaseUrl, migrateTestDatabase } from '@ecloud/testing';
import type pg from 'pg';

export interface TestDatabases {
  databaseUrl: string;
  appUrl: string;
  platformPool: pg.Pool;
  appPool: pg.Pool;
  platform: Db;
  app: Db;
  close(): Promise<void>;
}

export async function openTestDatabases(name: string): Promise<TestDatabases> {
  const { databaseUrl } = await migrateTestDatabase();
  const appUrl = getTestAppDatabaseUrl();
  if (appUrl === undefined) throw new Error('no ecloud_app URL for the test database');
  const platformPool = createPool(databaseUrl, { max: 4, applicationName: `${name}-platform` });
  const appPool = createPool(appUrl, { max: 4, applicationName: `${name}-app` });
  const platform = createDb(platformPool);
  const app = createDb(appPool);
  return {
    databaseUrl,
    appUrl,
    platformPool,
    appPool,
    platform,
    app,
    async close() {
      // Kysely.destroy() ends the underlying pools.
      await platform.destroy();
      await app.destroy();
    },
  };
}

/**
 * Runs `fn` on one connection inside a transaction that is ALWAYS rolled back. When
 * `organizationId` is given the transaction-local `app.current_org` is set first (the same
 * statement withTenant() issues). Used for probes that might succeed against a gap and must
 * never leave changes behind on the shared test database.
 */
export async function inRolledBackTransaction<T>(
  pool: pg.Pool,
  organizationId: string | null,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (organizationId !== null) {
      await client.query("SELECT set_config('app.current_org', $1, true)", [organizationId]);
    }
    return await fn(client);
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

/** `SELECT count(*)::int AS n ...` helper on a pg queryable. */
export async function countOf(
  db: { query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }> },
  text: string,
  values: unknown[] = [],
): Promise<number> {
  const result = await db.query(text, values);
  const row = result.rows[0] as { n?: number | string } | undefined;
  return Number(row?.n ?? Number.NaN);
}
