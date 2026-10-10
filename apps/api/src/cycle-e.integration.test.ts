/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment -- supertest response bodies are untyped JSON */
/**
 * Multi-vendor Cycle E (Cisco Meraki, D-044, migration 032) against the test database:
 *  - Meraki NAS registration: no nas_ip, mandatory + unique NAS-Identifier, das_host shape,
 *    per-NAS listener ports from MERAKI_RADIUS_PORT_RANGE, no adapter switching;
 *  - setup guide + platform state endpoints (honest OFF state, no secret);
 *  - the splash flow: redirect → flow view (login token, allow-listed origin) → identify (token
 *    required, single use) → POST hand-off to login_url → Access-Request on the NAS's own
 *    listener (shortname) → accept; the consumed login_url cannot be replayed;
 *  - NAS-Identifier binding: missing / another tenant's identifier rejected; a shared source IP
 *    registered by another tenant never wins over the listener shortname;
 *  - flag OFF: portal entry refused, AAA refused, renderer emits no Meraki client.
 * Skipped without the dev stack (ECLOUD_TEST_DATABASE_URL).
 */
import { describeIntegration, migrateTestDatabase } from '@ecloud/testing';
import { parseMerakiCloudRadiusSettings } from '@ecloud/shared';
import { generate } from 'otplib';
import request from 'supertest';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createApp } from './app.js';
import type { AppDeps } from './context.js';
import { decisionKey } from './internal/aaa.js';
import type { RadiusRequestBody } from './internal/radius.js';
import { MemoryKv } from './kv.js';
import { loadMerakiEntries, renderMerakiListeners } from './radius-clients/meraki.js';
import {
  TEST_INTERNAL_TOKEN,
  TEST_ORIGIN,
  closeDeps,
  createAdmin,
  createTenant,
  integrationDeps,
  unique,
  type AdminFixture,
} from './test-support/deps.js';

type Agent = ReturnType<typeof request.agent>;
type Apps = ReturnType<typeof createApp> & { kv: MemoryKv };

const BROWSER = { Origin: TEST_ORIGIN, 'X-Requested-With': 'XMLHttpRequest' };
// Ordinary public test networks (NOT Meraki ranges; Meraki publishes none).
const CIDR = '64.1.2.0/24';
const MERAKI_SOURCE_IP = '64.1.2.10';
const PORT_RANGE = '40000-48191';

const SETTINGS_ON = parseMerakiCloudRadiusSettings({
  MERAKI_CLOUD_RADIUS_ENABLED: 'true',
  MERAKI_RADIUS_SOURCE_CIDRS: CIDR,
  MERAKI_RADIUS_PORT_RANGE: PORT_RANGE,
});
const SETTINGS_OFF = parseMerakiCloudRadiusSettings({
  MERAKI_RADIUS_SOURCE_CIDRS: CIDR,
  MERAKI_RADIUS_PORT_RANGE: PORT_RANGE,
});

function hex(n: number): string {
  return Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join('');
}

function randomMac(): { canonical: string; dashed: string } {
  const bytes = [0x02, ...Array.from({ length: 5 }, () => Math.floor(Math.random() * 256))];
  const h = bytes.map((b) => b.toString(16).padStart(2, '0'));
  return { canonical: h.join(':'), dashed: h.join('-').toUpperCase() };
}

function randomIp(): string {
  const b = () => Math.floor(Math.random() * 250) + 2;
  return `10.${String(b())}.${String(b())}.${String(b())}`;
}

function radius(attrs: Record<string, string | number>): RadiusRequestBody {
  return Object.fromEntries(
    Object.entries(attrs).map(([k, v]) => [
      k,
      { type: typeof v === 'number' ? 'integer' : 'string', value: [v] },
    ]),
  );
}

