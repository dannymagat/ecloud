/* eslint-disable @typescript-eslint/no-unsafe-member-access -- supertest response bodies are untyped JSON */
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { OPENAPI_PATH } from './openapi.js';
import { TEST_INTERNAL_TOKEN, TEST_ORIGIN, closeDeps, unitDeps } from './test-support/deps.js';
import { toOpenApiPath } from './http/route.js';
import { PACKAGE_NAME } from './index.js';

const deps = unitDeps();
const { publicApp, internalApp, routes, openapi } = createApp(deps);

afterAll(async () => {
  await closeDeps(deps);
});

describe('@ecloud/api public listener (unit, no database)', () => {
  it('exports its package name', () => {
    expect(PACKAGE_NAME).toBe('@ecloud/api');
  });

  it('GET /healthz is ok, carries a request id and security headers', async () => {
    const res = await request(publicApp).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('echoes a well-formed incoming X-Request-Id', async () => {
    const res = await request(publicApp).get('/healthz').set('X-Request-Id', 'req-abcdef123');
    expect(res.headers['x-request-id']).toBe('req-abcdef123');
  });

  it('GET /readyz reports 503 when the database is unreachable', async () => {
    const res = await request(publicApp).get('/readyz');
    expect(res.status).toBe(503);
    expect(res.body.checks).toEqual({ database: 'unavailable', redis: 'ok' });
  });

  it('unknown routes are RFC 9457 problems', async () => {
    const res = await request(publicApp).get('/api/v1/nope');
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body).toMatchObject({ type: 'urn:ecloud:problem:not-found', status: 404 });
    expect(res.body.request_id).toBeTypeOf('string');
  });

  it('requires authentication on protected routes', async () => {
    const res = await request(publicApp).get('/api/v1/auth/me');
    expect(res.status).toBe(401);
    expect(res.body.type).toBe('urn:ecloud:problem:unauthorized');
  });

  it('rejects a malformed Bearer API key with 401', async () => {
    const res = await request(publicApp)
      .get('/api/v1/auth/me')
      .set('Authorization', 'Bearer not-a-key');
    expect(res.status).toBe(401);
  });

  it('CSRF: login without Origin is rejected before any credential check', async () => {
    const res = await request(publicApp)
      .post('/api/v1/auth/login')
      .send({ email: 'a@example.test', password: 'x' });
    expect(res.status).toBe(403);
    expect(res.body.type).toBe('urn:ecloud:problem:csrf');
  });

  it('CSRF: foreign Origin is rejected', async () => {
    const res = await request(publicApp)
      .post('/api/v1/auth/login')
      .set('Origin', 'https://evil.example')
      .set('X-Requested-With', 'XMLHttpRequest')
      .send({ email: 'a@example.test', password: 'x' });
    expect(res.status).toBe(403);
  });

  it('CSRF: missing X-Requested-With is rejected', async () => {
    const res = await request(publicApp)
      .post('/api/v1/auth/login')
      .set('Origin', TEST_ORIGIN)
      .send({ email: 'a@example.test', password: 'x' });
    expect(res.status).toBe(403);
    expect(res.body.detail).toContain('X-Requested-With');
  });

  it('validation problems list the failing fields', async () => {
    const res = await request(publicApp)
      .post('/api/v1/auth/login')
      .set('Origin', TEST_ORIGIN)
      .set('X-Requested-With', 'XMLHttpRequest')
      .send({ email: 'not-an-email' });
    expect(res.status).toBe(400);
    expect(res.body.type).toBe('urn:ecloud:problem:validation');
    const paths = (res.body.errors as { path: string }[]).map((e) => e.path);
    expect(paths).toEqual(expect.arrayContaining(['body.email', 'body.password']));
  });

  it('malformed JSON is a validation problem, oversized bodies are 413', async () => {
    const malformed = await request(publicApp)
      .post('/api/v1/auth/login')
      .set('Origin', TEST_ORIGIN)
      .set('X-Requested-With', 'XMLHttpRequest')
      .set('Content-Type', 'application/json')
      .send('{"email":');
    expect(malformed.status).toBe(400);
    const big = await request(publicApp)
      .post('/api/v1/auth/login')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ email: 'x'.repeat(1_100_000) }));
    expect(big.status).toBe(413);
  });

  it('login fails closed (503) when the database is unavailable', async () => {
    const res = await request(publicApp)
      .post('/api/v1/auth/login')
      .set('Origin', TEST_ORIGIN)
      .set('X-Requested-With', 'XMLHttpRequest')
      .send({ email: 'a@example.test', password: 'whatever-password' });
    expect(res.status).toBe(503);
    expect(res.body.type).toBe('urn:ecloud:problem:unavailable');
  });
});

