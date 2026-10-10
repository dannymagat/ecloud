/* eslint-disable @typescript-eslint/no-unsafe-member-access -- supertest response bodies are untyped JSON */
/**
 * D-046: ADMIN_MFA_MODE=off (the platform default) against the test database. The rest of the
 * API suites run with ADMIN_MFA_MODE=required (testConfig), which proves the former behaviour is
 * unchanged; this file proves the off behaviour:
 *  - password-only login returns a full session (no mfa_required / enrolment), stored TOTP
 *    enrolments are ignored, platform bindings hold their permissions at once;
 *  - the MFA endpoints answer 409 `mfa-disabled`;
 *  - the NAS secret reveal needs no code (one POST) but keeps permission, site scope,
 *    impersonation refusal, audit without the value, no-store and per-administrator / per-NAS
 *    rate limits.
 */
import { describeIntegration, migrateTestDatabase } from '@ecloud/testing';
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
const BROWSER = { Origin: TEST_ORIGIN, 'X-Requested-With': 'XMLHttpRequest' };

function randomIp(): string {
  const b = () => Math.floor(Math.random() * 250) + 2;
  return `10.${String(b())}.${String(b())}.${String(b())}`;
}

await describeIntegration('@ecloud/api ADMIN_MFA_MODE=off (D-046)', () => {
  let base: AppDeps;
  let off: ReturnType<typeof createApp>;
  let required: ReturnType<typeof createApp>;

  beforeAll(async () => {
    await migrateTestDatabase();
    base = integrationDeps();
    const make = (mode: 'off' | 'required') =>
      createApp({
        ...base,
        kv: new MemoryKv(),
        config: { ...base.config, adminMfaMode: mode },
      });
    off = make('off');
    required = make('required');
  }, 60_000);

  afterAll(async () => {
    await closeDeps(base);
  });

  async function login(admin: AdminFixture, app = off) {
    const agent = request.agent(app.publicApp);
    const res = await agent
      .post('/api/v1/auth/login')
      .set(BROWSER)
      .send({ email: admin.email, password: admin.password });
    return { agent, res };
  }

  async function orgAdmin() {
    const tenant = await createTenant(base.dbPlatform);
    const admin = await createAdmin(base.dbPlatform, [
      { template: 'org_admin', scope: 'organization', orgId: tenant.orgId },
    ]);
    const { agent, res } = await login(admin);
    expect(res.status).toBe(200);
    return { ...tenant, admin, agent };
  }

  async function createNas(agent: Agent, orgId: string, siteId: string) {
    const ip = randomIp();
    const res = await agent
      .post(`/api/v1/orgs/${orgId}/nas`)
      .set(BROWSER)
      .send({
        site_id: siteId,
        name: `nas ${ip}`,
        nas_ip: ip,
        adapter_key: 'generic-radius-8021x',
      });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return { id: res.body.id as string, secret: res.body.secret as string };
  }

  const reveal = (agent: Agent, orgId: string, nasId: string, body: object = {}) =>
    agent.post(`/api/v1/orgs/${orgId}/nas/${nasId}/secret/reveal`).set(BROWSER).send(body);

  it('login is password-only: a full session, no MFA step, no enrolment, /me reports mode off', async () => {
    const root = await createAdmin(base.dbPlatform, [
      { template: 'platform_super_admin', scope: 'platform' },
    ]);
    const { agent, res } = await login(root);
    expect(res.status).toBe(200);
    expect(res.body.mfa_required).toBe(false);
    expect(res.body.mfa_token).toBeUndefined();
    expect(res.body.mfa_enrolment_required).toBe(false);
    const me = await agent.get('/api/v1/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.mfa).toMatchObject({ mode: 'off', required: false, pending: false });
    // a platform binding holds its permissions without any MFA proof
    expect(JSON.stringify(me.body.permissions_by_scope)).toContain('nas:secret:reveal');
    const orgs = await agent.get('/api/v1/platform/organizations').set(BROWSER);
    expect(orgs.status).toBe(200);
  });

  it('a stored TOTP enrolment is ignored (kept, not deleted); the MFA endpoints answer 409', async () => {
    const tenant = await createTenant(base.dbPlatform);
    const admin = await createAdmin(base.dbPlatform, [
      { template: 'org_admin', scope: 'organization', orgId: tenant.orgId },
    ]);
    // Enrol while MFA is required ...
    const first = await login(admin, required);
    expect(first.res.status).toBe(200);
    const enrol = await first.agent.post('/api/v1/auth/mfa/enrol').set(BROWSER);
    expect(enrol.status).toBe(201);
    const confirm = await first.agent
      .post('/api/v1/auth/mfa/confirm')
      .set(BROWSER)
      .send({ code: await generate({ secret: enrol.body.secret as string }) });
    expect(confirm.status).toBe(200);
    // ... then password-only login ignores it.
    const { agent, res } = await login(admin);
    expect(res.status).toBe(200);
    expect(res.body.mfa_required).toBe(false);
    const rows = await base.dbPlatform
      .selectFrom('mfa_credentials')
      .select('id')
      .where('administrator_id', '=', admin.id)
      .execute();
    expect(rows).toHaveLength(1);
    for (const [path, body] of [
      ['/api/v1/auth/mfa/enrol', {}],
      ['/api/v1/auth/mfa/confirm', { code: '123456' }],
      ['/api/v1/auth/mfa/verify', { mfa_token: 'x'.repeat(32), code: '123456' }],
    ] as const) {
      const r = await agent.post(path).set(BROWSER).send(body);
      expect(r.status, path).toBe(409);
      expect(r.body.type).toBe('urn:ecloud:problem:mfa-disabled');
    }
  });

  it('reveal: one POST without a code; no-store; audited without the value', async () => {
    const a = await orgAdmin();
    const nas = await createNas(a.agent, a.orgId, a.siteId);
    const res = await reveal(a.agent, a.orgId, nas.id);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.secret).toBe(nas.secret);
    expect(res.headers['cache-control']).toContain('no-store');
    expect(await countAudit(base.dbPlatform, 'nas:secret:revealed', nas.id)).toBe(1);
    const audit = await base.dbPlatform
      .selectFrom('audit_logs')
      .selectAll()
      .where('action', '=', 'nas:secret:revealed')
      .where('target_id', '=', nas.id)
      .execute();
    expect(JSON.stringify(audit)).not.toContain(nas.secret);
  });

  it('reveal: still needs the permission and the tenant', async () => {
    const a = await orgAdmin();
    const b = await orgAdmin();
    const nas = await createNas(a.agent, a.orgId, a.siteId);
    const reader = await createAdmin(base.dbPlatform, [
      { template: 'operator', scope: 'organization', orgId: a.orgId },
    ]);
    const asReader = await login(reader);
    expect((await reveal(asReader.agent, a.orgId, nas.id)).status).toBe(403);
    expect((await reveal(b.agent, a.orgId, nas.id)).status).toBe(403);
    expect((await reveal(b.agent, b.orgId, nas.id)).status).toBe(404);
    expect(await countAudit(base.dbPlatform, 'nas:secret:revealed', nas.id)).toBe(0);
  });

  it('reveal: refused while impersonating, even for the super admin', async () => {
    const a = await orgAdmin();
    const nas = await createNas(a.agent, a.orgId, a.siteId);
    const root = await createAdmin(base.dbPlatform, [
      { template: 'platform_super_admin', scope: 'platform' },
    ]);
    const { agent } = await login(root);
    expect((await reveal(agent, a.orgId, nas.id)).status).toBe(200);
    const start = await agent
      .post('/api/v1/platform/support/impersonate')
      .set(BROWSER)
      .send({ organizationId: a.orgId, reason: 'radius secret ticket', ttlMinutes: 15 });
    expect(start.status).toBe(201);
    const refused = await reveal(agent, a.orgId, nas.id);
    expect(refused.status).toBe(403);
    expect(refused.body.type).toBe('urn:ecloud:problem:impersonation-forbidden');
    expect(refused.body.secret).toBeUndefined();
    await agent.delete('/api/v1/platform/support/impersonate').set(BROWSER);
    expect(await countAudit(base.dbPlatform, 'nas:secret:revealed', nas.id)).toBe(1);
  });

  it('reveal: rate limited per administrator and per NAS', async () => {
    const a = await orgAdmin();
    const nas = await createNas(a.agent, a.orgId, a.siteId);
    let status = 200;
    for (let i = 0; i < 11 && status === 200; i += 1)
      status = (await reveal(a.agent, a.orgId, nas.id)).status;
    expect(status).toBe(429); // per administrator (10 per window)
    // per NAS: other administrators of the same organization share the NAS budget
    const helpers: { agent: Agent }[] = [];
    for (let i = 0; i < 3; i += 1) {
      const admin = await createAdmin(base.dbPlatform, [
        { template: 'org_admin', scope: 'organization', orgId: a.orgId },
      ]);
      helpers.push(await login(admin));
    }
    let nasLimited = false;
    for (let i = 0; i < 30 && !nasLimited; i += 1) {
      const h = helpers[i % 3];
      const r = await reveal((h as { agent: Agent }).agent, a.orgId, nas.id);
      if (r.status === 429) nasLimited = true;
    }
    expect(nasLimited).toBe(true);
  });
});
