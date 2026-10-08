/* eslint-disable @typescript-eslint/no-unsafe-member-access -- supertest response bodies are untyped JSON */
/**
 * Phase 6 P6-A: `/internal/portal/*` (identity broker) + the AAA portal-credential path against
 * `ecloud_test` (and Redis when ECLOUD_TEST_REDIS_URL is set; otherwise the in-process store).
 * Redirects come from the L4 UAM device simulator (`@ecloud/testing`, written independently of
 * `@ecloud/adapters`); hand-off URLs are decoded the way the device does. Simulator evidence
 * only (SIMULATOR_TESTED): nothing here proves hardware behaviour.
 */
import { hashPassword } from '@ecloud/db';
import { newId } from '@ecloud/shared';
import {
  SIM_UAM_SECRET,
  buildUamRedirect,
  describeIntegration,
  deviceDecodePapTip,
  deviceDecodePapUpstream,
  getTestRedisUrl,
  migrateTestDatabase,
  parseDeviceLogon,
  signUamQuery,
  type UamFlavour,
  type UamRedirectInput,
} from '@ecloud/testing';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createApp } from './app.js';
import type { AppDeps } from './context.js';
import { Envelope, sealSecretRef } from './crypto.js';
import { PORTAL_RETRANSMIT_TTL_S, decisionKey } from './internal/aaa.js';
import { UAM_SECRET_PURPOSE } from './internal/portal.js';
import type { RadiusRequestBody } from './internal/radius.js';
import { MemoryKv, RedisKv, type KvStore } from './kv.js';
import { voucherHash } from './routes/vouchers.js';
import {
  TEST_INTERNAL_TOKEN,
  closeDeps,
  createTenant,
  integrationDeps,
  unique,
} from './test-support/deps.js';

const SUB_PASSWORD = 'sub-password-1';