describe('OpenAPI', () => {
  it('serves an OpenAPI 3.1 document', async () => {
    const res = await request(publicApp).get(OPENAPI_PATH);
    expect(res.status).toBe(200);
    expect(res.body.openapi).toBe('3.1.0');
    expect(res.body).toEqual(openapi);
  });

  it('documents every public route that is mounted on the router', () => {
    const doc = openapi as { paths: Record<string, Record<string, unknown>> };
    const mounted = collectRoutes(publicApp as unknown as { router?: { stack: Layer[] } });
    expect(mounted.length).toBeGreaterThan(60);
    const missing = mounted.filter(
      ({ method, path }) => doc.paths[toOpenApiPath(path)]?.[method] === undefined,
    );
    expect(missing).toEqual([]);
    for (const route of routes) {
      expect(doc.paths[toOpenApiPath(route.path)]?.[route.method]).toBeDefined();
    }
  });

  it('documents the multi-vendor endpoints with their permission (plan §8.2)', () => {
    const doc = openapi as {
      paths: Record<string, Record<string, { description?: string } | undefined>>;
    };
    const expected: [string, string, string][] = [
      ['/api/v1/compatibility', 'get', 'compatibility:read'],
      ['/api/v1/compatibility/{key}', 'get', 'compatibility:read'],
      ['/api/v1/vendors', 'get', 'compatibility:read'],
      ['/api/v1/orgs/{orgId}/controllers', 'get', 'controller:read'],
      ['/api/v1/orgs/{orgId}/controllers', 'post', 'controller:create'],
      ['/api/v1/orgs/{orgId}/controllers/{id}', 'get', 'controller:read'],
      ['/api/v1/orgs/{orgId}/controllers/{id}', 'patch', 'controller:update'],
      ['/api/v1/orgs/{orgId}/controllers/{id}', 'delete', 'controller:delete'],
      [
        '/api/v1/orgs/{orgId}/controllers/{id}/rotate-credential',
        'post',
        'controller:secret:rotate',
      ],
    ];
    for (const [path, method, permission] of expected) {
      expect(doc.paths[path]?.[method]?.description, `${method} ${path}`).toBe(
        `Permission: \`${permission}\``,
      );
    }
    // the credential is write-only: no response schema mentions it
    const text = JSON.stringify(doc.paths['/api/v1/orgs/{orgId}/controllers/{id}']);
    expect(text).not.toContain('credential_secret_ref');
  });
});

describe('internal listener', () => {
  const radiusBody = {
    'User-Name': { type: 'string', value: ['alice'] },
    'User-Password': { type: 'string', value: ['secret-password'] },
    'ECLOUD-Packet-Src-IP-Address': { type: 'string', value: ['192.0.2.10'] },
  };

  it('answers 401 without a body when X-Internal-Token is missing or wrong', async () => {
    const missing = await request(internalApp).post('/internal/aaa/authorize').send(radiusBody);
    expect(missing.status).toBe(401);
    expect(missing.text).toBe('');
    const wrong = await request(internalApp)
      .post('/internal/aaa/authorize')
      .set('X-Internal-Token', 'wrong')
      .send(radiusBody);
    expect(wrong.status).toBe(401);
  });

  it('never fails open: database errors become 503', async () => {
    const res = await request(internalApp)
      .post('/internal/aaa/authorize')
      .set('X-Internal-Token', TEST_INTERNAL_TOKEN)
      .send(radiusBody);
    expect(res.status).toBe(503);
    expect(JSON.stringify(res.body)).not.toContain('Auth-Type');
  });

  it('GET /metrics (internal only) exposes request and fail-closed AAA counters without secrets', async () => {
    await request(internalApp)
      .post('/internal/aaa/authorize')
      .set('X-Internal-Token', TEST_INTERNAL_TOKEN)
      .send(radiusBody);
    const res = await request(internalApp).get('/metrics');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.headers['content-type']).toContain('version=0.0.4');
    expect(res.text).toMatch(
      /^ecloud_aaa_authorize_decisions_total\{outcome="unavailable",reason="",retransmit="false"\} [1-9]/m,
    );
    expect(res.text).toMatch(
      /^ecloud_aaa_authorize_duration_seconds_count\{outcome="unavailable"\} [1-9]/m,
    );
    expect(res.text).toMatch(
      /^ecloud_api_http_requests_total\{listener="internal",method="POST",route="\/internal\/aaa\/authorize",status="503"\} [1-9]/m,
    );
    expect(res.text).toContain('# TYPE ecloud_api_process_resident_memory_bytes gauge');
    expect(res.text).not.toContain('alice');
    expect(res.text).not.toContain('secret-password');
    expect(res.text).not.toContain('192.0.2.10');
    // never on the public listener (Caddy-facing)
    const pub = await request(publicApp).get('/metrics');
    expect(pub.status).toBe(404);
  });

  it('labels unmatched routes as `unmatched` (bounded cardinality)', async () => {
    await request(publicApp).get('/api/v1/nope/abc-123');
    const res = await request(internalApp).get('/metrics');
    expect(res.text).toMatch(/route="unmatched",status="404"/);
    expect(res.text).not.toContain('abc-123');
  });

  it('post-auth always acknowledges with 204', async () => {
    const res = await request(internalApp)
      .post('/internal/aaa/post-auth')
      .set('X-Internal-Token', TEST_INTERNAL_TOKEN)
      .send({ 'ECLOUD-Auth-Result': { type: 'string', value: ['reject'] } });
    expect(res.status).toBe(204);
  });
});

interface Layer {
  route?: { path: string; methods: Record<string, boolean> };
  name?: string;
  handle?: { stack?: Layer[] };
}

/** Walks the Express router stack and returns every concrete route. */
function collectRoutes(app: { router?: { stack: Layer[] } }): { method: string; path: string }[] {
  const out: { method: string; path: string }[] = [];
  const walk = (stack: Layer[]) => {
    for (const layer of stack) {
      if (layer.route) {
        for (const [method, enabled] of Object.entries(layer.route.methods)) {
          if (enabled && method !== '_all') out.push({ method, path: layer.route.path });
        }
      } else if (layer.handle?.stack) {
        walk(layer.handle.stack);
      }
    }
  };
  walk(app.router?.stack ?? []);
  return out;
}
