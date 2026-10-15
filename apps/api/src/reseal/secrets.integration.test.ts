/**
 * The v1 → v2 re-seal (task 10).
 *
 * The fixtures are sealed under the LITERAL old label `'ecloud:nas:secret:v1'`, written out here
 * rather than read from `LEGACY_SECRET_PURPOSE`. That is the whole point: a fixture built from
 * the constants the code under test uses agrees with that code by construction, which is exactly
 * how the first version of this work passed its tests while production could not open a single
 * row. These rows are the shape the database actually holds.
 */
import { withPlatform } from '@ecloud/db';
import { describeIntegration, migrateTestDatabase } from '@ecloud/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { AppDeps } from '../context.js';
import { Envelope, openNasSecret, sealSecretRef } from '../crypto.js';
import { openUamSecret } from '../internal/portal.js';
import { closeDeps, integrationDeps, unique } from '../test-support/deps.js';
import { applyReseal, planReseal, restoreReseal } from './secrets.js';

await describeIntegration('@ecloud/api secret re-seal', () => {
  let deps: AppDeps;
  const REASON = { reason: 'test:reseal', audit: false } as const;
  const db = () => deps.dbPlatform;
  const key = () => deps.config.dataEncryptionKey;

  const NAS_SECRET = 'nas-plaintext-Ab3_-xyzAb3_-xyz'; // check-no-secrets: allow (test value)
  const UAM_SECRET = 'uam-plaintext-Ab3_-xyzAb3_-xyz'; // check-no-secrets: allow (test value)

  beforeAll(async () => {
    await migrateTestDatabase();
    deps = integrationDeps();
  }, 60_000);

  afterAll(async () => {
    await closeDeps(deps);
  });

  /** A tenant whose two secrets are sealed the way the OLD code sealed them. */
  async function legacyTenant(): Promise<{ orgId: string; nasId: string; portalId: string }> {
    // uq_nas_clients_ip is GLOBAL (unique on nas_ip where deleted_at is null) and this suite does
    // not truncate, so addresses accumulate across every run. A /24 gives 253 of them and this
    // file creates four per run — it collided on the second day of use, which is the same trap I
    // flagged in cycle-f and then walked into. 10.200.0.0/13 is ~524k addresses and is disjoint
    // from cycle-f's 10.77/16 and platform-default-portal's 10.120.0.0/13 by construction.
    const r = Math.floor(Math.random() * 0x7ffff);
    const ip = `10.${String(200 + (r >> 16))}.${String((r >> 8) & 0xff)}.${String((r & 0xfd) + 1)}`;
    const legacy = new Envelope(key(), 'ecloud:nas:secret:v1');
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
      const nas = await trx
        .insertInto('nas_clients')
        .values({
          organization_id: org.id,
          site_id: site.id,
          name: unique('NAS'),
          nas_identifier: unique('nas'),
          nas_ip: ip,
          adapter_type_key: 'coovachilli-uam',
          adapter_key: 'coovachilli-uam',
          secret_ref: sealSecretRef(legacy, NAS_SECRET),
          status: 'active',
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      const portal = await trx
        .insertInto('captive_portals')
        .values({
          organization_id: org.id,
          site_id: site.id,
          name: unique('Portal'),
          public_slug: unique('portal'),
          portal_type: 'uspot',
          network_ref: unique('net'),
          uam_secret_ref: sealSecretRef(legacy, UAM_SECRET),
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      return { orgId: org.id, nasId: nas.id, portalId: portal.id };
    });
  }

  const readNas = (id: string) =>
    withPlatform(db(), REASON, (trx) =>
      trx
        .selectFrom('nas_clients')
        .select(['secret_ref', 'secret_version'])
        .where('id', '=', id)
        .executeTakeFirstOrThrow(),
    );

  const readPortal = (id: string) =>
    withPlatform(db(), REASON, (trx) =>
      trx
        .selectFrom('captive_portals')
        .select(['uam_secret_ref', 'uam_secret_version'])
        .where('id', '=', id)
        .executeTakeFirstOrThrow(),
    );

  it('dry run counts the v1 rows and changes nothing', async () => {
    const t = await legacyTenant();
    const before = await readNas(t.nasId);
    const beforePortal = await readPortal(t.portalId);

    const { counts, dump } = await withPlatform(db(), REASON, (trx) => planReseal(trx));
    expect(counts.nas_v1).toBeGreaterThanOrEqual(1);
    expect(counts.portal_v1).toBeGreaterThanOrEqual(1);
    // The dump carries only what a run would change, and it is the rollback.
    expect(dump.nas.some((r) => r.id === t.nasId)).toBe(true);
    expect(dump.captive_portals.some((r) => r.id === t.portalId)).toBe(true);
    expect(dump.nas.find((r) => r.id === t.nasId)).toMatchObject({
      secret_ref: before.secret_ref,
      secret_version: Number(before.secret_version),
    });

    // Reads only.
    expect(await readNas(t.nasId)).toEqual(before);
    expect(await readPortal(t.portalId)).toEqual(beforePortal);
  });

  it('re-seals both columns to v2 at the SAME version, preserving the plaintext', async () => {
    const t = await legacyTenant();
    const before = await readNas(t.nasId);
    expect(before.secret_ref).toMatch(/^enc:v1\./);

    const result = await withPlatform(db(), REASON, (trx) => applyReseal(trx, key()));
    expect(result.nas_updated).toBeGreaterThanOrEqual(1);
    expect(result.portals_updated).toBeGreaterThanOrEqual(1);

    const after = await readNas(t.nasId);
    expect(after.secret_ref).toMatch(/^enc:v2\./);
    // NOT bumped: a re-seal preserves the plaintext, so recording a rotation would be a lie, and
    // the version is bound into the ciphertext so the two must agree.
    expect(Number(after.secret_version)).toBe(Number(before.secret_version));
    // The whole purpose: it opens, bound to this row, and the plaintext is unchanged.
    expect(
      openNasSecret(key(), String(after.secret_ref), {
        organizationId: t.orgId,
        nasId: t.nasId,
        secretVersion: Number(after.secret_version),
      }),
    ).toBe(NAS_SECRET);

    const portal = await readPortal(t.portalId);
    expect(portal.uam_secret_ref).toMatch(/^enc:v2\./);
    expect(
      openUamSecret(deps, String(portal.uam_secret_ref), {
        organizationId: t.orgId,
        portalId: t.portalId,
        secretVersion: Number(portal.uam_secret_version),
      }),
    ).toBe(UAM_SECRET);

    // Bound, not merely re-encrypted: the new ciphertext must not open against another row.
    expect(() =>
      openNasSecret(key(), String(after.secret_ref), {
        organizationId: t.orgId,
        nasId: t.portalId,
        secretVersion: Number(after.secret_version),
      }),
    ).toThrow();
  });

  it('is idempotent: a second run finds nothing left to do', async () => {
    await legacyTenant();
    await withPlatform(db(), REASON, (trx) => applyReseal(trx, key()));
    const second = await withPlatform(db(), REASON, (trx) => planReseal(trx));
    expect(second.counts.nas_v1).toBe(0);
    expect(second.counts.portal_v1).toBe(0);
    expect(second.dump.nas).toEqual([]);
  });

  it('restore puts the dumped refs back exactly', async () => {
    const t = await legacyTenant();
    const before = await readNas(t.nasId);
    const beforePortal = await readPortal(t.portalId);

    const { dump } = await withPlatform(db(), REASON, (trx) => applyReseal(trx, key()));
    expect((await readNas(t.nasId)).secret_ref).toMatch(/^enc:v2\./);

    await withPlatform(db(), REASON, (trx) => restoreReseal(trx, dump));
    // Byte-identical, because the rollback writes what it was given rather than re-deriving it.
    expect(await readNas(t.nasId)).toEqual(before);
    expect(await readPortal(t.portalId)).toEqual(beforePortal);
    // And the restored v1 ref still opens, so a rollback leaves a working estate.
    expect(
      openNasSecret(key(), String(before.secret_ref), {
        organizationId: t.orgId,
        nasId: t.nasId,
        secretVersion: Number(before.secret_version),
      }),
    ).toBe(NAS_SECRET);
  });
});
