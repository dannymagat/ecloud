/* eslint-disable @typescript-eslint/no-unsafe-member-access -- supertest response bodies are untyped JSON */
/**
 * Access Points page (D-045) against the test database:
 *  - RADIUS secret reveal: `nas:secret:reveal` (org_admin + platform_super_admin), a FRESH MFA code (required,
 *    wrong, replayed), per-administrator rate limit and lockout, audit without the value,
 *    refused while impersonating, cross-tenant, `Cache-Control: no-store`;
 *  - MikroTik installation script / login.html: no secret in the output, adapter check,
 *    attachment headers, tenant scope;
 *  - overview: setup progress from real data, vendor (chosen in the wizard or derived),
 *    unverified APs, PUBLIC_SUPPORT_EMAIL.
 * Skipped without the dev stack (ECLOUD_TEST_DATABASE_URL).
 */
import { describeIntegration, migrateTestDatabase } from '@ecloud/testing';
import { newId } from '@ecloud/shared';
import { generate } from 'otplib';
import request from 'supertest';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createApp } from './app.js';
import type { AppDeps } from './context.js';
import { MemoryKv } from './kv.js';
import {
  TEST_ORIGIN,
  closeDeps,
  countAudit,
  createAdmin,
  createTenant,
  integrationDeps,
  type AdminFixture,
} from './test-support/deps.js';

type Agent = ReturnType<typeof request.agent>;
type Apps = ReturnType<typeof createApp>;

const BROWSER = { Origin: TEST_ORIGIN, 'X-Requested-With': 'XMLHttpRequest' };
// RFC 5737 documentation address: a test value, not a deployment address.
const RADIUS_ADDRESS = '192.0.2.53';
const PORTAL_ORIGIN = 'https://portal.example.test';
const SUPPORT = 'support@example.test';

function randomIp(): string {
  const b = () => Math.floor(Math.random() * 250) + 2;
  return `10.${String(b())}.${String(b())}.${String(b())}`;
}

function randomMac(): string {
  const bytes = [0x02, ...Array.from({ length: 5 }, () => Math.floor(Math.random() * 256))];
  return bytes.map((b) => b.toString(16).padStart(2, '0')).join(':');
}

