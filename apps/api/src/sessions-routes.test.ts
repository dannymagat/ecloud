/**
 * P8-A routes without a database: authentication, OpenAPI coverage and permission keys.
 */
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { unitDeps } from './test-support/deps.js';

const { publicApp, openapi, routes } = createApp(unitDeps());

const P8_ROUTES: [string, string, string][] = [
  ['get', '/api/v1/orgs/:orgId/sessions', 'session:read'],
  ['get', '/api/v1/orgs/:orgId/sessions/:id', 'session:read'],
  ['post', '/api/v1/orgs/:orgId/sessions/:id/disconnect', 'session:disconnect'],
  ['post', '/api/v1/orgs/:orgId/sessions/:id/reauthorize', 'session:coa'],
  ['get', '/api/v1/orgs/:orgId/session-actions/:id', 'session:read'],
  ['get', '/api/v1/orgs/:orgId/usage', 'accounting:read'],
  ['get', '/api/v1/orgs/:orgId/usage/top', 'accounting:read'],
  ['post', '/api/v1/orgs/:orgId/usage/export', 'report:export'],
  ['get', '/api/v1/orgs/:orgId/accounting/records', 'accounting:read'],
  ['post', '/api/v1/orgs/:orgId/accounting/export', 'accounting:export'],
  ['get', '/api/v1/platform/retention/plan', 'platform:health:read'],
];

describe('P8-A sessions & accounting routes', () => {
  it('are defined with the catalogue permissions and documented in OpenAPI', () => {
    const doc = openapi as { paths: Record<string, Record<string, unknown>> };
    for (const [method, path, permission] of P8_ROUTES) {
      const route = routes.find((r) => r.method === method && r.path === path);
      expect(route, `${method} ${path}`).toBeDefined();
      expect(route?.permission).toBe(permission);
      const oaPath = path.replace(/:([A-Za-z]+)/g, '{$1}');
      expect(doc.paths[oaPath]?.[method], `${method} ${oaPath}`).toBeDefined();
    }
  });

  it('require authentication', async () => {
    const org = '0192aa00-0000-7000-8000-000000000001';
    const id = '0192aa00-0000-7000-8000-000000000002';
    for (const [method, path] of P8_ROUTES) {
      const url = path.replace(':orgId', org).replace(':id', id);
      const res =
        method === 'get'
          ? await request(publicApp).get(url)
          : await request(publicApp)
              .post(url)
              .set('Origin', 'http://admin.test.local')
              .set('X-Requested-With', 'XMLHttpRequest')
              .send({});
      expect(res.status, `${method} ${url}`).toBe(401);
      expect(res.headers['content-type']).toContain('application/problem+json');
    }
  });
});
