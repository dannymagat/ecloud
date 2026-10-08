/* eslint-disable @typescript-eslint/no-unsafe-member-access -- supertest response bodies are untyped JSON */
/**
 * Phase 7 P7-B AC2: `GET …/sites/{siteId}/openwifi-config/rate-limit-fragment` against
 * `ecloud_test`. Export/preview only (never pushed); site baseline layers only; schema-validated
 * fragment; JSON download; tenant isolation. Skipped without the dev stack.
 */
import { describeIntegration, migrateTestDatabase } from '@ecloud/testing';
import request from 'supertest';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createApp } from './app.js';
import type { AppDeps } from './context.js';
import {
  TEST_ORIGIN,
  closeDeps,
  createAdmin,
  createTenant,
  integrationDeps,
} from './test-support/deps.js';

type Agent = ReturnType<typeof request.agent>;
const BROWSER = { Origin: TEST_ORIGIN, 'X-Requested-With': 'XMLHttpRequest' };

await describeIntegration('@ecloud/api openwifi-config rate-limit fragment export', () => {
  let deps: AppDeps;
  let apps: ReturnType<typeof createApp>;

  beforeAll(async () => {
    await migrateTestDatabase();
    deps = integrationDeps();
    apps = createApp(deps);
  }, 60_000);

  afterAll(async () => {
    await closeDeps(deps);
  });

  async function orgAdmin(): Promise<{
    orgId: string;
    siteId: string;
    siteId2: string;
    agent: Agent;
  }> {
    const tenant = await createTenant(deps.dbPlatform);
    const admin = await createAdmin(deps.dbPlatform, [
      { template: 'org_admin', scope: 'organization', orgId: tenant.orgId },
    ]);
    const agent = request.agent(apps.publicApp);
    const res = await agent
      .post('/api/v1/auth/login')
      .set(BROWSER)
      .send({ email: admin.email, password: admin.password });
    expect(res.status).toBe(200);
    return { ...tenant, agent };
  }

  async function sitePolicy(
    agent: Agent,
    orgId: string,
    siteId: string,
    fields: Record<string, unknown>,
  ): Promise<void> {
    const policy = await agent
      .post(`/api/v1/orgs/${orgId}/policies`)
      .set(BROWSER)
      .send({ name: 'Site cap', scope_type: 'site', status: 'active', ...fields });
    expect(policy.status).toBe(201);
    const assign = await agent
      .post(`/api/v1/orgs/${orgId}/policy-assignments`)
      .set(BROWSER)
      .send({ policy_id: policy.body.id as string, target_type: 'site', target_id: siteId });
    expect(assign.status).toBe(201);
  }

  const url = (orgId: string, siteId: string, query: string) =>
    `/api/v1/orgs/${orgId}/sites/${siteId}/openwifi-config/rate-limit-fragment?${query}`;

  it('exports the site baseline as a schema-valid uCentral rate-limit fragment, never pushed', async () => {
    const { orgId, siteId, agent } = await orgAdmin();
    await sitePolicy(agent, orgId, siteId, {
      download_rate_kbps: 20_000,
      upload_rate_kbps: 5_000,
      idle_timeout_s: 600,
    });
    const res = await agent.get(url(orgId, siteId, 'ssid=lab-uam'));
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toMatchObject({
      available: true,
      mode: 'export_preview_only',
      pushed: false,
      ssid: 'lab-uam',
      reason: null,
      device_enforced: false,
      adapter: 'openwifi-config',
      resolution: { decision: 'accept' },
      fragment: {
        interfaces: [
          { ssids: [{ name: 'lab-uam', 'rate-limit': { 'egress-rate': 20, 'ingress-rate': 5 } }] },
        ],
      },
      validation: { valid: true, schema_id: 'https://openwrt.org/ucentral.schema.json' },
    });
    const body = res.body as {
      changes: { evidence_level: string }[];
      omitted: { field: string }[];
      fragment: unknown;
    };
    expect(body.changes.map((c) => c.evidence_level)).toEqual([
      'VERIFIED_FROM_SOURCE',
      'VERIFIED_FROM_SOURCE',
    ]);
    expect(body.omitted.map((o) => o.field)).toEqual(['idle_timeout_s']);

    const file = await agent.get(url(orgId, siteId, 'ssid=lab-uam&download=1'));
    expect(file.status).toBe(200);
    expect(file.headers['content-type']).toMatch(/^application\/json/);
    expect(file.headers['content-disposition']).toBe(
      'attachment; filename="ucentral-rate-limit-lab-uam.json"',
    );
    expect(JSON.parse(file.text)).toEqual(body.fragment);
  });

  it('a site without a site-scoped rate yields available=false (and 422 for download)', async () => {
    const { orgId, siteId, siteId2, agent } = await orgAdmin();
    // no policy at all → the resolution rejects (no_policy): nothing to export
    const none = await agent.get(url(orgId, siteId2, 'ssid=lab-uam'));
    expect(none.status).toBe(200);
    expect(none.body).toMatchObject({
      available: false,
      fragment: null,
      pushed: false,
      resolution: { decision: 'reject', reason_code: 'no_policy' },
    });
    // a site policy without rates → accepted, but no rate-limit translates
    await sitePolicy(agent, orgId, siteId, { idle_timeout_s: 600 });
    const res = await agent.get(url(orgId, siteId, 'ssid=lab-uam'));
    expect(res.body).toMatchObject({ available: false, resolution: { decision: 'accept' } });
    expect(res.body.reason).toMatch(/no site-scoped download\/upload rate/);
    const file = await agent.get(url(orgId, siteId2, 'ssid=lab-uam&download=1'));
    expect(file.status).toBe(422);
    expect(file.headers['content-type']).toMatch(/application\/problem\+json/);
  });

  it('validates the SSID and is tenant-isolated', async () => {
    const a = await orgAdmin();
    const b = await orgAdmin();
    expect((await a.agent.get(url(a.orgId, a.siteId, `ssid=${'x'.repeat(33)}`))).status).toBe(400);
    expect((await a.agent.get(url(a.orgId, a.siteId, ''))).status).toBe(400);
    // another tenant's site through my organization path → 404; their organization path → 403
    expect((await a.agent.get(url(a.orgId, b.siteId, 'ssid=s'))).status).toBe(404);
    expect((await a.agent.get(url(b.orgId, b.siteId, 'ssid=s'))).status).toBe(403);
  });

  it('is documented in the OpenAPI document', async () => {
    const doc = await request(apps.publicApp).get('/api/v1/openapi.json');
    expect(
      doc.body.paths['/api/v1/orgs/{orgId}/sites/{siteId}/openwifi-config/rate-limit-fragment']
        ?.get,
    ).toBeDefined();
  });
});
