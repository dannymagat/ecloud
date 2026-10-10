/**
 * Schema integration suite. Needs the dev stack (`npm run dev:stack`) and
 * `ECLOUD_TEST_DATABASE_URL` (platform role on ecloud_test); connects as `ecloud_app` through
 * `getTestAppDatabaseUrl()` for the RLS assertions. This is the ONLY suite allowed to pass
 * `reset: true` to migrateTestDatabase().
 */
import { COMPATIBILITY_ROWS, VENDORS, registrySnapshotHash } from '@ecloud/adapters';
import { PERMISSION_CATALOGUE, ROLE_TEMPLATES, newId } from '@ecloud/shared';
import {
  DATA_TABLES,
  describeIntegration,
  getTestAppDatabaseUrl,
  makeClientDevice,
  makeNasClient,
  makeOrganization,
  makeSite,
  makeUser,
  migrateTestDatabase,
  truncateAll,
} from '@ecloud/testing';
import { sql } from 'kysely';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  ALL_TABLES,
  PARTITIONED_TABLES,
  PLATFORM_TABLES,
  RADIUS_TABLES,
  TENANT_SCOPED_TABLES,
  TenancyError,
  createDb,
  createPlatformAdmin,
  createPool,
  discoverMigrations,
  ensureMonthPartitions,
  migrationStatus,
  pgExecutor,
  seedRegistry,
  verifyPassword,
  verifyRegistryMirror,
  withPlatform,
  withSite,
  withTenant,
  type Db,
} from './index.js';

const PARTITION_RE = /_(default|y\d{4}m\d{2})$/;

