/**
 * Phase 6 P6-A end-to-end, SIMULATOR evidence only (SIMULATOR_TESTED, never LAB_VALIDATED):
 *
 *   L4 UAM device simulator redirect → portal (`@ecloud/portal`, in-process) → api internal
 *   listener (real `@ecloud/api`, ecloud_test + Redis) → login → 302 hand-off to the NAS
 *   `/logon` → simulator decodes the PAP password like the device → Access-Request sent with
 *   radclient through the REAL dev-stack FreeRADIUS container (rlm_rest → this api) →
 *   Access-Accept with the policy reply attributes.
 *
 * Requires `ECLOUD_TEST_RADIUS=1`, docker with the dev stack's `freeradius` running, and
 * `ECLOUD_TEST_DATABASE_URL`; skips cleanly otherwise. The api internal listener binds where the
 * container already sends rlm_rest (`ECLOUD_INTERNAL_URL`, default host.docker.internal:3001),
 * so no api may be running on that port (the aaa-contract stub uses it too; this suite runs in
 * its own Vitest project after it). Nothing here starts, stops or rebuilds containers.
 */
import {
  MemoryKv,
  RedisKv,
  createApp,
  loadApiConfig,
  sealUamSecret,
  type AppDeps,
  type KvStore,
} from '@ecloud/api';
import { createDb, hashPassword } from '@ecloud/db';
import { HttpPortalApi, createServer, loadPortalConfig } from '@ecloud/portal';
import { createLogger, loadConfig, newId } from '@ecloud/shared';
import {
  SIM_UAM_SECRET,
  buildUamRedirect,
  deviceDecodePapTip,
  getTestAppDatabaseUrl,
  getTestDatabaseUrl,
  getTestRedisUrl,
  migrateTestDatabase,
  parseDeviceLogon,
  probeIntegration,
} from '@ecloud/testing';
import { sql } from 'kysely';
import { randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compose, containerEnv, radclient, radiusGate } from '../aaa-contract/radius-harness.js';

const gate = radiusGate();
const db = await probeIntegration();
const ready = gate.ok && db.ok;
const reason = !gate.ok ? gate.reason : !db.ok ? db.reason : '';
if (
  !ready &&
  process.env['ECLOUD_TEST_RADIUS'] === '1' &&
  process.env['ECLOUD_TEST_REQUIRE_INTEGRATION'] === '1'
) {
  throw new Error(`portal RADIUS e2e required but unavailable: ${reason}`);
}
const suite = ready ? describe : describe.skip;
const title = ready
  ? 'e2e: UAM simulator → portal → FreeRADIUS → /internal/aaa (portal credential)'
  : `e2e: UAM simulator → portal → FreeRADIUS [skipped: ${reason}]`;

const SUB_PASSWORD = 'e2e-sub-password-1';
const logger = createLogger({ name: 'portal-e2e', level: 'silent' });

