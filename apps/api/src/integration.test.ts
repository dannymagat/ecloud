/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument -- supertest response bodies are untyped JSON */
/**
 * Integration tests against the dev-stack `ecloud_test` database (RLS app role + platform role).
 * Skipped with a message when ECLOUD_TEST_DATABASE_URL is unset / unreachable.
 * Each test builds its own organizations, so the suite never truncates shared tables.
 */
import { describeIntegration, migrateTestDatabase } from '@ecloud/testing';
import { newId } from '@ecloud/shared';
import { generate } from 'otplib';
import { MemoryKv } from './kv.js';
import request from 'supertest';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createApp } from './app.js';
import type { AppDeps } from './context.js';
import {
  TEST_INTERNAL_TOKEN,
  TEST_ORIGIN,
  closeDeps,
  countAudit,
  createAdmin,
  createTenant,
  integrationDeps,
  templateRoleId,
  unique,
  type AdminFixture,
} from './test-support/deps.js';

type Agent = ReturnType<typeof request.agent>;

const BROWSER = { Origin: TEST_ORIGIN, 'X-Requested-With': 'XMLHttpRequest' };

await describeIntegration('@ecloud/api against ecloud_test', () => {
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

  async function login(admin: AdminFixture, app = apps.publicApp): Promise<Agent> {
    const agent = request.agent(app);
    const res = await agent
      .post('/api/v1/auth/login')
      .set(BROWSER)
      .send({ email: admin.email, password: admin.password });
    expect(res.status).toBe(200);
    expect(res.body.mfa_required).toBe(false);
    return agent;
  }

  /** Enrols + confirms TOTP inside the agent's session, which makes it MFA-verified. */
  async function enrolMfa(agent: Agent): Promise<void> {
    const enrol = await agent.post('/api/v1/auth/mfa/enrol').set(BROWSER);
    expect(enrol.status).toBe(201);
    const confirm = await agent
      .post('/api/v1/auth/mfa/confirm')
      .set(BROWSER)
      .send({ code: await generate({ secret: enrol.body.secret as string }) });
    expect(confirm.status).toBe(200);
  }

  function randomIp(): string {
    const b = () => Math.floor(Math.random() * 250) + 2;
    return `10.${String(b())}.${String(b())}.${String(b())}`;
  }

  // ------------------------------------------------------------------------- authentication

  it('login sets an HttpOnly session cookie; /auth/me; logout revokes it', async () => {
    const { orgId } = await createTenant(deps.dbPlatform);
    const admin = await createAdmin(deps.dbPlatform, [
      { template: 'org_admin', scope: 'organization', orgId },
    ]);
    const agent = request.agent(apps.publicApp);
    const res = await agent
      .post('/api/v1/auth/login')
      .set(BROWSER)
      .send({ email: admin.email.toUpperCase(), password: admin.password });
    expect(res.status).toBe(200);
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toMatch(/ecloud_sid=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);

    const me = await agent.get('/api/v1/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.administrator.email).toBe(admin.email);
    const scopes = me.body.permissions_by_scope as {
      organization_id: string;
      permissions: string[];
    }[];
    expect(scopes[0]?.organization_id).toBe(orgId);
    expect(scopes[0]?.permissions).toContain('site:create');
    expect(scopes[0]?.permissions).not.toContain('tenant:list');

    const out = await agent.post('/api/v1/auth/logout').set(BROWSER);
    expect(out.status).toBe(204);
    expect((await agent.get('/api/v1/auth/me')).status).toBe(401);
    expect(await countAudit(deps.dbPlatform, 'auth:login', admin.id)).toBe(1);
  });

  it('wrong password is a generic 401 and repeated failures lock the account', async () => {
    const admin = await createAdmin(deps.dbPlatform, []);
    const bad = await request(apps.publicApp)
      .post('/api/v1/auth/login')
      .set(BROWSER)
      .send({ email: admin.email, password: 'definitely wrong' });
    expect(bad.status).toBe(401);
    const unknown = await request(apps.publicApp)
      .post('/api/v1/auth/login')
      .set(BROWSER)
      .send({ email: 'nobody-here@example.test', password: 'definitely wrong' });
    expect(unknown.status).toBe(401);
    expect(unknown.body.detail).toBe(bad.body.detail);
    for (let i = 0; i < 9; i += 1) {
      await request(apps.publicApp)
        .post('/api/v1/auth/login')
        .set(BROWSER)
        .send({ email: admin.email, password: 'definitely wrong' });
    }
    const locked = await request(apps.publicApp)
      .post('/api/v1/auth/login')
      .set(BROWSER)
      .send({ email: admin.email, password: admin.password });
    expect(locked.status).toBe(429);
    expect(locked.headers['retry-after']).toBeDefined();
  });

  it('TOTP enrol → confirm → login requires the code; recovery code works once', async () => {
    const admin = await createAdmin(deps.dbPlatform, []);
    const agent = await login(admin);
    const enrol = await agent.post('/api/v1/auth/mfa/enrol').set(BROWSER);
    expect(enrol.status).toBe(201);
    const secret = enrol.body.secret as string;
    const stored = await deps.dbPlatform
      .selectFrom('mfa_credentials')
      .select('secret_enc')
      .where('administrator_id', '=', admin.id)
      .executeTakeFirstOrThrow();
    expect(stored.secret_enc).not.toContain(secret);

    const wrong = await agent
      .post('/api/v1/auth/mfa/confirm')
      .set(BROWSER)
      .send({ code: '000000' });
    expect([200, 401]).toContain(wrong.status);
    const confirm =
      wrong.status === 200
        ? wrong
        : await agent
            .post('/api/v1/auth/mfa/confirm')
            .set(BROWSER)
            .send({ code: await generate({ secret }) });
    expect(confirm.status).toBe(200);
    const recovery = confirm.body.recovery_codes as string[];
    expect(recovery).toHaveLength(10);

    const step1 = await request(apps.publicApp)
      .post('/api/v1/auth/login')
      .set(BROWSER)
      .send({ email: admin.email, password: admin.password });
    expect(step1.status).toBe(200);
    expect(step1.body.mfa_required).toBe(true);
    expect(step1.headers['set-cookie']).toBeUndefined();
    const step2 = await request(apps.publicApp)
      .post('/api/v1/auth/mfa/verify')
      .set(BROWSER)
      .send({ mfa_token: step1.body.mfa_token, code: await generate({ secret }) });
    expect(step2.status).toBe(200);
    expect(String(step2.headers['set-cookie'])).toMatch(/ecloud_sid=/);

    const again = await request(apps.publicApp)
      .post('/api/v1/auth/login')
      .set(BROWSER)
      .send({ email: admin.email, password: admin.password });
    const viaRecovery = await request(apps.publicApp)
      .post('/api/v1/auth/mfa/verify')
      .set(BROWSER)
      .send({ mfa_token: again.body.mfa_token, recovery_code: recovery[0] });
    expect(viaRecovery.status).toBe(200);
    const third = await request(apps.publicApp)
      .post('/api/v1/auth/login')
      .set(BROWSER)
      .send({ email: admin.email, password: admin.password });
    const reused = await request(apps.publicApp)
      .post('/api/v1/auth/mfa/verify')
      .set(BROWSER)
      .send({ mfa_token: third.body.mfa_token, recovery_code: recovery[0] });
    expect(reused.status).toBe(401);
  });

  it('MFA is enforced for platform bindings and mfa_enforced accounts (SEC §6.2)', async () => {
    // own rate-limit store: this test logs in four times from the shared supertest address
    const app = createApp({ ...deps, kv: new MemoryKv() }).publicApp;
    const superAdmin = await createAdmin(deps.dbPlatform, [
      { template: 'platform_super_admin', scope: 'platform' },
    ]);
    const first = await request(app)
      .post('/api/v1/auth/login')
      .set(BROWSER)
      .send({ email: superAdmin.email, password: superAdmin.password });
    expect(first.status).toBe(200);
    expect(first.body.mfa_enrolment_required).toBe(true);
    const agent = await login(superAdmin, app);
    // password-only session: no permissions at all until a second factor is proved
    expect((await agent.get('/api/v1/platform/organizations')).status).toBe(403);
    const pending = await agent.get('/api/v1/auth/me');
    expect(pending.body.mfa).toMatchObject({ required: true, enrolled: false, pending: true });
    expect(pending.body.permissions_by_scope).toEqual([]);
    await enrolMfa(agent);
    expect((await agent.get('/api/v1/platform/organizations')).status).toBe(200);
    const verified = await agent.get('/api/v1/auth/me');
    expect(verified.body.mfa).toMatchObject({ required: true, enrolled: true, pending: false });

    // an organization admin with mfa_enforced is held the same way
    const { orgId } = await createTenant(deps.dbPlatform);
    const enforced = await createAdmin(deps.dbPlatform, [
      { template: 'org_admin', scope: 'organization', orgId },
    ]);
    await deps.dbPlatform
      .updateTable('administrators')
      .set({ mfa_enforced: true })
      .where('id', '=', enforced.id)
      .execute();
    const orgAgent = await login(enforced, app);
    expect((await orgAgent.get(`/api/v1/orgs/${orgId}/sites`)).status).toBe(403);
    await enrolMfa(orgAgent);
    expect((await orgAgent.get(`/api/v1/orgs/${orgId}/sites`)).status).toBe(200);

    // an org admin without mfa_enforced keeps working with a password-only session
    const plain = await createAdmin(deps.dbPlatform, [
      { template: 'org_admin', scope: 'organization', orgId },
    ]);
    expect((await (await login(plain, app)).get(`/api/v1/orgs/${orgId}/sites`)).status).toBe(200);
  });

  it('cookie-authenticated mutations require Origin + X-Requested-With (CSRF)', async () => {
    const { orgId } = await createTenant(deps.dbPlatform);
    const admin = await createAdmin(deps.dbPlatform, [
      { template: 'org_admin', scope: 'organization', orgId },
    ]);
    const agent = await login(admin);
    const noOrigin = await agent
      .post(`/api/v1/orgs/${orgId}/sites`)
      .send({ slug: 'x1', name: 'X' });
    expect(noOrigin.status).toBe(403);
    expect(noOrigin.body.type).toBe('urn:ecloud:problem:csrf');
    const ok = await agent
      .post(`/api/v1/orgs/${orgId}/sites`)
      .set(BROWSER)
      .send({ slug: 'x1', name: 'X', timezone: 'Europe/Berlin' });
    expect(ok.status).toBe(201);
  });

  // ---------------------------------------------------------------------- RBAC + tenancy

  it('RBAC: site admin is limited to its site; org admin cannot reach another tenant', async () => {
    const a = await createTenant(deps.dbPlatform);
    const b = await createTenant(deps.dbPlatform);
    const orgAdmin = await createAdmin(deps.dbPlatform, [
      { template: 'org_admin', scope: 'organization', orgId: a.orgId },
    ]);
    const siteAdmin = await createAdmin(deps.dbPlatform, [
      { template: 'site_admin', scope: 'site', orgId: a.orgId, siteId: a.siteId },
    ]);
    const oa = await login(orgAdmin);
    const sa = await login(siteAdmin);

    const u1 = await oa
      .post(`/api/v1/orgs/${a.orgId}/users`)
      .set(BROWSER)
      .send({ username: unique('u1'), password: 'pw-123456789', site_id: a.siteId });
    expect(u1.status).toBe(201);
    expect(u1.body.password_hash).toBeUndefined();
    const u2 = await oa
      .post(`/api/v1/orgs/${a.orgId}/users`)
      .set(BROWSER)
      .send({ username: unique('u2'), site_id: a.siteId2 });
    expect(u2.status).toBe(201);

    // site admin: create site needs organization scope → 403; list users filtered to its site
    expect(
      (await sa.post(`/api/v1/orgs/${a.orgId}/sites`).set(BROWSER).send({ slug: 'zz', name: 'Z' }))
        .status,
    ).toBe(403);
    const listed = await sa.get(`/api/v1/orgs/${a.orgId}/users`);
    expect(listed.status).toBe(200);
    const ids = (listed.body.data as { id: string }[]).map((r) => r.id);
    expect(ids).toContain(u1.body.id);
    expect(ids).not.toContain(u2.body.id);
    expect((await sa.get(`/api/v1/orgs/${a.orgId}/users/${u2.body.id as string}`)).status).toBe(
      404,
    );
    expect(
      (
        await sa
          .post(`/api/v1/orgs/${a.orgId}/users`)
          .set(BROWSER)
          .send({ username: unique('u3'), site_id: a.siteId2 })
      ).status,
    ).toBe(404);

    // org admin of A vs tenant B
    expect((await oa.get(`/api/v1/orgs/${b.orgId}/sites`)).status).toBe(403);
    // B's site id smuggled into A's request: RLS hides it → 404, nothing written
    const smuggled = await oa
      .post(`/api/v1/orgs/${a.orgId}/network-devices`)
      .set(BROWSER)
      .send({ site_id: b.siteId, serial: unique('SER') });
    expect(smuggled.status).toBe(404);
    const bUser = await deps.dbPlatform
      .insertInto('users')
      .values({ id: newId(), organization_id: b.orgId, username: unique('bu') })
      .returning('id')
      .executeTakeFirstOrThrow();
    expect((await oa.get(`/api/v1/orgs/${a.orgId}/users/${bUser.id}`)).status).toBe(404);
  });

  it('CRUD: If-Match, validation problems, soft delete, audit rows', async () => {
    const { orgId } = await createTenant(deps.dbPlatform);
    const admin = await createAdmin(deps.dbPlatform, [
      { template: 'org_admin', scope: 'organization', orgId },
    ]);
    const agent = await login(admin);
    const bad = await agent
      .post(`/api/v1/orgs/${orgId}/sites`)
      .set(BROWSER)
      .send({ slug: 'Bad Slug!', name: '', timezone: 'Mars/Base' });
    expect(bad.status).toBe(400);
    expect((bad.body.errors as { path: string }[]).map((e) => e.path)).toEqual(
      expect.arrayContaining(['body.slug', 'body.name', 'body.timezone']),
    );
    const created = await agent
      .post(`/api/v1/orgs/${orgId}/sites`)
      .set(BROWSER)
      .send({ slug: 'hq', name: 'HQ', timezone: 'Asia/Dubai' });
    expect(created.status).toBe(201);
    const id = created.body.id as string;
    const etag = created.headers.etag as string;
    const stale = await agent
      .patch(`/api/v1/orgs/${orgId}/sites/${id}`)
      .set(BROWSER)
      .set('If-Match', '"2000-01-01T00:00:00.000Z"')
      .send({ name: 'HQ 2' });
    expect(stale.status).toBe(412);
    const fresh = await agent
      .patch(`/api/v1/orgs/${orgId}/sites/${id}`)
      .set(BROWSER)
      .set('If-Match', etag)
      .send({ name: 'HQ 2' });
    expect(fresh.status).toBe(200);
    expect(fresh.body.name).toBe('HQ 2');
    expect((await agent.delete(`/api/v1/orgs/${orgId}/sites/${id}`).set(BROWSER)).status).toBe(204);
    expect((await agent.get(`/api/v1/orgs/${orgId}/sites/${id}`)).status).toBe(404);
    expect(await countAudit(deps.dbPlatform, 'site:create', id)).toBe(1);
    expect(await countAudit(deps.dbPlatform, 'site:update', id)).toBe(1);
    expect(await countAudit(deps.dbPlatform, 'site:delete', id)).toBe(1);

    const policyBad = await agent.post(`/api/v1/orgs/${orgId}/policies`).set(BROWSER).send({
      name: 'Expired',
      scope_type: 'site',
      status: 'active',
      valid_until: '2001-01-01T00:00:00Z',
    });
    expect(policyBad.status).toBe(400);
    const policy = await agent
      .post(`/api/v1/orgs/${orgId}/policies`)
      .set(BROWSER)
      .send({ name: 'Std', scope_type: 'site', status: 'active', download_rate_kbps: 10_000 });
    expect(policy.status).toBe(201);
    const bumped = await agent
      .patch(`/api/v1/orgs/${orgId}/policies/${policy.body.id as string}`)
      .set(BROWSER)
      .send({ download_rate_kbps: 20_000 });
    expect(bumped.status).toBe(200);
    expect(bumped.body.version).toBe(2);
    const renamed = await agent
      .patch(`/api/v1/orgs/${orgId}/policies/${policy.body.id as string}`)
      .set(BROWSER)
      .send({ description: 'no enforcement change' });
    expect(renamed.body.version).toBe(2);
  });

  it('Idempotency-Key replays voucher batch creation without re-revealing codes', async () => {
    const { orgId, siteId } = await createTenant(deps.dbPlatform);
    const admin = await createAdmin(deps.dbPlatform, [
      { template: 'org_admin', scope: 'organization', orgId },
    ]);
    const agent = await login(admin);
    const missing = await agent
      .post(`/api/v1/orgs/${orgId}/voucher-batches`)
      .set(BROWSER)
      .send({ name: 'b1', count: 3, site_id: siteId });
    expect(missing.status).toBe(428);
    const key = newId();
    const first = await agent
      .post(`/api/v1/orgs/${orgId}/voucher-batches`)
      .set(BROWSER)
      .set('Idempotency-Key', key)
      .send({ name: 'b1', count: 3, site_id: siteId });
    expect(first.status).toBe(201);
    expect(first.body.codes).toHaveLength(3);
    const replay = await agent
      .post(`/api/v1/orgs/${orgId}/voucher-batches`)
      .set(BROWSER)
      .set('Idempotency-Key', key)
      .send({ name: 'b1', count: 3, site_id: siteId });
    expect(replay.status).toBe(201);
    expect(replay.body.id).toBe(first.body.id);
    expect(replay.body.codes).toBeUndefined();
    const rows = await deps.dbPlatform
      .selectFrom('vouchers')
      .select(['code_hash', 'code_hint', 'code_enc'])
      .where('batch_id', '=', first.body.id as string)
      .execute();
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.code_enc).toBeNull();
      expect((first.body.codes as string[]).some((c) => row.code_hash.includes(c))).toBe(false);
    }
  });

  // -------------------------------------------------------------------------------- API keys

  it('API keys: created once, Bearer auth, role-bound, no escalation, revocable', async () => {
    const { orgId, siteId } = await createTenant(deps.dbPlatform);
    const orgAdmin = await createAdmin(deps.dbPlatform, [
      { template: 'org_admin', scope: 'organization', orgId },
    ]);
    const siteAdmin = await createAdmin(deps.dbPlatform, [
      { template: 'site_admin', scope: 'site', orgId, siteId },
    ]);
    const oa = await login(orgAdmin);
    const readOnly = await templateRoleId(deps.dbPlatform, 'read_only');
    const orgAdminRole = await templateRoleId(deps.dbPlatform, 'org_admin');

    const created = await oa
      .post(`/api/v1/orgs/${orgId}/api-keys`)
      .set(BROWSER)
      .set('Idempotency-Key', newId())
      .send({ name: 'ci', role_id: readOnly, scope_type: 'organization' });
    expect(created.status).toBe(201);
    const key = created.body.key as string;
    expect(key).toMatch(/^eck_[A-Za-z0-9]{12}_/);
    const listed = await oa.get(`/api/v1/orgs/${orgId}/api-keys`);
    expect(JSON.stringify(listed.body)).not.toContain(key);

    const bearer = request(apps.publicApp);
    expect(
      (await bearer.get(`/api/v1/orgs/${orgId}/sites`).set('Authorization', `Bearer ${key}`))
        .status,
    ).toBe(200);
    // read_only key cannot write; API keys are CSRF-exempt so this reaches authorization
    const write = await request(apps.publicApp)
      .post(`/api/v1/orgs/${orgId}/users`)
      .set('Authorization', `Bearer ${key}`)
      .send({ username: unique('k') });
    expect(write.status).toBe(403);

    // a site admin cannot mint an org_admin key (escalation guard) — and lacks api_key:create
    const sa = await login(siteAdmin);
    const escalate = await sa
      .post(`/api/v1/orgs/${orgId}/api-keys`)
      .set(BROWSER)
      .set('Idempotency-Key', newId())
      .send({ name: 'x', role_id: orgAdminRole, scope_type: 'site', site_id: siteId });
    expect(escalate.status).toBe(403);

    const revoke = await oa
      .delete(`/api/v1/orgs/${orgId}/api-keys/${created.body.id as string}`)
      .set(BROWSER);
    expect(revoke.status).toBe(204);
    expect(
      (await bearer.get(`/api/v1/orgs/${orgId}/sites`).set('Authorization', `Bearer ${key}`))
        .status,
    ).toBe(401);
  });

  // ---------------------------------------------------------------------------- impersonation

  it('impersonation: audited, header on every response, D-027 restrictions enforced', async () => {
    const a = await createTenant(deps.dbPlatform);
    const b = await createTenant(deps.dbPlatform);
    const support = await createAdmin(deps.dbPlatform, [
      { template: 'platform_support', scope: 'platform' },
    ]);
    const agent = await login(support);
    await enrolMfa(agent);
    // platform support without impersonation cannot write tenant config
    expect(
      (
        await agent
          .post(`/api/v1/orgs/${a.orgId}/sites`)
          .set(BROWSER)
          .send({ slug: 'p', name: 'P' })
      ).status,
    ).toBe(403);

    const start = await agent
      .post('/api/v1/platform/support/impersonate')
      .set(BROWSER)
      .send({ organizationId: a.orgId, reason: 'ticket #42 investigation', ttlMinutes: 15 });
    expect(start.status).toBe(201);
    expect(start.headers['x-ecloud-impersonating']).toBe(a.orgId);

    const me = await agent.get('/api/v1/auth/me');
    expect(me.headers['x-ecloud-impersonating']).toBe(a.orgId);
    expect(me.body.impersonation.organization_id).toBe(a.orgId);

    const site = await agent
      .post(`/api/v1/orgs/${a.orgId}/sites`)
      .set(BROWSER)
      .send({ slug: 'imp', name: 'Imp' });
    expect(site.status).toBe(201);
    const row = await deps.dbPlatform
      .selectFrom('audit_logs')
      .select(['actor_id', 'impersonator_id'])
      .where('action', '=', 'site:create')
      .where('target_id', '=', site.body.id as string)
      .executeTakeFirstOrThrow();
    expect(row.impersonator_id).toBe(support.id);
    expect(row.actor_id).toBe(support.id);

    const readOnly = await templateRoleId(deps.dbPlatform, 'read_only');
    const key = await agent
      .post(`/api/v1/orgs/${a.orgId}/api-keys`)
      .set(BROWSER)
      .set('Idempotency-Key', newId())
      .send({ name: 'nope', role_id: readOnly, scope_type: 'organization' });
    expect(key.status).toBe(403);
    expect(key.body.type).toBe('urn:ecloud:problem:impersonation-forbidden');
    const binding = await agent
      .post(`/api/v1/orgs/${a.orgId}/role-bindings`)
      .set(BROWSER)
      .send({ administrator_id: support.id, role_id: readOnly, scope_type: 'organization' });
    expect(binding.body.type).toBe('urn:ecloud:problem:impersonation-forbidden');
    const nas = await deps.dbPlatform
      .insertInto('nas_clients')
      .values({
        id: newId(),
        organization_id: a.orgId,
        site_id: a.siteId,
        name: 'n',
        nas_ip: randomIp(),
        adapter_type_key: 'coovachilli-uam',
        adapter_key: 'coovachilli-uam',
        secret_ref: 'enc:placeholder',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const rotate = await agent
      .post(`/api/v1/orgs/${a.orgId}/nas/${nas.id}/rotate-secret`)
      .set(BROWSER)
      .set('Idempotency-Key', newId());
    expect(rotate.body.type).toBe('urn:ecloud:problem:impersonation-forbidden');
    // pinned to the impersonated organization; platform permissions are off
    expect((await agent.get(`/api/v1/orgs/${b.orgId}/sites`)).status).toBe(403);
    expect((await agent.get('/api/v1/platform/organizations')).status).toBe(403);

    const stop = await agent.delete('/api/v1/platform/support/impersonate').set(BROWSER);
    expect(stop.status).toBe(204);
    const after = await agent.get('/api/v1/auth/me');
    expect(after.status).toBe(200);
    expect(after.body.impersonation).toBeNull();
    expect(after.headers['x-ecloud-impersonating']).toBeUndefined();
    expect(await countAudit(deps.dbPlatform, 'tenant:impersonate', a.orgId)).toBe(1);
    expect(await countAudit(deps.dbPlatform, 'tenant:impersonate:end', a.orgId)).toBe(1);
  });

  // -------------------------------------------------------------------- platform + adapters

  it('platform: organizations CRUD and the four-state adapter matrix', async () => {
    const superAdmin = await createAdmin(deps.dbPlatform, [
      { template: 'platform_super_admin', scope: 'platform' },
    ]);
    const agent = await login(superAdmin);
    await enrolMfa(agent);
    const slug = unique('acme').toLowerCase().slice(0, 50);
    const created = await agent
      .post('/api/v1/platform/organizations')
      .set(BROWSER)
      .send({ slug, name: 'Acme' });
    expect(created.status).toBe(201);
    const dup = await agent
      .post('/api/v1/platform/organizations')
      .set(BROWSER)
      .send({ slug, name: 'Acme again' });
    expect(dup.status).toBe(409);
    const suspended = await agent
      .patch(`/api/v1/platform/organizations/${created.body.id as string}`)
      .set(BROWSER)
      .send({ status: 'suspended' });
    expect(suspended.body.status).toBe('suspended');

    const adapters = await agent.get('/api/v1/platform/adapters');
    expect(adapters.status).toBe(200);
    const statuses = new Set(
      (adapters.body.adapters as { fields: { status: string; evidence: string }[] }[]).flatMap(
        (a) => a.fields.map((f) => f.status),
      ),
    );
    for (const s of statuses) {
      expect([
        'VERIFIED_SUPPORTED',
        'REQUIRES_DEVICE_TEST',
        'UNSUPPORTED',
        'ECLOUD_SIDE_ONLY',
      ]).toContain(s);
    }
    expect(adapters.body.adapters).toHaveLength(7); // + generic-radius-8021x (Cycle A), mikrotik-hotspot (Cycle B)
  });

  // ---------------------------------------------------------------------------------- AAA

  async function aaaFixture(app = apps.publicApp) {
    const { orgId, siteId } = await createTenant(deps.dbPlatform);
    const admin = await createAdmin(deps.dbPlatform, [
      { template: 'org_admin', scope: 'organization', orgId },
    ]);
    const agent = await login(admin, app);
    const nasIp = randomIp();
    const nas = await agent
      .post(`/api/v1/orgs/${orgId}/nas`)
      .set(BROWSER)
      .send({ site_id: siteId, name: 'chilli', nas_ip: nasIp, adapter_key: 'coovachilli-uam' });
    expect(nas.status).toBe(201);
    expect(nas.body.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(nas.body.secret_ref).toBeUndefined();
    const username = unique('sub');
    const user = await agent
      .post(`/api/v1/orgs/${orgId}/users`)
      .set(BROWSER)
      .send({ username, password: 'sub-password-1' });
    expect(user.status).toBe(201);
    const policy = await agent.post(`/api/v1/orgs/${orgId}/policies`).set(BROWSER).send({
      name: 'Site 10M',
      scope_type: 'site',
      status: 'active',
      download_rate_kbps: 10_000,
      upload_rate_kbps: 2_000,
      session_timeout_s: 3600,
    });
    expect(policy.status).toBe(201);
    const assign = await agent
      .post(`/api/v1/orgs/${orgId}/policy-assignments`)
      .set(BROWSER)
      .send({ policy_id: policy.body.id, target_type: 'site', target_id: siteId });
    expect(assign.status).toBe(201);
    return { orgId, siteId, nasIp, username, agent };
  }

  function radius(attrs: Record<string, string | number>) {
    return Object.fromEntries(
      Object.entries(attrs).map(([k, v]) => [
        k,
        { type: typeof v === 'number' ? 'integer' : 'string', value: [v] },
      ]),
    );
  }

  function authorize(body: unknown) {
    return request(apps.internalApp)
      .post('/internal/aaa/authorize')
      .set('X-Internal-Token', TEST_INTERNAL_TOKEN)
      .send(body as object);
  }

  it('AAA authorize: accept with adapter attributes + Class, reject, unknown NAS, retransmit', async () => {
    const f = await aaaFixture();
    const acct = unique('acct');
    const body = radius({
      'User-Name': f.username,
      'User-Password': 'sub-password-1',
      'ECLOUD-Packet-Src-IP-Address': f.nasIp,
      'Calling-Station-Id': 'AA-BB-CC-DD-EE-01',
      'Acct-Session-Id': acct,
      'Service-Type': 'Login-User',
    });
    const ok = await authorize(body);
    expect(ok.status).toBe(200);
    expect(ok.body['control:Auth-Type']).toEqual({ value: ['Accept'], op: ':=', do_xlat: false });
    const cls = ok.body['reply:Class'] as { value: string[]; do_xlat: boolean };
    expect(cls.value[0]).toMatch(/^ai:[0-9a-f]{32}$/);
    for (const item of Object.values(ok.body as Record<string, { do_xlat: boolean }>)) {
      expect(item.do_xlat).toBe(false);
    }
    expect(JSON.stringify(ok.body)).not.toContain('sub-password-1');
    expect(Object.keys(ok.body).some((k) => k.startsWith('reply:CoovaChilli-'))).toBe(false);
    expect(ok.body['reply:Session-Timeout']).toBeDefined();

    const again = await authorize(body);
    expect(again.status).toBe(200);
    expect(again.body['reply:Class']).toEqual(ok.body['reply:Class']);
    const sessions = await deps.dbPlatform
      .selectFrom('sessions')
      .select(['id', 'status', 'acct_unique_id'])
      .where('acct_session_id', '=', acct)
      .execute();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.acct_unique_id).toBe(cls.value[0]);

    const wrong = await authorize({
      ...body,
      'User-Password': { type: 'string', value: ['nope'] },
    });
    expect(wrong.status).toBe(401);
    expect(wrong.body['reply:Reply-Message']).toEqual({
      value: ['Access denied'],
      op: ':=',
      do_xlat: false,
    });

    const unknownNas = await authorize({
      ...body,
      'ECLOUD-Packet-Src-IP-Address': { type: 'string', value: ['203.0.113.250'] },
    });
    expect(unknownNas.status).toBe(401);

    const post = await request(apps.internalApp)
      .post('/internal/aaa/post-auth')
      .set('X-Internal-Token', TEST_INTERNAL_TOKEN)
      .send({
        ...radius({
          'User-Name': f.username,
          'ECLOUD-Packet-Src-IP-Address': f.nasIp,
          'Calling-Station-Id': 'AA-BB-CC-DD-EE-01',
          'Acct-Session-Id': acct,
          'ECLOUD-Auth-Result': 'accept',
          'ECLOUD-Decision': 'accept',
        }),
        'ECLOUD-Reply-Class': {
          type: 'string',
          value: [`0x${Buffer.from(cls.value[0] as string, 'latin1').toString('hex')}`],
        },
      });
    expect(post.status).toBe(204);
    const events = await deps.dbPlatform
      .selectFrom('auth_events')
      .select(['result', 'organization_id', 'auth_method'])
      .where('username', '=', f.username)
      .execute();
    expect(events).toEqual([
      { result: 'accept', organization_id: f.orgId, auth_method: 'password' },
    ]);
  });

  it('T-05: only the authenticated packet source selects the tenant (no NAS-Identifier / Class trust)', async () => {
    // own rate-limit store: two more admin logins from the shared supertest address
    const app = createApp({ ...deps, kv: new MemoryKv() }).publicApp;
    const a = await aaaFixture(app);
    const b = await aaaFixture(app);
    const nasIdentifier = unique('ap-a');
    await deps.dbPlatform
      .updateTable('nas_clients')
      .set({ nas_identifier: nasIdentifier })
      .where('nas_ip', '=', a.nasIp)
      .execute();
    // a client whose source address is not A's NAS claims A's NAS-Identifier
    const spoofed = await authorize(
      radius({
        'User-Name': a.username,
        'User-Password': 'sub-password-1',
        'ECLOUD-Packet-Src-IP-Address': '203.0.113.251',
        'NAS-Identifier': nasIdentifier,
        'Calling-Station-Id': 'AA-BB-CC-DD-EE-05',
        'Acct-Session-Id': unique('acct'),
      }),
    );
    expect(spoofed.status).toBe(401);

    const acct = unique('acct');
    const ok = await authorize(
      radius({
        'User-Name': a.username,
        'User-Password': 'sub-password-1',
        'ECLOUD-Packet-Src-IP-Address': a.nasIp,
        'Calling-Station-Id': 'AA-BB-CC-DD-EE-06',
        'Acct-Session-Id': acct,
      }),
    );
    expect(ok.status).toBe(200);
    const cls = (ok.body['reply:Class'] as { value: string[] }).value[0] as string;
    // B's NAS replays A's Class in a reject post-auth: A's session must stay untouched
    await request(apps.internalApp)
      .post('/internal/aaa/post-auth')
      .set('X-Internal-Token', TEST_INTERNAL_TOKEN)
      .send({
        ...radius({
          'ECLOUD-Auth-Result': 'reject',
          'User-Name': unique('other'),
          'ECLOUD-Packet-Src-IP-Address': b.nasIp,
        }),
        'ECLOUD-Reply-Class': { type: 'string', value: [`0x${Buffer.from(cls).toString('hex')}`] },
      })
      .expect(204);
    const session = await deps.dbPlatform
      .selectFrom('sessions')
      .select(['status', 'organization_id'])
      .where('acct_unique_id', '=', cls)
      .executeTakeFirstOrThrow();
    expect(session).toEqual({ status: 'authorized', organization_id: a.orgId });
    const leaked = await deps.dbPlatform
      .selectFrom('auth_events')
      .select('organization_id')
      .where('nas_ip', '=', b.nasIp)
      .execute();
    expect(leaked.every((e) => e.organization_id !== a.orgId)).toBe(true);
  });

  it('AAA authorize: single-use voucher is consumed once; post-auth reject closes the session', async () => {
    const f = await aaaFixture();
    const batch = await f.agent
      .post(`/api/v1/orgs/${f.orgId}/voucher-batches`)
      .set(BROWSER)
      .set('Idempotency-Key', newId())
      .send({ name: unique('vb'), count: 1, site_id: f.siteId });
    expect(batch.status).toBe(201);
    const code = (batch.body.codes as string[])[0] as string;
    const body = radius({
      'User-Name': code.toLowerCase(),
      'User-Password': code,
      'ECLOUD-Packet-Src-IP-Address': f.nasIp,
      'Calling-Station-Id': 'AA-BB-CC-DD-EE-02',
      'Acct-Session-Id': unique('acct'),
    });
    const first = await authorize(body);
    expect(first.status).toBe(200);
    const retransmit = await authorize(body);
    expect(retransmit.status).toBe(200);
    const voucher = await deps.dbPlatform
      .selectFrom('vouchers')
      .select(['status', 'use_count'])
      .where('batch_id', '=', batch.body.id as string)
      .executeTakeFirstOrThrow();
    expect(voucher).toEqual({ status: 'exhausted', use_count: 1 });
    const reuse = await authorize({
      ...body,
      'Acct-Session-Id': { type: 'string', value: [unique('acct')] },
    });
    expect(reuse.status).toBe(401);

    const cls = (first.body['reply:Class'] as { value: string[] }).value[0] as string;
    await request(apps.internalApp)
      .post('/internal/aaa/post-auth')
      .set('X-Internal-Token', TEST_INTERNAL_TOKEN)
      .send({
        ...radius({
          'ECLOUD-Auth-Result': 'reject',
          'User-Name': code,
          'ECLOUD-Packet-Src-IP-Address': f.nasIp,
        }),
        'ECLOUD-Reply-Class': { type: 'string', value: [`0x${Buffer.from(cls).toString('hex')}`] },
      })
      .expect(204);
    const session = await deps.dbPlatform
      .selectFrom('sessions')
      .select(['status', 'terminate_cause'])
      .where('acct_unique_id', '=', cls)
      .executeTakeFirstOrThrow();
    expect(session).toEqual({ status: 'stopped', terminate_cause: 'auth-rejected' });
  });

  it('simulate returns the resolved policy and a per-adapter field table', async () => {
    const f = await aaaFixture();
    const user = await deps.dbPlatform
      .selectFrom('users')
      .select('id')
      .where('username', '=', f.username)
      .executeTakeFirstOrThrow();
    const res = await f.agent.get(
      `/api/v1/orgs/${f.orgId}/policies/simulate?user_id=${user.id}&site_id=${f.siteId}&adapter=coovachilli-uam`,
    );
    expect(res.status).toBe(200);
    expect(res.body.decision).toBe('accept');
    expect(res.body.effective.fields.download_rate_kbps).toBe(10_000);
    expect(res.body.per_adapter).toHaveLength(1);
    expect(res.body.per_adapter[0].field_table.length).toBeGreaterThan(10);
  });
});