function monthPartition(table: string, date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${table}_y${String(y)}m${m}`;
}

async function sqlState(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

await describeIntegration('@ecloud/db schema', () => {
  let platformPool: pg.Pool;
  let appPool: pg.Pool;
  let platform: Db;
  let app: Db;
  let databaseUrl: string;
  /** deployment_mode of NAS rows inserted at schema 018, read after 019 ran (upgrade path). */
  let backfilled: Record<string, string> = {};

  beforeAll(async () => {
    const legacyOrg = newId();
    const result = await migrateTestDatabase({
      reset: true,
      // 019 upgrade path: rows that exist before the migration are backfilled
      atVersion: {
        version: '018',
        run: async (client) => {
          const site = newId();
          await client.query('INSERT INTO organizations (id, slug, name) VALUES ($1, $2, $3)', [
            legacyOrg,
            `legacy-${legacyOrg.slice(-8)}`,
            'Legacy 018',
          ]);
          await client.query(
            "INSERT INTO sites (id, organization_id, slug, name, timezone) VALUES ($1, $2, 's', 'S', 'UTC')",
            [site, legacyOrg],
          );
          for (const [name, ip, key] of [
            ['chilli', '10.250.0.1', 'coovachilli-uam'],
            ['uspot', '10.250.0.2', 'openwifi-uspot-uam'],
          ] as const) {
            await client.query(
              `INSERT INTO nas_clients (organization_id, site_id, name, nas_ip, adapter_type_key, adapter_key, secret_ref)
               VALUES ($1, $2, $3, $4, $5, $5, 'enc:placeholder')`,
              [legacyOrg, site, name, ip, key],
            );
          }
        },
      },
    });

    databaseUrl = result.databaseUrl;
    expect(result.applied).toBe(discoverMigrations().length);
    const appUrl = getTestAppDatabaseUrl();
    if (appUrl === undefined) throw new Error('no ecloud_app URL for the test database');
    platformPool = createPool(databaseUrl, { max: 4, applicationName: 'ecloud-db-test-platform' });
    appPool = createPool(appUrl, { max: 4, applicationName: 'ecloud-db-test-app' });
    platform = createDb(platformPool);
    app = createDb(appPool);
    const legacy = await sql<{ name: string; deployment_mode: string }>`
      SELECT name, deployment_mode FROM nas_clients WHERE organization_id = ${legacyOrg}
    `.execute(platform);
    backfilled = Object.fromEntries(legacy.rows.map((r) => [r.name, r.deployment_mode]));
    await truncateAll(platformPool, DATA_TABLES);
  }, 120_000);

  afterAll(async () => {
    await platform.destroy();
    await app.destroy();
  });

  it('reports a clean status after a fresh run', async () => {
    const client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      const status = await migrationStatus(pgExecutor(client), discoverMigrations());
      expect(status.clean).toBe(true);
      expect(status.orphans).toEqual([]);
      expect(status.migrations.map((m) => m.state)).toEqual(status.migrations.map(() => 'applied'));
      expect(status.migrations.length).toBeGreaterThanOrEqual(11);
    } finally {
      await client.end();
    }
  });

  it('creates exactly the catalogued tables', async () => {
    const tables = await sql<{ schemaname: string; tablename: string }>`
      SELECT schemaname, tablename FROM pg_tables
       WHERE schemaname IN ('public', 'radius') AND tablename <> 'schema_migrations'
    `.execute(platform);
    const publicTables = tables.rows
      .filter((r) => r.schemaname === 'public' && !PARTITION_RE.test(r.tablename))
      .map((r) => r.tablename)
      .sort();
    const radiusTables = tables.rows
      .filter((r) => r.schemaname === 'radius')
      .map((r) => `radius.${r.tablename}`)
      .sort();
    expect(publicTables).toEqual([...ALL_TABLES].sort());
    expect(radiusTables).toEqual([...RADIUS_TABLES].sort());
    expect(publicTables).toHaveLength(49); // + portal_assets, portal_terms_versions (021); + session_enforcement, accounting_anomalies (023); + usage_hourly (026); + nas_access_points, vendor_api_credentials (028)

    const view = await sql<{ count: number }>`
      SELECT count(*)::int AS count FROM pg_views WHERE schemaname = 'radius' AND viewname = 'nas_v'
    `.execute(platform);
    expect(view.rows[0]?.count).toBe(1);
  });

  it('enables and FORCEs RLS on every tenant-scoped table, its partitions, and nothing else', async () => {
    const rows = await sql<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
      policies: number;
    }>`
      SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
             (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid AND p.polname = 'tenant_isolation') AS policies
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
    `.execute(platform);
    const byName = new Map(rows.rows.map((r) => [r.relname, r]));
    for (const table of TENANT_SCOPED_TABLES) {
      expect(byName.get(table), table).toMatchObject({
        relrowsecurity: true,
        relforcerowsecurity: true,
        policies: 1,
      });
    }
    for (const table of PLATFORM_TABLES) {
      expect(byName.get(table), table).toMatchObject({ relrowsecurity: false, policies: 0 });
    }
    expect(byName.get('schema_migrations')?.relrowsecurity).toBe(false);
    const partitions = rows.rows.filter((r) => PARTITION_RE.test(r.relname));
    expect(partitions.length).toBeGreaterThanOrEqual(PARTITIONED_TABLES.length * 4);
    for (const p of partitions) {
      expect(p, p.relname).toMatchObject({
        relrowsecurity: true,
        relforcerowsecurity: true,
        policies: 1,
      });
    }
  });

  it('seeds the shared permission catalogue and the six role templates exactly', async () => {
    const permissions = await platform.selectFrom('permissions').selectAll().execute();
    expect(permissions).toHaveLength(109); // + administrator:mfa_reset (D-038); + controller:* (5), compatibility:read (019); + portal_asset:* (3, 021), captive_portal:secret:rotate (P6-B)
    expect(permissions.map((p) => p.key).sort()).toEqual(
      PERMISSION_CATALOGUE.map((p) => p.key).sort(),
    );
    for (const def of PERMISSION_CATALOGUE) {
      const row = permissions.find((p) => p.key === def.key);
      expect(row, def.key).toMatchObject({
        resource: def.resource,
        action: def.action,
        description: def.description,
        min_scope: def.minScope,
        is_platform_only: def.platformOnly,
      });
    }

    const templates = await platform
      .selectFrom('roles')
      .selectAll()
      .where('is_template', '=', true)
      .where('organization_id', 'is', null)
      .execute();
    expect(templates).toHaveLength(6);
    expect(templates.map((t) => t.key).sort()).toEqual(ROLE_TEMPLATES.map((t) => t.key).sort());
    for (const template of ROLE_TEMPLATES) {
      const role = templates.find((t) => t.key === template.key);
      expect(role?.name).toBe(template.name);
      const granted = await platform
        .selectFrom('role_permissions')
        .select('permission_key')
        .where('role_id', '=', role?.id ?? '')
        .execute();
      expect(granted.map((g) => g.permission_key).sort(), template.key).toEqual(
        [...template.permissions].sort(),
      );
    }
    const superAdmin = templates.find((t) => t.key === 'platform_super_admin');
    const count = await platform
      .selectFrom('role_permissions')
      .select(({ fn }) => fn.countAll<number>().as('n'))
      .where('role_id', '=', superAdmin?.id ?? '')
      .executeTakeFirst();
    expect(Number(count?.n)).toBe(109);
  });

  it('hides cross-tenant rows from ecloud_app and shows everything to the platform role', async () => {
    const orgA = makeOrganization();
    const orgB = makeOrganization();
    await platform.insertInto('organizations').values([orgA, orgB]).execute();
    const siteA = makeSite(orgA.id);
    const siteB = makeSite(orgB.id);
    await platform.insertInto('sites').values([siteA, siteB]).execute();
    const userA1 = makeUser(orgA.id, { username: 'shared-name' });
    const userA2 = makeUser(orgA.id);
    const userB1 = makeUser(orgB.id, { username: 'shared-name' });
    await platform.insertInto('users').values([userA1, userA2, userB1]).execute();

    // T-09: tenant A sees only its rows
    const seenByA = await withTenant(app, orgA.id, (trx) =>
      trx.selectFrom('users').select('id').orderBy('id').execute(),
    );
    expect(seenByA.map((u) => u.id).sort()).toEqual([userA1.id, userA2.id].sort());
    const sitesSeenByB = await withTenant(app, orgB.id, (trx) =>
      trx.selectFrom('sites').select('id').execute(),
    );
    expect(sitesSeenByB.map((s) => s.id)).toEqual([siteB.id]);

    // T-10: no SET LOCAL -> fail closed (0 rows), on every tenant table
    const unscopedUsers = await app.selectFrom('users').select('id').execute();
    expect(unscopedUsers).toEqual([]);
    const unscopedSites = await app.selectFrom('sites').select('id').execute();
    expect(unscopedSites).toEqual([]);

    // writes for another tenant are rejected by the policy's WITH CHECK
    const code = await sqlState(
      withTenant(app, orgA.id, (trx) =>
        trx.insertInto('users').values(makeUser(orgB.id)).execute(),
      ),
    );
    expect(code).toBe('42501');
    // ... and a tenant cannot "steal" a row by updating its organization_id
    const moved = await withTenant(app, orgA.id, (trx) =>
      trx
        .updateTable('users')
        .set({ organization_id: orgB.id })
        .where('id', '=', userA1.id)
        .executeTakeFirst(),
    ).catch((error: unknown) => error);
    expect((moved as { code?: string }).code).toBe('42501');

    // templates are readable inside a tenant transaction; tenant cannot modify them
    const templatesSeen = await withTenant(app, orgA.id, (trx) =>
      trx.selectFrom('roles').select('key').where('is_template', '=', true).execute(),
    );
    expect(templatesSeen).toHaveLength(6);
    // ... and may not modify them: the row is visible (USING) but fails WITH CHECK
    const templateEdit = await sqlState(
      withTenant(app, orgA.id, (trx) =>
        trx.updateTable('roles').set({ name: 'hijacked' }).where('key', '=', 'read_only').execute(),
      ),
    );
    expect(templateEdit).toBe('42501');
    const untouched = await platform
      .selectFrom('roles')
      .select('name')
      .where('key', '=', 'read_only')
      .where('organization_id', 'is', null)
      .executeTakeFirstOrThrow();
    expect(untouched.name).toBe('Read Only');

    // platform role (BYPASSRLS) sees both tenants, plain queries
    const all = await platform.selectFrom('users').select('organization_id').execute();
    expect(new Set(all.map((u) => u.organization_id))).toEqual(new Set([orgA.id, orgB.id]));

    // withSite publishes the site GUC inside the tenant transaction
    const guc = await withSite(app, orgA.id, siteA.id, async (trx) => {
      const r = await sql<{ org: string; site: string }>`
        SELECT current_setting('app.current_org', true) AS org, current_setting('app.current_site', true) AS site
      `.execute(trx);
      return r.rows[0];
    });
    expect(guc).toEqual({ org: orgA.id, site: siteA.id });

    await expect(withTenant(app, 'not-a-uuid', () => Promise.resolve())).rejects.toBeInstanceOf(
      TenancyError,
    );
  });

  it('withPlatform refuses the RLS connection and writes an audit row on the platform one', async () => {
    await expect(
      withPlatform(app, { reason: 'test' }, () => Promise.resolve(1)),
    ).rejects.toBeInstanceOf(TenancyError);
    const before = await platform
      .selectFrom('audit_logs')
      .select(({ fn }) => fn.countAll<number>().as('n'))
      .executeTakeFirst();
    const total = await withPlatform(
      platform,
      { reason: 'integration test cross-tenant count', requestId: 'req-1' },
      async (trx) => {
        const r = await trx
          .selectFrom('organizations')
          .select(({ fn }) => fn.countAll<number>().as('n'))
          .executeTakeFirst();
        return Number(r?.n);
      },
    );
    expect(total).toBeGreaterThanOrEqual(2);
    const rows = await platform
      .selectFrom('audit_logs')
      .selectAll()
      .where('action', '=', 'platform:access')
      .orderBy('id', 'desc')
      .limit(1)
      .execute();
    expect(rows[0]).toMatchObject({
      actor_type: 'system',
      request_id: 'req-1',
      organization_id: null,
    });
    expect(rows[0]?.after).toEqual({ reason: 'integration test cross-tenant count' });
    const after = await platform
      .selectFrom('audit_logs')
      .select(({ fn }) => fn.countAll<number>().as('n'))
      .executeTakeFirst();
    expect(Number(after?.n)).toBe(Number(before?.n) + 1);
    await withPlatform(platform, { reason: 'quiet', audit: false }, () => Promise.resolve());
    const again = await platform
      .selectFrom('audit_logs')
      .select(({ fn }) => fn.countAll<number>().as('n'))
      .executeTakeFirst();
    expect(Number(again?.n)).toBe(Number(after?.n));
  });

  it('routes partitioned inserts to the month partition and keeps them append-only', async () => {
    const org = makeOrganization();
    await platform.insertInto('organizations').values(org).execute();
    const now = new Date();
    const recent = await platform
      .insertInto('accounting_records')
      .values({
        organization_id: org.id,
        acct_unique_id: `acct-${newId()}`,
        acct_session_id: 'S1',
        status_type: 'start',
        nas_ip: '192.0.2.10',
        received_at: now,
        raw: { 'Acct-Status-Type': 'Start' },
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const late = await platform
      .insertInto('accounting_records')
      .values({
        organization_id: org.id,
        acct_unique_id: `acct-${newId()}`,
        acct_session_id: 'S2',
        status_type: 'stop',
        nas_ip: '192.0.2.10',
        received_at: new Date('2000-01-01T00:00:00Z'),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const placed = await sql<{ id: number; part: string }>`
      SELECT id, tableoid::regclass::text AS part FROM accounting_records WHERE id IN (${recent.id}, ${late.id}) ORDER BY id
    `.execute(platform);
    expect(placed.rows.map((r) => r.part)).toEqual([
      monthPartition('accounting_records', now),
      'accounting_records_default',
    ]);

    const audit = await platform
      .insertInto('audit_logs')
      .values({
        organization_id: org.id,
        actor_type: 'system',
        action: 'organization:update',
        after: { x: 1 },
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const auditPart = await sql<{ part: string }>`
      SELECT tableoid::regclass::text AS part FROM audit_logs WHERE id = ${audit.id}
    `.execute(platform);
    expect(auditPart.rows[0]?.part).toBe(monthPartition('audit_logs', now));

    // append-only: even the owner cannot update or delete
    expect(
      await sqlState(
        platform
          .updateTable('accounting_records')
          .set({ username: 'x' })
          .where('id', '=', recent.id)
          .execute(),
      ),
    ).toBe('42501');
    expect(
      await sqlState(platform.deleteFrom('audit_logs').where('id', '=', audit.id).execute()),
    ).toBe('42501');

    // tenant visibility applies to partitioned tables as well
    const seen = await withTenant(app, org.id, (trx) =>
      trx.selectFrom('accounting_records').select('id').execute(),
    );
    expect(seen.map((r) => r.id).sort()).toEqual([recent.id, late.id].sort());
    const others = await withTenant(app, makeOrganization().id, (trx) =>
      trx.selectFrom('accounting_records').select('id').execute(),
    );
    expect(others).toEqual([]);
    // rows with organization_id NULL (unresolved tenant) are visible to platform ops only
    await platform
      .insertInto('accounting_records')
      .values({
        acct_unique_id: `acct-${newId()}`,
        acct_session_id: 'S3',
        status_type: 'accounting_on',
        nas_ip: '192.0.2.99',
      })
      .execute();
    const nullRows = await withTenant(app, org.id, (trx) =>
      trx
        .selectFrom('accounting_records')
        .select('id')
        .where('organization_id', 'is', null)
        .execute(),
    );
    expect(nullRows).toEqual([]);
  });

  it('ensure_month_partitions is idempotent and protects new partitions', async () => {
    const client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      const exec = pgExecutor(client);
      const first = await ensureMonthPartitions(exec, 6);
      const created = first.flatMap((r) => r.created);
      expect(created.length).toBeGreaterThan(0);
      expect(first.map((r) => r.table)).toEqual([...PARTITIONED_TABLES]);
      const second = await ensureMonthPartitions(exec, 6);
      expect(second.flatMap((r) => r.created)).toEqual([]);
      const rls = await exec.query<{ relname: string; ok: boolean }>(
        `SELECT c.relname, (c.relrowsecurity AND c.relforcerowsecurity AND EXISTS (
            SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid AND p.polname = 'tenant_isolation')) AS ok
           FROM pg_class c WHERE c.oid = ANY($1::regclass[])`,
        [created],
      );
      expect(rls.rows).toHaveLength(created.length);
      expect(rls.rows.every((r) => r.ok)).toBe(true);
      await expect(
        exec.query("SELECT ensure_month_partitions('users'::regclass, 1)"),
      ).rejects.toThrow(/not a partitioned table/);
    } finally {
      await client.end();
    }
  });

  it('enforces per-organization username and MAC uniqueness (soft-delete aware)', async () => {
    const orgA = makeOrganization();
    const orgB = makeOrganization();
    await platform.insertInto('organizations').values([orgA, orgB]).execute();
    await platform
      .insertInto('users')
      .values(makeUser(orgA.id, { username: 'Alice' }))
      .execute();
    expect(
      await sqlState(
        platform
          .insertInto('users')
          .values(makeUser(orgA.id, { username: 'alice' }))
          .execute(),
      ),
    ).toBe('23505');
    await platform
      .insertInto('users')
      .values(makeUser(orgB.id, { username: 'alice' }))
      .execute();

    const device = makeClientDevice(orgA.id, { mac: '02:00:00:00:aa:bb' });
    await platform.insertInto('client_devices').values(device).execute();
    // PostgreSQL macaddr normalises case and separators, so this is the same address
    expect(
      await sqlState(
        platform
          .insertInto('client_devices')
          .values(makeClientDevice(orgA.id, { mac: '02-00-00-00-AA-BB' }))
          .execute(),
      ),
    ).toBe('23505');
    await platform
      .insertInto('client_devices')
      .values(makeClientDevice(orgB.id, { mac: '02:00:00:00:aa:bb' }))
      .execute();
    // a soft-deleted row frees the MAC for re-registration in the same tenant
    await platform
      .updateTable('client_devices')
      .set({ deleted_at: new Date() })
      .where('id', '=', device.id)
      .execute();
    await platform
      .insertInto('client_devices')
      .values(makeClientDevice(orgA.id, { mac: '02:00:00:00:aa:bb' }))
      .execute();

    // nas_ip is global, per DATABASE_DESIGN.md §3.2 (Q3 default)
    const siteA = makeSite(orgA.id);
    const siteB = makeSite(orgB.id);
    await platform.insertInto('sites').values([siteA, siteB]).execute();
    await platform
      .insertInto('nas_clients')
      .values(makeNasClient(orgA.id, siteA.id, { nas_ip: '192.0.2.200' }))
      .execute();
    expect(
      await sqlState(
        platform
          .insertInto('nas_clients')
          .values(makeNasClient(orgB.id, siteB.id, { nas_ip: '192.0.2.200' }))
          .execute(),
      ),
    ).toBe('23505');
    // adapter_type_key must be a seeded adapter
    expect(
      await sqlState(
        platform
          .insertInto('nas_clients')
          .values(
            makeNasClient(orgA.id, siteA.id, { adapter_type_key: 'made_up', adapter_key: null }),
          )
          .execute(),
      ),
    ).toBe('23503');
    // D-035 (migration 015): adapter_key is one of the four NAS-facing engine keys …
    expect(
      await sqlState(
        platform
          .insertInto('nas_clients')
          .values(
            makeNasClient(orgA.id, siteA.id, {
              adapter_type_key: 'openwifi-config',
              adapter_key: 'openwifi-config',
            }),
          )
          .execute(),
      ),
    ).toBe('23514');
    // … and agrees with the catalogue reference
    expect(
      await sqlState(
        platform
          .insertInto('nas_clients')
          .values(
            makeNasClient(orgA.id, siteA.id, {
              adapter_type_key: 'openwifi-uspot-uam',
              adapter_key: 'coovachilli-uam',
            }),
          )
          .execute(),
      ),
    ).toBe('23514');
    // the reconciled catalogue holds exactly the engine keys on a fresh database (+ 028 generic, + 029 mikrotik)
    const keys = await platform.selectFrom('adapter_types').select('key').orderBy('key').execute();
    expect(keys.map((k) => k.key)).toEqual([
      'coovachilli-uam',
      'external-portal-postback',
      'generic-radius-8021x',
      'mikrotik-hotspot',
      'openwifi-config',
      'openwifi-hostapd-radius',
      'openwifi-uspot-uam',
      'uspot-upstream-uam',
    ]);
  });

  it('keeps the radius schema away from ecloud_app and insert-only for ecloud_radius', async () => {
    expect(await sqlState(sql`SELECT count(*) FROM radius.radacct_raw`.execute(app))).toBe('42501');
    expect(await sqlState(sql`SELECT count(*) FROM radius.nas_v`.execute(app))).toBe('42501');
    const radiusRole = await sql<{
      n: number;
    }>`SELECT count(*)::int AS n FROM pg_roles WHERE rolname = 'ecloud_radius'`.execute(platform);
    if (radiusRole.rows[0]?.n === 1) {
      const priv = await sql<{
        ins: boolean;
        sel: boolean;
        upd: boolean;
        nas: boolean;
        pub: boolean;
      }>`
        SELECT has_table_privilege('ecloud_radius', 'radius.radacct_raw', 'INSERT') AS ins,
               has_table_privilege('ecloud_radius', 'radius.radacct_raw', 'SELECT') AS sel,
               has_table_privilege('ecloud_radius', 'radius.radacct_raw', 'UPDATE') AS upd,
               has_table_privilege('ecloud_radius', 'radius.nas_v', 'SELECT') AS nas,
               has_table_privilege('ecloud_radius', 'users', 'SELECT') AS pub
      `.execute(platform);
      expect(priv.rows[0]).toEqual({ ins: true, sel: false, upd: false, nas: true, pub: false });
    }
    // the staging table's idempotency key (AAA_ARCHITECTURE.md §5): a retransmit is a no-op
    const packet = {
      acctsessionid: 'S1',
      acctuniqueid: `u-${newId()}`,
      nasipaddress: '192.0.2.10',
      acctstatustype: 'Interim-Update' as const,
      acctsessiontime: 300,
      acctinputoctets: 1000,
      acctoutputoctets: 2000,
    };
    await platform.insertInto('radius.radacct_raw').values(packet).execute();
    const dup = await platform
      .insertInto('radius.radacct_raw')
      .values(packet)
      .onConflict((oc) => oc.doNothing())
      .executeTakeFirst();
    expect(Number(dup.numInsertedOrUpdatedRows)).toBe(0);
    await platform
      .insertInto('radius.radacct_raw')
      .values({ ...packet, acctsessiontime: 600 })
      .execute();
  });

  it('migration 029 is idempotent and rebuilds its CHECKs from the live definition (keeps unknown keys)', async () => {
    const file = new URL('../migrations/029_mikrotik_teltonika.sql', import.meta.url);
    const migration029 = readFileSync(file, 'utf8');
    const client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    const def = async (table: string, con: string) =>
      (
        await client.query<{ d: string }>(
          'SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname = $1 AND conrelid = $2::regclass',
          [con, table],
        )
      ).rows[0]?.d ?? '';
    try {
      await client.query('BEGIN');
      // A key another branch's migration (e.g. 030) added, with uppercase and underscore.
      await client.query(`ALTER TABLE nas_clients DROP CONSTRAINT ck_nas_clients_adapter_key`);
      await client.query(
        `ALTER TABLE nas_clients ADD CONSTRAINT ck_nas_clients_adapter_key CHECK (adapter_key IS NULL OR adapter_key IN ('coovachilli-uam', 'Future_Key-030'))`,
      );
      await client.query(
        `ALTER TABLE captive_portals DROP CONSTRAINT ck_captive_portals_portal_type`,
      );
      await client.query(
        `ALTER TABLE captive_portals ADD CONSTRAINT ck_captive_portals_portal_type CHECK (portal_type IN ('uspot', 'external', 'post_back'))`,
      );
      await client.query(migration029);
      await client.query(migration029); // idempotent
      const adapterDef = await def('nas_clients', 'ck_nas_clients_adapter_key');
      for (const key of ['coovachilli-uam', 'Future_Key-030', 'mikrotik-hotspot'])
        expect(adapterDef).toContain(`'${key}'`);
      expect(adapterDef.match(/'mikrotik-hotspot'/g)).toHaveLength(1);
      const portalDef = await def('captive_portals', 'ck_captive_portals_portal_type');
      for (const key of ['uspot', 'external', 'post_back', 'mikrotik'])
        expect(portalDef).toContain(`'${key}'`);
      expect(portalDef.match(/'mikrotik'/g)).toHaveLength(1);
      const cols = await client.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_name = 'nas_clients'
            AND column_name IN ('device_test_attributes', 'hotspot_address', 'hotspot_port')`,
      );
      expect(cols.rows).toHaveLength(3);
    } finally {
      await client.query('ROLLBACK');
      await client.end();
    }
  });

  it('bootstraps a platform admin bound to the platform_super_admin template', async () => {
    const client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      const exec = pgExecutor(client);
      const result = await createPlatformAdmin(exec, {
        email: ' Root@Example.TEST ',
        password: 'correct horse battery staple',
        displayName: 'Root',
      });
      expect(result.email).toBe('root@example.test');
      const admin = await platform
        .selectFrom('administrators')
        .selectAll()
        .where('id', '=', result.administratorId)
        .executeTakeFirstOrThrow();
      expect(admin.status).toBe('active');
      expect(admin.password_hash).toMatch(/^\$argon2id\$v=19\$/);
      // PHC parameter order is implementation-defined; assert each value
      expect(admin.password_hash).toMatch(/\$m=19456,(?=.*t=2)(?=.*p=1)[^$]*\$/);
      expect(await verifyPassword(admin.password_hash ?? '', 'correct horse battery staple')).toBe(
        true,
      );
      expect(await verifyPassword(admin.password_hash ?? '', 'wrong')).toBe(false);
      const binding = await platform
        .selectFrom('role_bindings')
        .innerJoin('roles', 'roles.id', 'role_bindings.role_id')
        .select(['role_bindings.scope_type', 'role_bindings.organization_id', 'roles.key'])
        .where('role_bindings.administrator_id', '=', result.administratorId)
        .executeTakeFirstOrThrow();
      expect(binding).toEqual({
        scope_type: 'platform',
        organization_id: null,
        key: 'platform_super_admin',
      });
      await expect(
        createPlatformAdmin(exec, {
          email: 'root@example.test',
          password: 'another long password',
        }),
      ).rejects.toThrow(/already exists/);
      await expect(
        createPlatformAdmin(exec, { email: 'x@example.test', password: 'short' }),
      ).rejects.toThrow(/at least 12/);
      await expect(
        createPlatformAdmin(exec, { email: 'nope', password: 'long enough password' }),
      ).rejects.toThrow(/valid email/);
    } finally {
      await client.end();
    }
  });

  it('truncateAll(DATA_TABLES) clears tenant data and keeps the seeded catalogues', async () => {
    await truncateAll(platformPool, DATA_TABLES);
    const orgs = await platform
      .selectFrom('organizations')
      .select(({ fn }) => fn.countAll<number>().as('n'))
      .executeTakeFirst();
    expect(Number(orgs?.n)).toBe(0);
    const perms = await platform
      .selectFrom('permissions')
      .select(({ fn }) => fn.countAll<number>().as('n'))
      .executeTakeFirst();
    expect(Number(perms?.n)).toBe(109);
    const templates = await platform
      .selectFrom('roles')
      .select(({ fn }) => fn.countAll<number>().as('n'))
      .where('is_template', '=', true)
      .executeTakeFirst();
    expect(Number(templates?.n)).toBe(6);
  });

  // ------------------------------------------------------------- 019 multi-vendor registry

  it('019 upgrade path: NAS rows that existed at 018 are backfilled (CoovaChilli -> gateway)', () => {
    expect(backfilled).toEqual({ chilli: 'gateway', uspot: 'native' });
  });

  it('seed mirrors the @ecloud/adapters registry exactly (hash check) and is idempotent', async () => {
    const client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      const exec = pgExecutor(client);
      const check = await verifyRegistryMirror(exec);
      expect(check.mismatches).toEqual([]);
      expect(check.ok).toBe(true);
      expect(check.mirrorHash).toBe(registrySnapshotHash());
      expect(check.orphans).toEqual([]);
      const counts = await sql<{ v: number; m: number; f: number; e: number }>`
        SELECT (SELECT count(*)::int FROM vendors) AS v, (SELECT count(*)::int FROM hardware_models) AS m,
               (SELECT count(*)::int FROM firmware_versions) AS f, (SELECT count(*)::int FROM compatibility_entries) AS e
      `.execute(platform);
      expect(counts.rows[0]).toEqual({
        v: VENDORS.length,
        m: new Set(
          COMPATIBILITY_ROWS.filter((r) => r.hardwareModel !== 'UNKNOWN').map(
            (r) => `${r.vendorKey}/${r.hardwareModel}`,
          ),
        ).size,
        f: new Set(
          COMPATIBILITY_ROWS.filter((r) => r.firmware !== 'UNKNOWN').map((r) =>
            JSON.stringify([r.vendorKey, r.hardwareModel, r.firmware, r.controller]),
          ),
        ).size,
        e: COMPATIBILITY_ROWS.length,
      });

      const again = await seedRegistry(exec);
      expect(again.vendors).toMatchObject({ inserted: 0, updated: 0 });
      expect(again.hardwareModels.inserted).toBe(0);
      expect(again.firmwareVersions.inserted).toBe(0);
      expect(again.entries).toMatchObject({ inserted: 0, updated: 0, removed: [] });
      expect(again.registryHash).toBe(registrySnapshotHash());

      // drift is detected: a tampered cell, a stale hash, an extra row
      await client.query('BEGIN');
      try {
        await client.query(
          `UPDATE compatibility_entries
              SET capabilities = jsonb_set(capabilities, '{bandwidth,0,status}', '"VERIFIED_SUPPORTED"')
            WHERE key = 'ubiquiti-unifi-planned'`,
        );
        await client.query(
          "UPDATE vendors SET registry_hash = repeat('0', 64) WHERE key = 'cambium'",
        );
        const drift = await verifyRegistryMirror(exec);
        expect(drift.ok).toBe(false);
        expect(drift.mismatches).toEqual(
          expect.arrayContaining([
            'row ubiquiti-unifi-planned: content differs from the registry',
            'vendor cambium: stale registry_hash',
          ]),
        );
      } finally {
        await client.query('ROLLBACK');
      }
    } finally {
      await client.end();
    }
  });

  it('registry mirror is read-only for ecloud_app; controllers carry FORCE RLS', async () => {
    const vendors = await app.selectFrom('vendors').select('key').execute();
    expect(vendors.length).toBe(VENDORS.length);
    expect(
      await sqlState(
        sql`UPDATE compatibility_entries SET lifecycle = 'production-validated'`.execute(app),
      ),
    ).toBe('42501');
    expect(await sqlState(sql`DELETE FROM vendors`.execute(app))).toBe('42501');
    // no tenant context -> no controller rows, and inserts for another org fail WITH CHECK
    expect((await app.selectFrom('controllers').select('id').execute()).length).toBe(0);
  });
});
