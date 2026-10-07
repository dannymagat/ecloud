import { describe, expect, it } from 'vitest';
import { loadWorkerConfig } from './config.js';

describe('loadWorkerConfig', () => {
  it('defaults: CoA off, retention dry-run, health on 127.0.0.1:3003', () => {
    const c = loadWorkerConfig({ NODE_ENV: 'test' });
    expect(c.coa).toEqual({ enabled: false, radclientPath: 'radclient', timeoutS: 2, retries: 3 });
    expect(c.retention.apply).toBe(false);
    expect(c.health).toEqual({ port: 3003, host: '127.0.0.1' });
    expect(c.sessions).toEqual({ interimIntervalS: 600, reapGraceS: 120 });
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
  it('rejects invalid values by name', () => {
    expect(() => loadWorkerConfig({ NODE_ENV: 'test', ECLOUD_COA_ENABLED: 'yes' })).toThrow(
      /ECLOUD_COA_ENABLED/,
    );
    expect(() => loadWorkerConfig({ NODE_ENV: 'test', WORKER_HEALTH_PORT: '0' })).toThrow(
      /WORKER_HEALTH_PORT/,
    );
  });
});
