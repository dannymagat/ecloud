/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument -- supertest response bodies are untyped JSON */
/**
 * Multi-vendor Cycle B (D-044): MikroTik RouterOS Hotspot end to end against the test database
 * and the test Redis (ECLOUD_TEST_REDIS_URL, else the in-process store):
 *
 *   router login.html redirect (documented RouterOS variables) → POST /internal/portal/redirects
 *   (flavour mikrotik) → identify → POST-form hand-off to link-login-only with
 *   CHAP = MD5(chap-id ‖ password ‖ chap-challenge) → the router's Access-Request (CHAP) →
 *   /internal/aaa/authorize answers Auth-Type CHAP + Cleartext-Password and, for a NAS with the
 *   lab opt-in, Mikrotik-Rate-Limit / Mikrotik-Total-Limit(+Gigawords) / timers.
 *
 * The router side is emulated here from the vendor documentation; nothing proves device
 * behaviour (every MikroTik cell stays REQUIRES_DEVICE_TEST).
 */
import { MIKROTIK_DEFAULT_COA_PORT, computeMikrotikChapPassword } from '@ecloud/adapters';
import { describeIntegration, getTestRedisUrl, migrateTestDatabase } from '@ecloud/testing';
import { generate } from 'otplib';
import { createHash, randomBytes } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createApp } from './app.js';
import type { AppDeps } from './context.js';
import { retransmitKey } from './internal/aaa.js';
import type { RadiusRequestBody } from './internal/radius.js';
import { RedisKv } from './kv.js';
import {
  TEST_INTERNAL_TOKEN,
  TEST_ORIGIN,
  closeDeps,
  createAdmin,
  createTenant,
  integrationDeps,
  unique,
} from './test-support/deps.js';

const BROWSER = { Origin: TEST_ORIGIN, 'X-Requested-With': 'XMLHttpRequest' };

function randomIp(): string {
  const b = () => Math.floor(Math.random() * 250) + 2;
  return `10.${String(b())}.${String(b())}.${String(b())}`;
}

function routerMac(): string {
  const bytes = [0x02, ...Array.from(randomBytes(5))];
  return bytes.map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(':');
}

/** RouterOS `$(chap-…)` rendering: every byte as `\ooo` (vendor doc examples). */
function octal(bytes: Buffer): string {
  return Array.from(bytes, (b) => `\\${b.toString(8).padStart(3, '0')}`).join('');
}

function radius(attrs: Record<string, string | number>): RadiusRequestBody {
  return Object.fromEntries(
    Object.entries(attrs).map(([k, v]) => [
      k,
      { type: typeof v === 'number' ? 'integer' : 'string', value: [v] },
    ]),
  );
}

