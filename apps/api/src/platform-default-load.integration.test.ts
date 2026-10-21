/**
 * `loadPlatformDefaultPolicy` (migration 043), the loader that makes the resolver's
 * `platform_default` branch reachable at all.
 *
 * EVERY CASE HERE ROLLS BACK, and that is not tidiness. `platform_default_policy` is a GLOBAL
 * SINGLETON — one row, `id boolean PRIMARY KEY`, no tenant column. Enabling it is a fleet-wide
 * change, so a test that enabled it and committed would hand a policy to every other suite's
 * unassigned NAS and turn their expected `no_policy` rejections into accepts. The failures would
 * land in whichever file happened to run next, which is the worst possible place to debug them.
 * So each case opens a transaction, writes the singleton, asserts, and throws to roll back.
 */
import { describeIntegration, migrateTestDatabase } from '@ecloud/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { AppDeps } from './context.js';
import { PLATFORM_DEFAULT_POLICY_ID, loadPlatformDefaultPolicy } from './policy-data.js';
import { closeDeps, integrationDeps } from './test-support/deps.js';

/** Thrown to roll back; never escapes a test. */
class Rollback extends Error {}

await describeIntegration('@ecloud/api platform default policy loader', () => {
  let deps: AppDeps;
  const ORG = '5e9a1b7c-3d4e-4f50-8a1b-2c3d4e5f6071';

  beforeAll(async () => {
    await migrateTestDatabase();
    deps = integrationDeps();
  }, 60_000);

  afterAll(async () => {
    await closeDeps(deps);
  });

  /**
   * Runs `fn` with the singleton set to `row`, then rolls everything back. Passing `null` leaves
   * the table as it is, which on a fresh database is empty.
   */
  async function withSingleton<T>(
    row: Record<string, unknown> | null,
    fn: (trx: Parameters<typeof loadPlatformDefaultPolicy>[0]) => Promise<T>,
  ): Promise<T> {
    let out: T;
    try {
      await deps.dbPlatform.transaction().execute(async (trx) => {
        if (row !== null) {
          await trx
            .insertInto('platform_default_policy')
            .values({ id: true, ...row })
            .onConflict((oc) => oc.column('id').doUpdateSet(row))
            .execute();
        }
        out = await fn(trx);
        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }
    return out!;
  }

  it('returns null when the row is absent — "not configured" is the same as "off"', async () => {
    // The migration deliberately creates no row. A loader that treated absence as an error, or
    // worse as an empty policy that grants everything, would be the failure this feature has to
    // avoid.
    const intent = await withSingleton(null, (trx) => loadPlatformDefaultPolicy(trx, ORG));
    expect(intent).toBeNull();
  });

  it('returns null when the row exists but is disabled', async () => {
    // The off switch: disabling must restore the previous behaviour without deleting the
    // configured limits, so they survive being turned back on.
    const intent = await withSingleton(
      { enabled: false, description: 'off', download_rate_kbps: 2048 },
      (trx) => loadPlatformDefaultPolicy(trx, ORG),
    );
    expect(intent).toBeNull();
  });

  it('maps an enabled row to a PolicyIntent carrying its limits', async () => {
    const intent = await withSingleton(
      {
        enabled: true,
        description: 'fleet fallback',
        download_rate_kbps: 2048,
        upload_rate_kbps: 1024,
        session_timeout_s: 3600,
        quota_daily_bytes: 1_000_000_000,
      },
      (trx) => loadPlatformDefaultPolicy(trx, ORG),
    );
    expect(intent).not.toBeNull();
    expect(intent).toMatchObject({
      id: PLATFORM_DEFAULT_POLICY_ID,
      organization_id: ORG,
      name: 'Platform default',
      status: 'active',
      download_rate_kbps: 2048,
      upload_rate_kbps: 1024,
      session_timeout_s: 3600,
    });
    // bigint column, so pg hands back a BigInt — the same value `policyRowToIntent` passes
    // through for an ordinary policy, asserted type-agnostically rather than pinned to one form.
    expect(Number(intent?.quota_daily_bytes)).toBe(1_000_000_000);
    // It is a fallback, not a configured assignment: it must never present as an organization
    // default, or an operator reading provenance would think someone chose it.
    expect(intent?.is_default).toBe(false);
    expect(intent?.site_id).toBeNull();
  });

  it('is the organization being resolved for, not an owner', async () => {
    // The row has no owner — it is one row for the whole platform. Stamping the resolving
    // organization keeps any consumer that groups by organization_id from seeing a foreign id.
    const other = '5e9a1b7c-3d4e-4f50-8a1b-2c3d4e5f6072';
    const intent = await withSingleton({ enabled: true, download_rate_kbps: 512 }, (trx) =>
      loadPlatformDefaultPolicy(trx, other),
    );
    expect(intent?.organization_id).toBe(other);
  });
});
