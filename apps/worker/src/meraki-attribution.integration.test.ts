/**
 * Cycle E (D-044, migration 032): accounting from the Meraki Cloud is attributed by the matched
 * FreeRADIUS client shortname of the NAS's own listener (`packet_client_shortname`), with the
 * registered NAS-Identifier required, and NEVER by the shared Meraki source address (which
 * another tenant may have registered as its nas_ip).
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
import { DRAIN_CURSOR, drainOnce } from './accounting/drain.js';
import { MemoryWorkerState } from './infra/state.js';

const logger = createLogger({ name: 'worker-meraki-it', level: 'silent' });
const RUN = randomBytes(4).toString('hex');
const octet = () => String(2 + ((randomBytes(1)[0] ?? 0) % 250));
// A public-looking source shared by "the Meraki Cloud" in this test (not a real Meraki address).
const SHARED_IP = `64.${octet()}.${octet()}.${octet()}`;

await describeIntegration('@ecloud/worker Meraki accounting attribution (Cycle E)', () => {
  let db: Db;
  const orgA = makeOrganization({ slug: `mk-a-${RUN}` });
  const orgC = makeOrganization({ slug: `mk-c-${RUN}` });
  const siteA = makeSite(orgA.id, { timezone: 'UTC' });
  const siteC = makeSite(orgC.id, { timezone: 'UTC' });
  const nasA = newId();
  const nasC = newId();
  const IDENT = `ecloud-${randomBytes(8).toString('hex')}`;
  const t0 = new Date(Date.now() - 2 * 3600_000);
  const at = (minutes: number) => new Date(t0.getTime() + minutes * 60_000);

  async function insertRaw(rows: Record<string, unknown>[]): Promise<number[]> {
    const inserted = await db
      .insertInto('radius.radacct_raw')
      .values(
        rows.map((r) => ({
          acctdelaytime: 0,
          ...r,
          nasipaddress: SHARED_IP,
          packet_src_ip: SHARED_IP,
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
    db = createDb(createPool(databaseUrl, { max: 4, applicationName: 'ecloud-worker-meraki-it' }));
    await db.insertInto('organizations').values([orgA, orgC]).execute();
    await db.insertInto('sites').values([siteA, siteC]).execute();
    // free the shared address if an earlier run left it registered
    await db
      .updateTable('nas_clients')
      .set({ deleted_at: new Date() })
      .where('nas_ip', '=', SHARED_IP)
      .where('deleted_at', 'is', null)
      .execute();
    await db
      .insertInto('nas_clients')
      .values([
        {
          id: nasA,
          organization_id: orgA.id,
          site_id: siteA.id,
          name: `Meraki ${RUN}`,
          nas_ip: null,
          nas_identifier: IDENT,
          adapter_type_key: 'meraki-splash',
          adapter_key: 'meraki-splash',
          secret_ref: 'env:ECLOUD_WORKER_IT_NAS_SECRET',
        },
        {
          // tenant C registered the shared Meraki source address as its own NAS
          id: nasC,
          organization_id: orgC.id,
          site_id: siteC.id,
          name: `Squat ${RUN}`,
          nas_ip: SHARED_IP,
          adapter_type_key: 'generic-radius-8021x',
          adapter_key: 'generic-radius-8021x',
          secret_ref: 'env:ECLOUD_WORKER_IT_NAS_SECRET',
        },
      ])
      .execute();
  }, 120_000);

  afterAll(async () => {
    await db?.destroy();
  });

  it('attributes by the listener shortname + NAS-Identifier, never by the shared source IP', async () => {
    const [first] = await insertRaw([
      {
        acctuniqueid: `mk-ok-${RUN}`,
        acctsessionid: `ok-${RUN}`,
        acctstatustype: 'Start',
        nasidentifier: IDENT,
        packet_client_shortname: nasA,
        received_at: at(0),
      },
      {
        // same listener, forged NAS-Identifier → unattributed (no fallback to the source IP)
        acctuniqueid: `mk-forged-${RUN}`,
        acctsessionid: `forged-${RUN}`,
        acctstatustype: 'Start',
        nasidentifier: 'someone-else',
        packet_client_shortname: nasA,
        received_at: at(1),
      },
    ]);
    const result = await drainFrom(first ?? 0);
    expect(result.skipped).toBe(0);

    const ok = await db
      .selectFrom('sessions')
      .select(['organization_id', 'nas_client_id'])
      .where('acct_unique_id', '=', `mk-ok-${RUN}`)
      .execute();
    expect(ok).toEqual([{ organization_id: orgA.id, nas_client_id: nasA }]);

    const forgedSessions = await db
      .selectFrom('sessions')
      .select(['organization_id'])
      .where('acct_unique_id', '=', `mk-forged-${RUN}`)
      .execute();
    expect(forgedSessions).toEqual([]);
    const forgedRecords = await db
      .selectFrom('accounting_records')
      .select(['organization_id'])
      .where('acct_unique_id', '=', `mk-forged-${RUN}`)
      .execute();
    for (const r of forgedRecords) expect(r.organization_id).not.toBe(orgC.id);
    for (const r of forgedRecords) expect(r.organization_id).toBeNull();
  });

  it('a stale or unknown listener shortname is refused, never attributed by the source IP', async () => {
    // nasC (tenant C) owns SHARED_IP as its nas_ip; the rows carry a shortname that names no
    // live NAS (unknown id) or a disabled Meraki NAS: neither may fall back to C
    const disabledId = newId();
    await db
      .insertInto('nas_clients')
      .values({
        id: disabledId,
        organization_id: orgA.id,
        site_id: siteA.id,
        name: `Meraki disabled ${RUN}`,
        nas_ip: null,
        nas_identifier: `ecloud-${randomBytes(8).toString('hex')}`,
        adapter_type_key: 'meraki-splash',
        adapter_key: 'meraki-splash',
        status: 'disabled',
        secret_ref: 'env:ECLOUD_WORKER_IT_NAS_SECRET',
      })
      .execute();
    const [first] = await insertRaw([
      {
        acctuniqueid: `mk-unknown-${RUN}`,
        acctsessionid: `unknown-${RUN}`,
        acctstatustype: 'Start',
        nasidentifier: IDENT,
        packet_client_shortname: newId(),
        received_at: at(10),
      },
      {
        acctuniqueid: `mk-disabled-${RUN}`,
        acctsessionid: `disabled-${RUN}`,
        acctstatustype: 'Start',
        nasidentifier: IDENT,
        packet_client_shortname: disabledId,
        received_at: at(11),
      },
    ]);
    const result = await drainFrom(first ?? 0);
    expect(result.skipped).toBe(0);
    for (const unique of [`mk-unknown-${RUN}`, `mk-disabled-${RUN}`]) {
      const sessions = await db
        .selectFrom('sessions')
        .select(['organization_id'])
        .where('acct_unique_id', '=', unique)
        .execute();
      expect(sessions).toEqual([]);
      const records = await db
        .selectFrom('accounting_records')
        .select(['organization_id'])
        .where('acct_unique_id', '=', unique)
        .execute();
      for (const r of records) expect(r.organization_id).toBeNull();
    }
  });
});
