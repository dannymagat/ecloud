/**
 * RadSec (RFC 6614, migration 034): accounting from the RadSec listener is attributed by the
 * verified client certificate (`packet_tls_client_cn` = NAS id, `packet_tls_client_serial` = the
 * enrolled certificate) and NEVER by the source address, which over RadSec is a NAT address that
 * another tenant may have registered as its nas_ip.
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

const logger = createLogger({ name: 'worker-radsec-it', level: 'silent' });
const RUN = randomBytes(4).toString('hex');
const octet = () => String(2 + ((randomBytes(1)[0] ?? 0) % 250));
// The NAT address both remote sites appear from in this test (not a real address of anything).
const NAT_IP = `64.${octet()}.${octet()}.${octet()}`;
const RADSEC = 'ecloud-radsec';
// Every non-Meraki NAS row needs its own nas_ip (ck_nas_clients_nas_ip_by_adapter, unique), even
// one that only ever talks RadSec; these are never the address its packets arrive from.
const ownAddress = () => `64.${octet()}.${octet()}.${octet()}`;

await describeIntegration('@ecloud/worker RadSec accounting attribution (migration 034)', () => {
  let db: Db;
  const orgA = makeOrganization({ slug: `rs-a-${RUN}` });
  const orgC = makeOrganization({ slug: `rs-c-${RUN}` });
  const siteA = makeSite(orgA.id, { timezone: 'UTC' });
  const siteC = makeSite(orgC.id, { timezone: 'UTC' });
  const nasA = newId();
  const nasC = newId();
  const nasUnenrolled = newId();
  const SERIAL_A = randomBytes(16).toString('hex');
  const t0 = new Date(Date.now() - 2 * 3600_000);
  const at = (minutes: number) => new Date(t0.getTime() + minutes * 60_000);

  async function insertRaw(rows: Record<string, unknown>[]): Promise<number[]> {
    const inserted = await db
      .insertInto('radius.radacct_raw')
      .values(
        rows.map((r) => ({
          acctdelaytime: 0,
          acctstatustype: 'Start',
          packet_client_shortname: RADSEC,
          ...r,
          nasipaddress: NAT_IP,
          packet_src_ip: NAT_IP,
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

  async function owners(unique: string) {
    const sessions = await db
      .selectFrom('sessions')
      .select(['organization_id', 'nas_client_id'])
      .where('acct_unique_id', '=', unique)
      .execute();
    const records = await db
      .selectFrom('accounting_records')
      .select(['organization_id'])
      .where('acct_unique_id', '=', unique)
      .execute();
    return { sessions, records };
  }

  beforeAll(async () => {
    const { databaseUrl } = await migrateTestDatabase();
    db = createDb(createPool(databaseUrl, { max: 4, applicationName: 'ecloud-worker-radsec-it' }));
    await db.insertInto('organizations').values([orgA, orgC]).execute();
    await db.insertInto('sites').values([siteA, siteC]).execute();
    // free the NAT address if an earlier run left it registered
    await db
      .updateTable('nas_clients')
      .set({ deleted_at: new Date() })
      .where('nas_ip', '=', NAT_IP)
      .where('deleted_at', 'is', null)
      .execute();
    const common = {
      adapter_type_key: 'generic-radius-8021x',
      adapter_key: 'generic-radius-8021x',
      secret_ref: 'env:ECLOUD_WORKER_IT_NAS_SECRET',
    } as const;
    await db
      .insertInto('nas_clients')
      .values([
        {
          ...common,
          id: nasA,
          organization_id: orgA.id,
          site_id: siteA.id,
          name: `RadSec ${RUN}`,
          nas_ip: ownAddress(),
          radsec_enabled: true,
          radsec_cert_serial: SERIAL_A,
        },
        {
          // tenant C registered the NAT address as its own (UDP) NAS
          ...common,
          id: nasC,
          organization_id: orgC.id,
          site_id: siteC.id,
          name: `Squat ${RUN}`,
          nas_ip: NAT_IP,
        },
        {
          // a real NAS of tenant A that was never enrolled for RadSec
          ...common,
          id: nasUnenrolled,
          organization_id: orgA.id,
          site_id: siteA.id,
          name: `Unenrolled ${RUN}`,
          nas_ip: ownAddress(),
        },
      ])
      .execute();
  }, 120_000);

  afterAll(async () => {
    await db?.destroy();
  });

  it('attributes by the enrolled certificate, never by the NAT source address', async () => {
    const [first] = await insertRaw([
      {
        acctuniqueid: `rs-ok-${RUN}`,
        acctsessionid: `ok-${RUN}`,
        packet_tls_client_cn: nasA,
        // OpenSSL spelling of the same serial
        packet_tls_client_serial: SERIAL_A.toUpperCase(),
        received_at: at(0),
      },
    ]);
    const result = await drainFrom(first ?? 0);
    expect(result.skipped).toBe(0);

    const { sessions } = await owners(`rs-ok-${RUN}`);
    expect(sessions).toEqual([{ organization_id: orgA.id, nas_client_id: nasA }]);
  });

  it('refuses every RadSec packet without a usable certificate identity', async () => {
    const cases = {
      'no-cn': { packet_tls_client_cn: null, packet_tls_client_serial: SERIAL_A },
      'bad-cn': { packet_tls_client_cn: 'not-a-uuid', packet_tls_client_serial: SERIAL_A },
      'unknown-cn': { packet_tls_client_cn: newId(), packet_tls_client_serial: SERIAL_A },
      'stale-serial': {
        packet_tls_client_cn: nasA,
        packet_tls_client_serial: randomBytes(16).toString('hex'),
      },
      'no-serial': { packet_tls_client_cn: nasA, packet_tls_client_serial: null },
      unenrolled: { packet_tls_client_cn: nasUnenrolled, packet_tls_client_serial: SERIAL_A },
    };
    const [first] = await insertRaw(
      Object.entries(cases).map(([name, identity], i) => ({
        acctuniqueid: `rs-${name}-${RUN}`,
        acctsessionid: `${name}-${RUN}`,
        ...identity,
        received_at: at(10 + i),
      })),
    );
    const result = await drainFrom(first ?? 0);
    expect(result.skipped).toBe(0);

    for (const name of Object.keys(cases)) {
      const { sessions, records } = await owners(`rs-${name}-${RUN}`);
      // Above all, never booked to tenant C, whose nas_ip is the NAT address.
      expect(sessions).toEqual([]);
      for (const r of records) expect(r.organization_id).toBeNull();
    }
  });
});