await describeIntegration('@ecloud/api multi-vendor Cycle E (Meraki)', () => {
  let base: AppDeps;
  let depsOn: AppDeps;
  let depsOff: AppDeps;

  beforeAll(async () => {
    await migrateTestDatabase();
    base = integrationDeps();
    depsOn = { ...base, config: { ...base.config, merakiCloudRadius: SETTINGS_ON } };
    depsOff = { ...base, config: { ...base.config, merakiCloudRadius: SETTINGS_OFF } };
  }, 60_000);

  afterAll(async () => {
    await closeDeps(base);
  });

  const appsOf = (d: AppDeps): Apps => {
    const kv = new MemoryKv();
    return Object.assign(createApp({ ...d, kv }), { kv });
  };

  async function login(apps: Apps, admin: AdminFixture): Promise<Agent> {
    const agent = request.agent(apps.publicApp);
    const res = await agent
      .post('/api/v1/auth/login')
      .set(BROWSER)
      .send({ email: admin.email, password: admin.password });
    expect(res.status).toBe(200);
    return agent;
  }

  async function orgAdmin(apps: Apps) {
    const tenant = await createTenant(base.dbPlatform);
    const admin = await createAdmin(base.dbPlatform, [
      { template: 'org_admin', scope: 'organization', orgId: tenant.orgId },
    ]);
    return { ...tenant, agent: await login(apps, admin) };
  }

  async function merakiNas(
    agent: Agent,
    orgId: string,
    siteId: string,
    extra: Record<string, unknown> = {},
  ) {
    const res = await agent
      .post(`/api/v1/orgs/${orgId}/nas`)
      .set(BROWSER)
      .send({
        site_id: siteId,
        name: unique('meraki'),
        adapter_key: 'meraki-splash',
        das_host: 'n165.meraki.com',
        ...extra,
      });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const identifier = res.body.nas_identifier as string;
    expect(identifier).toMatch(/^ecloud-[0-9a-f]{16}$/);
    return {
      id: res.body.id as string,
      identifier,
      authPort: res.body.cloud_radius_auth_port as number | null,
      acctPort: res.body.cloud_radius_acct_port as number | null,
      secret: res.body.secret as string,
    };
  }

  async function externalPortal(orgId: string, siteId: string, nasId: string) {
    await base.dbPlatform
      .insertInto('captive_portals')
      .values({
        organization_id: orgId,
        site_id: siteId,
        name: 'Meraki lobby',
        public_slug: unique('mp')
          .toLowerCase()
          .replace(/[^a-z0-9-]/g, '')
          .slice(0, 60),
        portal_type: 'external',
        network_ref: 'guest',
        auth_methods: ['click_through', 'password'],
        adapter_config: { nas_client_id: nasId },
      })
      .execute();
    // a site policy (AAA rejects `no_policy` otherwise); Session-Timeout is the only
    // Meraki-declared device field (REQUIRES_DEVICE_TEST), rates are not pushable.
    const policy = await base.dbPlatform
      .insertInto('policies')
      .values({
        organization_id: orgId,
        name: 'Meraki site',
        scope_type: 'site',
        site_id: siteId,
        status: 'active',
        session_timeout_s: 3600,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await base.dbPlatform
      .insertInto('policy_assignments')
      .values({
        organization_id: orgId,
        policy_id: policy.id,
        target_type: 'site',
        site_id: siteId,
      })
      .onConflict((oc) => oc.doNothing())
      .execute();
  }

  function signOnQuery(clientMac: string, mauth = hex(24)) {
    return new URLSearchParams({
      login_url: `https://n143.network-auth.com/splash/login?mauth=${mauth}`,
      continue_url: 'http://example.com/',
      ap_mac: randomMac().canonical,
      client_mac: clientMac,
      client_ip: '10.0.0.13',
    }).toString();
  }

  function redirect(apps: Apps, nasid: string, rawQuery: string) {
    return request(apps.internalApp)
      .post('/internal/portal/redirects')
      .set('X-Internal-Token', TEST_INTERNAL_TOKEN)
      .send({ flavour: 'meraki', nasid, raw_query: rawQuery, client_ip: randomIp() });
  }

  function flowView(apps: Apps, flowId: string) {
    return request(apps.internalApp)
      .get(`/internal/portal/flows/${flowId}`)
      .set('X-Internal-Token', TEST_INTERNAL_TOKEN);
  }

  function identify(apps: Apps, flowId: string, body: object) {
    return request(apps.internalApp)
      .post(`/internal/portal/flows/${flowId}/identify`)
      .set('X-Internal-Token', TEST_INTERNAL_TOKEN)
      .send(body);
  }

  function authorize(apps: Apps, body: RadiusRequestBody) {
    return request(apps.internalApp)
      .post('/internal/aaa/authorize')
      .set('X-Internal-Token', TEST_INTERNAL_TOKEN)
      .send(body);
  }

  async function reasonOf(apps: Apps, body: RadiusRequestBody): Promise<string | null> {
    const facts = await apps.kv.get(decisionKey(body));
    return facts === null
      ? null
      : ((JSON.parse(facts) as { reason: string | null }).reason ?? null);
  }

  /** Meraki Cloud Access-Request as FreeRADIUS forwards it from a Meraki NAS listener. */
  function merakiAccessRequest(
    nas: { id: string; identifier: string },
    cred: { username: string; password: string },
    clientMacDashed: string,
    over: Record<string, string> = {},
  ): RadiusRequestBody {
    return radius({
      'User-Name': cred.username,
      'User-Password': cred.password,
      'ECLOUD-Packet-Src-IP-Address': MERAKI_SOURCE_IP,
      'ECLOUD-Client-Shortname': nas.id,
      'NAS-Identifier': nas.identifier,
      'Calling-Station-Id': clientMacDashed,
      'Called-Station-Id': 'AA-BB-CC-00-00-01:Guest',
      'Acct-Session-Id': hex(16).toUpperCase(),
      'Framed-IP-Address': '10.0.0.13',
      ...over,
    });
  }

  /** Full portal flow up to the hand-off; returns the broker credential Meraki would forward. */
  async function signOn(apps: Apps, nas: { identifier: string }, clientMac: string) {
    const r = await redirect(apps, nas.identifier, signOnQuery(clientMac));
    expect(r.status).toBe(200);
    expect(r.body.kind, JSON.stringify(r.body)).toBe('flow');
    const flowId = r.body.flow_id as string;
    const view = await flowView(apps, flowId);
    expect(view.status).toBe(200);
    const token = view.body.meraki.login_token as string;
    const ok = await identify(apps, flowId, {
      method: 'click_through',
      accept_terms: true,
      login_token: token,
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const fields = ok.body.handoff.fields as Record<string, string>;
    return { flowId, token, handoff: ok.body.handoff, fields };
  }

  // ------------------------------------------------------------------------ registration rules

  it('registers a Meraki NAS without nas_ip, with listener ports, unique NAS-Identifier', async () => {
    const apps = appsOf(depsOn);
    const a = await orgAdmin(apps);
    const nasA = await merakiNas(a.agent, a.orgId, a.siteId);
    expect(nasA.authPort).not.toBeNull();
    expect(nasA.acctPort).toBe((nasA.authPort ?? 0) + 1);
    expect(typeof nasA.secret).toBe('string');

    const b = await orgAdmin(apps);
    const nasB = await merakiNas(b.agent, b.orgId, b.siteId);
    expect(nasB.authPort).not.toBe(nasA.authPort);

    expect(nasB.identifier).not.toBe(nasA.identifier);

    // the identifier is server-generated and read-only (review F3)
    const chosen = await b.agent.post(`/api/v1/orgs/${b.orgId}/nas`).set(BROWSER).send({
      site_id: b.siteId,
      name: 'dup',
      adapter_key: 'meraki-splash',
      nas_identifier: nasA.identifier,
    });
    expect(chosen.status).toBe(422);
    const renamed = await a.agent
      .patch(`/api/v1/orgs/${a.orgId}/nas/${nasA.id}`)
      .set(BROWSER)
      .send({ nas_identifier: 'ecloud-0000000000000000' });
    expect(renamed.status).toBe(422);
    // cross-adapter: no other NAS may use the reserved shape (create or patch)
    const reserved = await b.agent.post(`/api/v1/orgs/${b.orgId}/nas`).set(BROWSER).send({
      site_id: b.siteId,
      name: 'reserved',
      adapter_key: 'generic-radius-8021x',
      nas_ip: randomIp(),
      nas_identifier: nasA.identifier,
    });
    expect(reserved.status).toBe(422);
    const generic = await b.agent.post(`/api/v1/orgs/${b.orgId}/nas`).set(BROWSER).send({
      site_id: b.siteId,
      name: 'generic',
      adapter_key: 'generic-radius-8021x',
      nas_ip: randomIp(),
    });
    expect(generic.status).toBe(201);
    const patchReserved = await b.agent
      .patch(`/api/v1/orgs/${b.orgId}/nas/${generic.body.id as string}`)
      .set(BROWSER)
      .send({ nas_identifier: nasA.identifier });
    expect(patchReserved.status).toBe(422);
    // review F2: a Meraki Cloud source address can never become a NAS address
    const cloudIp = await b.agent.post(`/api/v1/orgs/${b.orgId}/nas`).set(BROWSER).send({
      site_id: b.siteId,
      name: 'cloud-ip',
      adapter_key: 'generic-radius-8021x',
      nas_ip: MERAKI_SOURCE_IP,
    });
    expect(cloudIp.status).toBe(422);
    const patchCloudIp = await b.agent
      .patch(`/api/v1/orgs/${b.orgId}/nas/${generic.body.id as string}`)
      .set(BROWSER)
      .send({ nas_ip: MERAKI_SOURCE_IP });
    expect(patchCloudIp.status).toBe(422);
    // review F7: Message-Authenticator cannot be relaxed on a Meraki NAS by default
    const relaxed = await a.agent.post(`/api/v1/orgs/${a.orgId}/nas`).set(BROWSER).send({
      site_id: a.siteId,
      name: 'relaxed',
      adapter_key: 'meraki-splash',
      require_message_authenticator: false,
    });
    expect(relaxed.status).toBe(422);
    const relaxPatch = await a.agent
      .patch(`/api/v1/orgs/${a.orgId}/nas/${nasA.id}`)
      .set(BROWSER)
      .send({ require_message_authenticator: false });
    expect(relaxPatch.status).toBe(422);

    const withIp = await a.agent.post(`/api/v1/orgs/${a.orgId}/nas`).set(BROWSER).send({
      site_id: a.siteId,
      name: 'x',
      adapter_key: 'meraki-splash',
      nas_ip: randomIp(),
    });
    expect(withIp.status).toBe(422);
    const badHost = await a.agent.post(`/api/v1/orgs/${a.orgId}/nas`).set(BROWSER).send({
      site_id: a.siteId,
      name: 'x',
      adapter_key: 'meraki-splash',
      das_host: 'evil.example',
    });
    expect(badHost.status).toBe(422);
    const genericNoIp = await a.agent
      .post(`/api/v1/orgs/${a.orgId}/nas`)
      .set(BROWSER)
      .send({ site_id: a.siteId, name: 'x', adapter_key: 'generic-radius-8021x' });
    expect(genericNoIp.status).toBe(422);
    const switchAdapter = await a.agent
      .patch(`/api/v1/orgs/${a.orgId}/nas/${nasA.id}`)
      .set(BROWSER)
      .send({ adapter_key: 'generic-radius-8021x' });
    expect(switchAdapter.status).toBe(422);
    const listed = await a.agent.get(`/api/v1/orgs/${a.orgId}/nas/${nasA.id}`).set(BROWSER);
    expect(listed.status).toBe(200);
    expect(listed.body.nas_ip).toBeNull();
    expect(listed.body.secret_ref).toBeUndefined();
  });

  it('setup guide and platform state are honest while the flag is OFF and never show a secret', async () => {
    const apps = appsOf(depsOff);
    const a = await orgAdmin(apps);
    const nas = await merakiNas(a.agent, a.orgId, a.siteId);
    const state = await a.agent.get(`/api/v1/orgs/${a.orgId}/meraki/cloud-radius`).set(BROWSER);
    expect(state.status).toBe(200);
    expect(state.body).toMatchObject({
      enabled: false,
      state: 'disabled',
      radius_reachable_from_meraki: 'no',
    });
    const guide = await a.agent
      .get(`/api/v1/orgs/${a.orgId}/nas/${nas.id}/setup-guide`)
      .set(BROWSER);
    expect(guide.status).toBe(200);
    const codes = (guide.body.warnings as { code: string }[]).map((w) => w.code);
    expect(codes).toContain('meraki_disabled');
    const text = JSON.stringify(guide.body);
    expect(text).toContain(`/meraki/${nas.identifier}/`);
    expect(text).toContain('Sign-on with my RADIUS server');
    expect(text).toContain('<RADIUS_SECRET>');
    expect(text).not.toContain(nas.secret);
  });

  // ------------------------------------------------------------------------------- the flow

  it('flow: redirect → login token → POST hand-off → Access-Request on the NAS listener → accept', async () => {
    const apps = appsOf(depsOn);
    const a = await orgAdmin(apps);
    const nas = await merakiNas(a.agent, a.orgId, a.siteId);
    await externalPortal(a.orgId, a.siteId, nas.id);
    const mac = randomMac();

    const query = signOnQuery(mac.canonical);
    const r = await redirect(apps, nas.identifier, query);
    expect(r.body.kind).toBe('flow');
    const flowId = r.body.flow_id as string;
    const view = await flowView(apps, flowId);
    expect(view.body.meraki).toMatchObject({
      mode: 'sign-on',
      handoff_origin: 'https://n143.network-auth.com',
    });
    expect(view.body.methods).toEqual(['password', 'click_through']);

    // no / forged token → refused before any identity check
    const noToken = await identify(apps, flowId, { method: 'click_through', accept_terms: true });
    expect(noToken.status).toBe(403);
    const forged = await identify(apps, flowId, {
      method: 'click_through',
      accept_terms: true,
      login_token: 'lt1.e30.AAAA',
    });
    expect(forged.status).toBe(403);

    const token = view.body.meraki.login_token as string;
    const ok = await identify(apps, flowId, {
      method: 'click_through',
      accept_terms: true,
      login_token: token,
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.handoff.method).toBe('POST-form');
    expect(ok.body.handoff.url).toBe(new URLSearchParams(query).get('login_url'));
    const fields = ok.body.handoff.fields as Record<string, string>;
    expect(Object.keys(fields).sort()).toEqual(['password', 'success_url', 'username']);
    expect(fields.success_url).toMatch(/\/meraki-done$/);

    // the same token again: single use
    const again = await identify(apps, flowId, {
      method: 'click_through',
      accept_terms: true,
      login_token: token,
    });
    expect(again.status).toBe(403);

    // Meraki Cloud forwards the credential to the NAS's own listener
    const body = merakiAccessRequest(
      nas,
      { username: fields.username ?? '', password: fields.password ?? '' },
      mac.dashed,
    );
    const accept = await authorize(apps, body);
    expect(accept.status, String(await reasonOf(apps, body))).toBe(200);

    // the consumed login_url (vendor nonce) cannot start another flow
    const replay = await redirect(apps, nas.identifier, query);
    expect(replay.body.kind).toBe('error');
  });

  // ------------------------------------------------------------------- NAS-Identifier binding

  it('rejects a missing NAS-Identifier and another tenant forging an identifier', async () => {
    const apps = appsOf(depsOn);
    const a = await orgAdmin(apps);
    const nasA = await merakiNas(a.agent, a.orgId, a.siteId);
    await externalPortal(a.orgId, a.siteId, nasA.id);
    const b = await orgAdmin(apps);
    const nasB = await merakiNas(b.agent, b.orgId, b.siteId);

    const mac = randomMac();
    const flow = await signOn(apps, nasA, mac.canonical);
    const cred = { username: flow.fields.username ?? '', password: flow.fields.password ?? '' };

    // missing NAS-Identifier on A's own listener
    const missing = merakiAccessRequest(nasA, cred, mac.dashed);
    delete missing['NAS-Identifier'];
    expect((await authorize(apps, missing)).status).toBe(401);
    expect(await reasonOf(apps, missing)).toBe('nas_identifier_missing');

    // tenant B's Meraki listener (B's secret → B's shortname) claiming A's NAS-Identifier
    const forged = merakiAccessRequest(
      { id: nasB.id, identifier: nasA.identifier },
      cred,
      mac.dashed,
    );
    const res = await authorize(apps, forged);
    expect(res.status).toBe(401);
    expect(await reasonOf(apps, forged)).toBe('nas_identifier_mismatch');

    // A's own listener with B's NAS-Identifier
    const wrongId = merakiAccessRequest(
      { id: nasA.id, identifier: nasB.identifier },
      cred,
      mac.dashed,
    );
    expect((await authorize(apps, wrongId)).status).toBe(401);
    expect(await reasonOf(apps, wrongId)).toBe('nas_identifier_mismatch');
    // B's listener with B's own identifier but A's credential: bound to A's NAS → rejected
    const crossNas = merakiAccessRequest(nasB, cred, mac.dashed);
    expect((await authorize(apps, crossNas)).status).toBe(401);

    // the credential is still unconsumed: the genuine request is accepted
    const genuine = merakiAccessRequest(nasA, cred, mac.dashed);
    expect((await authorize(apps, genuine)).status).toBe(200);
  });

  it('a shared Meraki source IP registered as another tenant nas_ip never selects that tenant', async () => {
    const apps = appsOf(depsOn);
    const a = await orgAdmin(apps);
    const nasA = await merakiNas(a.agent, a.orgId, a.siteId);
    await externalPortal(a.orgId, a.siteId, nasA.id);
    // tenant C squats a public address inside the Meraki range as its NAS IP
    const c = await orgAdmin(apps);
    const squatIp = `64.1.2.${String(100 + Math.floor(Math.random() * 150))}`;
    // free the address if an earlier run of this test holds it (soft delete, as the API does)
    await base.dbPlatform
      .updateTable('nas_clients')
      .set({ deleted_at: new Date() })
      .where('nas_ip', '=', squatIp)
      .where('deleted_at', 'is', null)
      .execute();
    // the API now refuses it (review F2); simulate a row registered before the ranges were
    // configured, directly in the database
    const refused = await c.agent.post(`/api/v1/orgs/${c.orgId}/nas`).set(BROWSER).send({
      site_id: c.siteId,
      name: 'squat',
      adapter_key: 'generic-radius-8021x',
      nas_ip: squatIp,
    });
    expect(refused.status).toBe(422);
    await base.dbPlatform
      .insertInto('nas_clients')
      .values({
        organization_id: c.orgId,
        site_id: c.siteId,
        name: 'squat',
        nas_ip: squatIp,
        adapter_type_key: 'generic-radius-8021x',
        adapter_key: 'generic-radius-8021x',
        secret_ref: 'enc:placeholder',
      })
      .execute();

    const mac = randomMac();
    const flow = await signOn(apps, nasA, mac.canonical);
    const body = merakiAccessRequest(
      nasA,
      { username: flow.fields.username ?? '', password: flow.fields.password ?? '' },
      mac.dashed,
      { 'ECLOUD-Packet-Src-IP-Address': squatIp },
    );
    const res = await authorize(apps, body);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const facts = JSON.parse((await apps.kv.get(decisionKey(body))) ?? 'null') as {
      organization_id: string;
    } | null;
    expect(facts?.organization_id).toBe(a.orgId);
  });

  // ------------------------------------------------------------------------------- flag OFF

  it('flag OFF: portal entry refused, AAA refused, no Meraki client rendered', async () => {
    const on = appsOf(depsOn);
    const a = await orgAdmin(on);
    const nas = await merakiNas(a.agent, a.orgId, a.siteId);
    await externalPortal(a.orgId, a.siteId, nas.id);
    const mac = randomMac();
    const flow = await signOn(on, nas, mac.canonical);

    const off = appsOf(depsOff);
    const r = await redirect(off, nas.identifier, signOnQuery(mac.canonical));
    expect(r.body.kind).toBe('error');
    const offBody = merakiAccessRequest(
      nas,
      { username: flow.fields.username ?? '', password: flow.fields.password ?? '' },
      mac.dashed,
    );
    const denied = await authorize(off, offBody);
    expect(denied.status).toBe(401);
    expect(await reasonOf(off, offBody)).toBe('meraki_cloud_radius_disabled');

    const loaded = await loadMerakiEntries(base.dbPlatform, base.config.dataEncryptionKey, {
      organizationIds: [a.orgId],
    });
    expect(loaded.entries.map((e) => e.id)).toEqual([nas.id]);
    const rendOff = renderMerakiListeners(loaded.entries, SETTINGS_OFF, loaded.skipped);
    expect(rendOff.rendered).toEqual([]);
    expect(rendOff.content).not.toMatch(/^\s*(listen|clients?)\b/m);
    expect(rendOff.content).not.toContain(nas.secret);
    const rendOn = renderMerakiListeners(loaded.entries, SETTINGS_ON, loaded.skipped);
    expect(rendOn.rendered.map((e) => e.id)).toEqual([nas.id]);
    expect(rendOn.content).toContain(`shortname = ${nas.id}`);
    expect(rendOn.content).toContain(`port = ${String(nas.authPort)}`);
  });
  // --------------------------------------------------------------- review F2 / F3 / F6 additions

  it('a stale or unknown listener shortname never falls back to the source address', async () => {
    const apps = appsOf(depsOn);
    const a = await orgAdmin(apps);
    const nas = await merakiNas(a.agent, a.orgId, a.siteId);
    await externalPortal(a.orgId, a.siteId, nas.id);
    const c = await orgAdmin(apps);
    const ip = randomIp();
    const generic = await c.agent.post(`/api/v1/orgs/${c.orgId}/nas`).set(BROWSER).send({
      site_id: c.siteId,
      name: 'generic',
      adapter_key: 'generic-radius-8021x',
      nas_ip: ip,
    });
    expect(generic.status).toBe(201);
    const mac = randomMac();
    const flow = await signOn(apps, nas, mac.canonical);
    const cred = { username: flow.fields.username ?? '', password: flow.fields.password ?? '' };
    // the Meraki NAS is disabled while FreeRADIUS still runs its (stale) listener
    const disabled = await a.agent
      .patch(`/api/v1/orgs/${a.orgId}/nas/${nas.id}`)
      .set(BROWSER)
      .send({ status: 'disabled' });
    expect(disabled.status).toBe(200);
    const stale = merakiAccessRequest(nas, cred, mac.dashed, {
      'ECLOUD-Packet-Src-IP-Address': ip,
    });
    expect((await authorize(apps, stale)).status).toBe(401);
    expect(await reasonOf(apps, stale)).toBe('unknown_nas');
    // a shortname naming no NAS at all
    const unknown = merakiAccessRequest(
      { id: '01900000-0000-7000-8000-00000000dead', identifier: nas.identifier },
      cred,
      mac.dashed,
      { 'ECLOUD-Packet-Src-IP-Address': ip },
    );
    expect((await authorize(apps, unknown)).status).toBe(401);
    expect(await reasonOf(apps, unknown)).toBe('unknown_nas');
  });

  it('caps live Meraki NAS per organization; relaxed Message-Authenticator only when allowed', async () => {
    const capped: AppDeps = {
      ...base,
      config: { ...base.config, merakiCloudRadius: { ...SETTINGS_ON, maxNasPerOrg: 2 } },
    };
    const apps = appsOf(capped);
    const a = await orgAdmin(apps);
    await merakiNas(a.agent, a.orgId, a.siteId);
    const second = await merakiNas(a.agent, a.orgId, a.siteId);
    const third = await a.agent
      .post(`/api/v1/orgs/${a.orgId}/nas`)
      .set(BROWSER)
      .send({ site_id: a.siteId, name: 'third', adapter_key: 'meraki-splash' });
    expect(third.status).toBe(422);
    const del = await a.agent.delete(`/api/v1/orgs/${a.orgId}/nas/${second.id}`).set(BROWSER);
    expect(del.status).toBe(204);
    await merakiNas(a.agent, a.orgId, a.siteId);

    const relaxedDeps: AppDeps = {
      ...base,
      config: {
        ...base.config,
        merakiCloudRadius: { ...SETTINGS_ON, allowRelaxedMessageAuthenticator: true },
      },
    };
    const relaxedApps = appsOf(relaxedDeps);
    const r = await orgAdmin(relaxedApps);
    const relaxed = await merakiNas(r.agent, r.orgId, r.siteId, {
      require_message_authenticator: false,
    });
    expect(relaxed.id).toBeTruthy();
  });

  it('platform release of a Meraki NAS-Identifier (audited, platform scope only)', async () => {
    const apps = appsOf(depsOn);
    const a = await orgAdmin(apps);
    const nas = await merakiNas(a.agent, a.orgId, a.siteId);
    const tenantTry = await a.agent
      .post('/api/v1/platform/meraki/nas-identifiers/release')
      .set(BROWSER)
      .send({ nas_identifier: nas.identifier, reason: 'support ticket 1234' });
    expect(tenantTry.status).toBe(403);
    const admin = await createAdmin(base.dbPlatform, [
      { template: 'platform_super_admin', scope: 'platform' },
    ]);
    const platform = await login(apps, admin);
    // platform administrators act only with MFA (as in the Cycle A release test)
    const enrol = await platform.post('/api/v1/auth/mfa/enrol').set(BROWSER);
    await platform
      .post('/api/v1/auth/mfa/confirm')
      .set(BROWSER)
      .send({ code: await generate({ secret: enrol.body.secret as string }) });
    const res = await platform
      .post('/api/v1/platform/meraki/nas-identifiers/release')
      .set(BROWSER)
      .send({ nas_identifier: nas.identifier, reason: 'support ticket 1234' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ released: true, organization_id: a.orgId });
    const row = await base.dbPlatform
      .selectFrom('nas_clients')
      .select(['deleted_at'])
      .where('id', '=', nas.id)
      .executeTakeFirstOrThrow();
    expect(row.deleted_at).not.toBeNull();
    const audit = await base.dbPlatform
      .selectFrom('audit_logs')
      .select(['action'])
      .where('target_id', '=', nas.id)
      .where('action', '=', 'nas:meraki_identifier:release')
      .execute();
    expect(audit).toHaveLength(1);
    const again = await platform
      .post('/api/v1/platform/meraki/nas-identifiers/release')
      .set(BROWSER)
      .send({ nas_identifier: nas.identifier, reason: 'support ticket 1234' });
    expect(again.status).toBe(404);
  });
});
