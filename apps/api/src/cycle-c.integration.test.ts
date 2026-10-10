/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment -- supertest response bodies are untyped JSON */
/**
 * Multi-vendor Cycle C (D-044, migration 030): F3 external-portal post-back engine end to end
 * against the test database (+ Redis when ECLOUD_TEST_REDIS_URL is set):
 *   vendor redirect → /internal/portal/postback/redirects → flow view (login origin + single-use
 *   login token) → identify (token consumed) → POST-form hand-off to the AP / controller →
 *   /internal/aaa/authorize with the `pc-…` credential (as the device would send it).
 * Security: foreign login host refused, login-token replay refused, unverified AP MAC refused,
 * cross-tenant token / NAS refused, NAS adapter_config validation. Redirects are built from the
 * documented parameter names only; nothing here proves device behaviour (REQUIRES_DEVICE_TEST).
 */
import { hashPassword } from '@ecloud/db';
import { describeIntegration, getTestRedisUrl, migrateTestDatabase } from '@ecloud/testing';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createApp } from './app.js';
import type { AppDeps } from './context.js';
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

type Agent = ReturnType<typeof request.agent>;

const BROWSER = { Origin: TEST_ORIGIN, 'X-Requested-With': 'XMLHttpRequest' };
const SUB_PASSWORD = 'sub-password-1';

const b = () => Math.floor(Math.random() * 250) + 2;
const randomIp = () => `10.${String(b())}.${String(b())}.${String(b())}`;
/** Locally administered unicast MAC, `AA-BB-…` (Cambium / Omada wire format). */
function randomMac(): { dashed: string; colon: string } {
  const bytes = [0x02, ...Array.from(randomBytes(5))];
  const hex = bytes.map((x) => x.toString(16).padStart(2, '0'));
  return { dashed: hex.join('-').toUpperCase(), colon: hex.join(':') };
}

function radius(attrs: Record<string, string | number>): RadiusRequestBody {
  return Object.fromEntries(
    Object.entries(attrs).map(([k, v]) => [
      k,
      { type: typeof v === 'number' ? 'integer' : 'string', value: [v] },
    ]),
  );
}

