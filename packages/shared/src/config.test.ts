import { describe, expect, it } from 'vitest';
import { ConfigError, DEV_DEFAULTS, loadConfig, redactConfig, redactUrl } from './config.js';

describe('loadConfig', () => {
  it('applies development defaults when env is empty', () => {
    const config = loadConfig({});
    expect(config.nodeEnv).toBe('development');
    expect(config.isProduction).toBe(false);
    expect(config.ports).toEqual({ api: 3000, internal: 3001, portal: 3002 });
    expect(config.database.url).toBe(DEV_DEFAULTS.DATABASE_URL);
    expect(config.database.platformUrl).toBe(DEV_DEFAULTS.DATABASE_URL_PLATFORM);
    expect(config.session).toEqual({ cookieName: 'ecloud_sid', ttlSeconds: 43_200 });
    expect(config.argon2).toEqual({ memoryKib: 19_456, timeCost: 2, parallelism: 1 });
    expect(config.storage).toEqual({ driver: 'local', localPath: './var/storage' });
    expect(config.radius.coaPort).toBe(3799);
    expect(config.radius.bindIp).toBeUndefined();
  });

  it('coerces numeric ports and treats empty optional strings as unset', () => {
    const config = loadConfig({ API_PORT: '8080', RADIUS_BIND_IP: '   ', S3_BUCKET: '' });
    expect(config.ports.api).toBe(8080);
    expect(config.radius.bindIp).toBeUndefined();
  });

  it('rejects invalid values and names the variable without echoing the value', () => {
    expect(() => loadConfig({ API_PORT: 'not-a-port-zzz' })).toThrow(ConfigError);
    try {
      loadConfig({ API_PORT: 'not-a-port-zzz', LOG_LEVEL: 'loud' });
      expect.fail('expected ConfigError');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const message = (error as ConfigError).message;
      expect(message).toContain('API_PORT');
      expect(message).toContain('LOG_LEVEL');
      expect(message).not.toContain('not-a-port-zzz');
    }
  });

  it('rejects connection URLs with the wrong scheme', () => {
    expect(() => loadConfig({ DATABASE_URL: 'mysql://x' })).toThrow(/DATABASE_URL/);
    expect(() => loadConfig({ REDIS_URL: 'http://x' })).toThrow(/REDIS_URL/);
  });

  it('rejects dev defaults and short internal tokens in production', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(ConfigError);
    try {
      loadConfig({ NODE_ENV: 'production' });
    } catch (error) {
      const problems = (error as ConfigError).problems;
      expect(problems.some((p) => p.startsWith('DATABASE_URL:'))).toBe(true);
      expect(problems.some((p) => p.startsWith('DATABASE_URL_PLATFORM:'))).toBe(true);
      expect(problems.some((p) => p.startsWith('INTERNAL_API_TOKEN:'))).toBe(true);
      // The error message must never contain the token value.
      expect((error as ConfigError).message).not.toContain(DEV_DEFAULTS.INTERNAL_API_TOKEN);
    }

    const config = loadConfig({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://app:pw@db.internal:5432/ecloud',
      DATABASE_URL_PLATFORM: 'postgres://platform:pw@db.internal:5432/ecloud',
      REDIS_URL: 'redis://cache.internal:6379',
      INTERNAL_API_TOKEN: 'x'.repeat(32),
      STORAGE_LOCAL_ALLOW_PRODUCTION: 'true',
    });
    expect(config.isProduction).toBe(true);
  });

  describe('storage in production (D-026)', () => {
    const prodBase = {
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://app:pw@db.internal:5432/ecloud',
      DATABASE_URL_PLATFORM: 'postgres://platform:pw@db.internal:5432/ecloud',
      REDIS_URL: 'redis://cache.internal:6379',
      INTERNAL_API_TOKEN: 'x'.repeat(32),
    };
    const s3 = {
      STORAGE_DRIVER: 's3',
      S3_BUCKET: 'assets',
      S3_ACCESS_KEY_ID: 'placeholder_key_id',
      S3_SECRET_ACCESS_KEY: 'placeholder_secret',
    };

    it('rejects the local driver without the explicit opt-in', () => {
      expect(() => loadConfig(prodBase)).toThrow(/STORAGE_LOCAL_ALLOW_PRODUCTION/);
      expect(() => loadConfig({ ...prodBase, STORAGE_LOCAL_ALLOW_PRODUCTION: 'false' })).toThrow(
        /STORAGE_DRIVER: local/,
      );
      expect(
        loadConfig({ ...prodBase, STORAGE_LOCAL_ALLOW_PRODUCTION: 'true' }).storage.driver,
      ).toBe('local');
    });

    it('allows the local driver outside production without the opt-in', () => {
      expect(loadConfig({ NODE_ENV: 'development' }).storage.driver).toBe('local');
    });

    it('requires an https S3 endpoint', () => {
      expect(() =>
        loadConfig({ ...prodBase, ...s3, S3_ENDPOINT: 'http://s3.example.com' }),
      ).toThrow(/S3_ENDPOINT: must use https/);
      expect(
        loadConfig({ ...prodBase, ...s3, S3_ENDPOINT: 'https://s3.example.com' }).storage.driver,
      ).toBe('s3');
      // AWS (no endpoint, region only) uses the SDK's https default.
      expect(loadConfig({ ...prodBase, ...s3, S3_REGION: 'eu-west-1' }).storage.driver).toBe('s3');
      // Non-https endpoints stay allowed in development (throwaway local test servers).
      expect(loadConfig({ ...s3, S3_ENDPOINT: 'http://127.0.0.1:9000' }).storage.driver).toBe('s3');
    });
  });

  it('requires S3 settings when STORAGE_DRIVER=s3', () => {
    expect(() => loadConfig({ STORAGE_DRIVER: 's3' })).toThrow(/S3_BUCKET/);
    const config = loadConfig({
      STORAGE_DRIVER: 's3',
      S3_BUCKET: 'assets',
      S3_REGION: 'eu-west-1',
      S3_ACCESS_KEY_ID: 'AKIA_PLACEHOLDER',
      S3_SECRET_ACCESS_KEY: 'placeholder_secret',
      S3_FORCE_PATH_STYLE: 'true',
    });
    expect(config.storage.driver).toBe('s3');
    if (config.storage.driver === 's3') {
      expect(config.storage.s3.bucket).toBe('assets');
      expect(config.storage.s3.forcePathStyle).toBe(true);
    }
  });
});

