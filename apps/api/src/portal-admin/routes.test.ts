/* eslint-disable @typescript-eslint/no-unsafe-member-access -- OpenAPI and supertest bodies are untyped JSON */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newId } from '@ecloud/shared';
import { createStorage } from '@ecloud/storage';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { TEST_INTERNAL_TOKEN, closeDeps, unitDeps } from '../test-support/deps.js';
import { PortalCreate, ThemeCreate, portalAdapterConfig } from './routes.js';

const deps = unitDeps();
const { publicApp, internalApp, routes, openapi } = createApp(deps);

afterAll(async () => {
  await closeDeps(deps);
});

describe('portal administration routes (unit, no database)', () => {
  it('registers every P6-B endpoint with a catalogued permission', () => {
    const table = routes
      .filter((r) => /captive-portals|portal-themes|portal-assets|portal-previews/.test(r.path))
      .map((r) => `${r.method.toUpperCase()} ${r.path} ${r.permission ?? ''}`);
    expect(table).toEqual(
      expect.arrayContaining([
        'GET /api/v1/orgs/:orgId/captive-portals captive_portal:read',
        'POST /api/v1/orgs/:orgId/captive-portals captive_portal:create',
        'PATCH /api/v1/orgs/:orgId/captive-portals/:id captive_portal:update',
        'DELETE /api/v1/orgs/:orgId/captive-portals/:id captive_portal:delete',
        'GET /api/v1/orgs/:orgId/captive-portals/:id/terms captive_portal:read',
        'POST /api/v1/orgs/:orgId/captive-portals/:id/terms captive_portal:update',
        'POST /api/v1/orgs/:orgId/portal-themes portal_theme:create',
        'PATCH /api/v1/orgs/:orgId/portal-themes/:id portal_theme:update',
        'POST /api/v1/orgs/:orgId/portal-assets portal_asset:create',
        'GET /api/v1/orgs/:orgId/portal-assets/:id/content portal_asset:read',
        'DELETE /api/v1/orgs/:orgId/portal-assets/:id portal_asset:delete',
        'POST /api/v1/orgs/:orgId/portal-previews portal_theme:read',
        'POST /api/v1/orgs/:orgId/captive-portals/:id/rotate-uam-secret captive_portal:secret:rotate',
        'GET /api/v1/orgs/:orgId/portal-previews/:token portal_theme:read',
      ]),
    );
  });

  it('documents the binary upload body in OpenAPI', () => {
    const doc = openapi as { paths: Record<string, Record<string, unknown>> };
    const post = doc.paths['/api/v1/orgs/{orgId}/portal-assets']?.post as {
      requestBody: { content: Record<string, { schema: { format: string } }> };
    };
    expect(Object.keys(post.requestBody.content)).toEqual([
      'image/png',
      'image/jpeg',
      'image/webp',
    ]);
    expect(post.requestBody.content['image/png']?.schema.format).toBe('binary');
  });

  it('refuses anonymous uploads (the access check runs before the body parser)', async () => {
    const res = await request(publicApp)
      .post(`/api/v1/orgs/${newId()}/portal-assets`)
      .set('Content-Type', 'image/png')
      .send(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    expect(res.status).toBe(401);
  });

  it('answers 404 on the internal asset endpoint without storage, 401 without the token', async () => {
    expect((await request(internalApp).get(`/internal/portal-assets/${newId()}`)).status).toBe(401);
    const res = await request(internalApp)
      .get(`/internal/portal-assets/${newId()}`)
      .set('X-Internal-Token', TEST_INTERNAL_TOKEN);
    expect(res.status).toBe(404);
  });

  it('adds object storage to readiness when configured', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ecloud-ready-'));
    const storage = createStorage({ driver: 'local', localPath: root });
    try {
      const withStorage = createApp({ ...deps, storage });
      const res = await request(withStorage.publicApp).get('/readyz');
      expect(res.body.checks).toEqual({ database: 'unavailable', redis: 'ok', storage: 'ok' });
    } finally {
      await storage.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('validates theme and portal bodies', () => {
    expect(ThemeCreate.safeParse({ name: 'x', colors: { brand: '#12345g' } }).success).toBe(false);
    expect(ThemeCreate.safeParse({ name: 'x', colors: { unknown: '#123456' } }).success).toBe(
      false,
    );
    expect(
      ThemeCreate.safeParse({ name: 'x', strings: { 'not a locale': { welcome_title: 'x' } } })
        .success,
    ).toBe(false);
    const base = {
      site_id: newId(),
      name: 'p',
      public_slug: 'lobby',
      portal_type: 'uspot',
      network_ref: 'ssid',
    };
    expect(PortalCreate.safeParse({ ...base, auth_methods: ['mac'] }).success).toBe(false);
    expect(PortalCreate.safeParse({ ...base, redirect_url: 'javascript:alert(1)' }).success).toBe(
      false,
    );
    expect(PortalCreate.safeParse({ ...base, walled_garden: ['http://x'] }).success).toBe(false);
    expect(PortalCreate.safeParse({ ...base, public_slug: 'Bad Slug' }).success).toBe(false);
    expect(PortalCreate.parse({ ...base, walled_garden: ['*.Example.com'] }).walled_garden).toEqual(
      ['*.example.com'],
    );
  });

  it('accepts uam_server_url only on the portal origin with the UAM path of the portal type', async () => {
    const trx = {} as Parameters<typeof portalAdapterConfig>[0]; // no NAS pin: never queried
    const https = 'https://portal.example.test';
    const site = newId();
    const set = (url: string | null, type = 'uspot', origin = https, current = {}) =>
      portalAdapterConfig(trx, current, { uam_server_url: url }, type, site, origin);
    await expect(set(`${https}/uam/uspot/`)).resolves.toEqual({
      uam_server_url: `${https}/uam/uspot/`,
    });
    await expect(set(`${https}/uam/chilli/`, 'coovachilli')).resolves.toMatchObject({});
    for (const bad of [
      'https://evil.test/uam/uspot/',
      'http://portal.example.test/uam/uspot/',
      `${https}:8443/uam/uspot/`,
      `${https}/uam/chilli/`,
      `${https}/uam/uspot/?x=1`,
      `${https}/uam/uspot/#f`,
      'https://user:pw@portal.example.test/uam/uspot/',
      'javascript:alert(1)',
    ]) {
      await expect(set(bad), bad).rejects.toMatchObject({ status: 400 });
    }
    await expect(set(`${https}/uam/uspot/`, 'external')).rejects.toMatchObject({ status: 400 });
    // http only when the configured portal origin is itself http (local dev)
    await expect(
      set('http://localhost:3002/uam/uspot/', 'uspot', 'http://localhost:3002'),
    ).resolves.toMatchObject({ uam_server_url: 'http://localhost:3002/uam/uspot/' });
    // null removes the key and keeps unrelated adapter_config keys
    await expect(set(null, 'uspot', https, { uam_server_url: 'x', other: 1 })).resolves.toEqual({
      other: 1,
    });
  });
});
