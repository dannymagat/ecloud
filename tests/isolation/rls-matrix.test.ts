/**
 * Generated RLS matrix (MULTITENANCY.md §5 T-02/T-03/T-09/T-10 at database level).
 *
 * One block per entry of `TENANT_SCOPED_TABLES`, so a table added to the catalogue is covered
 * automatically; `withTwoTenants()` must seed a row for it or the coverage guard fails. Every
 * probe runs as `ecloud_app` through `withTenant()` (org A) against a fully seeded org B.
 */
import {
  PARTITIONED_TABLES,
  TENANT_SCOPED_TABLES,
  withTenant,
  type DbTransaction,
} from '@ecloud/db';
import {
  describeIntegration,
  expectDenied,
  expectNoRows,
  sqlProbe,
  tenantTablesMissingFromGraph,
  withTwoTenants,
  type TenantGraph,
  type TwoTenants,
} from '@ecloud/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  countOf,
  inRolledBackTransaction,
  openTestDatabases,
  type TestDatabases,
} from '../support/db.js';

const IDENT_RE = /^[a-z_][a-z0-9_]*$/;
function ident(name: string): string {
  if (!IDENT_RE.test(name)) throw new Error(`bad identifier ${name}`);
  return `"${name}"`;
}

/** Column rewritten by the no-op UPDATE probes (role_permissions has no organization_id). */
function touchColumn(table: string): string {
  return table === 'role_permissions' ? 'permission_key' : 'organization_id';
}

function rowRef(graph: TenantGraph, table: string): { column: string; value: string | number } {
  const ref = graph.rows[table];
  if (ref === undefined) throw new Error(`tenant graph has no row for ${table}`);
  return ref;
}

/** Rows of `table` that do NOT belong to org (templates of `roles` are legitimately shared). */
function foreignRowsSql(table: string): string {
  if (table === 'role_permissions') {
    return `SELECT count(*)::int AS n FROM role_permissions rp
             WHERE NOT EXISTS (SELECT 1 FROM roles r WHERE r.id = rp.role_id
                                 AND (r.organization_id IS NULL OR r.organization_id = $1::uuid))`;
  }
  if (table === 'roles') {
    return 'SELECT count(*)::int AS n FROM roles WHERE organization_id IS NOT NULL AND organization_id <> $1::uuid';
  }
  return `SELECT count(*)::int AS n FROM ${ident(table)} WHERE organization_id IS DISTINCT FROM $1::uuid`;
}

/** Rows a connection WITHOUT tenant context can see (templates excluded). */
function tenantRowsSql(table: string): string {
  if (table === 'role_permissions') {
    return `SELECT count(*)::int AS n FROM role_permissions rp
             WHERE NOT EXISTS (SELECT 1 FROM roles r WHERE r.id = rp.role_id AND r.organization_id IS NULL)`;
  }
  if (table === 'roles')
    return 'SELECT count(*)::int AS n FROM roles WHERE organization_id IS NOT NULL';
  return `SELECT count(*)::int AS n FROM ${ident(table)}`;
}

function insertForeignSql(table: string): { text: string; values: (g: TwoTenants) => unknown[] } {
  if (table === 'role_permissions') {
    return {
      text: 'INSERT INTO role_permissions (role_id, permission_key) SELECT $1::uuid, key FROM permissions ORDER BY key DESC LIMIT 1',
      values: (g) => [g.b.roleId],
    };
  }
  return {
    text: `INSERT INTO ${ident(table)} (organization_id) VALUES ($1::uuid)`,
    values: (g) => [g.b.organizationId],
  };
}

function moveToForeignSql(table: string, g: TwoTenants): { text: string; values: unknown[] } {
  const own = rowRef(g.a, table);
  if (table === 'role_permissions') {
    return {
      text: 'UPDATE role_permissions SET role_id = $1::uuid WHERE role_id = $2::uuid',
      values: [g.b.roleId, own.value],
    };
  }
  return {
    text: `UPDATE ${ident(table)} SET organization_id = $1::uuid WHERE ${ident(own.column)} = $2`,
    values: [g.b.organizationId, own.value],
  };
}

async function inTenant<T>(
  dbs: TestDatabases,
  organizationId: string,
  fn: (trx: DbTransaction) => Promise<T>,
): Promise<T> {
  return withTenant(dbs.app, organizationId, fn);
}

