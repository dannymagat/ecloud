import { getTestDatabaseUrl } from './integration.js';

/** Optional explicit URL for the FreeRADIUS role (`ecloud_radius`) on the test database. */
export const TEST_RADIUS_ROLE_DATABASE_URL_ENV = 'ECLOUD_TEST_RADIUS_ROLE_DATABASE_URL';
export const TEST_RADIUS_ROLE = 'ecloud_radius';

/** Returns `url` with the user name replaced (password and everything else kept). */
export function withDatabaseUser(url: string, user: string): string {
  const parsed = new URL(url);
  parsed.username = user;
  return parsed.toString();
}

/** Returns `url` pointing at database `name` (credentials kept). */
export function withDatabaseName(url: string, name: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${encodeURIComponent(name)}`;
  return parsed.toString();
}

/**
 * URL for the `ecloud_radius` role on the test database: the explicit
 * `ECLOUD_TEST_RADIUS_ROLE_DATABASE_URL`, or `ECLOUD_TEST_DATABASE_URL` with the user name
 * replaced (the dev stack and CI give all ECLOUD roles the same dev-only password).
 */
export function getTestRadiusRoleDatabaseUrl(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const explicit = env[TEST_RADIUS_ROLE_DATABASE_URL_ENV]?.trim();
  if (explicit !== undefined && explicit !== '') return explicit;
  const platform = getTestDatabaseUrl(env);
  if (platform === undefined) return undefined;
  try {
    return withDatabaseUser(platform, TEST_RADIUS_ROLE);
  } catch {
    return undefined;
  }
}
