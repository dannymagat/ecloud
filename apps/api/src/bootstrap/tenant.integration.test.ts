/**
 * Tenant bootstrap against the real schema. Skipped without the dev stack
 * (ECLOUD_TEST_DATABASE_URL).
 *
 * The first case is the production failure of 2026-10-15: a NAS identifier that exists on one
 * LIVE row and on one NEWER soft-deleted row. The reconcile query ordered by created_at alone,
 * chose the newer deleted row, revived it onto the live row's address, and the whole bootstrap
 * rolled back on uq_nas_clients_ip. A live row must win, so the bootstrap reconciles it in
 * place and the deleted row stays deleted.
 */
import { hashPassword } from '@ecloud/db';
import { newId } from '@ecloud/shared';
import {
  PLACEHOLDER_NAS_SECRET_REF,
  describeIntegration,
  makeOrganization,
  migrateTestDatabase,
} from '@ecloud/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { AppDeps } from '../context.js';
import { closeDeps, integrationDeps, unique } from '../test-support/deps.js';
import { openNasSecret } from '../crypto.js';
import { bootstrapTenant, type BootstrapInput } from './tenant.js';

await describeIntegration('tenant bootstrap', () => {
  let deps: AppDeps;
  let passwordHash: string;

  beforeAll(async () => {
    await migrateTestDatabase();
    deps = integrationDeps();
    passwordHash = await hashPassword('fixture-password-not-secret');
  }, 60_000);

  afterAll(async () => {
    await closeDeps(deps);
  });

  // A fresh /32 per call. The test database is shared across runs and nas_ip is unique among
  // live rows, so a fixed address would collide with this test's own earlier runs.
  let ipCounter = Math.floor(Math.random() * 60_000);
  function uniqueIp(): string {
    ipCounter += 1;
    return `10.${String(200 + (ipCounter >> 16) % 50)}.${String((ipCounter >> 8) & 255)}.${String(ipCounter & 255)}/32`;
  }

  function input(organizationId: string, nasIdentifier: string, nasIp: string): BootstrapInput {
    const n = unique('bs');
    return {
      organizationId,
      siteName: `Site ${n}`,
      siteSlug: n,
      timezone: 'UTC',
      nasName: `NAS ${n}`,
      nasIdentifier,
      nasIp,
      adapterKey: 'openwifi-uspot-uam',
      radiusSecret: 'fixture-radius-secret',
      uamSecret: 'fixture-uam-secret',
      secretsArePlatformDefaults: false,
      portalName: `Portal ${n}`,
      portalSlug: `portal-${n}`,
      networkRef: 'default',
      walledGarden: ['portal.example.test'],
      policyName: `Policy ${n}`,
      downloadKbps: 10_000,
      uploadKbps: 10_000,
      username: `user-${n}`,
      passwordHash,
      userValidDays: 1,
      dataEncryptionKey: deps.config.dataEncryptionKey,
      now: new Date(),
    };
  }

  it('reconciles the LIVE row when a newer soft-deleted row shares the identifier', async () => {
    const db = deps.dbPlatform;
    const org = makeOrganization({ slug: unique('org'), name: unique('Org') });
    await db.insertInto('organizations').values(org).execute();
    const siteId = newId();
    await db
      .insertInto('sites')
      .values({ id: siteId, organization_id: org.id, slug: unique('site'), name: 'Seed', timezone: 'UTC', status: 'active', settings: {} })
      .execute();

    const ident = `aa${unique('id').replace(/[^a-z0-9]/g, '').slice(0, 10)}`;
    const ip = uniqueIp();
    const liveId = newId();
    const deletedId = newId();
    // Older row: live, already on the address the bootstrap will ask for.
    await db
      .insertInto('nas_clients')
      .values({
        id: liveId, organization_id: org.id, site_id: siteId, name: 'live', nas_identifier: ident, nas_ip: ip,
        adapter_type_key: 'openwifi-uspot-uam', adapter_key: 'openwifi-uspot-uam', secret_ref: PLACEHOLDER_NAS_SECRET_REF, status: 'active',
      })
      .execute();
    // Newer row: same identifier, soft-deleted, on a different address.
    await db
      .insertInto('nas_clients')
      .values({
        id: deletedId, organization_id: org.id, site_id: siteId, name: 'deleted', nas_identifier: ident, nas_ip: uniqueIp(),
        adapter_type_key: 'uspot-upstream-uam', adapter_key: 'uspot-upstream-uam', secret_ref: PLACEHOLDER_NAS_SECRET_REF, status: 'active',
        deleted_at: new Date(),
      })
      .execute();

    const steps = await db.transaction().execute((trx) => bootstrapTenant(trx, input(org.id, ident, ip)));

    const nasStep = steps.find((s) => s.entity === 'nas_client');
    expect(nasStep).toMatchObject({ id: liveId, created: false });

    const rows = await db
      .selectFrom('nas_clients')
      .select(['id', 'deleted_at', 'secret_ref', 'secret_version'])
      .where('organization_id', '=', org.id)
      .where('nas_identifier', '=', ident)
      .execute();
    const live = rows.filter((r) => r.deleted_at === null);
    expect(live.map((r) => r.id)).toEqual([liveId]);
    // Task 10: the reconcile seals v2 against the LIVE row it actually wrote, and raises the
    // version because bootstrap cannot tell whether the environment's secret differs from the
    // one already in the row. Opening it with that row's own binding is the assertion that
    // matters: a ciphertext bound to the soft-deleted row's id would fail here.
    expect(live[0]?.secret_ref).toMatch(/^enc:v2\./);
    expect(Number(live[0]?.secret_version)).toBe(2);
    expect(
      openNasSecret(deps.config.dataEncryptionKey, String(live[0]?.secret_ref), {
        organizationId: org.id,
        nasId: liveId,
        secretVersion: 2,
      }),
    ).toBe('fixture-radius-secret');
    expect(rows.find((r) => r.id === deletedId)?.deleted_at).not.toBeNull();
  });

  it('reconciles the LIVE site when a newer soft-deleted site shares the name', async () => {
    // The same defect as the NAS one, in the site query, and production is set up to trigger it:
    // the live EZELINK-HQ carries slug `ezelink123` while a DELETED row holds `ezelink-hq`.
    const db = deps.dbPlatform;
    const org = makeOrganization({ slug: unique('org'), name: unique('Org') });
    await db.insertInto('organizations').values(org).execute();
    const name = unique('Site');
    const liveId = newId();
    const deletedId = newId();
    await db
      .insertInto('sites')
      .values({ id: liveId, organization_id: org.id, slug: unique('live'), name, timezone: 'UTC', status: 'active', settings: {} })
      .execute();
    await db
      .insertInto('sites')
      .values({ id: deletedId, organization_id: org.id, slug: unique('dead'), name, timezone: 'UTC', status: 'active', settings: {}, deleted_at: new Date() })
      .execute();

    const ident = `bb${unique('id').replace(/[^a-z0-9]/g, '').slice(0, 10)}`;
    const base = input(org.id, ident, uniqueIp());
    const steps = await db
      .transaction()
      .execute((trx) => bootstrapTenant(trx, { ...base, siteName: name }));

    expect(steps.find((s) => s.entity === 'site')).toMatchObject({ id: liveId, created: false });
    const rows = await db
      .selectFrom('sites')
      .select(['id', 'deleted_at'])
      .where('organization_id', '=', org.id)
      .where('name', '=', name)
      .execute();
    expect(rows.filter((r) => r.deleted_at === null).map((r) => r.id)).toEqual([liveId]);
  });

  it('reconciles the LIVE user when a newer soft-deleted user shares the username', async () => {
    const db = deps.dbPlatform;
    const org = makeOrganization({ slug: unique('org'), name: unique('Org') });
    await db.insertInto('organizations').values(org).execute();
    const siteId = newId();
    await db
      .insertInto('sites')
      .values({ id: siteId, organization_id: org.id, slug: unique('site'), name: 'Seed', timezone: 'UTC', status: 'active', settings: {} })
      .execute();
    const username = unique('user').toLowerCase().replace(/[^a-z0-9-]/g, '');
    const liveId = newId();
    await db
      .insertInto('users')
      .values({ id: liveId, organization_id: org.id, site_id: siteId, username, password_hash: 'x', auth_methods: ['password'], status: 'active', origin: 'admin' })
      .execute();
    await db
      .insertInto('users')
      .values({ id: newId(), organization_id: org.id, site_id: siteId, username, password_hash: 'x', auth_methods: ['password'], status: 'active', origin: 'admin', deleted_at: new Date() })
      .execute();

    const ident = `cc${unique('id').replace(/[^a-z0-9]/g, '').slice(0, 10)}`;
    const base = input(org.id, ident, uniqueIp());
    const steps = await db
      .transaction()
      .execute((trx) => bootstrapTenant(trx, { ...base, username }));

    expect(steps.find((s) => s.entity === 'user')).toMatchObject({ id: liveId, created: false });
    const live = await db
      .selectFrom('users')
      .select(['id'])
      .where('organization_id', '=', org.id)
      .where('username', '=', username)
      .where('deleted_at', 'is', null)
      .execute();
    expect(live.map((r) => r.id)).toEqual([liveId]);
  });

  it('is idempotent: a second run creates nothing and keeps one live NAS', async () => {
    const db = deps.dbPlatform;
    const org = makeOrganization({ slug: unique('org'), name: unique('Org') });
    await db.insertInto('organizations').values(org).execute();
    const ident = `bb${unique('id').replace(/[^a-z0-9]/g, '').slice(0, 10)}`;
    const inp = input(org.id, ident, uniqueIp());

    const first = await db.transaction().execute((trx) => bootstrapTenant(trx, inp));
    const second = await db.transaction().execute((trx) => bootstrapTenant(trx, inp));

    expect(first.some((s) => s.entity === 'nas_client' && s.created)).toBe(true);
    expect(second.filter((s) => s.created)).toEqual([]);
    const live = await db
      .selectFrom('nas_clients')
      .select('id')
      .where('organization_id', '=', org.id)
      .where('nas_identifier', '=', ident)
      .where('deleted_at', 'is', null)
      .execute();
    expect(live).toHaveLength(1);
  });
});
