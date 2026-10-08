/**
 * L4 simulator — DB-backed group (MULTI_VENDOR_INTEGRATION_PLAN.md §8.3 SIM-05, SIM-06, SIM-12,
 * SIM-17, SIM-18) against `ECLOUD_TEST_DATABASE_URL`; skips cleanly without it.
 *
 * - SIM-05/06: the L2 vendor adapters validate redirects whose NAS is resolved from real
 *   `nas_clients` rows of two tenants; the broker/AAA decision is the `SimBroker` stand-in
 *   (tests/simulators/broker.ts) because the Phase 6 broker does not exist yet.
 * - SIM-12/17/18: simulated NAS accounting streams (`SimAccountingSession`) are written to
 *   `radius.radacct_raw` exactly as FreeRADIUS would and processed by the real worker drainer
 *   (`drainOnce`) and reaper (`reapSessions`).
 *
 * Shared database: every fixture is unique to this run (own organizations, random NAS addresses
 * in 198.18.0.0/15, random session ids). Each accounting scenario uses its own epoch far in the
 * past (2020/2021/2022) so the reaper's cutoff can only reach this run's sessions.
 *
 * Simulator evidence: ECLOUD code behaviour only, NOT hardware compatibility.
 */
import { randomBytes } from 'node:crypto';
import { createDb, createPool, type Db } from '@ecloud/db';
import { createLogger, newId } from '@ecloud/shared';
import {
  SIM_UAM_SECRET,
  SimAccountingSession,
  buildUamRedirect,
  describeIntegration,
  makeOrganization,
  makeSite,
  makeUser,
  migrateTestDatabase,
  simClassFor,
  type SimRawAccountingRow,
} from '@ecloud/testing';
import { DRAIN_CURSOR, MemoryWorkerState, drainOnce, reapSessions } from '@ecloud/worker';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SimBroker, dbNasLookup } from './broker.js';
import { CHALLENGE, TARGETS, credential, redirectInput, type SimTarget } from './support.js';

const logger = createLogger({ name: 'sim-it', level: 'silent' });
const RUN = randomBytes(4).toString('hex');
const randomIp = (): string => {
  const b = randomBytes(2);
  return `198.${String(18 + ((b[0] ?? 0) % 2))}.${String(b[1] ?? 0)}.${String(1 + ((b[0] ?? 0) % 250))}`;
};