await describeIntegration('isolation: generated RLS matrix (TENANT_SCOPED_TABLES)', () => {
  let dbs: TestDatabases;
  let tenants: TwoTenants;

  beforeAll(async () => {
    dbs = await openTestDatabases('iso-matrix');
    tenants = await withTwoTenants(dbs.platformPool, { label: 'mx' });
  });

  afterAll(async () => {
    await dbs.close();
  });

  it('T-09 coverage guard: every tenant-scoped table is seeded and RLS-protected in the catalog', async () => {
    expect(tenantTablesMissingFromGraph(), 'add a row builder to withTwoTenants()').toEqual([]);
    const result = await dbs.platformPool.query<{ relname: string }>(
      `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relispartition
          AND c.relrowsecurity AND c.relforcerowsecurity
          AND EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid AND p.polname = 'tenant_isolation')`,
    );
    expect(result.rows.map((r) => r.relname).sort()).toEqual([...TENANT_SCOPED_TABLES].sort());
  });

  describe.each([...TENANT_SCOPED_TABLES])('%s', (table) => {
    it(`T-09 [${table}] org A sees its own seeded row and nothing of org B`, async () => {
      const own = rowRef(tenants.a, table);
      const foreign = rowRef(tenants.b, table);
      await inTenant(dbs, tenants.a.organizationId, async (trx) => {
        const mine = await sqlProbe(
          trx,
          `SELECT 1 FROM ${ident(table)} WHERE ${ident(own.column)} = $1`,
          [own.value],
        );
        expect(mine.ok, mine.message).toBe(true);
        expect(mine.rows.length).toBeGreaterThanOrEqual(1);

        expectNoRows(
          await sqlProbe(trx, `SELECT 1 FROM ${ident(table)} WHERE ${ident(foreign.column)} = $1`, [
            foreign.value,
          ]),
          `${table}: B's row by key`,
        );
        const leaked = await sqlProbe<{ n: number }>(trx, foreignRowsSql(table), [
          tenants.a.organizationId,
        ]);
        expect(leaked.ok, leaked.message).toBe(true);
        expect(leaked.rows[0]?.n, `${table}: rows of other tenants visible to A`).toBe(0);
      });
    });

    it(`T-10 [${table}] no app.current_org (unset or empty) -> zero tenant rows`, async () => {
      // pooled autocommit statement: no transaction, no GUC at all
      expect(await countOf(dbs.appPool, tenantRowsSql(table))).toBe(0);
      // explicit empty GUC inside a transaction (NULLIF(...,'') -> NULL -> no match)
      await inRolledBackTransaction(dbs.appPool, '', async (client) => {
        expect(await countOf(client, tenantRowsSql(table))).toBe(0);
      });
      // ...while the platform role sees both seeded rows
      const a = rowRef(tenants.a, table);
      const b = rowRef(tenants.b, table);
      const both = await countOf(
        dbs.platformPool,
        `SELECT count(*)::int AS n FROM ${ident(table)} WHERE ${ident(a.column)} IN ($1, $2)`,
        [a.value, b.value],
      );
      expect(both).toBeGreaterThanOrEqual(2);
    });

    it(`T-02 [${table}] cross-org UPDATE and DELETE by A touch no row of B`, async () => {
      const foreign = rowRef(tenants.b, table);
      const touch = ident(touchColumn(table));
      const where = `${ident(foreign.column)} = $1`;
      const update = await inTenant(dbs, tenants.a.organizationId, (trx) =>
        sqlProbe(trx, `UPDATE ${ident(table)} SET ${touch} = ${touch} WHERE ${where}`, [
          foreign.value,
        ]),
      );
      // either RLS hides the row (0 affected) or the role lacks UPDATE (append-only tables)
      if (update.ok) expect(update.rowCount, `${table}: UPDATE affected B`).toBe(0);
      else expectDenied(update, undefined, `${table} UPDATE`);

      const del = await inTenant(dbs, tenants.a.organizationId, (trx) =>
        sqlProbe(trx, `DELETE FROM ${ident(table)} WHERE ${where}`, [foreign.value]),
      );
      if (del.ok) expect(del.rowCount, `${table}: DELETE affected B`).toBe(0);
      else expectDenied(del, undefined, `${table} DELETE`);

      const still = await countOf(
        dbs.platformPool,
        `SELECT count(*)::int AS n FROM ${ident(table)} WHERE ${where}`,
        [foreign.value],
      );
      expect(still, `${table}: B's row must survive`).toBeGreaterThanOrEqual(1);
    });

    it(`T-03 [${table}] INSERT of a row for org B inside A's context fails WITH CHECK`, async () => {
      const insert = insertForeignSql(table);
      const probe = await inTenant(dbs, tenants.a.organizationId, (trx) =>
        sqlProbe(trx, insert.text, insert.values(tenants)),
      );
      expectDenied(probe, /row-level security/, `${table} INSERT for B`);
    });

    it(`T-03 [${table}] UPDATE moving A's row to org B fails`, async () => {
      const move = moveToForeignSql(table, tenants);
      const probe = await inTenant(dbs, tenants.a.organizationId, (trx) =>
        sqlProbe(trx, move.text, move.values),
      );
      // RLS WITH CHECK (mutable tables) or missing UPDATE privilege (append-only tables)
      expectDenied(probe, undefined, `${table} UPDATE to B`);
    });
  });

  describe.each([...PARTITIONED_TABLES])('partitions of %s', (table) => {
    it(`T-09/T-10 [${table}] every partition is RLS-forced and isolates when addressed directly`, async () => {
      const parts = await dbs.platformPool.query<{
        relname: string;
        forced: boolean;
        policy: boolean;
      }>(
        `SELECT c.relname, c.relrowsecurity AND c.relforcerowsecurity AS forced,
                EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid AND p.polname = 'tenant_isolation') AS policy
           FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
          WHERE i.inhparent = $1::regclass ORDER BY c.relname`,
        [table],
      );
      expect(parts.rows.length, `${table} has partitions`).toBeGreaterThan(0);
      for (const part of parts.rows) {
        expect(part.forced, `${part.relname} FORCE RLS`).toBe(true);
        expect(part.policy, `${part.relname} tenant_isolation policy`).toBe(true);
        expect(
          await countOf(dbs.appPool, `SELECT count(*)::int AS n FROM ${ident(part.relname)}`),
        ).toBe(0);
        await inTenant(dbs, tenants.a.organizationId, async (trx) => {
          const leaked = await sqlProbe<{ n: number }>(
            trx,
            `SELECT count(*)::int AS n FROM ${ident(part.relname)} WHERE organization_id IS DISTINCT FROM $1::uuid`,
            [tenants.a.organizationId],
          );
          expect(leaked.ok, leaked.message).toBe(true);
          expect(leaked.rows[0]?.n, `${part.relname} leaks to A`).toBe(0);
        });
      }
    });
  });
});
