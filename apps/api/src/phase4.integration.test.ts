/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument -- supertest response bodies are untyped JSON */
/**
 * Phase 4 backend (D-035 … D-038 and the admin-UI endpoint gaps) against `ecloud_test`.
 * Skipped with a message when ECLOUD_TEST_DATABASE_URL is unset / unreachable. Every test builds
 * its own organizations and uses its own in-memory rate-limit store.
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
  TEST_INTERNAL_TOKEN,
  TEST_ORIGIN,
  closeDeps,
  countAudit,
  createAdmin,
  createTenant,
  integrationDeps,
  unique,
  type AdminFixture,
} from './test-support/deps.js';

type Agent = ReturnType<typeof request.agent>;
type Apps = ReturnType<typeof createApp>;

const BROWSER = { Origin: TEST_ORIGIN, 'X-Requested-With': 'XMLHttpRequest' };

await describeIntegration('@ecloud/api Phase 4 against ecloud_test', () => {
  let deps: AppDeps;

  beforeAll(async () => {
    await migrateTestDatabase();
    deps = integrationDeps();
  }, 60_000);

  afterAll(async () => {
    await closeDeps(deps);
  });

  /** Own KV per test: login rate limits are per IP and supertest always uses 127.0.0.1. */
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
    expect(res.body.mfa_required).toBe(false);
    return agent;
  }

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

  async function superAdmin(apps: Apps): Promise<{ admin: AdminFixture; agent: Agent }> {
    const admin = await createAdmin(deps.dbPlatform, [
      { template: 'platform_super_admin', scope: 'platform' },
    ]);
    const agent = await login(apps, admin);
    await enrolMfa(agent);
    return { admin, agent };
  }

  function randomIp(): string {
    const b = () => Math.floor(Math.random() * 250) + 2;
    return `10.${String(b())}.${String(b())}.${String(b())}`;
  }

  function radius(attrs: Record<string, string | number>) {
    return Object.fromEntries(
      Object.entries(attrs).map(([k, v]) => [
        k,
        { type: typeof v === 'number' ? 'integer' : 'string', value: [v] },
      ]),
    );
  }

  function authorize(apps: Apps, body: unknown) {
    return request(apps.internalApp)
      .post('/internal/aaa/authorize')
      .set('X-Internal-Token', TEST_INTERNAL_TOKEN)
      .send(body as object);
  }

  async function orgFixture(apps: Apps, adapterKey = 'coovachilli-uam') {
    const { orgId, siteId, siteId2 } = await createTenant(deps.dbPlatform);
    const admin = await createAdmin(deps.dbPlatform, [
      { template: 'org_admin', scope: 'organization', orgId },
    ]);
    const agent = await login(apps, admin);
    const nasIp = randomIp();
    const nas = await agent
      .post(`/api/v1/orgs/${orgId}/nas`)
      .set(BROWSER)
      .send({ site_id: siteId, name: 'nas', nas_ip: nasIp, adapter_key: adapterKey });
    expect(nas.status).toBe(201);
    // AAA rejects without any applicable policy: a site default like the Phase 3 fixtures
    const policy = await agent.post(`/api/v1/orgs/${orgId}/policies`).set(BROWSER).send({
      name: 'Site 10M',
      scope_type: 'site',
      status: 'active',
      download_rate_kbps: 10_000,
      upload_rate_kbps: 2_000,
    });
    expect(policy.status).toBe(201);
    const assign = await agent
      .post(`/api/v1/orgs/${orgId}/policy-assignments`)
      .set(BROWSER)
      .send({ policy_id: policy.body.id, target_type: 'site', target_id: siteId });
    expect(assign.status).toBe(201);
    return { orgId, siteId, siteId2, admin, agent, nasIp, nasId: nas.body.id as string };
  }

  // ------------------------------------------------------------------------------- D-035

  it('D-035: NAS create requires an engine adapter_key; authorize resolves the adapter from it', async () => {
    const apps = freshApps();
    const f = await orgFixture(apps, 'openwifi-uspot-uam');
    const missing = await f.agent
      .post(`/api/v1/orgs/${f.orgId}/nas`)
      .set(BROWSER)
      .send({ site_id: f.siteId, name: 'x', nas_ip: randomIp() });
    expect(missing.status).toBe(400);
    const notNas = await f.agent
      .post(`/api/v1/orgs/${f.orgId}/nas`)
      .set(BROWSER)
      .send({ site_id: f.siteId, name: 'x', nas_ip: randomIp(), adapter_key: 'openwifi-config' });
    expect(notNas.status).toBe(400);
    const legacyField = await f.agent
      .post(`/api/v1/orgs/${f.orgId}/nas`)
      .set(BROWSER)
      .send({ site_id: f.siteId, name: 'x', nas_ip: randomIp(), adapter_type_key: 'coovachilli' });
    expect(legacyField.status).toBe(400);

    const row = await deps.dbPlatform
      .selectFrom('nas_clients')
      .select(['adapter_key', 'adapter_type_key'])
      .where('id', '=', f.nasId)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({
      adapter_key: 'openwifi-uspot-uam',
      adapter_type_key: 'openwifi-uspot-uam',
    });

    const patched = await f.agent
      .patch(`/api/v1/orgs/${f.orgId}/nas/${f.nasId}`)
      .set(BROWSER)
      .send({ adapter_key: 'openwifi-hostapd-radius' });
    expect(patched.status).toBe(200);
    expect(patched.body.adapter_key).toBe('openwifi-hostapd-radius');
    expect(patched.body.adapter_type_key).toBe('openwifi-hostapd-radius');

    const username = unique('sub');
    expect(
      (
        await f.agent
          .post(`/api/v1/orgs/${f.orgId}/users`)
          .set(BROWSER)
          .send({ username, password: 'sub-password-1' })
      ).status,
    ).toBe(201);
    const ok = await authorize(
      apps,
      radius({
        'User-Name': username,
        'User-Password': 'sub-password-1',
        'ECLOUD-Packet-Src-IP-Address': f.nasIp,
        'Calling-Station-Id': 'AA-BB-CC-00-35-01',
        'Acct-Session-Id': unique('acct'),
      }),
    );
    expect(ok.status).toBe(200);
    const sessionId = (ok.body['reply:Class'].value[0] as string).slice(3);
    const translation = await deps.dbPlatform
      .selectFrom('policy_translations')
      .select(['adapter_type_key', 'adapter_version'])
      .where('nas_client_id', '=', f.nasId)
      .executeTakeFirstOrThrow();
    expect(translation.adapter_type_key).toBe('openwifi-hostapd-radius');
    expect(translation.adapter_version).not.toBeNull();
    expect(sessionId).toMatch(/^[0-9a-f]{32}$/);

    // A legacy NAS without adapter_key: Accept with Auth-Type + Class only, recorded as unsupported
    const legacyIp = randomIp();
    await deps.dbPlatform
      .insertInto('nas_clients')
      .values({
        id: newId(),
        organization_id: f.orgId,
        site_id: f.siteId,
        name: 'legacy',
        nas_ip: legacyIp,
        adapter_type_key: 'openwifi-config',
        adapter_key: null,
        secret_ref: 'enc:placeholder',
      })
      .execute();
    const legacy = await authorize(
      apps,
      radius({
        'User-Name': username,
        'User-Password': 'sub-password-1',
        'ECLOUD-Packet-Src-IP-Address': legacyIp,
        'Calling-Station-Id': 'AA-BB-CC-00-35-02',
        'Acct-Session-Id': unique('acct'),
      }),
    );
    expect(legacy.status).toBe(200);
    expect(Object.keys(legacy.body).sort()).toEqual(['control:Auth-Type', 'reply:Class']);
  });

  // ------------------------------------------------------------------------------- D-036

  it('D-036: authorize inserts `authorized`; concurrency counts authorized sessions', async () => {
    const apps = freshApps();
    const f = await orgFixture(apps);
    const username = unique('sub');
    const user = await f.agent
      .post(`/api/v1/orgs/${f.orgId}/users`)
      .set(BROWSER)
      .send({ username, password: 'sub-password-1' });
    expect(user.status).toBe(201);
    const policy = await f.agent.post(`/api/v1/orgs/${f.orgId}/policies`).set(BROWSER).send({
      name: 'One session',
      scope_type: 'user',
      status: 'active',
      max_concurrent_sessions: 1,
    });
    expect(policy.status).toBe(201);
    expect(
      (
        await f.agent
          .post(`/api/v1/orgs/${f.orgId}/policy-assignments`)
          .set(BROWSER)
          .send({ policy_id: policy.body.id, target_type: 'user', target_id: user.body.id })
      ).status,
    ).toBe(201);
    const first = await authorize(
      apps,
      radius({
        'User-Name': username,
        'User-Password': 'sub-password-1',
        'ECLOUD-Packet-Src-IP-Address': f.nasIp,
        'Calling-Station-Id': 'AA-BB-CC-00-36-01',
        'Acct-Session-Id': unique('acct'),
      }),
    );
    expect(first.status).toBe(200);
    const session = await deps.dbPlatform
      .selectFrom('sessions')
      .select(['status'])
      .where('user_id', '=', user.body.id as string)
      .executeTakeFirstOrThrow();
    expect(session.status).toBe('authorized');

    // the first device has not sent Accounting-Start yet, but it already holds the only slot
    const second = await authorize(
      apps,
      radius({
        'User-Name': username,
        'User-Password': 'sub-password-1',
        'ECLOUD-Packet-Src-IP-Address': f.nasIp,
        'Calling-Station-Id': 'AA-BB-CC-00-36-02',
        'Acct-Session-Id': unique('acct'),
      }),
    );
    expect(second.status).toBe(401);
    expect(second.body['reply:Reply-Message'].value[0]).toBe('Too many active sessions');

    const listed = await f.agent.get(`/api/v1/orgs/${f.orgId}/sessions?status=authorized`);
    expect(listed.status).toBe(200);
    expect(listed.body.data).toHaveLength(1);
  });

  // ------------------------------------------------------------------------------- D-037

  it('D-037: duration allows re-login until expiry, max_uses counts logins, both apply', async () => {
    const apps = freshApps();
    const f = await orgFixture(apps);
    async function batch(extra: Record<string, unknown>) {
      return f.agent
        .post(`/api/v1/orgs/${f.orgId}/voucher-batches`)
        .set(BROWSER)
        .set('Idempotency-Key', newId())
        .send({ name: unique('vb'), count: 1, site_id: f.siteId, ...extra });
    }
    let n = 0;
    function login(code: string) {
      n += 1;
      return authorize(
        apps,
        radius({
          'User-Name': code,
          'User-Password': code,
          'ECLOUD-Packet-Src-IP-Address': f.nasIp,
          'Calling-Station-Id': `AA-BB-CC-00-37-${String(n).padStart(2, '0')}`,
          'Acct-Session-Id': unique('acct'),
        }),
      );
    }

    const neither = await batch({});
    expect(neither.status).toBe(201);
    expect(neither.body.max_uses).toBe(1);
    expect((await batch({ max_uses: null })).status).toBe(400);

    const timed = await batch({ duration_s: 3600 });
    expect(timed.status).toBe(201);
    expect(timed.body.max_uses).toBeNull();
    const timedCode = timed.body.codes[0] as string;
    for (let i = 0; i < 3; i += 1) expect((await login(timedCode)).status).toBe(200);

    const both = await batch({ duration_s: 3600, max_uses: 2 });
    const bothCode = both.body.codes[0] as string;
    expect((await login(bothCode)).status).toBe(200);
    expect((await login(bothCode)).status).toBe(200);
    const third = await login(bothCode);
    expect(third.status).toBe(401);
    const voucher = await deps.dbPlatform
      .selectFrom('vouchers')
      .select(['status', 'use_count'])
      .where('batch_id', '=', both.body.id as string)
      .executeTakeFirstOrThrow();
    expect(voucher).toEqual({ status: 'exhausted', use_count: 2 });

    // duration elapsed: re-login refused even though uses remain
    const expiring = await batch({ duration_s: 60, max_uses: 5 });
    const expiringCode = expiring.body.codes[0] as string;
    expect((await login(expiringCode)).status).toBe(200);
    await deps.dbPlatform
      .updateTable('vouchers')
      .set({ expires_at: new Date(Date.now() - 1000) })
      .where('batch_id', '=', expiring.body.id as string)
      .execute();
    const late = await login(expiringCode);
    expect(late.status).toBe(401);
    expect(late.body['reply:Reply-Message'].value[0]).toBe('Voucher expired');
  });

  // ------------------------------------------------------------------------------- D-038

  it('D-038: platform super admin resets a lost MFA factor; target must re-enrol', async () => {
    const apps = freshApps();
    const { orgId } = await createTenant(deps.dbPlatform);
    const { admin: root, agent: rootAgent } = await superAdmin(apps);
    const target = await createAdmin(deps.dbPlatform, [
      { template: 'org_admin', scope: 'organization', orgId },
    ]);
    const targetAgent = await login(apps, target);
    await enrolMfa(targetAgent);
    expect((await targetAgent.get(`/api/v1/orgs/${orgId}/sites`)).status).toBe(200);

    const noReason = await rootAgent
      .post(`/api/v1/platform/administrators/${target.id}/mfa/reset`)
      .set(BROWSER)
      .send({});
    expect(noReason.status).toBe(400);
    const self = await rootAgent
      .post(`/api/v1/platform/administrators/${root.id}/mfa/reset`)
      .set(BROWSER)
      .send({ reason: 'lost my phone' });
    expect(self.status).toBe(422);

    // a tenant admin and platform support cannot reset MFA
    const orgPeer = await login(
      apps,
      await createAdmin(deps.dbPlatform, [{ template: 'org_admin', scope: 'organization', orgId }]),
    );
    expect(
      (
        await orgPeer
          .post(`/api/v1/platform/administrators/${target.id}/mfa/reset`)
          .set(BROWSER)
          .send({ reason: 'helping a colleague' })
      ).status,
    ).toBe(403);
    const supportAgent = await login(
      apps,
      await createAdmin(deps.dbPlatform, [{ template: 'platform_support', scope: 'platform' }]),
    );
    await enrolMfa(supportAgent);
    expect(
      (
        await supportAgent
          .post(`/api/v1/platform/administrators/${target.id}/mfa/reset`)
          .set(BROWSER)
          .send({ reason: 'helping a colleague' })
      ).status,
    ).toBe(403);

    const reset = await rootAgent
      .post(`/api/v1/platform/administrators/${target.id}/mfa/reset`)
      .set(BROWSER)
      .send({ reason: 'ticket 42: phone lost' });
    expect(reset.status).toBe(200);
    expect(reset.body).toMatchObject({
      administrator_id: target.id,
      mfa_reenrol_required: true,
      credentials_removed: 1,
    });
    expect(reset.body.sessions_revoked).toBeGreaterThanOrEqual(1);
    expect(await countAudit(deps.dbPlatform, 'administrator:mfa_reset', target.id)).toBe(1);
    const auditRow = await deps.dbPlatform
      .selectFrom('audit_logs')
      .select(['after', 'actor_id'])
      .where('action', '=', 'administrator:mfa_reset')
      .where('target_id', '=', target.id)
      .executeTakeFirstOrThrow();
    expect(auditRow.actor_id).toBe(root.id);
    expect(JSON.stringify(auditRow.after)).toContain('ticket 42');

    // the target's old session is gone; a new login has no second factor and no permissions
    expect((await targetAgent.get('/api/v1/auth/me')).status).toBe(401);
    const relog = request.agent(apps.publicApp);
    const res = await relog
      .post('/api/v1/auth/login')
      .set(BROWSER)
      .send({ email: target.email, password: target.password });
    expect(res.body).toMatchObject({ mfa_required: false, mfa_enrolment_required: true });
    const me = await relog.get('/api/v1/auth/me');
    expect(me.body.mfa).toMatchObject({ pending: true, reenrol_required: true, enrolled: false });
    expect((await relog.get(`/api/v1/orgs/${orgId}/sites`)).status).toBe(403);

    await enrolMfa(relog);
    expect((await relog.get(`/api/v1/orgs/${orgId}/sites`)).status).toBe(200);
    const flag = await deps.dbPlatform
      .selectFrom('administrators')
      .select('mfa_reenrol_required')
      .where('id', '=', target.id)
      .executeTakeFirstOrThrow();
    expect(flag.mfa_reenrol_required).toBe(false);

    // impersonating: no platform permission, so the reset is refused
    const imp = await rootAgent
      .post('/api/v1/platform/support/impersonate')
      .set(BROWSER)
      .send({ organizationId: orgId, reason: 'support ticket 43' });
    expect(imp.status).toBe(201);
    const during = await rootAgent
      .post(`/api/v1/platform/administrators/${target.id}/mfa/reset`)
      .set(BROWSER)
      .send({ reason: 'while impersonating' });
    expect(during.status).toBe(403);
  });

  // -------------------------------------------------------------- administrators endpoints

  it('platform administrators: list, get with bindings, disable revokes sessions, no self-disable', async () => {
    const apps = freshApps();
    const { orgId } = await createTenant(deps.dbPlatform);
    const { admin: root, agent } = await superAdmin(apps);
    const target = await createAdmin(deps.dbPlatform, [
      { template: 'operator', scope: 'organization', orgId },
    ]);
    const targetAgent = await login(apps, target);

    const list = await agent.get(
      `/api/v1/platform/administrators?q=${encodeURIComponent(target.email)}`,
    );
    expect(list.status).toBe(200);
    expect((list.body.data as { id: string }[]).map((a) => a.id)).toEqual([target.id]);
    expect(list.body.data[0].password_hash).toBeUndefined();

    const got = await agent.get(`/api/v1/platform/administrators/${target.id}`);
    expect(got.status).toBe(200);
    expect(got.body.bindings).toHaveLength(1);
    expect(got.body.bindings[0]).toMatchObject({ role_key: 'operator', organization_id: orgId });

    const selfDisable = await agent
      .patch(`/api/v1/platform/administrators/${root.id}`)
      .set(BROWSER)
      .send({ status: 'disabled' });
    expect(selfDisable.status).toBe(422);

    const stale = await agent
      .patch(`/api/v1/platform/administrators/${target.id}`)
      .set(BROWSER)
      .set('If-Match', '"2000-01-01T00:00:00.000Z"')
      .send({ display_name: 'x' });
    expect(stale.status).toBe(412);

    const disabled = await agent
      .patch(`/api/v1/platform/administrators/${target.id}`)
      .set(BROWSER)
      .send({ status: 'disabled', display_name: 'Gone' });
    expect(disabled.status).toBe(200);
    expect(disabled.body).toMatchObject({ status: 'disabled', display_name: 'Gone' });
    expect(disabled.body.sessions_revoked).toBe(1);
    expect((await targetAgent.get('/api/v1/auth/me')).status).toBe(401);
    expect(await countAudit(deps.dbPlatform, 'administrator:disable', target.id)).toBe(1);

    // tenant admins cannot use the platform routes
    const tenantAdmin = await login(
      apps,
      await createAdmin(deps.dbPlatform, [{ template: 'org_admin', scope: 'organization', orgId }]),
    );
    expect((await tenantAdmin.get('/api/v1/platform/administrators')).status).toBe(403);
  });

  it('organization administrators: get / disable within the org, escalation and foreign-binding guards', async () => {
    const apps = freshApps();
    const { orgId } = await createTenant(deps.dbPlatform);
    const other = await createTenant(deps.dbPlatform);
    const orgAdmin = await createAdmin(deps.dbPlatform, [
      { template: 'org_admin', scope: 'organization', orgId },
    ]);
    const agent = await login(apps, orgAdmin);
    const operator = await createAdmin(deps.dbPlatform, [
      { template: 'operator', scope: 'organization', orgId },
    ]);
    const shared = await createAdmin(deps.dbPlatform, [
      { template: 'operator', scope: 'organization', orgId },
      { template: 'operator', scope: 'organization', orgId: other.orgId },
    ]);
    const outsider = await createAdmin(deps.dbPlatform, [
      { template: 'operator', scope: 'organization', orgId: other.orgId },
    ]);

    const got = await agent.get(`/api/v1/orgs/${orgId}/administrators/${operator.id}`);
    expect(got.status).toBe(200);
    expect(got.body.bindings).toHaveLength(1);
    expect((await agent.get(`/api/v1/orgs/${orgId}/administrators/${outsider.id}`)).status).toBe(
      404,
    );

    const foreign = await agent
      .patch(`/api/v1/orgs/${orgId}/administrators/${shared.id}`)
      .set(BROWSER)
      .send({ status: 'disabled' });
    expect(foreign.status).toBe(403);

    const disabled = await agent
      .patch(`/api/v1/orgs/${orgId}/administrators/${operator.id}`)
      .set(BROWSER)
      .send({ status: 'disabled' });
    expect(disabled.status).toBe(200);
    expect(disabled.body.status).toBe('disabled');
    const auditRow = await deps.dbPlatform
      .selectFrom('audit_logs')
      .select('organization_id')
      .where('action', '=', 'administrator:disable')
      .where('target_id', '=', operator.id)
      .executeTakeFirstOrThrow();
    expect(auditRow.organization_id).toBe(orgId);

    // an operator cannot manage administrators; a site admin cannot disable the org admin
    const opAgent = await login(
      apps,
      await createAdmin(deps.dbPlatform, [{ template: 'operator', scope: 'organization', orgId }]),
    );
    expect(
      (
        await opAgent
          .patch(`/api/v1/orgs/${orgId}/administrators/${orgAdmin.id}`)
          .set(BROWSER)
          .send({ display_name: 'x' })
      ).status,
    ).toBe(403);
    const lesser = await createAdmin(deps.dbPlatform, [
      { template: 'org_admin', scope: 'organization', orgId },
    ]);
    // custom role with administrator:update/disable only: cannot touch an org admin (escalation)
    const lesserAgent = await login(apps, lesser);
    const role = await agent
      .post(`/api/v1/orgs/${orgId}/roles`)
      .set(BROWSER)
      .send({
        key: unique('admmgr').replaceAll('-', '_').toLowerCase().slice(0, 40),
        name: 'Admin manager',
        permissions: ['administrator:read', 'administrator:update', 'administrator:disable'],
      });
    expect(role.status).toBe(201);
    await deps.dbPlatform
      .deleteFrom('role_bindings')
      .where('administrator_id', '=', lesser.id)
      .execute();
    await deps.dbPlatform
      .insertInto('role_bindings')
      .values({
        id: newId(),
        administrator_id: lesser.id,
        role_id: role.body.id as string,
        scope_type: 'organization',
        organization_id: orgId,
      })
      .execute();
    expect(
      (
        await lesserAgent
          .patch(`/api/v1/orgs/${orgId}/administrators/${orgAdmin.id}`)
          .set(BROWSER)
          .send({ status: 'disabled' })
      ).status,
    ).toBe(403);
  });

  // --------------------------------------------------------- templates / audit / health / me

  it('platform role templates, cross-tenant audit log and health report', async () => {
    const apps = freshApps();
    const { agent } = await superAdmin(apps);
    const templates = await agent.get('/api/v1/platform/role-templates');
    expect(templates.status).toBe(200);
    expect(templates.body.data).toHaveLength(6);
    const sa = (templates.body.data as { key: string; permissions: string[] }[]).find(
      (t) => t.key === 'platform_super_admin',
    );
    expect(sa?.permissions).toContain('administrator:mfa_reset');

    const f = await orgFixture(apps);
    const audit = await agent.get(
      `/api/v1/platform/audit-log?organization_id=${f.orgId}&action=nas:create`,
    );
    expect(audit.status).toBe(200);
    expect(audit.body.data).toHaveLength(1);
    expect(audit.body.data[0].organization_id).toBe(f.orgId);
    expect((await f.agent.get('/api/v1/platform/audit-log')).status).toBe(403);

    const health = await agent.get('/api/v1/platform/health');
    expect(health.status).toBe(200);
    expect(health.body).toMatchObject({
      status: 'ok',
      database: { ok: true },
      redis: { ok: true },
      queues: null, // in-memory KV in tests: no BullMQ queues to inspect
      freeradius: { status: 'not_checked' },
    });
    expect(health.body.migrations.latest).toMatch(/^\d{3}_/);
    expect(health.body.migrations.latest >= '018_admin_mfa_reset').toBe(true);
    expect(health.body.partitions.length).toBeGreaterThan(0);
    expect((await f.agent.get('/api/v1/platform/health')).status).toBe(403);
  });

  it('/me/sessions lists and revokes only my own sessions', async () => {
    const apps = freshApps();
    const { orgId } = await createTenant(deps.dbPlatform);
    const admin = await createAdmin(deps.dbPlatform, [
      { template: 'read_only', scope: 'organization', orgId },
    ]);
    const a = await login(apps, admin);
    const b = await login(apps, admin);
    const listed = await a.get('/api/v1/me/sessions');
    expect(listed.status).toBe(200);
    expect(listed.body.data).toHaveLength(2);
    expect(JSON.stringify(listed.body)).not.toContain('token');
    const other = (listed.body.data as { id: string; current: boolean }[]).find((x) => !x.current);
    expect(other).toBeDefined();
    const otherId = other?.id ?? '';

    const stranger = await login(
      apps,
      await createAdmin(deps.dbPlatform, [{ template: 'read_only', scope: 'organization', orgId }]),
    );
    expect((await stranger.delete(`/api/v1/me/sessions/${otherId}`).set(BROWSER)).status).toBe(404);

    expect((await a.delete(`/api/v1/me/sessions/${otherId}`).set(BROWSER)).status).toBe(204);
    expect((await b.get('/api/v1/auth/me')).status).toBe(401);
    expect((await a.get('/api/v1/me/sessions')).body.data).toHaveLength(1);
    expect(await countAudit(deps.dbPlatform, 'auth:session:revoke', otherId)).toBe(1);
  });

  // ------------------------------------------------------------- voucher export / import

  it('voucher batch export is CSV metadata only (no codes), audited', async () => {
    const apps = freshApps();
    const f = await orgFixture(apps);
    const batch = await f.agent
      .post(`/api/v1/orgs/${f.orgId}/voucher-batches`)
      .set(BROWSER)
      .set('Idempotency-Key', newId())
      .send({ name: unique('vb'), count: 3, site_id: f.siteId, duration_s: 600 });
    expect(batch.status).toBe(201);
    const codes = batch.body.codes as string[];
    const exported = await f.agent
      .post(`/api/v1/orgs/${f.orgId}/voucher-batches/${batch.body.id as string}/export`)
      .set(BROWSER);
    expect(exported.status).toBe(200);
    expect(exported.headers['content-type']).toMatch(/^text\/csv/);
    const lines = exported.text.trim().split('\r\n');
    expect(lines[0]).toBe(
      'voucher_id,batch_id,batch_name,code_hint,status,use_count,max_uses,duration_s,activated_at,expires_at,valid_from,valid_until',
    );
    expect(lines).toHaveLength(4);
    for (const code of codes) expect(exported.text).not.toContain(code);
    expect(await countAudit(deps.dbPlatform, 'voucher:export', batch.body.id as string)).toBe(1);

    const other = await createTenant(deps.dbPlatform);
    expect(
      (
        await f.agent
          .post(`/api/v1/orgs/${other.orgId}/voucher-batches/${batch.body.id as string}/export`)
          .set(BROWSER)
      ).status,
    ).toBe(403);
  });

  it('users import: validated all-or-nothing, dry run, idempotent re-run', async () => {
    const apps = freshApps();
    const f = await orgFixture(apps);
    const u1 = unique('imp');
    const u2 = unique('imp');
    const csv = [
      'username,password,display_name,email,site_id,auth_methods',
      `${u1},secret-pass-1,"Doe, Jane",jane@example.test,${f.siteId},password`,
      `${u2},,=cmd,,,mac;password`,
    ].join('\n');
    const post = (body: unknown, key = newId()) =>
      f.agent
        .post(`/api/v1/orgs/${f.orgId}/users/import`)
        .set(BROWSER)
        .set('Idempotency-Key', key)
        .send(body as object);

    expect(
      (await f.agent.post(`/api/v1/orgs/${f.orgId}/users/import`).set(BROWSER).send({ csv }))
        .status,
    ).toBe(428);

    const dry = await post({ csv, dry_run: true });
    expect(dry.status).toBe(200);
    expect(dry.body).toMatchObject({ dry_run: true, created: 0 });
    expect(dry.body.users).toHaveLength(2);
    expect(
      await deps.dbPlatform
        .selectFrom('users')
        .select('id')
        .where('username', '=', u1)
        .executeTakeFirst(),
    ).toBeUndefined();

    const bad = await post({
      csv: `username,email,colour\n${unique('x')},not-an-email,blue`,
    });
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body.errors)).toContain('unknown column colour');
    const badRow = await post({ csv: `username,email\n${unique('x')},not-an-email\n${u1},` });
    expect(badRow.status).toBe(400);
    expect(badRow.body.errors[0].path).toBe('body.csv.rows[2].email');

    const created = await post({ csv });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ dry_run: false, created: 2, skipped: [] });
    const jane = await deps.dbPlatform
      .selectFrom('users')
      .select(['display_name', 'site_id', 'password_hash', 'auth_methods'])
      .where('username', '=', u1)
      .executeTakeFirstOrThrow();
    expect(jane.display_name).toBe('Doe, Jane');
    expect(jane.site_id).toBe(f.siteId);
    expect(jane.password_hash).toMatch(/^\$argon2id\$/);

    const again = await post({ csv });
    expect(again.status).toBe(201);
    expect(again.body.created).toBe(0);
    expect(again.body.skipped).toHaveLength(2);
    expect(
      await deps.dbPlatform
        .selectFrom('audit_logs')
        .select('id')
        .where('organization_id', '=', f.orgId)
        .where('action', '=', 'user:create')
        .where('target_type', '=', 'user_import')
        .execute(),
    ).toHaveLength(2);

    const foreignSite = await createTenant(deps.dbPlatform);
    const ref = await post({ csv: `username,site_id\n${unique('x')},${foreignSite.siteId}` });
    expect(ref.status).toBe(400);
    expect(ref.body.errors[0].path).toBe('body.csv.rows[2].site_id');
  });
});
