/**
 * D-056: GET /internal/nas/:id/secret, the worker's per-dispatch fetch of ONE opened NAS secret.
 * The lookup is a seam; these tests cover the guards around it (enumeration, production TLS rule
 * and its acknowledgement, no-store, single id in / single secret out).
 */
import express, { type Express } from 'express';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { closeDeps, unitDeps } from '../test-support/deps.js';
import { INTERNAL_SECRET_TOKEN_HEADER, nasSecretHandler, type NasSecretById } from './nas-secret.js';

const deps = unitDeps();
afterAll(async () => {
  await closeDeps(deps);
});

const TOKEN = 'nas-secret-endpoint-token-0123456789abcdef'; // check-no-secrets: allow (test value)

const NAS: NasSecretById = {
  id: '11111111-2222-4333-8444-555555555555',
  secret: 'Zm9vYmFyLXRlc3Qtc2VjcmV0LTAxMjM0NTY3ODk', // synthetic. check-no-secrets: allow
};

function appWith(
  lookup: (id: string) => Promise<NasSecretById | null>,
  overrides: Partial<{
    isProduction: boolean;
    internalTls: { certFile: string; keyFile: string } | null;
    internalCleartextAck: boolean;
    internalSecretToken: string | null;
  }> = {},
): Express {
  const config = {
    ...deps.config,
    base: { ...deps.config.base, isProduction: overrides.isProduction ?? false },
    internalTls: overrides.internalTls ?? null,
    internalCleartextAck: overrides.internalCleartextAck ?? false,
    internalSecretToken:
      overrides.internalSecretToken === undefined ? TOKEN : overrides.internalSecretToken,
  };
  const app = express();
  app.use((req, _res, next) => {
    (req as unknown as { log: unknown }).log = {
      error: () => undefined,
      warn: () => undefined,
      info: () => undefined,
    };
    next();
  });
  app.get('/internal/nas/:id/secret', nasSecretHandler({ ...deps, config }, { lookup }));
  return app;
}

describe('GET /internal/nas/:id/secret', () => {
  it('answers one secret for a known NAS id, no-store', async () => {
    const seen: string[] = [];
    const app = appWith((id) => {
      seen.push(id);
      return Promise.resolve(id === NAS.id ? NAS : null);
    });
    const res = await request(app).get(`/internal/nas/${NAS.id}/secret`).set(INTERNAL_SECRET_TOKEN_HEADER, TOKEN);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toMatchObject({ id: NAS.id, secret: NAS.secret });
    expect(Object.keys(res.body as object).sort()).toEqual(['id', 'request_id', 'secret']);
    expect(seen).toEqual([NAS.id]);
  });

  it('404 with no body for an unknown id, a non-UUID id and an unopenable row', async () => {
    const app = appWith(() => Promise.resolve(null));
    for (const id of ['22222222-2222-4333-8444-555555555555', 'not-a-uuid', 'nas {']) {
      const res = await request(app).get(`/internal/nas/${encodeURIComponent(id)}/secret`).set(INTERNAL_SECRET_TOKEN_HEADER, TOKEN);
      expect(res.status).toBe(404);
      expect(res.text).toBe('');
    }
  });

  it('refuses a cleartext internal listener in production unless acknowledged', async () => {
    const refused = await request(appWith(() => Promise.resolve(NAS), { isProduction: true }))
      .get(`/internal/nas/${NAS.id}/secret`)
      .set(INTERNAL_SECRET_TOKEN_HEADER, TOKEN);
    expect(refused.status).toBe(503);
    expect(refused.text).toBe('');
    const acked = await request(
      appWith(() => Promise.resolve(NAS), { isProduction: true, internalCleartextAck: true }),
    )
      .get(`/internal/nas/${NAS.id}/secret`)
      .set(INTERNAL_SECRET_TOKEN_HEADER, TOKEN);
    expect(acked.status).toBe(200);
    const tls = await request(
      appWith(() => Promise.resolve(NAS), { isProduction: true, internalTls: { certFile: 'c', keyFile: 'k' } }),
    )
      .get(`/internal/nas/${NAS.id}/secret`)
      .set(INTERNAL_SECRET_TOKEN_HEADER, TOKEN);
    expect(tls.status).toBe(200);
  });

  it('503 with no body when the lookup itself fails', async () => {
    const app = appWith(() => Promise.reject(new Error('db down')));
    const res = await request(app).get(`/internal/nas/${NAS.id}/secret`).set(INTERNAL_SECRET_TOKEN_HEADER, TOKEN);
    expect(res.status).toBe(503);
    expect(res.text).toBe('');
  });
});

describe('GET /internal/nas/:id/secret: its own token (D-061)', () => {
  it('401 without the token, with a wrong one, and with the SHARED internal token', async () => {
    const app = appWith(() => Promise.resolve(NAS));
    const missing = await request(app).get(`/internal/nas/${NAS.id}/secret`);
    expect(missing.status).toBe(401);
    expect(missing.text).toBe('');
    const wrong = await request(app).get(`/internal/nas/${NAS.id}/secret`).set(INTERNAL_SECRET_TOKEN_HEADER, `${TOKEN}x`);
    expect(wrong.status).toBe(401);
    const shared = await request(app)
      .get(`/internal/nas/${NAS.id}/secret`)
      .set('X-Internal-Token', deps.config.base.internalApiToken)
      .set(INTERNAL_SECRET_TOKEN_HEADER, deps.config.base.internalApiToken);
    expect(shared.status).toBe(401);
  });

  it('503 with no body while INTERNAL_SECRET_TOKEN is not configured', async () => {
    const res = await request(appWith(() => Promise.resolve(NAS), { internalSecretToken: null }))
      .get(`/internal/nas/${NAS.id}/secret`)
      .set(INTERNAL_SECRET_TOKEN_HEADER, TOKEN);
    expect(res.status).toBe(503);
    expect(res.text).toBe('');
  });
});
