/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument -- supertest response bodies are untyped JSON */
/**
 * Phase 9 P9-A against `ecloud_test`: the organization / site dashboard (sessions, usage,
 * auth outcomes, lockouts, enforcement, anomalies, observed NAS activity), zero-filled chart
 * series in the site timezone, reports as JSON and CSV (Q75, D-027, rate limit, audit, CSV
 * injection), the platform per-organization summary, and EXPLAIN evidence that the dashboard
 * aggregates use the migration 024 / 026 indexes. Data is seeded directly at a frozen clock.
 * Skipped with a message when ECLOUD_TEST_DATABASE_URL is unset / unreachable.
 */
import { withTenant } from '@ecloud/db';
import { newId } from '@ecloud/shared';
import { describeIntegration, migrateTestDatabase } from '@ecloud/testing';
import { sql, type RawBuilder } from 'kysely';
import { generate } from 'otplib';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from './app.js';
import type { AppDeps } from './context.js';
import {
  activeUsersQuery,
  activeUsersSince,
  openSessionCountsQuery,
  usersCreatedQuery,
  usersCreatedSince,
  type ReportScope,
} from './dashboard-queries.js';
import { localHourStart, siteTodayStarts } from './dashboard-views.js';
import { MemoryKv } from './kv.js';
import { REPORTS } from './routes/reports.js';
import {
  TEST_ORIGIN,
  closeDeps,
  createAdmin,
  createTenant,
  integrationDeps,
  unique,
  type AdminFixture,
} from './test-support/deps.js';

type Agent = ReturnType<typeof request.agent>;
type Apps = ReturnType<typeof createApp>;

