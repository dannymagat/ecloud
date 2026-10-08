/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument -- supertest response bodies are untyped JSON */
/**
 * Phase 6 P6-B portal administration against `ecloud_test` + a throwaway local storage root:
 * CRUD, uploads, terms, preview, permissions, audit and tenant isolation (API, RLS, storage key
 * prefix). Skipped with a message when ECLOUD_TEST_DATABASE_URL is unset / unreachable.
 */
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withTenant } from '@ecloud/db';
import { newId } from '@ecloud/shared';
import { createStorage, type ObjectStorage } from '@ecloud/storage';
import { describeIntegration, migrateTestDatabase } from '@ecloud/testing';
import { sql } from 'kysely';
import { generate } from 'otplib';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import type { AppDeps } from '../context.js';
import { MemoryKv } from '../kv.js';
import {
  TEST_INTERNAL_TOKEN,
  TEST_ORIGIN,
  closeDeps,
  countAudit,
  createAdmin,
  createTenant,
  integrationDeps,
  type AdminFixture,
} from '../test-support/deps.js';

type Agent = ReturnType<typeof request.agent>;
type Apps = ReturnType<typeof createApp>;

const BROWSER = { Origin: TEST_ORIGIN, 'X-Requested-With': 'XMLHttpRequest' };
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

