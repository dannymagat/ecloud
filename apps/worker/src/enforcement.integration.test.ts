/**
 * Phase 7 P7-A worker loop against `ECLOUD_TEST_DATABASE_URL` (platform role, ecloud_test):
 * - SIM-14 vectors through the real drainer: the uspot TIP (32-bit) quirks hook is called on the
 *   accounting delta, every anomaly is recorded, usage is corrected only for an unambiguous wrap;
 * - quota breach / schedule end / late concurrency → `session_enforcement` pending `next_reauth`;
 * - a pending row of a session that ended becomes `applied`.
 * Own organization and NAS addresses; runtime jobs are scoped to this organization.
 */
import { randomBytes, randomInt } from 'node:crypto';
import { normalizeAccounting, type RawAccountingRow } from '@ecloud/adapters';
import { createDb, createPool, withPlatform, type Db } from '@ecloud/db';
import { createLogger, newId } from '@ecloud/shared';
import {
  describeIntegration,
  makeOrganization,
  makeSite,
  makeUser,
  migrateTestDatabase,
} from '@ecloud/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { processRecord } from './accounting/drain.js';
import { MemoryWorkerState } from './infra/state.js';
import {
  enforceRuntimeLimits,
  recordRuntimeEnforcement,
  resolveClosedEnforcement,
} from './jobs/enforcement.js';
import { enforceQuotas } from './jobs/quota.js';

const logger = createLogger({ name: 'worker-p7a-it', level: 'silent' });
const RUN = randomBytes(4).toString('hex');
const TWO_POW_32 = 4_294_967_296;
const octet = () => String(2 + randomInt(250));
const USPOT_IP = `198.18.${octet()}.${octet()}`;
const CHILLI_IP = `198.19.${octet()}.${octet()}`;

function classFor(sessionId: string): string {
  return `0x61693a${Buffer.from(sessionId.replace(/-/g, ''), 'latin1').toString('hex')}`;
}

let radacct = 9_000_000_000 + randomInt(1_000_000_000);