await describeIntegration('@ecloud/api captive portal broker (P6-A)', () => {
  let deps: AppDeps;
  let internal: ReturnType<typeof createApp>['internalApp'];
  let hash: string;

  beforeAll(async () => {
    await migrateTestDatabase();
    deps = integrationDeps();
    const redisUrl = getTestRedisUrl();
    if (redisUrl !== undefined) deps.kv = RedisKv.connect(redisUrl);
    internal = createApp(deps).internalApp;
    hash = await hashPassword(SUB_PASSWORD, { memoryKib: 8192 });
  }, 60_000);

  afterAll(async () => {
    await closeDeps(deps);
  });

  const hex = (bytes: number) => randomBytes(bytes).toString('hex');
  const randomIp = () =>
    `10.${String(Math.floor(Math.random() * 250) + 2)}.${String(Math.floor(Math.random() * 250) + 2)}.${String(Math.floor(Math.random() * 250) + 2)}`;
  const wireMac = () =>
    Array.from(randomBytes(6), (b) => b.toString(16).padStart(2, '0').toUpperCase()).join('-');

  type AdapterKey = 'openwifi-uspot-uam' | 'uspot-upstream-uam' | 'coovachilli-uam';

  interface Fixture {
    orgId: string;
    siteId: string;
    nasId: string;
    nasIp: string;
    nasIdentifier: string;
    portalId: string;
    adapterKey: AdapterKey;
    username: string;
    voucherCode: string;
    voucherId: string;
  }

  async function addNas(
    orgId: string,
    siteId: string,
    adapterKey: AdapterKey,
    nasIdentifier = unique('nas'),
  ) {
    const nasIp = randomIp();
    const row = await deps.dbPlatform
      .insertInto('nas_clients')
      .values({
        organization_id: orgId,
        site_id: siteId,
        name: 'ap',
        nas_identifier: nasIdentifier,
        nas_ip: nasIp,
        adapter_type_key: adapterKey,
        adapter_key: adapterKey,
        deployment_mode: adapterKey === 'coovachilli-uam' ? 'gateway' : 'native',
        secret_ref: 'enc:placeholder',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return { nasId: row.id, nasIp, nasIdentifier };
  }

  async function fixture(
    adapterKey: AdapterKey = 'openwifi-uspot-uam',
    methods: string[] = ['password', 'voucher', 'click_through'],
  ): Promise<Fixture> {
    const { orgId, siteId } = await createTenant(deps.dbPlatform);
    const nas = await addNas(orgId, siteId, adapterKey);
    const portal = await deps.dbPlatform
      .insertInto('captive_portals')
      .values({
        organization_id: orgId,
        site_id: siteId,
        name: 'Lobby',
        public_slug: unique('p')
          .toLowerCase()
          .replace(/[^a-z0-9-]/g, '')
          .slice(0, 60),
        portal_type: adapterKey === 'coovachilli-uam' ? 'coovachilli' : 'uspot',
        network_ref: 'guest',
        auth_methods: methods,
        uam_secret_ref: sealSecretRef(
          new Envelope(deps.config.dataEncryptionKey, UAM_SECRET_PURPOSE),
          SIM_UAM_SECRET,
        ),
        terms_version: '1',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await deps.dbPlatform
      .insertInto('portal_terms_versions')
      .values({
        organization_id: orgId,
        captive_portal_id: portal.id,
        version: 1,
        body: 'Use responsibly.',
      })
      .execute();
    const username = unique('sub');
    await deps.dbPlatform
      .insertInto('users')
      .values({ organization_id: orgId, username, password_hash: hash, status: 'active' })
      .execute();
    const policy = await deps.dbPlatform
      .insertInto('policies')
      .values({
        organization_id: orgId,
        name: 'Site 10M',
        scope_type: 'site',
        site_id: siteId,
        status: 'active',
        download_rate_kbps: 10_000,
        upload_rate_kbps: 2_000,
        session_timeout_s: 3600,
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
    const batch = await deps.dbPlatform
      .insertInto('voucher_batches')
      .values({ organization_id: orgId, name: 'b', count: 1, site_id: siteId, max_uses: 2 })
      .returning('id')
      .executeTakeFirstOrThrow();
    const voucherCode = `PV${hex(4).toUpperCase().replace(/[01]/g, '7')}`;
    const voucher = await deps.dbPlatform
      .insertInto('vouchers')
      .values({
        organization_id: orgId,
        batch_id: batch.id,
        code_hash: voucherHash(deps.config.voucherPepper, voucherCode),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return {
      orgId,
      siteId,
      ...nas,
      portalId: portal.id,
      adapterKey,
      username,
      voucherCode,
      voucherId: voucher.id,
    };
  }

  const flavourOf = (k: AdapterKey): UamFlavour =>
    k === 'coovachilli-uam'
      ? 'coovachilli'
      : k === 'uspot-upstream-uam'
        ? 'uspot-upstream'
        : 'uspot-tip';
  const pathOf = (k: AdapterKey) => (k === 'coovachilli-uam' ? 'chilli' : 'uspot');
  const uamServer = (k: AdapterKey) => `${deps.config.base.origins.portal}/uam/${pathOf(k)}/`;

  interface Device {
    mac: string;
    sessionid: string;
    challenge: string;
  }

  function redirectFor(f: Fixture, device: Device, over: Partial<UamRedirectInput> = {}) {
    return buildUamRedirect(
      {
        uamServer: uamServer(f.adapterKey),
        uamSecret: SIM_UAM_SECRET,
        res: 'notyet',
        uamip: '10.1.0.1',
        uamport: '3990',
        challenge: device.challenge,
        mac: device.mac,
        ip: '10.1.0.50',
        called: 'AA-00-00-00-00-01',
        nasid: f.nasIdentifier,
        ssid: 'Guest',
        sessionid: device.sessionid,
        userurl: 'https://example.com/start',
        ...over,
      },
      flavourOf(f.adapterKey),
    );
  }

  const newDevice = (): Device => ({ mac: wireMac(), sessionid: hex(8), challenge: hex(16) });

  function postRedirect(flavour: string, rawQuery: string, clientIp = randomIp(), app = internal) {
    return request(app)
      .post('/internal/portal/redirects')
      .set('X-Internal-Token', TEST_INTERNAL_TOKEN)
      .send({ flavour, raw_query: rawQuery, client_ip: clientIp });
  }

  async function startFlow(
    f: Fixture,
    device = newDevice(),
    over: Partial<UamRedirectInput> = {},
    app = internal,
  ) {
    const redirect = redirectFor(f, device, over);
    const res = await postRedirect(pathOf(f.adapterKey), redirect.query, randomIp(), app);
    expect(res.status).toBe(200);
    expect(res.body.kind).toBe('flow');
    return { flowId: res.body.flow_id as string, device, redirect };
  }

  function identify(flowId: string, body: object, app = internal) {
    return request(app)
      .post(`/internal/portal/flows/${flowId}/identify`)
      .set('X-Internal-Token', TEST_INTERNAL_TOKEN)
      .send(body);
  }

  /** What the NAS does with the hand-off: decode username + PAP password. */
  function deviceLogon(f: Fixture, device: Device, url: string) {
    const logon = parseDeviceLogon(url);
    const decode =
      f.adapterKey === 'openwifi-uspot-uam' ? deviceDecodePapTip : deviceDecodePapUpstream;
    return {
      logon,
      username: logon.username ?? '',
      password: decode(logon.passwordHex ?? '', device.challenge, SIM_UAM_SECRET),
    };
  }

  function radius(attrs: Record<string, string | number>): RadiusRequestBody {
    return Object.fromEntries(
      Object.entries(attrs).map(([k, v]) => [
        k,
        { type: typeof v === 'number' ? 'integer' : 'string', value: [v] },
      ]),
    );
  }

  function accessRequest(
    f: Fixture,
    device: Device,
    cred: { username: string; password: string },
    over: Record<string, string> = {},
  ): RadiusRequestBody {
    return radius({
      'User-Name': cred.username,
      'User-Password': cred.password,
      'ECLOUD-Packet-Src-IP-Address': f.nasIp,
      'NAS-Identifier': f.nasIdentifier,
      'Calling-Station-Id': device.mac,
      'Called-Station-Id': 'AA-00-00-00-00-01:Guest',
      'Acct-Session-Id': device.sessionid,
      'Framed-IP-Address': '10.1.0.50',
      'NAS-Port-Type': 'Wireless-802.11',
      ...over,
    });
  }

  function authorize(body: RadiusRequestBody, app = internal) {
    return request(app)
      .post('/internal/aaa/authorize')
      .set('X-Internal-Token', TEST_INTERNAL_TOKEN)
      .send(body);
  }

  async function reasonOf(body: RadiusRequestBody, kv: KvStore = deps.kv): Promise<string | null> {
    const facts = await kv.get(decisionKey(body));
    return facts === null
      ? null
      : ((JSON.parse(facts) as { reason: string | null }).reason ?? null);
  }

  async function passwordCredential(f: Fixture, device = newDevice()) {
    const flow = await startFlow(f, device);
    const res = await identify(flow.flowId, {
      method: 'password',
      username: f.username,
      password: SUB_PASSWORD,
      client_ip: randomIp(),
    });
    expect(res.status).toBe(200);
    return {
      ...flow,
      handoff: res.body.handoff.url as string,
      ...deviceLogon(f, device, res.body.handoff.url as string),
    };
  }

  // ------------------------------------------------------------------------------ happy path

  it.each(['openwifi-uspot-uam', 'uspot-upstream-uam', 'coovachilli-uam'] as const)(
    '%s: redirect → login → single-use credential → AAA Access-Accept with policy attributes',
    async (adapterKey) => {
      const f = await fixture(adapterKey);
      const device = newDevice();
      const flow = await startFlow(f, device);

      const view = await request(internal)
        .get(`/internal/portal/flows/${flow.flowId}`)
        .set('X-Internal-Token', TEST_INTERNAL_TOKEN);
      expect(view.status).toBe(200);
      expect(view.body).toMatchObject({
        state: 'ARRIVED',
        methods: ['password', 'voucher', 'click_through'],
        portal: { id: f.portalId, name: 'Lobby', site_name: 'Site A' },
        terms: { version: '1', text: 'Use responsibly.' },
        nas: { origin: 'http://10.1.0.1:3990' },
        continue_url: 'https://example.com/start',
        notice: null,
      });
      expect(JSON.stringify(view.body)).not.toContain(SIM_UAM_SECRET);

      const res = await identify(flow.flowId, {
        method: 'password',
        username: f.username.toUpperCase(),
        password: SUB_PASSWORD,
      });
      expect(res.status).toBe(200);
      expect(JSON.stringify(res.body)).not.toContain(SUB_PASSWORD);
      const { logon, username, password } = deviceLogon(f, device, res.body.handoff.url as string);
      expect(logon).toMatchObject({ host: '10.1.0.1', port: '3990', path: '/logon' });
      expect(username).toMatch(/^pc-[0-9a-f]{16}$/);
      expect(Buffer.byteLength(password)).toBeLessThanOrEqual(16);
      expect(decodeURIComponent(logon.userurlRaw ?? '')).toBe('https://example.com/start');

      const body = accessRequest(f, device, { username, password });
      const ok = await authorize(body);
      expect(ok.status).toBe(200);
      expect(ok.body['control:Auth-Type'].value).toEqual(['Accept']);
      expect(ok.body['reply:Session-Timeout']).toBeDefined();
      expect(
        Object.keys(ok.body as object).some((k) => /^reply:.*Bandwidth-Max-Down$/.test(k)),
      ).toBe(true);
      const cls = ok.body['reply:Class'].value[0] as string;
      expect(cls).toMatch(/^ai:[0-9a-f]{32}$/);
      expect(JSON.stringify(ok.body)).not.toContain(password);

      // NAS retransmit: same answer, same Class, no second session.
      const again = await authorize(body);
      expect(again.status).toBe(200);
      expect(again.body['reply:Class'].value[0]).toBe(cls);
      const sessions = await deps.dbPlatform
        .selectFrom('sessions')
        .select(['status', 'user_id', 'acct_session_id'])
        .where('nas_client_id', '=', f.nasId)
        .execute();
      expect(sessions).toHaveLength(1);
      expect(sessions[0]).toMatchObject({
        status: 'authorized',
        acct_session_id: device.sessionid,
      });

      // The redirect that led to the accept is consumed: presenting it again is a replay.
      const replayed = await postRedirect(pathOf(adapterKey), flow.redirect.query);
      expect(replayed.body).toEqual({ kind: 'error' });

      // res=success callback (same identity, re-signed by the device) → success for this flow.
      const success = redirectFor(f, device, { res: 'success' });
      const cb = await postRedirect(pathOf(adapterKey), success.query);
      expect(cb.body).toEqual({ kind: 'success', flow_id: flow.flowId });

      const status = await request(internal)
        .get(`/internal/portal/flows/${flow.flowId}/status`)
        .set('X-Internal-Token', TEST_INTERNAL_TOKEN);
      expect(status.body).toMatchObject({
        flow_state: 'AUTHORIZED',
        session: { status: 'authorized' },
      });
      const logout = await request(internal)
        .post(`/internal/portal/flows/${flow.flowId}/logout`)
        .set('X-Internal-Token', TEST_INTERNAL_TOKEN)
        .send({});
      expect(logout.body).toEqual({ result: 'ok', url: 'http://10.1.0.1:3990/logoff' });

      const attempts = await deps.dbPlatform
        .selectFrom('portal_login_attempts')
        .select(['method', 'result', 'username_or_code_prefix'])
        .where('captive_portal_id', '=', f.portalId)
        .execute();
      expect(attempts).toEqual([
        {
          method: 'password',
          result: 'accept',
          username_or_code_prefix: f.username.toUpperCase().slice(0, 3),
        },
      ]);
    },
  );

  it('voucher and click-through identities: voucher use counted at AAA, device row created', async () => {
    const f = await fixture();
    const vDevice = newDevice();
    const vFlow = await startFlow(f, vDevice);
    const v = await identify(vFlow.flowId, {
      method: 'voucher',
      code: f.voucherCode.toLowerCase(),
    });
    expect(v.status).toBe(200);
    const vCred = deviceLogon(f, vDevice, v.body.handoff.url as string);
    const before = await deps.dbPlatform
      .selectFrom('vouchers')
      .select(['use_count'])
      .where('id', '=', f.voucherId)
      .executeTakeFirstOrThrow();
    expect(before.use_count).toBe(0); // identify does not consume
    expect((await authorize(accessRequest(f, vDevice, vCred))).status).toBe(200);
    const after = await deps.dbPlatform
      .selectFrom('vouchers')
      .select(['use_count', 'status'])
      .where('id', '=', f.voucherId)
      .executeTakeFirstOrThrow();
    expect(after).toEqual({ use_count: 1, status: 'active' });

    const cDevice = newDevice();
    const cFlow = await startFlow(f, cDevice);
    const noTerms = await identify(cFlow.flowId, { method: 'click_through', accept_terms: false });
    expect(noTerms.status).toBe(400);
    const c = await identify(cFlow.flowId, { method: 'click_through', accept_terms: true });
    expect(c.status).toBe(200);
    const cCred = deviceLogon(f, cDevice, c.body.handoff.url as string);
    expect((await authorize(accessRequest(f, cDevice, cCred))).status).toBe(200);
    const mac = cDevice.mac.toLowerCase().replace(/-/g, ':');
    const device = await deps.dbPlatform
      .selectFrom('client_devices')
      .select(['organization_id'])
      .where('mac', '=', mac)
      .where('organization_id', '=', f.orgId)
      .executeTakeFirst();
    expect(device?.organization_id).toBe(f.orgId);
  });

  it('revoked voucher and disabled methods are refused at the portal', async () => {
    const f = await fixture('openwifi-uspot-uam', ['password']);
    const flow = await startFlow(f);
    const v = await identify(flow.flowId, { method: 'voucher', code: f.voucherCode });
    expect(v.status).toBe(403);
    expect(v.body).toEqual({ result: 'method_not_allowed' });
    const g = await fixture();
    await deps.dbPlatform
      .updateTable('vouchers')
      .set({ status: 'revoked' })
      .where('id', '=', g.voucherId)
      .execute();
    const gFlow = await startFlow(g);
    const r = await identify(gFlow.flowId, { method: 'voucher', code: g.voucherCode });
    expect(r.status).toBe(422);
    expect(r.body).toEqual({ result: 'rejected' });
  });

  // ------------------------------------------------------------------------- negative: redirect

  it('forged md, missing md, unknown NAS, wrong flavour, public uamip, duplicate params: one generic error', async () => {
    const f = await fixture();
    const device = newDevice();
    const good = redirectFor(f, device);
    const forged = `${good.signedQuery}&md=${'0'.repeat(32)}`;
    const tampered = signUamQuery(
      uamServer(f.adapterKey),
      good.signedQuery.replace('res=notyet', 'res=notyet&ip=1.2.3.4'),
      'wrong-secret',
    );
    const unknown = redirectFor({ ...f, nasIdentifier: unique('ghost') }, device);
    const publicUam = redirectFor(f, device, { uamip: '203.0.113.7' });
    const duplicate = signUamQuery(
      uamServer(f.adapterKey),
      good.signedQuery.replace('res=notyet', 'res=notyet&mac=AA-AA-AA-AA-AA-AA'),
      SIM_UAM_SECRET,
    );
    const cases: [string, string][] = [
      ['uspot', forged],
      ['uspot', good.signedQuery],
      ['uspot', tampered],
      ['uspot', unknown.query],
      ['chilli', good.query],
      ['uspot', publicUam.query],
      ['uspot', duplicate],
    ];
    for (const [flavour, query] of cases) {
      const res = await postRedirect(flavour, query);
      expect(res.status, query).toBe(200);
      expect(res.body, query).toEqual({ kind: 'error' });
    }
    // The genuine redirect still works (nothing above consumed it).
    expect((await postRedirect('uspot', good.query)).body.kind).toBe('flow');
  });

  it('cross-tenant: a NAS identifier shared by two organizations resolves to neither (fail closed)', async () => {
    const a = await fixture();
    const b = await fixture();
    await deps.dbPlatform
      .updateTable('nas_clients')
      .set({ nas_identifier: a.nasIdentifier })
      .where('id', '=', b.nasId)
      .execute();
    const res = await postRedirect('uspot', redirectFor(a, newDevice()).query);
    expect(res.body).toEqual({ kind: 'error' });
  });

  it('hostile userurl is dropped from the hand-off and the continue link', async () => {
    const f = await fixture();
    for (const userurl of [
      'http://10.0.0.5/admin',
      'javascript:alert(1)',
      'http://10.1.0.1:3990/logoff',
      'http://user:pw@example.com/',
      'http:\\\\evil.example',
    ]) {
      const device = newDevice();
      const flow = await startFlow(f, device, { userurl });
      const view = await request(internal)
        .get(`/internal/portal/flows/${flow.flowId}`)
        .set('X-Internal-Token', TEST_INTERNAL_TOKEN);
      expect(view.body.continue_url, userurl).toBeNull();
      const res = await identify(flow.flowId, {
        method: 'password',
        username: f.username,
        password: SUB_PASSWORD,
      });
      expect(parseDeviceLogon(res.body.handoff.url as string).userurlRaw, userurl).toBeNull();
    }
  });

  // ---------------------------------------------------------------------- negative: credential

  it('wrong MAC, wrong session, wrong NAS (same tenant), other tenant NAS, bad password: rejected, credential survives', async () => {
    const f = await fixture();
    const cred = await passwordCredential(f);
    const other = await addNas(f.orgId, f.siteId, 'openwifi-uspot-uam');
    const foreign = await fixture();
    const cases: [Record<string, string>, string][] = [
      [{ 'Calling-Station-Id': wireMac() }, 'portal_credential_mac_mismatch'],
      [{ 'Acct-Session-Id': hex(8) }, 'portal_credential_session_mismatch'],
      [
        { 'ECLOUD-Packet-Src-IP-Address': other.nasIp, 'NAS-Identifier': other.nasIdentifier },
        'portal_credential_nas_mismatch',
      ],
      [
        {
          'ECLOUD-Packet-Src-IP-Address': foreign.nasIp,
          'NAS-Identifier': foreign.nasIdentifier,
        },
        'portal_credential_tenant_mismatch',
      ],
      [{ 'User-Password': 'not-the-password' }, 'portal_credential_bad_password'],
    ];
    for (const [over, reason] of cases) {
      const body = accessRequest(f, cred.device, cred, over);
      const res = await authorize(body);
      expect(res.status, reason).toBe(401);
      expect(res.body['reply:Reply-Message'].value, reason).toEqual(['Access denied']);
      expect(await reasonOf(body), reason).toBe(reason);
    }
    // None of the above consumed it: the bound NAS + MAC + session still gets in.
    expect((await authorize(accessRequest(f, cred.device, cred))).status).toBe(200);
  });

  it('expired credential (TTL 90 s) is rejected', async () => {
    const f = await fixture();
    const cred = await passwordCredential(f);
    const later = createApp({ ...deps, now: () => new Date(Date.now() + 91_000) }).internalApp;
    const body = accessRequest(f, cred.device, cred);
    const res = await authorize(body, later);
    expect(res.status).toBe(401);
    expect(await reasonOf(body)).toBe('portal_credential_expired');
  });

  it('a user disabled after the portal login is refused when the credential is presented', async () => {
    const f = await fixture();
    const cred = await passwordCredential(f);
    await deps.dbPlatform
      .updateTable('users')
      .set({ status: 'disabled' })
      .where('username', '=', f.username)
      .execute();
    const body = accessRequest(f, cred.device, cred);
    expect((await authorize(body)).status).toBe(401);
    expect(await reasonOf(body)).toBe('user_disabled');
  });

  it('brute force: 5 failures per NAS + MAC lock the method (429) even for the right password', async () => {
    const f = await fixture();
    const device = newDevice();
    const flow = await startFlow(f, device);
    for (let i = 0; i < 5; i += 1) {
      const bad = await identify(flow.flowId, {
        method: 'password',
        username: f.username,
        password: `wrong-${String(i)}`,
        client_ip: randomIp(),
      });
      expect(bad.status).toBe(422);
      expect(bad.body).toEqual({ result: 'rejected' });
    }
    const locked = await identify(flow.flowId, {
      method: 'password',
      username: f.username,
      password: SUB_PASSWORD,
    });
    expect(locked.status).toBe(429);
    expect(locked.body.retry_after).toBeGreaterThan(0);
    // Unknown user and wrong password give the same status and body (timing is not asserted).
    const other = await startFlow(f);
    const unknownUser = await identify(other.flowId, {
      method: 'password',
      username: unique('nobody'),
      password: 'x',
    });
    expect(unknownUser.body).toEqual({ result: 'rejected' });
    const rows = await deps.dbPlatform
      .selectFrom('portal_login_attempts')
      .select(['result', 'reason'])
      .where('captive_portal_id', '=', f.portalId)
      .where('result', '=', 'reject')
      .execute();
    expect(rows).toHaveLength(6);
  });

  it('decision cache of a portal credential lasts the NAS retransmit horizon (30 s), then the single-use credential is gone', async () => {
    // A clock-driven store so the cache expiry is exercised, not simulated by deleting keys.
    let clock = Date.now();
    const kv = new MemoryKv(() => clock);
    const app = createApp({ ...deps, kv }).internalApp;
    const f = await fixture();
    const device = newDevice();
    const flow = await startFlow(f, device, {}, app);
    const res = await identify(
      flow.flowId,
      { method: 'password', username: f.username, password: SUB_PASSWORD },
      app,
    );
    expect(res.status).toBe(200);
    const cred = deviceLogon(f, device, res.body.handoff.url as string);
    const body = accessRequest(f, device, cred);
    const first = await authorize(body, app);
    expect(first.status).toBe(200);
    const cls = first.body['reply:Class'].value[0] as string;

    clock += (PORTAL_RETRANSMIT_TTL_S - 1) * 1000; // still inside the horizon: same answer
    const retransmit = await authorize(body, app);
    expect(retransmit.status).toBe(200);
    expect(retransmit.body['reply:Class'].value[0]).toBe(cls);

    clock += 2_000; // horizon passed: the cached decision expired, the credential was consumed
    const late = await authorize(body, app);
    expect(late.status).toBe(401);
    expect(await reasonOf(body, kv)).toBe('portal_credential_unknown');
    const sessions = await deps.dbPlatform
      .selectFrom('sessions')
      .select(['id'])
      .where('nas_client_id', '=', f.nasId)
      .execute();
    expect(sessions).toHaveLength(1);
  });

  it('per-account lock: rotating MAC and IP against one username is stopped after 10 failures (generic 429)', async () => {
    const f = await fixture();
    for (let i = 0; i < 10; i += 1) {
      const flow = await startFlow(f); // fresh device (MAC) + fresh sessionid every time
      const bad = await identify(flow.flowId, {
        method: 'password',
        username: i % 2 === 0 ? f.username : f.username.toUpperCase(),
        password: `wrong-${String(i)}`,
        client_ip: randomIp(),
      });
      expect(bad.status, `attempt ${String(i)}`).toBe(422);
    }
    const flow = await startFlow(f);
    const locked = await identify(flow.flowId, {
      method: 'password',
      username: f.username,
      password: SUB_PASSWORD,
      client_ip: randomIp(),
    });
    expect(locked.status).toBe(429);
    expect(locked.body).toEqual({
      result: 'rate_limited',
      retry_after: expect.any(Number) as number,
    });
    // Other accounts and other methods on the same site are unaffected.
    const voucher = await identify(flow.flowId, { method: 'voucher', code: f.voucherCode });
    expect(voucher.status).toBe(200);
    // The account lock is per site: the same username at another site is not locked.
    const g = await fixture();
    await deps.dbPlatform
      .updateTable('users')
      .set({ username: f.username })
      .where('organization_id', '=', g.orgId)
      .execute();
    const gFlow = await startFlow(g);
    const other = await identify(gFlow.flowId, {
      method: 'password',
      username: f.username,
      password: SUB_PASSWORD,
    });
    expect(other.status).toBe(200);
  });

  it('per-site voucher cap: 100 failed vouchers across rotating devices lock voucher entry for the site (generic 429)', async () => {
    const f = await fixture();
    let flow = await startFlow(f);
    for (let i = 0; i < 100; i += 1) {
      if (i % 9 === 0) flow = await startFlow(f); // stay under the per-MAC voucher lock (10)
      const bad = await identify(flow.flowId, {
        method: 'voucher',
        code: `ZZ${hex(4).toUpperCase().replace(/[01]/g, '9')}`,
        client_ip: randomIp(),
      });
      expect(bad.status, `attempt ${String(i)}`).toBe(422);
    }
    const fresh = await startFlow(f);
    const locked = await identify(fresh.flowId, { method: 'voucher', code: f.voucherCode });
    expect(locked.status).toBe(429);
    expect(locked.body.result).toBe('rate_limited');
    // Password logins on the site still work.
    const login = await identify(fresh.flowId, {
      method: 'password',
      username: f.username,
      password: SUB_PASSWORD,
    });
    expect(login.status).toBe(200);
  }, 60_000);

  it('flow + credential endpoints: unknown flow 404, internal token required', async () => {
    const res = await request(internal)
      .get(`/internal/portal/flows/${newId()}`)
      .set('X-Internal-Token', TEST_INTERNAL_TOKEN);
    expect(res.status).toBe(404);
    const noToken = await request(internal).post('/internal/portal/redirects').send({});
    expect(noToken.status).toBe(401);
  });
});
