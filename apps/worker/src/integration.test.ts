/**
 * Worker integration suite against `ECLOUD_TEST_DATABASE_URL` (platform role, ecloud_test).
 * Shares the database with other suites, so every fixture is unique to this run (own
 * organization, NAS address in TEST-NET-3, random session ids) and assertions are scoped to it.
 * Redis-backed state is exercised only when `ECLOUD_TEST_REDIS_URL` is set.
 */
import { randomBytes } from 'node:crypto';
import { createDb, createPool, type Db } from '@ecloud/db';
import { createLogger, newId } from '@ecloud/shared';
import {
  describeIntegration,
  getTestRedisUrl,
  makeClientDevice,
  makeOrganization,
  makeSite,
  makeUser,
  migrateTestDatabase,
} from '@ecloud/testing';
import { Redis } from 'ioredis';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { DRAIN_CURSOR, drainOnce } from './accounting/drain.js';
import { periodStarts } from './accounting/normalize.js';
import { SKIPPED_DISABLED, dispatchSessionAction } from './coa/dispatcher.js';
import type { RadclientRunner } from './coa/radclient.js';
import { MemoryWorkerState, RedisWorkerState } from './infra/state.js';
import { deliverWebhook, publishOutbox, type FetchLike, type WebhookJob } from './jobs/outbox.js';
import { ensurePartitions } from './jobs/partitions.js';
import { enforceQuotas } from './jobs/quota.js';
import { AUTHORIZATION_EXPIRED_CAUSE, expireAuthorizations } from './jobs/reap.js';
import { pruneRetention } from './jobs/retention.js';

const logger = createLogger({ name: 'worker-it', level: 'silent' });
const RUN = randomBytes(4).toString('hex');
const NAS_IP = `203.0.113.${String(1 + ((randomBytes(1)[0] ?? 0) % 250))}`;
const UNKNOWN_NAS_IP = '198.51.100.77';
const TZ = 'Asia/Dubai';
const OUT_GIGA = 2 ** 32;

function classFor(sessionId: string): string {
  const hex = sessionId.replace(/-/g, '');
  return `0x61693a${Buffer.from(hex, 'latin1').toString('hex')}`;
}

