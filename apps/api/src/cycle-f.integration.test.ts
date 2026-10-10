/* eslint-disable @typescript-eslint/no-unsafe-member-access -- supertest response bodies are untyped JSON */
/**
 * Multi-vendor Cycle F: the "How to configure your access points" gallery API against the test
 * database:
 *  - catalogue: every required vendor / product line, adapter + profile, evidence-derived status
 *    (no "Tested on device" today), long-tail vendors on the generic profile;
 *  - guide: ECLOUD values from configuration (portal origin, RADIUS_ADVERTISED_*), never a
 *    secret (a freshly created NAS secret appears in no guide), honest warnings;
 *  - tenant scope (another organization's admin, another organization's site) and permission
 *    (`nas:read`; a custom role without it gets 403; a site-scoped admin is limited to its site).
 * Skipped without the dev stack (ECLOUD_TEST_DATABASE_URL).
 */
import { describeIntegration, migrateTestDatabase } from '@ecloud/testing';
import { newId } from '@ecloud/shared';
import request from 'supertest';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createApp } from './app.js';
import type { AppDeps } from './context.js';
import { MemoryKv } from './kv.js';
import {
  TEST_ORIGIN,
  closeDeps,
  createAdmin,
  createTenant,
  integrationDeps,
  unique,
  type AdminFixture,
} from './test-support/deps.js';

type Agent = ReturnType<typeof request.agent>;
type Apps = ReturnType<typeof createApp>;

const BROWSER = { Origin: TEST_ORIGIN, 'X-Requested-With': 'XMLHttpRequest' };
// RFC 5737 documentation address: a test value, not a deployment address.
const RADIUS_ADDRESS = '192.0.2.53';

/** Every vendor / product line the gallery must cover (Cycle F scope item 3). */
const REQUIRED: readonly [string, string, string | null][] = [
  ['ezeap-openwifi', 'openwifi-uspot-uam', null],
  ['openwrt-uspot', 'uspot-upstream-uam', null],
  ['coovachilli', 'coovachilli-uam', null],
  ['teltonika', 'coovachilli-uam', null],
  ['mikrotik', 'mikrotik-hotspot', null],
  ['cambium', 'external-portal-postback', 'cambium-hotspot'],
  ['aruba', 'external-portal-postback', 'aruba-ecp'],
  ['cisco-wlc', 'external-portal-postback', 'cisco-webauth'],
  ['cisco-meraki', 'meraki-splash', null],
  ['fortinet', 'external-portal-postback', 'fortinet-ecp'],
  ['ruckus', 'external-portal-postback', 'ruckus-wispr'],
  ['tplink-omada-portal', 'external-portal-postback', 'omada-external-portal'],
  ['tplink-omada-api', 'omada-api', null],
  ['ubiquiti-unifi', 'unifi-external-portal', null],
  ['juniper-mist', 'mist-guest-portal', null],
  ['huawei', 'external-portal-postback', 'huawei-portal'],
  ['generic-8021x', 'generic-radius-8021x', null],
];
const LONG_TAIL = [
  'grandstream',
  'engenius',
  'zyxel',
  'draytek',
  'ruijie',
  'extreme',
  'alcatel-lucent',
  'tanaza',
  'openmesh',
];

