/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment -- supertest response bodies are untyped JSON */
/**
 * Phase 7 P7-A against `ecloud_test`: Q44 Session-Timeout cap at authorize, policy-change
 * propagation to live sessions (strategy from adapter evidence → next_reauth), the session
 * enforcement views, the impact preview and concurrency rejection at authorize.
 * Skipped with a message when ECLOUD_TEST_DATABASE_URL is unset / unreachable.
 */
import { describeIntegration, migrateTestDatabase } from '@ecloud/testing';
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

await describeIntegration('@ecloud/api P7-A enforcement orchestration against ecloud_test', () => {
  let deps: AppDeps;

  beforeAll(async () => {
    await migrateTestDatabase();
    deps = integrationDeps();
  }, 60_000);

  afterAll(async () => {
    await closeDeps(deps);
  });

  function freshApps(configOverrides: Partial<AppDeps['config']> = {}): Apps {
    return createApp({
      ...deps,
      config: { ...deps.config, ...configOverrides },
      kv: new MemoryKv(),
    });
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

  async function orgFixture(apps: Apps, policy: Record<string, unknown> = {}) {
    const { orgId, siteId } = await createTenant(deps.dbPlatform);
    const admin = await createAdmin(deps.dbPlatform, [
      { template: 'org_admin', scope: 'organization', orgId },
    ]);
    const agent = await login(apps, admin);
    const nasIp = randomIp();
    const nas = await agent
      .post(`/api/v1/orgs/${orgId}/nas`)
      .set(BROWSER)
      .send({ site_id: siteId, name: 'nas', nas_ip: nasIp, adapter_key: 'coovachilli-uam' });
    expect(nas.status).toBe(201);
    const created = await agent
      .post(`/api/v1/orgs/${orgId}/policies`)
      .set(BROWSER)
      .send({
        name: 'Site 10M',
        scope_type: 'site',
        status: 'active',
        download_rate_kbps: 10_000,
        upload_rate_kbps: 2_000,
        ...policy,
      });
    expect(created.status).toBe(201);
    const assign = await agent
      .post(`/api/v1/orgs/${orgId}/policy-assignments`)
      .set(BROWSER)
      .send({ policy_id: created.body.id, target_type: 'site', target_id: siteId });
    expect(assign.status).toBe(201);
    // No open session yet: nothing to propagate.
    expect(assign.body.enforcement.affected_sessions).toBe(0);
    return { orgId, siteId, agent, nasIp, policyId: created.body.id as string };
  }

  async function subscriber(agent: Agent, orgId: string): Promise<string> {
    const username = unique('sub');
    const res = await agent
      .post(`/api/v1/orgs/${orgId}/users`)
      .set(BROWSER)
      .send({ username, password: 'sub-password-1' });
    expect(res.status).toBe(201);
    return username;
  }

  async function login1(apps: Apps, nasIp: string, username: string, mac = 'AA-BB-CC-00-70-01') {
    const res = await authorize(
      apps,
      radius({
        'User-Name': username,
        'User-Password': 'sub-password-1',
        'ECLOUD-Packet-Src-IP-Address': nasIp,
        'Calling-Station-Id': mac,
        'Acct-Session-Id': unique('acct'),
      }),
    );
    return res;
  }

  function sessionIdOf(res: request.Response): string {
    const hex = (res.body['reply:Class'].value[0] as string).slice(3);
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  it('Q44: Session-Timeout is capped at AAA_SESSION_TIMEOUT_CAP_S (1800) without lab-validated CoA', async () => {
    const apps = freshApps();
    const f = await orgFixture(apps, { session_timeout_s: 7200 });
    const ok = await login1(apps, f.nasIp, await subscriber(f.agent, f.orgId));
    expect(ok.status).toBe(200);
    expect(Number(ok.body['reply:Session-Timeout'].value[0])).toBe(1800);
  });

  it('policy change → affected open sessions get next_reauth rows, outbox and audit; name-only edit affects none', async () => {
    const apps = freshApps();
    const f = await orgFixture(apps);
    const other = await orgFixture(apps);
    const ok = await login1(apps, f.nasIp, await subscriber(f.agent, f.orgId));
    expect(ok.status).toBe(200);
    const sessionId = sessionIdOf(ok);
    const foreign = await login1(apps, other.nasIp, await subscriber(other.agent, other.orgId));
    const foreignSession = sessionIdOf(foreign);

    const renamed = await f.agent
      .patch(`/api/v1/orgs/${f.orgId}/policies/${f.policyId}`)
      .set(BROWSER)
      .send({ name: 'Site 10M renamed', description: 'labels only' });
    expect(renamed.status).toBe(200);
    // Review fix 2: label-only PATCH → propagation skipped, zero re-resolutions.
    expect(renamed.body.enforcement).toMatchObject({
      change_id: null,
      evaluated_sessions: 0,
      affected_sessions: 0,
      skipped: 'no resolution input changed (name / description only)',
    });

    const changed = await f.agent
      .patch(`/api/v1/orgs/${f.orgId}/policies/${f.policyId}`)
      .set(BROWSER)
      .send({ download_rate_kbps: 20_000 });
    expect(changed.status).toBe(200);
    expect(changed.body.enforcement).toMatchObject({
      evaluated_sessions: 1,
      affected_sessions: 1,
      by_strategy: { coa_change: 0, disconnect_reauth: 0, next_reauth: 1, none: 0 },
      truncated: false,
    });
    const rows = await deps.dbPlatform
      .selectFrom('session_enforcement')
      .selectAll()
      .where('session_id', 'in', [sessionId, foreignSession])
      .execute();
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row).toMatchObject({
      organization_id: f.orgId,
      session_id: sessionId,
      trigger: 'policy_update',
      strategy: 'next_reauth',
      state: 'pending',
      policy_id: f.policyId,
      change_id: changed.body.enforcement.change_id,
    });
    expect(row?.reason).toContain('not lab-validated');
    expect(row?.reason).toContain('dispatcher disabled (D-006)');
    const session = await deps.dbPlatform
      .selectFrom('sessions')
      .select('started_at')
      .where('id', '=', sessionId)
      .executeTakeFirstOrThrow();
    expect(row?.expected_apply_by?.getTime()).toBe(session.started_at.getTime() + 1800 * 1000);

    const events = await deps.dbPlatform
      .selectFrom('outbox')
      .select(['event', 'payload'])
      .where('organization_id', '=', f.orgId)
      .where('event', 'in', ['policy.changed', 'session.enforcement_pending'])
      .execute();
    expect(events.map((e) => e.event).sort()).toEqual([
      'policy.changed',
      'session.enforcement_pending',
    ]);
    expect(await countAudit(deps.dbPlatform, 'session_enforcement:propagate', f.policyId)).toBe(1);

    // A second change supersedes the pending row (one pending per session).
    const again = await f.agent
      .patch(`/api/v1/orgs/${f.orgId}/policies/${f.policyId}`)
      .set(BROWSER)
      .send({ upload_rate_kbps: 4_000 });
    expect(again.body.enforcement.affected_sessions).toBe(1);
    const states = await deps.dbPlatform
      .selectFrom('session_enforcement')
      .select('state')
      .where('session_id', '=', sessionId)
      .orderBy('created_at')
      .execute();
    expect(states.map((s) => s.state)).toEqual(['superseded', 'pending']);
  });

  it('session enforcement view: snapshot, attributes sent, evidence, strategy; tenant-scoped', async () => {
    const apps = freshApps();
    const f = await orgFixture(apps, { quota_daily_bytes: 5_000_000_000 });
    const other = await orgFixture(apps);
    const ok = await login1(apps, f.nasIp, await subscriber(f.agent, f.orgId));
    const sessionId = sessionIdOf(ok);
    await f.agent
      .patch(`/api/v1/orgs/${f.orgId}/policies/${f.policyId}`)
      .set(BROWSER)
      .send({ download_rate_kbps: 30_000 });

    const view = await f.agent.get(`/api/v1/orgs/${f.orgId}/sessions/${sessionId}/enforcement`);
    expect(view.status).toBe(200);
    expect(view.body).toMatchObject({
      session_id: sessionId,
      status: 'authorized',
      adapter_key: 'coovachilli-uam',
      session_timeout: { value_s: 1800, sent: true },
      strategy_evidence: {
        dispatcher_enabled: false,
        strategy: 'next_reauth',
        coa_change: { device_enforced: false },
        disconnect: { device_enforced: false },
      },
      pending_change: { strategy: 'next_reauth', state: 'pending', trigger: 'policy_update' },
    });
    expect(view.body.snapshot.effective.download_rate_kbps).toBe(10_000);
    interface Sent {
      name: string;
      device_enforced: boolean;
    }
    interface Field {
      field: string;
      device_enforced: boolean;
      evidence_level: string | null;
    }
    const sent = view.body.attributes_sent as Sent[];
    const fields = view.body.fields as Field[];
    expect(sent.map((a) => a.name)).toEqual(
      expect.arrayContaining(['WISPr-Bandwidth-Max-Down', 'Session-Timeout']),
    );
    // V12: nothing is device-enforced without a lab-validated device test.
    expect(sent.every((a) => !a.device_enforced)).toBe(true);
    expect(fields.every((x) => !x.device_enforced)).toBe(true);
    const rate = fields.find((x) => x.field === 'download_rate_kbps');
    expect(rate).toMatchObject({ set: true, mechanism: 'radius', device_enforced: false });
    expect(rate?.evidence_level).not.toBe('LAB_VALIDATED');

    const list = await f.agent.get(`/api/v1/orgs/${f.orgId}/session-enforcement?state=pending`);
    expect(list.status).toBe(200);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0]).toMatchObject({
      session_id: sessionId,
      pending_change: { strategy: 'next_reauth' },
      device_enforced_fields: [],
    });

    // Another tenant's admin: its own org path cannot see the session (RLS → 404), the foreign
    // org path is refused (403).
    const hidden = await other.agent.get(
      `/api/v1/orgs/${other.orgId}/sessions/${sessionId}/enforcement`,
    );
    expect(hidden.status).toBe(404);
    const foreign = await other.agent.get(`/api/v1/orgs/${f.orgId}/session-enforcement`);
    expect(foreign.status).toBe(403);
  });

  it('impact preview counts affected sessions and writes nothing', async () => {
    const apps = freshApps();
    const f = await orgFixture(apps);
    const ok = await login1(apps, f.nasIp, await subscriber(f.agent, f.orgId));
    const sessionId = sessionIdOf(ok);
    const preview = await f.agent
      .post(`/api/v1/orgs/${f.orgId}/policies/${f.policyId}/impact-preview`)
      .set(BROWSER)
      .send({ download_rate_kbps: 20_000 });
    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({
      evaluated_sessions: 1,
      affected_sessions: 1,
      by_strategy: { next_reauth: 1 },
      session_timeout_cap_s: 1800,
      truncated: false,
    });
    expect(preview.body.message).toBe(
      '1 session affected; strategy 1 next_reauth; next_reauth applies at next login, at most 30 min',
    );
    expect(preview.body.sessions[0]).toMatchObject({
      session_id: sessionId,
      strategy: 'next_reauth',
    });
    expect(preview.body.max_apply_latency_s).toBeGreaterThan(0);
    expect(preview.body.max_apply_latency_s).toBeLessThanOrEqual(1800);

    const none = await f.agent
      .post(`/api/v1/orgs/${f.orgId}/policies/${f.policyId}/impact-preview`)
      .set(BROWSER)
      .send({ name: 'only a name' });
    expect(none.body.affected_sessions).toBe(0);
    const del = await f.agent
      .post(`/api/v1/orgs/${f.orgId}/policies/${f.policyId}/impact-preview`)
      .set(BROWSER)
      .send({ delete: true });
    expect(del.body.affected_sessions).toBe(1);
    const invalid = await f.agent
      .post(`/api/v1/orgs/${f.orgId}/policies/${f.policyId}/impact-preview`)
      .set(BROWSER)
      .send({ session_timeout_s: 5 });
    expect(invalid.status).toBe(400);

    const written = await deps.dbPlatform
      .selectFrom('session_enforcement')
      .select('id')
      .where('session_id', '=', sessionId)
      .execute();
    expect(written).toHaveLength(0);
  });

  it('assignment create propagates to the targeted user only; delete reverts the pending change', async () => {
    const apps = freshApps();
    const f = await orgFixture(apps);
    const alice = await subscriber(f.agent, f.orgId);
    const bob = await subscriber(f.agent, f.orgId);
    const a = sessionIdOf(await login1(apps, f.nasIp, alice, 'AA-BB-CC-00-71-01'));
    const b = sessionIdOf(await login1(apps, f.nasIp, bob, 'AA-BB-CC-00-71-02'));
    const aliceRow = await deps.dbPlatform
      .selectFrom('users')
      .select('id')
      .where('organization_id', '=', f.orgId)
      .where('username', '=', alice)
      .executeTakeFirstOrThrow();
    const vip = await f.agent
      .post(`/api/v1/orgs/${f.orgId}/policies`)
      .set(BROWSER)
      .send({ name: 'VIP', scope_type: 'user', status: 'active', download_rate_kbps: 50_000 });
    expect(vip.status).toBe(201);
    const assign = await f.agent
      .post(`/api/v1/orgs/${f.orgId}/policy-assignments`)
      .set(BROWSER)
      .send({ policy_id: vip.body.id, target_type: 'user', target_id: aliceRow.id });
    expect(assign.status).toBe(201);
    expect(assign.body.enforcement).toMatchObject({ evaluated_sessions: 1, affected_sessions: 1 });
    const del = await f.agent
      .delete(`/api/v1/orgs/${f.orgId}/policy-assignments/${assign.body.id}`)
      .set(BROWSER);
    expect(del.status).toBe(204);
    const rows = await deps.dbPlatform
      .selectFrom('session_enforcement')
      .select(['session_id', 'trigger', 'state'])
      .where('session_id', 'in', [a, b])
      .orderBy('created_at')
      .execute();
    // Deleting the assignment brings alice back to the policy she was authorized with: the
    // pending change is closed as reverted (nothing left to apply); bob was never in scope.
    expect(rows).toEqual([{ session_id: a, trigger: 'assignment_create', state: 'superseded' }]);
    const reverted = await deps.dbPlatform
      .selectFrom('session_enforcement')
      .select('detail')
      .where('session_id', '=', a)
      .executeTakeFirstOrThrow();
    expect(reverted.detail).toMatchObject({ resolution: 'reverted' });
  });

  it('concurrency: a second open session over max_concurrent_sessions is rejected at authorize', async () => {
    const apps = freshApps();
    const f = await orgFixture(apps, { max_concurrent_sessions: 1 });
    const user = await subscriber(f.agent, f.orgId);
    expect((await login1(apps, f.nasIp, user, 'AA-BB-CC-00-72-01')).status).toBe(200);
    const second = await login1(apps, f.nasIp, user, 'AA-BB-CC-00-72-02');
    expect(second.status).toBe(401);
    expect(second.body['reply:Reply-Message'].value[0]).toBe('Too many active sessions');
  });

  it('review fix 3: beyond ENFORCEMENT_MAX_SESSIONS sessions are recorded unevaluated, never dropped', async () => {
    const apps = freshApps({ enforcementMaxSessions: 1 });
    const f = await orgFixture(apps);
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const ok = await login1(
        apps,
        f.nasIp,
        await subscriber(f.agent, f.orgId),
        `AA-BB-CC-00-73-0${String(i)}`,
      );
      ids.push(sessionIdOf(ok));
    }
    const changed = await f.agent
      .patch(`/api/v1/orgs/${f.orgId}/policies/${f.policyId}`)
      .set(BROWSER)
      .send({ download_rate_kbps: 25_000 });
    expect(changed.body.enforcement).toMatchObject({
      evaluated_sessions: 1,
      affected_sessions: 3,
      unevaluated_sessions: 2,
      truncated: true,
      by_strategy: { next_reauth: 3 },
    });
    const rows = await deps.dbPlatform
      .selectFrom('session_enforcement')
      .select(['session_id', 'state', 'detail', 'target_hash'])
      .where('session_id', 'in', ids)
      .execute();
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.state === 'pending')).toBe(true);
    expect(
      rows.filter((r) => (r.detail as { unevaluated?: boolean }).unevaluated === true),
    ).toHaveLength(2);
    const preview = await f.agent
      .post(`/api/v1/orgs/${f.orgId}/policies/${f.policyId}/impact-preview`)
      .set(BROWSER)
      .send({ download_rate_kbps: 30_000 });
    expect(preview.body).toMatchObject({
      evaluated_sessions: 1,
      unevaluated_sessions: 2,
      truncated: true,
    });
  });

  it("review fix 9: propagation never touches another organization's open sessions", async () => {
    const apps = freshApps();
    const a = await orgFixture(apps);
    const b = await orgFixture(apps);
    const sa = sessionIdOf(await login1(apps, a.nasIp, await subscriber(a.agent, a.orgId)));
    const sb = sessionIdOf(await login1(apps, b.nasIp, await subscriber(b.agent, b.orgId)));
    const changed = await a.agent
      .patch(`/api/v1/orgs/${a.orgId}/policies/${a.policyId}`)
      .set(BROWSER)
      .send({ download_rate_kbps: 40_000, is_default: true });
    expect(changed.status).toBe(200);
    expect(changed.body.enforcement).toMatchObject({ evaluated_sessions: 1, affected_sessions: 1 });
    expect(
      await deps.dbPlatform
        .selectFrom('session_enforcement')
        .select('id')
        .where('session_id', '=', sb)
        .execute(),
    ).toHaveLength(0);
    expect(
      await deps.dbPlatform
        .selectFrom('session_enforcement')
        .select('organization_id')
        .where('session_id', '=', sa)
        .execute(),
    ).toEqual([{ organization_id: a.orgId }]);
    const foreignEvents = await deps.dbPlatform
      .selectFrom('outbox')
      .select('event')
      .where('organization_id', '=', b.orgId)
      .where('event', 'in', ['policy.changed', 'session.enforcement_pending'])
      .execute();
    expect(foreignEvents).toHaveLength(0);
  });

  it('review fix 1: a pending runtime-breach row absorbs a policy change instead of being superseded', async () => {
    const apps = freshApps();
    const f = await orgFixture(apps);
    const sessionId = sessionIdOf(await login1(apps, f.nasIp, await subscriber(f.agent, f.orgId)));
    await deps.dbPlatform
      .insertInto('session_enforcement')
      .values({
        organization_id: f.orgId,
        session_id: sessionId,
        change_id: sessionId,
        trigger: 'quota_breach',
        strategy: 'next_reauth',
        reason: 'quota_total: 2000 >= 1000 bytes',
        detail: JSON.stringify({ triggers: ['quota_breach'] }),
      })
      .execute();
    const changed = await f.agent
      .patch(`/api/v1/orgs/${f.orgId}/policies/${f.policyId}`)
      .set(BROWSER)
      .send({ download_rate_kbps: 15_000 });
    expect(changed.body.enforcement).toMatchObject({ affected_sessions: 1, merged_sessions: 1 });
    const rows = await deps.dbPlatform
      .selectFrom('session_enforcement')
      .select(['trigger', 'state', 'detail'])
      .where('session_id', '=', sessionId)
      .execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ trigger: 'quota_breach', state: 'pending' });
    expect((rows[0]?.detail as { triggers: string[] }).triggers).toEqual([
      'quota_breach',
      'policy_update',
    ]);
    const view = await f.agent.get(`/api/v1/orgs/${f.orgId}/sessions/${sessionId}/enforcement`);
    expect(view.body.pending_change).toMatchObject({
      triggers: ['quota_breach', 'policy_update'],
      state_meaning: 'waiting: the session still runs with the policy it was authorized with',
      resolution: null,
    });
  });
});