await describeIntegration('@ecloud/worker against PostgreSQL', () => {
  let db: Db;
  const org = makeOrganization({ slug: `worker-it-${RUN}` });
  const site = makeSite(org.id, { timezone: TZ });
  const user = makeUser(org.id, { username: `pc-it-${RUN}` });
  const user2 = makeUser(org.id, { username: `pc-quota-${RUN}` });
  const user3 = makeUser(org.id, { username: `pc-api-${RUN}` });
  const device = makeClientDevice(org.id);
  const nasId = newId();
  const policyId = newId();
  const sessionA = newId();
  const sessionC = newId();
  const t0 = new Date(Date.now() - 2 * 3600_000);
  const at = (minutes: number) => new Date(t0.getTime() + minutes * 60_000);

  async function insertRaw(rows: Record<string, unknown>[]): Promise<number[]> {
    const inserted = await db
      .insertInto('radius.radacct_raw')
      .values(
        rows.map((r) => ({
          acctsessionid: `it-${RUN}`,
          acctuniqueid: `uniq-${RUN}`,
          nasipaddress: NAS_IP,
          nasidentifier: `nas-${RUN}`,
          username: user.username,
          callingstationid: device.mac.toUpperCase().replace(/:/g, '-'),
          calledstationid: '00-11-22-33-44-55:lab-uam',
          framedipaddress: '192.0.2.100',
          acctdelaytime: 0,
          ...r,
          // FreeRADIUS writes the authenticated UDP source; default it to the NAS address.
          packet_src_ip: 'packet_src_ip' in r ? r.packet_src_ip : (r.nasipaddress ?? NAS_IP),
          eventtimestamp: r.received_at as Date,
        })) as never,
      )
      .returning('radacctid')
      .execute();
    return inserted.map((r) => r.radacctid);
  }

  async function freshState(fromId: number): Promise<MemoryWorkerState> {
    const state = new MemoryWorkerState();
    await state.setCursor(DRAIN_CURSOR, fromId - 1);
    return state;
  }

  beforeAll(async () => {
    const { databaseUrl } = await migrateTestDatabase();
    db = createDb(createPool(databaseUrl, { max: 4, applicationName: 'ecloud-worker-it' }));
    await db.insertInto('organizations').values(org).execute();
    await db.insertInto('sites').values(site).execute();
    await db.insertInto('users').values([user, user2, user3]).execute();
    await db
      .insertInto('client_devices')
      .values({ ...device, user_id: user.id })
      .execute();
    await db
      .insertInto('nas_clients')
      .values({
        id: nasId,
        organization_id: org.id,
        site_id: site.id,
        name: `NAS ${RUN}`,
        nas_identifier: `nas-${RUN}`,
        nas_ip: NAS_IP,
        adapter_type_key: 'coovachilli-uam',
        adapter_key: 'coovachilli-uam',
        secret_ref: 'env:ECLOUD_WORKER_IT_NAS_SECRET',
      })
      .execute();
    await db
      .insertInto('policies')
      .values({
        id: policyId,
        organization_id: org.id,
        name: `quota ${RUN}`,
        scope_type: 'user',
        quota_daily_bytes: 5_000_000,
        status: 'active',
      })
      .execute();
  }, 120_000);

  afterAll(async () => {
    await db?.destroy();
  });

  it('drains Start / Interim / reordered Interim / Stop / Accounting-On in one tick', async () => {
    const ids = await insertRaw([
      {
        acctuniqueid: `uniqA-${RUN}`,
        acctsessionid: `A-${RUN}`,
        acctstatustype: 'Start',
        class: classFor(sessionA),
        received_at: at(0),
      },
      {
        acctuniqueid: `uniqA-${RUN}`,
        acctsessionid: `A-${RUN}`,
        acctstatustype: 'Interim-Update',
        class: classFor(sessionA),
        acctsessiontime: 600,
        acctinputoctets: 1_048_576,
        acctoutputoctets: OUT_GIGA + 123_456_789,
        acctinterval: 300,
        received_at: at(10),
      },
      {
        // delayed retransmission of an older interim: must not move counters backwards
        acctuniqueid: `uniqA-${RUN}`,
        acctsessionid: `A-${RUN}`,
        acctstatustype: 'Interim-Update',
        class: classFor(sessionA),
        acctsessiontime: 300,
        acctinputoctets: 500,
        acctoutputoctets: 1000,
        received_at: at(11),
      },
      {
        acctuniqueid: `uniqB-${RUN}`,
        acctsessionid: `B-${RUN}`,
        acctstatustype: 'Start',
        class: null,
        received_at: at(5),
        callingstationid: '02-AA-00-00-00-01',
        username: 'someone-else',
      },
      {
        acctuniqueid: `uniqA-${RUN}`,
        acctsessionid: `A-${RUN}`,
        acctstatustype: 'Stop',
        class: classFor(sessionA),
        acctsessiontime: 3600,
        acctinputoctets: 2_097_152,
        acctoutputoctets: OUT_GIGA + 987_654_321,
        acctterminatecause: 'Session-Timeout',
        received_at: at(60),
      },
      {
        acctuniqueid: `on-${RUN}`,
        acctsessionid: `boot-${RUN}`,
        acctstatustype: 'Accounting-On',
        username: null,
        received_at: at(70),
      },
      {
        acctuniqueid: `uniqX-${RUN}`,
        acctsessionid: `X-${RUN}`,
        acctstatustype: 'Start',
        nasipaddress: UNKNOWN_NAS_IP,
        received_at: at(71),
      },
    ]);
    const first = ids[0] ?? 0;
    const state = await freshState(first);
    const result = await drainOnce({ db, state, logger, batchSize: 500, lagMs: 0 });
    expect(result.cursor).toBeGreaterThanOrEqual(Math.max(...ids));
    expect(result.processed + result.unresolved + result.duplicates).toBeGreaterThanOrEqual(
      ids.length,
    );
    expect(result.unresolved).toBeGreaterThanOrEqual(1);
    expect(result.skipped).toBe(0);

    const a = await db
      .selectFrom('sessions')
      .selectAll()
      .where('id', '=', sessionA)
      .executeTakeFirstOrThrow();
    expect(a).toMatchObject({
      organization_id: org.id,
      site_id: site.id,
      nas_client_id: nasId,
      user_id: user.id,
      client_device_id: device.id,
      acct_unique_id: `uniqA-${RUN}`,
      status: 'stopped',
      terminate_cause: 'session_timeout',
      input_octets: 2_097_152,
      output_octets: OUT_GIGA + 987_654_321,
      session_time_s: 3600,
      mac: device.mac,
    });
    expect(a.last_interim_at?.toISOString()).toBe(at(11).toISOString());
    expect(a.stopped_at?.toISOString()).toBe(at(60).toISOString());

    const b = await db
      .selectFrom('sessions')
      .selectAll()
      .where('acct_unique_id', '=', `uniqB-${RUN}`)
      .executeTakeFirstOrThrow();
    expect(b.status).toBe('stale');
    expect(b.user_id).toBeNull();

    const records = await db
      .selectFrom('accounting_records')
      .select(['status_type', 'session_id', 'organization_id'])
      .where('acct_unique_id', 'in', [`uniqA-${RUN}`, `uniqB-${RUN}`, `on-${RUN}`, `uniqX-${RUN}`])
      .orderBy('id')
      .execute();
    expect(records.map((r) => r.status_type)).toEqual([
      'start',
      'interim',
      'interim',
      'start',
      'stop',
      'accounting_on',
      'start',
    ]);
    expect(records.filter((r) => r.session_id === sessionA)).toHaveLength(4);
    expect(records.at(-1)).toMatchObject({ organization_id: null, session_id: null });

    const counters = await db
      .selectFrom('usage_counters')
      .selectAll()
      .where('subject_id', 'in', [user.id, device.id])
      .execute();
    const total = (subject: string) =>
      counters.find((c) => c.subject_id === subject && c.period_type === 'total');
    for (const subject of [user.id, device.id]) {
      expect(total(subject)).toMatchObject({
        bytes_in: 2_097_152,
        bytes_out: OUT_GIGA + 987_654_321,
        session_count: 1,
        session_time_s: 3600,
      });
      const daily = counters.filter((c) => c.subject_id === subject && c.period_type === 'daily');
      expect(daily.reduce((s, c) => s + c.bytes_in + c.bytes_out, 0)).toBe(
        2_097_152 + OUT_GIGA + 987_654_321,
      );
      expect(daily.map((c) => c.period_start)).toContain(periodStarts(at(60), TZ).daily);
    }

    const events = await db
      .selectFrom('outbox')
      .select(['event', 'payload'])
      .where('organization_id', '=', org.id)
      .orderBy('id')
      .execute();
    expect(events.map((e) => e.event)).toEqual([
      'session.started',
      'session.updated',
      'session.updated',
      'session.started',
      'session.stopped',
      'session.updated',
    ]);
    expect(events.at(-1)?.payload).toMatchObject({
      site_id: site.id,
      data: { status: 'stale', reason: 'accounting_on' },
    });

    // Crash-before-cursor-save replay: everything is a duplicate, nothing changes.
    const replay = await drainOnce({
      db,
      state: await freshState(first),
      logger,
      batchSize: 500,
      lagMs: 0,
    });
    expect(replay.duplicates).toBeGreaterThanOrEqual(ids.length);
    expect(replay.processed).toBe(0);
    const again = await db
      .selectFrom('usage_counters')
      .selectAll()
      .where('subject_id', '=', user.id)
      .where('period_type', '=', 'total')
      .executeTakeFirstOrThrow();
    expect(again.bytes_in).toBe(2_097_152);
    const eventCount = await db
      .selectFrom('outbox')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('organization_id', '=', org.id)
      .executeTakeFirstOrThrow();
    expect(Number(eventCount.n)).toBe(6);
  });

  it('T-08: NAS-IP-Address / Class from an unauthenticated source never attribute a record', async () => {
    const before = await db
      .selectFrom('sessions')
      .select(['input_octets', 'output_octets', 'session_time_s', 'status'])
      .where('id', '=', sessionA)
      .executeTakeFirstOrThrow();
    const ids = await insertRaw([
      {
        // claims this tenant's NAS address and session A's Class, sent from an unknown source
        acctuniqueid: `spoof-${RUN}`,
        acctsessionid: `spoof-${RUN}`,
        acctstatustype: 'Interim-Update',
        nasipaddress: NAS_IP,
        packet_src_ip: UNKNOWN_NAS_IP,
        class: classFor(sessionA),
        acctinputoctets: 9_999_999_999,
        acctsessiontime: 99_999,
        received_at: at(80),
      },
      {
        // legacy row written before migration 014: no authenticated source
        acctuniqueid: `legacy-${RUN}`,
        acctsessionid: `legacy-${RUN}`,
        acctstatustype: 'Start',
        packet_src_ip: null,
        class: classFor(sessionA),
        received_at: at(81),
      },
    ]);
    const result = await drainOnce({
      db,
      state: await freshState(ids[0] ?? 0),
      logger,
      batchSize: 500,
      lagMs: 0,
    });
    expect(result.unresolved).toBe(2);
    const records = await db
      .selectFrom('accounting_records')
      .select(['organization_id', 'session_id'])
      .where('acct_unique_id', 'in', [`spoof-${RUN}`, `legacy-${RUN}`])
      .execute();
    expect(records).toEqual([
      { organization_id: null, session_id: null },
      { organization_id: null, session_id: null },
    ]);
    const after = await db
      .selectFrom('sessions')
      .select(['input_octets', 'output_octets', 'session_time_s', 'status'])
      .where('id', '=', sessionA)
      .executeTakeFirstOrThrow();
    expect(after).toEqual(before);
    const created = await db
      .selectFrom('sessions')
      .select('id')
      .where('acct_unique_id', 'in', [`spoof-${RUN}`, `legacy-${RUN}`])
      .execute();
    expect(created).toEqual([]);
  });

  it('quota breach: pending while CoA is disabled, disconnect + dispatcher when enabled', async () => {
    // Session bound to a policy at authorize time (Class = its id).
    await db
      .insertInto('sessions')
      .values({
        id: sessionC,
        organization_id: org.id,
        site_id: site.id,
        nas_client_id: nasId,
        user_id: user2.id,
        policy_id: policyId,
        policy_version: 1,
        acct_session_id: `C-${RUN}`,
        acct_unique_id: `uniqC-${RUN}`,
        username_raw: user2.username,
        started_at: new Date(Date.now() - 60_000),
      })
      .execute();
    const now = new Date();
    const ids = await insertRaw([
      {
        acctuniqueid: `uniqC-${RUN}`,
        acctsessionid: `C-${RUN}`,
        acctstatustype: 'Interim-Update',
        class: classFor(sessionC),
        acctsessiontime: 60,
        acctinputoctets: 1_000_000,
        acctoutputoctets: 9_000_000,
        received_at: new Date(now.getTime() - 1000),
        username: user2.username,
        callingstationid: '02-BB-00-00-00-02',
      },
    ]);
    const state = await freshState(ids[0] ?? 0);
    const drained = await drainOnce({ db, state, logger, batchSize: 500, lagMs: 0 });
    expect(drained.touchedSessionIds).toContain(sessionC);

    const enqueued: string[] = [];
    const enqueueDisconnect = (id: string) => {
      enqueued.push(id);
      return Promise.resolve();
    };
    const off = await enforceQuotas(
      { db, state, logger, coaEnabled: false, enqueueDisconnect },
      drained.touchedSessionIds,
    );
    expect(off).toMatchObject({ breaches: 1, pending: 1, disconnectsQueued: 0 });
    expect(Object.keys(await state.listPending())).toContain(sessionC);
    // once per period: a second evaluation emits nothing
    expect(
      (await enforceQuotas({ db, state, logger, coaEnabled: false, enqueueDisconnect }, [sessionC]))
        .breaches,
    ).toBe(0);

    const exceeded = await db
      .selectFrom('outbox')
      .select('payload')
      .where('organization_id', '=', org.id)
      .where('event', '=', 'quota.exceeded')
      .execute();
    expect(exceeded).toHaveLength(1);
    expect(exceeded[0]?.payload).toMatchObject({
      data: {
        session_id: sessionC,
        enforcement: 'pending',
        pending_reason: 'coa_disabled',
        breaches: [{ period: 'daily', limit_bytes: 5_000_000, used_bytes: 10_000_000 }],
      },
    });
    expect(
      await db
        .selectFrom('session_actions')
        .select('id')
        .where('session_id', '=', sessionC)
        .execute(),
    ).toHaveLength(0);

    // Lab mode: flag on → session_actions row + queued disconnect.
    const lab = await enforceQuotas(
      { db, state: new MemoryWorkerState(), logger, coaEnabled: true, enqueueDisconnect },
      [sessionC],
    );
    expect(lab).toMatchObject({ breaches: 1, disconnectsQueued: 1 });
    const actionId = enqueued[0] ?? '';
    const action = await db
      .selectFrom('session_actions')
      .selectAll()
      .where('id', '=', actionId)
      .executeTakeFirstOrThrow();
    expect(action).toMatchObject({ action: 'disconnect', status: 'pending', session_id: sessionC });

    const runner: RadclientRunner = (_p, args, stdin) => {
      expect(args).toContain(`${NAS_IP}:3799`);
      expect(stdin).toContain(`User-Name = "${user2.username}"`);
      return Promise.resolve({
        stdout: 'Received Disconnect-ACK Id 1',
        stderr: '',
        exitCode: 0,
        killed: false,
      });
    };
    const dispatchDeps = {
      db,
      logger,
      radclientPath: 'radclient',
      timeoutS: 1,
      retries: 1,
      defaultCoaPort: 3799,
      runner,
      resolveSecret: (ref: string) =>
        Promise.resolve(ref === 'env:ECLOUD_WORKER_IT_NAS_SECRET' ? 'placeholder' : undefined),
    };
    expect(
      await dispatchSessionAction({ ...dispatchDeps, coaEnabled: true }, actionId, {
        attempt: 1,
        maxAttempts: 3,
      }),
    ).toEqual({
      status: 'ack',
      sessionClosed: false,
    });
    const acked = await db
      .selectFrom('session_actions')
      .selectAll()
      .where('id', '=', actionId)
      .executeTakeFirstOrThrow();
    expect(acked.status).toBe('ack');
    expect(acked.completed_at).not.toBeNull();
    // CoovaChilli sends its own Acct-Stop: the session stays open until it arrives.
    expect(
      (
        await db
          .selectFrom('sessions')
          .select('status')
          .where('id', '=', sessionC)
          .executeTakeFirstOrThrow()
      ).status,
    ).toBe('active');
    expect(
      await dispatchSessionAction({ ...dispatchDeps, coaEnabled: true }, actionId, {
        attempt: 1,
        maxAttempts: 3,
      }),
    ).toEqual({
      status: 'already_done',
      current: 'ack',
    });

    // Flag off: an operator-requested action is recorded as skipped, nothing is sent.
    const manual = await db
      .insertInto('session_actions')
      .values({ organization_id: org.id, session_id: sessionC, action: 'disconnect' })
      .returning('id')
      .executeTakeFirstOrThrow();
    const failRunner: RadclientRunner = () => Promise.reject(new Error('must not run'));
    expect(
      await dispatchSessionAction(
        { ...dispatchDeps, runner: failRunner, coaEnabled: false },
        manual.id,
        { attempt: 1, maxAttempts: 3 },
      ),
    ).toEqual({
      status: 'skipped_disabled',
    });
    const skipped = await db
      .selectFrom('session_actions')
      .selectAll()
      .where('id', '=', manual.id)
      .executeTakeFirstOrThrow();
    expect(skipped).toMatchObject({ status: 'unsupported', error: SKIPPED_DISABLED });
  });

  it('adopts a session pre-created by /internal/aaa/authorize (placeholder identifiers)', async () => {
    const sessionD = newId();
    const classValue = `ai:${sessionD.replace(/-/g, '')}`;
    await db
      .insertInto('sessions')
      .values({
        id: sessionD,
        organization_id: org.id,
        site_id: site.id,
        nas_client_id: nasId,
        user_id: user3.id,
        acct_session_id: '',
        acct_unique_id: classValue,
        username_raw: user3.username,
        started_at: new Date(Date.now() - 120_000),
      })
      .execute();
    const startAt = new Date(Date.now() - 90_000);
    const ids = await insertRaw([
      {
        acctuniqueid: `uniqD-${RUN}`,
        acctsessionid: `D-${RUN}`,
        acctstatustype: 'Start',
        class: classFor(sessionD),
        username: user3.username,
        received_at: startAt,
      },
      {
        acctuniqueid: `uniqD-${RUN}`,
        acctsessionid: `D-${RUN}`,
        acctstatustype: 'Stop',
        class: classFor(sessionD),
        username: user3.username,
        acctsessiontime: 60,
        acctinputoctets: 100,
        acctoutputoctets: 200,
        acctterminatecause: 'User-Request',
        received_at: new Date(Date.now() - 30_000),
      },
    ]);
    await drainOnce({ db, state: await freshState(ids[0] ?? 0), logger, batchSize: 500, lagMs: 0 });
    const d = await db
      .selectFrom('sessions')
      .selectAll()
      .where('id', '=', sessionD)
      .executeTakeFirstOrThrow();
    expect(d).toMatchObject({
      acct_unique_id: `uniqD-${RUN}`,
      acct_session_id: `D-${RUN}`,
      status: 'stopped',
      terminate_cause: 'user_request',
      input_octets: 100,
      output_octets: 200,
    });
    expect(d.started_at.toISOString()).toBe(startAt.toISOString());
    const total = await db
      .selectFrom('usage_counters')
      .selectAll()
      .where('subject_id', '=', user3.id)
      .where('period_type', '=', 'total')
      .executeTakeFirstOrThrow();
    expect(total).toMatchObject({
      session_count: 1,
      bytes_in: 100,
      bytes_out: 200,
      session_time_s: 60,
    });
  });

  it('publishes the outbox to subscribed webhooks with an HMAC signature', async () => {
    const hook = await db
      .insertInto('webhooks')
      .values({
        organization_id: org.id,
        name: 'it',
        url: `https://hooks.example.test/${RUN}`,
        events: ['session.stopped', 'quota.exceeded'],
        signing_secret_ref: 'env:ECLOUD_WORKER_IT_WEBHOOK_SECRET',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const jobs: WebhookJob[] = [];
    let published = 0;
    for (let i = 0; i < 50; i += 1) {
      const r = await publishOutbox({
        db,
        enqueueWebhook: (_id, job) => (jobs.push(job), Promise.resolve()),
      });
      published += r.published;
      if (r.published === 0) break;
    }
    expect(published).toBeGreaterThan(0);
    const mine = jobs.filter((j) => j.webhookId === hook.id);
    expect(mine.map((j) => j.envelope.event).sort()).toEqual([
      'quota.exceeded',
      'quota.exceeded',
      'session.stopped',
      'session.stopped',
    ]);
    const left = await db
      .selectFrom('outbox')
      .select('id')
      .where('organization_id', '=', org.id)
      .where('published_at', 'is', null)
      .execute();
    expect(left).toHaveLength(0);

    const calls: { url: string; headers: Record<string, string> }[] = [];
    const fetch: FetchLike = (url, init) => {
      calls.push({ url, headers: init.headers });
      return Promise.resolve({ status: 204 });
    };
    const job = mine[0] as WebhookJob;
    const out = await deliverWebhook(
      {
        db,
        fetch,
        resolveSecret: (ref) =>
          Promise.resolve(ref.endsWith('WEBHOOK_SECRET') ? 'placeholder' : undefined),
      },
      job,
      1,
    );
    expect(out).toEqual({ status: 'success', httpStatus: 204 });
    expect(calls[0]?.headers['X-ECLOUD-Signature']).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    const deliveries = await db
      .selectFrom('webhook_deliveries')
      .selectAll()
      .where('webhook_id', '=', hook.id)
      .execute();
    expect(deliveries).toMatchObject([{ status: 'success', http_status: 204, attempt: 1 }]);

    const failing: FetchLike = () => Promise.resolve({ status: 500 });
    await expect(
      deliverWebhook({ db, fetch: failing, resolveSecret: () => Promise.resolve('p') }, job, 2),
    ).rejects.toThrow('HTTP 500');
    const after = await db
      .selectFrom('webhooks')
      .select('failure_count')
      .where('id', '=', hook.id)
      .executeTakeFirstOrThrow();
    expect(after.failure_count).toBe(1);
  });

  it('partitions.ensure is idempotent and retention defaults to a dry-run plan', async () => {
    await ensurePartitions(db);
    const second = await ensurePartitions(db);
    expect(second.every((r) => r.created.length === 0)).toBe(true);
    const audit = await db
      .selectFrom('audit_logs')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where(sql<boolean>`after->>'reason' = 'worker:partitions.ensure'`)
      .executeTakeFirstOrThrow();
    expect(Number(audit.n)).toBeGreaterThanOrEqual(2);

    const report = await pruneRetention({ db, state: new MemoryWorkerState(), apply: false });
    expect(report.applied).toBe(false);
    expect(report.rawRowsDeleted).toBe(0);
    expect(Object.keys(report.cutoffs)).toEqual(['raw', 'accounting_records', 'audit_logs']);
  });

  it('Redis state: lock, cursor and once-markers (needs ECLOUD_TEST_REDIS_URL)', async () => {
    const url = getTestRedisUrl();
    if (url === undefined) return;
    const redis = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1 });
    await redis.connect();
    try {
      const state = new RedisWorkerState(redis);
      const name = `it-${RUN}`;
      const nested = await state.withLock(name, 5000, () =>
        state.withLock(name, 5000, () => Promise.resolve('inner')),
      );
      expect(nested).toBeUndefined();
      expect(await state.withLock(name, 5000, () => Promise.resolve('free'))).toBe('free');
      await state.setCursor(name, 42);
      expect(await state.getCursor(name)).toBe(42);
      expect(await state.markOnce(name, 60)).toBe(true);
      expect(await state.markOnce(name, 60)).toBe(false);
      await redis.del(`ecloud:worker:cursor:${name}`, `ecloud:worker:once:${name}`);
    } finally {
      await redis.quit();
    }
  });
  it('D-036: Start promotes an authorization; unpromoted ones expire after the TTL and revive', async () => {
    const promoted = newId();
    const stuck = newId();
    const recent = newId();
    const base = {
      organization_id: org.id,
      site_id: site.id,
      nas_client_id: nasId,
      user_id: user3.id,
      acct_session_id: '',
      username_raw: user3.username,
      status: 'authorized' as const,
    };
    await db
      .insertInto('sessions')
      .values([
        { ...base, id: promoted, acct_unique_id: `ai-p-${RUN}`, started_at: at(100) },
        { ...base, id: stuck, acct_unique_id: `ai-s-${RUN}`, started_at: at(100) },
        { ...base, id: recent, acct_unique_id: `ai-r-${RUN}`, started_at: new Date() },
      ])
      .execute();

    const ids = await insertRaw([
      {
        acctuniqueid: `auth-p-${RUN}`,
        acctsessionid: `P-${RUN}`,
        acctstatustype: 'Start',
        username: user3.username,
        class: classFor(promoted),
        received_at: at(101),
      },
    ]);
    await drainOnce({ db, state: await freshState(ids[0] ?? 0), logger, batchSize: 500, lagMs: 0 });
    const status = async (id: string) =>
      await db
        .selectFrom('sessions')
        .select(['status', 'terminate_cause', 'acct_unique_id'])
        .where('id', '=', id)
        .executeTakeFirstOrThrow();
    expect(await status(promoted)).toMatchObject({
      status: 'active',
      acct_unique_id: `auth-p-${RUN}`,
    });

    // TTL 300 s: the 2-hour-old authorization expires, the fresh one and the promoted one stay
    const expired = await expireAuthorizations({ db, ttlS: 300 });
    expect(expired).toBeGreaterThanOrEqual(1);
    expect(await status(stuck)).toMatchObject({
      status: 'expired',
      terminate_cause: AUTHORIZATION_EXPIRED_CAUSE,
    });
    expect((await status(recent)).status).toBe('authorized');
    expect((await status(promoted)).status).toBe('active');

    // a late Start (slow client) revives the expired authorization
    const late = await insertRaw([
      {
        acctuniqueid: `auth-s-${RUN}`,
        acctsessionid: `S-${RUN}`,
        acctstatustype: 'Start',
        username: user3.username,
        class: classFor(stuck),
        received_at: at(110),
      },
    ]);
    await drainOnce({
      db,
      state: await freshState(late[0] ?? 0),
      logger,
      batchSize: 500,
      lagMs: 0,
    });
    expect(await status(stuck)).toMatchObject({ status: 'active', terminate_cause: null });
  });
});
