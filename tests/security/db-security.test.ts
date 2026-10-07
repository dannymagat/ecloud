/**
 * SECURITY_ARCHITECTURE.md §3.1/§3.4 probes that need no API: S-05, S-06, S-10 (DB part), the
 * FreeRADIUS role boundary, append-only enforcement, secret-column hygiene and migration
 * checksum drift detection. S-01…S-03 are lab-only (DT-19/DT-20); S-04 runs in the
 * aaa-contract suite; S-07…S-09 need the API/portal (docs/TESTING.md).
 */
import {
  APPEND_ONLY_TABLES,
  MigrationDriftError,
  PLATFORM_TABLES,
  discoverMigrations,
  migrationStatus,
  pgExecutor,
  runMigrations,
  withPlatform,
  withTenant,
  type MigrationFile,
} from '@ecloud/db';
import {
  describeIntegration,
  expectDenied,
  expectNoRows,
  getTestRadiusRoleDatabaseUrl,
  sqlProbe,
  withTwoTenants,
  type TwoTenants,
} from '@ecloud/testing';
import pg from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  countOf,
  inRolledBackTransaction,
  openTestDatabases,
  type TestDatabases,
} from '../support/db.js';

/** Column names that would hold a secret in clear text. */
const SECRET_NAME_RE = /(password|passwd|secret|token|api_?key|private_?key|psk|preshared)/i;
/** Accepted storage forms: hash, reference to a secret store, encrypted blob, display hint/prefix. */
const SAFE_SUFFIX_RE = /_(hash|hashes|ref|enc|hint|prefix)$/i;
/**
 * Documented exceptions. radius.nas.secret is the official rlm_sql `nas` shape (009); it is
 * empty in the pilot (clients.conf is rendered instead) and unreachable for ecloud_app, which
 * the S-06 test below asserts.
 */
const SECRET_COLUMN_EXCEPTIONS = new Set(['radius.nas.secret']);

function quote(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`bad identifier ${name}`);
  return `"${name}"`;
}

