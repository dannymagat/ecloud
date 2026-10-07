import { Socket } from 'node:net';
import { describe } from 'vitest';

export const TEST_DATABASE_URL_ENV = 'ECLOUD_TEST_DATABASE_URL';
export const TEST_REDIS_URL_ENV = 'ECLOUD_TEST_REDIS_URL';
/** When `1`, integration suites fail instead of skipping (used by `npm run test:integration` / CI). */
export const REQUIRE_INTEGRATION_ENV = 'ECLOUD_TEST_REQUIRE_INTEGRATION';

export const DEFAULT_PROBE_TIMEOUT_MS = 500;

/** Returns `ECLOUD_TEST_DATABASE_URL` or `undefined` when unset/blank. */
export function getTestDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = env[TEST_DATABASE_URL_ENV]?.trim();
  return value === undefined || value === '' ? undefined : value;
}

/** Returns `ECLOUD_TEST_REDIS_URL` or `undefined` when unset/blank. */
export function getTestRedisUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = env[TEST_REDIS_URL_ENV]?.trim();
  return value === undefined || value === '' ? undefined : value;
}

export interface HostPort {
  host: string;
  port: number;
}

const DEFAULT_PORTS: Readonly<Record<string, number>> = {
  'postgres:': 5432,
  'postgresql:': 5432,
  'redis:': 6379,
  'rediss:': 6379,
};

/** Extracts host and port from a connection URL; returns `undefined` when unparsable. */
export function hostPortFromUrl(url: string): HostPort | undefined {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^\[|\]$/g, '');
    const port = parsed.port !== '' ? Number(parsed.port) : DEFAULT_PORTS[parsed.protocol];
    if (host === '' || port === undefined || !Number.isInteger(port)) return undefined;
    return { host, port };
  } catch {
    return undefined;
  }
}

/** Resolves `true` when a TCP connection to host:port succeeds within `timeoutMs`. */
export function canConnect(
  { host, port }: HostPort,
  timeoutMs: number = DEFAULT_PROBE_TIMEOUT_MS,
): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new Socket();
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(port, host);
  });
}

export type IntegrationProbe =
  | { ok: true; databaseUrl: string }
  | { ok: false; reason: string; databaseUrl: string | undefined };

/**
 * Decides whether integration tests can run: the env variable must be set and the database
 * host must accept a TCP connection within `timeoutMs`.
 */
export async function probeIntegration(
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs: number = DEFAULT_PROBE_TIMEOUT_MS,
): Promise<IntegrationProbe> {
  const databaseUrl = getTestDatabaseUrl(env);
  if (databaseUrl === undefined) {
    return {
      ok: false,
      databaseUrl,
      reason: `${TEST_DATABASE_URL_ENV} is not set (start the dev stack with \`npm run dev:stack\` and export it)`,
    };
  }
  const target = hostPortFromUrl(databaseUrl);
  if (target === undefined) {
    return { ok: false, databaseUrl, reason: `${TEST_DATABASE_URL_ENV} is not a valid URL` };
  }
  if (!(await canConnect(target, timeoutMs))) {
    return {
      ok: false,
      databaseUrl,
      reason: `database at ${target.host}:${String(target.port)} not reachable within ${String(timeoutMs)} ms`,
    };
  }
  return { ok: true, databaseUrl };
}

/**
 * Registers an integration suite. Use with top-level `await` in the test file:
 *
 *   await describeIntegration('sessions repository', () => { ... });
 *
 * When the database is unavailable the suite is registered with `describe.skip` and a
 * message explaining why. When `ECLOUD_TEST_REQUIRE_INTEGRATION=1` (CI integration job),
 * an unavailable database is a failure instead of a skip.
 */
export async function describeIntegration(
  name: string,
  factory: () => void | Promise<void>,
  options: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<IntegrationProbe> {
  const env = options.env ?? process.env;
  const probe = await probeIntegration(env, options.timeoutMs);
  if (probe.ok) {
    describe(name, factory);
    return probe;
  }
  if (env[REQUIRE_INTEGRATION_ENV] === '1') {
    throw new Error(`Integration tests required but unavailable: ${probe.reason}`);
  }
  describe.skip(`${name} [integration skipped: ${probe.reason}]`, factory);
  return probe;
}
