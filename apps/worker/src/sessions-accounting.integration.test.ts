/**
 * Phase 8 P8-A worker paths against `ECLOUD_TEST_DATABASE_URL` (platform role, ecloud_test):
 * - the drainer advances `site` usage counters (migration 024) in the site timezone (Q65)
 *   alongside the user counters;
 * - the pending-action sweep hands API-committed Disconnect / CoA rows to the dispatcher queues
 *   (fresh `pending` only; terminal and stale rows are left alone).
 * Own organization and NAS address; the sweep is global, so assertions are limited to own rows.
 */
import { randomBytes, randomInt } from 'node:crypto';
import { normalizeAccounting, type RawAccountingRow } from '@ecloud/adapters';
import { createDb, createPool, withPlatform, type Db } from '@ecloud/db';
import { localDateKey } from '@ecloud/policy-engine';
import { newId } from '@ecloud/shared';
import {
  describeIntegration,
  makeOrganization,
  makeSite,
  makeUser,
  migrateTestDatabase,
} from '@ecloud/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { processRecord } from './accounting/drain.js';
import { localHourStart } from './accounting/normalize.js';
import { sweepPendingSessionActions } from './coa/sweep.js';
import { MemoryWorkerState } from './infra/state.js';
import { pruneRetention } from './jobs/retention.js';

const RUN = randomBytes(4).toString('hex');
const octet = () => String(2 + randomInt(250));
const NAS_IP = `198.20.${octet()}.${octet()}`;

function classFor(sessionId: string): string {
  return `0x61693a${Buffer.from(sessionId.replace(/-/g, ''), 'latin1').toString('hex')}`;
}

let radacct = 7_000_000_000 + randomInt(1_000_000_000);

