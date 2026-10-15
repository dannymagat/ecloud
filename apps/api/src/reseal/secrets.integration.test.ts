/**
 * The v1 → v2 re-seal (task 10).
 *
 * EVERY CALL IS SCOPED to the organization the case created. `planReseal` and `applyReseal` are
 * FLEET-WIDE by default, which is what the migration is for — but this database is shared and the
 * suites run in parallel, so an unscoped `applyReseal` picks up other files' v1 fixtures, and the
 * first one sealed under a different key fails the whole run with `Unsupported state or unable to
 * authenticate data`. That is correct behaviour for a production migration and wrong for a test:
 * it would make these cases fail for reasons that have nothing to do with the re-seal.
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

    const { counts, dump } = await withPlatform(db(), REASON, (trx) => planReseal(trx, { organizationIds: [t.orgId] }));
    expect(counts).toMatchObject({ nas_rows: 1, nas_v1: 1, nas_v2: 0, portal_rows: 1, portal_v1: 1, portal_v2: 0 });
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

    const result = await withPlatform(db(), REASON, (trx) => applyReseal(trx, key(), { organizationIds: [t.orgId] }));
    expect(result.nas_updated).toBe(1);
    expect(result.portals_updated).toBe(1);

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

  it('is idempotent: a second run has nothing left to do for the rows it sealed', async () => {
    const t = await legacyTenant();
    await withPlatform(db(), REASON, (trx) => applyReseal(trx, key(), { organizationIds: [t.orgId] }));
    const second = await withPlatform(db(), REASON, (trx) => planReseal(trx, { organizationIds: [t.orgId] }));

    // SCOPED TO THIS TENANT'S ROWS, not to the global counts, and the reason is the direction of
    // the error. `planReseal` deliberately has no tenant filter — it is a fleet-wide migration —
    // so any suite running in parallel that creates a legacy v1 fixture lands in those counts.
    // Contamination pushes the count UP, which is the same direction a genuinely missed row
    // pushes it, so `nas_v1 === 0` cannot tell "the CLI left a row behind" from "another file
    // added one". It would be unreliable in exactly the case it exists to catch, and flaky in CI
    // depending on file scheduling. Asserting the absence of THESE ids says the same thing and
    // can only fail for the right reason. Raised by EZECLOUD1, who hit the flake.
    expect(second.dump.nas.some((r) => r.id === t.nasId)).toBe(false);
    expect(second.dump.captive_portals.some((r) => r.id === t.portalId)).toBe(false);
    expect((await readNas(t.nasId)).secret_ref).toMatch(/^enc:v2\./);
    expect((await readPortal(t.portalId)).uam_secret_ref).toMatch(/^enc:v2\./);
  });

  it('restore puts the dumped refs back exactly', async () => {
    const t = await legacyTenant();
    const before = await readNas(t.nasId);
    const beforePortal = await readPortal(t.portalId);

    const { dump } = await withPlatform(db(), REASON, (trx) => applyReseal(trx, key(), { organizationIds: [t.orgId] }));
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
