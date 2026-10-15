import { describe, expect, it } from 'vitest';
import { loadWorkerConfig } from './config.js';

describe('loadWorkerConfig', () => {
  it('defaults: CoA off, retention dry-run, health on 127.0.0.1:3003', () => {
    const c = loadWorkerConfig({ NODE_ENV: 'test' });
    expect(c.coa).toEqual({ enabled: false, radclientPath: 'radclient', timeoutS: 2, retries: 3 });
    expect(c.retention.apply).toBe(false);
    expect(c.health).toEqual({ port: 3003, host: '127.0.0.1' });
    expect(c.sessions).toEqual({ interimIntervalS: 600, reapGraceS: 120, authorizationTtlS: 300 });
    expect(c.drain.batchSize).toBe(500);
  });
  it('parses flags and overrides', () => {
    const c = loadWorkerConfig({
      NODE_ENV: 'test',
      ECLOUD_COA_ENABLED: 'true',
      RETENTION_APPLY: '1',
      WORKER_HEALTH_PORT: '4999',
      RADCLIENT_PATH: '/usr/bin/radclient',
    });
    expect(c.coa.enabled).toBe(true);
    expect(c.coa.radclientPath).toBe('/usr/bin/radclient');
    expect(c.retention.apply).toBe(true);
    expect(c.health.port).toBe(4999);
  });
  it('loads in production with NO INTERNAL_API_TOKEN at all', () => {
    // THE POINT OF requireInternalApiToken: false. The worker has no reader for the shared
    // token — it authenticates to the api's NAS-secret endpoint with INTERNAL_SECRET_TOKEN
    // (D-061) — so compose does not give it one. Before this, the shared loader refused to
    // start without it: the dev-default check and the 32-character production floor both
    // fired, so the worker had to mount a credential it could not use, which meant a
    // compromised worker also yielded the token FreeRADIUS and the portal authenticate with.
    //
    // This test is what stops someone restoring that mount because startup broke and the
    // reason was not visible.
    const production = {
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://ecloud_app:aVeryLongDevPassword123@db:5432/ecloud',
      DATABASE_URL_PLATFORM: 'postgres://ecloud_platform:aVeryLongDevPassword123@db:5432/ecloud',
      REDIS_URL: 'redis://redis:6379',
      DATA_ENCRYPTION_KEY: 'x'.repeat(48),
      MFA_ENCRYPTION_KEY: 'y'.repeat(48),
      SESSION_SIGNING_KEY: 'z'.repeat(48),
      PORTAL_BASE_URL: 'https://portal.example.test',
      ADMIN_BASE_URL: 'https://admin.example.test',
      STORAGE_DRIVER: 'local',
      STORAGE_LOCAL_ALLOW_PRODUCTION: 'true',
    } as Record<string, string | undefined>;
    // No INTERNAL_API_TOKEN and no INTERNAL_API_TOKEN_FILE anywhere in the environment.
    expect(production.INTERNAL_API_TOKEN).toBeUndefined();
    const c = loadWorkerConfig(production);
    expect(c.app.isProduction).toBe(true);
  });

  it('rejects invalid values by name', () => {
    expect(() => loadWorkerConfig({ NODE_ENV: 'test', ECLOUD_COA_ENABLED: 'yes' })).toThrow(
      /ECLOUD_COA_ENABLED/,
    );
    expect(() => loadWorkerConfig({ NODE_ENV: 'test', WORKER_HEALTH_PORT: '0' })).toThrow(
      /WORKER_HEALTH_PORT/,
    );
  });
});
