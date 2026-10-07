/**
 * MULTITENANCY.md §5 isolation cases T-01…T-15 at DATABASE level (ecloud_app via withTenant /
 * withSite, org A vs org B, plus the platform role). The API-level halves of these cases
 * (HTTP 404/403, auth_events written by the AAA endpoint, export tokens, API-key roles) belong
 * to the API suites; see docs/TESTING.md "API-level tests expected from A5".
 */
import { TenancyError, withPlatform, withSite, withTenant } from '@ecloud/db';
import { newId } from '@ecloud/shared';
import {
  describeIntegration,
  expectDenied,
  expectNoRows,
  sqlProbe,
  withTwoTenants,
  type TwoTenants,
} from '@ecloud/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  countOf,
  inRolledBackTransaction,
  openTestDatabases,
  type TestDatabases,
} from '../support/db.js';

await describeIntegration('isolation: tenant cases T-01…T-15 (database level)', () => {
  let dbs: TestDatabases;
  let t: TwoTenants;

  beforeAll(async () => {
    dbs = await openTestDatabases('iso-cases');
    t = await withTwoTenants(dbs.platformPool, { label: 'tc' });
  });

  afterAll(async () => {
    await dbs.close();
  });

  it('T-01 org A lists sites: only A rows, count equals the DB rows of A', async () => {
    const expected = await countOf(
      dbs.platformPool,
      'SELECT count(*)::int AS n FROM sites WHERE organization_id = $1',
      [t.a.organizationId],
    );
    const sites = await withTenant(dbs.app, t.a.organizationId, (trx) =>
      trx.selectFrom('sites').select(['id', 'organization_id']).execute(),
    );
    expect(sites).toHaveLength(expected);
    expect(sites.every((s) => s.organization_id === t.a.organizationId)).toBe(true);
    expect(sites.map((s) => s.id)).toContain(t.a.siteId);
  });

  it('T-02 org A reads a user of org B by id -> no row (API maps to 404)', async () => {
    const rows = await withTenant(dbs.app, t.a.organizationId, (trx) =>
      trx.selectFrom('users').select('id').where('id', '=', t.b.userId).execute(),
    );
    expectNoRows(rows, 'B user by id');
  });

  it('T-03 FK re-check: B policy is invisible to A and an assignment row for B is refused', async () => {
    await withTenant(dbs.app, t.a.organizationId, async (trx) => {
      expectNoRows(
        await sqlProbe(trx, 'SELECT id FROM policies WHERE id = $1', [t.b.policyId]),
        'B policy lookup in A',
      );
    });
    const probe = await withTenant(dbs.app, t.a.organizationId, (trx) =>
      sqlProbe(
        trx,
        `INSERT INTO policy_assignments (organization_id, policy_id, target_type, user_id)
         VALUES ($1, $2, 'user', $3)`,
        [t.b.organizationId, t.b.policyId, t.b.userId],
      ),
    );
    expectDenied(probe, /row-level security/, 'policy_assignment for B');
  });

  it('T-04 (DB part) withSite() publishes app.current_site and never widens the org scope', async () => {
    await withSite(dbs.app, t.a.organizationId, t.a.siteId, async (trx) => {
      const guc = await sqlProbe<{ site: string }>(
        trx,
        "SELECT current_setting('app.current_site', true) AS site",
      );
      expect(guc.rows[0]?.site).toBe(t.a.siteId);
      expectNoRows(
        await sqlProbe(trx, 'SELECT id FROM sessions WHERE id = $1', [t.b.sessionId]),
        'B session under A site scope',
      );
    });
    // site is not an RLS boundary (MULTITENANCY §4.4): site-admin scoping is the API's job
    await withSite(dbs.app, t.a.organizationId, newId(), async (trx) => {
      const own = await sqlProbe(trx, 'SELECT id FROM sessions WHERE id = $1', [t.a.sessionId]);
      expect(own.rows).toHaveLength(1);
    });
  });

  it('T-05 (DB part) a reject auth_event written in A context stays in A', async () => {
    const username = `only-in-b-${t.runId}`;
    await withTenant(dbs.app, t.a.organizationId, (trx) =>
      trx
        .insertInto('auth_events')
        .values({
          organization_id: t.a.organizationId,
          nas_client_id: t.a.nasClientId,
          username,
          result: 'reject',
          reason: 'unknown_user',
        })
        .execute(),
    );
    const inA = await withTenant(dbs.app, t.a.organizationId, (trx) =>
      trx.selectFrom('auth_events').select('result').where('username', '=', username).execute(),
    );
    expect(inA).toEqual([{ result: 'reject' }]);
    const inB = await withTenant(dbs.app, t.b.organizationId, (trx) =>
      trx.selectFrom('auth_events').select('id').where('username', '=', username).execute(),
    );
    expectNoRows(inB, 'A auth_event in B');
  });

  it('T-06 same username in A and B: B resolves only its user; A row untouched by B writes', async () => {
    expect(t.a.username).toBe(t.b.username);
    const before = await dbs.platformPool.query<{ updated_at: Date; display_name: string | null }>(
      'SELECT updated_at, display_name FROM users WHERE id = $1',
      [t.a.userId],
    );
    const resolved = await withTenant(dbs.app, t.b.organizationId, async (trx) => {
      const rows = await trx
        .selectFrom('users')
        .select(['id'])
        .where('username', '=', t.b.username)
        .execute();
      await trx
        .updateTable('users')
        .set({ display_name: 'touched by B' })
        .where('username', '=', t.b.username)
        .execute();
      return rows;
    });
    expect(resolved).toEqual([{ id: t.b.userId }]);
    const after = await dbs.platformPool.query<{ updated_at: Date; display_name: string | null }>(
      'SELECT updated_at, display_name FROM users WHERE id = $1',
      [t.a.userId],
    );
    expect(after.rows[0]).toEqual(before.rows[0]);
  });

  it('T-07 (DB part) A voucher is invisible on B; code_hash is globally unique; B logs tenant_mismatch privately', async () => {
    await withTenant(dbs.app, t.b.organizationId, async (trx) => {
      expectNoRows(
        await sqlProbe(trx, 'SELECT id FROM vouchers WHERE code_hash = $1', [t.a.voucherCodeHash]),
        'A voucher by code in B',
      );
    });
    const duplicate = await withTenant(dbs.app, t.b.organizationId, (trx) =>
      sqlProbe(
        trx,
        'INSERT INTO vouchers (organization_id, batch_id, code_hash) VALUES ($1, $2, $3)',
        [t.b.organizationId, t.b.voucherBatchId, t.a.voucherCodeHash],
      ),
    );
    expect(duplicate.code, 'a code resolves to exactly one tenant').toBe('23505');

    const reason = `tenant_mismatch-${t.runId}`;
    await withTenant(dbs.app, t.b.organizationId, (trx) =>
      trx
        .insertInto('portal_login_attempts')
        .values({
          organization_id: t.b.organizationId,
          captive_portal_id: t.b.captivePortalId,
          method: 'voucher',
          result: 'reject',
          reason,
        })
        .execute(),
    );
    const seenByA = await withTenant(dbs.app, t.a.organizationId, (trx) =>
      trx.selectFrom('portal_login_attempts').select('id').where('reason', '=', reason).execute(),
    );
    expectNoRows(seenByA, 'B login attempt in A');
  });

  it('T-08 accounting with an unresolved tenant (organization_id NULL) is invisible to every tenant', async () => {
    const acctUniqueId = `unresolved-${t.runId}-${newId()}`;
    await dbs.platformPool.query(
      `INSERT INTO accounting_records (organization_id, acct_unique_id, acct_session_id, status_type, nas_ip)
       VALUES (NULL, $1, 'foreign', 'interim', '198.51.100.7')`,
      [acctUniqueId],
    );
    for (const org of [t.a.organizationId, t.b.organizationId]) {
      await withTenant(dbs.app, org, async (trx) => {
        expectNoRows(
          await sqlProbe(trx, 'SELECT id FROM accounting_records WHERE acct_unique_id = $1', [
            acctUniqueId,
          ]),
          'NULL-org accounting row',
        );
      });
    }
    expect(
      await countOf(
        dbs.platformPool,
        'SELECT count(*)::int AS n FROM accounting_records WHERE acct_unique_id = $1',
        [acctUniqueId],
      ),
    ).toBe(1);
    // A's session is unchanged by the foreign packet
    const session = await dbs.platformPool.query<{ status: string }>(
      'SELECT status FROM sessions WHERE id = $1',
      [t.a.sessionId],
    );
    expect(session.rows[0]?.status).toBe('active');
  });

  it('T-09 SELECT count(*) FROM users with app.current_org = A equals A users only', async () => {
    const expected = await countOf(
      dbs.platformPool,
      'SELECT count(*)::int AS n FROM users WHERE organization_id = $1',
      [t.a.organizationId],
    );
    const counted = await withTenant(dbs.app, t.a.organizationId, (trx) =>
      sqlProbe<{ n: number }>(trx, 'SELECT count(*)::int AS n FROM users'),
    );
    expect(counted.rows[0]?.n).toBe(expected);
  });

  it('T-10 same query without any SET LOCAL returns 0 rows (fails closed)', async () => {
    expect(await countOf(dbs.appPool, 'SELECT count(*)::int AS n FROM users')).toBe(0);
    const viaKysely = await dbs.app
      .transaction()
      .execute((trx) => sqlProbe<{ n: number }>(trx, 'SELECT count(*)::int AS n FROM users'));
    expect(viaKysely.rows[0]?.n).toBe(0);
  });

  it('T-11 (DB part) an impersonation audit row can be written for A but never for B from A context', async () => {
    const impersonator = t.a.administratorId;
    const forB = await withTenant(dbs.app, t.a.organizationId, (trx) =>
      sqlProbe(
        trx,
        `INSERT INTO audit_logs (organization_id, actor_type, actor_id, impersonator_id, action)
         VALUES ($1, 'administrator', $2, $2, 'organization:update')`,
        [t.b.organizationId, impersonator],
      ),
    );
    expectDenied(forB, /row-level security/, 'audit row for B');
    const action = `organization:update_${t.runId}`;
    await withTenant(dbs.app, t.a.organizationId, (trx) =>
      trx
        .insertInto('audit_logs')
        .values({
          organization_id: t.a.organizationId,
          actor_type: 'administrator',
          actor_id: impersonator,
          impersonator_id: impersonator,
          action,
        })
        .execute(),
    );
    const visibleToB = await withTenant(dbs.app, t.b.organizationId, (trx) =>
      trx.selectFrom('audit_logs').select('id').where('action', '=', action).execute(),
    );
    expectNoRows(visibleToB, 'A impersonation audit in B');
  });

  it('T-12 (DB part) A sees only its webhooks and deliveries', async () => {
    const hooks = await withTenant(dbs.app, t.a.organizationId, (trx) =>
      trx.selectFrom('webhooks').select(['id', 'organization_id']).execute(),
    );
    expect(hooks.map((h) => h.id)).toContain(t.a.webhookId);
    expect(hooks.every((h) => h.organization_id === t.a.organizationId)).toBe(true);
    const deliveries = await withTenant(dbs.app, t.a.organizationId, (trx) =>
      trx
        .selectFrom('webhook_deliveries')
        .select('id')
        .where('webhook_id', '=', t.b.webhookId)
        .execute(),
    );
    expectNoRows(deliveries, 'B deliveries in A');
  });

  it('T-14 (DB part) API keys of A are invisible to B', async () => {
    const keyId = t.a.rows['api_keys']?.value;
    const rows = await withTenant(dbs.app, t.b.organizationId, (trx) =>
      sqlProbe(trx, 'SELECT id FROM api_keys WHERE id = $1', [keyId]),
    );
    expectNoRows(rows, 'A api key in B');
  });

  it('T-15 templates are readable but not writable by a tenant (UPDATE / INSERT / grant)', async () => {
    const template = await dbs.platformPool.query<{ id: string }>(
      'SELECT id FROM roles WHERE organization_id IS NULL ORDER BY key LIMIT 1',
    );
    const templateId = template.rows[0]?.id;
    expect(templateId, 'seeded role templates').toBeDefined();

    await withTenant(dbs.app, t.a.organizationId, async (trx) => {
      const visible = await sqlProbe(trx, 'SELECT id FROM roles WHERE id = $1', [templateId]);
      expect(visible.rows).toHaveLength(1);
    });
    const update = await withTenant(dbs.app, t.a.organizationId, (trx) =>
      sqlProbe(trx, "UPDATE roles SET name = name || ' (edited)' WHERE id = $1", [templateId]),
    );
    expectDenied(update, /row-level security/, 'UPDATE template');
    const insert = await withTenant(dbs.app, t.a.organizationId, (trx) =>
      sqlProbe(
        trx,
        "INSERT INTO roles (organization_id, key, name) VALUES (NULL, $1, 'fake template')",
        [`fake_${t.runId}`],
      ),
    );
    expectDenied(insert, /row-level security/, 'INSERT template');
    const grant = await withTenant(dbs.app, t.a.organizationId, (trx) =>
      sqlProbe(
        trx,
        'INSERT INTO role_permissions (role_id, permission_key) SELECT $1::uuid, key FROM permissions ORDER BY key DESC LIMIT 1',
        [templateId],
      ),
    );
    expectDenied(grant, /row-level security/, 'grant on template');
  });

  it('T-15 copy-on-write: a platform change to a template does not alter the custom role of A', async () => {
    const before = await dbs.platformPool.query(
      'SELECT key, name, description FROM roles WHERE id = $1',
      [t.a.roleId],
    );
    await inRolledBackTransaction(dbs.platformPool, null, async (client) => {
      await client.query(
        "UPDATE roles SET description = 'template v2' WHERE organization_id IS NULL",
      );
      const during = await client.query('SELECT key, name, description FROM roles WHERE id = $1', [
        t.a.roleId,
      ]);
      expect(during.rows).toEqual(before.rows);
    });
  });

  // Fixed by migration 012 (RESTRICTIVE DELETE guards on roles / role_permissions).
  it('T-15: a tenant cannot DELETE a platform template role or its grants', async () => {
    await inRolledBackTransaction(dbs.appPool, t.a.organizationId, async (client) => {
      const grants = await sqlProbe(
        client,
        'DELETE FROM role_permissions WHERE role_id IN (SELECT id FROM roles WHERE organization_id IS NULL)',
      );
      expect(grants.ok && grants.rowCount > 0, 'template grants deletable by tenant').toBe(false);
      const roles = await sqlProbe(client, 'DELETE FROM roles WHERE organization_id IS NULL');
      expect(roles.ok && roles.rowCount > 0, 'templates deletable by tenant').toBe(false);
    });
  });

  it('T-15: a tenant can still DELETE its own custom role grants', async () => {
    await inRolledBackTransaction(dbs.appPool, t.a.organizationId, async (client) => {
      const own = await sqlProbe(client, 'DELETE FROM role_permissions WHERE role_id = $1', [
        t.a.roleId,
      ]);
      expect(own.ok).toBe(true);
    });
  });

  it('platform vs app roles: only the platform connection has BYPASSRLS', async () => {
    const roles = await dbs.platformPool.query<{
      rolname: string;
      rolbypassrls: boolean;
      rolsuper: boolean;
    }>(
      "SELECT rolname, rolbypassrls, rolsuper FROM pg_roles WHERE rolname IN ('ecloud_app', 'ecloud_radius')",
    );
    expect(roles.rows.map((r) => r.rolname).sort()).toEqual(['ecloud_app', 'ecloud_radius']);
    for (const r of roles.rows) {
      expect(r.rolbypassrls, `${r.rolname} BYPASSRLS`).toBe(false);
      expect(r.rolsuper, `${r.rolname} SUPERUSER`).toBe(false);
    }
    const app = await dbs.appPool.query<{ u: string; b: boolean }>(
      'SELECT current_user AS u, rolbypassrls AS b FROM pg_roles WHERE rolname = current_user',
    );
    expect(app.rows[0]).toEqual({ u: 'ecloud_app', b: false });
    const platform = await dbs.platformPool.query<{ b: boolean }>(
      'SELECT rolbypassrls AS b FROM pg_roles WHERE rolname = current_user',
    );
    expect(platform.rows[0]?.b).toBe(true);
  });

  it('withPlatform() refuses the RLS connection and writes exactly one platform:access audit row', async () => {
    await expect(
      withPlatform(dbs.app, { reason: 'must refuse' }, () => Promise.resolve(1)),
    ).rejects.toBeInstanceOf(TenancyError);

    const reason = `isolation-suite ${t.runId}`;
    const seen = await withPlatform(
      dbs.platform,
      { reason, organizationId: t.b.organizationId, actorType: 'system' },
      (trx) =>
        trx
          .selectFrom('users')
          .select('organization_id')
          .where('id', 'in', [t.a.userId, t.b.userId])
          .execute(),
    );
    expect(seen).toHaveLength(2);
    const audit = await dbs.platformPool.query<{
      action: string;
      target_id: string;
      reason: string;
    }>(
      `SELECT action, target_id, after->>'reason' AS reason FROM audit_logs
        WHERE action = 'platform:access' AND after->>'reason' = $1`,
      [reason],
    );
    expect(audit.rows).toEqual([
      { action: 'platform:access', target_id: t.b.organizationId, reason },
    ]);
  });
});
