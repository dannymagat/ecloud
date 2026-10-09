/**
 * P10-A: INTERNAL_API_TOKEN rotation window (docs/SECRETS_MANAGEMENT.md R1). During a rotation
 * the internal listener accepts the current token and INTERNAL_API_TOKEN_PREVIOUS; any other
 * value is still a 401 without a body.
 */
import { ConfigError, createLogger } from '@ecloud/shared';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { loadApiConfig } from '../config.js';
import { TEST_INTERNAL_TOKEN, closeDeps, testConfig, unitDeps } from '../test-support/deps.js';

const PREVIOUS = 'previous_internal_token_for_rotation_test';
const deps = unitDeps({
  config: testConfig({ INTERNAL_API_TOKEN_PREVIOUS: PREVIOUS }),
  logger: createLogger({ name: 'api-test', level: 'silent' }),
});
const { internalApp } = createApp(deps);

afterAll(async () => {
  await closeDeps(deps);
});

describe('internal token rotation window (P10-A)', () => {
  it('accepts the current and the previous token, rejects anything else', async () => {
    // /internal/* behind the guard; post-auth always answers 204 once authenticated.
    const send = (token: string) =>
      request(internalApp).post('/internal/aaa/post-auth').set('X-Internal-Token', token).send({});
    expect((await send(TEST_INTERNAL_TOKEN)).status).toBe(204);
    expect((await send(PREVIOUS)).status).toBe(204);
    const wrong = await send('not_the_token_0123456789abcdef0123');
    expect(wrong.status).toBe(401);
    expect(wrong.text).toBe('');
  });

  it('production: the previous token must be strong and differ from the current one', () => {
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
    expect(
      loadApiConfig({ ...prod, INTERNAL_API_TOKEN_PREVIOUS: 'p'.repeat(40) })
        .internalApiTokenPrevious,
    ).toBe('p'.repeat(40));
    expect(loadApiConfig(prod).internalApiTokenPrevious).toBeNull();
    for (const bad of ['short', 'i'.repeat(40)]) {
      expect(() => loadApiConfig({ ...prod, INTERNAL_API_TOKEN_PREVIOUS: bad })).toThrow(
        ConfigError,
      );
    }
  });
});
