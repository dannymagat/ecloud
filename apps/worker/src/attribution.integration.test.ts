/**
 * Regression suite for the cross-tenant accounting attribution defect found by L4 SIM-18
 * (MULTI_VENDOR_INTEGRATION_PLAN.md §8.2 implementation notes): Acct-Unique-Session-Id and Class
 * are NAS-supplied, so a session may only be attached to records of the NAS (and organization)
 * resolved from the authenticated packet source. Also: `stale` sessions are reaped.
 */
import { randomBytes } from 'node:crypto';
import { createDb, createPool, type Db } from '@ecloud/db';
import { createLogger, newId } from '@ecloud/shared';
import {
  describeIntegration,
  makeOrganization,
  makeSite,
  migrateTestDatabase,
} from '@ecloud/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { ACCT_UNIQUE_ID_COLLISION_ACTION, DRAIN_CURSOR, drainOnce } from './accounting/drain.js';
import { MemoryWorkerState } from './infra/state.js';
import { LOST_INTERIM_CAUSE, reapSessions } from './jobs/reap.js';

const logger = createLogger({ name: 'worker-attribution-it', level: 'silent' });
const RUN = randomBytes(4).toString('hex');
const octet = () => String(1 + ((randomBytes(1)[0] ?? 0) % 250));
const IP_A = `198.18.${octet()}.${octet()}`;
const IP_B = `198.19.${octet()}.${octet()}`;

function classFor(sessionId: string): string {
  const hex = sessionId.replace(/-/g, '');
  return `0x61693a${Buffer.from(hex, 'latin1').toString('hex')}`;
}

