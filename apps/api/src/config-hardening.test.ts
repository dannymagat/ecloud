import { ConfigError } from '@ecloud/shared';
import { describe, expect, it } from 'vitest';
import { loadApiConfig } from './config.js';

/** Production env that passes every other check (values are obviously fake test strings). */
const prod = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgres://a:b@db/x',
  DATABASE_URL_PLATFORM: 'postgres://a:b@db/y',
  REDIS_URL: 'redis://r:6379',
  INTERNAL_API_TOKEN: 'i'.repeat(40),
  STORAGE_LOCAL_ALLOW_PRODUCTION: 'true',
  MFA_ENCRYPTION_KEY: 'm'.repeat(40),
  DATA_ENCRYPTION_KEY: 'd'.repeat(40),
  VOUCHER_PEPPER: 'v'.repeat(40),
  SESSION_COOKIE_NAME: '__Host-ecloud_sid',
};

function problemsOf(env: Record<string, string>): readonly string[] {
  try {
    loadApiConfig(env);
    return [];
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return (error as ConfigError).problems;
  }
}

describe('API production config hardening (P10-A, SECURITY_ARCHITECTURE §6.3)', () => {
  it('accepts a __Host- cookie with Secure defaulted on', () => {
    const config = loadApiConfig(prod);
    expect(config.session.secureCookie).toBe(true);
    expect(config.session.cookieName).toBe('__Host-ecloud_sid');
  });

  it('refuses SESSION_COOKIE_SECURE=false and a cookie name without __Host-', () => {
    expect(problemsOf({ ...prod, SESSION_COOKIE_SECURE: 'false' })).toEqual([
      'SESSION_COOKIE_SECURE: must not be false when NODE_ENV=production',
    ]);
    expect(problemsOf({ ...prod, SESSION_COOKIE_NAME: 'ecloud_sid' })).toEqual([
      'SESSION_COOKIE_NAME: must start with __Host- when NODE_ENV=production',
    ]);
  });

  it('development keeps the plain cookie name and non-secure default', () => {
    const config = loadApiConfig({ NODE_ENV: 'development' });
    expect(config.session.cookieName).toBe('ecloud_sid');
    expect(config.session.secureCookie).toBe(false);
  });
});