await describeIntegration(
  'security: database probes (S-05, S-06, S-10, radius role, append-only, drift)',
  () => {
    let dbs: TestDatabases;
    let t: TwoTenants;
    let radius: pg.Client;

    beforeAll(async () => {
      dbs = await openTestDatabases('security');
      t = await withTwoTenants(dbs.platformPool, { label: 'sec' });
      const radiusUrl = getTestRadiusRoleDatabaseUrl();
      if (radiusUrl === undefined) throw new Error('no ecloud_radius URL for the test database');
      radius = new pg.Client({
        connectionString: radiusUrl,
        application_name: 'ecloud-test-radius-role',
      });
      await radius.connect();
    });

    afterAll(async () => {
      await radius.end();
      await dbs.close();
    });

    it('S-06 every table with an organization_id column (incl. partitions) has RLS enabled + forced + a policy', async () => {
      const result = await dbs.platformPool.query<{
        table: string;
        enabled: boolean;
        forced: boolean;
        policies: number;
      }>(
        `SELECT n.nspname || '.' || c.relname AS table, c.relrowsecurity AS enabled,
              c.relforcerowsecurity AS forced,
              (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname IN ('public', 'radius') AND c.relkind IN ('r', 'p')
          AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid
                        AND a.attname = 'organization_id' AND NOT a.attisdropped)
        ORDER BY 1`,
      );
      expect(result.rows.length).toBeGreaterThan(30);
      const unprotected = result.rows
        .filter((r) => !(r.enabled && r.forced && r.policies > 0))
        .map((r) => r.table);
      // radius.nas carries organization_id for the renderer but lives in a schema ecloud_app
      // cannot even enter; anything else unprotected is a regression.
      expect(unprotected).toEqual(['radius.nas']);
      const usage = await dbs.platformPool.query<{ app: boolean }>(
        "SELECT has_schema_privilege('ecloud_app', 'radius', 'USAGE') AS app",
      );
      expect(usage.rows[0]?.app).toBe(false);
    });

    it('S-06 the only public tables without RLS are the catalogued PLATFORM_TABLES', async () => {
      const result = await dbs.platformPool.query<{ relname: string }>(
        `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relispartition
          AND NOT (c.relrowsecurity AND c.relforcerowsecurity)
        ORDER BY 1`,
      );
      expect(result.rows.map((r) => r.relname).sort()).toEqual(
        [...PLATFORM_TABLES, 'schema_migrations'].sort(),
      );
    });

    it('S-05 tenant work never goes through withPlatform(); one withPlatform() call = one audit row', async () => {
      const platformRows = (org: string) =>
        countOf(
          dbs.platformPool,
          "SELECT count(*)::int AS n FROM audit_logs WHERE action = 'platform:access' AND target_id = $1",
          [org],
        );
      const before = await platformRows(t.a.organizationId);
      await withTenant(dbs.app, t.a.organizationId, async (trx) => {
        await trx.selectFrom('users').selectAll().execute();
        await trx.selectFrom('sessions').selectAll().execute();
        await trx
          .updateTable('users')
          .set({ display_name: 'S-05' })
          .where('id', '=', t.a.userId)
          .execute();
      });
      expect(await platformRows(t.a.organizationId)).toBe(before);
      await withPlatform(
        dbs.platform,
        { reason: 'S-05 probe', organizationId: t.a.organizationId },
        () => Promise.resolve(),
      );
      expect(await platformRows(t.a.organizationId)).toBe(before + 1);
    });

    it('S-10 (DB part) a worker scoped to A cannot find or act on a session of B', async () => {
      await withTenant(dbs.app, t.a.organizationId, async (trx) => {
        expectNoRows(
          await sqlProbe(trx, 'SELECT id FROM sessions WHERE id = $1', [t.b.sessionId]),
          'B session lookup in A',
        );
      });
      const action = await withTenant(dbs.app, t.a.organizationId, (trx) =>
        sqlProbe(
          trx,
          "INSERT INTO session_actions (organization_id, session_id, action) VALUES ($1, $2, 'disconnect')",
          [t.b.organizationId, t.b.sessionId],
        ),
      );
      expectDenied(action, /row-level security/, 'session_action for B');
    });

    it('radius role: no access to the public schema tables', async () => {
      const grants = await dbs.platformPool.query<{ relname: string }>(
        `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v')
          AND (has_table_privilege('ecloud_radius', c.oid, 'SELECT')
            OR has_table_privilege('ecloud_radius', c.oid, 'INSERT')
            OR has_table_privilege('ecloud_radius', c.oid, 'UPDATE')
            OR has_table_privilege('ecloud_radius', c.oid, 'DELETE'))`,
      );
      expect(grants.rows.map((r) => r.relname)).toEqual([]);
      expectDenied(
        await sqlProbe(radius, 'SELECT id FROM public.users LIMIT 1'),
        /permission denied/,
      );
      expectDenied(
        await sqlProbe(radius, 'SELECT id FROM public.nas_clients LIMIT 1'),
        /permission denied/,
      );
    });

    it('radius role: radacct_raw is INSERT-only (no SELECT, UPDATE, DELETE, TRUNCATE)', async () => {
      const acctUniqueId = `sec-${t.runId}`;
      await radius.query('BEGIN');
      try {
        const insert = await sqlProbe(
          radius,
          `INSERT INTO radius.radacct_raw (acctsessionid, acctuniqueid, nasipaddress, acctstatustype)
         VALUES ('sec-probe', $1, '192.0.2.10', 'Start') ON CONFLICT DO NOTHING`,
          [acctUniqueId],
        );
        expect(insert.ok, insert.message).toBe(true);
        expect(insert.rowCount).toBe(1);
      } finally {
        await radius.query('ROLLBACK');
      }
      expectDenied(await sqlProbe(radius, 'SELECT radacctid FROM radius.radacct_raw LIMIT 1'));
      expectDenied(
        await sqlProbe(
          radius,
          "UPDATE radius.radacct_raw SET username = 'x' WHERE acctuniqueid = $1",
          [acctUniqueId],
        ),
      );
      expectDenied(
        await sqlProbe(radius, 'DELETE FROM radius.radacct_raw WHERE acctuniqueid = $1', [
          acctUniqueId,
        ]),
      );
      expectDenied(await sqlProbe(radius, 'TRUNCATE radius.radacct_raw'));
      const nasView = await sqlProbe(radius, 'SELECT nasname FROM radius.nas_v LIMIT 1');
      expect(nasView.ok, nasView.message).toBe(true);
      expectDenied(await sqlProbe(radius, 'SELECT secret FROM radius.nas LIMIT 1'));
    });

    it('append-only tables: trigger on parent and every partition; UPDATE/DELETE raise even for the owner', async () => {
      for (const table of APPEND_ONLY_TABLES) {
        const missing = await dbs.platformPool.query<{ relname: string }>(
          `SELECT c.relname FROM pg_class c
          WHERE (c.oid = $1::regclass OR c.oid IN (SELECT inhrelid FROM pg_inherits WHERE inhparent = $1::regclass))
            AND NOT EXISTS (SELECT 1 FROM pg_trigger tg JOIN pg_proc p ON p.oid = tg.tgfoid
                             WHERE tg.tgrelid = c.oid AND p.proname = 'forbid_mutation' AND tg.tgenabled <> 'D')`,
          [table],
        );
        expect(
          missing.rows.map((r) => r.relname),
          `${table}: partitions without trigger`,
        ).toEqual([]);

        const ref = t.a.rows[table];
        if (ref === undefined) throw new Error(`no seeded row for ${table}`);
        await inRolledBackTransaction(dbs.platformPool, null, async (client) => {
          await client.query('SAVEPOINT probe');
          const update = await sqlProbe(
            client,
            `UPDATE ${quote(table)} SET organization_id = organization_id WHERE ${quote(ref.column)} = $1`,
            [ref.value],
          );
          expectDenied(update, /append-only/, `${table} UPDATE as owner`);
          await client.query('ROLLBACK TO SAVEPOINT probe');
          const del = await sqlProbe(
            client,
            `DELETE FROM ${quote(table)} WHERE ${quote(ref.column)} = $1`,
            [ref.value],
          );
          expectDenied(del, /append-only/, `${table} DELETE as owner`);
        });

        const privileges = await dbs.platformPool.query<{
          u: boolean;
          d: boolean;
          tr: boolean;
          i: boolean;
        }>(
          `SELECT has_table_privilege('ecloud_app', $1, 'UPDATE') AS u,
                has_table_privilege('ecloud_app', $1, 'DELETE') AS d,
                has_table_privilege('ecloud_app', $1, 'TRUNCATE') AS tr,
                has_table_privilege('ecloud_app', $1, 'INSERT') AS i`,
          [table],
        );
        expect(privileges.rows[0], `${table} ecloud_app privileges`).toEqual({
          u: false,
          d: false,
          tr: false,
          i: true,
        });
      }
    });

    it('no plaintext secret columns (only *_hash / *_ref / *_enc / *_hint / *_prefix forms)', async () => {
      const columns = await dbs.platformPool.query<{ name: string }>(
        `SELECT c.table_schema || '.' || c.table_name || '.' || c.column_name AS name
         FROM information_schema.columns c
         JOIN pg_class k ON k.relname = c.table_name
         JOIN pg_namespace n ON n.oid = k.relnamespace AND n.nspname = c.table_schema
        WHERE c.table_schema IN ('public', 'radius') AND NOT k.relispartition AND k.relkind IN ('r', 'p', 'v')`,
      );
      const offending = columns.rows
        .map((r) => r.name)
        .filter((name) => {
          const column = name.split('.').pop() ?? '';
          return SECRET_NAME_RE.test(column) && !SAFE_SUFFIX_RE.test(column);
        })
        .filter((name) => !SECRET_COLUMN_EXCEPTIONS.has(name));
      // radius.nas_v re-exposes radius.nas.secret to ecloud_radius only (asserted above)
      expect(offending.filter((n) => n !== 'radius.nas_v.secret')).toEqual([]);
      const viewReaders = await dbs.platformPool.query<{ app: boolean }>(
        "SELECT has_table_privilege('ecloud_app', 'radius.nas_v', 'SELECT') AS app",
      );
      expect(viewReaders.rows[0]?.app).toBe(false);
    });

    it('migration checksum drift and orphans are detected before anything is applied', async () => {
      const client = new pg.Client({
        connectionString: dbs.databaseUrl,
        application_name: 'ecloud-test-drift',
      });
      await client.connect();
      try {
        const exec = pgExecutor(client);
        const files = discoverMigrations();
        const clean = await migrationStatus(exec, files);
        expect(clean.clean).toBe(true);

        const target = files[files.length - 1] as MigrationFile;
        const tampered: MigrationFile[] = files.map((f) =>
          f.name === target.name
            ? { ...f, sql: `${f.sql}\n-- tampered`, checksum: 'f'.repeat(64) }
            : f,
        );
        const drift = await migrationStatus(exec, tampered);
        expect(drift.clean).toBe(false);
        expect(drift.migrations.find((m) => m.name === target.name)?.state).toBe('changed');
        await expect(
          runMigrations(exec, tampered, { actor: 'ecloud-test-drift' }),
        ).rejects.toBeInstanceOf(MigrationDriftError);

        const withoutLast = files.slice(0, -1);
        const orphan = await migrationStatus(exec, withoutLast);
        expect(orphan.orphans).toContain(target.name);
        await expect(
          runMigrations(exec, withoutLast, { actor: 'ecloud-test-drift' }),
        ).rejects.toBeInstanceOf(MigrationDriftError);

        const after = await migrationStatus(exec, files);
        expect(after.clean, 'drift probes must not modify schema_migrations').toBe(true);
      } finally {
        await client.end();
      }
    });
  },
);
