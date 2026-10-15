/**
 * Migration 048: the secret-version monotonic guard, one trigger function per table.
 *
 * This file exists because of the bug it tests for. Migration 047 guarded both tables with a
 * single PL/pgSQL function and a `TG_TABLE_NAME` test. PL/pgSQL resolves `NEW.<field>` in order to
 * evaluate the expression, so the guard never short-circuits: the `nas_clients` branch raised
 * `record "new" has no field "secret_version"` on every `captive_portals` UPDATE, and the
 * `captive_portals` branch did the mirror image. Every portal publish, portal rollback, UAM secret
 * rotation, NAS edit and NAS secret rotation failed, and the first symptom an operator would have
 * seen is an unrelated 500 on whatever they touched.
 *
 * So the two no-op UPDATE cases below are not padding: they are the regression, and they are the
 * reason this suite would rather be slow than absent. Everything runs inside a transaction that is
 * rolled back, so the suite needs no truncate and leaves no rows.
 */
import { describeIntegration, getTestDatabaseUrl } from '@ecloud/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool } from './client.js';

await describeIntegration('migration 048 secret-version triggers', () => {
  let pool: Pool;

  /** 198.51.100.0/24 is the RFC 5737 documentation range, so no real address can collide. */
  const randomTestIp = (): string =>
    `198.51.100.${String(1 + Math.floor(Math.random() * 253))}`;

  beforeAll(() => {
    pool = createPool(getTestDatabaseUrl() ?? '', { max: 1 });
  });

  afterAll(async () => {
    await pool.end();
  });

  /**
   * Runs `fn` against a scratch organization, site, NAS and portal, then rolls everything back.
   * The ids come from the database so the test does not depend on an id generator.
   */
  async function withScratch(
    fn: (q: (sql: string, params?: unknown[]) => Promise<void>, ids: { nas: string; portal: string }) => Promise<void>,
  ): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const suffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      const org = await client.query<{ id: string }>(
        `INSERT INTO organizations (slug, name, status) VALUES ($1, $2, 'active') RETURNING id`,
        [`trg-${suffix}`, `Trigger ${suffix}`],
      );
      const orgId = org.rows[0]?.id ?? '';
      const site = await client.query<{ id: string }>(
        `INSERT INTO sites (organization_id, slug, name, timezone, status)
         VALUES ($1, $2, $3, 'UTC', 'active') RETURNING id`,
        [orgId, `trg-${suffix}`, `Site ${suffix}`],
      );
      const siteId = site.rows[0]?.id ?? '';
      const nas = await client.query<{ id: string }>(
        // ck_nas_clients_nas_ip_by_adapter (D-044): every non-Meraki adapter requires an address,
        // and uq_nas_clients_ip requires it to be distinct, hence the random host octets.
        `INSERT INTO nas_clients (organization_id, site_id, name, nas_identifier, nas_ip, adapter_type_key, adapter_key, secret_ref, status)
         VALUES ($1, $2, $3, $4, $5, 'coovachilli-uam', 'coovachilli-uam', 'enc:v1.trigger-test', 'active')
         RETURNING id`,
        [orgId, siteId, `NAS ${suffix}`, `nas-${suffix}`, randomTestIp()],
      );
      const portal = await client.query<{ id: string }>(
        `INSERT INTO captive_portals (organization_id, site_id, name, public_slug, portal_type, network_ref)
         VALUES ($1, $2, $3, $4, 'uspot', $5) RETURNING id`,
        [orgId, siteId, `Portal ${suffix}`, `trg-${suffix}`, `net-${suffix}`],
      );
      const q = async (sql: string, params: unknown[] = []): Promise<void> => {
        await client.query(sql, params);
      };
      await fn(q, { nas: nas.rows[0]?.id ?? '', portal: portal.rows[0]?.id ?? '' });
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  }

  it('lets an ordinary UPDATE through on both tables', async () => {
    // THE REGRESSION. Under 047 these two statements raised `record "new" has no field ...`,
    // because each table was broken by the branch written for the other one.
    await withScratch(async (q, ids) => {
      await expect(
        q('UPDATE captive_portals SET published_version_id = published_version_id WHERE id = $1', [
          ids.portal,
        ]),
      ).resolves.toBeUndefined();
      await expect(
        q('UPDATE nas_clients SET name = name WHERE id = $1', [ids.nas]),
      ).resolves.toBeUndefined();
    });
  });

  it('allows the version to rise and refuses a decrease on nas_clients', async () => {
    await withScratch(async (q, ids) => {
      await q('UPDATE nas_clients SET secret_version = 5 WHERE id = $1', [ids.nas]);
      await expect(
        q('UPDATE nas_clients SET secret_version = 2 WHERE id = $1', [ids.nas]),
      ).rejects.toThrow(/secret_version must not decrease/);
    });
  });

  it('allows the version to rise and refuses a decrease on captive_portals', async () => {
    await withScratch(async (q, ids) => {
      await q('UPDATE captive_portals SET uam_secret_version = 5 WHERE id = $1', [ids.portal]);
      await expect(
        q('UPDATE captive_portals SET uam_secret_version = 2 WHERE id = $1', [ids.portal]),
      ).rejects.toThrow(/uam_secret_version must not decrease/);
    });
  });

  it('keeps no shared trigger function, so the 047 bug cannot come back by reuse', async () => {
    // A single function guarding both tables is the shape of the original defect, not merely the
    // instance of it: the next person to add a third versioned column would reach for the same
    // `TG_TABLE_NAME` test. Asserting the shared function is absent names that for them.
    const { rows } = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM pg_proc WHERE proname = 'trg_secret_version_no_decrease'`,
    );
    expect(rows[0]?.count).toBe('0');
  });
});
