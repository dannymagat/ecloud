/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call -- supertest response bodies are untyped JSON */
/**
 * Phase 8 P8-A against `ecloud_test`: session list filters + keyset paging, session detail with
 * accounting timeline / anomalies / enforcement / operation availability, Disconnect and
 * Reauthorize gating (refused by default, lab mode queues, idempotent, audited, V12), usage per
 * subject with quota position and freshness, top-N, accounting record query bounds and site
 * scoping, CSV exports (Q75, D-027 impersonation, audit) and the platform retention dry run.
 * Skipped with a message when ECLOUD_TEST_DATABASE_URL is unset / unreachable.
 */
import { localDateKey } from '@ecloud/policy-engine';
import { newId } from '@ecloud/shared';
import { describeIntegration, migrateTestDatabase } from '@ecloud/testing';
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

await describeIntegration('@ecloud/api P8-A sessions & accounting against ecloud_test', () => {
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

  async function withMfa(agent: Agent): Promise<void> {
    const enrol = await agent.post('/api/v1/auth/mfa/enrol').set(BROWSER);
    const confirm = await agent
      .post('/api/v1/auth/mfa/confirm')
      .set(BROWSER)
      .send({ code: await generate({ secret: enrol.body.secret as string }) });
    expect(confirm.status).toBeLessThan(300);
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

  function sessionIdOf(res: request.Response): string {
    const hex = (res.body['reply:Class'].value[0] as string).slice(3);
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  /**
   * Org with two sites, a hostapd NAS on site A, a quota policy on site A, one subscriber with an
   * authorized → active session carrying accounting records, counters, an anomaly and an
   * enforcement row; plus a stopped session on site B.
   */
  async function fixture(apps: Apps) {
    const { orgId, siteId, siteId2 } = await createTenant(deps.dbPlatform);
    const admin = await createAdmin(deps.dbPlatform, [
      { template: 'org_admin', scope: 'organization', orgId },
    ]);
    const agent = await login(apps, admin);
    const nasIp = randomIp();
    const nas = await agent.post(`/api/v1/orgs/${orgId}/nas`).set(BROWSER).send({
      site_id: siteId,
      name: 'nas-a',
      nas_ip: nasIp,
      adapter_key: 'openwifi-hostapd-radius',
    });
    expect(nas.status).toBe(201);
    const nas2 = await agent.post(`/api/v1/orgs/${orgId}/nas`).set(BROWSER).send({
      site_id: siteId2,
      name: 'nas-b',
      nas_ip: randomIp(),
      adapter_key: 'coovachilli-uam',
    });
    expect(nas2.status).toBe(201);
    const policy = await agent.post(`/api/v1/orgs/${orgId}/policies`).set(BROWSER).send({
      name: 'Quota',
      scope_type: 'site',
      status: 'active',
      download_rate_kbps: 10_000,
      quota_daily_bytes: 100_000,
      quota_monthly_bytes: 1_000_000,
    });
    expect(policy.status).toBe(201);
    const assign = await agent
      .post(`/api/v1/orgs/${orgId}/policy-assignments`)
      .set(BROWSER)
      .send({ policy_id: policy.body.id, target_type: 'site', target_id: siteId });
    expect(assign.status).toBe(201);
    const username = unique('sub');
    const user = await agent
      .post(`/api/v1/orgs/${orgId}/users`)
      .set(BROWSER)
      .send({ username, password: 'sub-password-1', site_id: siteId });
    expect(user.status).toBe(201);
    const auth = await request(apps.internalApp)
      .post('/internal/aaa/authorize')
      .set('X-Internal-Token', TEST_INTERNAL_TOKEN)
      .send(
        radius({
          'User-Name': username,
          'User-Password': 'sub-password-1',
          'ECLOUD-Packet-Src-IP-Address': nasIp,
          'Calling-Station-Id': 'AA-BB-CC-00-80-01',
          'Acct-Session-Id': unique('acct'),
        }),
      );
    expect(auth.status).toBe(200);
    const sessionId = sessionIdOf(auth);

    // Simulate the drained accounting (the worker owns that path; its own suite covers it).
    const db = deps.dbPlatform;
    const now = new Date();
    const t0 = new Date(now.getTime() - 20 * 60_000);
    const t1 = new Date(now.getTime() - 10 * 60_000);
    const t2 = new Date(now.getTime() - 2 * 60_000);
    const s = await db
      .updateTable('sessions')
      .set({
        status: 'active',
        mac: 'aa:bb:cc:00:80:01',
        started_at: t0,
        last_interim_at: t2,
        input_octets: 3000,
        output_octets: 5000,
        session_time_s: 1080,
      })
      .where('id', '=', sessionId)
      .returning(['acct_session_id', 'acct_unique_id'])
      .executeTakeFirstOrThrow();
    const recs = [
      { status_type: 'start', received_at: t0, input_octets: 0, output_octets: 0 },
      { status_type: 'interim', received_at: t1, input_octets: 1000, output_octets: 2000 },
      { status_type: 'interim', received_at: t2, input_octets: 3000, output_octets: 5000 },
    ] as const;
    for (const r of recs) {
      await db
        .insertInto('accounting_records')
        .values({
          organization_id: orgId,
          session_id: sessionId,
          acct_unique_id: s.acct_unique_id,
          acct_session_id: s.acct_session_id,
          status_type: r.status_type,
          nas_ip: nasIp,
          username,
          calling_station_id: 'AA-BB-CC-00-80-01',
          event_time: r.received_at,
          received_at: r.received_at,
          input_octets: r.input_octets,
          output_octets: r.output_octets,
          session_time_s: Math.floor((r.received_at.getTime() - t0.getTime()) / 1000),
        })
        .execute();
    }
    const today = localDateKey(now, 'Asia/Dubai');
    const month = `${today.slice(0, 7)}-01`;
    for (const [subjectType, subjectId] of [
      ['user', user.body.id as string],
      ['site', siteId],
    ] as const) {
      for (const [periodType, periodStart] of [
        ['daily', today],
        ['monthly', month],
        ['total', '1970-01-01'],
      ] as const) {
        await db
          .insertInto('usage_counters')
          .values({
            organization_id: orgId,
            subject_type: subjectType,
            subject_id: subjectId,
            period_type: periodType,
            period_start: periodStart,
            bytes_in: 3000,
            bytes_out: 5000,
            session_count: 1,
            session_time_s: 1080,
          })
          .execute();
      }
    }
    await db
      .insertInto('accounting_anomalies')
      .values({
        organization_id: orgId,
        session_id: sessionId,
        nas_client_id: nas.body.id,
        adapter_key: 'openwifi-hostapd-radius',
        kind: 'counter_wrap_32bit',
        counter: 'inputOctets',
        previous: 4_000_000_000,
        observed: 100,
        estimated_lost_bytes: 0,
        applied: false,
        reason: 'test anomaly',
        radacct_id: Math.floor(Math.random() * 1e12),
      })
      .execute();
    await db
      .insertInto('session_enforcement')
      .values({
        organization_id: orgId,
        session_id: sessionId,
        change_id: newId(),
        trigger: 'policy_update',
        strategy: 'next_reauth',
        state: 'pending',
        reason: 'test enforcement row',
      })
      .execute();
    // A stopped session on site B (older).
    const stoppedId = newId();
    await db
      .insertInto('sessions')
      .values({
        id: stoppedId,
        organization_id: orgId,
        site_id: siteId2,
        nas_client_id: nas2.body.id,
        acct_session_id: unique('acct'),
        acct_unique_id: unique('uniq'),
        username_raw: 'guest-b',
        mac: 'aa:bb:cc:00:80:02',
        started_at: new Date(now.getTime() - 3 * 3600_000),
        stopped_at: new Date(now.getTime() - 2 * 3600_000),
        status: 'stopped',
        input_octets: 10,
        output_octets: 20,
      })
      .execute();
    await db
      .insertInto('accounting_records')
      .values({
        organization_id: orgId,
        session_id: stoppedId,
        acct_unique_id: 'u-b',
        acct_session_id: 'a-b',
        status_type: 'stop',
        nas_ip: nasIp,
        username: 'guest-b',
        received_at: new Date(now.getTime() - 2 * 3600_000),
        input_octets: 10,
        output_octets: 20,
      })
      .execute();
    return {
      orgId,
      siteId,
      siteId2,
      agent,
      admin,
      nasId: nas.body.id as string,
      userId: user.body.id as string,
      policyId: policy.body.id as string,
      username,
      sessionId,
      stoppedId,
    };
  }

  it('lists sessions with filters, keyset paging and freshness; detail carries the timeline', async () => {
    const apps = freshApps();
    const f = await fixture(apps);
    const all = await f.agent.get(`/api/v1/orgs/${f.orgId}/sessions?limit=1`);
    expect(all.status).toBe(200);
    expect(all.body.data).toHaveLength(1);
    expect(all.body.data[0].id).toBe(f.sessionId); // newest first
    expect(all.body.data[0]).toMatchObject({
      status: 'active',
      nas_name: 'nas-a',
      site_name: 'Site A',
      adapter_key: 'openwifi-hostapd-radius',
      policy_name: 'Quota',
      bytes_total: 8000,
    });
    expect(all.body.data[0].freshness_s).toBeGreaterThanOrEqual(100);
    expect(typeof all.body.measured_at).toBe('string');
    const page2 = await f.agent.get(
      `/api/v1/orgs/${f.orgId}/sessions?limit=1&cursor=${encodeURIComponent(all.body.next_cursor as string)}`,
    );
    expect(page2.body.data.map((r: { id: string }) => r.id)).toEqual([f.stoppedId]);
    expect(page2.body.next_cursor).toBeNull();

    const q = (qs: string) => f.agent.get(`/api/v1/orgs/${f.orgId}/sessions?${qs}`);
    expect((await q('open=true')).body.data.map((r: { id: string }) => r.id)).toEqual([
      f.sessionId,
    ]);
    expect((await q('status=stopped,stale')).body.data.map((r: { id: string }) => r.id)).toEqual([
      f.stoppedId,
    ]);
    expect((await q(`site_id=${f.siteId2}`)).body.data).toHaveLength(1);
    expect((await q('mac=AA-BB-CC-00-80-01')).body.data[0].id).toBe(f.sessionId);
    expect((await q(`username=${f.username}`)).body.data).toHaveLength(1);
    expect((await q(`user_id=${f.userId}`)).body.data).toHaveLength(1);
    const since = new Date(Date.now() - 3600_000).toISOString();
    expect((await q(`from=${encodeURIComponent(since)}`)).body.data).toHaveLength(1);
    expect((await q('status=bogus')).status).toBe(400);
    expect((await q('cursor=garbage')).status).toBe(400);

    const detail = await f.agent.get(`/api/v1/orgs/${f.orgId}/sessions/${f.sessionId}`);
    expect(detail.status).toBe(200);
    expect(detail.body.timeline.map((r: { status_type: string }) => r.status_type)).toEqual([
      'start',
      'interim',
      'interim',
    ]);
    expect(detail.body.timeline[2]).toMatchObject({
      delta_input_octets: 2000,
      delta_output_octets: 3000,
    });
    expect(detail.body.timeline_truncated).toBe(false);
    expect(detail.body.anomalies).toHaveLength(1);
    expect(detail.body.enforcement[0]).toMatchObject({ strategy: 'next_reauth', state: 'pending' });
    expect(detail.body.freshness.freshness_s).toBeGreaterThanOrEqual(100);
    expect(detail.body.nas).toMatchObject({ id: f.nasId, adapter_key: 'openwifi-hostapd-radius' });
    expect(detail.body.operations.disconnect).toMatchObject({
      available: false,
      permitted: true,
      code: 'dispatcher_disabled',
      device_enforced: false,
      dispatcher_enabled: false,
      evidence: { status: 'REQUIRES_DEVICE_TEST', device_enforced: false },
    });
    expect(detail.body.operations.reauthorize.permission).toBe('session:coa');

    // Tenant isolation: another org's admin gets 404.
    const other = await fixture(apps);
    expect(
      (await other.agent.get(`/api/v1/orgs/${other.orgId}/sessions/${f.sessionId}`)).status,
    ).toBe(404);
  });

  it('disconnect / reauthorize are refused (409, audited) unless the dispatcher is enabled', async () => {
    const apps = freshApps();
    const f = await fixture(apps);
    const res = await f.agent
      .post(`/api/v1/orgs/${f.orgId}/sessions/${f.sessionId}/disconnect`)
      .set(BROWSER)
      .send({ reason: 'abuse report' });
    expect(res.status).toBe(409);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body).toMatchObject({
      operation: 'disconnect',
      code: 'dispatcher_disabled',
      dispatcher_enabled: false,
      evidence: { device_enforced: false },
    });
    expect(res.body.reason).toContain('ECLOUD_COA_ENABLED=false');
    expect(await countAudit(deps.dbPlatform, 'session:disconnect_refused', f.sessionId)).toBe(1);
    const actions = await deps.dbPlatform
      .selectFrom('session_actions')
      .select('id')
      .where('session_id', '=', f.sessionId)
      .execute();
    expect(actions).toHaveLength(0);
    const stopped = await f.agent
      .post(`/api/v1/orgs/${f.orgId}/sessions/${f.stoppedId}/reauthorize`)
      .set(BROWSER)
      .send({});
    expect(stopped.status).toBe(409);
    expect(stopped.body.code).toBe('session_not_open');
  });

  it('lab mode queues an idempotent, audited action that is never device-enforced (V12)', async () => {
    const apps = freshApps({ coaEnabled: true });
    const f = await fixture(apps);
    const url = `/api/v1/orgs/${f.orgId}/sessions/${f.sessionId}`;
    const first = await f.agent.post(`${url}/disconnect`).set(BROWSER).send({ reason: 'lab test' });
    expect(first.status).toBe(202);
    expect(first.body).toMatchObject({
      deduplicated: false,
      mode: 'lab',
      device_enforced: false,
      session_action: { action: 'disconnect', status: 'pending', session_id: f.sessionId },
    });
    const again = await f.agent.post(`${url}/disconnect`).set(BROWSER).send({});
    expect(again.status).toBe(202);
    expect(again.body.deduplicated).toBe(true);
    expect(again.body.session_action.id).toBe(first.body.session_action.id);
    expect(await countAudit(deps.dbPlatform, 'session:disconnect', f.sessionId)).toBe(2);
    const events = await deps.dbPlatform
      .selectFrom('outbox')
      .select('event')
      .where('organization_id', '=', f.orgId)
      .where('event', '=', 'session.disconnect_requested')
      .execute();
    expect(events).toHaveLength(1);

    const coa = await f.agent.post(`${url}/reauthorize`).set(BROWSER).send({});
    expect(coa.status, JSON.stringify(coa.body)).toBe(202);
    expect(coa.body.session_action.action).toBe('coa_update');
    expect(coa.body.session_action.payload.plan).toBeUndefined(); // plan stays server-side
    const stored = await deps.dbPlatform
      .selectFrom('session_actions')
      .select('payload')
      .where('id', '=', coa.body.session_action.id)
      .executeTakeFirstOrThrow();
    expect((stored.payload as { plan: { adapter: string } }).plan.adapter).toBe(
      'openwifi-hostapd-radius',
    );
    const poll = await f.agent.get(
      `/api/v1/orgs/${f.orgId}/session-actions/${first.body.session_action.id as string}`,
    );
    expect(poll.status).toBe(200);
    expect(poll.body.status).toBe('pending');
    const detail = await f.agent.get(url);
    expect(detail.body.operations.disconnect).toMatchObject({
      available: true,
      mode: 'lab',
      device_enforced: false,
    });

    // Operator (site binding): may disconnect but holds no session:coa; Read Only may do neither.
    const operator = await login(
      apps,
      await createAdmin(deps.dbPlatform, [
        { template: 'operator', scope: 'site', orgId: f.orgId, siteId: f.siteId },
      ]),
    );
    expect((await operator.post(`${url}/reauthorize`).set(BROWSER).send({})).status).toBe(403);
    expect((await operator.post(`${url}/disconnect`).set(BROWSER).send({})).status).toBe(202);
    const readOnly = await login(
      apps,
      await createAdmin(deps.dbPlatform, [
        { template: 'read_only', scope: 'organization', orgId: f.orgId },
      ]),
    );
    expect((await readOnly.post(`${url}/disconnect`).set(BROWSER).send({})).status).toBe(403);
    const ro = await readOnly.get(url);
    expect(ro.body.operations.disconnect.permitted).toBe(false);
  });

  it('usage per user / site / organization with quota position and freshness; top-N', async () => {
    const apps = freshApps();
    const f = await fixture(apps);
    const base = `/api/v1/orgs/${f.orgId}/usage`;
    const user = await f.agent.get(`${base}?subject_type=user&subject_id=${f.userId}&period=daily`);
    expect(user.status).toBe(200);
    expect(user.body).toMatchObject({
      subject_type: 'user',
      label: f.username,
      timezone: 'Asia/Dubai',
      total: { bytes_total: 8000, session_count: 1 },
      current: { bytes_in: 3000, bytes_out: 5000 },
    });
    expect(user.body.series).toHaveLength(1);
    expect(user.body.quota).toMatchObject({ policy_id: f.policyId, policy_source: 'open_session' });
    expect(user.body.quota.periods).toEqual([
      expect.objectContaining({
        period: 'daily',
        limit_bytes: 100_000,
        used_bytes: 8000,
        remaining_bytes: 92_000,
        exceeded: false,
      }),
      expect.objectContaining({
        period: 'monthly',
        limit_bytes: 1_000_000,
        remaining_bytes: 992_000,
      }),
    ]);
    expect(typeof user.body.last_accounting_at).toBe('string');
    expect(user.body.freshness_s).toBeGreaterThanOrEqual(0);
    expect(user.body.expected_lag_s).toBeGreaterThan(0);

    const site = await f.agent.get(
      `${base}?subject_type=site&subject_id=${f.siteId}&period=monthly`,
    );
    expect(site.body).toMatchObject({ label: 'Site A', quota: null, total: { bytes_total: 8000 } });
    const org = await f.agent.get(`${base}?subject_type=organization&period=total`);
    expect(org.body).toMatchObject({ timezone: 'mixed', total: { bytes_total: 8000 } });
    expect((await f.agent.get(`${base}?subject_type=user`)).status).toBe(400);

    const top = await f.agent.get(`${base}/top?subject_type=user&period=total`);
    expect(top.status).toBe(200);
    expect(top.body.data[0]).toMatchObject({
      rank: 1,
      subject_id: f.userId,
      label: f.username,
      bytes_total: 8000,
    });
    const topSites = await f.agent.get(`${base}/top?subject_type=site&period=total`);
    expect(topSites.body.data[0]).toMatchObject({ subject_id: f.siteId, label: 'Site A' });

    // A site-bound operator of site B: no usage of site A (404) and no per-user top-N (403).
    const opB = await login(
      apps,
      await createAdmin(deps.dbPlatform, [
        { template: 'operator', scope: 'site', orgId: f.orgId, siteId: f.siteId2 },
      ]),
    );
    expect((await opB.get(`${base}?subject_type=site&subject_id=${f.siteId}`)).status).toBe(404);
    expect((await opB.get(`${base}/top?subject_type=user`)).status).toBe(403);
    expect((await opB.get(`${base}/top?subject_type=site&period=total`)).body.data).toEqual([]);
  });

  it('accounting records need a ≤ 31-day window, page by keyset and honour site scope', async () => {
    const apps = freshApps();
    const f = await fixture(apps);
    const base = `/api/v1/orgs/${f.orgId}/accounting/records`;
    expect((await f.agent.get(base)).status).toBe(400);
    const from = new Date(Date.now() - 24 * 3600_000).toISOString();
    const to = new Date(Date.now() + 60_000).toISOString();
    const tooWide = new Date(Date.now() - 40 * 86_400_000).toISOString();
    expect(
      (
        await f.agent.get(
          `${base}?from=${encodeURIComponent(tooWide)}&to=${encodeURIComponent(to)}`,
        )
      ).status,
    ).toBe(400);
    const window = `from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
    const p1 = await f.agent.get(`${base}?${window}&limit=2`);
    expect(p1.status).toBe(200);
    expect(p1.body.data).toHaveLength(2);
    const p2 = await f.agent.get(
      `${base}?${window}&limit=2&cursor=${encodeURIComponent(p1.body.next_cursor as string)}`,
    );
    const p3 = p2.body.next_cursor
      ? await f.agent.get(
          `${base}?${window}&limit=2&cursor=${encodeURIComponent(p2.body.next_cursor as string)}`,
        )
      : null;
    const ids = [...p1.body.data, ...p2.body.data, ...(p3?.body.data ?? [])].map(
      (r: { id: number }) => r.id,
    );
    expect(new Set(ids).size).toBe(4);
    const bySession = await f.agent.get(
      `${base}?${window}&session_id=${f.sessionId}&status_type=interim`,
    );
    expect(bySession.body.data).toHaveLength(2);

    const opA = await login(
      apps,
      await createAdmin(deps.dbPlatform, [
        { template: 'operator', scope: 'site', orgId: f.orgId, siteId: f.siteId },
      ]),
    );
    const scoped = await opA.get(`${base}?${window}`);
    expect(scoped.status).toBe(200);
    expect(
      scoped.body.data.every((r: { session_id: string }) => r.session_id === f.sessionId),
    ).toBe(true);
    expect(scoped.body.data).toHaveLength(3);
  });

  it('exports stream CSV for export holders, refuse Read Only (Q75) and impersonation (D-027), are audited', async () => {
    const apps = freshApps();
    const f = await fixture(apps);
    const body = {
      from: new Date(Date.now() - 24 * 3600_000).toISOString(),
      to: new Date(Date.now() + 60_000).toISOString(),
    };
    const res = await f.agent
      .post(`/api/v1/orgs/${f.orgId}/accounting/export`)
      .set(BROWSER)
      .send(body)
      .buffer(true)
      .parse((r, cb) => {
        let data = '';
        r.setEncoding('utf8');
        r.on('data', (c: string) => (data += c));
        r.on('end', () => cb(null, data));
      });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    const lines = (res.body as string).trim().split('\r\n');
    expect(lines[0]).toContain('received_at');
    expect(lines).toHaveLength(5); // header + 4 records, ascending
    expect(lines[1]).toContain(',stop,'); // site B session, two hours ago
    expect(lines[2]).toContain(',start,');
    const audits = await deps.dbPlatform
      .selectFrom('audit_logs')
      .select('after')
      .where('organization_id', '=', f.orgId)
      .where('action', '=', 'accounting:export')
      .execute();
    expect(audits).toHaveLength(1);
    expect((audits[0]?.after as { rows_at_start: number }).rows_at_start).toBe(4);
    const completed = await deps.dbPlatform
      .selectFrom('audit_logs')
      .select('after')
      .where('organization_id', '=', f.orgId)
      .where('action', '=', 'accounting:export_completed')
      .execute();
    expect(completed.map((a) => a.after)).toEqual([
      { format: 'csv', rows_at_start: 4, rows_emitted: 4, outcome: 'finished' },
    ]);

    const usage = await f.agent
      .post(`/api/v1/orgs/${f.orgId}/usage/export`)
      .set(BROWSER)
      .send({ subject_type: 'site', period: 'total' });
    expect(usage.status).toBe(200);
    expect(usage.text).toContain('Site A');
    expect(await countAudit(deps.dbPlatform, 'report:export', f.orgId)).toBe(0); // no target id
    const readOnly = await login(
      apps,
      await createAdmin(deps.dbPlatform, [
        { template: 'read_only', scope: 'organization', orgId: f.orgId },
      ]),
    );
    expect(
      (await readOnly.post(`/api/v1/orgs/${f.orgId}/accounting/export`).set(BROWSER).send(body))
        .status,
    ).toBe(403);
    expect(
      (
        await readOnly
          .post(`/api/v1/orgs/${f.orgId}/usage/export`)
          .set(BROWSER)
          .send({ subject_type: 'site' })
      ).status,
    ).toBe(403);
    expect(
      (
        await readOnly.get(
          `/api/v1/orgs/${f.orgId}/accounting/records?from=${encodeURIComponent(body.from)}&to=${encodeURIComponent(body.to)}`,
        )
      ).status,
    ).toBe(200);

    // Impersonating support admin: reads allowed, exports refused.
    const support = await login(
      apps,
      await createAdmin(deps.dbPlatform, [{ template: 'platform_support', scope: 'platform' }]),
    );
    await withMfa(support);
    const start = await support
      .post('/api/v1/platform/support/impersonate')
      .set(BROWSER)
      .send({ organizationId: f.orgId, reason: 'accounting ticket', ttlMinutes: 15 });
    expect(start.status).toBe(201);
    expect((await support.get(`/api/v1/orgs/${f.orgId}/sessions`)).status).toBe(200);
    const imp = await support
      .post(`/api/v1/orgs/${f.orgId}/accounting/export`)
      .set(BROWSER)
      .send(body);
    expect(imp.status).toBe(403);
    expect(imp.body.type).toContain('impersonation-forbidden');
  });

  it('site-local labels: an Auckland site past midnight keeps its own day; mixed zones need period_start', async () => {
    const setupApps = freshApps();
    const f = await fixture(setupApps);
    // 11:30 UTC on 8 Oct = 00:30 on 9 Oct in Auckland (NZDT, UTC+13), 15:30 in Dubai.
    const frozen = new Date('2026-10-08T11:30:00Z');
    const apps = createApp({ ...deps, now: () => frozen, kv: new MemoryKv() });
    const agent = await login(apps, f.admin);
    const auckland = newId();
    await deps.dbPlatform
      .insertInto('sites')
      .values({
        id: auckland,
        organization_id: f.orgId,
        slug: 'site-akl',
        name: 'Site AKL',
        timezone: 'Pacific/Auckland',
      })
      .execute();
    const counter = (
      subjectId: string,
      subjectType: 'site' | 'user',
      day: string,
      bytes: number,
    ) => ({
      organization_id: f.orgId,
      subject_type: subjectType,
      subject_id: subjectId,
      period_type: 'daily' as const,
      period_start: day,
      bytes_in: bytes,
      bytes_out: 0,
      session_count: 1,
      session_time_s: 60,
    });
    await deps.dbPlatform
      .insertInto('usage_counters')
      .values([
        counter(auckland, 'site', '2026-10-09', 900), // Auckland's current day
        counter(auckland, 'site', '2026-10-08', 50_000), // Auckland's previous day
        counter(f.siteId2, 'site', '2026-10-08', 400), // UTC site's current day
      ])
      .onConflict((oc) => oc.doNothing())
      .execute();
    const base = `/api/v1/orgs/${f.orgId}/usage`;
    const top = await agent.get(`${base}/top?subject_type=site&period=daily`);
    expect(top.status).toBe(200);
    expect(top.body.period_start).toBeNull(); // labels differ per site
    expect(top.body.label_basis).toContain('own timezone');
    const akl = top.body.data.find((r: { subject_id: string }) => r.subject_id === auckland);
    expect(akl).toMatchObject({ period_start: '2026-10-09', bytes_total: 900 });
    const utc = top.body.data.find((r: { subject_id: string }) => r.subject_id === f.siteId2);
    expect(utc).toMatchObject({ period_start: '2026-10-08', bytes_total: 400 });
    // Explicit label: matched as a site-local date for every site.
    const explicit = await agent.get(
      `${base}/top?subject_type=site&period=daily&period_start=2026-10-08`,
    );
    expect(explicit.body.period_start).toBe('2026-10-08');
    expect(explicit.body.data[0]).toMatchObject({ subject_id: auckland, bytes_total: 50_000 });
    // Users: counters carry the session site's TZ; three zones → no single current day.
    const users = await agent.get(`${base}/top?subject_type=user&period=daily`);
    expect(users.status).toBe(400);
    expect(JSON.stringify(users.body)).toContain('period_start is required');
    expect((await agent.get(`${base}/top?subject_type=user&period=total`)).status).toBe(200);
    // Organization across zones: no current bucket, with the reason.
    const org = await agent.get(`${base}?subject_type=organization&period=daily`);
    expect(org.status).toBe(200);
    expect(org.body).toMatchObject({ timezone: 'mixed', current: null });
    expect(org.body.current_unavailable_reason).toContain('several timezones');
    // The Auckland site itself reports its local current day.
    const site = await agent.get(`${base}?subject_type=site&subject_id=${auckland}&period=daily`);
    expect(site.body).toMatchObject({
      timezone: 'Pacific/Auckland',
      current: { period_start: '2026-10-09', bytes_total: 900 },
      current_unavailable_reason: null,
    });
  });

  it('refused exports do not consume the 10/hour export budget', async () => {
    const apps = freshApps();
    const f = await fixture(apps);
    const tooWide = {
      from: new Date(Date.now() - 40 * 86_400_000).toISOString(),
      to: new Date().toISOString(),
    };
    for (let i = 0; i < 12; i += 1) {
      const r = await f.agent
        .post(`/api/v1/orgs/${f.orgId}/accounting/export`)
        .set(BROWSER)
        .send(tooWide);
      expect(r.status).toBe(400);
    }
    const opB = await login(
      apps,
      await createAdmin(deps.dbPlatform, [
        { template: 'site_admin', scope: 'site', orgId: f.orgId, siteId: f.siteId2 },
      ]),
    );
    for (let i = 0; i < 12; i += 1) {
      const r = await opB
        .post(`/api/v1/orgs/${f.orgId}/usage/export`)
        .set(BROWSER)
        .send({ subject_type: 'user', period: 'total' });
      expect(r.status).toBe(403); // per-user counters need an organization-level grant
    }
    const ok = {
      from: new Date(Date.now() - 86_400_000).toISOString(),
      to: new Date(Date.now() + 60_000).toISOString(),
    };
    expect(
      (await f.agent.post(`/api/v1/orgs/${f.orgId}/accounting/export`).set(BROWSER).send(ok))
        .status,
    ).toBe(200);
    expect(
      (
        await opB
          .post(`/api/v1/orgs/${f.orgId}/usage/export`)
          .set(BROWSER)
          .send({ subject_type: 'site', period: 'total' })
      ).status,
    ).toBe(200);
    // The budget itself still applies: 10 successful exports, then 429.
    for (let i = 0; i < 9; i += 1) {
      await f.agent.post(`/api/v1/orgs/${f.orgId}/accounting/export`).set(BROWSER).send(ok);
    }
    expect(
      (await f.agent.post(`/api/v1/orgs/${f.orgId}/accounting/export`).set(BROWSER).send(ok))
        .status,
    ).toBe(429);
  });

  it('refused Disconnect attempts are capped at 30 per minute per principal (audit flood guard)', async () => {
    const apps = freshApps();
    const f = await fixture(apps);
    const url = `/api/v1/orgs/${f.orgId}/sessions/${f.sessionId}/disconnect`;
    for (let i = 0; i < 30; i += 1) {
      expect((await f.agent.post(url).set(BROWSER).send({})).status).toBe(409);
    }
    const over = await f.agent.post(url).set(BROWSER).send({});
    expect(over.status).toBe(429);
    expect(await countAudit(deps.dbPlatform, 'session:disconnect_refused', f.sessionId)).toBe(30);
  });

  it('platform retention dry run plans against current partitions; tenants are refused', async () => {
    const apps = freshApps();
    const f = await fixture(apps);
    expect((await f.agent.get('/api/v1/platform/retention/plan')).status).toBe(403);
    const sa = await login(
      apps,
      await createAdmin(deps.dbPlatform, [{ template: 'platform_super_admin', scope: 'platform' }]),
    );
    await withMfa(sa);
    const res = await sa.get('/api/v1/platform/retention/plan');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      mode: 'dry_run',
      policy: { raw_days: 7, accounting_months: 13, audit_months: 24 },
    });
    expect(res.body.partitions.length).toBeGreaterThan(0);
    const names = res.body.checks.map((c: { name: string }) => c.name);
    expect(names).toContain('accounting_records.current_month_partition');
    expect(
      res.body.checks.find(
        (c: { name: string }) => c.name === 'accounting_records.current_month_partition',
      ).ok,
    ).toBe(true);
  });
});