describe('redactConfig', () => {
  it('removes every secret from the printable copy', () => {
    const config = loadConfig({
      DATABASE_URL: 'postgres://app:supersecretpw@127.0.0.1:5432/ecloud',
      REDIS_URL: 'redis://:redispw@127.0.0.1:6379',
      INTERNAL_API_TOKEN: 'tok_verysecret_value',
      STORAGE_DRIVER: 's3',
      S3_BUCKET: 'b',
      S3_ENDPOINT: 'http://127.0.0.1:9000',
      S3_ACCESS_KEY_ID: 'keyid_secret',
      S3_SECRET_ACCESS_KEY: 's3_secret_value',
    });
    const printable = JSON.stringify(redactConfig(config));
    for (const secret of [
      'supersecretpw',
      'redispw',
      'tok_verysecret_value',
      'keyid_secret',
      's3_secret_value',
    ]) {
      expect(printable).not.toContain(secret);
    }
    expect(printable).toContain('[REDACTED]');
    // Original is untouched.
    expect(config.internalApiToken).toBe('tok_verysecret_value');
  });

  it('redactUrl keeps host and database but hides the password', () => {
    expect(redactUrl('postgres://app:pw@db:5432/ecloud')).toBe(
      'postgres://app:REDACTED@db:5432/ecloud',
    );
    expect(redactUrl('not a url')).toBe('[REDACTED]');
  });
});