await describeIntegration('@ecloud/api multi-vendor Cycle B (MikroTik / Teltonika)', () => {
  let deps: AppDeps;
  let apps: ReturnType<typeof createApp>;

  beforeAll(async () => {
    await migrateTestDatabase();
    deps = integrationDeps();
    const redisUrl = getTestRedisUrl();
    if (redisUrl !== undefined) deps.kv = RedisKv.connect(redisUrl);
    apps = createApp(deps);
  }, 60_000);

  afterAll(async () => {
    await closeDeps(deps);
  });

  interface Fixture {
    orgId: string;
    siteId: string;
    nasId: string;
    nasIp: string;
    identity: string;
  }

  async function fixture(opts: { lab: boolean; quota?: number }): Promise<Fixture> {
    const { orgId, siteId } = await createTenant(deps.dbPlatform);
    const nasIp = randomIp();
    const identity = unique('mt');
    const nas = await deps.dbPlatform
      .insertInto('nas_clients')
      .values({
        organization_id: orgId,
        site_id: siteId,
        name: 'MikroTik hEX',
        nas_identifier: identity,
        nas_ip: nasIp,
        adapter_type_key: 'mikrotik-hotspot',
        adapter_key: 'mikrotik-hotspot',
        deployment_mode: 'gateway',
        secret_ref: 'enc:placeholder',
        device_test_attributes: opts.lab,
        hotspot_address: '10.5.50.1',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await deps.dbPlatform
      .insertInto('captive_portals')
      .values({
        organization_id: orgId,
        site_id: siteId,
        name: 'Lobby',
        public_slug: unique('mt')
          .toLowerCase()
          .replace(/[^a-z0-9-]/g, '')
          .slice(0, 60),
        portal_type: 'mikrotik',
        network_ref: 'hotspot1',
        auth_methods: ['click_through'],
      })
      .execute();
    const policy = await deps.dbPlatform
      .insertInto('policies')
      .values({
        organization_id: orgId,
        name: 'Site 10M',
        scope_type: 'site',
        status: 'active',
        download_rate_kbps: 10_000,
        upload_rate_kbps: 2_000,
        session_timeout_s: 3_600,
        idle_timeout_s: 600,
        quota_total_bytes: opts.quota ?? null,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await deps.dbPlatform
      .insertInto('policy_assignments')
      .values({
        organization_id: orgId,
        policy_id: policy.id,
        target_type: 'site',
        site_id: siteId,
      })
      .execute();
    return { orgId, siteId, nasId: nas.id, nasIp, identity };
  }

  interface Router {
    mac: string;
    chapId: Buffer;
    challenge: Buffer;
    query: string;
  }

  /** What the ECLOUD login.html makes the browser request (names = RouterOS variables). */
  function routerRedirect(f: Fixture, over: Record<string, string> = {}): Router {
    const mac = routerMac();
    const chapId = randomBytes(1);
    const challenge = randomBytes(16);
    const query = new URLSearchParams({
      mac,
      ip: '10.5.50.23',
      identity: f.identity,
      'link-login-only': 'http://10.5.50.1/login',
      'link-orig': 'https://www.example.com/news',
      'chap-id': octal(chapId),
      'chap-challenge': octal(challenge),
      error: '',
      ...over,
    }).toString();
    return { mac, chapId, challenge, query };
  }

  function postRedirect(query: string) {
    return request(apps.internalApp)
      .post('/internal/portal/redirects')
      .set('X-Internal-Token', TEST_INTERNAL_TOKEN)
      .send({ flavour: 'mikrotik', raw_query: query, client_ip: randomIp() });
  }

  function identify(flowId: string) {
    return request(apps.internalApp)
      .post(`/internal/portal/flows/${flowId}/identify`)
      .set('X-Internal-Token', TEST_INTERNAL_TOKEN)
      .send({ method: 'click_through', accept_terms: true, client_ip: randomIp() });
  }

  function authorize(body: RadiusRequestBody) {
    return request(apps.internalApp)
      .post('/internal/aaa/authorize')
      .set('X-Internal-Token', TEST_INTERNAL_TOKEN)
      .send(body);
  }

  /** The router's HTTP-CHAP Access-Request for the posted form (vendor RADIUS doc facts). */
  function chapAccessRequest(f: Fixture, r: Router, username: string, chapHex: string) {
    return radius({
      'User-Name': username,
      // rlm_rest sends octets as raw bytes; presence is what the API looks at (contract §2).
      'CHAP-Password': Buffer.concat([r.chapId, Buffer.from(chapHex, 'hex')]).toString('latin1'),
      'CHAP-Challenge': r.challenge.toString('latin1'),
      'ECLOUD-Packet-Src-IP-Address': f.nasIp,
      'NAS-Identifier': f.identity,
      'Calling-Station-Id': r.mac,
      'Called-Station-Id': 'hotspot1',
      'NAS-Port-Id': 'ether2',
      'Acct-Session-Id': `81${randomBytes(3).toString('hex')}`,
      'Framed-IP-Address': '10.5.50.23',
    });
  }

  async function handoff(f: Fixture, r: Router) {
    const red = await postRedirect(r.query);
    expect(red.status, JSON.stringify(red.body)).toBe(200);
    expect(red.body.kind).toBe('flow');
    const flowId = red.body.flow_id as string;
    const view = await request(apps.internalApp)
      .get(`/internal/portal/flows/${flowId}`)
      .set('X-Internal-Token', TEST_INTERNAL_TOKEN);
    expect(view.status).toBe(200);
    expect(view.body.nas).toEqual({ origin: 'http://10.5.50.1:80' });
    expect(view.body.continue_url).toBe('https://www.example.com/news');
    const id = await identify(flowId);
    expect(id.status, JSON.stringify(id.body)).toBe(200);
    return { flowId, handoff: id.body.handoff };
  }

  it('full flow: redirect → portal → POST-form CHAP hand-off → authorize returns Mikrotik attributes (lab NAS)', async () => {
    const f = await fixture({ lab: true, quota: 6_000_000_000 });
    const r = routerRedirect(f);
    const { handoff: h } = await handoff(f, r);

    // POST to $(link-login-only) with the documented login.html fields.
    expect(h.method).toBe('POST-form');
    expect(h.url).toBe('http://10.5.50.1:80/login');
    expect(Object.keys(h.fields).sort()).toEqual(['dst', 'password', 'popup', 'username']);
    expect(h.fields.dst).toBe('https://www.example.com/news');
    expect(h.fields.username).toMatch(/^pc-[0-9a-f]{16}$/);
    expect(h.fields.password).toMatch(/^[0-9a-f]{32}$/);

    const request0 = chapAccessRequest(f, r, h.fields.username, h.fields.password);
    const res = await authorize(request0);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body['control:Auth-Type'].value).toEqual(['CHAP']);
    // Review F2: the retransmit cache holds the CHAP cleartext sealed only; a retransmit gets the
    // identical answer back.
    const cachedRaw = await deps.kv.get(retransmitKey(request0));
    expect(cachedRaw).not.toBeNull();
    const cleartext = res.body['control:Cleartext-Password'].value[0] as string;
    expect(cachedRaw).not.toContain(cleartext);
    expect(cachedRaw).not.toContain('Cleartext-Password');
    expect(JSON.parse(cachedRaw ?? '{}').sealedCleartext).toMatch(/^enc:/);
    const retransmit = await authorize(request0);
    expect(retransmit.status).toBe(200);
    expect(retransmit.body).toEqual(res.body);
    // A different CHAP response is a different packet (not answered from the cache).
    const otherChap = { ...request0, 'CHAP-Password': { value: ['\u0001different'] } };
    expect(retransmitKey(otherChap)).not.toBe(retransmitKey(request0));
    // FreeRADIUS `chap` verifies the router's CHAP-Password against this cleartext: prove the
    // hand-off hash is exactly MD5(chap-id ‖ cleartext ‖ chap-challenge).
    const clear = res.body['control:Cleartext-Password'].value[0] as string;
    expect(computeMikrotikChapPassword(r.chapId, clear, r.challenge)).toBe(h.fields.password);
    expect(
      createHash('md5')
        .update(Buffer.concat([r.chapId, Buffer.from(clear), r.challenge]))
        .digest('hex'),
    ).toBe(h.fields.password);

    expect(res.body['reply:Mikrotik-Rate-Limit'].value).toEqual(['2M/10M']);
    expect(res.body['reply:Mikrotik-Total-Limit'].value).toEqual([6_000_000_000 % 4_294_967_296]);
    expect(res.body['reply:Mikrotik-Total-Limit-Gigawords'].value).toEqual([1]);
    expect(res.body['reply:Session-Timeout']).toBeDefined();
    expect(res.body['reply:Idle-Timeout'].value).toEqual([600]);
    expect(res.body['reply:Class'].value[0]).toMatch(/^ai:[0-9a-f]{32}$/);

    // Every emitted attribute is recorded as experimental (REQUIRES_DEVICE_TEST, D-028).
    const tr = await deps.dbPlatform
      .selectFrom('policy_translations')
      .select(['emitted', 'adapter_type_key'])
      .where('nas_client_id', '=', f.nasId)
      .executeTakeFirstOrThrow();
    expect(tr.adapter_type_key).toBe('mikrotik-hotspot');
    const emitted = (typeof tr.emitted === 'string' ? JSON.parse(tr.emitted) : tr.emitted) as {
      name: string;
    }[];
    expect(emitted.map((a) => a.name)).toContain('Mikrotik-Rate-Limit');

    // Single use: the same credential again (new packet) is refused.
    const again = chapAccessRequest(f, r, h.fields.username, h.fields.password);
    again['Acct-Session-Id'] = { type: 'string', value: ['81ffffff'] };
    expect((await authorize(again)).status).toBe(401);
    // The redirect's CHAP challenge is consumed (vendor-nonce replay key).
    const replay = await postRedirect(r.query);
    expect(replay.body.kind).toBe('error');
  });

  it('without the lab opt-in the NAS gets Auth-Type + Class only (REQUIRES_DEVICE_TEST withheld)', async () => {
    const f = await fixture({ lab: false });
    const r = routerRedirect(f);
    const { handoff: h } = await handoff(f, r);
    const res = await authorize(chapAccessRequest(f, r, h.fields.username, h.fields.password));
    expect(res.status).toBe(200);
    expect(res.body['control:Auth-Type'].value).toEqual(['CHAP']);
    const replyKeys = Object.keys(res.body).filter((k) => k.startsWith('reply:'));
    expect(replyKeys).toEqual(['reply:Class']);
  });

  it('binding: wrong NAS, wrong MAC, PAP for a CHAP credential and non-portal CHAP are refused', async () => {
    const f = await fixture({ lab: true });
    const other = await fixture({ lab: true });
    const r = routerRedirect(f);
    const { handoff: h } = await handoff(f, r);
    const body = chapAccessRequest(f, r, h.fields.username, h.fields.password);
    expect(
      (await authorize({ ...body, 'ECLOUD-Packet-Src-IP-Address': { value: [other.nasIp] } }))
        .status,
    ).toBe(401);
    expect(
      (await authorize({ ...body, 'Calling-Station-Id': { value: ['02-00-00-00-00-99'] } })).status,
    ).toBe(401);
    // Router identity must match the registered NAS identifier (own Acct-Session-Id so the
    // retransmit cache does not answer the genuine request below).
    const wrongIdentity = {
      ...body,
      'NAS-Identifier': { value: ['someone-else'] },
      'Acct-Session-Id': { value: ['81000001'] },
    };
    expect((await authorize(wrongIdentity)).status).toBe(401);
    // A CHAP request for a non-portal user name stays unsupported.
    const plain = radius({
      'User-Name': 'alice',
      'CHAP-Password': 'x',
      'ECLOUD-Packet-Src-IP-Address': f.nasIp,
      'Calling-Station-Id': r.mac,
    });
    expect((await authorize(plain)).status).toBe(401);
    // The genuine request still works afterwards (nothing above consumed the credential).
    expect((await authorize(body)).status).toBe(200);
  });

  it('PAP over http is refused at the hand-off; https target gets a PAP form', async () => {
    const f = await fixture({ lab: false });
    const noChap = routerRedirect(f, { 'chap-id': '', 'chap-challenge': '' });
    const red = await postRedirect(noChap.query);
    expect(red.body.kind).toBe('flow');
    const id = await identify(red.body.flow_id as string);
    expect(id.status).toBe(422);
    expect(id.body.result).toBe('handoff_unavailable');

    const https = routerRedirect(f, {
      'chap-id': '',
      'chap-challenge': '',
      'link-login-only': 'https://10.5.50.1/login',
    });
    const red2 = await postRedirect(https.query);
    const id2 = await identify(red2.body.flow_id as string);
    expect(id2.status).toBe(200);
    expect(id2.body.handoff.url).toBe('https://10.5.50.1:443/login');
    // The flow's login token is single use: a second identify gets no second credential.
    const second = await identify(red2.body.flow_id as string);
    expect(second.status).toBe(422);
    expect(second.body.result).toBe('handoff_unavailable');
    const pap = radius({
      'User-Name': id2.body.handoff.fields.username,
      'User-Password': id2.body.handoff.fields.password,
      'ECLOUD-Packet-Src-IP-Address': f.nasIp,
      'NAS-Identifier': f.identity,
      'Calling-Station-Id': https.mac,
    });
    const ok = await authorize(pap);
    expect(ok.status).toBe(200);
    expect(ok.body['control:Auth-Type'].value).toEqual(['Accept']);
    // Authorized flow: further identify calls answer flow_state.
    const again = await identify(red2.body.flow_id as string);
    expect(again.status).toBe(409);
  });

  it('redirect refusals: unknown identity, public login target, malformed CHAP', async () => {
    const f = await fixture({ lab: false });
    const overrides: Record<string, string>[] = [
      // Review F1: a login target other than the registered hotspot address (attacker host on
      // the same LAN), for CHAP and for a PAP https target.
      { 'link-login-only': 'http://10.5.50.66/login' },
      { 'chap-id': '', 'chap-challenge': '', 'link-login-only': 'https://10.5.50.77/login' },
      { identity: 'no-such-router' },
      { 'link-login-only': 'http://203.0.113.10/login' },
      { 'chap-id': 'abc' },
    ];
    for (const over of overrides) {
      const res = await postRedirect(routerRedirect(f, over).query);
      expect(res.status).toBe(200);
      expect(res.body.kind).toBe('error');
    }
  });

  it('NAS API: mikrotik-hotspot defaults the CoA port to 1700; lab opt-in is a NAS field', async () => {
    const { orgId, siteId } = await createTenant(deps.dbPlatform);
    const admin = await createAdmin(deps.dbPlatform, [
      { template: 'org_admin', scope: 'organization', orgId },
    ]);
    const agent = request.agent(apps.publicApp);
    const login = await agent
      .post('/api/v1/auth/login')
      .set(BROWSER)
      .send({ email: admin.email, password: admin.password });
    expect(login.status).toBe(200);
    const mt = await agent
      .post(`/api/v1/orgs/${orgId}/nas`)
      .set(BROWSER)
      .send({
        site_id: siteId,
        name: 'mt',
        nas_ip: randomIp(),
        nas_identifier: unique('mt'),
        adapter_key: 'mikrotik-hotspot',
        hotspot_address: '10.5.50.1',
      });
    expect(mt.status, JSON.stringify(mt.body)).toBe(201);
    expect(mt.body.hotspot_address).toBe('10.5.50.1');
    expect(mt.body.coa_port).toBe(MIKROTIK_DEFAULT_COA_PORT);
    expect(mt.body.device_test_attributes).toBe(false);
    // Registry row lists gateway + native: the existing rule defaults an ambiguous adapter to native.
    expect(mt.body.deployment_mode).toBe('native');
    // Review F1: the hotspot address is required for MikroTik and must be private unicast IPv4.
    for (const bad of [{}, { hotspot_address: '8.8.8.8' }, { hotspot_port: 80 }]) {
      const res = await agent
        .post(`/api/v1/orgs/${orgId}/nas`)
        .set(BROWSER)
        .send({
          site_id: siteId,
          name: 'mt-bad',
          nas_ip: randomIp(),
          adapter_key: 'mikrotik-hotspot',
          ...bad,
        });
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
    // Review F3: an organization admin cannot switch on lab mode (create or patch).
    const denied = await agent.post(`/api/v1/orgs/${orgId}/nas`).set(BROWSER).send({
      site_id: siteId,
      name: 'mt-lab',
      nas_ip: randomIp(),
      adapter_key: 'mikrotik-hotspot',
      hotspot_address: '10.5.50.1',
      device_test_attributes: true,
    });
    expect(denied.status).toBe(403);
    const patchDenied = await agent
      .patch(`/api/v1/orgs/${orgId}/nas/${mt.body.id as string}`)
      .set(BROWSER)
      .send({ device_test_attributes: true });
    expect(patchDenied.status).toBe(403);
    const explicit = await agent.post(`/api/v1/orgs/${orgId}/nas`).set(BROWSER).send({
      site_id: siteId,
      name: 'mt2',
      nas_ip: randomIp(),
      adapter_key: 'mikrotik-hotspot',
      hotspot_address: '192.168.88.1',
      hotspot_port: 8080,
      coa_port: 3799,
    });
    expect(explicit.status).toBe(201);
    expect([explicit.body.coa_port, explicit.body.hotspot_port]).toEqual([3799, 8080]);

    // A platform admin (platform:adapter:manage, MFA) may; the change is audited.
    const platformAdmin = await createAdmin(deps.dbPlatform, [
      { template: 'platform_super_admin', scope: 'platform' },
    ]);
    const platform = request.agent(apps.publicApp);
    expect(
      (
        await platform
          .post('/api/v1/auth/login')
          .set(BROWSER)
          .send({ email: platformAdmin.email, password: platformAdmin.password })
      ).status,
    ).toBe(200);
    const enrol = await platform.post('/api/v1/auth/mfa/enrol').set(BROWSER);
    await platform
      .post('/api/v1/auth/mfa/confirm')
      .set(BROWSER)
      .send({ code: await generate({ secret: enrol.body.secret as string }) });
    const lab = await platform
      .patch(`/api/v1/orgs/${orgId}/nas/${mt.body.id as string}`)
      .set(BROWSER)
      .send({ device_test_attributes: true });
    expect(lab.status, JSON.stringify(lab.body)).toBe(200);
    expect(lab.body.device_test_attributes).toBe(true);
    const audit = await deps.dbPlatform
      .selectFrom('audit_logs')
      .select(['action', 'target_id'])
      .where('organization_id', '=', orgId)
      .where('action', '=', 'nas:lab_mode_changed')
      .execute();
    expect(audit).toEqual([{ action: 'nas:lab_mode_changed', target_id: mt.body.id }]);
    const coova = await agent.post(`/api/v1/orgs/${orgId}/nas`).set(BROWSER).send({
      site_id: siteId,
      name: 'teltonika',
      nas_ip: randomIp(),
      adapter_key: 'coovachilli-uam',
    });
    expect(coova.status).toBe(201);
    expect(coova.body.coa_port).toBeNull();
    // Captive portal type `mikrotik` is accepted (migration 029).
    const portal = await agent
      .post(`/api/v1/orgs/${orgId}/captive-portals`)
      .set(BROWSER)
      .send({
        site_id: siteId,
        name: 'MT lobby',
        public_slug: unique('mtp')
          .toLowerCase()
          .replace(/[^a-z0-9-]/g, '')
          .slice(0, 60),
        portal_type: 'mikrotik',
        network_ref: 'hotspot1',
      });
    expect(portal.status, JSON.stringify(portal.body)).toBe(201);
  });
});