await describeIntegration('@ecloud/worker accounting attribution (SIM-18 regression)', () => {
  let db: Db;
  const orgA = makeOrganization({ slug: `attr-a-${RUN}` });
  const orgB = makeOrganization({ slug: `attr-b-${RUN}` });
  const siteA = makeSite(orgA.id, { timezone: 'UTC' });
  const siteB = makeSite(orgB.id, { timezone: 'UTC' });
  const nasA = newId();
  const nasB = newId();
  const t0 = new Date(Date.now() - 3 * 3600_000);
  const at = (minutes: number) => new Date(t0.getTime() + minutes * 60_000);

  async function insertRaw(rows: Record<string, unknown>[]): Promise<number[]> {
    const inserted = await db
      .insertInto('radius.radacct_raw')
      .values(
        rows.map((r) => ({
          acctdelaytime: 0,
          ...r,
          nasipaddress: r.packet_src_ip as string,
          eventtimestamp: r.received_at as Date,
        })) as never,
      )
      .returning('radacctid')
      .execute();
    return inserted.map((r) => r.radacctid);
  }

  async function drainFrom(firstId: number) {
    const state = new MemoryWorkerState();
    await state.setCursor(DRAIN_CURSOR, firstId - 1);
    return drainOnce({ db, state, logger, batchSize: 1000, lagMs: 0 });
  }

  beforeAll(async () => {
    const { databaseUrl } = await migrateTestDatabase();
    db = createDb(createPool(databaseUrl, { max: 4, applicationName: 'ecloud-worker-attr-it' }));
    await db.insertInto('organizations').values([orgA, orgB]).execute();
    await db.insertInto('sites').values([siteA, siteB]).execute();
    for (const [id, org, site, ip] of [
      [nasA, orgA.id, siteA.id, IP_A],
      [nasB, orgB.id, siteB.id, IP_B],
    ] as const) {
      await db
        .insertInto('nas_clients')
        .values({
          id,
          organization_id: org,
          site_id: site,
          name: `NAS ${RUN}`,
          nas_ip: ip,
          adapter_type_key: 'coovachilli-uam',
          adapter_key: 'coovachilli-uam',
          secret_ref: 'env:ECLOUD_WORKER_IT_NAS_SECRET',
        })
        .execute();
    }
  }, 120_000);

  afterAll(async () => {
    await db?.destroy();
  });

  it("a colliding Acct-Unique-Session-Id from another tenant's NAS never touches the first session", async () => {
    const unique = `collide-${RUN}`;
    const [first] = await insertRaw([
      {
        acctuniqueid: unique,
        acctsessionid: `s-${RUN}`,
        acctstatustype: 'Start',
        packet_src_ip: IP_A,
        received_at: at(0),
      },
      {
        acctuniqueid: unique,
        acctsessionid: `s-${RUN}`,
        acctstatustype: 'Interim-Update',
        packet_src_ip: IP_A,
        acctinputoctets: 1000,
        acctoutputoctets: 2000,
        acctsessiontime: 300,
        received_at: at(5),
      },
      {
        // B retransmits / updates the colliding session: still exactly one audit row (F6)
        acctuniqueid: unique,
        acctsessionid: `s-${RUN}`,
        acctstatustype: 'Interim-Update',
        packet_src_ip: IP_B,
        acctinputoctets: 9_000_000,
        acctoutputoctets: 9_000_000,
        acctsessiontime: 360,
        received_at: at(6),
      },
      {
        acctuniqueid: unique,
        acctsessionid: `s-${RUN}`,
        acctstatustype: 'Stop',
        packet_src_ip: IP_B,
        acctinputoctets: 9_000_001,
        acctoutputoctets: 9_000_001,
        acctsessiontime: 420,
        acctterminatecause: 'Admin-Reset',
        received_at: at(7),
      },
    ]);
    const result = await drainFrom(first ?? 0);
    expect(result.skipped).toBe(0);

    const sessions = await db
      .selectFrom('sessions')
      .select(['organization_id', 'nas_client_id', 'status', 'input_octets', 'output_octets'])
      .where('acct_unique_id', '=', unique)
      .execute();
    expect(sessions).toEqual([
      {
        organization_id: orgA.id,
        nas_client_id: nasA,
        status: 'active',
        input_octets: 1000,
        output_octets: 2000,
      },
    ]);
    const records = await db
      .selectFrom('accounting_records')
      .select(['organization_id', 'session_id', 'status_type'])
      .where('acct_unique_id', '=', unique)
      .orderBy('id')
      .execute();
    expect(records.map((r) => r.organization_id)).toEqual([orgA.id, orgA.id, orgB.id, orgB.id]);
    expect(records.slice(2).map((r) => r.session_id)).toEqual([null, null]);
    const audit = await db
      .selectFrom('audit_logs')
      .select(['organization_id', 'target_id'])
      .where('action', '=', ACCT_UNIQUE_ID_COLLISION_ACTION)
      .where('target_id', '=', nasB)
      .execute();
    expect(audit).toEqual([{ organization_id: null, target_id: nasB }]);
  });

  it("an echoed Class of another tenant's (or another NAS's) session opens a separate session", async () => {
    const [a] = await insertRaw([
      {
        acctuniqueid: `cls-a-${RUN}`,
        acctsessionid: `ca-${RUN}`,
        acctstatustype: 'Start',
        packet_src_ip: IP_A,
        received_at: at(10),
      },
    ]);
    await drainFrom(a ?? 0);
    const sessionA = await db
      .selectFrom('sessions')
      .select(['id', 'input_octets'])
      .where('acct_unique_id', '=', `cls-a-${RUN}`)
      .executeTakeFirstOrThrow();
    const [b] = await insertRaw([
      {
        acctuniqueid: `cls-b-${RUN}`,
        acctsessionid: `cb-${RUN}`,
        acctstatustype: 'Interim-Update',
        packet_src_ip: IP_B,
        class: classFor(sessionA.id),
        acctinputoctets: 777_777,
        acctsessiontime: 60,
        received_at: at(11),
      },
    ]);
    await drainFrom(b ?? 0);
    const afterA = await db
      .selectFrom('sessions')
      .select('input_octets')
      .where('id', '=', sessionA.id)
      .executeTakeFirstOrThrow();
    expect(afterA.input_octets).toBe(sessionA.input_octets);
    const sessionB = await db
      .selectFrom('sessions')
      .select(['organization_id', 'nas_client_id', 'input_octets'])
      .where('acct_unique_id', '=', `cls-b-${RUN}`)
      .executeTakeFirstOrThrow();
    expect(sessionB).toEqual({
      organization_id: orgB.id,
      nas_client_id: nasB,
      input_octets: 777_777,
    });
  });

  it('stale sessions (Accounting-On) are closed by the reaper after the grace period', async () => {
    const staleId = newId();
    const freshId = newId();
    for (const [id, startedAt] of [
      [staleId, at(0)],
      [freshId, new Date()],
    ] as const) {
      await db
        .insertInto('sessions')
        .values({
          id,
          organization_id: orgA.id,
          site_id: siteA.id,
          nas_client_id: nasA,
          acct_session_id: `stale-${id}`,
          acct_unique_id: `stale-${id}`,
          started_at: startedAt,
          status: 'stale',
        })
        .execute();
    }
    const reaped = await reapSessions({ db, interimIntervalS: 300, graceS: 120 });
    expect(reaped).toBeGreaterThanOrEqual(1);
    const rows = await db
      .selectFrom('sessions')
      .select(['id', 'status', 'terminate_cause'])
      .where('id', 'in', [staleId, freshId])
      .execute();
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(byId[staleId]).toMatchObject({ status: 'stopped', terminate_cause: LOST_INTERIM_CAUSE });
    expect(byId[freshId]).toMatchObject({ status: 'stale', terminate_cause: null });
  });

  it('a stale session revived by a Start is not reaped on its old timestamp (F5)', async () => {
    const id = newId();
    const unique = `revive-${RUN}`;
    await db
      .insertInto('sessions')
      .values({
        id,
        organization_id: orgA.id,
        site_id: siteA.id,
        nas_client_id: nasA,
        acct_session_id: unique,
        acct_unique_id: unique,
        started_at: at(0),
        status: 'stale',
      })
      .execute();
    const now = new Date();
    const [first] = await insertRaw([
      {
        acctuniqueid: unique,
        acctsessionid: unique,
        acctstatustype: 'Start',
        packet_src_ip: IP_A,
        received_at: now,
      },
    ]);
    await drainFrom(first ?? 0);
    const revived = await db
      .selectFrom('sessions')
      .select(['status', 'last_interim_at'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(revived.status).toBe('active');
    expect(revived.last_interim_at?.getTime()).toBe(now.getTime());
    await reapSessions({ db, interimIntervalS: 300, graceS: 120 });
    const after = await db
      .selectFrom('sessions')
      .select('status')
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(after.status).toBe('active');
  });
});
