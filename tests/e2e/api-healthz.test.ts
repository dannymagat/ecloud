/**
 * Smoke: the built api process starts and answers GET /healthz. Runs only when
 * apps/api/dist/main.js exists (after `npm run build`) and the integration environment is
 * available (the api may need the database at startup); skips cleanly otherwise. The full
 * Playwright e2e layer arrives in Phase 6 (tests/e2e/README.md).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import {
  getTestAppDatabaseUrl,
  getTestDatabaseUrl,
  getTestRedisUrl,
  probeIntegration,
} from '@ecloud/testing';
import { afterAll, describe, expect, it } from 'vitest';

const MAIN = resolve(import.meta.dirname, '..', '..', 'apps', 'api', 'dist', 'main.js');
const probe = await probeIntegration();
const reason = !existsSync(MAIN)
  ? 'apps/api/dist/main.js not built'
  : probe.ok
    ? undefined
    : probe.reason;
const suite = reason === undefined ? describe : describe.skip;

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((r) => server.close(() => r()));
  return port;
}

suite(`e2e smoke: api /healthz${reason === undefined ? '' : ` [skipped: ${reason}]`}`, () => {
  let child: ChildProcess | undefined;
  let logs = '';

  afterAll(() => {
    child?.kill('SIGTERM');
  });

  it('starts dist/main.js and serves GET /healthz -> 200 {status:"ok"}', async () => {
    const apiPort = await freePort();
    const internalPort = await freePort();
    const env: NodeJS.ProcessEnv = {
      PATH: process.env['PATH'],
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      API_PORT: String(apiPort),
      INTERNAL_PORT: String(internalPort),
      PORTAL_PORT: String(await freePort()),
    };
    const appUrl = getTestAppDatabaseUrl();
    const platformUrl = getTestDatabaseUrl();
    const redisUrl = getTestRedisUrl();
    if (appUrl !== undefined) env['DATABASE_URL'] = appUrl;
    if (platformUrl !== undefined) env['DATABASE_URL_PLATFORM'] = platformUrl;
    if (redisUrl !== undefined) env['REDIS_URL'] = redisUrl;

    child = spawn(process.execPath, [MAIN], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout?.on('data', (c: Buffer) => (logs += c.toString('utf8')));
    child.stderr?.on('data', (c: Buffer) => (logs += c.toString('utf8')));

    const deadline = Date.now() + 15_000;
    let last: unknown;
    while (Date.now() < deadline) {
      if (child.exitCode !== null)
        throw new Error(`api exited with ${String(child.exitCode)}: ${logs}`);
      let res: Response;
      try {
        res = await fetch(`http://127.0.0.1:${String(apiPort)}/healthz`);
      } catch (error) {
        // not listening yet
        last = error;
        await new Promise((r) => setTimeout(r, 200));
        continue;
      }
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ status: 'ok' });
      return;
    }
    throw new Error(`api did not answer /healthz within 15 s (${String(last)}): ${logs}`);
  });
});
