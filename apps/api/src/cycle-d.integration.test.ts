/* eslint-disable @typescript-eslint/no-unsafe-member-access -- supertest response bodies are untyped JSON */
/**
 * Multi-vendor Cycle D (migration 031) against the test database, with a LOCAL mock vendor
 * controller (HTTPS on 127.0.0.1, throw-away CA). No real vendor controller is contacted.
 *  - API credential: TLS pin (CA / fingerprint), per-adapter settings, validation;
 *  - "Test connection": permission-gated, audited without values, SSRF policy, TLS failure;
 *  - UniFi external portal: verified-AP redirect → click-through → controller authorisation with
 *    policy limits → `vendor_api_sessions` row (accounting none, usage unknown), no `sessions` row;
 *  - Omada API mode: operator login + extPortal/auth (6.2.10 body);
 *  - Mist: signed grant URL (HMAC-SHA1 with the WLAN API secret), WLAN id allow-list.
 */
import { createHmac } from 'node:crypto';
import {
  allowLoopback,
  describeIntegration,
  json,
  loopbackResolver,
  migrateTestDatabase,
  startMockController,
  testPki,
  type MockController,
} from '@ecloud/testing';
import { newId } from '@ecloud/shared';
import { VendorHttpClient } from '@ecloud/vendor-api';
import request from 'supertest';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { generate } from 'otplib';
import { createApp } from './app.js';
import { voucherHash } from './routes/vouchers.js';
import type { AppDeps } from './context.js';
import { MemoryKv } from './kv.js';
import {
  TEST_INTERNAL_TOKEN,
  TEST_ORIGIN,
  closeDeps,
  createAdmin,
  createTenant,
  integrationDeps,
  type AdminFixture,
} from './test-support/deps.js';

type Agent = ReturnType<typeof request.agent>;
type Apps = ReturnType<typeof createApp>;

/** A key-shaped PEM (built at runtime so no key marker is committed); never a real key. */
const FAKE_KEY_PEM = ['-----BEGIN', 'PRIVATE KEY-----\nAAAA\n-----END', 'PRIVATE KEY-----\n'].join(
  ' ',
);
const BROWSER = { Origin: TEST_ORIGIN, 'X-Requested-With': 'XMLHttpRequest' };
/** Obviously fake vendor secrets (never real credentials). */
const FAKE_UNIFI_KEY = 'test-unifi-api-key-not-real';
const FAKE_MIST_SECRET = 'test-mist-wlan-secret-not-real';
const FAKE_OMADA_PASSWORD = 'test-omada-operator-pass';
const WLAN = 'be22bba7-8e22-e1cf-5185-b880816fe2cf';
const UNIFI_SITE = '88f7af54-98f8-306a-a1c7-c9349722b1f6';

function randomIp(): string {
  const b = () => Math.floor(Math.random() * 250) + 2;
  return `10.${String(b())}.${String(b())}.${String(b())}`;
}

function randomMac(): string {
  const bytes = [0x02, ...Array.from({ length: 5 }, () => Math.floor(Math.random() * 256))];
  return bytes.map((b) => b.toString(16).padStart(2, '0')).join(':');
}

