import { createServer, type AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import {
  canConnect,
  describeIntegration,
  getTestDatabaseUrl,
  hostPortFromUrl,
  probeIntegration,
} from './integration.js';

async function closedLocalPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
  return port;
}

describe('getTestDatabaseUrl', () => {
  it('returns undefined when unset or blank', () => {
    expect(getTestDatabaseUrl({})).toBeUndefined();
    expect(getTestDatabaseUrl({ ECLOUD_TEST_DATABASE_URL: '  ' })).toBeUndefined();
    expect(getTestDatabaseUrl({ ECLOUD_TEST_DATABASE_URL: 'postgres://u:p@h:5/db' })).toBe(
      'postgres://u:p@h:5/db',
    );
  });
});

describe('hostPortFromUrl', () => {
  it('parses host and port with protocol defaults', () => {
    expect(hostPortFromUrl('postgres://u:p@db.local:6543/x')).toEqual({
      host: 'db.local',
      port: 6543,
    });
    expect(hostPortFromUrl('postgres://db.local/x')).toEqual({ host: 'db.local', port: 5432 });
    expect(hostPortFromUrl('redis://cache')).toEqual({ host: 'cache', port: 6379 });
    expect(hostPortFromUrl('nonsense')).toBeUndefined();
  });
});

describe('probeIntegration', () => {
  it('reports a clear reason when the variable is unset', async () => {
    const probe = await probeIntegration({});
    expect(probe.ok).toBe(false);
    if (!probe.ok) expect(probe.reason).toContain('ECLOUD_TEST_DATABASE_URL is not set');
  });

  it('fails fast when the database port is closed', async () => {
    const port = await closedLocalPort();
    const started = Date.now();
    expect(await canConnect({ host: '127.0.0.1', port }, 500)).toBe(false);
    const probe = await probeIntegration(
      { ECLOUD_TEST_DATABASE_URL: `postgres://u:p@127.0.0.1:${String(port)}/db` },
      500,
    );
    expect(Date.now() - started).toBeLessThan(2000);
    expect(probe.ok).toBe(false);
    if (!probe.ok) expect(probe.reason).toContain('not reachable');
  });

  it('connects when something listens', async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    try {
      expect(await canConnect({ host: '127.0.0.1', port })).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('describeIntegration', () => {
  it('throws when integration is required but unavailable', async () => {
    await expect(
      describeIntegration('x', () => undefined, {
        env: { ECLOUD_TEST_REQUIRE_INTEGRATION: '1' },
      }),
    ).rejects.toThrow(/Integration tests required but unavailable/);
  });
});

// Real usage: registers a skipped suite in this environment unless the dev stack is up.
await describeIntegration('describeIntegration self-check', () => {
  it('only runs against a reachable database', () => {
    expect(getTestDatabaseUrl()).toBeDefined();
  });
});