suite(title, () => {
  let deps: AppDeps;
  let internalServer: Server;
  let portal: ReturnType<typeof createServer>;
  let portalOrigin: string;
  let containerIp: string;
  const f = {
    orgId: '',
    siteId: '',
    nasId: '',
    nasIdentifier: `e2e-nas-${randomBytes(4).toString('hex')}`,
    portalId: '',
    username: `e2e-${randomBytes(4).toString('hex')}`,
  };

  beforeAll(async () => {
    await migrateTestDatabase();
    const internalUrl = new URL(
      containerEnv('ECLOUD_INTERNAL_URL') || 'http://host.docker.internal:3001',
    );
    const token = containerEnv('INTERNAL_API_TOKEN');
    expect(token, 'INTERNAL_API_TOKEN in the freeradius container').not.toBe('');
    const ip = compose(['exec', '-T', 'freeradius', 'hostname', '-i'])
      .stdout.trim()
      .split(/\s+/)[0];
    expect(ip, 'freeradius container address').toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    containerIp = ip ?? '';

    const platformUrl = getTestDatabaseUrl() ?? '';
    const appUrl = getTestAppDatabaseUrl() ?? '';
    const redisUrl = getTestRedisUrl();
    const env = {
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      INTERNAL_API_TOKEN: token,
      DATABASE_URL: appUrl,
      DATABASE_URL_PLATFORM: platformUrl,
      KV_DRIVER: redisUrl === undefined ? 'memory' : 'redis',
      ...(redisUrl === undefined ? {} : { REDIS_URL: redisUrl }),
      ARGON2_MEMORY_KIB: '8192',
    };
    const config = loadApiConfig(env);
    const kv: KvStore = redisUrl === undefined ? new MemoryKv() : RedisKv.connect(redisUrl);
    deps = {
      config,
      logger,
      db: createDb(appUrl, { max: 4, applicationName: 'ecloud-e2e-portal' }),
      dbPlatform: createDb(platformUrl, { max: 4, applicationName: 'ecloud-e2e-portal-platform' }),
      kv,
    };
    const { internalApp } = createApp(deps);
    const host = process.platform === 'linux' ? '0.0.0.0' : '127.0.0.1';
    const port = Number(internalUrl.port || 80);
    internalServer = await new Promise<Server>((resolve, reject) => {
      const s = internalApp.listen(port, host, (error?: Error) =>
        error
          ? reject(
              new Error(
                `cannot bind the api internal listener on ${host}:${String(port)}: ${error.message}`,
              ),
            )
          : resolve(s),
      );
    });

    const portalConfig = loadPortalConfig(env, loadConfig(env));
    portalOrigin = config.base.origins.portal.replace(/\/+$/, '');
    portal = createServer({
      config: portalConfig,
      logger,
      api: new HttpPortalApi(`http://127.0.0.1:${String(port)}`, token, 5_000),
    });

    // ---- fixture: tenant, NAS at the container address (= authenticated packet source) ----
    const p = deps.dbPlatform;
    // The NAS IP is unique among live rows: retire earlier e2e rows for this address.
    await sql`UPDATE nas_clients SET deleted_at = now() WHERE nas_ip = ${containerIp}::inet AND deleted_at IS NULL`.execute(
      p,
    );
    f.orgId = newId();
    f.siteId = newId();
    await p
      .insertInto('organizations')
      .values({ id: f.orgId, slug: `e2e-${randomBytes(5).toString('hex')}`, name: 'E2E Org' })
      .execute();
    await p
      .insertInto('sites')
      .values({
        id: f.siteId,
        organization_id: f.orgId,
        slug: 'lobby',
        name: 'Lobby',
        timezone: 'UTC',
      })
      .execute();
    const nas = await p
      .insertInto('nas_clients')
      .values({
        organization_id: f.orgId,
        site_id: f.siteId,
        name: 'sim-uspot',
        nas_identifier: f.nasIdentifier,
        nas_ip: containerIp,
        adapter_type_key: 'openwifi-uspot-uam',
        adapter_key: 'openwifi-uspot-uam',
        secret_ref: 'enc:placeholder',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    f.nasId = nas.id;
    const portalRow = await p
      .insertInto('captive_portals')
      .values({
        organization_id: f.orgId,
        site_id: f.siteId,
        name: 'Lobby Wi-Fi',
        public_slug: `e2e-${randomBytes(5).toString('hex')}`,
        portal_type: 'uspot',
        network_ref: 'guest',
        auth_methods: ['password', 'voucher', 'click_through'],
        uam_secret_ref: sealUamSecret(config.dataEncryptionKey, SIM_UAM_SECRET),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    f.portalId = portalRow.id;
    await p
      .insertInto('users')
      .values({
        organization_id: f.orgId,
        username: f.username,
        password_hash: await hashPassword(SUB_PASSWORD, { memoryKib: 8192 }),
      })
      .execute();
    const policy = await p
      .insertInto('policies')
      .values({
        organization_id: f.orgId,
        site_id: f.siteId,
        name: 'E2E 10/2 Mbit',
        scope_type: 'site',
        status: 'active',
        download_rate_kbps: 10_000,
        upload_rate_kbps: 2_000,
        session_timeout_s: 3_600,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await p
      .insertInto('policy_assignments')
      .values({
        organization_id: f.orgId,
        policy_id: policy.id,
        target_type: 'site',
        site_id: f.siteId,
      })
      .execute();
  }, 120_000);

  afterAll(async () => {
    // rlm_rest keeps pooled keep-alive connections open: close them, or close() never returns.
    await new Promise<void>((resolve) => {
      if (internalServer === undefined) {
        resolve();
        return;
      }
      internalServer.close(() => resolve());
      internalServer.closeAllConnections();
    });
    if (deps) {
      await sql`UPDATE nas_clients SET deleted_at = now() WHERE id = ${f.nasId}::uuid`
        .execute(deps.dbPlatform)
        .catch(() => undefined);
      await Promise.allSettled([deps.db.destroy(), deps.dbPlatform.destroy(), deps.kv.close()]);
    }
  });

  const wireMac = () =>
    Array.from(randomBytes(6), (b) => b.toString(16).padStart(2, '0').toUpperCase()).join('-');

  function device() {
    return {
      mac: wireMac(),
      sessionid: randomBytes(8).toString('hex'),
      challenge: randomBytes(16).toString('hex'),
    };
  }

  type Device = ReturnType<typeof device>;

  function redirect(d: Device, userurl = 'https://example.com/landing') {
    return buildUamRedirect(
      {
        uamServer: `${portalOrigin}/uam/uspot/`,
        uamSecret: SIM_UAM_SECRET,
        res: 'notyet',
        uamip: '10.1.0.1',
        uamport: '3990',
        challenge: d.challenge,
        mac: d.mac,
        ip: '10.1.0.50',
        called: 'AA-00-00-00-00-01',
        nasid: f.nasIdentifier,
        ssid: 'Guest',
        sessionid: d.sessionid,
        userurl,
      },
      'uspot-tip',
    );
  }

  /** Browser: UAM redirect → flow page → login form → POST → 302 Location. */
  async function browserLogin(d: Device, password = SUB_PASSWORD, userurl?: string) {
    const r = redirect(d, userurl);
    const entry = await request(portal).get(`/uam/uspot/?${r.query}`);
    expect(entry.status, entry.text).toBe(303);
    const flowPath = String(entry.headers.location);
    const cookie =
      String((entry.headers['set-cookie'] as unknown as string[])[0]).split(';')[0] ?? '';
    const form = await request(portal).get(`${flowPath}/login`).set('Cookie', cookie);
    expect(form.status).toBe(200);
    const csrf = /name="csrf" value="([^"]+)"/.exec(form.text)?.[1] ?? '';
    const post = await request(portal)
      .post(`${flowPath}/login`)
      .set('Cookie', cookie)
      .type('form')
      .send({ csrf, username: f.username, password });
    return { post, flowPath, cookie, redirect: r };
  }

  function packet(d: Device, cred: { username: string; password: string }, mac = d.mac): string {
    return [
      `User-Name = "${cred.username}"`,
      `User-Password = "${cred.password}"`,
      `Acct-Session-Id = "${d.sessionid}"`,
      'Framed-IP-Address = 10.1.0.50',
      `Calling-Station-Id = "${mac}"`,
      'Called-Station-Id = "AA-00-00-00-00-01:Guest"',
      `NAS-Identifier = "${f.nasIdentifier}"`,
      `NAS-IP-Address = ${containerIp}`,
      'NAS-Port-Type = Wireless-802.11',
      'WISPr-Logoff-URL = "http://10.1.0.1:3990/logoff"',
      'Message-Authenticator = 0x00',
      '',
    ].join('\n');
  }

  it('redirect → login → hand-off → Access-Request through FreeRADIUS → Access-Accept with policy attributes; retransmit idempotent', async () => {
    const d = device();
    const { post, flowPath, cookie } = await browserLogin(d);
    expect(post.status, post.text).toBe(302);
    const location = String(post.headers.location);
    const logon = parseDeviceLogon(location);
    expect(logon).toMatchObject({ host: '10.1.0.1', port: '3990', path: '/logon' });
    expect(logon.username).toMatch(/^pc-[0-9a-f]{16}$/);
    expect(decodeURIComponent(logon.userurlRaw ?? '')).toBe('https://example.com/landing');
    const cred = {
      username: logon.username ?? '',
      password: deviceDecodePapTip(logon.passwordHex ?? '', d.challenge, SIM_UAM_SECRET),
    };
    expect(Buffer.byteLength(cred.password)).toBeLessThanOrEqual(16);

    const reply = await radclient(packet(d, cred), { type: 'auth' });
    expect(reply.code, reply.output).toBe('Access-Accept');
    expect(reply.attributes['WISPr-Bandwidth-Max-Down']).toEqual(['10000000']);
    expect(reply.attributes['WISPr-Bandwidth-Max-Up']).toEqual(['2000000']);
    expect(Number(reply.attributes['Session-Timeout']?.[0])).toBeGreaterThan(0);
    const cls = reply.attributes['Class']?.[0] ?? '';
    expect(Buffer.from(cls.replace(/^0x/, ''), 'hex').toString('latin1')).toMatch(
      /^ai:[0-9a-f]{32}$/,
    );
    expect(reply.output).not.toContain(SUB_PASSWORD);

    // NAS retransmit of the same Access-Request: same decision, same Class (no second session).
    const again = await radclient(packet(d, cred), { type: 'auth' });
    expect(again.code).toBe('Access-Accept');
    expect(again.attributes['Class']?.[0]).toBe(cls);
    const sessions = await deps.dbPlatform
      .selectFrom('sessions')
      .select(['status', 'acct_session_id', 'acct_unique_id'])
      .where('nas_client_id', '=', f.nasId)
      .where('acct_session_id', '=', d.sessionid)
      .execute();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.status).toBe('authorized');

    // Device reports success back to the portal (final-redirect-url = uam).
    const success = buildUamRedirect({ ...redirectInputOf(d), res: 'success' }, 'uspot-tip');
    const done = await request(portal).get(`/uam/uspot/?${success.query}`);
    expect(done.status).toBe(200);
    expect(done.text).toContain('You are connected.');
    const status = await request(portal).get(`${flowPath}/status`).set('Cookie', cookie);
    expect(status.status).toBe(200);
    expect(status.text).toContain('Sign out');

    // The consumed redirect cannot be replayed into a new flow.
    const replay = await request(portal).get(`/uam/uspot/?${redirect(d).query}`);
    expect(replay.status).toBe(400);
  });

  function redirectInputOf(d: Device) {
    return {
      uamServer: `${portalOrigin}/uam/uspot/`,
      uamSecret: SIM_UAM_SECRET,
      res: 'notyet',
      uamip: '10.1.0.1',
      uamport: '3990',
      challenge: d.challenge,
      mac: d.mac,
      ip: '10.1.0.50',
      called: 'AA-00-00-00-00-01',
      nasid: f.nasIdentifier,
      ssid: 'Guest',
      sessionid: d.sessionid,
      userurl: 'https://example.com/landing',
    };
  }

  it('wrong client MAC on the Access-Request is rejected by FreeRADIUS; the bound MAC still gets in', async () => {
    const d = device();
    const { post } = await browserLogin(d);
    expect(post.status).toBe(302);
    const logon = parseDeviceLogon(String(post.headers.location));
    const cred = {
      username: logon.username ?? '',
      password: deviceDecodePapTip(logon.passwordHex ?? '', d.challenge, SIM_UAM_SECRET),
    };
    const wrong = await radclient(packet(d, cred, wireMac()), { type: 'auth' });
    expect(wrong.code, wrong.output).toBe('Access-Reject');
    expect(wrong.attributes['Reply-Message']).toEqual(['Access denied']);
    const forgedPassword = await radclient(packet(d, { ...cred, password: 'x'.repeat(16) }), {
      type: 'auth',
    });
    expect(forgedPassword.code).toBe('Access-Reject');
    const right = await radclient(packet(d, cred), { type: 'auth' });
    expect(right.code, right.output).toBe('Access-Accept');
  });

  it('forged md and hostile userurl at the portal: generic error page / no reflected redirect', async () => {
    const d = device();
    const r = redirect(d);
    const forged = await request(portal).get(`/uam/uspot/?${r.signedQuery}&md=${'A'.repeat(32)}`);
    expect(forged.status).toBe(400);
    expect(forged.text).toContain('We could not start sign-in on this network.');
    const hostile = await browserLogin(device(), SUB_PASSWORD, 'http://10.1.0.1:3990/logoff');
    expect(hostile.post.status).toBe(302);
    expect(parseDeviceLogon(String(hostile.post.headers.location)).userurlRaw).toBeNull();
  });

  it('brute force through the portal: the 6th attempt is locked out (429)', async () => {
    const d = device();
    const r = redirect(d);
    const entry = await request(portal).get(`/uam/uspot/?${r.query}`);
    const flowPath = String(entry.headers.location);
    const cookie =
      String((entry.headers['set-cookie'] as unknown as string[])[0]).split(';')[0] ?? '';
    const form = await request(portal).get(`${flowPath}/login`).set('Cookie', cookie);
    const csrf = /name="csrf" value="([^"]+)"/.exec(form.text)?.[1] ?? '';
    const statuses: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      const res = await request(portal)
        .post(`${flowPath}/login`)
        .set('Cookie', cookie)
        .type('form')
        .send({
          csrf,
          username: f.username,
          password: i < 5 ? `wrong-${String(i)}` : SUB_PASSWORD,
        });
      statuses.push(res.status);
    }
    expect(statuses).toEqual([422, 422, 422, 422, 422, 429]);
  });
});
