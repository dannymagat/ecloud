/**
 * P10-A security review fixes on POST /api/v1/auth/mfa/verify (unit, no database):
 *  - the per-challenge attempt limit is enforced with an atomic counter, so parallel requests
 *    on one challenge cannot each see the same count (former read-modify-write race);
 *  - every failure emits the fail2ban-matchable `admin_mfa_failed` event with the client IP.
 */
import { createLogger } from '@ecloud/shared';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { sha256Hex } from '../crypto.js';
import { TEST_ORIGIN, closeDeps, unitDeps } from '../test-support/deps.js';
import { LOGIN_LIMITS } from './rate-limit.js';

const lines: string[] = [];
const deps = unitDeps({
  logger: createLogger({
    name: 'api-test',
    level: 'warn',
    destination: { write: (chunk: string) => lines.push(chunk) },
  }),
});
const { publicApp } = createApp(deps);

afterAll(async () => {
  await closeDeps(deps);
});

const verify = (token: string, code = '123456') =>
  request(publicApp)
    .post('/api/v1/auth/mfa/verify')
    .set('Origin', TEST_ORIGIN)
    .set('X-Requested-With', 'XMLHttpRequest')
    .send({ mfa_token: token, code });

describe('MFA verify hardening (P10-A)', () => {
  it('caps attempts per challenge atomically under concurrency', async () => {
    const token = 'challenge-token-'.padEnd(43, 'a');
    await deps.kv.set(
      `mfa:${sha256Hex(token)}`,
      JSON.stringify({ administratorId: '01900000-0000-7000-8000-000000000001' }),
      300,
    );
    const parallel = LOGIN_LIMITS.mfaAttempts + 7;
    const responses = await Promise.all(Array.from({ length: parallel }, () => verify(token)));
    // Attempts within the limit reach the (unavailable) database -> 5xx; the rest are refused
    // before any code check with the generic 401.
    const reachedCodeCheck = responses.filter((r) => r.status >= 500).length;
    const refused = responses.filter((r) => r.status === 401).length;
    expect(reachedCodeCheck).toBe(LOGIN_LIMITS.mfaAttempts);
    expect(refused).toBe(parallel - LOGIN_LIMITS.mfaAttempts);
    // The challenge is burnt once the limit is crossed.
    expect(await deps.kv.get(`mfa:${sha256Hex(token)}`)).toBeNull();
  });

  it('logs admin_mfa_failed with the client IP and never the code or token', async () => {
    lines.length = 0;
    const token = 'unknown-challenge-'.padEnd(43, 'b');
    const res = await verify(token, '654321');
    expect(res.status).toBe(401);
    const events = lines.filter((l) => l.includes('"event":"admin_mfa_failed"'));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatch(/"event":"admin_mfa_failed","ip":"[0-9a-f.:]+"/);
    expect(lines.join('')).not.toContain(token);
    expect(lines.join('')).not.toContain('654321');
  });
});