await describeIntegration('@ecloud/worker P7-A enforcement loop against PostgreSQL', () => {
  let db: Db;
  const org = makeOrganization({ slug: `worker-p7a-${RUN}` });
  const site = makeSite(org.id, { timezone: 'UTC' });
  const user = makeUser(org.id, { username: `p7a-${RUN}` });
  const user2 = makeUser(org.id, { username: `p7a-conc-${RUN}` });
  const uspotNas = newId();
  const chilliNas = newId();
  const quotaPolicy = newId();
  const t0 = new Date(Date.now() - 3600_000);

  function raw(
    sessionId: string,
    over: Partial<RawAccountingRow> & { at: number },
    nasIp = USPOT_IP,
  ): RawAccountingRow {
    radacct += 1;
    const received = new Date(t0.getTime() + over.at * 1000);
    return {
      radacctid: radacct,
      acctsessionid: `as-${sessionId}`,
      acctuniqueid: `uq-${sessionId}`,
      username: user.username,
      nasipaddress: nasIp,
      nasidentifier: null,
      nasportid: null,
      acctsessiontime: 0,
      acctinputoctets: 0,
      acctoutputoctets: 0,
      acctinterval: null,
      calledstationid: null,
      callingstationid: 'AA-BB-CC-77-00-01',
      acctterminatecause: null,
      framedipaddress: null,
      class: classFor(sessionId),
      acctstatustype: 'Interim-Update',
      eventtimestamp: received,
      acctdelaytime: 0,
      received_at: received,
      packet_src_ip: nasIp,
      ...over,
    };
  }

  async function feed(rows: RawAccountingRow[]): Promise<void> {
    for (const r of rows) {
      await withPlatform(db, { reason: 'test:p7a', audit: false }, (trx) =>
        processRecord(trx, normalizeAccounting(r), new Map()),
      );
    }
  }

  async function session(id: string) {
    return db
      .selectFrom('sessions')
      .select(['input_octets', 'output_octets', 'input_wrap_offset', 'output_wrap_offset'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
  }

  async function anomalies(id: string) {
    return db
      .selectFrom('accounting_anomalies')
      .select([
        'counter',
        'previous',
        'observed',
        'estimated_lost_bytes',
        'applied',
        'reason',
        'adapter_key',
      ])
      .where('session_id', '=', id)
      .orderBy('created_at')
      .execute();
  }

  beforeAll(async () => {
    const { databaseUrl } = await migrateTestDatabase();
    db = createDb(createPool(databaseUrl, { max: 4, applicationName: 'ecloud-worker-p7a-it' }));
    await db.insertInto('organizations').values(org).execute();
    await db.insertInto('sites').values(site).execute();
    await db.insertInto('users').values([user, user2]).execute();
    await db
      .insertInto('nas_clients')
      .values([
        {
          id: uspotNas,
          organization_id: org.id,
          site_id: site.id,
          name: `uspot ${RUN}`,
          nas_ip: USPOT_IP,
          adapter_type_key: 'openwifi-uspot-uam',
          adapter_key: 'openwifi-uspot-uam',
          secret_ref: 'env:ECLOUD_WORKER_IT_NAS_SECRET',
        },
        {
          id: chilliNas,
          organization_id: org.id,
          site_id: site.id,
          name: `chilli ${RUN}`,
          nas_ip: CHILLI_IP,
          adapter_type_key: 'coovachilli-uam',
          adapter_key: 'coovachilli-uam',
          secret_ref: 'env:ECLOUD_WORKER_IT_NAS_SECRET',
        },
      ])
      .execute();
    await db
      .insertInto('policies')
      .values({
        id: quotaPolicy,
        organization_id: org.id,
        name: `quota ${RUN}`,
        scope_type: 'user',
        quota_total_bytes: 1_000,
        status: 'active',
      })
      .execute();
  }, 120_000);

  afterAll(async () => {
    await db?.destroy();
  });

  it('SIM-14 vector: unambiguous 32-bit wrap is recorded and corrected (offset + raw), reorder-safe', async () => {
    const id = newId();
    const before = TWO_POW_32 - 100;
    await feed([
      raw(id, { acctstatustype: 'Start', at: 0 }),
      raw(id, { at: 300, acctsessiontime: 300, acctinputoctets: 10, acctoutputoctets: before }),
      raw(id, { at: 600, acctsessiontime: 600, acctinputoctets: 20, acctoutputoctets: 500 }),
    ]);
    expect(await session(id)).toEqual({
      input_octets: 20,
      output_octets: TWO_POW_32 + 500,
      input_wrap_offset: 0,
      output_wrap_offset: TWO_POW_32,
    });
    const a = await anomalies(id);
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({
      counter: 'outputOctets',
      previous: before,
      observed: 500,
      estimated_lost_bytes: 600,
      applied: true,
      adapter_key: 'openwifi-uspot-uam',
    });
    // Usage counters got the corrected delta: 10 + 10 in, (2^32 − 100) + 600 out.
    const usage = await db
      .selectFrom('usage_counters')
      .select(['bytes_in', 'bytes_out'])
      .where('subject_type', '=', 'user')
      .where('subject_id', '=', user.id)
      .where('period_type', '=', 'total')
      .executeTakeFirstOrThrow();
    expect(usage).toEqual({ bytes_in: 20, bytes_out: TWO_POW_32 + 500 });
    const events = await db
      .selectFrom('outbox')
      .select('payload')
      .where('organization_id', '=', org.id)
      .where('event', '=', 'accounting.anomaly_detected')
      .execute();
    expect(events.some((e) => (e.payload as { data: { applied: boolean } }).data.applied)).toBe(
      true,
    );

    // A reordered pre-wrap Interim (older session time) adds nothing; a later one adds its delta.
    await feed([
      raw(id, {
        at: 450,
        acctsessiontime: 450,
        acctinputoctets: 15,
        acctoutputoctets: before - 50,
      }),
      raw(id, { at: 900, acctsessiontime: 900, acctinputoctets: 30, acctoutputoctets: 1_000 }),
    ]);
    expect(await session(id)).toMatchObject({
      input_octets: 30,
      output_octets: TWO_POW_32 + 1_000,
    });
    expect(await anomalies(id)).toHaveLength(1);
  });

  it('SIM-14 vector: both directions wrap in one record → two anomalies, both corrected', async () => {
    const id = newId();
    await feed([
      raw(id, { acctstatustype: 'Start', at: 0 }),
      raw(id, {
        at: 10,
        acctsessiontime: 10,
        acctinputoctets: TWO_POW_32 - 1,
        acctoutputoctets: TWO_POW_32 - 2,
      }),
      raw(id, { at: 20, acctsessiontime: 20, acctinputoctets: 0, acctoutputoctets: 3 }),
    ]);
    const a = await anomalies(id);
    expect(a.map((x) => [x.counter, x.estimated_lost_bytes, x.applied])).toEqual([
      ['inputOctets', 1, true],
      ['outputOctets', 5, true],
    ]);
    expect(await session(id)).toMatchObject({
      input_octets: TWO_POW_32,
      output_octets: TWO_POW_32 + 3,
    });
  });

  it('ambiguous decrease (mid-range reset) is recorded but NOT corrected', async () => {
    const id = newId();
    await feed([
      raw(id, { acctstatustype: 'Start', at: 0 }),
      raw(id, { at: 300, acctsessiontime: 300, acctoutputoctets: 1_000_000_000 }),
      raw(id, { at: 600, acctsessiontime: 600, acctoutputoctets: 10 }),
    ]);
    const a = await anomalies(id);
    expect(a).toHaveLength(1);
    expect(a[0]?.applied).toBe(false);
    expect(a[0]?.reason).toMatch(/^W2:/);
    expect(await session(id)).toMatchObject({
      output_octets: 1_000_000_000,
      output_wrap_offset: 0,
    });
  });

  it('a 64-bit adapter (CoovaChilli) has no quirks hook: no anomaly, monotonic rule unchanged', async () => {
    const id = newId();
    await feed([
      raw(id, { acctstatustype: 'Start', at: 0 }, CHILLI_IP),
      raw(id, { at: 300, acctsessiontime: 300, acctoutputoctets: TWO_POW_32 - 100 }, CHILLI_IP),
      raw(id, { at: 600, acctsessiontime: 600, acctoutputoctets: 500 }, CHILLI_IP),
    ]);
    expect(await anomalies(id)).toHaveLength(0);
    expect((await session(id)).output_octets).toBe(TWO_POW_32 - 100);
  });

  async function openSession(
    id: string,
    opts: { userId: string; mac: string; startedAt: Date; policyId?: string; snapshot?: unknown },
  ): Promise<void> {
    await db
      .insertInto('sessions')
      .values({
        id,
        organization_id: org.id,
        site_id: site.id,
        nas_client_id: chilliNas,
        user_id: opts.userId,
        policy_id: opts.policyId ?? null,
        acct_session_id: `as-${id}`,
        acct_unique_id: `uq-open-${id}`,
        mac: opts.mac,
        started_at: opts.startedAt,
        status: 'active',
      })
      .execute();
    if (opts.snapshot !== undefined) {
      await db
        .insertInto('policy_translations')
        .values({
          organization_id: org.id,
          policy_id: opts.policyId ?? null,
          policy_version: 1,
          adapter_type_key: 'coovachilli-uam',
          nas_client_id: chilliNas,
          session_id: id,
          trigger: 'authorize',
          input_snapshot: JSON.stringify(opts.snapshot),
          emitted: JSON.stringify([
            {
              name: 'Session-Timeout',
              value: 1800,
              status: 'VERIFIED_SUPPORTED',
              field: 'session_bound',
            },
          ]),
        })
        .execute();
    }
  }

  async function enforcementOf(id: string) {
    return db
      .selectFrom('session_enforcement')
      .select(['trigger', 'strategy', 'state', 'reason', 'expected_apply_by'])
      .where('session_id', '=', id)
      .orderBy('created_at')
      .execute();
  }

  it('quota breach → pending next_reauth (no Disconnect: D-006), once per breach', async () => {
    const id = newId();
    const startedAt = new Date(Date.now() - 600_000);
    await openSession(id, {
      userId: user.id,
      mac: 'aa:bb:cc:77:10:01',
      startedAt,
      policyId: quotaPolicy,
      snapshot: { effective: { fields: { quota_total_bytes: '1000' } } },
    });
    // user already has > 1000 bytes total from the SIM-14 tests above
    const deps = {
      db,
      state: new MemoryWorkerState(),
      logger,
      coaEnabled: false,
      enqueueDisconnect: () => Promise.resolve(),
    };
    const result = await enforceQuotas(deps, [id]);
    expect(result).toMatchObject({ breaches: 1, pending: 1, disconnectsQueued: 0 });
    const rows = await enforcementOf(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      trigger: 'quota_breach',
      strategy: 'next_reauth',
      state: 'pending',
    });
    expect(rows[0]?.reason).toMatch(
      /^quota_total: \d+ >= 1000 bytes; applies at the next Access-Request/,
    );
    expect(rows[0]?.expected_apply_by?.getTime()).toBe(startedAt.getTime() + 1800_000);
    // Lab opt-in on: a Disconnect experiment is queued, but the relied-on strategy is unchanged.
    await enforceQuotas({ ...deps, state: new MemoryWorkerState(), coaEnabled: true }, [id]);
    expect(await enforcementOf(id)).toHaveLength(1);
  });

  it('schedule end → pending schedule_end next_reauth; idempotent; applied once the session ends', async () => {
    const id = newId();
    const now = new Date();
    const day = ((now.getUTCDay() + 6) % 7) + 1; // ISO day 1..7
    // A window that ended an hour ago today (UTC), or yesterday's when it is before 02:00.
    const endH = now.getUTCHours() >= 2 ? now.getUTCHours() - 1 : 23;
    const hh = (h: number) => `${String(h).padStart(2, '0')}:00`;
    const ruleDay = now.getUTCHours() >= 2 ? day : ((day + 5) % 7) + 1;
    await openSession(id, {
      userId: user2.id,
      mac: 'aa:bb:cc:77:20:01',
      startedAt: new Date(now.getTime() - 7200_000),
      snapshot: {
        effective: {
          fields: {},
          schedule: {
            id: 'sched-1',
            timezone: 'UTC',
            rules: [{ days: [ruleDay], start: hh(endH - 1 < 0 ? 0 : endH - 1), end: hh(endH) }],
          },
          provenance: {},
        },
      },
    });
    const first = await enforceRuntimeLimits({
      db,
      logger,
      coaEnabled: false,
      organizationId: org.id,
      now: () => now,
    });
    expect(first.scheduleEnded).toBe(1);
    const again = await enforceRuntimeLimits({
      db,
      logger,
      coaEnabled: false,
      organizationId: org.id,
      now: () => now,
    });
    expect(again.scheduleEnded).toBe(0);
    expect((await enforcementOf(id)).map((r) => [r.trigger, r.strategy, r.state])).toEqual([
      ['schedule_end', 'next_reauth', 'pending'],
    ]);

    await db
      .updateTable('sessions')
      .set({ status: 'stopped', stopped_at: now, terminate_cause: 'session_timeout' })
      .where('id', '=', id)
      .execute();
    expect(await resolveClosedEnforcement(db, now, org.id)).toBeGreaterThanOrEqual(1);
    expect((await enforcementOf(id)).map((r) => r.state)).toEqual(['applied']);
  });

  it('late-detected concurrency: the newest session beyond max_concurrent_sessions is pending', async () => {
    const subject = makeUser(org.id, { username: `p7a-race-${RUN}` });
    await db.insertInto('users').values(subject).execute();
    const snapshot = { effective: { fields: { max_concurrent_sessions: 2 } } };
    const ids = [newId(), newId(), newId()];
    for (const [i, id] of ids.entries()) {
      await openSession(id, {
        userId: subject.id,
        mac: `aa:bb:cc:77:30:0${String(i)}`,
        startedAt: new Date(Date.now() - (300 - i * 60) * 1000),
        snapshot,
      });
    }
    const result = await enforceRuntimeLimits({
      db,
      logger,
      coaEnabled: false,
      organizationId: org.id,
    });
    expect(result.concurrencyBreaches).toBe(1);
    expect(await enforcementOf(ids[0] as string)).toHaveLength(0);
    expect(await enforcementOf(ids[1] as string)).toHaveLength(0);
    expect((await enforcementOf(ids[2] as string))[0]).toMatchObject({
      trigger: 'concurrency',
      strategy: 'next_reauth',
      state: 'pending',
    });
  });

  /** A schedule whose only window closed within the last two hours (UTC). */
  function closedSchedule(now: Date) {
    const day = ((now.getUTCDay() + 6) % 7) + 1;
    const late = now.getUTCHours() >= 2;
    const endH = late ? now.getUTCHours() - 1 : 23;
    const hh = (h: number) => `${String(h).padStart(2, '0')}:00`;
    return {
      id: 'sched-closed',
      timezone: 'UTC',
      rules: [{ days: [late ? day : ((day + 5) % 7) + 1], start: hh(endH - 1), end: hh(endH) }],
    };
  }

  async function pendingEvents(id: string): Promise<number> {
    const rows = await db
      .selectFrom('outbox')
      .select('payload')
      .where('organization_id', '=', org.id)
      .where('event', '=', 'session.enforcement_pending')
      .execute();
    return rows.filter(
      (r) => (r.payload as { data: { session_id: string } }).data.session_id === id,
    ).length;
  }

  it('review fix 1: simultaneous breaches over two ticks → one pending row, triggers merged, no repeated events, quota row kept', async () => {
    const subject = makeUser(org.id, { username: `p7a-multi-${RUN}` });
    await db.insertInto('users').values(subject).execute();
    const now = new Date();
    const snapshot = {
      effective: {
        fields: { max_concurrent_sessions: 1 },
        schedule: closedSchedule(now),
        provenance: {},
      },
    };
    const older = newId();
    const x = newId();
    await openSession(older, {
      userId: subject.id,
      mac: 'aa:bb:cc:77:40:01',
      startedAt: new Date(now.getTime() - 3 * 3600_000),
      snapshot,
    });
    await openSession(x, {
      userId: subject.id,
      mac: 'aa:bb:cc:77:40:02',
      startedAt: new Date(now.getTime() - 2 * 3600_000),
      snapshot,
    });
    // A quota breach is pending first.
    await withPlatform(db, { reason: 'test:p7a', audit: false }, (trx) =>
      recordRuntimeEnforcement(trx, {
        organizationId: org.id,
        siteId: site.id,
        sessionId: x,
        startedAt: now,
        adapterKey: 'coovachilli-uam',
        trigger: 'quota_breach',
        breach: 'quota_total: 2000 >= 1000 bytes',
        policyId: null,
        coaEnabled: false,
        now,
      }),
    );
    const tick = () =>
      enforceRuntimeLimits({
        db,
        logger,
        coaEnabled: false,
        organizationId: org.id,
        now: () => now,
      });
    await tick();
    const afterFirst = await pendingEvents(x);
    await tick();
    await tick();
    expect(await pendingEvents(x)).toBe(afterFirst);
    expect(afterFirst).toBe(3); // insert (quota) + merge schedule_end + merge concurrency
    const rows = await db
      .selectFrom('session_enforcement')
      .select(['trigger', 'state', 'detail'])
      .where('session_id', '=', x)
      .execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ trigger: 'quota_breach', state: 'pending' });
    expect((rows[0]?.detail as { triggers: string[] }).triggers.sort()).toEqual([
      'concurrency',
      'quota_breach',
      'schedule_end',
    ]);
  });

  it('review fix 4: concurrent writers on one session serialise (no 23505), one pending row', async () => {
    const subject = makeUser(org.id, { username: `p7a-race2-${RUN}` });
    await db.insertInto('users').values(subject).execute();
    const x = newId();
    const now = new Date();
    await openSession(x, { userId: subject.id, mac: 'aa:bb:cc:77:50:01', startedAt: now });
    const triggers = ['quota_breach', 'schedule_end', 'concurrency'] as const;
    const results = await Promise.allSettled(
      Array.from({ length: 9 }, (_, i) =>
        withPlatform(db, { reason: 'test:p7a', audit: false }, (trx) =>
          recordRuntimeEnforcement(trx, {
            organizationId: org.id,
            siteId: site.id,
            sessionId: x,
            startedAt: now,
            adapterKey: 'coovachilli-uam',
            trigger: triggers[i % 3] as (typeof triggers)[number],
            breach: `race ${String(i)}`,
            policyId: null,
            coaEnabled: false,
            now,
          }),
        ),
      ),
    );
    expect(results.filter((r) => r.status === 'rejected')).toEqual([]);
    expect(results.filter((r) => r.status === 'fulfilled' && r.value).length).toBe(3);
    const rows = await db
      .selectFrom('session_enforcement')
      .select(['state', 'detail'])
      .where('session_id', '=', x)
      .execute();
    expect(rows).toHaveLength(1);
    expect((rows[0]?.detail as { triggers: string[] }).triggers).toHaveLength(3);
  });
});