await describeIntegration('@ecloud/worker P8-A site counters and action sweep', () => {
  let db: Db;
  const org = makeOrganization({ slug: `worker-p8a-${RUN}` });
  const site = makeSite(org.id, { timezone: 'Asia/Dubai' });
  const user = makeUser(org.id, { username: `p8a-${RUN}` });
  const nasId = newId();

  function raw(
    sessionId: string,
    over: Partial<RawAccountingRow> & { at: Date },
  ): RawAccountingRow {
    radacct += 1;
    return {
      radacctid: radacct,
      acctsessionid: `as-${sessionId}`,
      acctuniqueid: `uq-${sessionId}`,
      username: user.username,
      nasipaddress: NAS_IP,
      nasidentifier: null,
      nasportid: null,
      acctsessiontime: 0,
      acctinputoctets: 0,
      acctoutputoctets: 0,
      acctinterval: null,
      calledstationid: null,
      callingstationid: 'AA-BB-CC-88-00-01',
      acctterminatecause: null,
      framedipaddress: null,
      class: classFor(sessionId),
      acctstatustype: 'Interim-Update',
      eventtimestamp: over.at,
      acctdelaytime: 0,
      received_at: over.at,
      packet_src_ip: NAS_IP,
      ...over,
    };
  }

  beforeAll(async () => {
    const { databaseUrl } = await migrateTestDatabase();
    db = createDb(createPool(databaseUrl, { max: 2, applicationName: 'ecloud-worker-p8a-it' }));
    await db.insertInto('organizations').values(org).execute();
    await db.insertInto('sites').values(site).execute();
    await db.insertInto('users').values(user).execute();
    await db
      .insertInto('nas_clients')
      .values({
        id: nasId,
        organization_id: org.id,
        site_id: site.id,
        name: `hostapd ${RUN}`,
        nas_ip: NAS_IP,
        adapter_type_key: 'openwifi-hostapd-radius',
        adapter_key: 'openwifi-hostapd-radius',
        secret_ref: 'env:ECLOUD_WORKER_IT_NAS_SECRET',
      })
      .execute();
  }, 120_000);

  afterAll(async () => {
    await db?.destroy();
  });

  it('drain advances site counters (daily / monthly in the site TZ, total) with the user counters', async () => {
    const id = newId();
    const t0 = new Date(Date.now() - 600_000);
    const t1 = new Date(Date.now() - 60_000);
    for (const r of [
      raw(id, { acctstatustype: 'Start', at: t0 }),
      raw(id, { at: t1, acctsessiontime: 540, acctinputoctets: 700, acctoutputoctets: 1300 }),
    ]) {
      await withPlatform(db, { reason: 'test:p8a', audit: false }, (trx) =>
        processRecord(trx, normalizeAccounting(r), new Map()),
      );
    }
    const rows = await db
      .selectFrom('usage_counters')
      .select([
        'subject_type',
        'period_type',
        'period_start',
        'bytes_in',
        'bytes_out',
        'session_count',
      ])
      .where('organization_id', '=', org.id)
      .where('subject_type', '=', 'site')
      .where('subject_id', '=', site.id)
      .orderBy('period_type')
      .execute();
    const today = localDateKey(t1, 'Asia/Dubai');
    expect(rows).toEqual([
      {
        subject_type: 'site',
        period_type: 'daily',
        period_start: today,
        bytes_in: 700,
        bytes_out: 1300,
        session_count: 1,
      },
      {
        subject_type: 'site',
        period_type: 'monthly',
        period_start: `${today.slice(0, 7)}-01`,
        bytes_in: 700,
        bytes_out: 1300,
        session_count: 1,
      },
      {
        subject_type: 'site',
        period_type: 'total',
        period_start: '1970-01-01',
        bytes_in: 700,
        bytes_out: 1300,
        session_count: 1,
      },
    ]);
    const userTotal = await db
      .selectFrom('usage_counters')
      .select(['bytes_in', 'bytes_out'])
      .where('subject_type', '=', 'user')
      .where('subject_id', '=', user.id)
      .where('period_type', '=', 'total')
      .executeTakeFirstOrThrow();
    expect(userTotal).toEqual({ bytes_in: 700, bytes_out: 1300 });

    // Migration 026 (P9-A): the hourly site rollup receives the same deltas, keyed by the
    // site-local hour of each accounting event.
    const hourly = await db
      .selectFrom('usage_hourly')
      .select(['hour_start', 'bytes_in', 'bytes_out', 'session_count'])
      .where('organization_id', '=', org.id)
      .where('site_id', '=', site.id)
      .orderBy('hour_start')
      .execute();
    const hours = [...new Set([t0, t1].map((t) => localHourStart(t, 'Asia/Dubai').toISOString()))];
    expect(hourly.map((h) => h.hour_start.toISOString())).toEqual(hours);
    expect(hourly.reduce((a, h) => a + h.bytes_in, 0)).toBe(700);
    expect(hourly.reduce((a, h) => a + h.bytes_out, 0)).toBe(1300);
    expect(hourly.reduce((a, h) => a + h.session_count, 0)).toBe(1);
    expect(hourly[0]?.session_count).toBe(1); // the Start's hour counts the session
  });

  it('sweep enqueues fresh pending actions on the right queue, skips terminal and stale rows', async () => {
    const session = await db
      .selectFrom('sessions')
      .select('id')
      .where('organization_id', '=', org.id)
      .executeTakeFirstOrThrow();
    const fresh = newId();
    const freshCoa = newId();
    const done = newId();
    const stale = newId();
    await db
      .insertInto('session_actions')
      .values([
        {
          id: fresh,
          organization_id: org.id,
          session_id: session.id,
          action: 'disconnect',
          status: 'pending',
        },
        {
          id: freshCoa,
          organization_id: org.id,
          session_id: session.id,
          action: 'coa_update',
          status: 'pending',
        },
        {
          id: done,
          organization_id: org.id,
          session_id: session.id,
          action: 'disconnect',
          status: 'ack',
        },
        {
          id: stale,
          organization_id: org.id,
          session_id: session.id,
          action: 'disconnect',
          status: 'pending',
          created_at: new Date(Date.now() - 2 * 86_400_000),
        },
      ])
      .execute();
    const seen: [string, string][] = [];
    for (let i = 0; i < 20 && !seen.some(([, id]) => id === freshCoa); i += 1) {
      await sweepPendingSessionActions({
        db,
        enqueue: (action, id) => {
          seen.push([action, id]);
          return Promise.resolve();
        },
        batch: 1000,
      });
    }
    expect(seen).toContainEqual(['disconnect', fresh]);
    expect(seen).toContainEqual(['coa_update', freshCoa]);
    expect(seen.map(([, id]) => id)).not.toContain(done);
    expect(seen.map(([, id]) => id)).not.toContain(stale);
    // terminal rows only: nothing to hand over
    await db
      .updateTable('session_actions')
      .set({ status: 'timeout' })
      .where('id', 'in', [fresh, freshCoa, stale])
      .execute();
  });

  it('retention.prune counts old usage_hourly rows in dry-run and deletes only them when applied', async () => {
    const old = new Date(Date.now() - 14 * 31 * 86_400_000); // past the 13-month cutoff
    old.setUTCMinutes(0, 0, 0);
    const recent = localHourStart(new Date(), 'Asia/Dubai');
    await db
      .insertInto('usage_hourly')
      .values([
        { organization_id: org.id, site_id: site.id, hour_start: old, bytes_in: 1 },
        { organization_id: org.id, site_id: site.id, hour_start: recent, bytes_in: 1 },
      ])
      .onConflict((oc) => oc.columns(['organization_id', 'site_id', 'hour_start']).doNothing())
      .execute();
    const hoursOf = async () =>
      (
        await db
          .selectFrom('usage_hourly')
          .select('hour_start')
          .where('site_id', '=', site.id)
          .execute()
      ).map((r) => r.hour_start.toISOString());

    const dry = await pruneRetention({ db, state: new MemoryWorkerState(), apply: false });
    expect(dry.usageHourlyRowsEligible).toBeGreaterThanOrEqual(1);
    expect(dry.usageHourlyRowsDeleted).toBe(0);
    expect(await hoursOf()).toContain(old.toISOString());

    const applied = await pruneRetention({ db, state: new MemoryWorkerState(), apply: true });
    expect(applied.applied).toBe(true);
    expect(applied.usageHourlyRowsDeleted).toBeGreaterThanOrEqual(1);
    const left = await hoursOf();
    expect(left).not.toContain(old.toISOString());
    expect(left).toContain(recent.toISOString());
  });
});
