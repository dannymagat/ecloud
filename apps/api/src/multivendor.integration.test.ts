/* eslint-disable @typescript-eslint/no-unsafe-member-access -- supertest response bodies are untyped JSON */
/**
 * Multi-vendor L3 endpoints against `ecloud_test` (MULTI_VENDOR_INTEGRATION_PLAN.md §8.2):
 * controllers CRUD + rotate-credential (secret never returned, audited, refused while
 * impersonating, cross-tenant denial), NAS deployment_mode / controller_id, the compatibility
 * registry read API and the adapter catalogue evidence fields. Skipped without the dev stack.
 */
import { COMPATIBILITY_ROWS, VENDORS } from '@ecloud/adapters';
import { newId } from '@ecloud/shared';
import { describeIntegration, migrateTestDatabase } from '@ecloud/testing';
import { sql } from 'kysely';
import { generate } from 'otplib';
import request from 'supertest';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createApp } from './app.js';
import type { AppDeps } from './context.js';
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
/** Obviously fake controller credential (never a real secret). */
const FAKE_CREDENTIAL = 'test-controller-credential-not-a-secret';

await describeIntegration('@ecloud/api multi-vendor (controllers, registry)', () => {
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

  async function login(admin: AdminFixture): Promise<Agent> {
    const agent = request.agent(apps.publicApp);
    const res = await agent
      .post('/api/v1/auth/login')
      .set(BROWSER)
      .send({ email: admin.email, password: admin.password });
    expect(res.status).toBe(200);
    return agent;
  }

  async function orgAdmin(): Promise<{
    orgId: string;
    siteId: string;
    siteId2: string;
    agent: Agent;
  }> {
    const tenant = await createTenant(deps.dbPlatform);
    const admin = await createAdmin(deps.dbPlatform, [
      { template: 'org_admin', scope: 'organization', orgId: tenant.orgId },
    ]);
    return { ...tenant, agent: await login(admin) };
  }

  function randomIp(): string {
    const b = () => Math.floor(Math.random() * 250) + 2;
    return `10.${String(b())}.${String(b())}.${String(b())}`;
  }

  async function auditRows(targetId: string): Promise<{ action: string; text: string }[]> {
    const rows = await sql<{ action: string; before: unknown; after: unknown }>`
      SELECT action, before, after FROM audit_logs WHERE target_id = ${targetId} ORDER BY id
    `.execute(deps.dbPlatform);
    return rows.rows.map((r) => ({
      action: r.action,
      text: JSON.stringify([r.before, r.after]),
    }));
  }

  // ------------------------------------------------------------------------------ controllers

  it('controller CRUD: credential is write-only (has_credential), sealed at rest, audited', async () => {
    const { orgId, siteId, agent } = await orgAdmin();
    const created = await agent.post(`/api/v1/orgs/${orgId}/controllers`).set(BROWSER).send({
      site_id: siteId,
      vendor_key: 'cambium',
      name: 'cnMaestro on-prem',
      kind: 'on_premises',
      base_url: 'https://10.20.30.40:8443/api',
      credential: FAKE_CREDENTIAL,
    });
    expect(created.status).toBe(201);
    expect(created.body.has_credential).toBe(true);
    expect(created.body.credential).toBeUndefined();
    expect(created.body.credential_secret_ref).toBeUndefined();
    expect(JSON.stringify(created.body)).not.toContain(FAKE_CREDENTIAL);
    expect(JSON.stringify(created.body)).not.toContain('enc:v1');
    const id = created.body.id as string;

    // at rest: sealed envelope, never the clear value
    const stored = await deps.dbPlatform
      .selectFrom('controllers')
      .select('credential_secret_ref')
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(stored.credential_secret_ref).toMatch(/^enc:v1\./);
    expect(stored.credential_secret_ref).not.toContain(FAKE_CREDENTIAL);

    for (const res of [
      await agent.get(`/api/v1/orgs/${orgId}/controllers/${id}`),
      await agent.get(`/api/v1/orgs/${orgId}/controllers`),
      await agent
        .patch(`/api/v1/orgs/${orgId}/controllers/${id}`)
        .set(BROWSER)
        .send({ name: 'cnMaestro (renamed)', kind: 'embedded' }),
    ]) {
      expect(res.status).toBe(200);
      const text = JSON.stringify(res.body);
      expect(text).not.toContain(FAKE_CREDENTIAL);
      expect(text).not.toContain('credential_secret_ref');
      expect(text).toContain('"has_credential":true');
    }

    // credentials change only through rotate-credential
    const sneaky = await agent
      .patch(`/api/v1/orgs/${orgId}/controllers/${id}`)
      .set(BROWSER)
      .send({ credential: 'other' });
    expect(sneaky.status).toBe(400);

    const noKey = await agent
      .post(`/api/v1/orgs/${orgId}/controllers/${id}/rotate-credential`)
      .set(BROWSER)
      .send({ credential: `${FAKE_CREDENTIAL}-2` });
    expect(noKey.status).toBe(428); // Idempotency-Key required
    const rotated = await agent
      .post(`/api/v1/orgs/${orgId}/controllers/${id}/rotate-credential`)
      .set(BROWSER)
      .set('Idempotency-Key', newId())
      .send({ credential: `${FAKE_CREDENTIAL}-2` });
    expect(rotated.status).toBe(200);
    expect(rotated.body).toEqual({ id, has_credential: true });
    const after = await deps.dbPlatform
      .selectFrom('controllers')
      .select('credential_secret_ref')
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(after.credential_secret_ref).not.toBe(stored.credential_secret_ref);

    const del = await agent.delete(`/api/v1/orgs/${orgId}/controllers/${id}`).set(BROWSER);
    expect(del.status).toBe(204);
    expect((await agent.get(`/api/v1/orgs/${orgId}/controllers/${id}`)).status).toBe(404);

    const audit = await auditRows(id);
    expect(audit.map((a) => a.action)).toEqual([
      'controller:create',
      'controller:update',
      'controller:secret:rotate',
      'controller:delete',
    ]);
    for (const row of audit) {
      expect(row.text).not.toContain(FAKE_CREDENTIAL);
      expect(row.text).not.toContain('credential_secret_ref');
      expect(row.text).not.toContain('enc:v1');
    }
  });

  it('controller base_url rules: https, no userinfo/fragment, public host for cloud', async () => {
    const { orgId, agent } = await orgAdmin();
    const post = (kind: string, base_url: string) =>
      agent
        .post(`/api/v1/orgs/${orgId}/controllers`)
        .set(BROWSER)
        .send({ vendor_key: 'cambium', name: `c-${newId()}`, kind, base_url });

    for (const [kind, url] of [
      ['cloud', 'http://cnmaestro.example.com'],
      ['cloud', 'https://user:pass@cnmaestro.example.com'],
      ['cloud', 'https://cnmaestro.example.com/#frag'],
      ['cloud', 'https://10.0.0.5/'],
      ['cloud', 'https://100.100.1.1/'],
      ['cloud', 'https://localhost/'],
      ['on_premises', 'https://127.0.0.1/'],
      ['on_premises', 'https://169.254.169.254/'],
      ['embedded', 'https://[fe80::1]/'],
      ['on_premises', 'ftp://10.0.0.5/'],
    ] as const) {
      const res = await post(kind, url);
      expect(res.status, `${kind} ${url}`).toBe(400);
      expect(res.body.errors[0].path).toBe('body.base_url');
    }
    for (const [kind, url] of [
      ['cloud', 'https://cnmaestro.example.com/api'],
      ['on_premises', 'https://192.168.10.2:8443/'],
      ['on_premises', 'https://100.100.4.7/'],
      ['embedded', 'https://[fd12:3456::1]/'],
      ['on_premises', 'https://controller.internal.example/'],
    ] as const) {
      const res = await post(kind, url);
      expect(res.status, `${kind} ${url}`).toBe(201);
      expect(res.body.has_credential).toBe(false);
    }
    // changing the kind re-validates the stored URL
    const priv = await post('on_premises', 'https://10.1.2.3/');
    const toCloud = await agent
      .patch(`/api/v1/orgs/${orgId}/controllers/${priv.body.id as string}`)
      .set(BROWSER)
      .send({ kind: 'cloud' });
    expect(toCloud.status).toBe(400);
    // unknown vendor
    const vendor = await agent.post(`/api/v1/orgs/${orgId}/controllers`).set(BROWSER).send({
      vendor_key: 'no-such-vendor',
      name: 'x',
      kind: 'cloud',
      base_url: 'https://a.example',
    });
    expect(vendor.status).toBe(400);
  });

  it('cross-tenant: other organizations, their sites and controllers are invisible', async () => {
    const a = await orgAdmin();
    const b = await orgAdmin();
    const ctrlB = await b.agent.post(`/api/v1/orgs/${b.orgId}/controllers`).set(BROWSER).send({
      vendor_key: 'ezelink',
      name: 'B controller',
      kind: 'on_premises',
      base_url: 'https://10.9.9.9/',
      credential: FAKE_CREDENTIAL,
    });
    expect(ctrlB.status).toBe(201);
    const idB = ctrlB.body.id as string;

    // A on B's organization path: route-level deny
    expect((await a.agent.get(`/api/v1/orgs/${b.orgId}/controllers`)).status).toBe(403);
    expect((await a.agent.get(`/api/v1/orgs/${b.orgId}/controllers/${idB}`)).status).toBe(403);
    // A on its own path with B's id: RLS hides it (404), writes touch nothing
    expect((await a.agent.get(`/api/v1/orgs/${a.orgId}/controllers/${idB}`)).status).toBe(404);
    expect(
      (
        await a.agent
          .patch(`/api/v1/orgs/${a.orgId}/controllers/${idB}`)
          .set(BROWSER)
          .send({ name: 'pwned' })
      ).status,
    ).toBe(404);
    expect(
      (await a.agent.delete(`/api/v1/orgs/${a.orgId}/controllers/${idB}`).set(BROWSER)).status,
    ).toBe(404);
    expect(
      (
        await a.agent
          .post(`/api/v1/orgs/${a.orgId}/controllers/${idB}/rotate-credential`)
          .set(BROWSER)
          .set('Idempotency-Key', newId())
          .send({ credential: 'x' })
      ).status,
    ).toBe(404);
    const listA = await a.agent.get(`/api/v1/orgs/${a.orgId}/controllers`);
    expect((listA.body.data as { id: string }[]).map((c) => c.id)).not.toContain(idB);
    const stillB = await deps.dbPlatform
      .selectFrom('controllers')
      .select(['name', 'deleted_at'])
      .where('id', '=', idB)
      .executeTakeFirstOrThrow();
    expect(stillB).toEqual({ name: 'B controller', deleted_at: null });

    // same-org check: A cannot bind a controller to B's site
    const foreignSite = await a.agent
      .post(`/api/v1/orgs/${a.orgId}/controllers`)
      .set(BROWSER)
      .send({
        site_id: b.siteId,
        vendor_key: 'ezelink',
        name: 'x',
        kind: 'on_premises',
        base_url: 'https://10.1.1.1/',
      });
    expect(foreignSite.status).toBe(404);
    // ... nor reference B's controller from a NAS
    const nas = await a.agent.post(`/api/v1/orgs/${a.orgId}/nas`).set(BROWSER).send({
      site_id: a.siteId,
      name: 'n',
      nas_ip: randomIp(),
      adapter_key: 'openwifi-uspot-uam',
      controller_id: idB,
    });
    expect(nas.status).toBe(404);
  });

  it('site-scoped bindings: controller:read covers the own site only; writes need org scope', async () => {
    const { orgId, siteId, siteId2, agent } = await orgAdmin();
    const mk = async (site: string | null, name: string) =>
      (
        await agent.post(`/api/v1/orgs/${orgId}/controllers`).set(BROWSER).send({
          site_id: site,
          vendor_key: 'ezelink',
          name,
          kind: 'on_premises',
          base_url: 'https://10.2.2.2/',
        })
      ).body.id as string;
    const onSite = await mk(siteId, 'site 1');
    const onSite2 = await mk(siteId2, 'site 2');
    const orgWide = await mk(null, 'org wide');

    const siteAdmin = await createAdmin(deps.dbPlatform, [
      { template: 'site_admin', scope: 'site', orgId, siteId },
    ]);
    const sa = await login(siteAdmin);
    const list = await sa.get(`/api/v1/orgs/${orgId}/controllers`);
    expect(list.status).toBe(200);
    expect((list.body.data as { id: string }[]).map((c) => c.id)).toEqual([onSite]);
    expect((await sa.get(`/api/v1/orgs/${orgId}/controllers/${onSite}`)).status).toBe(200);
    expect((await sa.get(`/api/v1/orgs/${orgId}/controllers/${onSite2}`)).status).toBe(404);
    expect((await sa.get(`/api/v1/orgs/${orgId}/controllers/${orgWide}`)).status).toBe(404);
    // site_admin has controller:read only
    const write = await sa
      .patch(`/api/v1/orgs/${orgId}/controllers/${onSite}`)
      .set(BROWSER)
      .send({ name: 'nope' });
    expect(write.status).toBe(403);
    const create = await sa.post(`/api/v1/orgs/${orgId}/controllers`).set(BROWSER).send({
      site_id: siteId,
      vendor_key: 'ezelink',
      name: 'nope',
      kind: 'on_premises',
      base_url: 'https://10.2.2.3/',
    });
    expect(create.status).toBe(403);
  });

  it('rotate-credential is refused while impersonating (D-027)', async () => {
    const a = await orgAdmin();
    const ctrl = await a.agent.post(`/api/v1/orgs/${a.orgId}/controllers`).set(BROWSER).send({
      vendor_key: 'ezelink',
      name: 'imp',
      kind: 'on_premises',
      base_url: 'https://10.3.3.3/',
      credential: FAKE_CREDENTIAL,
    });
    const id = ctrl.body.id as string;
    const support = await createAdmin(deps.dbPlatform, [
      { template: 'platform_support', scope: 'platform' },
    ]);
    const agent = await login(support);
    const enrol = await agent.post('/api/v1/auth/mfa/enrol').set(BROWSER);
    await agent
      .post('/api/v1/auth/mfa/confirm')
      .set(BROWSER)
      .send({ code: await generate({ secret: enrol.body.secret as string }) });
    const start = await agent
      .post('/api/v1/platform/support/impersonate')
      .set(BROWSER)
      .send({ organizationId: a.orgId, reason: 'controller credential ticket', ttlMinutes: 15 });
    expect(start.status).toBe(201);
    // review F4: no credential may be set at create time either while impersonating
    const withCredential = await agent
      .post(`/api/v1/orgs/${a.orgId}/controllers`)
      .set(BROWSER)
      .send({
        vendor_key: 'ezelink',
        name: 'imp-create',
        kind: 'on_premises',
        base_url: 'https://10.3.3.4/',
        credential: 'impersonator-value',
      });
    expect(withCredential.status).toBe(403);
    expect(withCredential.body.type).toBe('urn:ecloud:problem:impersonation-forbidden');
    const withoutCredential = await agent
      .post(`/api/v1/orgs/${a.orgId}/controllers`)
      .set(BROWSER)
      .send({
        vendor_key: 'ezelink',
        name: 'imp-create-2',
        kind: 'on_premises',
        base_url: 'https://10.3.3.5/',
      });
    expect(withoutCredential.status).toBe(201);
    expect(withoutCredential.body.has_credential).toBe(false);
    const rotate = await agent
      .post(`/api/v1/orgs/${a.orgId}/controllers/${id}/rotate-credential`)
      .set(BROWSER)
      .set('Idempotency-Key', newId())
      .send({ credential: 'impersonator-value' });
    expect(rotate.status).toBe(403);
    expect(rotate.body.type).toBe('urn:ecloud:problem:impersonation-forbidden');
    expect(await countAudit(deps.dbPlatform, 'controller:secret:rotate', id)).toBe(0);
    // the impersonated read still never exposes the credential
    const read = await agent.get(`/api/v1/orgs/${a.orgId}/controllers/${id}`);
    expect(read.status).toBe(200);
    expect(JSON.stringify(read.body)).not.toContain(FAKE_CREDENTIAL);
    await agent.delete('/api/v1/platform/support/impersonate').set(BROWSER);
  });

  it('NAS deployment_mode defaults from the registry and controller references are checked', async () => {
    const { orgId, siteId, siteId2, agent } = await orgAdmin();
    const chilli = await agent.post(`/api/v1/orgs/${orgId}/nas`).set(BROWSER).send({
      site_id: siteId,
      name: 'chilli',
      nas_ip: randomIp(),
      adapter_key: 'coovachilli-uam',
    });
    expect(chilli.status).toBe(201);
    expect(chilli.body.deployment_mode).toBe('gateway');
    const uspot = await agent.post(`/api/v1/orgs/${orgId}/nas`).set(BROWSER).send({
      site_id: siteId,
      name: 'uspot',
      nas_ip: randomIp(),
      adapter_key: 'openwifi-uspot-uam',
    });
    expect(uspot.body.deployment_mode).toBe('native');
    const wrongMode = await agent.post(`/api/v1/orgs/${orgId}/nas`).set(BROWSER).send({
      site_id: siteId,
      name: 'bad',
      nas_ip: randomIp(),
      adapter_key: 'openwifi-uspot-uam',
      deployment_mode: 'gateway',
    });
    expect(wrongMode.status).toBe(400);
    expect(wrongMode.body.errors[0].path).toBe('body.deployment_mode');

    const ctrl = await agent.post(`/api/v1/orgs/${orgId}/controllers`).set(BROWSER).send({
      site_id: siteId,
      vendor_key: 'ezelink',
      name: 'ezecontroller',
      kind: 'on_premises',
      base_url: 'https://10.4.4.4/',
    });
    const ctrlId = ctrl.body.id as string;
    const linked = await agent
      .patch(`/api/v1/orgs/${orgId}/nas/${uspot.body.id as string}`)
      .set(BROWSER)
      .send({ controller_id: ctrlId });
    expect(linked.status).toBe(200);
    expect(linked.body.controller_id).toBe(ctrlId);
    // a site-bound controller cannot serve a NAS of another site
    const otherSite = await agent.post(`/api/v1/orgs/${orgId}/nas`).set(BROWSER).send({
      site_id: siteId2,
      name: 'other',
      nas_ip: randomIp(),
      adapter_key: 'openwifi-uspot-uam',
      controller_id: ctrlId,
    });
    expect(otherSite.status).toBe(400);
    // a referenced controller cannot be deleted
    const del = await agent.delete(`/api/v1/orgs/${orgId}/controllers/${ctrlId}`).set(BROWSER);
    expect(del.status).toBe(409);
    // switching the adapter adjusts an invalid mode to the new adapter's default
    const switched = await agent
      .patch(`/api/v1/orgs/${orgId}/nas/${chilli.body.id as string}`)
      .set(BROWSER)
      .send({ adapter_key: 'openwifi-uspot-uam' });
    expect(switched.status).toBe(200);
    expect(switched.body.deployment_mode).toBe('native');

    // network devices: registry references
    const model = await deps.dbPlatform
      .selectFrom('hardware_models')
      .select('id')
      .where('model', '=', 'EZE-AP1832')
      .executeTakeFirstOrThrow();
    const device = await agent
      .post(`/api/v1/orgs/${orgId}/network-devices`)
      .set(BROWSER)
      .send({
        site_id: siteId,
        serial: `SER-${newId()}`,
        hardware_model_id: model.id,
        controller_id: ctrlId,
        managed: true,
      });
    expect(device.status).toBe(201);
    expect(device.body.hardware_model_id).toBe(model.id);
    const unknownModel = await agent
      .post(`/api/v1/orgs/${orgId}/network-devices`)
      .set(BROWSER)
      .send({ site_id: siteId, serial: `SER-${newId()}`, hardware_model_id: newId() });
    expect(unknownModel.status).toBe(400);
  });

  // ------------------------------------------------------------------------ registry reads

  it('compatibility registry: every role template reads the hash-checked mirror', async () => {
    const { orgId, siteId } = await createTenant(deps.dbPlatform);
    const operator = await createAdmin(deps.dbPlatform, [
      { template: 'operator', scope: 'site', orgId, siteId },
    ]);
    const agent = await login(operator);
    const list = await agent.get('/api/v1/compatibility');
    expect(list.status).toBe(200);
    const rows = list.body.data as {
      key: string;
      lifecycle: string;
      registry_hash: string;
      capabilities: { status: string; evidence_level: string | null; device_enforced: boolean }[];
      doc_links: unknown[];
    }[];
    expect(rows.map((r) => r.key).sort()).toEqual(COMPATIBILITY_ROWS.map((r) => r.key).sort());
    // no capability is presented as device-enforced today (V12, D-034)
    expect(rows.flatMap((r) => r.capabilities).some((c) => c.device_enforced)).toBe(false);
    const tip = rows.find((r) => r.key === 'ezelink-eze-ap1832-r32912-tip-uspot');
    expect(tip?.lifecycle).toBe('implemented');
    expect(tip?.doc_links.length).toBeGreaterThan(0);
    expect(
      tip?.capabilities.every((c) => c.status === 'UNKNOWN' || c.evidence_level !== null),
    ).toBe(true);

    const one = await agent.get('/api/v1/compatibility/cambium-cnpilot-e-external-hotspot');
    expect(one.status).toBe(200);
    expect(one.body.lifecycle).toBe('researched');
    expect(one.body.adapter_key).toBeNull();
    expect((await agent.get('/api/v1/compatibility/no-such-row')).status).toBe(404);
    expect((await agent.get('/api/v1/compatibility?lifecycle=planned')).body.data).toHaveLength(
      COMPATIBILITY_ROWS.filter((r) => r.lifecycle === 'planned').length,
    );

    const vendors = await agent.get('/api/v1/vendors');
    expect(vendors.status).toBe(200);
    expect((vendors.body.data as { key: string }[]).map((v) => v.key).sort()).toEqual(
      VENDORS.map((v) => v.key).sort(),
    );
    expect((await request(apps.publicApp).get('/api/v1/vendors')).status).toBe(401);
  });

  it('compatibility:read is required (a binding without it is denied)', async () => {
    const { orgId } = await createTenant(deps.dbPlatform);
    const roleId = newId();
    await deps.dbPlatform
      .insertInto('roles')
      .values({
        id: roleId,
        organization_id: orgId,
        key: `nocompat_${newId().slice(-8)}`,
        name: 'x',
        template_key: null,
      })
      .execute();
    await deps.dbPlatform
      .insertInto('role_permissions')
      .values({ role_id: roleId, permission_key: 'site:read' })
      .execute();
    const admin = await createAdmin(deps.dbPlatform, []);
    await deps.dbPlatform
      .insertInto('role_bindings')
      .values({
        id: newId(),
        administrator_id: admin.id,
        role_id: roleId,
        scope_type: 'organization',
        organization_id: orgId,
      })
      .execute();
    const agent = await login(admin);
    expect((await agent.get('/api/v1/compatibility')).status).toBe(403);
    expect((await agent.get('/api/v1/vendors')).status).toBe(403);
    expect((await agent.get(`/api/v1/orgs/${orgId}/controllers`)).status).toBe(403);
  });

  it('adapter catalogue emits evidence_level / device_enforced / dt_refs from the registry', async () => {
    const admin = await createAdmin(deps.dbPlatform, [
      { template: 'platform_super_admin', scope: 'platform' },
    ]);
    const agent = await login(admin);
    const enrol = await agent.post('/api/v1/auth/mfa/enrol').set(BROWSER);
    await agent
      .post('/api/v1/auth/mfa/confirm')
      .set(BROWSER)
      .send({ code: await generate({ secret: enrol.body.secret as string }) });
    const res = await agent.get('/api/v1/platform/adapters');
    expect(res.status).toBe(200);
    const adapters = res.body.adapters as {
      key: string;
      fields: { evidence_level: string | null; device_enforced: boolean; dt_refs: string[] }[];
      disconnect: { evidence_level: string | null; device_enforced: boolean };
      attributes: { evidence_level: string; device_enforced: boolean }[];
    }[];
    expect(adapters).toHaveLength(7); // + generic-radius-8021x (Cycle A), external-portal-postback (Cycle C)
    for (const a of adapters) {
      for (const f of a.fields) {
        expect(f.evidence_level, a.key).not.toBeNull();
        expect(f.device_enforced).toBe(false);
        expect(f.dt_refs).toEqual([]);
      }
      expect(a.disconnect.evidence_level).not.toBeNull();
      expect(a.disconnect.device_enforced).toBe(false);
      expect(a.attributes.every((x) => x.device_enforced === false && x.evidence_level)).toBe(true);
    }
  });
});
