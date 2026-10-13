/**
 * Dynamic FreeRADIUS client lookup (Phase 2A).
 *
 * This is the only endpoint that returns a NAS shared secret, so the tests are mostly about
 * what it refuses: a cleartext internal leg in production, an unknown address, a database
 * failure. "Refuses" means 404 with no body in every not-served case, so the endpoint cannot
 * be used to find out which addresses are registered.
 */
import express, { type Express } from 'express';
import request from 'supertest';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { AppDeps } from '../context.js';
import { closeDeps, unitDeps } from '../test-support/deps.js';
import { dynamicClientHandler, type NasSecretLookup } from './radius-client-lookup.js';

const deps = unitDeps();

afterAll(async () => {
  await closeDeps(deps);
});

const NAS: NasSecretLookup = {
  id: '11111111-2222-4333-8444-555555555555',
  nasIp: '192.0.2.10',
  // Same alphabet the renderer enforces; not a real secret.
  secret: 'Zm9vYmFyLXRlc3Qtc2VjcmV0LTAxMjM0NTY3ODk',
  requireMessageAuthenticator: true,
};

/** An app with just this handler, plus the `req.log` the handler expects. */
function appWith(
  lookup: (ip: string) => Promise<NasSecretLookup | null>,
  overrides: Partial<{ isProduction: boolean; internalTls: { certFile: string; keyFile: string } | null }> = {},
): Express {
  const config = {
    ...deps.config,
    base: { ...deps.config.base, isProduction: overrides.isProduction ?? false },
    internalTls: overrides.internalTls ?? null,
  } as AppDeps['config'];
  const app = express();
  app.use((req, _res, next) => {
    (req as unknown as { log: unknown }).log = {
      error: () => undefined,
      warn: () => undefined,
      info: () => undefined,
    };
    next();
  });
  app.get('/internal/radius/client', dynamicClientHandler({ ...deps, config }, { lookup }));
  return app;
}

describe('GET /internal/radius/client', () => {
  it('returns the control attributes for a registered NAS', async () => {
    const app = appWith(async () => NAS);
    const res = await request(app).get('/internal/radius/client').query({ ip: NAS.nasIp });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      'control:FreeRADIUS-Client-IP-Address': NAS.nasIp,
      'control:FreeRADIUS-Client-Secret': NAS.secret,
      'control:FreeRADIUS-Client-Shortname': NAS.id,
      // FreeRADIUS rejects `auto` for this attribute: it must be literally yes or no.
      'control:FreeRADIUS-Client-Require-MA': 'yes',
      'control:FreeRADIUS-Client-NAS-Type': 'other',
    });
  });

  it('carries Require-MA = no when the NAS has it disabled', async () => {
    const app = appWith(async () => ({ ...NAS, requireMessageAuthenticator: false }));
    const res = await request(app).get('/internal/radius/client').query({ ip: NAS.nasIp });
    expect(res.body['control:FreeRADIUS-Client-Require-MA']).toBe('no');
  });

  it.each([
    ['no ip', undefined],
    ['empty ip', ''],
    ['not an address', 'not-an-ip'],
    ['a hostname', 'nas.example.com'],
    ['an address with a port', '192.0.2.10:1812'],
    ['a CIDR', '192.0.2.0/24'],
  ])('answers 404 with no body for %s', async (_label, ip) => {
    const lookup = vi.fn(async () => NAS);
    const app = appWith(lookup);
    const res = await request(app)
      .get('/internal/radius/client')
      .query(ip === undefined ? {} : { ip });
    expect(res.status).toBe(404);
    expect(res.text).toBe('');
    // A malformed address is rejected before the database is touched.
    expect(lookup).not.toHaveBeenCalled();
  });

  it('answers 404 with no body when no NAS is registered at that address', async () => {
    const app = appWith(async () => null);
    const res = await request(app).get('/internal/radius/client').query({ ip: '192.0.2.99' });
    expect(res.status).toBe(404);
    expect(res.text).toBe('');
  });

  it('answers 503 and no secret when the lookup fails', async () => {
    const app = appWith(async () => {
      throw new Error('database unavailable');
    });
    const res = await request(app).get('/internal/radius/client').query({ ip: NAS.nasIp });
    // Not 200: a database failure must never admit a client.
    expect(res.status).toBe(503);
    expect(res.text).not.toContain(NAS.secret);
  });

  it('refuses to serve a secret over a cleartext internal leg in production', async () => {
    // HERMES_AAA_AUDIT.md F-002: User-Password over that leg is an acknowledged risk; every
    // NAS shared secret is not. Fail closed rather than inherit the acknowledgement.
    const lookup = vi.fn(async () => NAS);
    const app = appWith(lookup, { isProduction: true, internalTls: null });
    const res = await request(app).get('/internal/radius/client').query({ ip: NAS.nasIp });
    expect(res.status).toBe(503);
    expect(res.text).not.toContain(NAS.secret);
    expect(lookup).not.toHaveBeenCalled();
  });

  it('serves in production once the internal listener is TLS', async () => {
    const app = appWith(async () => NAS, {
      isProduction: true,
      internalTls: { certFile: '/etc/ecloud/tls/api-internal.crt', keyFile: '/etc/ecloud/tls/api-internal.key' },
    });
    const res = await request(app).get('/internal/radius/client').query({ ip: NAS.nasIp });
    expect(res.status).toBe(200);
    expect(res.body['control:FreeRADIUS-Client-Secret']).toBe(NAS.secret);
  });

  it('serves in development without TLS, so the dev stack is unchanged', async () => {
    const app = appWith(async () => NAS, { isProduction: false, internalTls: null });
    expect((await request(app).get('/internal/radius/client').query({ ip: NAS.nasIp })).status).toBe(200);
  });
});
