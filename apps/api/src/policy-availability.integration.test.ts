/**
 * `policyAvailabilityForSites` (docs/NAS_PENDING_GAP_ANALYSIS.md).
 *
 * The case worth the whole file is the organization default: a tenant with ZERO assignments and
 * one `is_default` policy resolves fine, because `rankCandidates` injects it at the
 * organization_default layer. A helper that tested assignments alone would report `missing` for
 * a working tenant — the loudest possible wrong answer, and the one a second implementation of
 * this question would most likely give.
 */
import { withPlatform } from '@ecloud/db';
import { newId } from '@ecloud/shared';
import { describeIntegration, migrateTestDatabase } from '@ecloud/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { AppDeps } from './context.js';
import { closeDeps, integrationDeps, unique } from './test-support/deps.js';
import { policyAvailabilityForSites } from './policy-availability.js';

await describeIntegration('@ecloud/api policy availability', () => {
  let deps: AppDeps;
  const REASON = { reason: 'test:policy-availability', audit: false } as const;
  const db = () => deps.dbPlatform;

  beforeAll(async () => {
    await migrateTestDatabase();
    deps = integrationDeps();
  }, 60_000);

  afterAll(async () => {
    await closeDeps(deps);
  });

  /** One organization, one site, nothing else. The starting point for every case below. */
  async function tenant(): Promise<{ orgId: string; siteId: string }> {
    return withPlatform(db(), REASON, async (trx) => {
      const org = await trx
        .insertInto('organizations')
        .values({ name: unique('Org'), slug: unique('org'), status: 'active' })
        .returning('id')
        .executeTakeFirstOrThrow();
      const site = await trx
        .insertInto('sites')
        .values({
          organization_id: org.id,
          name: unique('Site'),
          slug: unique('site'),
          timezone: 'UTC',
          status: 'active',
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      return { orgId: org.id, siteId: site.id };
    });
  }

  async function policy(
    orgId: string,
    over: Record<string, unknown> = {},
  ): Promise<string> {
    return withPlatform(db(), REASON, async (trx) => {
      const row = await trx
        .insertInto('policies')
        .values({
          organization_id: orgId,
          name: unique('Policy'),
          scope_type: 'site',
          status: 'active',
          download_rate_kbps: 1000,
          ...over,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      return row.id;
    });
  }

  const availability = (siteId: string, now = new Date()) =>
    withPlatform(db(), REASON, async (trx) =>
      (await policyAvailabilityForSites(trx, [siteId], now)).get(siteId),
    );

  it('reports missing when nothing is assigned and the platform default is off', async () => {
    const { siteId } = await tenant();
    expect(await availability(siteId)).toBe('missing');
  });

  it('reports assigned for an organization default with NO assignments at all', async () => {
    // The EZELINK shape, and the one a naive implementation gets wrong.
    const { orgId, siteId } = await tenant();
    await policy(orgId, { is_default: true });
    expect(await availability(siteId)).toBe('assigned');
  });

  it('ignores an organization default that is retired, deleted or out of its window', async () => {
    const { orgId, siteId } = await tenant();
    await policy(orgId, { is_default: true, status: 'retired' });
    expect(await availability(siteId)).toBe('missing');

    const { orgId: o2, siteId: s2 } = await tenant();
    await policy(o2, { is_default: true, valid_until: new Date(Date.now() - 60_000) });
    expect(await availability(s2)).toBe('missing');
  });

  it('reports assigned for a site-targeted assignment on this site only', async () => {
    const { orgId, siteId } = await tenant();
    const other = await tenant();
    const policyId = await policy(orgId);
    await withPlatform(db(), REASON, async (trx) => {
      await trx
        .insertInto('policy_assignments')
        .values({
          organization_id: orgId,
          policy_id: policyId,
          target_type: 'site',
          site_id: siteId,
        })
        .execute();
    });
    expect(await availability(siteId)).toBe('assigned');
    // A different organization's site is untouched by it.
    expect(await availability(other.siteId)).toBe('missing');
  });

  it('ignores an assignment whose window has closed', async () => {
    const { orgId, siteId } = await tenant();
    const policyId = await policy(orgId);
    await withPlatform(db(), REASON, async (trx) => {
      await trx
        .insertInto('policy_assignments')
        .values({
          organization_id: orgId,
          policy_id: policyId,
          target_type: 'site',
          site_id: siteId,
          // ck_policy_assignments_window requires until > from, so the whole window is past.
          effective_from: new Date(Date.now() - 120_000),
          effective_until: new Date(Date.now() - 60_000),
        })
        .execute();
    });
    // An expired assignment still sits in the table; the engine filters it and so must this.
    expect(await availability(siteId)).toBe('missing');
  });

  it('ignores an assignment whose policy was retired after the fact', async () => {
    const { orgId, siteId } = await tenant();
    const policyId = await policy(orgId, { status: 'retired' });
    await withPlatform(db(), REASON, async (trx) => {
      await trx
        .insertInto('policy_assignments')
        .values({
          organization_id: orgId,
          policy_id: policyId,
          target_type: 'site',
          site_id: siteId,
        })
        .execute();
    });
    expect(await availability(siteId)).toBe('missing');
  });

  it('answers every site in one call, and an unknown id is simply absent', async () => {
    const a = await tenant();
    const b = await tenant();
    await policy(b.orgId, { is_default: true });
    const map = await withPlatform(db(), REASON, (trx) =>
      policyAvailabilityForSites(trx, [a.siteId, b.siteId, newId()], new Date()),
    );
    expect(map.get(a.siteId)).toBe('missing');
    expect(map.get(b.siteId)).toBe('assigned');
    expect(map.size).toBe(2);
  });

  it('returns an empty map for an empty list without touching the database', async () => {
    const map = await withPlatform(db(), REASON, (trx) =>
      policyAvailabilityForSites(trx, [], new Date()),
    );
    expect(map.size).toBe(0);
  });
});
