/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment -- supertest response bodies are untyped JSON */
/**
 * Multi-vendor Cycle A (D-044, migration 028) against `ecloud_test`:
 *  - access points behind a NAS (AP MAC identity): canonical MAC, global uniqueness, tenant
 *    safety, site follows the NAS, NAS delete frees the MACs; `findNasByIdentity` fail-closed rules;
 *  - vendor API credentials: write-only secret sealed at rest, SSRF guard on base_url, vendor /
 *    kind checks, audit without values, impersonation refused, cross-tenant 404;
 *  - AAA for the generic 802.1X / MAC-auth adapter: MAC-as-username MAB, MAC mismatch, EAP inner
 *    identities (allowed only on 802.1X adapters, never a portal credential, never MAC auth).
 * Skipped without the dev stack (ECLOUD_TEST_DATABASE_URL).
 */
import { describeIntegration, migrateTestDatabase } from '@ecloud/testing';
import { newId } from '@ecloud/shared';
import { sql } from 'kysely';
import { generate } from 'otplib';
import request from 'supertest';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createApp } from './app.js';
import type { AppDeps } from './context.js';
import { Envelope, openSecretRef } from './crypto.js';
import { ServiceUnavailableError } from './http/errors.js';
import { consumePortalLoginToken, issuePortalLoginToken } from './internal/login-token-store.js';
import { findNasByIdentity } from './internal/nas-lookup.js';
import { MemoryKv, RedisKv } from './kv.js';
import { VENDOR_API_SECRET_PURPOSE } from './routes/controllers.js';
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

const BROWSER = { Origin: TEST_ORIGIN, 'X-Requested-With': 'XMLHttpRequest' };
/** Obviously fake controller-API secret (never a real credential). */
const FAKE_API_SECRET = 'test-vendor-api-secret-not-real';

function randomIp(): string {
  const b = () => Math.floor(Math.random() * 250) + 2;
  return `10.${String(b())}.${String(b())}.${String(b())}`;
}

/** Random locally administered unicast MAC in UPPER-dash form (canonicalised by the API). */
function randomMac(): { dashed: string; canonical: string } {
  const bytes = [0x02, ...Array.from({ length: 5 }, () => Math.floor(Math.random() * 256))];
  const hex = bytes.map((b) => b.toString(16).padStart(2, '0'));
  return { dashed: hex.join('-').toUpperCase(), canonical: hex.join(':') };
}

function radius(attrs: Record<string, string | number>) {
  return Object.fromEntries(
    Object.entries(attrs).map(([k, v]) => [
      k,
      { type: typeof v === 'number' ? 'integer' : 'string', value: [v] },
    ]),
  );
}

