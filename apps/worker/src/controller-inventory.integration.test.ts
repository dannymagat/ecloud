/**
 * Cycle D `controllers.inventory` against the test database and a LOCAL mock UniFi controller
 * (no real vendor is contacted): AP MACs the controller reports are verified only for AP rows of
 * the same organization whose NAS is managed by that controller; failures are recorded as codes;
 * expired API-authorised sessions are closed; the job is off unless enabled.
 */
import { randomBytes } from 'node:crypto';
import { createDb, createPool, type Db } from '@ecloud/db';
import { createLogger, newId } from '@ecloud/shared';
import {
  allowLoopback,
  describeIntegration,
  json,
  loopbackResolver,
  makeOrganization,
  makeSite,
  migrateTestDatabase,
  startMockController,
  testPki,
  type MockController,
} from '@ecloud/testing';
import { VendorHttpClient, deriveVendorApiKey, sealSecret } from '@ecloud/vendor-api';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { runControllerInventory } from './jobs/controller-inventory.js';

const logger = createLogger({ name: 'worker-inventory-it', level: 'silent' });
const RUN = randomBytes(4).toString('hex');
const DEK = 'ecloud_test_worker_data_key_0123456789';
const FAKE_KEY = 'test-unifi-key-not-real';
const mac = () =>
  ['02', ...Array.from({ length: 5 }, () => randomBytes(1).toString('hex'))].join(':');
const ip = () =>
  `10.${String(1 + ((randomBytes(1)[0] ?? 0) % 250))}.${String(1 + ((randomBytes(1)[0] ?? 0) % 250))}.${String(1 + ((randomBytes(1)[0] ?? 0) % 250))}`;