await describeIntegration('@ecloud/api multi-vendor Cycle D (mock controller)', () => {
  let deps: AppDeps;
  let mock: MockController;

  beforeAll(async () => {
    await migrateTestDatabase();
    deps = integrationDeps();
    mock = await startMockController();
  }, 60_000);

  afterAll(async () => {
    await mock.close();
    await closeDeps(deps);
  });

  /** Apps whose outbound client reaches the loopback mock (test-only address policy). */
  function freshApps(
    vendorHttp = new VendorHttpClient({
      resolve: loopbackResolver,
      addressAllowed: allowLoopback,
      allowedPorts: [443, mock.port],
    }),
    vendorTestFloorMs = 0,
  ): Apps {
    return createApp({ ...deps, kv: new MemoryKv(), vendorHttp, vendorTestFloorMs });
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

  async function orgAdmin(apps: Apps, template = 'org_admin') {
    const tenant = await createTenant(deps.dbPlatform);
    const admin = await createAdmin(deps.dbPlatform, [
      { template, scope: 'organization', orgId: tenant.orgId },
    ]);
    return { ...tenant, admin, agent: await login(apps, admin) };
  }

  async function controller(
    agent: Agent,
    orgId: string,
    vendorKey: string,
    baseUrl: string,
  ): Promise<string> {
    const res = await agent
      .post(`/api/v1/orgs/${orgId}/controllers`)
      .set(BROWSER)
      .send({
        name: `ctrl ${newId().slice(-12)}`,
        vendor_key: vendorKey,
        kind: 'on_premises',
        base_url: baseUrl,
      });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.id as string;
  }

  function setCredential(agent: Agent, orgId: string, id: string, body: Record<string, unknown>) {
    return agent
      .post(`/api/v1/orgs/${orgId}/controllers/${id}/api-credential`)
      .set(BROWSER)
      .set('Idempotency-Key', newId())
      .send(body);
  }

  function testConnection(agent: Agent, orgId: string, id: string) {
    return agent
      .post(`/api/v1/orgs/${orgId}/controllers/${id}/api-credential/test`)
      .set(BROWSER)
      .send({});
  }

  const mockBase = (path = '/proxy/network/integration') =>
    `https://controller.test:${String(mock.port)}${path}`;

  /** NAS of `adapterKey` behind `controllerId`, an external portal, a VERIFIED AP and a site policy. */
  async function vendorSite(
    a: { agent: Agent; orgId: string; siteId: string },
    adapterKey: string,
    controllerId: string,
    verified = true,
    portal: { methods?: string[]; redirectUrl?: string | null } = {},
  ) {
    const nas = await a.agent
      .post(`/api/v1/orgs/${a.orgId}/nas`)
      .set(BROWSER)
      .send({
        site_id: a.siteId,
        name: `nas ${newId().slice(-6)}`,
        nas_ip: randomIp(),
        adapter_key: adapterKey,
        controller_id: controllerId,
      });
    expect(nas.status, JSON.stringify(nas.body)).toBe(201);
    const apMac = randomMac();
    await deps.dbPlatform
      .insertInto('nas_access_points')
      .values({
        organization_id: a.orgId,
        site_id: a.siteId,
        nas_client_id: nas.body.id as string,
        mac: apMac,
        ...(verified
          ? { verified_at: new Date(), verification_source: 'controller-inventory' as const }
          : {}),
      })
      .execute();
    await deps.dbPlatform
      .insertInto('captive_portals')
      .values({
        organization_id: a.orgId,
        site_id: a.siteId,
        name: 'Guest',
        public_slug: `g${newId().replace(/-/g, '').slice(0, 20)}`,
        portal_type: 'external',
        network_ref: 'guest',
        auth_methods: portal.methods ?? ['click_through'],
        redirect_url: portal.redirectUrl ?? null,
      })
      .execute();
    const policy = await deps.dbPlatform
      .insertInto('policies')
      .values({
        organization_id: a.orgId,
        name: 'Guest 10M',
        scope_type: 'site',
        site_id: a.siteId,
        status: 'active',
        download_rate_kbps: 10_000,
        upload_rate_kbps: 2_000,
        session_timeout_s: 3_600,
        quota_total_bytes: 500_000_000,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await deps.dbPlatform
      .insertInto('policy_assignments')
      .values({
        organization_id: a.orgId,
        policy_id: policy.id,
        target_type: 'site',
        site_id: a.siteId,
      })
      .execute();
    return { nasId: nas.body.id as string, apMac };
  }

  function redirect(apps: Apps, adapter: string, path: string, rawQuery: string) {
    return request(apps.internalApp)
      .post('/internal/vendor-portal/redirects')
      .set('X-Internal-Token', TEST_INTERNAL_TOKEN)
      .send({ adapter, path, raw_query: rawQuery, client_ip: randomIp() });
  }

  function clickThrough(apps: Apps, flowId: string) {
    return request(apps.internalApp)
      .post(`/internal/portal/flows/${flowId}/identify`)
      .set('X-Internal-Token', TEST_INTERNAL_TOKEN)
      .send({ method: 'click_through', accept_terms: true });
  }

  // ------------------------------------------------------------------------- credential + test

  it('stores TLS pins and settings, validates them, and never returns the secret', async () => {
    const apps = freshApps();
    const a = await orgAdmin(apps);
    const id = await controller(a.agent, a.orgId, 'ubiquiti-unifi', mockBase());
    const base = {
      api_kind: 'unifi-network',
      base_url: mockBase(),
      secret: FAKE_UNIFI_KEY,
      external_site_id: UNIFI_SITE,
    };

    const keyAsCa = await setCredential(a.agent, a.orgId, id, {
      ...base,
      tls_ca_pem: FAKE_KEY_PEM,
    });
    expect(keyAsCa.status).toBe(400);
    const both = await setCredential(a.agent, a.orgId, id, {
      ...base,
      tls_ca_pem: testPki().caPem,
      tls_fingerprint_sha256: testPki().leafFingerprint,
    });
    expect(both.status).toBe(400);
    const badSetting = await setCredential(a.agent, a.orgId, id, {
      ...base,
      settings: { omada_controller_id: 'x' },
    });
    expect(badSetting.status).toBe(400);

    const ok = await setCredential(a.agent, a.orgId, id, {
      ...base,
      tls_ca_pem: testPki().caPem,
      settings: { unifi_site_name: 'default' },
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({
      tls_trust: 'ca',
      settings: { unifi_site_name: 'default' },
      has_secret: true,
      last_test_result: null,
    });
    expect(JSON.stringify(ok.body)).not.toContain(FAKE_UNIFI_KEY);
    expect(JSON.stringify(ok.body)).not.toContain('BEGIN CERTIFICATE');

    const fp = await setCredential(a.agent, a.orgId, id, {
      ...base,
      tls_fingerprint_sha256: testPki().leafFingerprint.toLowerCase(),
    });
    expect(fp.body).toMatchObject({
      tls_trust: 'fingerprint',
      tls_fingerprint_sha256: testPki().leafFingerprint,
    });
  });

  it('test connection: permission-gated, audited without values, TLS and SSRF enforced', async () => {
    mock.handler = (req, res) =>
      req.headers['x-api-key'] === FAKE_UNIFI_KEY
        ? json(res, 200, { data: [] })
        : json(res, 401, {});
    const apps = freshApps();
    const a = await orgAdmin(apps);
    const id = await controller(a.agent, a.orgId, 'ubiquiti-unifi', mockBase());
    const base = {
      api_kind: 'unifi-network',
      base_url: mockBase(),
      secret: FAKE_UNIFI_KEY,
      external_site_id: UNIFI_SITE,
    };
    expect(
      (await setCredential(a.agent, a.orgId, id, { ...base, tls_ca_pem: testPki().caPem })).status,
    ).toBe(200);

    const ok = await testConnection(a.agent, a.orgId, id);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({ ok: true, code: 'ok', contacted: true });
    const listed = mock.requests.at(-1);
    expect(listed?.url).toBe(`/proxy/network/integration/v1/sites/${UNIFI_SITE}/clients?limit=1`);
    const meta = await a.agent.get(`/api/v1/orgs/${a.orgId}/controllers/${id}/api-credential`);
    expect(meta.body.last_test_result).toBe('ok');

    const audit = await deps.dbPlatform
      .selectFrom('audit_logs')
      .select(['action', 'after'])
      .where('organization_id', '=', a.orgId)
      .where('action', '=', 'controller:api_credential_test')
      .execute();
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit)).not.toContain(FAKE_UNIFI_KEY);
    expect(audit[0]?.after).toMatchObject({
      result: 'ok',
      contacted: true,
      api_kind: 'unifi-network',
    });

    // wrong key → auth_failed (no vendor text echoed)
    await setCredential(a.agent, a.orgId, id, {
      ...base,
      secret: 'test-wrong-key',
      tls_ca_pem: testPki().caPem,
    });
    expect((await testConnection(a.agent, a.orgId, id)).body).toMatchObject({
      ok: false,
      code: 'auth_failed',
    });

    // no pin: the private test CA is not trusted by the system roots → TLS failure, which for
    // an on-prem controller is reported as the single `unreachable` code (review F2)
    await setCredential(a.agent, a.orgId, id, base);
    expect((await testConnection(a.agent, a.orgId, id)).body).toMatchObject({
      ok: false,
      code: 'unreachable',
      contacted: false,
    });
    expect(
      (await a.agent.get(`/api/v1/orgs/${a.orgId}/controllers/${id}/api-credential`)).body
        .last_test_result,
    ).toBe('unreachable');

    // production address policy: a name resolving to loopback is blocked before any connect
    const prod = freshApps(
      new VendorHttpClient({ resolve: loopbackResolver, allowedPorts: [443, mock.port] }),
    );
    const agentProd = await login(prod, a.admin);
    await setCredential(a.agent, a.orgId, id, { ...base, tls_ca_pem: testPki().caPem });
    const n = mock.requests.length;
    expect((await testConnection(agentProd, a.orgId, id)).body).toMatchObject({
      ok: false,
      code: 'unreachable',
    });
    expect(mock.requests.length).toBe(n);

    // read-only role → 403; other tenant → 404
    const op = await createAdmin(deps.dbPlatform, [
      { template: 'operator', scope: 'organization', orgId: a.orgId },
    ]);
    expect((await testConnection(await login(apps, op), a.orgId, id)).status).toBe(403);
    const b = await orgAdmin(apps);
    expect((await testConnection(b.agent, b.orgId, id)).status).toBe(404);
  });

  // ----------------------------------------------------------------------------- UniFi flow

  it('UniFi: verified AP redirect → click-through → AUTHORIZE_GUEST_ACCESS with policy limits', async () => {
    const clientMac = randomMac();
    const authorised: unknown[] = [];
    mock.handler = (req, res) => {
      if (req.headers['x-api-key'] !== FAKE_UNIFI_KEY) return json(res, 401, {});
      if (req.method === 'GET' && req.url.includes('/clients?')) {
        const known = decodeURIComponent(req.url).includes(clientMac);
        return json(res, 200, {
          data: known
            ? [
                {
                  id: 'unifi-client-7',
                  macAddress: clientMac.toUpperCase(),
                  access: { type: 'GUEST' },
                },
              ]
            : [],
        });
      }
      if (req.method === 'POST' && req.url.endsWith('/clients/unifi-client-7/actions')) {
        authorised.push(JSON.parse(req.body));
        return json(res, 200, {});
      }
      return json(res, 404, {});
    };
    const apps = freshApps();
    const a = await orgAdmin(apps);
    const id = await controller(a.agent, a.orgId, 'ubiquiti-unifi', mockBase());
    await setCredential(a.agent, a.orgId, id, {
      api_kind: 'unifi-network',
      base_url: mockBase(),
      secret: FAKE_UNIFI_KEY,
      external_site_id: UNIFI_SITE,
      tls_ca_pem: testPki().caPem,
      settings: { unifi_site_name: 'default' },
    });
    const site = await vendorSite(a, 'unifi-external-portal', id);
    const q = `ap=${site.apMac}&id=${clientMac}&t=1700000000&url=${encodeURIComponent('https://example.com/news')}&ssid=Guest`;

    expect((await redirect(apps, 'unifi', '/guest/s/other-site/', q)).body.kind).toBe('error'); // site name mismatch
    const flow = await redirect(apps, 'unifi', '/guest/s/default/', q);
    expect(flow.body.kind, JSON.stringify(flow.body)).toBe('flow');
    const view = await request(apps.internalApp)
      .get(`/internal/portal/flows/${flow.body.flow_id as string}`)
      .set('X-Internal-Token', TEST_INTERNAL_TOKEN);
    expect(view.body).toMatchObject({
      methods: ['click_through'],
      nas: null,
      continue_url: 'https://example.com/news',
    });

    const done = await clickThrough(apps, flow.body.flow_id as string);
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body).toMatchObject({
      result: 'ok',
      handoff: { kind: 'vendor-api', url: 'https://example.com/news' },
      accounting: 'none',
    });
    expect(authorised).toEqual([
      {
        action: 'AUTHORIZE_GUEST_ACCESS',
        timeLimitMinutes: 60,
        dataUsageLimitMBytes: 500,
        rxRateLimitKbps: 10_000,
        txRateLimitKbps: 2_000,
      },
    ]);

    const rows = await deps.dbPlatform
      .selectFrom('vendor_api_sessions')
      .selectAll()
      .where('organization_id', '=', a.orgId)
      .execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: 'authorized',
      adapter_key: 'unifi-external-portal',
      api_kind: 'unifi-network',
      client_mac: clientMac,
      ap_mac: site.apMac,
      identity_kind: 'click_through',
      vendor_client_ref: 'unifi-client-7',
      granted_duration_s: 3600,
      usage_source: 'unknown',
      accounting: 'none',
    });
    const statuses = rows[0]?.field_statuses as { field: string; status: string }[];
    expect(statuses.find((s) => s.field === 'download_rate_kbps')?.status).toBe(
      'REQUIRES_DEVICE_TEST',
    );
    expect(statuses.some((s) => s.status === 'VERIFIED_SUPPORTED')).toBe(false);
    // UniFi sends no RADIUS accounting: no RADIUS `sessions` row is ever created for it
    const radiusSessions = await deps.dbPlatform
      .selectFrom('sessions')
      .select('id')
      .where('organization_id', '=', a.orgId)
      .execute();
    expect(radiusSessions).toHaveLength(0);
    // the flow is done
    expect((await clickThrough(apps, flow.body.flow_id as string)).status).toBe(409);

    // a client the controller does not report on the site is never authorised
    const stranger = await redirect(
      apps,
      'unifi',
      '/guest/s/default/',
      `ap=${site.apMac}&id=${randomMac()}`,
    );
    const refused = await clickThrough(apps, stranger.body.flow_id as string);
    expect(refused.status).toBe(502);
    expect(refused.body).toEqual({ result: 'vendor_unavailable' });
    const failed = await deps.dbPlatform
      .selectFrom('vendor_api_sessions')
      .select(['status', 'error_code'])
      .where('organization_id', '=', a.orgId)
      .where('status', '=', 'failed')
      .execute();
    expect(failed).toEqual([{ status: 'failed', error_code: 'client_not_found' }]);
  });

  it('UniFi: unverified AP, wrong adapter or missing credential fail closed with one generic error', async () => {
    const apps = freshApps();
    const a = await orgAdmin(apps);
    const id = await controller(a.agent, a.orgId, 'ubiquiti-unifi', mockBase());
    const unverified = await vendorSite(a, 'unifi-external-portal', id, false);
    expect(
      (
        await redirect(
          apps,
          'unifi',
          '/guest/s/default/',
          `ap=${unverified.apMac}&id=${randomMac()}`,
        )
      ).body,
    ).toEqual({ kind: 'error' });
    // verified AP but no API credential on the controller
    const b = await orgAdmin(apps);
    const idB = await controller(b.agent, b.orgId, 'ubiquiti-unifi', mockBase());
    const noCred = await vendorSite(b, 'unifi-external-portal', idB);
    expect(
      (await redirect(apps, 'unifi', '/guest/s/default/', `ap=${noCred.apMac}&id=${randomMac()}`))
        .body,
    ).toEqual({ kind: 'error' });
    // the same AP presented as a Mist redirect → adapter mismatch
    const mistQ = `wlan_id=${WLAN}&ap_mac=${noCred.apMac.replace(/:/g, '')}&client_mac=${randomMac().replace(/:/g, '')}`;
    expect((await redirect(apps, 'mist', '/ext/mist', mistQ)).body).toEqual({ kind: 'error' });
  });

  // ----------------------------------------------------------------------------- Omada flow

  it('Omada API mode: operator login + extPortal/auth with the 6.2.10 body', async () => {
    const auths: unknown[] = [];
    mock.handler = (req, res) => {
      if (req.url === '/omadac1234/api/v2/hotspot/login') {
        const body = JSON.parse(req.body) as { name: string; password: string };
        return body.name === 'hotspot-op' && body.password === FAKE_OMADA_PASSWORD
          ? json(
              res,
              200,
              { errorCode: 0, result: { token: 'csrf-token-1234567890' } },
              { 'set-cookie': 'TPOMADA_SESSIONID=abc; Path=/' },
            )
          : json(res, 200, { errorCode: -30109 });
      }
      if (
        req.url === '/omadac1234/api/v2/hotspot/extPortal/auth' &&
        req.headers['csrf-token'] === 'csrf-token-1234567890'
      ) {
        auths.push(JSON.parse(req.body));
        return json(res, 200, { errorCode: 0 });
      }
      return json(res, 200, { errorCode: -1 });
    };
    const apps = freshApps();
    const a = await orgAdmin(apps);
    const id = await controller(a.agent, a.orgId, 'tplink-omada', mockBase(''));
    const cred = await setCredential(a.agent, a.orgId, id, {
      api_kind: 'omada-controller',
      base_url: mockBase(''),
      username: 'hotspot-op',
      secret: FAKE_OMADA_PASSWORD,
      tls_fingerprint_sha256: testPki().leafFingerprint,
      settings: { omada_controller_id: 'omadac1234' },
    });
    expect(cred.status, JSON.stringify(cred.body)).toBe(200);
    expect((await testConnection(a.agent, a.orgId, id)).body).toMatchObject({
      ok: true,
      code: 'ok',
    });

    const site = await vendorSite(a, 'omada-api', id);
    const apDashed = site.apMac.replace(/:/g, '-').toUpperCase();
    const clientMac = randomMac();
    const clientDashed = clientMac.replace(/:/g, '-').toUpperCase();
    const q = `clientMac=${clientDashed}&clientIp=192.168.10.20&apMac=${apDashed}&ssidName=Guest&t=1700000000000&radioId=1&site=Default&redirectUrl=${encodeURIComponent('https://example.com/')}`;
    const flow = await redirect(apps, 'omada', '/ext/omada', q);
    expect(flow.body.kind, JSON.stringify(flow.body)).toBe('flow');
    const done = await clickThrough(apps, flow.body.flow_id as string);
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(auths).toEqual([
      {
        clientMac: clientDashed,
        clientIp: '192.168.10.20',
        apMac: apDashed,
        ssidName: 'Guest',
        radioId: '1',
        time: 3_600_000,
        authType: 4,
        originUrl: 'https://example.com/',
        totalTrafficLimitBytes: 500_000_000,
        downloadRateLimitKbps: 10_000,
        uploadRateLimitKbps: 2_000,
      },
    ]);
  });

  // ------------------------------------------------------------------------------ Mist flow

  it('Mist: signed grant URL for a registered WLAN only', async () => {
    const apps = freshApps();
    const a = await orgAdmin(apps);
    const id = await controller(a.agent, a.orgId, 'juniper-mist', 'https://api.mist.com');
    const cred = await setCredential(a.agent, a.orgId, id, {
      api_kind: 'mist',
      base_url: 'https://api.mist.com',
      secret: FAKE_MIST_SECRET,
      settings: { mist_wlan_ids: [WLAN] },
    });
    expect(cred.status, JSON.stringify(cred.body)).toBe(200);
    const n = mock.requests.length;
    expect((await testConnection(a.agent, a.orgId, id)).body).toMatchObject({
      ok: true,
      contacted: false,
    });
    const site = await vendorSite(a, 'mist-guest-portal', id);
    const clientMac = randomMac();
    const ap = site.apMac.replace(/:/g, '');
    const cm = clientMac.replace(/:/g, '');

    const other = `wlan_id=00000000-0000-4000-8000-000000000000&ap_mac=${ap}&client_mac=${cm}`;
    expect((await redirect(apps, 'mist', '/ext/mist', other)).body).toEqual({ kind: 'error' });

    const flow = await redirect(
      apps,
      'mist',
      '/ext/mist',
      `wlan_id=${WLAN}&ap_mac=${ap}&client_mac=${cm}&url=${encodeURIComponent('https://example.com/')}`,
    );
    expect(flow.body.kind, JSON.stringify(flow.body)).toBe('flow');
    const done = await clickThrough(apps, flow.body.flow_id as string);
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body.handoff.kind).toBe('vendor-grant');
    const url = new URL(done.body.handoff.url as string);
    expect(url.origin + url.pathname).toBe('https://portal.mist.com/authorize');
    const token = Buffer.from(url.searchParams.get('token') ?? '', 'base64').toString();
    expect(token).toBe(`${WLAN}/${ap}/${cm}/60/0/0/0`);
    const raw = (done.body.handoff.url as string).split('?')[1] ?? '';
    const payload = raw.replace(/^signature=[^&]*&/, '');
    const expected = createHmac('sha1', FAKE_MIST_SECRET).update(payload).digest('base64');
    expect(url.searchParams.get('signature')).toBe(expected);
    expect(Number(url.searchParams.get('expires')) - Date.now() / 1000).toBeLessThanOrEqual(121);
    expect(done.body.handoff.url).not.toContain(FAKE_MIST_SECRET);
    expect(mock.requests.length).toBe(n); // Mist is never contacted server-side

    const rows = await deps.dbPlatform
      .selectFrom('vendor_api_sessions')
      .select(['status', 'granted_duration_s', 'accounting'])
      .where('organization_id', '=', a.orgId)
      .execute();
    expect(rows).toEqual([
      { status: 'granted_url_issued', granted_duration_s: 3600, accounting: 'none' },
    ]);
  });

  // ------------------------------------------------------------------- review fixes F1–F6

  async function platformAgent(apps: Apps): Promise<Agent> {
    const admin = await createAdmin(deps.dbPlatform, [
      { template: 'platform_super_admin', scope: 'platform' },
    ]);
    const agent = await login(apps, admin);
    const enrol = await agent.post('/api/v1/auth/mfa/enrol').set(BROWSER);
    await agent
      .post('/api/v1/auth/mfa/confirm')
      .set(BROWSER)
      .send({ code: await generate({ secret: enrol.body.secret as string }) });
    return agent;
  }

  it('F1: inventory candidates need platform confirmation; config changes reset that trust', async () => {
    const apps = freshApps();
    const a = await orgAdmin(apps);
    const id = await controller(a.agent, a.orgId, 'ubiquiti-unifi', mockBase());
    const base = {
      api_kind: 'unifi-network',
      base_url: mockBase(),
      secret: FAKE_UNIFI_KEY,
      external_site_id: UNIFI_SITE,
      tls_ca_pem: testPki().caPem,
    };
    await setCredential(a.agent, a.orgId, id, base);
    const site = await vendorSite(a, 'unifi-external-portal', id, false);
    const mark = () =>
      deps.dbPlatform
        .updateTable('nas_access_points')
        .set({ inventory_seen_at: new Date(), inventory_controller_id: id })
        .where('mac', '=', site.apMac)
        .execute();
    const row = () =>
      deps.dbPlatform
        .selectFrom('nas_access_points')
        .select(['verified_at', 'verification_source', 'inventory_controller_id'])
        .where('mac', '=', site.apMac)
        .executeTakeFirstOrThrow();
    const platform = await platformAgent(apps);
    const confirm = (agent: Agent) =>
      agent
        .post('/api/v1/platform/access-points/confirm-inventory')
        .set(BROWSER)
        .send({ mac: site.apMac, reason: 'ticket 4711 site survey ok' });

    // no candidate yet → refused; tenant can never confirm
    expect((await confirm(platform)).status).toBe(400);
    await mark();
    expect((await confirm(a.agent)).status).toBe(403);
    // still unverified: the redirect is refused (MAC-only lookups need verification)
    expect(
      (await redirect(apps, 'unifi', '/guest/s/default/', `ap=${site.apMac}&id=${randomMac()}`))
        .body,
    ).toEqual({ kind: 'error' });
    const ok = await confirm(platform);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(await row()).toMatchObject({ verification_source: 'controller-inventory' });
    const audit = await deps.dbPlatform
      .selectFrom('audit_logs')
      .select('action')
      .where('organization_id', '=', a.orgId)
      .where('action', '=', 'access_point:verify')
      .execute();
    expect(audit).toHaveLength(1);

    // rotating the credential (new URL / pin / secret) drops inventory-based trust
    await setCredential(a.agent, a.orgId, id, base);
    expect(await row()).toEqual({
      verified_at: null,
      verification_source: null,
      inventory_controller_id: null,
    });
    // so does a controller URL change
    await mark();
    expect((await confirm(platform)).status).toBe(200);
    const patch = await a.agent
      .patch(`/api/v1/orgs/${a.orgId}/controllers/${id}`)
      .set(BROWSER)
      .send({ base_url: mockBase('/other') });
    expect(patch.status, JSON.stringify(patch.body)).toBe(200);
    expect((await row()).verified_at).toBeNull();
    // RADIUS-observed verification is never touched by these resets
    await deps.dbPlatform
      .updateTable('nas_access_points')
      .set({ verified_at: new Date(), verification_source: 'radius-called-station' })
      .where('mac', '=', site.apMac)
      .execute();
    await setCredential(a.agent, a.orgId, id, base);
    expect(await row()).toMatchObject({ verification_source: 'radius-called-station' });
  });

  it('F2: ports off the allow-list are refused; per-org limits; uniform failure latency', async () => {
    const apps = freshApps(undefined, 400);
    const a = await orgAdmin(apps);
    const id = await controller(a.agent, a.orgId, 'ubiquiti-unifi', mockBase());
    const badPort = await setCredential(a.agent, a.orgId, id, {
      api_kind: 'unifi-network',
      base_url: 'https://10.1.2.3:5432/',
      secret: FAKE_UNIFI_KEY,
      external_site_id: UNIFI_SITE,
    });
    expect(badPort.status).toBe(400);
    expect(JSON.stringify(badPort.body)).toContain('port');

    await setCredential(a.agent, a.orgId, id, {
      api_kind: 'unifi-network',
      base_url: mockBase(),
      secret: FAKE_UNIFI_KEY,
      external_site_id: UNIFI_SITE,
    }); // no pin → TLS failure → collapsed
    const started = Date.now();
    const first = await testConnection(a.agent, a.orgId, id);
    expect(first.body).toMatchObject({ code: 'unreachable' });
    expect(Date.now() - started).toBeGreaterThanOrEqual(390);

    const codes: number[] = [];
    for (let i = 0; i < 10; i += 1) codes.push((await testConnection(a.agent, a.orgId, id)).status);
    expect(codes.slice(0, 9).every((c) => c === 200)).toBe(true);
    expect(codes[9]).toBe(429);

    const b = await orgAdmin(apps);
    const created: number[] = [];
    for (let i = 0; i < 21; i += 1) {
      created.push(
        (
          await b.agent
            .post(`/api/v1/orgs/${b.orgId}/controllers`)
            .set(BROWSER)
            .send({
              name: `c${String(i)}`,
              vendor_key: 'ubiquiti-unifi',
              kind: 'on_premises',
              base_url: 'https://10.1.2.3/',
            })
        ).status,
      );
    }
    expect(created.slice(0, 20).every((c) => c === 201)).toBe(true);
    expect(created[20]).toBe(429);
  }, 30_000);

  async function voucherFixture(a: { orgId: string; siteId: string }) {
    const batch = await deps.dbPlatform
      .insertInto('voucher_batches')
      .values({ organization_id: a.orgId, name: 'b', count: 1, site_id: a.siteId, max_uses: 1 })
      .returning('id')
      .executeTakeFirstOrThrow();
    const code = `T${newId().replace(/-/g, '').slice(0, 9).toUpperCase()}`;
    const v = await deps.dbPlatform
      .insertInto('vouchers')
      .values({
        organization_id: a.orgId,
        batch_id: batch.id,
        code_hash: voucherHash(deps.config.voucherPepper, code),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return { code, id: v.id };
  }

  function voucherIdentify(apps: Apps, flowId: string, code: string) {
    return request(apps.internalApp)
      .post(`/internal/portal/flows/${flowId}/identify`)
      .set('X-Internal-Token', TEST_INTERNAL_TOKEN)
      .send({ method: 'voucher', code });
  }

  it('F3: a vendor failure never consumes the voucher; F5: one completion per flow', async () => {
    let authorise = 0;
    let known = false;
    let clientMac = '';
    mock.handler = (req, res) => {
      if (req.method === 'GET') {
        return json(res, 200, {
          data: known ? [{ id: 'c-9', macAddress: clientMac, access: { type: 'GUEST' } }] : [],
        });
      }
      authorise += 1;
      setTimeout(() => json(res, 200, {}), 150).unref();
      return undefined;
    };
    const apps = freshApps();
    const a = await orgAdmin(apps);
    const id = await controller(a.agent, a.orgId, 'ubiquiti-unifi', mockBase());
    await setCredential(a.agent, a.orgId, id, {
      api_kind: 'unifi-network',
      base_url: mockBase(),
      secret: FAKE_UNIFI_KEY,
      external_site_id: UNIFI_SITE,
      tls_ca_pem: testPki().caPem,
    });
    const site = await vendorSite(a, 'unifi-external-portal', id, true, {
      methods: ['voucher', 'click_through'],
    });
    const voucher = await voucherFixture(a);
    clientMac = randomMac();
    const flow = await redirect(
      apps,
      'unifi',
      '/guest/s/default/',
      `ap=${site.apMac}&id=${clientMac}`,
    );
    // controller does not know the client → 502, voucher fully restored
    const failed = await voucherIdentify(apps, flow.body.flow_id as string, voucher.code);
    expect(failed.status).toBe(502);
    const v1 = await deps.dbPlatform
      .selectFrom('vouchers')
      .select(['use_count', 'status', 'activated_at', 'expires_at'])
      .where('id', '=', voucher.id)
      .executeTakeFirstOrThrow();
    expect(v1).toEqual({ use_count: 0, status: 'unused', activated_at: null, expires_at: null });

    // the same flow can be retried after a failure, and the (single-use) voucher still works;
    // two concurrent identifies on that flow reach the controller once
    known = true;
    const [r1, r2] = await Promise.all([
      voucherIdentify(apps, flow.body.flow_id as string, voucher.code),
      voucherIdentify(apps, flow.body.flow_id as string, voucher.code),
    ]);
    expect([r1.status, r2.status].sort()).toEqual([200, 409]);
    expect(authorise).toBe(1);
    const v2 = await deps.dbPlatform
      .selectFrom('vouchers')
      .select(['use_count', 'status'])
      .where('id', '=', voucher.id)
      .executeTakeFirstOrThrow();
    expect(v2).toEqual({ use_count: 1, status: 'exhausted' });
  });

  it('F6: only a tenant-listed host is a trusted continue target (and Mist forward)', async () => {
    mock.handler = (req, res) =>
      req.method === 'GET'
        ? json(res, 200, {
            data: [
              {
                id: 'c-6',
                macAddress: decodeURIComponent(req.url).match(/'([^']+)'/)?.[1] ?? '',
                access: { type: 'GUEST' },
              },
            ],
          })
        : json(res, 200, {});
    const apps = freshApps();
    const a = await orgAdmin(apps);
    const id = await controller(a.agent, a.orgId, 'ubiquiti-unifi', mockBase());
    await setCredential(a.agent, a.orgId, id, {
      api_kind: 'unifi-network',
      base_url: mockBase(),
      secret: FAKE_UNIFI_KEY,
      external_site_id: UNIFI_SITE,
      tls_ca_pem: testPki().caPem,
    });
    const site = await vendorSite(a, 'unifi-external-portal', id, true, {
      redirectUrl: 'https://hotel.example.com/welcome',
    });
    const go = async (url: string) => {
      const flow = await redirect(
        apps,
        'unifi',
        '/guest/s/default/',
        `ap=${site.apMac}&id=${randomMac()}&url=${encodeURIComponent(url)}`,
      );
      return (await clickThrough(apps, flow.body.flow_id as string)).body.handoff as Record<
        string,
        unknown
      >;
    };
    expect(await go('https://hotel.example.com/spa')).toMatchObject({
      host: 'hotel.example.com',
      trusted: true,
      landing_url: 'https://hotel.example.com/welcome',
    });
    expect(await go('https://evil.example.net/login')).toMatchObject({
      url: 'https://evil.example.net/login',
      host: 'evil.example.net',
      trusted: false,
      landing_url: 'https://hotel.example.com/welcome',
    });

    // Mist: an unlisted forward is replaced by the tenant's landing page
    const b = await orgAdmin(apps);
    const mistId = await controller(b.agent, b.orgId, 'juniper-mist', 'https://api.mist.com');
    await setCredential(b.agent, b.orgId, mistId, {
      api_kind: 'mist',
      base_url: 'https://api.mist.com',
      secret: FAKE_MIST_SECRET,
      settings: { mist_wlan_ids: [WLAN] },
    });
    const ms = await vendorSite(b, 'mist-guest-portal', mistId, true, {
      redirectUrl: 'https://hotel.example.com/welcome',
    });
    const flow = await redirect(
      apps,
      'mist',
      '/ext/mist',
      `wlan_id=${WLAN}&ap_mac=${ms.apMac.replace(/:/g, '')}&client_mac=${randomMac().replace(/:/g, '')}&url=${encodeURIComponent('https://evil.example.net/')}`,
    );
    const done = await clickThrough(apps, flow.body.flow_id as string);
    const forward = new URL(done.body.handoff.url as string).searchParams.get('forward');
    expect(forward).toBe('https://hotel.example.com/welcome');
    // F5: a Mist grant (LOGON_SENT) is never re-identified
    expect((await clickThrough(apps, flow.body.flow_id as string)).status).toBe(409);
  });
});