await describeIntegration('L4 simulators: DB-backed scenarios (SIM-05/06/12/17/18)', () => {
  let db: Db;
  const orgA = makeOrganization({ slug: `sim-a-${RUN}` });
  const orgB = makeOrganization({ slug: `sim-b-${RUN}` });
  const siteA = makeSite(orgA.id);
  const siteB = makeSite(orgB.id);
  const username = `sim-user-${RUN}`;
  const userA = makeUser(orgA.id, { username });
  const userB = makeUser(orgB.id, { username });
  const ips = new Set<string>();
  const freshIp = (): string => {
    let ip = randomIp();
    while (ips.has(ip)) ip = randomIp();
    ips.add(ip);
    return ip;
  };

  interface SimNas {
    id: string;
    org: string;
    site: string;
    ip: string;
    identifier: string;
    adapterKey: string;
  }
  const nas = (org: string, site: string, adapterKey: string, label: string): SimNas => ({
    id: newId(),
    org,
    site,
    ip: freshIp(),
    identifier: `sim-${RUN}-${label}`,
    adapterKey,
  });
  // org A: one NAS per adapter + a second CoovaChilli at the same site (roaming);
  // org B: one NAS per adapter (cross-tenant).
  const A: Record<string, SimNas> = {
    'coovachilli-uam': nas(orgA.id, siteA.id, 'coovachilli-uam', 'a-coova'),
    'openwifi-uspot-uam': nas(orgA.id, siteA.id, 'openwifi-uspot-uam', 'a-tip'),
    roam: nas(orgA.id, siteA.id, 'coovachilli-uam', 'a-coova-2'),
  };
  const B: Record<string, SimNas> = {
    'coovachilli-uam': nas(orgB.id, siteB.id, 'coovachilli-uam', 'b-coova'),
    'openwifi-uspot-uam': nas(orgB.id, siteB.id, 'openwifi-uspot-uam', 'b-tip'),
  };
  const allNas = [...Object.values(A), ...Object.values(B)];
  const nasOf = (group: Record<string, SimNas>, key: string): SimNas => {
    const n = group[key];
    if (!n) throw new Error(`no NAS ${key}`);
    return n;
  };

  const uamFor = (t: SimTarget) => () => ({
    uamServerUrl: t.uamServer,
    uamSecret: SIM_UAM_SECRET,
  });

  async function insertRaw(rows: readonly SimRawAccountingRow[]): Promise<number[]> {
    const inserted = await db
      .insertInto('radius.radacct_raw')
      .values(rows.map(({ radacctid: _id, ...r }) => r) as never)
      .returning('radacctid')
      .execute();
    return inserted.map((r) => Number(r.radacctid));
  }

  async function drainFrom(firstId: number): Promise<void> {
    const state = new MemoryWorkerState();
    await state.setCursor(DRAIN_CURSOR, firstId - 1);
    for (;;) {
      const r = await drainOnce({ db, state, logger, batchSize: 500, lagMs: 0 });
      if (r.read === 0) return;
    }
  }

  async function play(rows: readonly SimRawAccountingRow[]): Promise<void> {
    const ids = await insertRaw(rows);
    await drainFrom(Math.min(...ids));
  }

  const sessionByUnique = (acctUniqueId: string) =>
    db
      .selectFrom('sessions')
      .select([
        'id',
        'organization_id',
        'nas_client_id',
        'status',
        'terminate_cause',
        'input_octets',
        'output_octets',
        'stopped_at',
      ])
      .where('acct_unique_id', '=', acctUniqueId)
      .execute();

  const totalUsage = async (userId: string) =>
    db
      .selectFrom('usage_counters')
      .select(['organization_id', 'bytes_in', 'bytes_out', 'session_count'])
      .where('subject_type', '=', 'user')
      .where('subject_id', '=', userId)
      .where('period_type', '=', 'total')
      .executeTakeFirst();

  function acctSession(
    n: SimNas,
    width: 32 | 64,
    over: { unique?: string; acctSessionId?: string; mac?: string; class?: string | null } = {},
  ): SimAccountingSession {
    return new SimAccountingSession(
      {
        acctSessionId: over.acctSessionId ?? randomBytes(8).toString('hex'),
        acctUniqueId: over.unique ?? `sim-${RUN}-${randomBytes(6).toString('hex')}`,
        username,
        callingStationId: over.mac ?? 'AA-BB-CC-00-00-01',
        calledStationId: '00-11-22-33-44-55',
        nasIp: n.ip,
        nasIdentifier: n.identifier,
        class: over.class ?? null,
      },
      width,
    );
  }

  beforeAll(async () => {
    const { databaseUrl } = await migrateTestDatabase();
    db = createDb(createPool(databaseUrl, { max: 4, applicationName: 'ecloud-sim-it' }));
    await db.insertInto('organizations').values([orgA, orgB]).execute();
    await db.insertInto('sites').values([siteA, siteB]).execute();
    await db.insertInto('users').values([userA, userB]).execute();
    await db
      .insertInto('nas_clients')
      .values(
        allNas.map((n) => ({
          id: n.id,
          organization_id: n.org,
          site_id: n.site,
          name: `SIM ${n.identifier}`,
          nas_identifier: n.identifier,
          nas_ip: n.ip,
          adapter_type_key: n.adapterKey,
          adapter_key: n.adapterKey,
          secret_ref: 'env:ECLOUD_SIM_TEST_NAS_SECRET',
        })),
      )
      .execute();
  }, 120_000);

  afterAll(async () => {
    if (!db) return;
    // Soft-delete this run's NAS rows so their addresses never collide with a later run.
    await db
      .updateTable('nas_clients')
      .set({ deleted_at: new Date() })
      .where(
        'id',
        'in',
        allNas.map((n) => n.id),
      )
      .execute();
    await db.destroy();
  });

  for (const t of TARGETS) {
    const tag = `[${t.adapterKey}]`;
    const nasA = (): SimNas => nasOf(A, t.adapterKey);
    const nasB = (): SimNas => nasOf(B, t.adapterKey);
    const NOW = new Date('2026-10-08T06:00:00Z');

    const redirectFor = (n: SimNas, over: Parameters<typeof redirectInput>[1] = {}) =>
      buildUamRedirect(redirectInput(t, { nasid: n.identifier, ...over }), t.flavour);

    describe(`portal + broker ${tag}`, () => {
      it(`SIM-05 ${tag} redirect from org A's NAS on a portal bound to org B → tenant_mismatch`, async () => {
        const r = redirectFor(nasA());
        const parsed = t.adapter.parseRedirect({ url: r.url, method: 'GET' });
        if ('unsupported' in parsed) throw new Error(parsed.reason);
        const lookupB = dbNasLookup(db, {
          expectedOrganizationId: orgB.id,
          uam: uamFor(t),
          consumed: new Set(),
          now: NOW,
        });
        const v = await t.adapter.validateContext(parsed, lookupB);
        expect(v).toMatchObject({ ok: false, reason: 'tenant_mismatch' });
        if (!v.ok) expect(JSON.stringify(v)).not.toContain(orgA.id);
        // Unbound portal host: tenant comes from the NAS row only (R-26).
        const unbound = await t.adapter.validateContext(
          parsed,
          dbNasLookup(db, {
            expectedOrganizationId: null,
            uam: uamFor(t),
            consumed: new Set(),
            now: NOW,
          }),
        );
        expect(unbound.ok && unbound.context.organizationId).toBe(orgA.id);
      });

      it(`SIM-05 ${tag} credential bound to org B's NAS: no hand-off on A, AAA rejects`, async () => {
        const broker = new SimBroker(db);
        const lookupA = dbNasLookup(db, {
          expectedOrganizationId: orgA.id,
          uam: uamFor(t),
          consumed: new Set(),
          now: NOW,
        });
        const parsed = t.adapter.parseRedirect({ url: redirectFor(nasA()).url, method: 'GET' });
        if ('unsupported' in parsed) throw new Error(parsed.reason);
        const v = await t.adapter.validateContext(parsed, lookupA);
        if (!v.ok) throw new Error(`${v.reason}: ${v.detail}`);
        const credB = broker.issue({
          ...credential(t, { username: `pc-b-${RUN}-${t.adapterKey}`, boundNasId: nasB().id }),
          expiresAt: new Date(NOW.getTime() + 90_000),
          organizationId: orgB.id,
        });
        expect(t.adapter.authorizeSession(v.context, credB, { uamSecret: SIM_UAM_SECRET })).toEqual(
          {
            unsupported: true,
            reason: 'credential is not bound to this NAS and client (SECURITY §5.6)',
          },
        );
        // The browser could still try the credential on A's NAS: the AAA side rejects it.
        const d = await broker.accessRequest({
          packetSrcIp: nasA().ip,
          username: credB.username,
          password: credB.password,
          callingStationId: credB.boundClientMac,
          at: new Date(NOW.getTime() + 10_000),
        });
        expect(d).toEqual({ decision: 'reject', reason: 'tenant_mismatch' });
      });

      it(`SIM-05 ${tag} duplicate nasid across tenants resolves to no NAS (fail closed)`, async () => {
        const dup = {
          ...nasOf(B, t.adapterKey),
          id: newId(),
          ip: freshIp(),
          identifier: nasA().identifier,
        };
        allNas.push(dup);
        await db
          .insertInto('nas_clients')
          .values({
            id: dup.id,
            organization_id: dup.org,
            site_id: dup.site,
            name: `SIM dup ${dup.identifier}`,
            nas_identifier: dup.identifier,
            nas_ip: dup.ip,
            adapter_type_key: dup.adapterKey,
            adapter_key: dup.adapterKey,
            secret_ref: 'env:ECLOUD_SIM_TEST_NAS_SECRET',
          })
          .execute();
        try {
          const parsed = t.adapter.parseRedirect({ url: redirectFor(nasA()).url, method: 'GET' });
          if ('unsupported' in parsed) throw new Error(parsed.reason);
          const v = await t.adapter.validateContext(
            parsed,
            dbNasLookup(db, {
              expectedOrganizationId: null,
              uam: uamFor(t),
              consumed: new Set(),
              now: NOW,
            }),
          );
          expect(v).toMatchObject({ ok: false, reason: 'unknown_nas' });
        } finally {
          await db
            .updateTable('nas_clients')
            .set({ deleted_at: new Date() })
            .where('id', '=', dup.id)
            .execute();
        }
      });

      it(`SIM-06 ${tag} replay after consumption → replayed; second Access-Request rejected`, async () => {
        const broker = new SimBroker(db);
        const sessionid = randomBytes(8).toString('hex');
        const r = redirectFor(nasA(), { sessionid });
        const parsed = t.adapter.parseRedirect({ url: r.url, method: 'GET' });
        if ('unsupported' in parsed) throw new Error(parsed.reason);
        const lookup = dbNasLookup(db, {
          expectedOrganizationId: orgA.id,
          uam: uamFor(t),
          consumed: broker.consumedRedirects,
          now: new Date(),
        });
        const v = await t.adapter.validateContext(parsed, lookup);
        if (!v.ok) throw new Error(`${v.reason}: ${v.detail}`);
        const cred = broker.issue({
          ...credential(t, { username: `pc-a-${RUN}-${sessionid}`, boundNasId: nasA().id }),
          expiresAt: new Date(Date.now() + 90_000),
          organizationId: orgA.id,
        });
        const h = t.adapter.authorizeSession(v.context, cred, { uamSecret: SIM_UAM_SECRET });
        expect('unsupported' in h).toBe(false);
        const req = {
          packetSrcIp: nasA().ip,
          username: cred.username,
          password: cred.password,
          callingStationId: cred.boundClientMac,
          at: new Date(),
        };
        expect(await broker.accessRequest(req)).toMatchObject({
          decision: 'accept',
          organizationId: orgA.id,
        });
        broker.consumedRedirects.add(
          `${nasA().id}|${sessionid}|${CHALLENGE}|${v.context.clientMac}`,
        );
        // Same redirect (same challenge + sessionid + MAC) presented again.
        expect(await t.adapter.validateContext(parsed, lookup)).toMatchObject({
          ok: false,
          reason: 'replayed',
        });
        // Second Access-Request with the consumed credential.
        expect(await broker.accessRequest({ ...req, at: new Date() })).toEqual({
          decision: 'reject',
          reason: 'consumed',
        });
        // Fail closed when the caller supplies no replay check at runtime.
        const noReplay = { ...lookup, isReplay: undefined } as unknown as typeof lookup;
        expect(await t.adapter.validateContext(parsed, noReplay)).toMatchObject({
          ok: false,
          reason: 'replayed',
        });
      });

      it(`SIM-06 ${tag} credential reused after its TTL → hand-off refused and AAA rejects`, async () => {
        const broker = new SimBroker(db);
        const issuedAt = new Date();
        const cred = broker.issue({
          ...credential(t, { username: `pc-ttl-${RUN}-${t.adapterKey}`, boundNasId: nasA().id }),
          expiresAt: new Date(issuedAt.getTime() + 90_000),
          organizationId: orgA.id,
        });
        const later = new Date(issuedAt.getTime() + 120_000);
        // A fresh redirect after the TTL: the hand-off builder sees an expired credential.
        const parsed = t.adapter.parseRedirect({
          url: redirectFor(nasA(), { sessionid: randomBytes(8).toString('hex') }).url,
          method: 'GET',
        });
        if ('unsupported' in parsed) throw new Error(parsed.reason);
        const v = await t.adapter.validateContext(
          parsed,
          dbNasLookup(db, {
            expectedOrganizationId: orgA.id,
            uam: uamFor(t),
            consumed: new Set(),
            now: later,
          }),
        );
        if (!v.ok) throw new Error(`${v.reason}: ${v.detail}`);
        expect(
          t.adapter.authorizeSession(v.context, cred, { uamSecret: SIM_UAM_SECRET }),
        ).toMatchObject({
          unsupported: true,
        });
        expect(
          await broker.accessRequest({
            packetSrcIp: nasA().ip,
            username: cred.username,
            password: cred.password,
            callingStationId: cred.boundClientMac,
            at: later,
          }),
        ).toEqual({ decision: 'reject', reason: 'expired' });
      });
    });
  }

  describe('accounting through the real drainer / reaper', () => {
    for (const t of TARGETS) {
      const tag = `[${t.adapterKey}]`;
      const width = t.adapterKey === 'coovachilli-uam' ? 64 : 32;

      it(`SIM-12 ${tag} missing Stop: reaper closes as lost_interim; late Stop not double-counted`, async () => {
        const n = nasOf(A, t.adapterKey);
        const offset = t.adapterKey === 'coovachilli-uam' ? 0 : 3600;
        const t0 = new Date(Date.UTC(2020, 0, 1, 0, 0, 0) + offset * 1000);
        const at = (min: number): Date => new Date(t0.getTime() + min * 60_000);
        const s = acctSession(n, width);
        const before = await totalUsage(userA.id);
        await play([
          s.row({ status: 'Start', at: at(0) }),
          s.row({
            status: 'Interim-Update',
            at: at(5),
            inputBytes: 1_000,
            outputBytes: 4_000,
            sessionTimeS: 300,
            interimS: 300,
          }),
        ]);
        const reaped = await reapSessions({
          db,
          interimIntervalS: 300,
          graceS: 60,
          now: () => at(30),
        });
        expect(reaped).toBeGreaterThanOrEqual(1);
        const [closed] = await sessionByUnique(s.identity.acctUniqueId);
        expect(closed).toMatchObject({
          status: 'stopped',
          terminate_cause: 'lost_interim',
          organization_id: orgA.id,
        });
        expect(closed?.stopped_at?.toISOString()).toBe(at(5).toISOString());
        // A reaped session is not reaped twice.
        await reapSessions({ db, interimIntervalS: 300, graceS: 60, now: () => at(40) });
        expect((await sessionByUnique(s.identity.acctUniqueId))[0]?.terminate_cause).toBe(
          'lost_interim',
        );
        // The Stop arrives late: only the remainder is added.
        await play([
          s.row({
            status: 'Stop',
            at: at(45),
            inputBytes: 1_500,
            outputBytes: 6_000,
            sessionTimeS: 2700,
            terminateCause: 'Lost-Carrier',
          }),
        ]);
        const after = await totalUsage(userA.id);
        expect(Number(after?.bytes_in) - Number(before?.bytes_in ?? 0)).toBe(1_500);
        expect(Number(after?.bytes_out) - Number(before?.bytes_out ?? 0)).toBe(6_000);
        expect(Number(after?.session_count) - Number(before?.session_count ?? 0)).toBe(1);
        expect((await sessionByUnique(s.identity.acctUniqueId))[0]).toMatchObject({
          status: 'stopped',
          terminate_cause: 'lost_carrier',
        });
      });
    }

    it("SIM-17 [coovachilli-uam] [openwifi-uspot-uam] Accounting-On/Off: that NAS's open sessions marked stale, others untouched, no double count", async () => {
      const t0 = new Date(Date.UTC(2021, 0, 1, 0, 0, 0));
      const at = (min: number): Date => new Date(t0.getTime() + min * 60_000);
      const coova = nasOf(A, 'coovachilli-uam');
      const tip = nasOf(A, 'openwifi-uspot-uam');
      const s1 = acctSession(coova, 64, { mac: 'AA-BB-CC-00-17-01' });
      const s2 = acctSession(coova, 64, { mac: 'AA-BB-CC-00-17-02' });
      const s3 = acctSession(tip, 32, { mac: 'AA-BB-CC-00-17-03' });
      const before = await totalUsage(userA.id);
      await play([
        s1.row({ status: 'Start', at: at(0) }),
        s2.row({ status: 'Start', at: at(1) }),
        s3.row({ status: 'Start', at: at(2) }),
        s1.row({
          status: 'Interim-Update',
          at: at(5),
          inputBytes: 100,
          outputBytes: 200,
          sessionTimeS: 300,
        }),
        s3.row({
          status: 'Interim-Update',
          at: at(6),
          inputBytes: 10,
          outputBytes: 20,
          sessionTimeS: 240,
        }),
      ]);
      // The CoovaChilli NAS reboots: Accounting-On (no session attributes).
      const boot = acctSession(coova, 64, { unique: `sim-${RUN}-acct-on` });
      await play([boot.row({ status: 'Accounting-On', at: at(10) })]);
      const st = async (s: SimAccountingSession) =>
        (await sessionByUnique(s.identity.acctUniqueId))[0];
      expect((await st(s1))?.status).toBe('stale');
      expect((await st(s2))?.status).toBe('stale');
      expect((await st(s3))?.status).toBe('active');
      const onRecord = await db
        .selectFrom('accounting_records')
        .select(['organization_id', 'session_id', 'status_type'])
        .where('acct_unique_id', '=', boot.identity.acctUniqueId)
        .execute();
      expect(onRecord).toEqual([
        { organization_id: orgA.id, session_id: null, status_type: 'accounting_on' },
      ]);
      // After the reboot the client re-authenticates: a new session; the old one is not revived
      // and its usage is not counted again.
      const s1b = acctSession(coova, 64, { mac: 'AA-BB-CC-00-17-01' });
      await play([
        s1b.row({ status: 'Start', at: at(12) }),
        s1b.row({
          status: 'Interim-Update',
          at: at(17),
          inputBytes: 50,
          outputBytes: 70,
          sessionTimeS: 300,
        }),
      ]);
      expect((await st(s1))?.status).toBe('stale');
      expect((await st(s1b))?.status).toBe('active');
      // The uspot NAS sends Accounting-Off: only its session goes stale.
      const off = acctSession(tip, 32, { unique: `sim-${RUN}-acct-off` });
      await play([off.row({ status: 'Accounting-Off', at: at(20) })]);
      expect((await st(s3))?.status).toBe('stale');
      expect((await st(s1b))?.status).toBe('active');
      const after = await totalUsage(userA.id);
      expect(Number(after?.bytes_in) - Number(before?.bytes_in ?? 0)).toBe(100 + 10 + 50);
      expect(Number(after?.bytes_out) - Number(before?.bytes_out ?? 0)).toBe(200 + 20 + 70);
      expect(Number(after?.session_count) - Number(before?.session_count ?? 0)).toBe(4);
    });

    it('SIM-18 [coovachilli-uam] [openwifi-uspot-uam] roaming across two NAS of one site: two sessions, usage = sum of deltas', async () => {
      const t0 = new Date(Date.UTC(2022, 0, 1, 0, 0, 0));
      const at = (min: number): Date => new Date(t0.getTime() + min * 60_000);
      const n1 = nasOf(A, 'coovachilli-uam');
      const n2 = nasOf(A, 'roam');
      const n3 = nasOf(A, 'openwifi-uspot-uam');
      const mac = 'AA-BB-CC-00-18-01';
      // Same Acct-Session-Id on both NAS (devices may reuse ids): sessions must still be distinct.
      const sameId = randomBytes(8).toString('hex');
      const r1 = acctSession(n1, 64, { mac, acctSessionId: sameId });
      const r2 = acctSession(n2, 64, { mac, acctSessionId: sameId });
      const r3 = acctSession(n3, 32, { mac });
      const before = await totalUsage(userA.id);
      await play([
        r1.row({ status: 'Start', at: at(0) }),
        r1.row({
          status: 'Interim-Update',
          at: at(5),
          inputBytes: 1_000,
          outputBytes: 10_000,
          sessionTimeS: 300,
        }),
        r2.row({ status: 'Start', at: at(6) }),
        r3.row({ status: 'Start', at: at(7) }),
        r2.row({
          status: 'Interim-Update',
          at: at(9),
          inputBytes: 300,
          outputBytes: 3_000,
          sessionTimeS: 180,
        }),
        r1.row({
          status: 'Interim-Update',
          at: at(10),
          inputBytes: 1_200,
          outputBytes: 12_000,
          sessionTimeS: 600,
        }),
        r3.row({
          status: 'Interim-Update',
          at: at(11),
          inputBytes: 7,
          outputBytes: 70,
          sessionTimeS: 240,
        }),
        r1.row({
          status: 'Stop',
          at: at(12),
          inputBytes: 1_300,
          outputBytes: 13_000,
          sessionTimeS: 720,
          terminateCause: 'User-Request',
        }),
        r2.row({
          status: 'Stop',
          at: at(15),
          inputBytes: 500,
          outputBytes: 5_000,
          sessionTimeS: 540,
          terminateCause: 'User-Request',
        }),
        r3.row({
          status: 'Stop',
          at: at(16),
          inputBytes: 9,
          outputBytes: 90,
          sessionTimeS: 540,
          terminateCause: 'User-Request',
        }),
      ]);
      const sessions = await db
        .selectFrom('sessions')
        .select(['nas_client_id', 'input_octets', 'output_octets', 'status'])
        .where(
          'acct_unique_id',
          'in',
          [r1, r2, r3].map((s) => s.identity.acctUniqueId),
        )
        .orderBy('input_octets', 'desc')
        .execute();
      expect(sessions).toEqual([
        { nas_client_id: n1.id, input_octets: 1_300, output_octets: 13_000, status: 'stopped' },
        { nas_client_id: n2.id, input_octets: 500, output_octets: 5_000, status: 'stopped' },
        { nas_client_id: n3.id, input_octets: 9, output_octets: 90, status: 'stopped' },
      ]);
      const after = await totalUsage(userA.id);
      expect(Number(after?.bytes_in) - Number(before?.bytes_in ?? 0)).toBe(1_300 + 500 + 9);
      expect(Number(after?.bytes_out) - Number(before?.bytes_out ?? 0)).toBe(13_000 + 5_000 + 90);
      expect(Number(after?.session_count) - Number(before?.session_count ?? 0)).toBe(3);
    });

    it("SIM-18 [coovachilli-uam] [openwifi-uspot-uam] same MAC / user / Acct-Session-Id on another tenant's NAS: separate sessions", async () => {
      const t0 = new Date(Date.UTC(2022, 0, 2, 0, 0, 0));
      const at = (min: number): Date => new Date(t0.getTime() + min * 60_000);
      const mac = 'AA-BB-CC-00-18-02';
      const sameId = randomBytes(8).toString('hex');
      const a = acctSession(nasOf(A, 'coovachilli-uam'), 64, { mac, acctSessionId: sameId });
      const b = acctSession(nasOf(B, 'coovachilli-uam'), 64, { mac, acctSessionId: sameId });
      const beforeA = await totalUsage(userA.id);
      const beforeB = await totalUsage(userB.id);
      await play([
        a.row({ status: 'Start', at: at(0) }),
        b.row({ status: 'Start', at: at(1) }),
        a.row({
          status: 'Interim-Update',
          at: at(5),
          inputBytes: 111,
          outputBytes: 222,
          sessionTimeS: 300,
        }),
        b.row({
          status: 'Interim-Update',
          at: at(6),
          inputBytes: 333,
          outputBytes: 444,
          sessionTimeS: 300,
        }),
      ]);
      const [sa] = await sessionByUnique(a.identity.acctUniqueId);
      const [sb] = await sessionByUnique(b.identity.acctUniqueId);
      expect(sa).toMatchObject({ organization_id: orgA.id, input_octets: 111 });
      expect(sb).toMatchObject({ organization_id: orgB.id, input_octets: 333 });
      const afterA = await totalUsage(userA.id);
      const afterB = await totalUsage(userB.id);
      expect(Number(afterA?.bytes_in) - Number(beforeA?.bytes_in ?? 0)).toBe(111);
      expect(Number(afterB?.bytes_in) - Number(beforeB?.bytes_in ?? 0)).toBe(333);
      expect(afterB?.organization_id).toBe(orgB.id);
    });

    // Formerly a pinned DEFECT (`it.fails`): drain.ts `createSession` re-read the row by
    // acct_unique_id alone and returned org A's session for org B's NAS. Fixed in L3: session
    // lookups are bound to the authenticated organization AND NAS; a collision is recorded for
    // the reporting organization without a session and audited
    // (`accounting:acct_unique_id_collision`).
    it("SIM-18 [coovachilli-uam] [openwifi-uspot-uam] colliding Acct-Unique-Session-Id from another tenant's NAS is never merged into the first tenant's session", async () => {
      // acctuniqueid = md5(Class, Acct-Session-Id) (infra/freeradius README contract §3 rule 5) or
      // the stock hash of NAS-supplied attributes: both are chosen by the NAS. An org-B NAS that
      // echoes org A's Class and Acct-Session-Id produces the same acctuniqueid.
      const t0 = new Date(Date.UTC(2022, 0, 3, 0, 0, 0));
      const at = (min: number): Date => new Date(t0.getTime() + min * 60_000);
      const sessionUuid = newId();
      const cls = simClassFor(sessionUuid);
      const unique = `sim-${RUN}-collide`;
      const acctId = randomBytes(8).toString('hex');
      const a = acctSession(nasOf(A, 'coovachilli-uam'), 64, {
        unique,
        acctSessionId: acctId,
        class: cls,
      });
      const b = acctSession(nasOf(B, 'coovachilli-uam'), 64, {
        unique,
        acctSessionId: acctId,
        class: cls,
      });
      await play([
        a.row({ status: 'Start', at: at(0) }),
        a.row({
          status: 'Interim-Update',
          at: at(5),
          inputBytes: 1_000,
          outputBytes: 2_000,
          sessionTimeS: 300,
        }),
      ]);
      const beforeA = await totalUsage(userA.id);
      const [sa0] = await sessionByUnique(unique);
      await play([
        b.row({
          status: 'Interim-Update',
          at: at(6),
          inputBytes: 9_000_000,
          outputBytes: 9_000_000,
          sessionTimeS: 360,
        }),
        b.row({
          status: 'Stop',
          at: at(7),
          inputBytes: 9_000_001,
          outputBytes: 9_000_001,
          sessionTimeS: 420,
          terminateCause: 'Admin-Reset',
        }),
      ]);
      const [sa1] = await sessionByUnique(unique);
      // org A's session must be unchanged by org B's packets.
      expect(sa1).toMatchObject({
        id: sa0?.id,
        organization_id: orgA.id,
        nas_client_id: nasOf(A, 'coovachilli-uam').id,
        status: sa0?.status,
        input_octets: 1_000,
        output_octets: 2_000,
      });
      const afterA = await totalUsage(userA.id);
      expect(Number(afterA?.bytes_in)).toBe(Number(beforeA?.bytes_in));
      // B's records are never attributed to A.
      const bRecords = await db
        .selectFrom('accounting_records')
        .select(['organization_id', 'session_id'])
        .where('acct_unique_id', '=', unique)
        .where('input_octets', '>=', 9_000_000)
        .execute();
      expect(bRecords).toHaveLength(2);
      for (const r of bRecords) expect(r.organization_id).not.toBe(orgA.id);
    });
  });
});