await describeIntegration('@ecloud/api Access Points page (D-045)', () => {
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
        supportEmail: SUPPORT,
        setupGuide: { ...base.config.setupGuide, radiusAddress: RADIUS_ADDRESS },
        base: {
          ...base.config.base,
          origins: { ...base.config.base.origins, portal: PORTAL_ORIGIN },
        },
      },
    };
    apps = createApp(deps);
  }, 60_000);

  afterAll(async () => {
    await closeDeps(base);
  });

  async function login(admin: AdminFixture, app: Apps = apps): Promise<Agent> {
    const agent = request.agent(app.publicApp);
    const res = await agent
      .post('/api/v1/auth/login')
      .set(BROWSER)
      .send({ email: admin.email, password: admin.password });
    expect(res.status).toBe(200);
    return agent;
  }

  /** Enrols + confirms TOTP on the session; returns the TOTP secret. */
  async function enrolMfa(agent: Agent): Promise<string> {
    const enrol = await agent.post('/api/v1/auth/mfa/enrol').set(BROWSER);
    expect(enrol.status).toBe(201);
    const secret = enrol.body.secret as string;
    const confirm = await agent
      .post('/api/v1/auth/mfa/confirm')
      .set(BROWSER)
      .send({ code: await generate({ secret }) });
    expect(confirm.status).toBe(200);
    return secret;
  }

  /** A valid code of the step `offset` steps from now (the ±1 step window accepts -1, 0, +1). */
  function code(secret: string, offset = 0): Promise<string> {
    return generate({ secret, epoch: Math.floor(Date.now() / 1000) + offset * 30 });
  }

  async function orgAdmin(withMfa = true) {
    const tenant = await createTenant(deps.dbPlatform);
    const admin = await createAdmin(deps.dbPlatform, [
      { template: 'org_admin', scope: 'organization', orgId: tenant.orgId },
    ]);
    const agent = await login(admin);
    const totp = withMfa ? await enrolMfa(agent) : null;
    return { ...tenant, admin, agent, totp };
  }

  async function createNas(
    agent: Agent,
    orgId: string,
    siteId: string,
    adapterKey = 'generic-radius-8021x',
    extra: Record<string, unknown> = {},
  ): Promise<{ id: string; secret: string; ip: string }> {
    const ip = randomIp();
    const res = await agent
      .post(`/api/v1/orgs/${orgId}/nas`)
      .set(BROWSER)
      .send({ site_id: siteId, name: `nas ${ip}`, nas_ip: ip, adapter_key: adapterKey, ...extra });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return { id: res.body.id as string, secret: res.body.secret as string, ip };
  }

  function mikrotik(agent: Agent, orgId: string, siteId: string) {
    return createNas(agent, orgId, siteId, 'mikrotik-hotspot', {
      hotspot_address: randomIp(),
      nas_identifier: `gw-${newId().slice(-12)}`,
    });
  }

  function reveal(agent: Agent, orgId: string, nasId: string, body: object) {
    return agent.post(`/api/v1/orgs/${orgId}/nas/${nasId}/secret/reveal`).set(BROWSER).send(body);
  }

  // ------------------------------------------------------------------------------- reveal

  it('reveal: org_admin with a fresh MFA code gets the secret, no-store, audited without it', async () => {
    const a = await orgAdmin();
    const nas = await createNas(a.agent, a.orgId, a.siteId);
    const res = await reveal(a.agent, a.orgId, nas.id, { code: await code(a.totp as string) });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ secret: nas.secret });
    expect(res.headers['cache-control']).toBe('no-store');
    expect(await countAudit(deps.dbPlatform, 'nas:secret:revealed', nas.id)).toBe(1);
    const rows = await deps.dbPlatform
      .selectFrom('audit_logs')
      .selectAll()
      .where('action', '=', 'nas:secret:revealed')
      .where('target_id', '=', nas.id)
      .execute();
    expect(rows[0]?.actor_id).toBe(a.admin.id);
    expect(JSON.stringify(rows)).not.toContain(nas.secret);
  });

  it('reveal: MFA code required, a wrong or replayed code is refused (403, no audit)', async () => {
    const a = await orgAdmin();
    const nas = await createNas(a.agent, a.orgId, a.siteId);
    const missing = await reveal(a.agent, a.orgId, nas.id, {});
    expect(missing.status).toBe(400);
    const malformed = await reveal(a.agent, a.orgId, nas.id, { code: '12345a' });
    expect(malformed.status).toBe(400);
    const good = await code(a.totp as string);
    const wrong = await reveal(a.agent, a.orgId, nas.id, {
      code: good === '000000' ? '111111' : '000000',
    });
    expect(wrong.status).toBe(403);
    expect(wrong.body.type).toBe('urn:ecloud:problem:mfa-code-invalid');
    expect(JSON.stringify(wrong.body)).not.toContain(nas.secret);
    const first = await reveal(a.agent, a.orgId, nas.id, { code: good });
    expect(first.status).toBe(200);
    const replay = await reveal(a.agent, a.orgId, nas.id, { code: good });
    expect(replay.status).toBe(403);
    expect(replay.body.type).toBe('urn:ecloud:problem:mfa-code-invalid');
    expect(await countAudit(deps.dbPlatform, 'nas:secret:revealed', nas.id)).toBe(1);
  });

  it('reveal: an administrator without MFA cannot reveal', async () => {
    const a = await orgAdmin(false);
    const nas = await createNas(a.agent, a.orgId, a.siteId);
    const res = await reveal(a.agent, a.orgId, nas.id, { code: '123456' });
    expect(res.status).toBe(403);
    expect(res.body.type).toBe('urn:ecloud:problem:mfa-enrolment-required');
  });

  it('reveal: wrong codes lock the reveal out (login lockout semantics), even for a valid code', async () => {
    const a = await orgAdmin();
    const nas = await createNas(a.agent, a.orgId, a.siteId);
    const valid = new Set([
      await code(a.totp as string, -1),
      await code(a.totp as string),
      await code(a.totp as string, 1),
    ]);
    const wrongCodes = [
      '000000',
      '111111',
      '222222',
      '333333',
      '444444',
      '555555',
      '666666',
    ].filter((c) => !valid.has(c));
    for (const c of wrongCodes.slice(0, 5)) {
      const res = await reveal(a.agent, a.orgId, nas.id, { code: c });
      expect(res.status).toBe(403);
    }
    const locked = await reveal(a.agent, a.orgId, nas.id, { code: await code(a.totp as string) });
    expect(locked.status).toBe(429);
    expect(locked.headers['retry-after']).toBeDefined();
    expect(await countAudit(deps.dbPlatform, 'nas:secret:revealed', nas.id)).toBe(0);
  });

  it('reveal: rate limited per administrator (10 per window, any outcome)', async () => {
    const a = await orgAdmin();
    const nas = await createNas(a.agent, a.orgId, a.siteId);
    const valid = [
      await code(a.totp as string, -1),
      await code(a.totp as string),
      await code(a.totp as string, 1),
    ];
    const wrong = ['000000', '111111', '222222', '333333', '444444', '555555', '666666'].find(
      (c) => !valid.includes(c),
    ) as string;
    // success, 4 failures, success (clears the failures: no lockout), 4 failures = 10 requests;
    // the 11th is over the per-administrator budget although its code is valid.
    const plan = [valid[0], wrong, wrong, wrong, wrong, valid[1], wrong, wrong, wrong, wrong];
    const statuses: number[] = [];
    for (const c of plan)
      statuses.push((await reveal(a.agent, a.orgId, nas.id, { code: c })).status);
    expect(statuses).toEqual([200, 403, 403, 403, 403, 200, 403, 403, 403, 403]);
    const over = await reveal(a.agent, a.orgId, nas.id, { code: valid[2] });
    expect(over.status).toBe(429);
    expect(over.body.secret).toBeUndefined();
    expect(await countAudit(deps.dbPlatform, 'nas:secret:revealed', nas.id)).toBe(2);
  });

  it('reveal: needs nas:secret:reveal (site_admin / operator with nas:read get 403)', async () => {
    const a = await orgAdmin();
    const nas = await createNas(a.agent, a.orgId, a.siteId);
    for (const template of ['site_admin', 'operator', 'read_only']) {
      const other = await createAdmin(deps.dbPlatform, [
        template === 'site_admin'
          ? { template, scope: 'site', orgId: a.orgId, siteId: a.siteId }
          : { template, scope: 'organization', orgId: a.orgId },
      ]);
      const agent = await login(other);
      const totp = await enrolMfa(agent);
      const res = await reveal(agent, a.orgId, nas.id, { code: await code(totp, 1) });
      expect(res.status, template).toBe(403);
      expect(res.body.secret).toBeUndefined();
    }
  });

  it('reveal: cross-tenant is refused (other org path 403, foreign NAS id 404)', async () => {
    const a = await orgAdmin();
    const b = await orgAdmin();
    const nasA = await createNas(a.agent, a.orgId, a.siteId);
    const viaOtherOrg = await reveal(b.agent, a.orgId, nasA.id, {
      code: await code(b.totp as string),
    });
    expect(viaOtherOrg.status).toBe(403);
    const foreignId = await reveal(b.agent, b.orgId, nasA.id, {
      code: await code(b.totp as string, 1),
    });
    expect(foreignId.status).toBe(404);
    expect(JSON.stringify(foreignId.body)).not.toContain(nasA.secret);
    expect(await countAudit(deps.dbPlatform, 'nas:secret:revealed', nasA.id)).toBe(0);
  });

  it('reveal: refused while impersonating (even with the org_admin permission set)', async () => {
    const a = await orgAdmin();
    const nas = await createNas(a.agent, a.orgId, a.siteId);
    const support = await createAdmin(deps.dbPlatform, [
      { template: 'platform_support', scope: 'platform' },
    ]);
    const agent = await login(support);
    const totp = await enrolMfa(agent);
    const start = await agent
      .post('/api/v1/platform/support/impersonate')
      .set(BROWSER)
      .send({ organizationId: a.orgId, reason: 'radius secret ticket', ttlMinutes: 15 });
    expect(start.status).toBe(201);
    const res = await reveal(agent, a.orgId, nas.id, { code: await code(totp, 1) });
    expect(res.status).toBe(403);
    expect(res.body.type).toBe('urn:ecloud:problem:impersonation-forbidden');
    await agent.delete('/api/v1/platform/support/impersonate').set(BROWSER);
    expect(await countAudit(deps.dbPlatform, 'nas:secret:revealed', nas.id)).toBe(0);
  });

  it('reveal: platform_super_admin may reveal outside impersonation, is refused while impersonating', async () => {
    const a = await orgAdmin();
    const nas = await createNas(a.agent, a.orgId, a.siteId);
    const root = await createAdmin(deps.dbPlatform, [
      { template: 'platform_super_admin', scope: 'platform' },
    ]);
    const agent = await login(root);
    const totp = await enrolMfa(agent);
    const ok = await reveal(agent, a.orgId, nas.id, { code: await code(totp, 1) });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.secret).toBe(nas.secret);
    expect(ok.headers['cache-control']).toContain('no-store');
    expect(await countAudit(deps.dbPlatform, 'nas:secret:revealed', nas.id)).toBe(1);
    const start = await agent
      .post('/api/v1/platform/support/impersonate')
      .set(BROWSER)
      .send({ organizationId: a.orgId, reason: 'radius secret ticket', ttlMinutes: 15 });
    expect(start.status).toBe(201);
    const refused = await reveal(agent, a.orgId, nas.id, { code: await code(totp, -1) });
    expect(refused.status).toBe(403);
    expect(refused.body.type).toBe('urn:ecloud:problem:impersonation-forbidden');
    expect(refused.body.secret).toBeUndefined();
    await agent.delete('/api/v1/platform/support/impersonate').set(BROWSER);
    expect(await countAudit(deps.dbPlatform, 'nas:secret:revealed', nas.id)).toBe(1);
  });

  // ------------------------------------------------------------------------ MikroTik script

  it('mikrotik script: RouterOS text download, never the secret', async () => {
    const a = await orgAdmin(false);
    const nas = await mikrotik(a.agent, a.orgId, a.siteId);
    const res = await a.agent.get(`/api/v1/orgs/${a.orgId}/nas/${nas.id}/mikrotik-script`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/plain/);
    expect(res.headers['content-disposition']).toMatch(
      /^attachment; filename="ecloud-mikrotik-[a-z0-9-]+\.rsc"$/,
    );
    expect(res.headers['cache-control']).toBe('no-store');
    const text = res.text;
    expect(text).not.toContain(nas.secret);
    expect(text).toContain('PASTE_RADIUS_SECRET_HERE');
    expect(text).toContain(`:local radiusAddress "${RADIUS_ADDRESS}"`);
    expect(text).toContain(`src-address=${nas.ip}`);
    expect(text).toContain('/radius incoming set accept=yes port=1700');
    expect(text).toContain('use-radius=yes');
    expect(text).toContain('/ip hotspot walled-garden add dst-host="portal.example.test"');
  });

  it('mikrotik script / login.html: mikrotik-hotspot only; nas:read is enough; tenant scoped', async () => {
    const a = await orgAdmin(false);
    const generic = await createNas(a.agent, a.orgId, a.siteId);
    const notMikrotik = await a.agent.get(
      `/api/v1/orgs/${a.orgId}/nas/${generic.id}/mikrotik-script`,
    );
    expect(notMikrotik.status).toBe(422);
    expect(notMikrotik.body.type).toBe('urn:ecloud:problem:adapter-mismatch');
    const nas = await mikrotik(a.agent, a.orgId, a.siteId);
    const operator = await createAdmin(deps.dbPlatform, [
      { template: 'read_only', scope: 'organization', orgId: a.orgId },
    ]);
    const ro = await login(operator);
    expect((await ro.get(`/api/v1/orgs/${a.orgId}/nas/${nas.id}/mikrotik-script`)).status).toBe(
      200,
    );
    const html = await ro.get(`/api/v1/orgs/${a.orgId}/nas/${nas.id}/mikrotik-login-html`);
    expect(html.status).toBe(200);
    expect(html.headers['content-disposition']).toBe('attachment; filename="login.html"');
    expect(html.text).toContain(`${PORTAL_ORIGIN}/hotspot/mikrotik/?`);
    expect(html.text).not.toContain(nas.secret);
    expect(html.text).not.toMatch(/<script/i);
    const b = await orgAdmin(false);
    expect(
      (await b.agent.get(`/api/v1/orgs/${a.orgId}/nas/${nas.id}/mikrotik-script`)).status,
    ).toBe(403);
    expect(
      (await b.agent.get(`/api/v1/orgs/${b.orgId}/nas/${nas.id}/mikrotik-script`)).status,
    ).toBe(404);
  });

  it('login.html needs an https portal origin', async () => {
    const httpApps = createApp({ ...deps, config: { ...deps.config, base: base.config.base } });
    const tenant = await createTenant(deps.dbPlatform);
    const admin = await createAdmin(deps.dbPlatform, [
      { template: 'org_admin', scope: 'organization', orgId: tenant.orgId },
    ]);
    const agent = await login(admin, httpApps);
    const nas = await mikrotik(agent, tenant.orgId, tenant.siteId);
    const res = await agent.get(`/api/v1/orgs/${tenant.orgId}/nas/${nas.id}/mikrotik-login-html`);
    expect(res.status).toBe(409);
    expect(res.body.type).toBe('urn:ecloud:problem:portal-origin-not-https');
  });

  // ------------------------------------------------------------------------------ overview

  it('overview: progress from real data, vendor, unverified APs, support e-mail', async () => {
    const a = await orgAdmin(false);
    const url = `/api/v1/orgs/${a.orgId}/access-points/overview`;
    const empty = await a.agent.get(url);
    expect(empty.status).toBe(200);
    expect(empty.body.progress).toMatchObject({ completed: 0, total: 5 });
    expect(empty.body.support_email).toBe(SUPPORT);
    expect(empty.body.access_points).toEqual([]);

    const nas = await createNas(a.agent, a.orgId, a.siteId, 'coovachilli-uam', {
      vendor_key: 'teltonika',
    });
    let res = await a.agent.get(url);
    expect(res.body.progress.completed).toBe(2);
    expect(res.body.nas[0]).toMatchObject({
      id: nas.id,
      vendor_key: 'teltonika',
      vendor_name: 'Teltonika',
      has_secret: true,
      activity: 'never',
      access_points: 0,
    });
    expect(JSON.stringify(res.body)).not.toContain(nas.secret);

    const mac = randomMac();
    const ap = await a.agent
      .post(`/api/v1/orgs/${a.orgId}/access-points`)
      .set(BROWSER)
      .send({ nas_client_id: nas.id, mac, name: 'Lobby AP' });
    expect(ap.status).toBe(201);
    res = await a.agent.get(url);
    expect(res.body.progress.completed).toBe(3);
    expect(res.body.access_points).toEqual([
      expect.objectContaining({
        mac,
        name: 'Lobby AP',
        nas_client_id: nas.id,
        vendor_key: 'teltonika',
        verified: false,
        activity: 'never',
      }),
    ]);

    const event = (result: 'accept' | 'reject') => ({
      organization_id: a.orgId,
      nas_client_id: nas.id,
      nas_ip: nas.ip,
      username: 'guest',
      result,
      created_at: new Date(),
    });
    await deps.dbPlatform.insertInto('auth_events').values(event('reject')).execute();
    res = await a.agent.get(url);
    expect(res.body.progress.completed).toBe(4);
    expect((res.body.progress.steps as unknown[]).at(-1)).toMatchObject({
      key: 'guest_login',
      done: false,
    });
    expect(res.body.access_points[0].activity).toBe('active');
    await deps.dbPlatform.insertInto('auth_events').values(event('accept')).execute();
    res = await a.agent.get(url);
    expect(res.body.progress.completed).toBe(5);

    // another organization sees none of it
    const b = await orgAdmin(false);
    const other = await b.agent.get(`/api/v1/orgs/${b.orgId}/access-points/overview`);
    expect(other.body.progress.completed).toBe(0);
    expect((await b.agent.get(url)).status).toBe(403);
  });

  it('overview: no support e-mail configured → null', async () => {
    const plain = createApp({ ...deps, config: { ...deps.config, supportEmail: null } });
    const tenant = await createTenant(deps.dbPlatform);
    const admin = await createAdmin(deps.dbPlatform, [
      { template: 'read_only', scope: 'organization', orgId: tenant.orgId },
    ]);
    const agent = await login(admin, plain);
    const res = await agent.get(`/api/v1/orgs/${tenant.orgId}/access-points/overview`);
    expect(res.status).toBe(200);
    expect(res.body.support_email).toBeNull();
  });

  it('vendor_key: must be a gallery vendor of the NAS adapter; dropped on an adapter change', async () => {
    const a = await orgAdmin(false);
    const bad = await a.agent.post(`/api/v1/orgs/${a.orgId}/nas`).set(BROWSER).send({
      site_id: a.siteId,
      name: 'x',
      nas_ip: randomIp(),
      adapter_key: 'generic-radius-8021x',
      vendor_key: 'mikrotik',
    });
    expect(bad.status).toBe(400);
    const unknown = await a.agent.post(`/api/v1/orgs/${a.orgId}/nas`).set(BROWSER).send({
      site_id: a.siteId,
      name: 'y',
      nas_ip: randomIp(),
      adapter_key: 'generic-radius-8021x',
      vendor_key: 'no-such-vendor',
    });
    expect(unknown.status).toBe(400);
    const nas = await createNas(a.agent, a.orgId, a.siteId, 'coovachilli-uam', {
      vendor_key: 'teltonika',
    });
    const patch = await a.agent
      .patch(`/api/v1/orgs/${a.orgId}/nas/${nas.id}`)
      .set(BROWSER)
      .send({ adapter_key: 'generic-radius-8021x' });
    expect(patch.status, JSON.stringify(patch.body)).toBe(200);
    expect(patch.body.vendor_key).toBeNull();
  });
});