await describeIntegration('@ecloud/worker controllers.inventory (Cycle D)', () => {
  let db: Db;
  let mock: MockController;
  let http: VendorHttpClient;
  const orgA = makeOrganization({ slug: `inv-a-${RUN}` });
  const orgB = makeOrganization({ slug: `inv-b-${RUN}` });
  const siteA = makeSite(orgA.id, { timezone: 'UTC' });
  const siteB = makeSite(orgB.id, { timezone: 'UTC' });
  const ctrlA = newId();
  const ctrlB = newId();
  const nasManaged = newId();
  const nasUnmanaged = newId();
  const nasB = newId();
  const ap = {
    inInventory: mac(),
    notInInventory: mac(),
    unmanagedNas: mac(),
    otherTenant: mac(),
    sniffed: mac(),
    unpinned: mac(),
  };
  // Review F1 attack: org C registered a sniffed MAC (someone else's AP) and points a "UniFi"
  // credential (pinned with its own CA) at a server it controls that lists that MAC.
  const orgC = makeOrganization({ slug: `inv-c-${RUN}` });
  const siteC = makeSite(orgC.id, { timezone: 'UTC' });
  const ctrlC = newId();
  const nasC = newId();
  // org E: on-prem controller WITHOUT a TLS pin → never inventoried.
  const orgE = makeOrganization({ slug: `inv-e-${RUN}` });
  const siteE = makeSite(orgE.id, { timezone: 'UTC' });
  const ctrlE = newId();
  const nasE = newId();
  const DERIVED = deriveVendorApiKey(DEK);
  let reported: string[] = [];

  async function addNas(id: string, org: string, site: string, controller: string | null) {
    await db
      .insertInto('nas_clients')
      .values({
        id,
        organization_id: org,
        site_id: site,
        name: `NAS ${RUN}`,
        nas_ip: ip(),
        adapter_type_key: 'unifi-external-portal',
        adapter_key: 'unifi-external-portal',
        controller_id: controller,
        secret_ref: 'enc:placeholder',
      })
      .execute();
  }

  async function verification(m: string) {
    return db
      .selectFrom('nas_access_points')
      .select([
        'verified_at',
        'verification_source',
        'inventory_seen_at',
        'inventory_controller_id',
      ])
      .where('mac', '=', m)
      .executeTakeFirstOrThrow();
  }

  beforeAll(async () => {
    const { databaseUrl } = await migrateTestDatabase();
    db = createDb(createPool(databaseUrl, { max: 4, applicationName: 'ecloud-worker-inv-it' }));
    mock = await startMockController();
    http = new VendorHttpClient({
      resolve: loopbackResolver,
      addressAllowed: allowLoopback,
      allowedPorts: [mock.port],
    });
    mock.handler = (req, res) =>
      req.headers['x-api-key'] === FAKE_KEY
        ? json(res, 200, {
            data: reported.map((m) => ({ macAddress: m.toUpperCase() })),
            totalCount: reported.length,
          })
        : json(res, 401, {});
    await db.insertInto('organizations').values([orgA, orgB, orgC, orgE]).execute();
    await db.insertInto('sites').values([siteA, siteB, siteC, siteE]).execute();
    for (const [id, org, kind] of [
      [ctrlA, orgA.id, 'ubiquiti-unifi'],
      [ctrlB, orgB.id, 'ubiquiti-unifi'],
      [ctrlC, orgC.id, 'ubiquiti-unifi'],
      [ctrlE, orgE.id, 'ubiquiti-unifi'],
    ] as const) {
      await db
        .insertInto('controllers')
        .values({
          id,
          organization_id: org,
          vendor_key: kind,
          name: `c ${RUN}`,
          kind: 'on_premises',
          base_url: `https://controller.test:${String(mock.port)}/`,
        })
        .execute();
    }
    await addNas(nasManaged, orgA.id, siteA.id, ctrlA);
    await addNas(nasUnmanaged, orgA.id, siteA.id, null);
    await addNas(nasB, orgB.id, siteB.id, ctrlB);
    await addNas(nasC, orgC.id, siteC.id, ctrlC);
    await addNas(nasE, orgE.id, siteE.id, ctrlE);
    await db
      .insertInto('nas_access_points')
      .values([
        {
          organization_id: orgA.id,
          site_id: siteA.id,
          nas_client_id: nasManaged,
          mac: ap.inInventory,
        },
        {
          organization_id: orgA.id,
          site_id: siteA.id,
          nas_client_id: nasManaged,
          mac: ap.notInInventory,
        },
        {
          organization_id: orgA.id,
          site_id: siteA.id,
          nas_client_id: nasUnmanaged,
          mac: ap.unmanagedNas,
        },
        { organization_id: orgB.id, site_id: siteB.id, nas_client_id: nasB, mac: ap.otherTenant },
        { organization_id: orgC.id, site_id: siteC.id, nas_client_id: nasC, mac: ap.sniffed },
        { organization_id: orgE.id, site_id: siteE.id, nas_client_id: nasE, mac: ap.unpinned },
      ])
      .execute();
    await db
      .insertInto('vendor_api_credentials')
      .values({
        organization_id: orgA.id,
        controller_id: ctrlA,
        api_kind: 'unifi-network',
        base_url: `https://controller.test:${String(mock.port)}/proxy/network/integration`,
        secret_ref: sealSecret(DEK, FAKE_KEY),
        external_site_id: 'site-a',
        tls_ca_pem: testPki().caPem,
      })
      .execute();
    // org B's controller has a credential whose key the mock refuses
    await db
      .insertInto('vendor_api_credentials')
      .values({
        organization_id: orgB.id,
        controller_id: ctrlB,
        api_kind: 'unifi-network',
        base_url: `https://controller.test:${String(mock.port)}/`,
        secret_ref: sealSecret(DEK, 'test-wrong-key'),
        external_site_id: 'site-b',
        tls_ca_pem: testPki().caPem,
      })
      .execute();
    for (const [org, ctrl, pinned] of [
      [orgC.id, ctrlC, true],
      [orgE.id, ctrlE, false],
    ] as const) {
      await db
        .insertInto('vendor_api_credentials')
        .values({
          organization_id: org,
          controller_id: ctrl,
          api_kind: 'unifi-network',
          base_url: `https://controller.test:${String(mock.port)}/`,
          secret_ref: sealSecret(DEK, FAKE_KEY),
          external_site_id: 'site-x',
          tls_ca_pem: pinned ? testPki().caPem : null,
        })
        .execute();
    }
  }, 60_000);

  afterAll(async () => {
    await mock.close();
    await db.destroy();
  });

  const run = (over: Partial<Parameters<typeof runControllerInventory>[0]> = {}) =>
    runControllerInventory({ db, logger, enabled: true, vendorApiKey: DERIVED, http, ...over });

  it('is off unless enabled with the DERIVED key; refuses the master key (no outbound call)', async () => {
    const n = mock.requests.length;
    expect((await run({ enabled: false })).skipped).toBe('disabled');
    expect((await run({ vendorApiKey: null })).skipped).toBe('no_vendor_api_key');
    expect((await run({ vendorApiKey: DEK })).skipped).toBe('invalid_vendor_api_key');
    expect((await run({ masterKeyPresent: true })).skipped).toBe('master_key_present');
    expect(mock.requests.length).toBe(n);
  });

  it('marks candidates only (never verifies), same tenant, managed NAS, pinned on-prem only', async () => {
    reported = [ap.inInventory, ap.unmanagedNas, ap.otherTenant, ap.sniffed, ap.unpinned, mac()];
    const report = await run();
    expect(report.skipped).toBeNull();
    expect(report.candidates).toBeGreaterThanOrEqual(2); // A's AP + C's sniffed MAC
    expect(report.failures.auth_failed).toBeGreaterThanOrEqual(1); // org B's refused key

    const own = await verification(ap.inInventory);
    expect(own).toMatchObject({
      verified_at: null,
      verification_source: null,
      inventory_controller_id: ctrlA,
    });
    expect(own.inventory_seen_at).not.toBeNull();
    for (const m of [ap.notInInventory, ap.unmanagedNas, ap.otherTenant, ap.unpinned]) {
      expect(await verification(m)).toEqual({
        verified_at: null,
        verification_source: null,
        inventory_seen_at: null,
        inventory_controller_id: null,
      });
    }
    const credA = await db
      .selectFrom('vendor_api_credentials')
      .select(['inventory_result', 'inventory_matched'])
      .where('controller_id', '=', ctrlA)
      .executeTakeFirstOrThrow();
    expect(credA).toEqual({ inventory_result: 'ok', inventory_matched: 1 });
    const credE = await db
      .selectFrom('vendor_api_credentials')
      .select(['inventory_checked_at'])
      .where('controller_id', '=', ctrlE)
      .executeTakeFirstOrThrow();
    expect(credE.inventory_checked_at).toBeNull(); // unpinned controller is never contacted
  });

  it('F1 attack: a tenant-controlled "controller" listing a sniffed MAC does NOT verify it', async () => {
    reported = [ap.sniffed];
    await run();
    const row = await verification(ap.sniffed);
    expect(row.verified_at).toBeNull();
    expect(row.verification_source).toBeNull();
    expect(row.inventory_controller_id).toBe(ctrlC); // candidate only, awaiting platform review
  });

  it('a wrong derived key is recorded as a code, never thrown', async () => {
    const report = await run({ vendorApiKey: deriveVendorApiKey(`${DEK}-other`) });
    expect(report.failures.secret_unavailable).toBeGreaterThanOrEqual(2);
  });

  it('expires API-authorised sessions past their granted duration', async () => {
    const id = newId();
    await db
      .insertInto('vendor_api_sessions')
      .values({
        id,
        organization_id: orgA.id,
        site_id: siteA.id,
        nas_client_id: nasManaged,
        controller_id: ctrlA,
        adapter_key: 'unifi-external-portal',
        api_kind: 'unifi-network',
        client_mac: mac(),
        identity_kind: 'click_through',
        status: 'authorized',
        authorized_at: new Date(Date.now() - 7200_000),
        expires_at: new Date(Date.now() - 3600_000),
        granted_duration_s: 3600,
      })
      .execute();
    const report = await run({ enabled: false });
    expect(report.expiredApiSessions).toBeGreaterThanOrEqual(1);
    const row = await db
      .selectFrom('vendor_api_sessions')
      .select(['status'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe('expired');
  });
});