await describeIntegration('@ecloud/api multi-vendor Cycle F (setup-guide gallery)', () => {
  let base: AppDeps;
  let deps: AppDeps;
  let apps: Apps;

  beforeAll(async () => {
    await migrateTestDatabase();
    base = integrationDeps();
    deps = {
      ...base,
      kv: new MemoryKv(),
      config: {
        ...base.config,
        setupGuide: { ...base.config.setupGuide, radiusAddress: RADIUS_ADDRESS },
      },
    };
    apps = createApp(deps);
  }, 60_000);

  afterAll(async () => {
    await closeDeps(base);
  });

  async function login(admin: AdminFixture): Promise<Agent> {
    const agent = request.agent(apps.publicApp);
    const res = await agent
      .post('/api/v1/auth/login')
      .set(BROWSER)
      .send({ email: admin.email, password: admin.password });
    expect(res.status).toBe(200);
    return agent;
  }

  async function orgAdmin() {
    const tenant = await createTenant(deps.dbPlatform);
    const admin = await createAdmin(deps.dbPlatform, [
      { template: 'org_admin', scope: 'organization', orgId: tenant.orgId },
    ]);
    return { ...tenant, agent: await login(admin) };
  }

  it('catalogue: every required vendor with adapter, profile, family and an evidence-derived status', async () => {
    const { orgId, agent } = await orgAdmin();
    const res = await agent.get(`/api/v1/orgs/${orgId}/setup-guides`);
    expect(res.status).toBe(200);
    const data = res.body.data as {
      vendor_key: string;
      adapter_key: string;
      profile: string | null;
      family: string;
      status: string;
      status_label: string;
      display_name: string;
    }[];
    const byKey = new Map(data.map((e) => [e.vendor_key, e]));
    for (const [key, adapter, profile] of REQUIRED) {
      const e = byKey.get(key);
      expect(e, key).toBeDefined();
      expect(e?.adapter_key, key).toBe(adapter);
      expect(e?.profile, key).toBe(profile);
      expect(e?.status, key).toBe('documented');
      expect(e?.status_label, key).toBe('Documented, not yet device-tested');
    }
    for (const key of LONG_TAIL) {
      const e = byKey.get(key);
      expect(e?.adapter_key, key).toBe('external-portal-postback');
      expect(e?.profile, key).toBe('postback-generic');
      expect(e?.status_label, key).toBe('Via generic profile: needs a captured redirect');
    }
    // No LAB_VALIDATED / PRODUCTION_VALIDATED device-test evidence exists today.
    expect(data.some((e) => e.status === 'tested_on_device')).toBe(false);
    expect(new Set(data.map((e) => e.vendor_key)).size).toBe(data.length);
    expect((res.body.families as { key: string }[]).map((f) => f.key)).toContain('external-portal');
  });

  it('guide: Cambium with ECLOUD values from configuration and warnings, no secret', async () => {
    const { orgId, siteId, agent } = await orgAdmin();
    const res = await agent.get(`/api/v1/orgs/${orgId}/setup-guides/cambium?site_id=${siteId}`);
    expect(res.status).toBe(200);
    const origin = deps.config.base.origins.portal.replace(/\/+$/, '');
    expect(res.body.site).toEqual({ id: siteId, name: 'Site A' });
    expect(res.body.portal_url).toBe(`${origin}/pb/cambium-hotspot/<NAS_IDENTIFIER>/`);
    expect(res.body.walled_garden).toEqual([new URL(origin).host]);
    expect(res.body.radius).toEqual({
      address: RADIUS_ADDRESS,
      auth_port: 1812,
      acct_port: 1813,
      coa_port: deps.config.setupGuide.coaPort,
    });
    expect(res.body.add_nas).toEqual({
      adapter_key: 'external-portal-postback',
      profile: 'cambium-hotspot',
    });
    const steps = res.body.steps as { id: string; value: string; secret: boolean }[];
    const auth = steps.find((s) => s.id === 'radius-auth');
    expect(auth?.value).toBe(`${RADIUS_ADDRESS}, 1812, <RADIUS_SECRET>`);
    expect(auth?.secret).toBe(true);
    expect(steps.find((s) => s.id === 'cambium-external-url')?.value).toBe(
      `${origin}/pb/cambium-hotspot/<NAS_IDENTIFIER>/`,
    );
    const codes = (res.body.warnings as { code: string }[]).map((w) => w.code);
    expect(codes).toEqual(
      expect.arrayContaining([
        'not_device_tested',
        'http_postback_cleartext',
        'lab_mode_attributes',
      ]),
    );
    expect(res.body.secret_note).toMatch(/shown once when you add the NAS/);
    // The default production host never leaks into a guide of another origin.
    if (!origin.includes('portal.ezecloud.ezelink.ai')) {
      expect(JSON.stringify(res.body)).not.toContain('portal.ezecloud.ezelink.ai');
    }
  });

  it('guides never contain a secret: a fresh NAS secret appears in no vendor guide', async () => {
    const { orgId, siteId, agent } = await orgAdmin();
    const nas = await agent
      .post(`/api/v1/orgs/${orgId}/nas`)
      .set(BROWSER)
      .send({
        site_id: siteId,
        name: unique('cambium'),
        nas_ip: '10.77.0.2',
        adapter_key: 'external-portal-postback',
        adapter_config: { profile: 'cambium-hotspot' },
      });
    expect(nas.status, JSON.stringify(nas.body)).toBe(201);
    const secret = nas.body.secret as string;
    expect(secret.length).toBeGreaterThan(8);
    const list = await agent.get(`/api/v1/orgs/${orgId}/setup-guides`);
    for (const e of list.body.data as { vendor_key: string }[]) {
      const g = await agent.get(`/api/v1/orgs/${orgId}/setup-guides/${e.vendor_key}`);
      expect(g.status, e.vendor_key).toBe(200);
      const text = JSON.stringify(g.body);
      expect(text, e.vendor_key).not.toContain(secret);
      expect(text, e.vendor_key).not.toContain(deps.config.dataEncryptionKey);
      expect(text, e.vendor_key).not.toContain(deps.config.base.internalApiToken);
      for (const s of g.body.steps as { value: string; secret: boolean }[]) {
        // every secret-bearing value is still a placeholder and flagged
        if (/<(RADIUS|UAM|DAE)_SECRET>/.test(s.value)) expect(s.secret).toBe(true);
      }
      expect(Array.isArray(g.body.warnings)).toBe(true);
    }
    const tail = await agent.get(`/api/v1/orgs/${orgId}/setup-guides/zyxel`);
    expect((tail.body.warnings as { code: string }[]).map((w) => w.code)).toContain(
      'needs_captured_redirect',
    );
    const meraki = await agent.get(`/api/v1/orgs/${orgId}/setup-guides/cisco-meraki`);
    expect(meraki.body.meraki.state).toBe('disabled');
    expect(meraki.body.radius).toBeNull();
    expect((meraki.body.warnings as { code: string }[]).map((w) => w.code)).toContain(
      'meraki_disabled',
    );
    const unifi = await agent.get(`/api/v1/orgs/${orgId}/setup-guides/ubiquiti-unifi`);
    expect(unifi.body.radius).toBeNull();
    expect(
      (unifi.body.steps as { value: string }[]).some((s) => s.value === '<UNIFI_API_KEY>'),
    ).toBe(true);
  });

  it('without RADIUS_ADVERTISED_ADDRESS the placeholder stays and a warning says so', async () => {
    const local = createApp({
      ...deps,
      config: { ...deps.config, setupGuide: { ...deps.config.setupGuide, radiusAddress: null } },
    });
    {
      const tenant = await createTenant(deps.dbPlatform);
      const admin = await createAdmin(deps.dbPlatform, [
        { template: 'org_admin', scope: 'organization', orgId: tenant.orgId },
      ]);
      const agent = request.agent(local.publicApp);
      await agent
        .post('/api/v1/auth/login')
        .set(BROWSER)
        .send({ email: admin.email, password: admin.password });
      const g = await agent.get(`/api/v1/orgs/${tenant.orgId}/setup-guides/mikrotik`);
      expect(g.status).toBe(200);
      expect(g.body.radius.address).toBeNull();
      expect(JSON.stringify(g.body.steps)).toContain('<ECLOUD_RADIUS_ADDRESS>');
      expect((g.body.warnings as { code: string }[]).map((w) => w.code)).toContain(
        'radius_address_not_configured',
      );
    }
  });

  it('tenant scope, permission and unknown vendor', async () => {
    const a = await orgAdmin();
    const b = await orgAdmin();
    // another organization's admin cannot read this organization's gallery
    const cross = await b.agent.get(`/api/v1/orgs/${a.orgId}/setup-guides`);
    expect([403, 404]).toContain(cross.status);
    const crossGuide = await b.agent.get(`/api/v1/orgs/${a.orgId}/setup-guides/cambium`);
    expect([403, 404]).toContain(crossGuide.status);
    // another organization's site is not found
    const foreignSite = await a.agent.get(
      `/api/v1/orgs/${a.orgId}/setup-guides/cambium?site_id=${b.siteId}`,
    );
    expect(foreignSite.status).toBe(404);
    expect(JSON.stringify(foreignSite.body)).not.toContain('Site A');
    // unknown vendor key
    expect((await a.agent.get(`/api/v1/orgs/${a.orgId}/setup-guides/no-such-vendor`)).status).toBe(
      404,
    );
    expect(
      (await a.agent.get(`/api/v1/orgs/${a.orgId}/setup-guides/cambium?site_id=not-a-uuid`)).status,
    ).toBe(400);

    // custom role without nas:read: 403
    const role = await a.agent
      .post(`/api/v1/orgs/${a.orgId}/roles`)
      .set(BROWSER)
      .send({
        key: unique('users_only').replaceAll('-', '_').toLowerCase().slice(0, 40),
        name: 'Users only',
        permissions: ['user:read'],
      });
    expect(role.status, JSON.stringify(role.body)).toBe(201);
    const limited = await createAdmin(deps.dbPlatform, []);
    await deps.dbPlatform
      .insertInto('role_bindings')
      .values({
        id: newId(),
        administrator_id: limited.id,
        role_id: role.body.id as string,
        scope_type: 'organization',
        organization_id: a.orgId,
      })
      .execute();
    const limitedAgent = await login(limited);
    expect((await limitedAgent.get(`/api/v1/orgs/${a.orgId}/setup-guides`)).status).toBe(403);
    expect((await limitedAgent.get(`/api/v1/orgs/${a.orgId}/setup-guides/cambium`)).status).toBe(
      403,
    );

    // site-scoped admin (nas:read on site A only): gallery yes, other site no
    const siteAdmin = await createAdmin(deps.dbPlatform, [
      { template: 'site_admin', scope: 'site', orgId: a.orgId, siteId: a.siteId },
    ]);
    const siteAgent = await login(siteAdmin);
    expect((await siteAgent.get(`/api/v1/orgs/${a.orgId}/setup-guides`)).status).toBe(200);
    expect(
      (await siteAgent.get(`/api/v1/orgs/${a.orgId}/setup-guides/mikrotik?site_id=${a.siteId}`))
        .status,
    ).toBe(200);
    // out-of-scope site and missing site answer the same 404 (no site-existence oracle)
    const outOfScope = await siteAgent.get(
      `/api/v1/orgs/${a.orgId}/setup-guides/mikrotik?site_id=${a.siteId2}`,
    );
    expect(outOfScope.status).toBe(404);
    expect(outOfScope.body.detail).toBe(`site ${a.siteId2} not found.`);
    const missingId = '00000000-0000-4000-8000-000000000000';
    const missing = await siteAgent.get(
      `/api/v1/orgs/${a.orgId}/setup-guides/mikrotik?site_id=${missingId}`,
    );
    expect(missing.status).toBe(404);
    expect(missing.body.detail).toBe(`site ${missingId} not found.`);

    // unauthenticated
    expect((await request(apps.publicApp).get(`/api/v1/orgs/${a.orgId}/setup-guides`)).status).toBe(
      401,
    );
  });

  it('OpenAPI documents both endpoints', async () => {
    const doc = await request(apps.publicApp).get('/api/v1/openapi.json');
    expect(doc.status).toBe(200);
    const paths = doc.body.paths as Record<string, unknown>;
    expect(paths['/api/v1/orgs/{orgId}/setup-guides']).toBeDefined();
    expect(paths['/api/v1/orgs/{orgId}/setup-guides/{vendorKey}']).toBeDefined();
  });
});
