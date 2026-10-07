import {
  configureTypeParsers,
  discoverMigrations,
  pgExecutor,
  runMigrations,
  seedCatalogue,
  type MigrationResult,
} from '@ecloud/db';
import pg from 'pg';
import { TEST_DATABASE_URL_ENV, getTestDatabaseUrl } from './integration.js';

/** Optional explicit RLS-enforced (`ecloud_app`) URL for the test database. */
export const TEST_APP_DATABASE_URL_ENV = 'ECLOUD_TEST_APP_DATABASE_URL';
export const TEST_APP_ROLE = 'ecloud_app';

/**
 * URL to connect to the test database as the RLS-enforced application role: the explicit
 * `ECLOUD_TEST_APP_DATABASE_URL`, or `ECLOUD_TEST_DATABASE_URL` with the username replaced by
 * `ecloud_app` (the dev stack gives both roles the same dev-only password).
 */
export function getTestAppDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const explicit = env[TEST_APP_DATABASE_URL_ENV]?.trim();
  if (explicit !== undefined && explicit !== '') return explicit;
  const platform = getTestDatabaseUrl(env);
  if (platform === undefined) return undefined;
  try {
    const url = new URL(platform);
    url.username = TEST_APP_ROLE;
    return url.toString();
  } catch {
    return undefined;
  }
}

export interface MigrateTestDatabaseOptions {
  env?: NodeJS.ProcessEnv;
  /**
   * Drop and recreate the `public` and `radius` schemas first. ONLY for the schema suite of
   * @ecloud/db: other suites share the database and must not reset it.
   */
  reset?: boolean;
  /** Run `seedCatalogue` after migrating (default true). */
  seed?: boolean;
}

export interface MigrateTestDatabaseResult {
  databaseUrl: string;
  results: MigrationResult[];
  applied: number;
  seeded: boolean;
  reset: boolean;
}

const RESET_SQL = `
DROP SCHEMA IF EXISTS radius CASCADE;
DROP SCHEMA IF EXISTS public CASCADE;
CREATE SCHEMA public;
`;

const memo = new Map<string, Promise<MigrateTestDatabaseResult>>();

/**
 * Brings `ECLOUD_TEST_DATABASE_URL` to the current schema (all migrations + seed) once per
 * test process; concurrent workers are serialised by the runner's advisory lock. Throws when
 * the variable is unset — call it only inside a `describeIntegration` suite.
 */
export function migrateTestDatabase(
  options: MigrateTestDatabaseOptions = {},
): Promise<MigrateTestDatabaseResult> {
  const env = options.env ?? process.env;
  const databaseUrl = getTestDatabaseUrl(env);
  if (databaseUrl === undefined) {
    throw new Error(
      `${TEST_DATABASE_URL_ENV} is not set; migrateTestDatabase() needs the dev stack`,
    );
  }
  const reset = options.reset === true;
  const seed = options.seed !== false;
  const key = `${databaseUrl}|${String(reset)}|${String(seed)}`;
  let pending = memo.get(key);
  if (pending === undefined) {
    pending = migrateOnce(databaseUrl, reset, seed);
    memo.set(key, pending);
    pending.catch(() => memo.delete(key));
  }
  return pending;
}

async function migrateOnce(
  databaseUrl: string,
  reset: boolean,
  seed: boolean,
): Promise<MigrateTestDatabaseResult> {
  configureTypeParsers();
  const client = new pg.Client({
    connectionString: databaseUrl,
    application_name: 'ecloud-test-migrate',
  });
  await client.connect();
  try {
    const exec = pgExecutor(client);
    if (reset) await client.query(RESET_SQL);
    const results = await runMigrations(exec, discoverMigrations(), { actor: 'ecloud-test' });
    if (seed) await seedCatalogue(exec);
    return {
      databaseUrl,
      results,
      applied: results.filter((r) => r.state === 'applied').length,
      seeded: seed,
      reset,
    };
  } finally {
    await client.end();
  }
}