await describeIntegration('@ecloud/api multi-vendor Cycle A', () => {
  let deps: AppDeps;

  beforeAll(async () => {
    await migrateTestDatabase();
    deps = integrationDeps();
  }, 60_000);

  afterAll(async () => {
    await closeDeps(deps);
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

  async function orgAdmin(apps: Apps) {
    const tenant = await createTenant(deps.dbPlatform);
    const admin = await createAdmin(deps.dbPlatform, [
      { template: 'org_admin', scope: 'organization', orgId: tenant.orgId },
    ]);
    return { ...tenant, admin, agent: await login(apps, admin) };
  }

  async function createNas(
    agent: Agent,
    orgId: string,
    siteId: string,
    adapterKey = 'generic-radius-8021x',
    extra: Record<string, unknown> = {},
  ): Promise<{ id: string; ip: string }> {
    const ip = randomIp();
    const res = await agent
      .post(`/api/v1/orgs/${orgId}/nas`)
      .set(BROWSER)
      .send({ site_id: siteId, name: `nas ${ip}`, nas_ip: ip, adapter_key: adapterKey, ...extra });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return { id: res.body.id as string, ip };
  }

  // ---------------------------------------------------------------------------- access points

  it('access points: canonical MAC, site from the NAS, unicast only, globally unique', async () => {
    const apps = freshApps();
    const a = await orgAdmin(apps);
    const nas = await createNas(a.agent, a.orgId, a.siteId);
    const mac = randomMac();

    const created = await a.agent
      .post(`/api/v1/orgs/${a.orgId}/access-points`)
      .set(BROWSER)
      .send({ nas_client_id: nas.id, mac: mac.dashed, name: 'Lobby AP' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.mac).toBe(mac.canonical);
    expect(created.body.site_id).toBe(a.siteId);
    expect(created.body.nas_client_id).toBe(nas.id);

    // same MAC again in the same org (other spelling) -> generic 409
    const dupSame = await a.agent
      .post(`/api/v1/orgs/${a.orgId}/access-points`)
      .set(BROWSER)
      .send({ nas_client_id: nas.id, mac: mac.canonical.replace(/:/g, '') });
    expect(dupSame.status).toBe(409);

    // same MAC in ANOTHER organization -> the same 409 (global rule), no tenant detail
    const b = await orgAdmin(apps);
    const nasB = await createNas(b.agent, b.orgId, b.siteId);
    const dupOther = await b.agent
      .post(`/api/v1/orgs/${b.orgId}/access-points`)
      .set(BROWSER)
      .send({ nas_client_id: nasB.id, mac: mac.dashed });
    expect(dupOther.status).toBe(409);
    expect(JSON.stringify(dupOther.body)).not.toContain(a.orgId);

    // multicast / broadcast / zero / garbage refused
    for (const bad of ['01:00:5e:00:00:01', 'ff:ff:ff:ff:ff:ff', '00:00:00:00:00:00', 'ap-1']) {
      const res = await a.agent
        .post(`/api/v1/orgs/${a.orgId}/access-points`)
        .set(BROWSER)
        .send({ nas_client_id: nas.id, mac: bad });
      expect(res.status, bad).toBe(400);
    }

    // a NAS of another organization is invisible (G9)
    const foreign = await a.agent
      .post(`/api/v1/orgs/${a.orgId}/access-points`)
      .set(BROWSER)
      .send({ nas_client_id: nasB.id, mac: randomMac().canonical });
    expect(foreign.status).toBe(404);

    // org B cannot read org A's access point
    const peek = await b.agent.get(`/api/v1/orgs/${a.orgId}/access-points/${created.body.id}`);
    expect([403, 404]).toContain(peek.status);
    const listB = await b.agent.get(`/api/v1/orgs/${b.orgId}/access-points`);
    expect(listB.status).toBe(200);
    expect(JSON.stringify(listB.body)).not.toContain(mac.canonical);

    // audited in the tenant
    const audit = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM audit_logs
       WHERE action = 'nas:create' AND target_type = 'access_point' AND target_id = ${created.body.id}
    `.execute(deps.dbPlatform);
    expect(audit.rows[0]?.n).toBe(1);
  });

  it('access points: moving / deleting the NAS keeps the AP consistent and frees the MAC', async () => {
    const apps = freshApps();
    const a = await orgAdmin(apps);
    const nas = await createNas(a.agent, a.orgId, a.siteId);
    const mac = randomMac();
    const ap = await a.agent
      .post(`/api/v1/orgs/${a.orgId}/access-points`)
      .set(BROWSER)
      .send({ nas_client_id: nas.id, mac: mac.canonical });
    expect(ap.status).toBe(201);

    // NAS moves to site 2 -> the AP follows (composite FK ON UPDATE CASCADE)
    const moved = await a.agent
      .patch(`/api/v1/orgs/${a.orgId}/nas/${nas.id}`)
      .set(BROWSER)
      .send({ site_id: a.siteId2 });
    expect(moved.status).toBe(200);
    const after = await a.agent.get(`/api/v1/orgs/${a.orgId}/access-points/${ap.body.id}`);
    expect(after.body.site_id).toBe(a.siteId2);

    // deleting the NAS soft-deletes its APs: the MAC can be registered again
    const del = await a.agent.delete(`/api/v1/orgs/${a.orgId}/nas/${nas.id}`).set(BROWSER);
    expect(del.status).toBe(204);
    const gone = await a.agent.get(`/api/v1/orgs/${a.orgId}/access-points/${ap.body.id}`);
    expect(gone.status).toBe(404);
    const nas2 = await createNas(a.agent, a.orgId, a.siteId);
    const again = await a.agent
      .post(`/api/v1/orgs/${a.orgId}/access-points`)
      .set(BROWSER)
      .send({ nas_client_id: nas2.id, mac: mac.canonical });
    expect(again.status).toBe(201);
  });

  it('findNasByIdentity: nasid decides, AP rows are hints; MAC-only needs a RADIUS-verified AP', async () => {
    const apps = freshApps();
    const a = await orgAdmin(apps);
    const nasId = `nas-${newId().slice(-12)}`;
    const nas = await createNas(a.agent, a.orgId, a.siteId, 'generic-radius-8021x', {
      nas_identifier: nasId,
    });
    const other = await createNas(a.agent, a.orgId, a.siteId);
    const mac = randomMac();
    const otherMac = randomMac();
    const apIds: string[] = [];
    for (const [nasClientId, m] of [
      [nas.id, mac.canonical],
      [other.id, otherMac.canonical],
    ] as const) {
      const res = await a.agent
        .post(`/api/v1/orgs/${a.orgId}/access-points`)
        .set(BROWSER)
        .send({ nas_client_id: nasClientId, mac: m });
      expect(res.status).toBe(201);
      expect(res.body.verified_at).toBeNull();
      apIds.push(res.body.id as string);
    }

    // unverified: never usable on its own (M1b)
    expect(await findNasByIdentity(deps, { apMac: mac.dashed })).toEqual({
      ok: false,
      reason: 'ap_unverified',
    });
    // a tenant cannot set verified_at itself
    const selfVerify = await a.agent
      .patch(`/api/v1/orgs/${a.orgId}/access-points/${String(apIds[0])}`)
      .set(BROWSER)
      .send({ verified_at: new Date().toISOString() });
    expect(selfVerify.status).toBe(400);

    // an authenticated Access-Request of ANOTHER NAS naming the MAC does not verify it
    await authorize(
      apps,
      radius({
        'User-Name': 'nobody',
        'User-Password': 'x-placeholder',
        'Called-Station-Id': `${mac.dashed}:lab`,
        'ECLOUD-Packet-Src-IP-Address': other.ip,
      }),
    );
    expect(await findNasByIdentity(deps, { apMac: mac.canonical })).toEqual({
      ok: false,
      reason: 'ap_unverified',
    });
    // ...its own NAS does (the packet passed the NAS secret check in FreeRADIUS)
    await authorize(
      apps,
      radius({
        'User-Name': 'nobody',
        'User-Password': 'x-placeholder',
        'Called-Station-Id': `${mac.dashed}:lab`,
        'ECLOUD-Packet-Src-IP-Address': nas.ip,
      }),
    );
    const verified = await a.agent.get(`/api/v1/orgs/${a.orgId}/access-points/${String(apIds[0])}`);
    expect(verified.body.verification_source).toBe('radius-called-station');
    expect(verified.body.verified_at).not.toBeNull();
    expect(await findNasByIdentity(deps, { apMac: mac.dashed })).toMatchObject({
      ok: true,
      via: 'ap_mac',
      nas: { id: nas.id },
    });
    expect(await findNasByIdentity(deps, { nasid: nasId, apMac: mac.canonical })).toMatchObject({
      ok: true,
      via: 'both',
      apMacClaimedElsewhere: false,
    });
    // nasid of NAS 1 + an AP registered to NAS 2: NOT a conflict (no squatting DoS), flagged
    expect(
      await findNasByIdentity(deps, { nasid: nasId, apMac: otherMac.canonical }),
    ).toMatchObject({ ok: true, via: 'nasid', nas: { id: nas.id }, apMacClaimedElsewhere: true });
    const stranger = randomMac().canonical;
    expect(await findNasByIdentity(deps, { apMac: stranger })).toEqual({
      ok: false,
      reason: 'unknown_ap',
    });
    expect(await findNasByIdentity(deps, { nasid: nasId, apMac: stranger })).toMatchObject({
      ok: true,
      via: 'nasid',
    });
    expect(await findNasByIdentity(deps, { apMac: '01:00:5e:00:00:01' })).toEqual({
      ok: false,
      reason: 'no_identity',
    });

    // changing the MAC resets the verification
    const moved = randomMac();
    await a.agent
      .patch(`/api/v1/orgs/${a.orgId}/access-points/${String(apIds[0])}`)
      .set(BROWSER)
      .send({ mac: moved.canonical });
    expect(await findNasByIdentity(deps, { apMac: moved.canonical })).toEqual({
      ok: false,
      reason: 'ap_unverified',
    });
    // a disabled AP refuses MAC-only lookups
    await authorize(
      apps,
      radius({
        'User-Name': 'nobody',
        'Called-Station-Id': moved.dashed,
        'User-Password': 'x-placeholder',
        'ECLOUD-Packet-Src-IP-Address': nas.ip,
      }),
    );
    await a.agent
      .patch(`/api/v1/orgs/${a.orgId}/access-points/${String(apIds[0])}`)
      .set(BROWSER)
      .send({ status: 'disabled' });
    expect(await findNasByIdentity(deps, { apMac: moved.canonical })).toEqual({
      ok: false,
      reason: 'ap_inactive',
    });
  });

  it('squatting: 409 carries no constraint name; a platform admin can release the MAC (audited)', async () => {
    const apps = freshApps();
    const owner = await orgAdmin(apps);
    const squatter = await orgAdmin(apps);
    const mac = randomMac();
    const nasS = await createNas(squatter.agent, squatter.orgId, squatter.siteId);
    const squat = await squatter.agent
      .post(`/api/v1/orgs/${squatter.orgId}/access-points`)
      .set(BROWSER)
      .send({ nas_client_id: nasS.id, mac: mac.canonical });
    expect(squat.status).toBe(201);
    const nasO = await createNas(owner.agent, owner.orgId, owner.siteId);
    const blocked = await owner.agent
      .post(`/api/v1/orgs/${owner.orgId}/access-points`)
      .set(BROWSER)
      .send({ nas_client_id: nasO.id, mac: mac.canonical });
    expect(blocked.status).toBe(409);
    expect(blocked.body.constraint).toBeUndefined();
    expect(JSON.stringify(blocked.body)).not.toContain('uq_nas_access_points_mac');
    // same rule for the NAS IP slot
    const ipDup = await owner.agent.post(`/api/v1/orgs/${owner.orgId}/nas`).set(BROWSER).send({
      site_id: owner.siteId,
      name: 'dup',
      nas_ip: nasS.ip,
      adapter_key: 'generic-radius-8021x',
    });
    expect(ipDup.status).toBe(409);
    expect(JSON.stringify(ipDup.body)).not.toContain('uq_nas_clients_ip');

    // tenants cannot use the platform path
    const tenantTry = await owner.agent
      .post('/api/v1/platform/access-points/release')
      .set(BROWSER)
      .send({ mac: mac.canonical, reason: 'ticket 1234 squatted MAC' });
    expect(tenantTry.status).toBe(403);

    const admin = await createAdmin(deps.dbPlatform, [
      { template: 'platform_super_admin', scope: 'platform' },
    ]);
    const platform = await login(apps, admin);
    const enrol = await platform.post('/api/v1/auth/mfa/enrol').set(BROWSER);
    await platform
      .post('/api/v1/auth/mfa/confirm')
      .set(BROWSER)
      .send({ code: await generate({ secret: enrol.body.secret as string }) });
    const shortReason = await platform
      .post('/api/v1/platform/access-points/release')
      .set(BROWSER)
      .send({ mac: mac.canonical, reason: 'x' });
    expect(shortReason.status).toBe(400);
    const released = await platform
      .post('/api/v1/platform/access-points/release')
      .set(BROWSER)
      .send({ mac: mac.dashed, reason: 'ticket 1234 squatted MAC' });
    expect(released.status, JSON.stringify(released.body)).toBe(200);
    expect(released.body).toMatchObject({ released: true, organization_id: squatter.orgId });
    const audit = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM audit_logs
       WHERE action = 'access_point:release' AND organization_id = ${squatter.orgId}
    `.execute(deps.dbPlatform);
    expect(audit.rows[0]?.n).toBe(1);
    const again = await platform
      .post('/api/v1/platform/access-points/release')
      .set(BROWSER)
      .send({ mac: mac.canonical, reason: 'ticket 1234 squatted MAC' });
    expect(again.status).toBe(404);
    // the owner can register it now
    const ok = await owner.agent
      .post(`/api/v1/orgs/${owner.orgId}/access-points`)
      .set(BROWSER)
      .send({ nas_client_id: nasO.id, mac: mac.canonical });
    expect(ok.status).toBe(201);
  });

  it('deleting a site or an organization frees its global slots (AP MACs, NAS IPs, devices)', async () => {
    const apps = freshApps();
    const a = await orgAdmin(apps);
    const nas1 = await createNas(a.agent, a.orgId, a.siteId);
    const nas2 = await createNas(a.agent, a.orgId, a.siteId2);
    const mac1 = randomMac();
    const mac2 = randomMac();
    for (const [n, m] of [
      [nas1.id, mac1.canonical],
      [nas2.id, mac2.canonical],
    ] as const) {
      const res = await a.agent
        .post(`/api/v1/orgs/${a.orgId}/access-points`)
        .set(BROWSER)
        .send({ nas_client_id: n, mac: m });
      expect(res.status).toBe(201);
    }
    const delSite = await a.agent.delete(`/api/v1/orgs/${a.orgId}/sites/${a.siteId}`).set(BROWSER);
    expect(delSite.status).toBe(204);
    const live = async (orgId: string) =>
      (
        await sql<{ ap: number; nas: number }>`
          SELECT (SELECT count(*)::int FROM nas_access_points WHERE organization_id = ${orgId} AND deleted_at IS NULL) AS ap,
                 (SELECT count(*)::int FROM nas_clients WHERE organization_id = ${orgId} AND deleted_at IS NULL) AS nas
        `.execute(deps.dbPlatform)
      ).rows[0];
    expect(await live(a.orgId)).toEqual({ ap: 1, nas: 1 }); // site 2 untouched

    // another org can now take site 1's slots
    const b = await orgAdmin(apps);
    const reuseIp = await b.agent.post(`/api/v1/orgs/${b.orgId}/nas`).set(BROWSER).send({
      site_id: b.siteId,
      name: 'reuse',
      nas_ip: nas1.ip,
      adapter_key: 'generic-radius-8021x',
    });
    expect(reuseIp.status, JSON.stringify(reuseIp.body)).toBe(201);
    const reuseMac = await b.agent
      .post(`/api/v1/orgs/${b.orgId}/access-points`)
      .set(BROWSER)
      .send({ nas_client_id: reuseIp.body.id, mac: mac1.canonical });
    expect(reuseMac.status).toBe(201);

    // archiving the organization frees the rest
    const admin = await createAdmin(deps.dbPlatform, [
      { template: 'platform_super_admin', scope: 'platform' },
    ]);
    const platform = await login(apps, admin);
    const enrol = await platform.post('/api/v1/auth/mfa/enrol').set(BROWSER);
    await platform
      .post('/api/v1/auth/mfa/confirm')
      .set(BROWSER)
      .send({ code: await generate({ secret: enrol.body.secret as string }) });
    const archive = await platform.delete(`/api/v1/platform/organizations/${a.orgId}`).set(BROWSER);
    expect(archive.status, JSON.stringify(archive.body)).toBe(204);
    expect(await live(a.orgId)).toEqual({ ap: 0, nas: 0 });
    const reuse2 = await b.agent
      .post(`/api/v1/orgs/${b.orgId}/access-points`)
      .set(BROWSER)
      .send({ nas_client_id: reuseIp.body.id, mac: mac2.canonical });
    expect(reuse2.status).toBe(201);
  });

  it('login token store (L6): Redis SET NX single use; store failure is a 503', async () => {
    const binding = {
      organizationId: newId(),
      siteId: newId(),
      nasId: newId(),
      clientMac: randomMac().dashed,
      flowId: newId(),
    };
    const now = new Date();
    const redisUrl = process.env['ECLOUD_TEST_REDIS_URL'];
    // the real Redis when the integration env provides it (SET NX EX), else the in-memory KV
    const kv = redisUrl ? RedisKv.connect(redisUrl) : new MemoryKv();
    const redisDeps: AppDeps = { ...deps, kv };
    // no offline queue: wait until the connection is up
    for (let i = 0; i < 50; i += 1) {
      if (
        await kv.ping().then(
          () => true,
          () => false,
        )
      )
        break;
      await new Promise((r) => setTimeout(r, 100));
    }
    try {
      await runLoginTokenChecks(redisDeps, binding, now);
    } finally {
      await kv.close();
    }
  });

  async function runLoginTokenChecks(
    deps: AppDeps,
    binding: Parameters<typeof issuePortalLoginToken>[1],
    now: Date,
  ): Promise<void> {
    const issued = issuePortalLoginToken(deps, binding, now);
    expect(issued.token.startsWith('lt1.')).toBe(true);
    // deps.kv is the real test Redis (ECLOUD_TEST_REDIS_URL)
    const first = await consumePortalLoginToken(deps, issued.token, binding, now);
    expect(first.ok).toBe(true);
    expect(await deps.kv.get(`pf:lt-used:${issued.tokenId}`)).toBe('1');
    expect(await deps.kv.ttl(`pf:lt-used:${issued.tokenId}`)).toBeGreaterThan(60);
    // a second API instance (fresh deps object, same Redis) sees the claim
    const replay = await consumePortalLoginToken({ ...deps }, issued.token, binding, now);
    expect(replay).toEqual({ ok: false, reason: 'replayed' });
    const wrongTenant = await consumePortalLoginToken(
      deps,
      issuePortalLoginToken(deps, binding, now).token,
      { ...binding, organizationId: newId() },
      now,
    );
    expect(wrongTenant).toEqual({ ok: false, reason: 'binding_mismatch' });

    const broken = new MemoryKv();
    broken.set = () => Promise.reject(new Error('redis down'));
    const second = issuePortalLoginToken(deps, binding, now);
    const failure = await consumePortalLoginToken(
      { ...deps, kv: broken },
      second.token,
      binding,
      now,
    )
      .then(() => null)
      .catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ServiceUnavailableError);
    expect((failure as ServiceUnavailableError).status).toBe(503);
  }

  // --------------------------------------------------------------------- vendor API credentials

  async function controller(
    agent: Agent,
    orgId: string,
    body: Record<string, unknown>,
  ): Promise<string> {
    const res = await agent
      .post(`/api/v1/orgs/${orgId}/controllers`)
      .set(BROWSER)
      .send({ name: `ctrl ${newId().slice(-12)}`, ...body });
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

  it('vendor API credential: write-only secret, sealed with its own purpose, audited without values', async () => {
    const apps = freshApps();
    const a = await orgAdmin(apps);
    const id = await controller(a.agent, a.orgId, {
      vendor_key: 'ubiquiti-unifi',
      kind: 'on_premises',
      base_url: 'https://10.20.30.40:11443/',
    });

    const missing = await a.agent.get(`/api/v1/orgs/${a.orgId}/controllers/${id}/api-credential`);
    expect(missing.status).toBe(404);

    const noKey = await a.agent
      .post(`/api/v1/orgs/${a.orgId}/controllers/${id}/api-credential`)
      .set(BROWSER)
      .send({
        api_kind: 'unifi-network',
        base_url: 'https://10.20.30.40/',
        secret: FAKE_API_SECRET,
      });
    expect(noKey.status).toBe(428);

    const set = await setCredential(a.agent, a.orgId, id, {
      api_kind: 'unifi-network',
      base_url: 'https://10.20.30.40:11443/proxy/network/integration',
      secret: FAKE_API_SECRET,
      external_site_id: 'default',
    });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    expect(set.body).toMatchObject({
      controller_id: id,
      api_kind: 'unifi-network',
      has_secret: true,
      username: null,
      external_site_id: 'default',
    });
    const text = JSON.stringify(set.body);
    expect(text).not.toContain(FAKE_API_SECRET);
    expect(text).not.toContain('enc:v1');
    expect(text).not.toContain('secret_ref');

    const stored = await deps.dbPlatform
      .selectFrom('vendor_api_credentials')
      .select(['secret_ref', 'rotated_at'])
      .where('controller_id', '=', id)
      .executeTakeFirstOrThrow();
    expect(stored.secret_ref).toMatch(/^enc:v1\./);
    expect(stored.secret_ref).not.toContain(FAKE_API_SECRET);
    // sealed with the vendor-API purpose: opens with it, not with the controller purpose
    expect(
      openSecretRef(
        new Envelope(deps.config.dataEncryptionKey, VENDOR_API_SECRET_PURPOSE),
        stored.secret_ref,
      ),
    ).toBe(FAKE_API_SECRET);
    expect(() =>
      openSecretRef(
        new Envelope(deps.config.dataEncryptionKey, 'ecloud:controller:credential:v1'),
        stored.secret_ref,
      ),
    ).toThrow();

    const read = await a.agent.get(`/api/v1/orgs/${a.orgId}/controllers/${id}/api-credential`);
    expect(read.status).toBe(200);
    expect(JSON.stringify(read.body)).not.toContain(FAKE_API_SECRET);

    // rotate: new seal, new rotation time
    const rotated = await setCredential(a.agent, a.orgId, id, {
      api_kind: 'unifi-network',
      base_url: 'https://10.20.30.40:11443/proxy/network/integration',
      secret: `${FAKE_API_SECRET}-2`,
    });
    expect(rotated.status).toBe(200);
    const restored = await deps.dbPlatform
      .selectFrom('vendor_api_credentials')
      .select(['secret_ref'])
      .where('controller_id', '=', id)
      .executeTakeFirstOrThrow();
    expect(restored.secret_ref).not.toBe(stored.secret_ref);

    const audit = await sql<{ after: unknown }>`
      SELECT after FROM audit_logs
       WHERE action = 'controller:secret:rotate' AND target_id = ${id} ORDER BY id
    `.execute(deps.dbPlatform);
    expect(audit.rows).toHaveLength(2);
    const auditText = JSON.stringify(audit.rows);
    expect(auditText).not.toContain(FAKE_API_SECRET);
    expect(auditText).not.toContain('enc:v1');
    expect(auditText).toContain('"api_credential":"set"');
    expect(auditText).toContain('"api_credential":"rotated"');

    // delete
    const del = await a.agent
      .delete(`/api/v1/orgs/${a.orgId}/controllers/${id}/api-credential`)
      .set(BROWSER);
    expect(del.status).toBe(204);
    expect(
      (await a.agent.get(`/api/v1/orgs/${a.orgId}/controllers/${id}/api-credential`)).status,
    ).toBe(404);
  });

  it('vendor API credential: SSRF guard, vendor/kind match, username rules, cross-tenant', async () => {
    const apps = freshApps();
    const a = await orgAdmin(apps);
    const onPrem = await controller(a.agent, a.orgId, {
      vendor_key: 'tplink-omada',
      kind: 'on_premises',
      base_url: 'https://192.168.10.5:8043/',
    });
    const cloud = await controller(a.agent, a.orgId, {
      vendor_key: 'juniper-mist',
      kind: 'cloud',
      base_url: 'https://api.mist.example.com/',
    });

    for (const base_url of [
      'https://127.0.0.1/',
      'https://169.254.169.254/latest/',
      'https://localhost./',
      'https://[::1]/',
      'https://[::ffff:127.0.0.1]/',
      'https://[::127.0.0.1]/',
      'https://[fe80::1]/',
      'http://192.168.10.5:8088/',
      'https://user:pw@192.168.10.5/',
      'https://192.168.10.5/#frag',
    ]) {
      const res = await setCredential(a.agent, a.orgId, onPrem, {
        api_kind: 'omada-controller',
        base_url,
        username: 'operator',
        secret: FAKE_API_SECRET,
      });
      expect(res.status, base_url).toBe(400);
    }
    // a cloud controller must name a public host
    const privateCloud = await setCredential(a.agent, a.orgId, cloud, {
      api_kind: 'mist',
      base_url: 'https://10.1.1.1/',
      secret: FAKE_API_SECRET,
    });
    expect(privateCloud.status).toBe(400);
    // kind must match the controller vendor
    const wrongVendor = await setCredential(a.agent, a.orgId, onPrem, {
      api_kind: 'unifi-network',
      base_url: 'https://192.168.10.5:8043/',
      secret: FAKE_API_SECRET,
    });
    expect(wrongVendor.status).toBe(400);
    // Omada needs the operator name
    const noUser = await setCredential(a.agent, a.orgId, onPrem, {
      api_kind: 'omada-controller',
      base_url: 'https://192.168.10.5:8043/',
      secret: FAKE_API_SECRET,
    });
    expect(noUser.status).toBe(400);
    const bad = await setCredential(a.agent, a.orgId, onPrem, {
      api_kind: 'omada-controller',
      base_url: 'https://192.168.10.5:8043/',
      username: 'operator',
      secret: FAKE_API_SECRET,
      external_org_id: 'bad id with spaces',
    });
    expect(bad.status).toBe(400);
    const ok = await setCredential(a.agent, a.orgId, onPrem, {
      api_kind: 'omada-controller',
      base_url: 'https://192.168.10.5:8043/',
      username: 'operator',
      secret: FAKE_API_SECRET,
      external_org_id: 'a1b2c3d4e5f6',
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.username).toBe('operator');

    // changing the controller's vendor while the credential exists is refused
    const vendorChange = await a.agent
      .patch(`/api/v1/orgs/${a.orgId}/controllers/${onPrem}`)
      .set(BROWSER)
      .send({ vendor_key: 'ubiquiti-unifi' });
    expect(vendorChange.status).toBe(409);
    // ...and so is a kind change that the stored URL does not satisfy (private URL -> cloud)
    const kindChange = await a.agent
      .patch(`/api/v1/orgs/${a.orgId}/controllers/${onPrem}`)
      .set(BROWSER)
      .send({ kind: 'cloud', base_url: 'https://omada.example.com/' });
    expect(kindChange.status).toBe(409);

    // another organization sees nothing and cannot write
    const b = await orgAdmin(apps);
    const peek = await b.agent.get(`/api/v1/orgs/${a.orgId}/controllers/${onPrem}/api-credential`);
    expect([403, 404]).toContain(peek.status);
    const own = await b.agent.get(`/api/v1/orgs/${b.orgId}/controllers/${onPrem}/api-credential`);
    expect(own.status).toBe(404);
    const write = await setCredential(b.agent, b.orgId, onPrem, {
      api_kind: 'omada-controller',
      base_url: 'https://192.168.10.5:8043/',
      username: 'x',
      secret: 'x',
    });
    expect(write.status).toBe(404);

    // deleting the controller removes its credential
    const delCtrl = await a.agent
      .delete(`/api/v1/orgs/${a.orgId}/controllers/${onPrem}`)
      .set(BROWSER);
    expect(delCtrl.status).toBe(204);
    const left = await deps.dbPlatform
      .selectFrom('vendor_api_credentials')
      .select('id')
      .where('controller_id', '=', onPrem)
      .execute();
    expect(left).toEqual([]);
  });

  it('vendor API credential: refused while impersonating (D-027)', async () => {
    const apps = freshApps();
    const a = await orgAdmin(apps);
    const id = await controller(a.agent, a.orgId, {
      vendor_key: 'ruckus',
      kind: 'on_premises',
      base_url: 'https://10.9.9.9:8443/',
    });
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
      .send({ organizationId: a.orgId, reason: 'vendor credential ticket', ttlMinutes: 15 });
    expect(start.status).toBe(201);
    const res = await setCredential(agent, a.orgId, id, {
      api_kind: 'ruckus-nbi',
      base_url: 'https://10.9.9.9:8443/',
      secret: 'impersonator-value',
    });
    expect(res.status).toBe(403);
    expect(res.body.type).toBe('urn:ecloud:problem:impersonation-forbidden');
    const del = await agent
      .delete(`/api/v1/orgs/${a.orgId}/controllers/${id}/api-credential`)
      .set(BROWSER);
    expect(del.status).toBe(403);
    await agent.delete('/api/v1/platform/support/impersonate').set(BROWSER);
  });

  // ------------------------------------------------------------------- AAA: generic 802.1X / MAB

  async function aaaFixture(apps: Apps, adapterKey = 'generic-radius-8021x') {
    const a = await orgAdmin(apps);
    const nas = await createNas(a.agent, a.orgId, a.siteId, adapterKey);
    const policy = await a.agent.post(`/api/v1/orgs/${a.orgId}/policies`).set(BROWSER).send({
      name: 'Site default',
      scope_type: 'site',
      status: 'active',
      session_timeout_s: 3600,
      vlan_id: 42,
    });
    expect(policy.status).toBe(201);
    const assign = await a.agent
      .post(`/api/v1/orgs/${a.orgId}/policy-assignments`)
      .set(BROWSER)
      .send({ policy_id: policy.body.id, target_type: 'site', target_id: a.siteId });
    expect(assign.status).toBe(201);
    return { ...a, nas };
  }

  function authorize(apps: Apps, body: unknown) {
    return request(apps.internalApp)
      .post('/internal/aaa/authorize')
      .set('X-Internal-Token', TEST_INTERNAL_TOKEN)
      .send(body as object);
  }

  it('MAC auth on the generic adapter: User-Name = Calling-Station-Id MAC, no Call-Check needed', async () => {
    const apps = freshApps();
    const f = await aaaFixture(apps);
    const mac = randomMac();
    const device = await f.agent
      .post(`/api/v1/orgs/${f.orgId}/client-devices`)
      .set(BROWSER)
      .send({ mac: mac.canonical, mac_auth_enabled: true });
    expect(device.status).toBe(201);

    const ok = await authorize(
      apps,
      radius({
        'User-Name': mac.canonical.replace(/:/g, ''),
        'User-Password': mac.canonical.replace(/:/g, ''),
        'Calling-Station-Id': mac.dashed,
        'ECLOUD-Packet-Src-IP-Address': f.nas.ip,
      }),
    );
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body['control:Auth-Type']).toBeDefined();
    const session = await deps.dbPlatform
      .selectFrom('sessions')
      .select(['client_device_id', 'mac'])
      .where('organization_id', '=', f.orgId)
      .executeTakeFirstOrThrow();
    expect(session).toEqual({ client_device_id: device.body.id, mac: mac.canonical });
    const translation = await deps.dbPlatform
      .selectFrom('policy_translations')
      .select(['adapter_type_key', 'unsupported'])
      .where('organization_id', '=', f.orgId)
      .executeTakeFirstOrThrow();
    expect(translation.adapter_type_key).toBe('generic-radius-8021x');
    // VLAN / Session-Timeout are REQUIRES_DEVICE_TEST: recorded as not device-enforced
    expect(JSON.stringify(translation.unsupported)).toContain('vlan_id');

    // a MAC user name for ANOTHER station is not MAC auth (falls through) and is rejected
    const other = randomMac();
    const spoof = await authorize(
      apps,
      radius({
        'User-Name': mac.canonical,
        'User-Password': mac.canonical,
        'Calling-Station-Id': other.dashed,
        'ECLOUD-Packet-Src-IP-Address': f.nas.ip,
      }),
    );
    expect(spoof.status).toBe(401);
    // with Call-Check the mismatch is an explicit reject
    const callCheck = await authorize(
      apps,
      radius({
        'User-Name': mac.canonical,
        'Service-Type': 'Call-Check',
        'Calling-Station-Id': other.dashed,
        'ECLOUD-Packet-Src-IP-Address': f.nas.ip,
      }),
    );
    expect(callCheck.status).toBe(401);
    // L5: Call-Check without any strictly parsable MAC fails closed
    const garbage = await authorize(
      apps,
      radius({
        'User-Name': 'user-aabbccddee01x',
        'Service-Type': 'Call-Check',
        'Calling-Station-Id': 'not-a-mac',
        'ECLOUD-Packet-Src-IP-Address': f.nas.ip,
      }),
    );
    expect(garbage.status).toBe(401);
    // unknown device / MAC auth disabled -> reject
    const unknown = await authorize(
      apps,
      radius({
        'User-Name': other.canonical,
        'Calling-Station-Id': other.dashed,
        'ECLOUD-Packet-Src-IP-Address': f.nas.ip,
      }),
    );
    expect(unknown.status).toBe(401);
  });

  it('EAP inner identity: TTLS/PAP subscriber on the generic adapter; refused elsewhere', async () => {
    const apps = freshApps();
    const f = await aaaFixture(apps);
    const username = `eap-${newId().slice(-12)}`;
    const password = 'test-subscriber-pass-1';
    const user = await f.agent
      .post(`/api/v1/orgs/${f.orgId}/users`)
      .set(BROWSER)
      .send({ username, password, auth_methods: ['password'] });
    expect(user.status).toBe(201);
    const station = randomMac();

    const inner = (extra: Record<string, string | number> = {}) =>
      radius({
        'User-Name': username,
        'User-Password': password,
        'Calling-Station-Id': station.dashed,
        'ECLOUD-Packet-Src-IP-Address': f.nas.ip,
        'ECLOUD-EAP-Inner': 'ttls',
        'ECLOUD-Outer-User-Name': 'anonymous',
        ...extra,
      });

    const ok = await authorize(apps, inner());
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const session = await deps.dbPlatform
      .selectFrom('sessions')
      .select(['user_id', 'username_raw'])
      .where('organization_id', '=', f.orgId)
      .executeTakeFirstOrThrow();
    expect(session).toEqual({ user_id: user.body.id, username_raw: username });

    const wrong = await authorize(apps, inner({ 'User-Password': 'not-the-password' }));
    expect(wrong.status).toBe(401);

    // a portal broker credential never authenticates through EAP
    const pc = await authorize(apps, inner({ 'User-Name': 'pc-0123456789abcdef' }));
    expect(pc.status).toBe(401);

    // an inner identity that looks like the station MAC is NOT MAC auth
    const device = await f.agent
      .post(`/api/v1/orgs/${f.orgId}/client-devices`)
      .set(BROWSER)
      .send({ mac: station.canonical, mac_auth_enabled: true });
    expect(device.status).toBe(201);
    const macInner = await authorize(
      apps,
      inner({ 'User-Name': station.canonical, 'User-Password': station.canonical }),
    );
    expect(macInner.status).toBe(401);

    // a captive-portal NAS never accepts EAP inner identities
    const uspot = await aaaFixture(apps, 'openwifi-uspot-uam');
    const userB = `eap-${newId().slice(-12)}`;
    await uspot.agent
      .post(`/api/v1/orgs/${uspot.orgId}/users`)
      .set(BROWSER)
      .send({ username: userB, password, auth_methods: ['password'] });
    const refused = await authorize(
      apps,
      radius({
        'User-Name': userB,
        'User-Password': password,
        'Calling-Station-Id': station.dashed,
        'ECLOUD-Packet-Src-IP-Address': uspot.nas.ip,
        'ECLOUD-EAP-Inner': 'ttls',
      }),
    );
    expect(refused.status).toBe(401);
    // ...while the same login without the EAP marker is a normal PAP login there
    const pap = await authorize(
      apps,
      radius({
        'User-Name': userB,
        'User-Password': password,
        'Calling-Station-Id': randomMac().dashed,
        'ECLOUD-Packet-Src-IP-Address': uspot.nas.ip,
      }),
    );
    expect(pap.status).toBe(200);
  });
});