const BROWSER = { Origin: TEST_ORIGIN, 'X-Requested-With': 'XMLHttpRequest' };
/** 16:00 in Dubai, 12:00 UTC: the same local day at both sites. */
const NOW = new Date('2026-10-08T12:00:00Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const MIN = 60_000;
const HOUR = 3_600_000;

await describeIntegration('@ecloud/api P9-A dashboard & reports against ecloud_test', () => {
  let deps: AppDeps;

  beforeAll(async () => {
    await migrateTestDatabase();
    deps = integrationDeps();
  }, 60_000);

  afterAll(async () => {
    await closeDeps(deps);
  });

  function apps(): Apps {
    return createApp({ ...deps, now: () => NOW, kv: new MemoryKv() });
  }

  async function login(a: Apps, admin: AdminFixture): Promise<Agent> {
    const agent = request.agent(a.publicApp);
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

  /**
   * Site A (Asia/Dubai) with NAS A (active: accounting 5 min ago) and NAS C (never seen), site B
   * (UTC) with NAS B (quiet: accounting 2 h ago). Sessions: A active + A authorized + B stopped +
   * B expired authorization. Auth events, portal attempts with one lockout, counters, an hourly
   * rollup row, a pending overdue enforcement and an anomaly.
   */
  async function fixture() {
    const db = deps.dbPlatform;
    const { orgId, siteId: siteA, siteId2: siteB } = await createTenant(db);
    const nas = (siteId: string, name: string) => ({
      id: newId(),
      organization_id: orgId,
      site_id: siteId,
      name,
      nas_ip: randomIp(),
      adapter_type_key: 'openwifi-hostapd-radius',
      adapter_key: 'openwifi-hostapd-radius',
      secret_ref: 'env:ECLOUD_API_IT_NAS_SECRET',
      created_at: ago(30 * 24 * HOUR),
    });
    const nasA = nas(siteA, 'nas-a');
    const nasB = nas(siteB, 'nas-b');
    const nasC = nas(siteA, 'nas-c');
    await db.insertInto('nas_clients').values([nasA, nasB, nasC]).execute();
    const session = (
      siteId: string,
      nasId: string,
      status: 'authorized' | 'active' | 'stopped' | 'expired',
      startedAt: Date,
      octets: number,
      mac: string,
    ) => ({
      id: newId(),
      organization_id: orgId,
      site_id: siteId,
      nas_client_id: nasId,
      acct_session_id: unique('as'),
      acct_unique_id: unique('au'),
      username_raw: 'subscriber',
      mac,
      started_at: startedAt,
      last_interim_at: status === 'active' ? ago(5 * MIN) : null,
      stopped_at: status === 'stopped' ? ago(2 * HOUR) : null,
      input_octets: octets,
      output_octets: octets * 2,
      session_time_s: 600,
      status,
    });
    const s1 = session(siteA, nasA.id, 'active', ago(HOUR), 1000, '02:00:00:00:00:01');
    const s2 = session(siteA, nasA.id, 'authorized', ago(5 * MIN), 0, '02:00:00:00:00:02');
    const s3 = session(siteB, nasB.id, 'stopped', ago(3 * HOUR), 500, '02:00:00:00:00:03');
    const s4 = session(siteB, nasB.id, 'expired', ago(10 * MIN), 0, '02:00:00:00:00:04');
    await db.insertInto('sessions').values([s1, s2, s3, s4]).execute();
    const authEvent = (
      nasRow: { id: string; nas_ip: string } | null,
      result: 'accept' | 'reject' | 'error',
      at: Date,
      reason: string | null = null,
      method: string | null = result === 'error' ? null : 'password',
    ) => ({
      organization_id: orgId,
      nas_client_id: nasRow?.id ?? null,
      nas_ip: nasRow?.nas_ip ?? null,
      username: 'subscriber',
      result,
      reason,
      auth_method: method,
      created_at: at,
    });
    await db
      .insertInto('auth_events')
      .values([
        authEvent(nasA, 'accept', ago(10 * MIN)),
        authEvent(nasA, 'accept', ago(10 * MIN)),
        authEvent(nasA, 'accept', ago(70 * MIN)),
        authEvent(nasA, 'reject', ago(20 * MIN), 'bad_credentials'),
        authEvent(nasA, 'reject', ago(20 * MIN), 'bad_credentials'),
        // free-text module message echoing a username (must never reach tenants), and a
        // spreadsheet formula in the method (CSV injection)
        authEvent(
          nasA,
          'reject',
          ago(25 * MIN),
          'Login incorrect (pap: Invalid user alice-secret-id)',
          '=HYPERLINK("http://evil")',
        ),
        authEvent(nasB, 'reject', ago(30 * HOUR), 'voucher_exhausted'),
        authEvent(nasB, 'accept', ago(3 * 24 * HOUR)),
        authEvent(null, 'error', ago(15 * MIN)), // organization-level: no NAS row
      ])
      .execute();
    await db
      .insertInto('accounting_records')
      .values([
        {
          organization_id: orgId,
          session_id: s1.id,
          acct_unique_id: s1.acct_unique_id,
          acct_session_id: s1.acct_session_id,
          status_type: 'interim',
          nas_ip: nasA.nas_ip,
          received_at: ago(5 * MIN),
        },
        {
          organization_id: orgId,
          session_id: s3.id,
          acct_unique_id: s3.acct_unique_id,
          acct_session_id: s3.acct_session_id,
          status_type: 'stop',
          nas_ip: nasB.nas_ip,
          received_at: ago(2 * HOUR),
        },
      ])
      .execute();
    const portalId = newId();
    await db
      .insertInto('captive_portals')
      .values({
        id: portalId,
        organization_id: orgId,
        site_id: siteA,
        name: 'Lobby',
        public_slug: unique('p')
          .toLowerCase()
          .replace(/[^a-z0-9-]/g, '')
          .slice(0, 60),
        portal_type: 'uspot',
        network_ref: 'guest',
        auth_methods: ['password', 'voucher'],
      })
      .execute();
    const attempt = (
      method: string,
      result: 'accept' | 'reject',
      at: Date,
      lock = false,
      reason: string | null = null,
    ) => ({
      organization_id: orgId,
      captive_portal_id: portalId,
      method,
      result,
      reason,
      triggered_lockout: lock,
      created_at: at,
    });
    await db
      .insertInto('portal_login_attempts')
      .values([
        attempt('password', 'accept', ago(30 * MIN)),
        attempt('voucher', 'reject', ago(40 * MIN), false, 'voucher_invalid'),
        attempt('voucher', 'reject', ago(40 * MIN), true, 'voucher_invalid'),
      ])
      .execute();
    const counter = (
      siteId: string,
      period: 'daily' | 'monthly',
      start: string,
      bytes: number,
    ) => ({
      organization_id: orgId,
      subject_type: 'site' as const,
      subject_id: siteId,
      period_type: period,
      period_start: start,
      bytes_in: bytes,
      bytes_out: bytes,
      session_count: 1,
      session_time_s: 60,
    });
    await db
      .insertInto('usage_counters')
      .values([
        counter(siteA, 'daily', '2026-10-08', 5000),
        counter(siteA, 'daily', '2026-10-07', 1000),
        counter(siteA, 'monthly', '2026-10-01', 6000),
        counter(siteB, 'daily', '2026-10-08', 300),
        counter(siteB, 'monthly', '2026-10-01', 300),
      ])
      .execute();
    await db
      .insertInto('usage_hourly')
      .values({
        organization_id: orgId,
        site_id: siteA,
        hour_start: localHourStart(ago(90 * MIN), 'Asia/Dubai'),
        bytes_in: 700,
        bytes_out: 1300,
        session_count: 1,
        session_time_s: 300,
      })
      .execute();
    await db
      .insertInto('session_enforcement')
      .values({
        organization_id: orgId,
        session_id: s1.id,
        change_id: newId(),
        trigger: 'policy_update',
        strategy: 'next_reauth',
        reason: 'policy changed',
        expected_apply_by: ago(MIN),
      })
      .execute();
    await db
      .insertInto('accounting_anomalies')
      .values({
        organization_id: orgId,
        session_id: s1.id,
        nas_client_id: nasA.id,
        adapter_key: 'openwifi-hostapd-radius',
        kind: 'counter_wrap_32bit',
        counter: 'inputOctets',
        previous: 4_000_000_000,
        observed: 10,
        estimated_lost_bytes: 4096,
        applied: true,
        reason: 'wrap',
        radacct_id: Math.floor(Math.random() * 1e12),
        created_at: ago(30 * MIN),
      })
      .execute();
    // A deleted site with live data: excluded everywhere (dashboard, series, reports, platform).
    const siteD = newId();
    await db
      .insertInto('sites')
      .values({
        id: siteD,
        organization_id: orgId,
        slug: 'site-d',
        name: 'Site D',
        timezone: 'UTC',
        deleted_at: ago(HOUR),
      })
      .execute();
    const nasD = nas(siteD, 'nas-d');
    await db.insertInto('nas_clients').values(nasD).execute();
    await db
      .insertInto('sessions')
      .values(session(siteD, nasD.id, 'active', ago(HOUR), 9999, '02:00:00:00:00:0d'))
      .execute();
    await db
      .insertInto('auth_events')
      .values([
        authEvent(nasD, 'accept', ago(10 * MIN)),
        authEvent(nasD, 'reject', ago(10 * MIN), 'x'),
      ])
      .execute();
    await db
      .insertInto('usage_counters')
      .values(counter(siteD, 'daily', '2026-10-08', 777))
      .execute();
    await db
      .insertInto('usage_hourly')
      .values({
        organization_id: orgId,
        site_id: siteD,
        hour_start: localHourStart(ago(90 * MIN), 'UTC'),
        bytes_in: 777,
      })
      .execute();
    // NAS IP reuse: accounting for NAS C's IP from before NAS C existed belongs to an earlier NAS.
    await db
      .insertInto('accounting_records')
      .values({
        organization_id: orgId,
        acct_unique_id: unique('au'),
        acct_session_id: unique('as'),
        status_type: 'interim',
        nas_ip: nasC.nas_ip,
        received_at: ago(40 * 24 * HOUR),
      })
      .execute();
    const a = apps();
    const admin = await createAdmin(db, [{ template: 'org_admin', scope: 'organization', orgId }]);
    return { a, orgId, siteA, siteB, nasA, nasB, nasC, agent: await login(a, admin) };
  }

  let f: Awaited<ReturnType<typeof fixture>>;
  beforeAll(async () => {
    f = await fixture();
  }, 60_000);

  describe('organization dashboard', () => {
    it('returns every block in one call, scoped to the organization', async () => {
      const res = await f.agent.get(`/api/v1/orgs/${f.orgId}/dashboard`);
      expect(res.status).toBe(200);
      const d = res.body;
      expect(d.timezone).toBe('mixed');
      expect(d.sites.map((s: { name: string }) => s.name)).toEqual(['Site A', 'Site B']);
      expect(d.window).toEqual({
        key: '24h',
        from: '2026-10-07T12:00:00.000Z',
        to: NOW.toISOString(),
      });
      expect(d.sessions).toMatchObject({ open: 2, authorized: 1, active: 1, started_today: 3 });
      expect(d.usage.today).toEqual({
        bytes_in: 5300,
        bytes_out: 5300,
        bytes_total: 10_600,
        session_count: 2,
        session_time_s: 120,
      });
      expect(d.usage.month.bytes_total).toBe(12_600);
      expect(d.usage.last_accounting_at).not.toBeNull();
      expect(d.auth.radius).toMatchObject({
        total: 7,
        accept: 3,
        reject: 3,
        error: 1,
        challenge: 0,
      });
      expect(d.auth.portal).toMatchObject({ total: 3, accept: 1, reject: 2, lockouts: 1 });
      expect(d.auth.portal.by_method).toEqual([
        { method: 'voucher', total: 2, accept: 0, reject: 2, error: 0, lockouts: 1 },
        { method: 'password', total: 1, accept: 1, reject: 0, error: 0, lockouts: 0 },
      ]);
      expect(d.auth.top_reject_reasons[0]).toEqual({
        source: 'radius',
        reason: 'bad_credentials',
        count: 2,
      });
      expect(d.enforcement).toMatchObject({ pending: 1, overdue: 1 });
      expect(d.anomalies).toEqual({ count: 1, estimated_lost_bytes: 4096 });
      expect(d.nas_activity.thresholds).toEqual({ active_within_s: 1200, quiet_within_s: 86_400 });
      expect(d.nas_activity.counts).toEqual({
        registered: 3,
        active: 1,
        quiet: 1,
        silent: 0,
        never: 1,
      });
      const byName = Object.fromEntries(
        d.nas_activity.data.map((n: { name: string }) => [n.name, n]),
      );
      expect(byName['nas-a']).toMatchObject({
        activity: 'active',
        open_sessions: 2,
        last_accounting_at: ago(5 * MIN).toISOString(),
        last_auth_request_at: ago(10 * MIN).toISOString(),
      });
      expect(byName['nas-b']).toMatchObject({ activity: 'quiet', open_sessions: 0 });
      expect(byName['nas-c']).toMatchObject({ activity: 'never', last_activity_at: null });
      expect(d.network_devices.online_status_known).toBe(0);
      expect(JSON.stringify(d)).not.toMatch(/"(online|offline)"/);
      // free-text RADIUS messages are reduced to a code; deleted sites are absent
      expect(d.auth.top_reject_reasons).toContainEqual({
        source: 'radius',
        reason: 'module_message',
        count: 1,
      });
      expect(JSON.stringify(d)).not.toContain('alice-secret-id');
      expect(JSON.stringify(d)).not.toMatch(/Site D|nas-d/);
    });

    it('site dashboard and site-scoped callers see only their sites', async () => {
      const site = await f.agent.get(`/api/v1/orgs/${f.orgId}/dashboard?site_id=${f.siteB}`);
      expect(site.status).toBe(200);
      expect(site.body.timezone).toBe('UTC');
      expect(site.body.sessions).toMatchObject({ open: 0, started_today: 1 });
      // the organization-level RADIUS error (no NAS row) is not part of a site
      expect(site.body.auth.radius.total).toBe(0);
      expect(site.body.nas_activity.data.map((n: { name: string }) => n.name)).toEqual(['nas-b']);

      const siteAdmin = await login(
        f.a,
        await createAdmin(deps.dbPlatform, [
          { template: 'site_admin', scope: 'site', orgId: f.orgId, siteId: f.siteB },
        ]),
      );
      const own = await siteAdmin.get(`/api/v1/orgs/${f.orgId}/dashboard`);
      expect(own.status).toBe(200);
      expect(own.body.sites.map((s: { id: string }) => s.id)).toEqual([f.siteB]);
      expect(own.body.nas_activity.counts.registered).toBe(1);
      expect(own.body.auth.radius.total).toBe(0);
      expect(
        (await siteAdmin.get(`/api/v1/orgs/${f.orgId}/dashboard?site_id=${f.siteA}`)).status,
      ).toBe(404);
      const other = await createTenant(deps.dbPlatform);
      expect((await f.agent.get(`/api/v1/orgs/${other.orgId}/dashboard`)).status).toBe(403);
    });
  });

  describe('subscriber aggregates (active users, new users today)', () => {
    /**
     * Org X: site A (Asia/Dubai, local midnight 2026-10-07T20:00Z) and site B (UTC). Org Y holds
     * look-alike rows that must never be counted for org X (RLS + organization filter).
     */
    async function subscribers() {
      const db = deps.dbPlatform;
      const x = await createTenant(db);
      const y = await createTenant(db);
      const at = (iso: string) => new Date(iso);
      const user = (
        orgId: string,
        siteId: string | null,
        createdAt: Date,
        deleted: boolean = false,
      ) => ({
        id: newId(),
        organization_id: orgId,
        site_id: siteId,
        username: unique('sub').toLowerCase(),
        created_at: createdAt,
        deleted_at: deleted ? ago(MIN) : null,
      });
      const uA1 = user(x.orgId, x.siteId, ago(2 * HOUR));
      const uA2 = user(x.orgId, x.siteId, at('2026-10-07T21:00:00Z')); // after Dubai midnight
      const uA3 = user(x.orgId, x.siteId, at('2026-10-07T19:00:00Z')); // before Dubai midnight
      const uB1 = user(x.orgId, x.siteId2, at('2026-10-07T21:00:00Z')); // before UTC midnight
      const uB2 = user(x.orgId, x.siteId2, ago(HOUR));
      const uOrg = user(x.orgId, null, ago(HOUR)); // organization-wide subscriber
      const uDel = user(x.orgId, x.siteId, ago(HOUR), true);
      const yUsers = [
        user(y.orgId, y.siteId, ago(HOUR)),
        user(y.orgId, y.siteId2, ago(HOUR)),
        user(y.orgId, null, ago(HOUR)),
      ];
      await db
        .insertInto('users')
        .values([uA1, uA2, uA3, uB1, uB2, uOrg, uDel, ...yUsers])
        .execute();
      const nasRow = (orgId: string, siteId: string) => ({
        id: newId(),
        organization_id: orgId,
        site_id: siteId,
        name: unique('nas'),
        nas_ip: randomIp(),
        adapter_type_key: 'openwifi-hostapd-radius',
        adapter_key: 'openwifi-hostapd-radius',
        secret_ref: 'env:ECLOUD_API_IT_NAS_SECRET',
      });
      const nasA = nasRow(x.orgId, x.siteId);
      const nasB = nasRow(x.orgId, x.siteId2);
      const nasY = nasRow(y.orgId, y.siteId);
      await db.insertInto('nas_clients').values([nasA, nasB, nasY]).execute();
      const session = (
        orgId: string,
        siteId: string,
        nasId: string,
        userId: string | null,
        status: 'authorized' | 'active' | 'stopped' | 'expired',
        startedAt: Date,
        mac: string,
      ) => ({
        id: newId(),
        organization_id: orgId,
        site_id: siteId,
        nas_client_id: nasId,
        user_id: userId,
        acct_session_id: unique('as'),
        acct_unique_id: unique('au'),
        username_raw: 'subscriber',
        mac,
        started_at: startedAt,
        stopped_at: status === 'stopped' ? ago(HOUR) : null,
        status,
      });
      await db
        .insertInto('sessions')
        .values([
          session(
            x.orgId,
            x.siteId,
            nasA.id,
            uA1.id,
            'stopped',
            ago(5 * 24 * HOUR),
            '02:aa:00:00:00:01',
          ),
          // open for 40 days: still an active user
          session(
            x.orgId,
            x.siteId,
            nasA.id,
            uA2.id,
            'active',
            ago(40 * 24 * HOUR),
            '02:aa:00:00:00:02',
          ),
          // a session without a subscriber record: a device, not a user
          session(x.orgId, x.siteId, nasA.id, null, 'active', ago(HOUR), '02:aa:00:00:00:03'),
          // expired authorization: not a session (D-036)
          session(x.orgId, x.siteId, nasA.id, uA3.id, 'expired', ago(HOUR), '02:aa:00:00:00:04'),
          // a soft-deleted subscriber's open session: a device, never an (active / open) user
          session(x.orgId, x.siteId, nasA.id, uDel.id, 'active', ago(HOUR), '02:aa:00:00:00:07'),
          // last session 40 days ago: not active
          session(
            x.orgId,
            x.siteId2,
            nasB.id,
            uB1.id,
            'stopped',
            ago(40 * 24 * HOUR),
            '02:aa:00:00:00:05',
          ),
          // two sessions of one subscriber count once
          session(x.orgId, x.siteId2, nasB.id, uB2.id, 'active', ago(HOUR), '02:aa:00:00:00:06'),
          session(
            x.orgId,
            x.siteId2,
            nasB.id,
            uB2.id,
            'stopped',
            ago(48 * HOUR),
            '02:aa:00:00:00:06',
          ),
          // org Y: open sessions of its own subscribers
          session(
            y.orgId,
            y.siteId,
            nasY.id,
            yUsers[0]!.id,
            'active',
            ago(HOUR),
            '02:bb:00:00:00:01',
          ),
          session(
            y.orgId,
            y.siteId,
            nasY.id,
            yUsers[1]!.id,
            'active',
            ago(HOUR),
            '02:bb:00:00:00:02',
          ),
        ])
        .execute();
      const a = apps();
      const adminX = await createAdmin(db, [
        { template: 'org_admin', scope: 'organization', orgId: x.orgId },
      ]);
      const adminY = await createAdmin(db, [
        { template: 'org_admin', scope: 'organization', orgId: y.orgId },
      ]);
      return { a, x, y, agentX: await login(a, adminX), agentY: await login(a, adminY) };
    }

    let s: Awaited<ReturnType<typeof subscribers>>;
    beforeAll(async () => {
      s = await subscribers();
    }, 60_000);

    it('counts distinct active and new subscribers of the organization, site-local today', async () => {
      const res = await s.agentX.get(`/api/v1/orgs/${s.x.orgId}/dashboard`);
      expect(res.status).toBe(200);
      expect(res.body.users).toMatchObject({ active_window_days: 30, active: 3, new_today: 4 });
      expect(res.body.users.new_today_basis).toMatch(/local midnight/);
      expect(res.body.sessions).toMatchObject({ open: 4, open_users: 2, open_devices: 4 });
    });

    it('honours the site filter (site-less subscribers only organization-wide)', async () => {
      const a = await s.agentX.get(`/api/v1/orgs/${s.x.orgId}/dashboard?site_id=${s.x.siteId}`);
      expect(a.status).toBe(200);
      expect(a.body.users).toMatchObject({ active: 2, new_today: 2 });
      expect(a.body.sessions).toMatchObject({ open_users: 1, open_devices: 3 });
      const b = await s.agentX.get(`/api/v1/orgs/${s.x.orgId}/dashboard?site_id=${s.x.siteId2}`);
      expect(b.body.users).toMatchObject({ active: 1, new_today: 1 });
      expect(b.body.sessions).toMatchObject({ open_users: 1, open_devices: 1 });
    });

    it("one organization never counts another organization's subscribers (RLS isolation)", async () => {
      const y = await s.agentY.get(`/api/v1/orgs/${s.y.orgId}/dashboard`);
      expect(y.status).toBe(200);
      expect(y.body.users).toMatchObject({ active: 2, new_today: 3 });
      expect(y.body.sessions).toMatchObject({ open_users: 2, open_devices: 2 });
      // X's administrator cannot read Y's figures at all
      expect((await s.agentX.get(`/api/v1/orgs/${s.y.orgId}/dashboard`)).status).toBe(403);

      // The queries themselves, run in Y's tenant transaction with a scope naming X: RLS hides
      // every X row (second lock, MULTITENANCY.md G6), so the counts are 0, not X's figures.
      const scopeX: ReportScope = {
        orgId: s.x.orgId,
        siteId: null,
        sites: [
          { id: s.x.siteId, name: 'Site A', timezone: 'Asia/Dubai' },
          { id: s.x.siteId2, name: 'Site B', timezone: 'UTC' },
        ],
        allSites: true,
        timezone: 'mixed',
      };
      const utcMidnight = new Date('2026-10-08T00:00:00Z');
      const since = ago(30 * 24 * HOUR);
      const counts = (orgId: string) =>
        withTenant(deps.db, orgId, async (trx) => ({
          active: await activeUsersSince(trx, scopeX, since),
          created: await usersCreatedSince(
            trx,
            scopeX,
            siteTodayStarts(scopeX.sites, NOW),
            utcMidnight,
          ),
        }));
      expect(await counts(s.y.orgId)).toEqual({ active: 0, created: 0 });
      expect(await counts(s.x.orgId)).toEqual({ active: 3, created: 4 });
    });

    it('a site-bound administrator counts only subscribers of their site', async () => {
      const siteAdmin = await login(
        s.a,
        await createAdmin(deps.dbPlatform, [
          { template: 'site_admin', scope: 'site', orgId: s.x.orgId, siteId: s.x.siteId2 },
        ]),
      );
      const res = await siteAdmin.get(`/api/v1/orgs/${s.x.orgId}/dashboard`);
      expect(res.status).toBe(200);
      // site B only: the organization-wide subscriber is not part of a site scope
      expect(res.body.users).toMatchObject({ active: 1, new_today: 1 });
    });
  });

  describe('chart series', () => {
    it('hourly auth outcomes are zero-filled local hours and need one timezone', async () => {
      const mixed = await f.agent.get(`/api/v1/orgs/${f.orgId}/dashboard/series/auth`);
      expect(mixed.status).toBe(400);
      const res = await f.agent.get(
        `/api/v1/orgs/${f.orgId}/dashboard/series/auth?site_id=${f.siteA}`,
      );
      expect(res.status).toBe(200);
      expect(res.body.timezone).toBe('Asia/Dubai');
      expect(res.body.buckets).toHaveLength(24);
      expect(res.body.buckets[23].label).toBe('2026-10-08 15:00');
      expect(res.body.totals).toMatchObject({
        radius_accept: 3,
        radius_reject: 3,
        portal_accept: 1,
        portal_reject: 2,
        portal_lockouts: 1,
      });
      const last = res.body.buckets[23];
      expect(last).toMatchObject({ radius_accept: 2, radius_reject: 3, portal_reject: 2 });
      expect(
        res.body.buckets.filter((b: { radius_accept: number }) => b.radius_accept === 0),
      ).toHaveLength(22);
    });

    it('daily auth outcomes across timezones use each site’s local days', async () => {
      const res = await f.agent.get(
        `/api/v1/orgs/${f.orgId}/dashboard/series/auth?granularity=day&from=2026-10-01&to=2026-10-08`,
      );
      expect(res.status).toBe(200);
      expect(res.body.timezone).toBe('mixed');
      expect(res.body.buckets.map((b: { label: string }) => b.label)).toEqual([
        '2026-10-01',
        '2026-10-02',
        '2026-10-03',
        '2026-10-04',
        '2026-10-05',
        '2026-10-06',
        '2026-10-07',
        '2026-10-08',
      ]);
      const byDay = Object.fromEntries(
        res.body.buckets.map((b: { label: string }) => [b.label, b]),
      );
      expect(byDay['2026-10-05'].radius_accept).toBe(1); // NAS B, 3 days ago (UTC site)
      expect(byDay['2026-10-07'].radius_reject).toBe(1); // NAS B, 30 h ago
      expect(byDay['2026-10-08']).toMatchObject({
        radius_accept: 3,
        radius_reject: 3,
        radius_error: 1,
      });
      expect(
        (
          await f.agent.get(
            `/api/v1/orgs/${f.orgId}/dashboard/series/auth?granularity=day&from=2025-09-01&to=2026-10-08`,
          )
        ).status,
      ).toBe(400);
    });

    it('usage series read the hourly rollup and the daily site counters with freshness', async () => {
      const hour = await f.agent.get(
        `/api/v1/orgs/${f.orgId}/dashboard/series/usage?site_id=${f.siteA}`,
      );
      expect(hour.status).toBe(200);
      expect(hour.body.source).toBe('usage_hourly');
      expect(hour.body.buckets).toHaveLength(24);
      expect(hour.body.totals.bytes_total).toBe(2000);
      const filled = hour.body.buckets.filter((b: { bytes_total: number }) => b.bytes_total > 0);
      expect(filled).toEqual([
        expect.objectContaining({
          bucket_start: localHourStart(ago(90 * MIN), 'Asia/Dubai').toISOString(),
          bytes_in: 700,
          bytes_out: 1300,
        }),
      ]);
      expect(hour.body).toHaveProperty('expected_lag_s');
      const day = await f.agent.get(
        `/api/v1/orgs/${f.orgId}/dashboard/series/usage?granularity=day&from=2026-10-07&to=2026-10-08`,
      );
      expect(day.status).toBe(200);
      expect(day.body.source).toBe('usage_counters');
      expect(
        day.body.buckets.map((b: { label: string; bytes_in: number }) => [b.label, b.bytes_in]),
      ).toEqual([
        ['2026-10-07', 1000],
        ['2026-10-08', 5300],
      ]);
    });
  });

  describe('reports', () => {
    it('lists definitions and runs each report as JSON', async () => {
      const list = await f.agent.get(`/api/v1/orgs/${f.orgId}/reports`);
      expect(list.status).toBe(200);
      expect(list.body.data.map((r: { key: string }) => r.key)).toEqual([
        'usage_by_site',
        'auth_outcomes',
        'session_summary',
        'nas_activity',
      ]);
      const usage = await f.agent.get(
        `/api/v1/orgs/${f.orgId}/reports/usage_by_site?from=2026-10-07&to=2026-10-08`,
      );
      expect(usage.status).toBe(200);
      expect(usage.body.rows).toEqual([
        expect.objectContaining({
          site_name: 'Site A',
          period_start: '2026-10-07',
          bytes_in: 1000,
        }),
        expect.objectContaining({
          site_name: 'Site A',
          period_start: '2026-10-08',
          bytes_in: 5000,
        }),
        expect.objectContaining({ site_name: 'Site B', period_start: '2026-10-08', bytes_in: 300 }),
      ]);
      expect(usage.body.freshness).not.toBeNull();
      const auth = await f.agent.get(
        `/api/v1/orgs/${f.orgId}/reports/auth_outcomes?from=2026-10-08&to=2026-10-08`,
      );
      expect(auth.status).toBe(200);
      expect(auth.body.rows).toContainEqual(
        expect.objectContaining({
          source: 'portal',
          method: 'voucher',
          result: 'reject',
          count: 2,
          lockouts: 1,
          site_name: 'Site A',
        }),
      );
      expect(auth.body.rows).toContainEqual(
        expect.objectContaining({ source: 'radius', result: 'error', site_id: null, count: 1 }),
      );
      const sessions = await f.agent.get(
        `/api/v1/orgs/${f.orgId}/reports/session_summary?from=2026-10-08&to=2026-10-08`,
      );
      expect(sessions.status).toBe(200);
      expect(sessions.body.rows).toEqual([
        expect.objectContaining({
          site_name: 'Site A',
          sessions_started: 2,
          still_open: 2,
          distinct_devices: 2,
          bytes_in: 1000,
        }),
        expect.objectContaining({ site_name: 'Site B', sessions_started: 1, still_open: 0 }),
      ]);
      const nas = await f.agent.get(`/api/v1/orgs/${f.orgId}/reports/nas_activity`);
      expect(nas.status).toBe(200);
      expect(nas.body.rows.find((r: { name: string }) => r.name === 'nas-a')).toMatchObject({
        activity: 'active',
        auth_accept: 3,
        auth_reject: 3,
        sessions_started: 2,
      });
      expect((await f.agent.get(`/api/v1/orgs/${f.orgId}/reports/nope`)).status).toBe(404);
    });

    it('exports CSV with the P8 guard: Read Only refused, impersonation refused, audited, injection-safe, rate limited', async () => {
      const res = await f.agent
        .post(`/api/v1/orgs/${f.orgId}/reports/auth_outcomes/export`)
        .set(BROWSER)
        .send({ from: '2026-10-08', to: '2026-10-08' });
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/csv');
      expect(res.headers['content-disposition']).toContain('report-auth_outcomes-2026-10-08.csv');
      const lines = res.text.trim().split('\r\n');
      expect(lines[0]).toBe(
        'period_start,site_id,site_name,source,method,result,reason,count,lockouts',
      );
      expect(res.text).toContain(`"'=HYPERLINK(""http://evil"")"`);
      expect(res.text).toContain(',module_message,');
      expect(res.text).not.toContain('alice-secret-id');
      expect(res.text).not.toContain('Site D');
      const audits = await deps.dbPlatform
        .selectFrom('audit_logs')
        .select(['target_type', 'after'])
        .where('organization_id', '=', f.orgId)
        .where('action', '=', 'report:export')
        .execute();
      expect(audits).toHaveLength(1);
      expect(audits[0]?.target_type).toBe('report');
      expect(audits[0]?.after).toMatchObject({ report: 'auth_outcomes', rows: lines.length - 1 });

      const readOnly = await login(
        f.a,
        await createAdmin(deps.dbPlatform, [
          { template: 'read_only', scope: 'organization', orgId: f.orgId },
        ]),
      );
      expect((await readOnly.get(`/api/v1/orgs/${f.orgId}/dashboard`)).status).toBe(200);
      expect((await readOnly.get(`/api/v1/orgs/${f.orgId}/reports/usage_by_site`)).status).toBe(
        200,
      );
      expect(
        (
          await readOnly
            .post(`/api/v1/orgs/${f.orgId}/reports/usage_by_site/export`)
            .set(BROWSER)
            .send({})
        ).status,
      ).toBe(403);

      const support = await login(
        f.a,
        await createAdmin(deps.dbPlatform, [{ template: 'platform_support', scope: 'platform' }]),
      );
      await withMfa(support);
      const start = await support
        .post('/api/v1/platform/support/impersonate')
        .set(BROWSER)
        .send({ organizationId: f.orgId, reason: 'dashboard ticket', ttlMinutes: 15 });
      expect(start.status).toBe(201);
      expect((await support.get(`/api/v1/orgs/${f.orgId}/dashboard`)).status).toBe(200);
      const imp = await support
        .post(`/api/v1/orgs/${f.orgId}/reports/usage_by_site/export`)
        .set(BROWSER)
        .send({});
      expect(imp.status).toBe(403);
      expect(imp.body.type).toContain('impersonation-forbidden');

      // 10 exports per hour per principal (the first one above counted): 9 more, then 429.
      for (let i = 0; i < 9; i += 1) {
        const ok = await f.agent
          .post(`/api/v1/orgs/${f.orgId}/reports/nas_activity/export`)
          .set(BROWSER)
          .send({});
        expect(ok.status).toBe(200);
      }
      // Over the limit: 429 from the read-only pre-check, before the report query runs.
      const nasReport = REPORTS.find((r) => r.key === 'nas_activity');
      if (nasReport === undefined) throw new Error('nas_activity report missing');
      const run = vi.spyOn(nasReport, 'run');
      try {
        const limited = await f.agent
          .post(`/api/v1/orgs/${f.orgId}/reports/nas_activity/export`)
          .set(BROWSER)
          .send({});
        expect(limited.status).toBe(429);
        expect(run).not.toHaveBeenCalled();
      } finally {
        run.mockRestore();
      }
    });
  });

  describe('site-bound administrator (site B only)', () => {
    let siteAdmin: Agent;
    beforeAll(async () => {
      siteAdmin = await login(
        f.a,
        await createAdmin(deps.dbPlatform, [
          { template: 'site_admin', scope: 'site', orgId: f.orgId, siteId: f.siteB },
        ]),
      );
    });
    const base = () => `/api/v1/orgs/${f.orgId}`;
    const names = (rows: { site_name?: string | null }[]) => [
      ...new Set(rows.map((r) => r.site_name ?? null)),
    ];

    it('reports contain only site B rows; another site id is 404', async () => {
      const usage = await siteAdmin.get(
        `${base()}/reports/usage_by_site?from=2026-10-07&to=2026-10-08`,
      );
      expect(usage.status).toBe(200);
      expect(usage.body.rows).toEqual([
        expect.objectContaining({ site_id: f.siteB, period_start: '2026-10-08', bytes_in: 300 }),
      ]);
      const auth = await siteAdmin.get(
        `${base()}/reports/auth_outcomes?from=2026-10-01&to=2026-10-08`,
      );
      expect(auth.status).toBe(200);
      expect(names(auth.body.rows)).toEqual(['Site B']);
      expect(
        auth.body.rows
          .map((r: { count: number }) => r.count)
          .reduce((x: number, y: number) => x + y, 0),
      ).toBe(2);
      const sessions = await siteAdmin.get(
        `${base()}/reports/session_summary?from=2026-10-08&to=2026-10-08`,
      );
      expect(names(sessions.body.rows)).toEqual(['Site B']);
      const nas = await siteAdmin.get(`${base()}/reports/nas_activity`);
      expect(nas.body.rows.map((r: { name: string }) => r.name)).toEqual(['nas-b']);
      for (const key of ['usage_by_site', 'auth_outcomes', 'session_summary', 'nas_activity']) {
        expect((await siteAdmin.get(`${base()}/reports/${key}?site_id=${f.siteA}`)).status).toBe(
          404,
        );
      }
    });

    it('CSV export holds only site B; another site id is 404', async () => {
      const csv = await siteAdmin
        .post(`${base()}/reports/session_summary/export`)
        .set(BROWSER)
        .send({ from: '2026-10-01', to: '2026-10-08' });
      expect(csv.status).toBe(200);
      const lines = csv.text.trim().split('\r\n');
      expect(lines).toHaveLength(2);
      expect(lines[1]).toContain(f.siteB);
      expect(csv.text).not.toContain(f.siteA);
      expect(csv.text).not.toContain('Site A');
      expect(
        (
          await siteAdmin
            .post(`${base()}/reports/session_summary/export`)
            .set(BROWSER)
            .send({ site_id: f.siteA })
        ).status,
      ).toBe(404);
    });

    it('series cover only site B; another site id is 404', async () => {
      const auth = await siteAdmin.get(
        `${base()}/dashboard/series/auth?granularity=day&from=2026-10-01&to=2026-10-08`,
      );
      expect(auth.status).toBe(200);
      expect(auth.body.timezone).toBe('UTC');
      expect(auth.body.totals).toMatchObject({
        radius_accept: 1,
        radius_reject: 1,
        radius_error: 0,
        portal_accept: 0,
        portal_reject: 0,
      });
      const hourly = await siteAdmin.get(`${base()}/dashboard/series/auth`);
      expect(hourly.status).toBe(200); // a single site: one timezone
      expect(hourly.body.totals.radius_accept).toBe(0);
      const usage = await siteAdmin.get(
        `${base()}/dashboard/series/usage?granularity=day&from=2026-10-07&to=2026-10-08`,
      );
      expect(usage.body.totals.bytes_in).toBe(300);
      const usageHour = await siteAdmin.get(`${base()}/dashboard/series/usage`);
      expect(usageHour.body.totals.bytes_total).toBe(0);
      for (const path of ['series/auth', 'series/usage']) {
        expect((await siteAdmin.get(`${base()}/dashboard/${path}?site_id=${f.siteA}`)).status).toBe(
          404,
        );
      }
    });
  });

  describe('platform summary', () => {
    it('gives platform admins per-organization counts only; tenants are refused', async () => {
      expect((await f.agent.get('/api/v1/platform/dashboard')).status).toBe(403);
      const sa = await login(
        f.a,
        await createAdmin(deps.dbPlatform, [
          { template: 'platform_super_admin', scope: 'platform' },
        ]),
      );
      await withMfa(sa);
      const res = await sa.get(`/api/v1/platform/dashboard?organization_id=${f.orgId}`);
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      const row = res.body.data[0] as Record<string, unknown>;
      const plan = await sa.get('/api/v1/platform/retention/plan');
      expect(plan.status).toBe(200);
      expect(plan.body.usage_hourly_rows_older_than_cutoff).toEqual(expect.any(Number));
      const page = await sa.get('/api/v1/platform/dashboard?limit=2');
      expect(page.status).toBe(200);
      expect(page.body.data.length).toBeLessThanOrEqual(2);
      expect(row).toMatchObject({
        sites: 2,
        nas_registered: 3,
        nas_activity: { active: 1, quiet: 1, silent: 0, never: 1 },
        open_sessions: 2,
        sessions_started_24h: 3,
        radius_accept_24h: 3,
        radius_reject_24h: 3,
        portal_attempts_24h: 3,
        portal_lockouts_24h: 1,
        enforcement_pending: 1,
        anomalies_24h: 1,
      });
      // counts only: no subscriber or device identifiers
      expect(Object.keys(row).sort()).toEqual([
        'anomalies_24h',
        'enforcement_pending',
        'name',
        'nas_activity',
        'nas_activity_truncated',
        'nas_registered',
        'network_devices_registered',
        'open_sessions',
        'organization_id',
        'portal_attempts_24h',
        'portal_lockouts_24h',
        'radius_accept_24h',
        'radius_reject_24h',
        'sessions_started_24h',
        'sites',
        'slug',
        'status',
      ]);
    });
  });

  describe('performance evidence (EXPLAIN)', () => {
    async function plan(query: RawBuilder<unknown>): Promise<string> {
      return withTenant(deps.db, f.orgId, async (trx) => {
        await sql`SET LOCAL enable_seqscan = off`.execute(trx);
        const r = await sql<{ 'QUERY PLAN': string }>`EXPLAIN ${query}`.execute(trx);
        return r.rows.map((x) => x['QUERY PLAN']).join('\n');
      });
    }

    it('dashboard aggregates are index-supported', async () => {
      const org = f.orgId;
      const since = ago(24 * HOUR).toISOString();
      expect(
        await plan(sql`SELECT count(*) FROM sessions WHERE organization_id = ${org}
          AND status IN ('authorized', 'active') AND site_id IN (${f.siteA})`),
      ).toContain('idx_sessions_open_org_site_nas');
      expect(
        await plan(sql`SELECT created_at FROM auth_events WHERE organization_id = ${org}
          AND nas_client_id = ${f.nasA.id} ORDER BY created_at DESC LIMIT 1`),
      ).toMatch(/org_nas_time|organization_id_nas_client_id/);
      expect(
        await plan(sql`SELECT received_at FROM accounting_records WHERE organization_id = ${org}
          AND nas_ip = ${f.nasA.nas_ip}::inet ORDER BY received_at DESC LIMIT 1`),
      ).toMatch(/org_nas_received|organization_id_nas_ip/);
      expect(
        await plan(sql`SELECT count(*) FROM accounting_anomalies WHERE organization_id = ${org}
          AND created_at >= ${since}::timestamptz`),
      ).toContain('idx_accounting_anomalies_org_created');
      expect(
        await plan(sql`SELECT sum(bytes_in) FROM usage_hourly WHERE organization_id = ${org}
          AND hour_start >= ${since}::timestamptz`),
      ).toMatch(/usage_hourly_pkey|idx_usage_hourly_org_hour/);
      expect(
        await plan(sql`SELECT result, count(*) FROM auth_events WHERE organization_id = ${org}
          AND created_at >= ${since}::timestamptz GROUP BY result`),
      ).toMatch(/Index|Bitmap/);
    });

    it('subscriber and open-session aggregates (the real query builders) are index-supported', async () => {
      const sites = [
        { id: f.siteA, name: 'Site A', timezone: 'Asia/Dubai' },
        { id: f.siteB, name: 'Site B', timezone: 'UTC' },
      ];
      // organization-wide: `site_id IN (SELECT id FROM sites … live)`; site: `site_id IN ($1)`
      const orgWide: ReportScope = {
        orgId: f.orgId,
        siteId: null,
        sites,
        allSites: true,
        timezone: 'mixed',
      };
      const oneSite: ReportScope = {
        orgId: f.orgId,
        siteId: f.siteA,
        sites: [sites[0]!],
        allSites: false,
        timezone: 'Asia/Dubai',
      };
      const since = ago(30 * 24 * HOUR);
      const utcMidnight = new Date('2026-10-08T00:00:00Z');
      for (const scope of [orgWide, oneSite]) {
        const open = await plan(openSessionCountsQuery(scope));
        // a partial index over open sessions (016 / 026), whichever the planner prefers
        expect(open).toMatch(/idx_sessions_open_(org_site_nas|user|device)/);
        // the live-subscriber join reads users through an index (primary key or organization)
        expect(open).toMatch(/Index Scan using (users_pkey|\w*users_org\w*) on users/);
        const active = await plan(activeUsersQuery(scope, since));
        expect(active).toMatch(/idx_sessions_org_site_started|idx_sessions_org_user_started/);
        expect(active).toMatch(/idx_sessions_open_(org_site_nas|user|device)/);
        expect(active).toMatch(/Index Scan using (users_pkey|\w*users_org\w*) on users/);
        // the VALUES (site_id, local midnight) LEFT JOIN form
        const created = usersCreatedQuery(scope, siteTodayStarts(scope.sites, NOW), utcMidnight);
        expect(created).not.toBeNull();
        expect(await plan(created!)).toMatch(/users_org/);
      }
      // a site-bound caller without sites: nothing to count, no query at all
      expect(usersCreatedQuery({ ...oneSite, sites: [] }, [], utcMidnight)).toBeNull();
    });
  });
});