await describeIntegration('@ecloud/api multi-vendor Cycle C (post-back engine)', () => {
  let deps: AppDeps;
  let apps: ReturnType<typeof createApp>;
  let hash: string;

  beforeAll(async () => {
    await migrateTestDatabase();
    deps = integrationDeps();
    const redisUrl = getTestRedisUrl();
    if (redisUrl !== undefined) deps.kv = RedisKv.connect(redisUrl);
    apps = createApp(deps);
    hash = await hashPassword(SUB_PASSWORD, { memoryKib: 8192 });
  }, 60_000);

  afterAll(async () => {
    await closeDeps(deps);
  });

  async function orgAdmin() {
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

  interface Fixture {
    orgId: string;
    siteId: string;
    agent: Agent;
    nasId: string;
    nasIp: string;
    nasIdentifier: string;
    username: string;
  }

  /** Org + post-back NAS (created through the admin API) + external portal + subscriber. */
  async function fixture(adapterConfig: Record<string, unknown>): Promise<Fixture> {
    const t = await orgAdmin();
    const nasIp = randomIp();
    const nasIdentifier = unique('pb')
      .replace(/[^A-Za-z0-9._:-]/g, '')
      .slice(0, 60);
    const created = await t.agent.post(`/api/v1/orgs/${t.orgId}/nas`).set(BROWSER).send({
      site_id: t.siteId,
      name: 'post-back AP',
      nas_ip: nasIp,
      nas_identifier: nasIdentifier,
      adapter_key: 'external-portal-postback',
      adapter_config: adapterConfig,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    await deps.dbPlatform
      .insertInto('captive_portals')
      .values({
        organization_id: t.orgId,
        site_id: t.siteId,
        name: 'Guest',
        public_slug: unique('p')
          .toLowerCase()
          .replace(/[^a-z0-9-]/g, '')
          .slice(0, 60),
        portal_type: 'external',
        network_ref: 'guest',
        auth_methods: ['password', 'click_through'],
      })
      .execute();
    const username = unique('sub');
    await deps.dbPlatform
      .insertInto('users')
      .values({ organization_id: t.orgId, username, password_hash: hash, status: 'active' })
      .execute();
    const policy = await deps.dbPlatform
      .insertInto('policies')
      .values({
        organization_id: t.orgId,
        name: 'Site 1h',
        scope_type: 'site',
        site_id: t.siteId,
        status: 'active',
        download_rate_kbps: 10_000,
        session_timeout_s: 3600,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await deps.dbPlatform
      .insertInto('policy_assignments')
      .values({
        organization_id: t.orgId,
        policy_id: policy.id,
        target_type: 'site',
        site_id: t.siteId,
      })
      .execute();
    return { ...t, nasId: created.body.id as string, nasIp, nasIdentifier, username };
  }

  function postback(profile: string, rawQuery: string, nasid: string | null = null) {
    return request(apps.internalApp)
      .post('/internal/portal/postback/redirects')
      .set('X-Internal-Token', TEST_INTERNAL_TOKEN)
      .send({
        profile,
        ...(nasid === null ? {} : { nasid }),
        raw_query: rawQuery,
        client_ip: randomIp(),
      });
  }

  function view(flowId: string) {
    return request(apps.internalApp)
      .get(`/internal/portal/flows/${flowId}`)
      .set('X-Internal-Token', TEST_INTERNAL_TOKEN);
  }

  function identify(flowId: string, body: object) {
    return request(apps.internalApp)
      .post(`/internal/portal/flows/${flowId}/identify`)
      .set('X-Internal-Token', TEST_INTERNAL_TOKEN)
      .send(body);
  }

  function authorize(body: RadiusRequestBody) {
    return request(apps.internalApp)
      .post('/internal/aaa/authorize')
      .set('X-Internal-Token', TEST_INTERNAL_TOKEN)
      .send(body);
  }

  function cambiumQuery(f: Fixture, client: string, ap: string, qv: string, srvr = '10.77.0.2') {
    return [
      `ga_ssid=Guest`,
      `ga_ap_mac=${ap}`,
      `ga_nas_id=${f.nasIdentifier}`,
      `ga_srvr=${srvr}`,
      `ga_cmac=${client}`,
      `ga_Qv=${qv}`,
      `ga_orig_url=http%3A%2F%2Fexample.com%2F`,
    ].join('&');
  }

  it('Cambium: redirect → flow → token → POST-form hand-off → AAA accepts the pc- credential once', async () => {
    const f = await fixture({ profile: 'cambium-hotspot' });
    const client = randomMac();
    const ap = randomMac();
    // AP registered (unverified): ga_nas_id decides; the first RADIUS request verifies it.
    const apRes = await f.agent
      .post(`/api/v1/orgs/${f.orgId}/access-points`)
      .set(BROWSER)
      .send({ nas_client_id: f.nasId, mac: ap.dashed });
    expect(apRes.status, JSON.stringify(apRes.body)).toBe(201);

    const qv = `${randomBytes(6).toString('hex')}%01%2B`;
    const q = cambiumQuery(f, client.dashed, ap.dashed, qv);
    const r = await postback('cambium-hotspot', q);
    expect(r.body.kind, JSON.stringify(r.body)).toBe('flow');
    const flowId = r.body.flow_id as string;

    const v = await view(flowId);
    expect(v.status).toBe(200);
    expect(v.body.postback.login_origin).toBe('http://10.77.0.2:880');
    expect(v.body.nas).toBeNull();
    expect(v.body.continue_url).toBe('http://example.com/');
    const token = v.body.postback.login_token as string;
    expect(token).toMatch(/^lt1\./);

    // without the login token: refused, nothing issued
    const noToken = await identify(flowId, {
      method: 'password',
      username: f.username,
      password: SUB_PASSWORD,
    });
    expect(noToken.status).toBe(403);
    expect(noToken.body).toEqual({ result: 'login_token_invalid' });

    const ok = await identify(flowId, {
      method: 'password',
      username: f.username,
      password: SUB_PASSWORD,
      login_token: token,
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.handoff.method).toBe('POST-form');
    // the received query is appended byte-for-byte (ga_Qv opaque bytes intact)
    expect(ok.body.handoff.url).toBe(`http://10.77.0.2:880/cgi-bin/hotspot_login.cgi?${q}`);
    const fields = ok.body.handoff.fields as Record<string, string>;
    expect(Object.keys(fields).sort()).toEqual(['ga_pass', 'ga_user']);
    expect(fields.ga_user).toMatch(/^pc-[0-9a-f]{16}$/);
    expect(JSON.stringify(ok.body)).not.toContain(SUB_PASSWORD);

    // token replay: refused
    const replay = await identify(flowId, {
      method: 'click_through',
      accept_terms: true,
      login_token: token,
    });
    expect(replay.status).toBe(403);
    expect(replay.body).toEqual({ result: 'login_token_invalid' });

    // the AP posts the credential to ECLOUD RADIUS (PAP)
    const access = radius({
      'User-Name': fields.ga_user ?? '',
      'User-Password': fields.ga_pass ?? '',
      'ECLOUD-Packet-Src-IP-Address': f.nasIp,
      'NAS-Identifier': f.nasIdentifier,
      'Calling-Station-Id': client.dashed,
      'Called-Station-Id': `${ap.dashed}:Guest`,
      'NAS-Port-Type': 'Wireless-802.11',
    });
    const accept = await authorize(access);
    expect(accept.status).toBe(200);
    expect(accept.body['control:Auth-Type'].value).toEqual(['Accept']);
    // REQUIRES_DEVICE_TEST attributes are not emitted outside lab mode (translate.ts, D-028):
    // the post-back family has no VERIFIED attribute yet, so only Class is sent.
    expect(accept.body['reply:Class']).toBeDefined();
    expect(accept.body['reply:Session-Timeout']).toBeUndefined();
    // no vendor rate attribute is emitted for the post-back family (not device-enforced)
    expect(Object.keys(accept.body as object).some((k) => /Bandwidth|Rate-Limit/.test(k))).toBe(
      false,
    );

    // single use: a new Access-Request with the same credential is rejected
    const second = await authorize(
      radius({
        'User-Name': fields.ga_user ?? '',
        'User-Password': fields.ga_pass ?? '',
        'ECLOUD-Packet-Src-IP-Address': f.nasIp,
        'NAS-Identifier': f.nasIdentifier,
        'Calling-Station-Id': client.dashed,
        'Called-Station-Id': `${ap.dashed}:Guest`,
        // a new packet (not a retransmit of the first one, which the AAA cache answers again)
        'Acct-Session-Id': 'second-attempt',
        'NAS-Port-Type': 'Wireless-802.11',
      }),
    );
    expect(second.body['control:Auth-Type']?.value).not.toEqual(['Accept']);

    // the vendor nonce (ga_Qv) is now consumed: the same redirect is a replay
    expect((await postback('cambium-hotspot', q)).body).toEqual({ kind: 'error' });

    // setup guide: ECLOUD portal URL with this NAS identifier, secrets as placeholders only
    const guide = await f.agent.get(`/api/v1/orgs/${f.orgId}/nas/${f.nasId}/setup-guide`);
    expect(guide.status).toBe(200);
    expect(guide.body.profile).toBe('cambium-hotspot');
    expect(guide.body.steps[0].value).toBe(
      `https://portal.ezecloud.ezelink.ai/pb/cambium-hotspot/${f.nasIdentifier}/`,
    );
    expect(JSON.stringify(guide.body)).toContain('<RADIUS_SECRET>');

    // RADIUS from the NAS verified the AP MAC (Cycle A observeAccessPoint)
    const apRow = await deps.dbPlatform
      .selectFrom('nas_access_points')
      .select(['verified_at'])
      .where('nas_client_id', '=', f.nasId)
      .executeTakeFirstOrThrow();
    expect(apRow.verified_at).not.toBeNull();
  });

  it('Aruba: AP-MAC identity only when the AP row is VERIFIED; hand-off to securelogin', async () => {
    const f = await fixture({ profile: 'aruba-ecp' });
    const client = randomMac();
    const ap = randomMac();
    await f.agent
      .post(`/api/v1/orgs/${f.orgId}/access-points`)
      .set(BROWSER)
      .send({ nas_client_id: f.nasId, mac: ap.colon })
      .expect(201);
    const q = `cmd=login&mac=${client.colon}&essid=Guest&ip=10.30.0.15&apname=ap1&apmac=${ap.colon}&url=http%3A%2F%2Fexample.com%2F`;

    // unverified AP MAC: fail closed
    expect((await postback('aruba-ecp', q)).body).toEqual({ kind: 'error' });

    await deps.dbPlatform
      .updateTable('nas_access_points')
      .set({ verified_at: new Date(), verification_source: 'radius-called-station' })
      .where('nas_client_id', '=', f.nasId)
      .execute();
    const r = await postback('aruba-ecp', q);
    expect(r.body.kind).toBe('flow');
    const v = await view(r.body.flow_id as string);
    expect(v.body.postback.login_origin).toBe('https://securelogin.arubanetworks.com');
    const ok = await identify(r.body.flow_id as string, {
      method: 'click_through',
      accept_terms: true,
      login_token: v.body.postback.login_token,
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.handoff).toMatchObject({
      method: 'POST-form',
      url: 'https://securelogin.arubanetworks.com/cgi-bin/login',
      fields: { cmd: 'authenticate', url: 'http://example.com/' },
    });

    // the path NAS id may name the NAS too (no verified AP needed)
    const viaPath = await postback(
      'aruba-ecp',
      q.replace(ap.colon, randomMac().colon),
      f.nasIdentifier,
    );
    expect(viaPath.body.kind).toBe('flow');
  });

  it('security: foreign login host, wrong profile, cross-tenant token and NAS are refused', async () => {
    const f = await fixture({ profile: 'cisco-webauth' });
    const client = randomMac();
    const base = `ap_mac=${randomMac().colon}&client_mac=${client.colon}&ssid=Guest`;
    // switch_url on a public / foreign host (open-redirect / SSRF-like) → generic error
    for (const host of [
      'http%3A%2F%2Fevil.example.com%2Flogin.html',
      'http%3A%2F%2F203.0.113.9%2Flogin.html',
      'http%3A%2F%2F169.254.169.254%2Flatest',
      'http%3A%2F%2F10.1.1.1%40evil.example.com%2F',
      'javascript%3Aalert(1)',
    ]) {
      const res = await postback('cisco-webauth', `switch_url=${host}&${base}`, f.nasIdentifier);
      expect(res.body, host).toEqual({ kind: 'error' });
    }
    // a private virtual IP is accepted
    const good = await postback(
      'cisco-webauth',
      `switch_url=http%3A%2F%2F192.168.255.1%2Flogin.html&${base}`,
      f.nasIdentifier,
    );
    expect(good.body.kind).toBe('flow');
    // another profile on the same NAS → refused
    expect(
      (
        await postback(
          'aruba-ecp',
          `mac=${client.colon}&apmac=${randomMac().colon}`,
          f.nasIdentifier,
        )
      ).body,
    ).toEqual({ kind: 'error' });

    // cross-tenant: org B's token is useless on org A's flow (binding mismatch)
    const g = await fixture({ profile: 'cisco-webauth' });
    const gr = await postback(
      'cisco-webauth',
      `switch_url=http%3A%2F%2F192.168.255.1%2Flogin.html&ap_mac=${randomMac().colon}&client_mac=${randomMac().colon}`,
      g.nasIdentifier,
    );
    expect(gr.body.kind).toBe('flow');
    const tokenB = (await view(gr.body.flow_id as string)).body.postback.login_token as string;
    const cross = await identify(good.body.flow_id as string, {
      method: 'click_through',
      accept_terms: true,
      login_token: tokenB,
    });
    expect(cross.status).toBe(403);

    // credential issued for org A's NAS, presented by org B's NAS → reject
    const tokenA = (await view(good.body.flow_id as string)).body.postback.login_token as string;
    const okA = await identify(good.body.flow_id as string, {
      method: 'click_through',
      accept_terms: true,
      login_token: tokenA,
    });
    expect(okA.status).toBe(200);
    const fa = okA.body.handoff.fields as Record<string, string>;
    const wrongNas = await authorize(
      radius({
        'User-Name': fa.username ?? '',
        'User-Password': fa.password ?? '',
        'ECLOUD-Packet-Src-IP-Address': g.nasIp,
        'NAS-Identifier': g.nasIdentifier,
        'Calling-Station-Id': client.dashed,
      }),
    );
    expect(wrongNas.body['control:Auth-Type']?.value).not.toEqual(['Accept']);
  });

  it('generic profile: needs the NAS id in the path, posts the configured names', async () => {
    const f = await fixture({
      profile: 'postback-generic',
      generic: {
        params: { client_mac: 'cmac', ap_mac: 'apmac', login_url: 'lurl', continue_url: 'dst' },
        fields: { username: 'u', password: 'p' },
        method: 'POST',
        constants: { mode: 'login' },
        login_path: '/auth',
      },
    });
    const client = randomMac();
    const q = `cmac=${client.colon}&apmac=${randomMac().colon}&lurl=http%3A%2F%2F10.9.9.9%2Fauth&dst=http%3A%2F%2Fexample.com%2F`;
    expect((await postback('postback-generic', q)).body).toEqual({ kind: 'error' });
    const r = await postback('postback-generic', q, f.nasIdentifier);
    expect(r.body.kind).toBe('flow');
    const v = await view(r.body.flow_id as string);
    const ok = await identify(r.body.flow_id as string, {
      method: 'password',
      username: f.username,
      password: SUB_PASSWORD,
      login_token: v.body.postback.login_token,
    });
    expect(ok.status).toBe(200);
    expect(ok.body.handoff.url).toBe('http://10.9.9.9/auth');
    expect(Object.keys(ok.body.handoff.fields as object).sort()).toEqual(['mode', 'p', 'u']);
    const fields = ok.body.handoff.fields as Record<string, string>;
    const accept = await authorize(
      radius({
        'User-Name': fields.u ?? '',
        'User-Password': fields.p ?? '',
        'ECLOUD-Packet-Src-IP-Address': f.nasIp,
        'Calling-Station-Id': client.dashed,
      }),
    );
    expect(accept.body['control:Auth-Type'].value).toEqual(['Accept']);
  });

  it('review M1 / M2: undocumented ports and, in strict mode, other LAN hosts are refused', async () => {
    const f = await fixture({
      profile: 'cisco-webauth',
      login_hosts: ['192.168.50.1'],
      strict_login_hosts: true,
    });
    const base = `ap_mac=${randomMac().colon}&client_mac=${randomMac().colon}&ssid=Guest`;
    const go = (url: string) =>
      postback('cisco-webauth', `switch_url=${encodeURIComponent(url)}&${base}`, f.nasIdentifier);
    expect((await go('http://192.168.50.1:6379/anything')).body).toEqual({ kind: 'error' });
    expect((await go('http://192.168.50.7/login.html')).body).toEqual({ kind: 'error' });
    expect((await go(`http://${f.nasIp}/login.html`)).body.kind).toBe('flow');
    expect((await go('http://192.168.50.1/login.html')).body.kind).toBe('flow');
  });

  it('review L1: a NAS identifier used in public portal URLs is unique across organizations', async () => {
    const a = await fixture({ profile: 'cambium-hotspot' });
    const b = await orgAdmin();
    const create = (adapterKey: string, extra: Record<string, unknown> = {}) =>
      b.agent
        .post(`/api/v1/orgs/${b.orgId}/nas`)
        .set(BROWSER)
        .send({
          site_id: b.siteId,
          name: 'squat',
          nas_ip: randomIp(),
          nas_identifier: a.nasIdentifier,
          adapter_key: adapterKey,
          ...extra,
        });
    // any adapter in another org may not take the identifier of a post-back NAS (DoS)
    const squat = await create('generic-radius-8021x');
    expect(squat.status).toBe(409);
    expect(JSON.stringify(squat.body)).not.toContain(a.orgId);
    expect(JSON.stringify(squat.body)).not.toContain('nas_identifier');
    // nor through a rename
    const other = await create('generic-radius-8021x', { nas_identifier: unique('free') });
    expect(other.status).toBe(201);
    const rename = await b.agent
      .patch(`/api/v1/orgs/${b.orgId}/nas/${other.body.id as string}`)
      .set(BROWSER)
      .send({ nas_identifier: a.nasIdentifier });
    expect(rename.status).toBe(409);
    // the redirect of org A still resolves (no ambiguity was created)
    const client = randomMac();
    const r = await postback(
      'cambium-hotspot',
      cambiumQuery(a, client.dashed, randomMac().dashed, randomBytes(4).toString('hex')),
    );
    expect(r.body.kind).toBe('flow');
    // reverse direction: a post-back NAS may not take an identifier another org already uses
    const shared = unique('shared');
    const c = await orgAdmin();
    await c.agent
      .post(`/api/v1/orgs/${c.orgId}/nas`)
      .set(BROWSER)
      .send({
        site_id: c.siteId,
        name: 'x',
        nas_ip: randomIp(),
        nas_identifier: shared,
        adapter_key: 'generic-radius-8021x',
      })
      .expect(201);
    const pb = await create('external-portal-postback', {
      nas_identifier: shared,
      adapter_config: { profile: 'aruba-ecp' },
    });
    expect(pb.status).toBe(409);
    // non-public adapters keep the old rule (same identifier in two orgs is allowed)
    const d = await orgAdmin();
    await d.agent
      .post(`/api/v1/orgs/${d.orgId}/nas`)
      .set(BROWSER)
      .send({
        site_id: d.siteId,
        name: 'x',
        nas_ip: randomIp(),
        nas_identifier: shared,
        adapter_key: 'generic-radius-8021x',
      })
      .expect(201);
  });

  it('NAS adapter_config: validated on create and patch, cleared when the adapter changes', async () => {
    const t = await orgAdmin();
    const create = (body: Record<string, unknown>) =>
      t.agent
        .post(`/api/v1/orgs/${t.orgId}/nas`)
        .set(BROWSER)
        .send({ site_id: t.siteId, name: 'x', nas_ip: randomIp(), ...body });
    for (const bad of [
      { adapter_key: 'external-portal-postback' },
      { adapter_key: 'external-portal-postback', adapter_config: { profile: 'nope' } },
      {
        adapter_key: 'external-portal-postback',
        adapter_config: { profile: 'cambium-hotspot', login_hosts: ['169.254.169.254'] },
      },
      {
        adapter_key: 'external-portal-postback',
        adapter_config: {
          profile: 'postback-generic',
          generic: { params: { client_mac: 'a"><script>', login_url: 'u' } },
        },
      },
      { adapter_key: 'generic-radius-8021x', adapter_config: { profile: 'cambium-hotspot' } },
      {
        adapter_key: 'external-portal-postback',
        adapter_config: {
          profile: 'postback-generic',
          generic: { params: { client_mac: 'm', login_url: 'u' } }, // login_path missing (M1)
        },
      },
    ]) {
      const res = await create(bad);
      expect([400, 422], JSON.stringify(bad)).toContain(res.status);
    }
    const ok = await create({
      adapter_key: 'external-portal-postback',
      adapter_config: {
        profile: 'omada-external-portal',
        https: true,
        login_hosts: ['Omada.Example.NET.'],
      },
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body.adapter_config).toEqual({
      profile: 'omada-external-portal',
      https: true,
      login_hosts: ['omada.example.net'],
    });
    const patched = await t.agent
      .patch(`/api/v1/orgs/${t.orgId}/nas/${ok.body.id as string}`)
      .set(BROWSER)
      .send({ adapter_key: 'generic-radius-8021x' });
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    expect(patched.body.adapter_config).toEqual({});
    const back = await t.agent
      .patch(`/api/v1/orgs/${t.orgId}/nas/${ok.body.id as string}`)
      .set(BROWSER)
      .send({ adapter_key: 'external-portal-postback' });
    expect([400, 422]).toContain(back.status);
  });
});