await describeIntegration('@ecloud/api portal administration (P6-B) against ecloud_test', () => {
  let deps: AppDeps;
  let storageRoot: string;
  let storage: ObjectStorage;

  beforeAll(async () => {
    await migrateTestDatabase();
    storageRoot = await mkdtemp(join(tmpdir(), 'ecloud-p6b-'));
    storage = createStorage({ driver: 'local', localPath: storageRoot });
    deps = { ...integrationDeps(), storage };
  }, 60_000);

  afterAll(async () => {
    await closeDeps(deps);
    await storage.close();
    await rm(storageRoot, { recursive: true, force: true });
  });

  function freshApps(): Apps {
    return createApp({ ...deps, kv: new MemoryKv() });
  }

  async function login(apps: Apps, admin: AdminFixture): Promise<Agent> {
    const agent = request.agent(apps.publicApp);
    const res = await agent
      .post('/api/v1/auth/login')
      .set(BROWSER)
      .send({ email: admin.email, password: admin.password });
    expect(res.status).toBe(200);
    return agent;
  }

  async function tenantWithAdmin(apps: Apps, template = 'org_admin') {
    const tenant = await createTenant(deps.dbPlatform);
    const admin = await createAdmin(deps.dbPlatform, [
      { template, scope: 'organization', orgId: tenant.orgId },
    ]);
    return { ...tenant, agent: await login(apps, admin) };
  }

  function upload(agent: Agent, orgId: string, bytes: Buffer, type = 'image/png') {
    return agent
      .post(`/api/v1/orgs/${orgId}/portal-assets?filename=logo.png`)
      .set(BROWSER)
      .set('Content-Type', type)
      .send(bytes);
  }

  async function portalFixture(agent: Agent, orgId: string, siteId: string, slugSuffix: string) {
    const res = await agent
      .post(`/api/v1/orgs/${orgId}/captive-portals`)
      .set(BROWSER)
      .send({
        site_id: siteId,
        name: 'Lobby Wi-Fi',
        public_slug: `lobby-${slugSuffix}`,
        portal_type: 'uspot',
        network_ref: 'ssid-guest',
        auth_methods: ['password', 'voucher', 'click_through', 'voucher'],
        walled_garden: ['example.com'],
      });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as { id: string; auth_methods: string[] };
  }

  const slug = () => Math.random().toString(36).slice(2, 10);

  it('runs the designer flow: theme, logo upload, portal, terms, preview — all audited', async () => {
    const apps = freshApps();
    const { orgId, siteId, agent } = await tenantWithAdmin(apps);

    const asset = await upload(agent, orgId, PNG);
    expect(asset.status, JSON.stringify(asset.body)).toBe(201);
    expect(asset.body).toMatchObject({
      purpose: 'branding',
      content_type: 'image/png',
      byte_size: PNG.length,
      original_filename: 'logo.png',
    });
    expect(asset.body.url).toMatch(new RegExp(`/a/${asset.body.id as string}$`));
    expect(await countAudit(deps.dbPlatform, 'portal_asset:create', asset.body.id)).toBe(1);

    // storage key prefix: the object lives under org/{orgId}/branding/{assetId} and the row says so
    const row = await deps.dbPlatform
      .selectFrom('portal_assets')
      .selectAll()
      .where('id', '=', asset.body.id)
      .executeTakeFirstOrThrow();
    expect(row.storage_key).toBe(`org/${orgId}/branding/${asset.body.id as string}`);
    expect(row.organization_id).toBe(orgId);
    expect(await storage.head(row.storage_key)).toMatchObject({ size: PNG.length });
    const orgDirs = await readdir(join(storageRoot, 'objects', 'org'));
    expect(orgDirs).toContain(orgId);

    const content = await agent.get(`/api/v1/orgs/${orgId}/portal-assets/${asset.body.id}/content`);
    expect(content.status).toBe(200);
    expect(content.headers['content-type']).toBe('image/png');
    expect(content.headers['x-content-type-options']).toBe('nosniff');
    expect(Buffer.compare(content.body as Buffer, PNG)).toBe(0);

    const theme = await agent
      .post(`/api/v1/orgs/${orgId}/portal-themes`)
      .set(BROWSER)
      .send({
        name: `Brand ${slug()}`,
        colors: { brand: '#0B6BCB' },
        strings: { en: { welcome_title: 'Hello <b>guests</b>' } },
        logo_asset_id: asset.body.id,
      });
    expect(theme.status, JSON.stringify(theme.body)).toBe(201);
    expect(theme.body.colors.brand).toBe('#0b6bcb');
    expect(theme.body.logo_asset_id).toBe(asset.body.id);
    expect(theme.body.version).toBe(1);
    expect(theme.body).not.toHaveProperty('custom_css');

    const patched = await agent
      .patch(`/api/v1/orgs/${orgId}/portal-themes/${theme.body.id}`)
      .set(BROWSER)
      .set('If-Match', theme.headers.etag as string)
      .send({ colors: { background: '#ffffff' } });
    expect(patched.status).toBe(200);
    expect(patched.body.version).toBe(2);
    expect(patched.body.colors.brand).toBe('#0b6bcb');

    const portal = await portalFixture(agent, orgId, siteId, slug());
    expect(portal.auth_methods).toEqual(['password', 'voucher', 'click_through']);
    expect(portal).toMatchObject({ social_login: 'not_configured', uam_secret_configured: false });
    expect(portal).not.toHaveProperty('uam_secret_ref');
    const assigned = await agent
      .patch(`/api/v1/orgs/${orgId}/captive-portals/${portal.id}`)
      .set(BROWSER)
      .send({ theme_id: theme.body.id, auth_methods: ['voucher'] });
    expect(assigned.status).toBe(200);
    expect(assigned.body.theme_id).toBe(theme.body.id);

    const terms = await agent
      .post(`/api/v1/orgs/${orgId}/captive-portals/${portal.id}/terms`)
      .set(BROWSER)
      .send({ texts: { en: 'Be nice. <script>x</script>', ar: 'كن لطيفا' } });
    expect(terms.status, JSON.stringify(terms.body)).toBe(201);
    expect(terms.body.version).toBe('1');
    const terms2 = await agent
      .post(`/api/v1/orgs/${orgId}/captive-portals/${portal.id}/terms`)
      .set(BROWSER)
      .send({ texts: { en: 'Version two' } });
    expect(terms2.body.version).toBe('2');
    const listed = await agent.get(`/api/v1/orgs/${orgId}/captive-portals/${portal.id}/terms`);
    expect(listed.body.current_version).toBe('2');
    expect((listed.body.data as { version: number }[]).map((t) => t.version)).toEqual([2, 1, 1]);
    expect(await countAudit(deps.dbPlatform, 'captive_portal:update', portal.id)).toBe(3);

    const ticket = await agent
      .post(`/api/v1/orgs/${orgId}/portal-previews`)
      .set(BROWSER)
      .send({
        page: 'landing',
        captive_portal_id: portal.id,
        draft: { strings: { en: { welcome_text: 'Draft <i>text</i>' } } },
      });
    expect(ticket.status, JSON.stringify(ticket.body)).toBe(201);
    const html = await agent.get(ticket.body.preview_url as string);
    expect(html.status).toBe(200);
    expect(html.headers['content-type']).toMatch(/^text\/html/);
    expect(html.headers['content-security-policy']).toContain("default-src 'none'");
    expect(html.headers['content-security-policy']).toContain('sandbox');
    expect(html.text).toContain('Draft &lt;i&gt;text&lt;/i&gt;');
    expect(html.text).not.toContain('<i>text</i>');
    expect(html.text).toContain('data:image/png;base64,');
    expect(html.text).toContain('Use voucher'); // only voucher enabled after the PATCH
    expect(html.text).not.toContain('type="password"');

    const termsPage = await agent
      .post(`/api/v1/orgs/${orgId}/portal-previews`)
      .set(BROWSER)
      .send({ page: 'terms', locale: 'ar', captive_portal_id: portal.id });
    const termsHtml = await agent.get(termsPage.body.preview_url as string);
    expect(termsHtml.text).toContain('dir="rtl"');
    expect(termsHtml.text).toContain('Version two'); // v2 has no ar text: English fallback

    // A theme in use keeps its logo: the asset cannot be deleted, then can after unassigning
    const blocked = await agent
      .delete(`/api/v1/orgs/${orgId}/portal-assets/${asset.body.id}`)
      .set(BROWSER);
    expect(blocked.status).toBe(409);
    await agent
      .patch(`/api/v1/orgs/${orgId}/portal-themes/${theme.body.id}`)
      .set(BROWSER)
      .send({ logo_asset_id: null })
      .expect(200);
    await agent
      .delete(`/api/v1/orgs/${orgId}/portal-assets/${asset.body.id}`)
      .set(BROWSER)
      .expect(204);
    expect(await storage.head(row.storage_key)).toBeNull();
    expect(await countAudit(deps.dbPlatform, 'portal_asset:delete', asset.body.id)).toBe(1);

    // portal delete cascades its terms versions
    await agent
      .delete(`/api/v1/orgs/${orgId}/captive-portals/${portal.id}`)
      .set(BROWSER)
      .expect(204);
    const left = await deps.dbPlatform
      .selectFrom('portal_terms_versions')
      .select('id')
      .where('captive_portal_id', '=', portal.id)
      .execute();
    expect(left).toEqual([]);
  });

  it('validates uploads: type allow-list, magic bytes, size, authentication', async () => {
    const apps = freshApps();
    const { orgId, agent } = await tenantWithAdmin(apps);
    const html = await upload(agent, orgId, Buffer.from('<html><script>1</script>'), 'text/html');
    expect(html.status).toBe(415);
    const svg = await upload(agent, orgId, Buffer.from('<svg/>'), 'image/svg+xml');
    expect(svg.status).toBe(415);
    const disguised = await upload(
      agent,
      orgId,
      Buffer.from('<html>not a png</html>'),
      'image/png',
    );
    expect(disguised.status).toBe(415);
    const mislabeled = await upload(agent, orgId, PNG, 'image/jpeg');
    expect(mislabeled.status).toBe(415);
    const big = Buffer.alloc(5 * 1024 * 1024 + 1);
    PNG.copy(big);
    const tooLarge = await upload(agent, orgId, big);
    expect(tooLarge.status).toBe(413);
    const anonymous = await request(apps.publicApp)
      .post(`/api/v1/orgs/${orgId}/portal-assets`)
      .set('Content-Type', 'image/png')
      .send(PNG);
    expect(anonymous.status).toBe(401);
    // nothing was stored for the rejected uploads
    const listed = await agent.get(`/api/v1/orgs/${orgId}/portal-assets`);
    expect(listed.body.data).toEqual([]);
    expect(await storage.list(`org/${orgId}/`)).toEqual([]);
  });

  it('rejects low-contrast palettes and unknown tokens / custom CSS', async () => {
    const apps = freshApps();
    const { orgId, agent } = await tenantWithAdmin(apps);
    const low = await agent
      .post(`/api/v1/orgs/${orgId}/portal-themes`)
      .set(BROWSER)
      .send({ name: 'Low', colors: { text: '#cccccc', background: '#ffffff' } });
    expect(low.status).toBe(422);
    expect(low.body.contrast_issues[0]).toMatchObject({ foreground: 'text' });
    const css = await agent
      .post(`/api/v1/orgs/${orgId}/portal-themes`)
      .set(BROWSER)
      .send({ name: 'Css', custom_css: 'body{}' });
    expect(css.status).toBe(400);
    const notHex = await agent
      .post(`/api/v1/orgs/${orgId}/portal-themes`)
      .set(BROWSER)
      .send({ name: 'Url', colors: { brand: 'url(https://evil.test/x)' } });
    expect(notHex.status).toBe(400);
    const idp = await agent
      .post(`/api/v1/orgs/${orgId}/captive-portals`)
      .set(BROWSER)
      .send({
        site_id: newId(),
        name: 'x',
        public_slug: `x-${slug()}`,
        portal_type: 'uspot',
        network_ref: 'n',
        auth_methods: ['idp'],
      });
    expect(idp.status).toBe(400);
  });

  it('keeps portals, themes, assets, terms and previews tenant-isolated', async () => {
    const apps = freshApps();
    const a = await tenantWithAdmin(apps);
    const b = await tenantWithAdmin(apps);
    const assetA = (await upload(a.agent, a.orgId, PNG)).body as { id: string };
    const themeA = (
      await a.agent
        .post(`/api/v1/orgs/${a.orgId}/portal-themes`)
        .set(BROWSER)
        .send({ name: `A ${slug()}`, logo_asset_id: assetA.id })
    ).body as { id: string };
    const portalA = await portalFixture(a.agent, a.orgId, a.siteId, slug());

    // B through its own org path: A's ids do not exist (404), lists are empty
    for (const path of [
      `portal-themes/${themeA.id}`,
      `portal-assets/${assetA.id}`,
      `portal-assets/${assetA.id}/content`,
      `captive-portals/${portalA.id}`,
      `captive-portals/${portalA.id}/terms`,
    ]) {
      const res = await b.agent.get(`/api/v1/orgs/${b.orgId}/${path}`);
      expect(res.status, path).toBe(404);
    }
    expect((await b.agent.get(`/api/v1/orgs/${b.orgId}/portal-themes`)).body.data).toEqual([]);
    expect((await b.agent.get(`/api/v1/orgs/${b.orgId}/portal-assets`)).body.data).toEqual([]);
    // B through A's org path: forbidden before anything is read
    for (const path of [`portal-themes/${themeA.id}`, `portal-assets/${assetA.id}/content`]) {
      expect((await b.agent.get(`/api/v1/orgs/${a.orgId}/${path}`)).status, path).toBe(403);
    }
    expect((await upload(b.agent, a.orgId, PNG)).status).toBe(403);
    // G9: B cannot reference A's theme / asset from its own objects
    const crossTheme = await b.agent
      .post(`/api/v1/orgs/${b.orgId}/captive-portals`)
      .set(BROWSER)
      .send({
        site_id: b.siteId,
        name: 'x',
        public_slug: `b-${slug()}`,
        portal_type: 'uspot',
        network_ref: 'n',
        theme_id: themeA.id,
      });
    expect(crossTheme.status).toBe(404);
    const crossLogo = await b.agent
      .post(`/api/v1/orgs/${b.orgId}/portal-themes`)
      .set(BROWSER)
      .send({ name: 'B', logo_asset_id: assetA.id });
    expect(crossLogo.status).toBe(404);
    const crossPreview = await b.agent
      .post(`/api/v1/orgs/${b.orgId}/portal-previews`)
      .set(BROWSER)
      .send({ page: 'login', theme_id: themeA.id });
    expect(crossPreview.status).toBe(404);
    // a preview ticket is bound to its creator and organization
    const ticket = await a.agent
      .post(`/api/v1/orgs/${a.orgId}/portal-previews`)
      .set(BROWSER)
      .send({ page: 'login', theme_id: themeA.id });
    expect(ticket.status).toBe(201);
    const token = (ticket.body.preview_url as string).split('/').pop() as string;
    expect((await b.agent.get(`/api/v1/orgs/${b.orgId}/portal-previews/${token}`)).status).toBe(
      404,
    );

    // RLS: the app role in tenant B sees none of A's rows
    const seen = await withTenant(deps.db, b.orgId, async (trx) => ({
      assets: await trx.selectFrom('portal_assets').select('id').execute(),
      terms: await trx.selectFrom('portal_terms_versions').select('id').execute(),
      themes: await trx.selectFrom('portal_themes').select('id').execute(),
    }));
    expect(seen).toEqual({ assets: [], terms: [], themes: [] });

    // DB-level key pinning: a row cannot point into another tenant's storage prefix
    const forged = newId();
    await expect(
      deps.dbPlatform
        .insertInto('portal_assets')
        .values({
          id: forged,
          organization_id: b.orgId,
          storage_key: `org/${a.orgId}/branding/${assetA.id}`,
          content_type: 'image/png',
          byte_size: 10,
          sha256: 'a'.repeat(64),
        })
        .execute(),
    ).rejects.toMatchObject({ code: '23514', constraint: 'ck_portal_assets_storage_key' });

    // terms versions are immutable for the application role
    await a.agent
      .post(`/api/v1/orgs/${a.orgId}/captive-portals/${portalA.id}/terms`)
      .set(BROWSER)
      .send({ texts: { en: 'v1' } })
      .expect(201);
    await expect(
      withTenant(deps.db, a.orgId, (trx) =>
        sql`UPDATE portal_terms_versions SET body = 'changed'`.execute(trx),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('gives operators read-only access and site admins their own site only', async () => {
    const apps = freshApps();
    const owner = await tenantWithAdmin(apps);
    const asset = (await upload(owner.agent, owner.orgId, PNG)).body as { id: string };
    const theme = (
      await owner.agent
        .post(`/api/v1/orgs/${owner.orgId}/portal-themes`)
        .set(BROWSER)
        .send({ name: `T ${slug()}` })
    ).body as { id: string };
    const portalA = await portalFixture(owner.agent, owner.orgId, owner.siteId, slug());
    const portalB = await portalFixture(owner.agent, owner.orgId, owner.siteId2, slug());

    const operator = await createAdmin(deps.dbPlatform, [
      { template: 'operator', scope: 'organization', orgId: owner.orgId },
    ]);
    const op = await login(apps, operator);
    const o = `/api/v1/orgs/${owner.orgId}`;
    expect((await op.get(`${o}/captive-portals`)).body.data).toHaveLength(2);
    expect((await op.get(`${o}/portal-themes/${theme.id}`)).status).toBe(200);
    expect((await op.get(`${o}/portal-assets/${asset.id}`)).status).toBe(200);
    expect((await op.post(`${o}/portal-themes`).set(BROWSER).send({ name: 'nope' })).status).toBe(
      403,
    );
    expect((await upload(op, owner.orgId, PNG)).status).toBe(403);
    expect(
      (await op.patch(`${o}/captive-portals/${portalA.id}`).set(BROWSER).send({ name: 'x' }))
        .status,
    ).toBe(403);
    expect(
      (
        await op
          .post(`${o}/captive-portals/${portalA.id}/terms`)
          .set(BROWSER)
          .send({ texts: { en: 'x' } })
      ).status,
    ).toBe(403);
    expect((await op.delete(`${o}/portal-assets/${asset.id}`).set(BROWSER)).status).toBe(403);

    const siteAdmin = await createAdmin(deps.dbPlatform, [
      { template: 'site_admin', scope: 'site', orgId: owner.orgId, siteId: owner.siteId },
    ]);
    const sa = await login(apps, siteAdmin);
    const list = await sa.get(`${o}/captive-portals`);
    expect((list.body.data as { id: string }[]).map((p) => p.id)).toEqual([portalA.id]);
    expect(
      (await sa.patch(`${o}/captive-portals/${portalA.id}`).set(BROWSER).send({ name: 'Mine' }))
        .status,
    ).toBe(200);
    expect(
      (await sa.patch(`${o}/captive-portals/${portalB.id}`).set(BROWSER).send({ name: 'x' }))
        .status,
    ).toBe(404);
    expect((await sa.get(`${o}/portal-themes`)).status).toBe(403);
  });

  async function auditRowsFor(targetId: string): Promise<string> {
    const rows = await deps.dbPlatform
      .selectFrom('audit_logs')
      .select(['action', 'before', 'after'])
      .where('target_id', '=', targetId)
      .execute();
    return JSON.stringify(rows);
  }

  it('rotates the UAM secret write-only: shown once, sealed, never returned, logged or audited', async () => {
    const apps = freshApps();
    const { orgId, siteId, agent } = await tenantWithAdmin(apps);
    const portal = await portalFixture(agent, orgId, siteId, slug());
    expect(portal).toMatchObject({ uam_secret_configured: false });

    const key = newId();
    const rotate = await agent
      .post(`/api/v1/orgs/${orgId}/captive-portals/${portal.id}/rotate-uam-secret`)
      .set(BROWSER)
      .set('Idempotency-Key', key);
    expect(rotate.status, JSON.stringify(rotate.body)).toBe(200);
    const secret = rotate.body.uam_secret as string;
    expect(secret).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(rotate.body.uam_secret_configured).toBe(true);
    expect(rotate.headers['cache-control']).toBe('no-store');

    // an idempotent replay does not hand out the secret a second time
    const replay = await agent
      .post(`/api/v1/orgs/${orgId}/captive-portals/${portal.id}/rotate-uam-secret`)
      .set(BROWSER)
      .set('Idempotency-Key', key);
    expect(JSON.stringify(replay.body)).not.toContain(secret);

    const stored = await deps.dbPlatform
      .selectFrom('captive_portals')
      .select('uam_secret_ref')
      .where('id', '=', portal.id)
      .executeTakeFirstOrThrow();
    expect(stored.uam_secret_ref).toMatch(/^enc:v1\./);
    expect(stored.uam_secret_ref).not.toContain(secret);

    // reads and PATCH responses never carry the secret or its sealed form
    const read = await agent.get(`/api/v1/orgs/${orgId}/captive-portals/${portal.id}`);
    const list = await agent.get(`/api/v1/orgs/${orgId}/captive-portals`);
    const patched = await agent
      .patch(`/api/v1/orgs/${orgId}/captive-portals/${portal.id}`)
      .set(BROWSER)
      .send({ name: 'Renamed' });
    expect(patched.status).toBe(200);
    for (const body of [read.body, list.body, patched.body]) {
      const text = JSON.stringify(body);
      expect(text).not.toContain(secret);
      expect(text).not.toContain('enc:v1');
      expect(text).not.toContain('uam_secret_ref');
    }
    expect(read.body.uam_secret_configured).toBe(true);
    expect(patched.body.uam_secret_configured).toBe(true);

    // audit: create, rotate, patch and delete rows exist, none holds the secret or the envelope
    await agent
      .delete(`/api/v1/orgs/${orgId}/captive-portals/${portal.id}`)
      .set(BROWSER)
      .expect(204);
    expect(await countAudit(deps.dbPlatform, 'captive_portal:secret:rotate', portal.id)).toBe(1);
    expect(await countAudit(deps.dbPlatform, 'captive_portal:delete', portal.id)).toBe(1);
    const audit = await auditRowsFor(portal.id);
    expect(audit).not.toContain(secret);
    expect(audit).not.toContain('enc:v1');
    expect(audit).not.toContain('uam_secret_ref');
  });

  it('allows secret rotation to org_admin only, not to operators or site admins', async () => {
    const apps = freshApps();
    const owner = await tenantWithAdmin(apps);
    const portal = await portalFixture(owner.agent, owner.orgId, owner.siteId, slug());
    const path = `/api/v1/orgs/${owner.orgId}/captive-portals/${portal.id}/rotate-uam-secret`;
    const operator = await login(
      apps,
      await createAdmin(deps.dbPlatform, [
        { template: 'operator', scope: 'organization', orgId: owner.orgId },
      ]),
    );
    const siteAdmin = await login(
      apps,
      await createAdmin(deps.dbPlatform, [
        { template: 'site_admin', scope: 'site', orgId: owner.orgId, siteId: owner.siteId },
      ]),
    );
    for (const agent of [operator, siteAdmin]) {
      expect((await agent.post(path).set(BROWSER).set('Idempotency-Key', newId())).status).toBe(
        403,
      );
    }
    // Idempotency-Key is required
    expect((await owner.agent.post(path).set(BROWSER)).status).toBe(428);
    const other = await tenantWithAdmin(apps);
    expect(
      (
        await other.agent
          .post(`/api/v1/orgs/${other.orgId}/captive-portals/${portal.id}/rotate-uam-secret`)
          .set(BROWSER)
          .set('Idempotency-Key', newId())
      ).status,
    ).toBe(404);
  });

  it('under impersonation: portal edits follow the impersonation template, secrets are refused (D-027)', async () => {
    const apps = freshApps();
    const { orgId, siteId, agent: owner } = await tenantWithAdmin(apps);
    const portal = await portalFixture(owner, orgId, siteId, slug());
    const support = await createAdmin(deps.dbPlatform, [
      { template: 'platform_support', scope: 'platform' },
    ]);
    const agent = await login(apps, support);
    const enrol = await agent.post('/api/v1/auth/mfa/enrol').set(BROWSER);
    await agent
      .post('/api/v1/auth/mfa/confirm')
      .set(BROWSER)
      .send({ code: await generate({ secret: enrol.body.secret as string }) });
    const start = await agent
      .post('/api/v1/platform/support/impersonate')
      .set(BROWSER)
      .send({ organizationId: orgId, reason: 'portal support ticket', ttlMinutes: 15 });
    expect(start.status).toBe(201);

    const o = `/api/v1/orgs/${orgId}`;
    const patched = await agent
      .patch(`${o}/captive-portals/${portal.id}`)
      .set(BROWSER)
      .send({ name: 'Fixed by support' });
    expect(patched.status).toBe(200);
    const theme = await agent
      .post(`${o}/portal-themes`)
      .set(BROWSER)
      .send({ name: `S ${slug()}` });
    expect(theme.status).toBe(201);
    const rotate = await agent
      .post(`${o}/captive-portals/${portal.id}/rotate-uam-secret`)
      .set(BROWSER)
      .set('Idempotency-Key', newId());
    expect(rotate.status).toBe(403);
    expect(rotate.body.type).toBe('urn:ecloud:problem:impersonation-forbidden');
    expect(await countAudit(deps.dbPlatform, 'captive_portal:secret:rotate', portal.id)).toBe(0);
    // the impersonator is recorded on the audit row of the change
    const row = await deps.dbPlatform
      .selectFrom('audit_logs')
      .select(['impersonator_id'])
      .where('action', '=', 'captive_portal:update')
      .where('target_id', '=', portal.id)
      .executeTakeFirstOrThrow();
    expect(row.impersonator_id).toBe(support.id);
    await agent.delete('/api/v1/platform/support/impersonate').set(BROWSER);
  });

  it('sets the NAS pin and UAM server URL (validated, audited, clearable)', async () => {
    const apps = freshApps();
    const a = await tenantWithAdmin(apps);
    const b = await tenantWithAdmin(apps);
    const ip = () =>
      `10.${String(Math.floor(Math.random() * 250) + 2)}.9.${String(Math.floor(Math.random() * 250) + 2)}`;
    const nas = async (t: typeof a, siteId: string) =>
      (
        await t.agent
          .post(`/api/v1/orgs/${t.orgId}/nas`)
          .set(BROWSER)
          .send({ site_id: siteId, name: 'ap', nas_ip: ip(), adapter_key: 'openwifi-uspot-uam' })
      ).body as { id: string };
    const nasA = await nas(a, a.siteId);
    const nasOtherSite = await nas(a, a.siteId2);
    const nasB = await nas(b, b.siteId);
    const portalOrigin = deps.config.base.origins.portal.replace(/\/+$/, '');
    const o = `/api/v1/orgs/${a.orgId}`;

    const created = await a.agent
      .post(`${o}/captive-portals`)
      .set(BROWSER)
      .send({
        site_id: a.siteId,
        name: 'Pinned',
        public_slug: `pin-${slug()}`,
        portal_type: 'uspot',
        network_ref: 'ssid-pin',
        nas_client_id: nasA.id,
        uam_server_url: `${portalOrigin}/uam/uspot/`,
      });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.adapter_config).toEqual({
      nas_client_id: nasA.id,
      uam_server_url: `${portalOrigin}/uam/uspot/`,
    });
    expect(created.body).not.toHaveProperty('nas_client_id');
    expect(created.body.uam_secret_configured).toBe(false); // no secret is created implicitly
    const id = created.body.id as string;

    const reject = async (body: object, status: number) => {
      const res = await a.agent.patch(`${o}/captive-portals/${id}`).set(BROWSER).send(body);
      expect(res.status, JSON.stringify(body)).toBe(status);
    };
    await reject({ uam_server_url: 'https://evil.test/uam/uspot/' }, 400);
    await reject({ uam_server_url: `${portalOrigin}/uam/chilli/` }, 400);
    await reject({ portal_type: 'coovachilli' }, 400); // stored URL no longer matches the type
    await reject({ nas_client_id: nasOtherSite.id }, 422);
    await reject({ nas_client_id: nasB.id }, 404);
    await reject({ nas_client_id: newId() }, 404);

    const cleared = await a.agent
      .patch(`${o}/captive-portals/${id}`)
      .set(BROWSER)
      .send({ uam_server_url: null, nas_client_id: null, portal_type: 'coovachilli' });
    expect(cleared.status).toBe(200);
    expect(cleared.body.adapter_config).toEqual({});
    const audit = await auditRowsFor(id);
    expect(audit).toContain(nasA.id);
    expect(audit).toContain('/uam/uspot/');
    expect(await countAudit(deps.dbPlatform, 'captive_portal:update', id)).toBe(1);
  });

  it('022: the logo FK closes the delete/assign race and pins logos to the same tenant', async () => {
    const apps = freshApps();
    const a = await tenantWithAdmin(apps);
    const b = await tenantWithAdmin(apps);
    const asset = (await upload(a.agent, a.orgId, PNG)).body as { id: string };
    const theme = (
      await a.agent
        .post(`/api/v1/orgs/${a.orgId}/portal-themes`)
        .set(BROWSER)
        .send({ name: `R ${slug()}`, logo_asset_id: asset.id })
    ).body as { id: string };
    // the race: the reference check already passed, the row delete must still be refused
    await expect(
      withTenant(deps.db, a.orgId, (trx) =>
        trx.deleteFrom('portal_assets').where('id', '=', asset.id).execute(),
      ),
    ).rejects.toMatchObject({ code: '23503', constraint: 'fk_portal_themes_logo_asset' });
    // and the API answers 409, the object stays
    expect(
      (await a.agent.delete(`/api/v1/orgs/${a.orgId}/portal-assets/${asset.id}`).set(BROWSER))
        .status,
    ).toBe(409);
    expect(await storage.head(`org/${a.orgId}/branding/${asset.id}`)).not.toBeNull();
    // a theme of B cannot point at A's asset even through the platform role
    const themeB = (
      await b.agent
        .post(`/api/v1/orgs/${b.orgId}/portal-themes`)
        .set(BROWSER)
        .send({ name: `B ${slug()}` })
    ).body as { id: string };
    await expect(
      deps.dbPlatform
        .updateTable('portal_themes')
        .set({ logo_asset_ref: asset.id })
        .where('id', '=', themeB.id)
        .execute(),
    ).rejects.toMatchObject({ code: '23503' });
    expect(theme.id).toBeTruthy();
  });

  describe('internal asset endpoint (portal origin /a/{assetId})', () => {
    it('serves bytes with the stored type, nosniff and immutable caching behind the token', async () => {
      const apps = freshApps();
      const { orgId, agent } = await tenantWithAdmin(apps);
      const asset = (await upload(agent, orgId, PNG)).body as { id: string };
      const res = await request(apps.internalApp)
        .get(`/internal/portal-assets/${asset.id}`)
        .set('X-Internal-Token', TEST_INTERNAL_TOKEN);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('image/png');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['cache-control']).toBe('public, max-age=86400');
      expect(Buffer.compare(res.body as Buffer, PNG)).toBe(0);
      const cached = await request(apps.internalApp)
        .get(`/internal/portal-assets/${asset.id}`)
        .set('X-Internal-Token', TEST_INTERNAL_TOKEN)
        .set('If-None-Match', res.headers.etag as string);
      expect(cached.status).toBe(304);
      expect(
        (await request(apps.internalApp).get(`/internal/portal-assets/${asset.id}`)).status,
      ).toBe(401);
      for (const id of [newId(), 'not-a-uuid', '..%2F..%2Fetc']) {
        const missing = await request(apps.internalApp)
          .get(`/internal/portal-assets/${id}`)
          .set('X-Internal-Token', TEST_INTERNAL_TOKEN);
        expect(missing.status, id).toBe(404);
      }
      // the object file is private to the service user
      const file = await stat(join(storageRoot, 'objects', 'org', orgId));
      expect(file.mode & 0o077).toBe(0);
    });
  });
});
