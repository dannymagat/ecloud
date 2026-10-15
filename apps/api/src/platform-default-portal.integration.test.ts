/**
 * Migration 041: the platform-default captive portal, against `ecloud_test`.
 *
 * `ensurePlatformDefaultPortal` is tested directly rather than through a device redirect because
 * what it guarantees is database behaviour — create-once, publish-in-the-same-transaction, and
 * three refusals that each stop the fallback from admitting guests where it must not. Driving a
 * vendor redirect would exercise the adapter, not these rules.
 *
 * Note which gateway families the fallback can actually serve: `openwifi-uspot-uam`,
 * `uspot-upstream-uam` and `coovachilli-uam` declare `requireSecret: true`, so an unsigned
 * redirect is refused (SECURITY §5.2) and a fallback portal — which has no UAM secret, because
 * the device's secret is not knowable from here — cannot complete their hand-off. MikroTik,
 * Meraki and the post-back families do not require one.
 */
import { randomInt } from 'node:crypto';
import { newId } from '@ecloud/shared';
import { withTenant } from '@ecloud/db';
import { describeIntegration, migrateTestDatabase } from '@ecloud/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { AppDeps } from './context.js';
import { createLogger } from '@ecloud/shared';
import {
  PLATFORM_DEFAULT_PORTAL_NAME,
  ensurePlatformDefaultPortal,
  resolveExternalPortalId,
  resolvePortal,
} from './internal/portal.js';
import { PORTAL_COLUMNS, type PortalRow } from './internal/portal-row.js';
import { readSnapshot } from './internal/portal-snapshot.js';
import { closeDeps, createTenant, integrationDeps, unique } from './test-support/deps.js';

await describeIntegration('@ecloud/api platform-default portal (migration 041)', () => {
  let deps: AppDeps;

  beforeAll(async () => {
    await migrateTestDatabase();
    deps = integrationDeps();
  }, 60_000);

  afterAll(async () => {
    await closeDeps(deps);
  });

  async function tenant() {
    return await createTenant(deps.dbPlatform);
  }

  const ensure = (orgId: string, siteId: string) =>
    withTenant(deps.db, orgId, (trx) =>
      ensurePlatformDefaultPortal(trx, { organization_id: orgId, site_id: siteId }, 'mikrotik'),
    );

  it('creates a published click-through portal for a site that has none', async () => {
    const { orgId, siteId } = await tenant();
    const created = await ensure(orgId, siteId);
    expect(created).toBeDefined();
    expect(created?.is_platform_default).toBe(true);
    expect(created?.name).toBe(PLATFORM_DEFAULT_PORTAL_NAME);
    expect(created?.auth_methods).toEqual(['click_through']);
    // Published in the same transaction as the insert: the row can never exist in the
    // draft-only state, which would serve guests nothing and defeat the feature.
    expect(created?.published_version_id).not.toBeNull();

    const version = await deps.dbPlatform
      .selectFrom('portal_versions')
      .select(['snapshot', 'version', 'published_by'])
      .where('id', '=', created?.published_version_id ?? '')
      .executeTakeFirstOrThrow();
    expect(version.version).toBe(1);
    // No administrator published it, and the row says so rather than attributing it to someone.
    expect(version.published_by).toBeNull();
    const snapshot = readSnapshot(version.snapshot);
    expect(snapshot?.template_key).toBe('quick_connect');
    expect(snapshot?.methods).toEqual(['click_through']);
    // Explicit, so the page keeps offering exactly one button whatever joins the registry later.
    expect(snapshot?.method_order).toEqual(['click_through']);
    expect(snapshot?.terms_version).toBeNull();
  });

  it('creates at most one per site and portal type, and returns the same row again', async () => {
    const { orgId, siteId } = await tenant();
    const first = await ensure(orgId, siteId);
    const second = await ensure(orgId, siteId);
    expect(second?.id).toBe(first?.id);
    const count = await deps.dbPlatform
      .selectFrom('captive_portals')
      .select(['id'])
      .where('site_id', '=', siteId)
      .where('is_platform_default', '=', true)
      .execute();
    expect(count).toHaveLength(1);
  });

  it('refuses to serve a platform default an operator disabled, and does not recreate it', async () => {
    const { orgId, siteId } = await tenant();
    const created = await ensure(orgId, siteId);
    await deps.dbPlatform
      .updateTable('captive_portals')
      .set({ status: 'disabled' })
      .where('id', '=', created?.id ?? '')
      .execute();

    // Disabling the fallback row is the operator's only way to switch this feature off for a
    // site. It must therefore stay off: not served, and not quietly recreated beside itself.
    expect(await ensure(orgId, siteId)).toBeUndefined();
    const rows = await deps.dbPlatform
      .selectFrom('captive_portals')
      .select(['id', 'status'])
      .where('site_id', '=', siteId)
      .where('is_platform_default', '=', true)
      .execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('disabled');
  });

  it('refuses to create a fallback for a site whose configured portal is disabled', async () => {
    const { orgId, siteId } = await tenant();
    await deps.dbPlatform
      .insertInto('captive_portals')
      .values({
        organization_id: orgId,
        site_id: siteId,
        name: 'Guest Wi-Fi',
        public_slug: unique('p').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 60),
        portal_type: 'mikrotik',
        network_ref: 'hotspot1',
        auth_methods: ['password'],
        // The operator took this site's guest access offline on purpose.
        status: 'disabled',
      })
      .execute();

    // Turning "offline" into "open to anyone" would be the worst possible reading of the
    // operator's intent, so the presence of a configured portal blocks the fallback whatever
    // its status.
    expect(await ensure(orgId, siteId)).toBeUndefined();
    const defaults = await deps.dbPlatform
      .selectFrom('captive_portals')
      .select(['id'])
      .where('site_id', '=', siteId)
      .where('is_platform_default', '=', true)
      .execute();
    expect(defaults).toEqual([]);
  });

  it('does not create a fallback beside an active configured portal', async () => {
    const { orgId, siteId } = await tenant();
    await deps.dbPlatform
      .insertInto('captive_portals')
      .values({
        organization_id: orgId,
        site_id: siteId,
        name: 'Guest Wi-Fi',
        public_slug: unique('p').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 60),
        portal_type: 'mikrotik',
        network_ref: 'hotspot1',
        auth_methods: ['password'],
      })
      .execute();
    expect(await ensure(orgId, siteId)).toBeUndefined();
  });

  it('keeps fallbacks of different portal types separate', async () => {
    const { orgId, siteId } = await tenant();
    const mikrotik = await ensure(orgId, siteId);
    const external = await withTenant(deps.db, orgId, (trx) =>
      ensurePlatformDefaultPortal(
        trx,
        { organization_id: orgId, site_id: siteId },
        'external',
      ),
    );
    expect(external?.id).not.toBe(mikrotik?.id);
    // `network_ref` is unique per site, so the portal type has to be part of it.
    expect(external?.is_platform_default).toBe(true);
  });

  // -------------------------------------------------------------------------------------------
  // The serving path. These go through `resolvePortal` rather than `ensurePlatformDefaultPortal`
  // because the fail-open this covers was in the WIRING, not the rule: the "a configured portal
  // blocks the fallback" check existed on the creation path, and once a fallback row existed
  // `pickPortal` returned it directly so the creation path never ran.
  // -------------------------------------------------------------------------------------------

  const logger = createLogger({ name: 'test', level: 'silent' });

  // `uq_nas_clients_ip` is GLOBAL (`unique(nas_ip) where deleted_at is null`), not per-tenant,
  // and these suites do not truncate — so a hardcoded address is a time bomb rather than a flake:
  // the first aborted run that leaves a row behind poisons it permanently with a 409.
  //
  // Randomised, and deliberately DISJOINT from other suites rather than merely unlikely to
  // collide. `cycle-f.integration.test.ts` randomises inside 10.77.0.0/16, and an earlier version
  // of this range spanned second octets 77 to 116, so the two shared 10.77/16 — a low per-insert
  // probability, but cumulative across runs because nothing clears the rows. 10.120.0.0/13 has no
  // other fixture in it; keep it that way rather than widening this back over 10.77.
  const randomNasIp = () =>
    `10.${String(120 + randomInt(0, 8))}.${String(randomInt(0, 256))}.${String(randomInt(1, 255))}`;

  async function nas(orgId: string, siteId: string) {
    const identifier = unique('mt');
    await deps.dbPlatform
      .insertInto('nas_clients')
      .values({
        organization_id: orgId,
        site_id: siteId,
        name: 'MikroTik hEX',
        nas_identifier: identifier,
        nas_ip: randomNasIp(),
        adapter_type_key: 'mikrotik-hotspot',
        adapter_key: 'mikrotik-hotspot',
        deployment_mode: 'gateway',
        secret_ref: 'enc:placeholder',
        hotspot_address: '10.5.50.1',
      })
      .execute();
    return identifier;
  }

  const resolve = async (nasid: string) => {
    const r = await resolvePortal(deps, 'mikrotik', { nasid, apMac: null }, logger);
    return r.ok ? r.portal : null;
  };
  /** The refusal reason, for the assertions that care WHY rather than that it refused. */
  const resolveReason = async (nasid: string) => {
    const r = await resolvePortal(deps, 'mikrotik', { nasid, apMac: null }, logger);
    return r.ok ? null : r.reason;
  };

  async function configuredPortal(orgId: string, siteId: string, status: 'active' | 'disabled') {
    const row = await deps.dbPlatform
      .insertInto('captive_portals')
      .values({
        organization_id: orgId,
        site_id: siteId,
        name: 'Guest Wi-Fi',
        public_slug: unique('p').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 60),
        portal_type: 'mikrotik',
        network_ref: 'hotspot1',
        auth_methods: ['click_through'],
        status,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  }

  it('serves a freshly created fallback to a NAS whose site has no portal', async () => {
    const { orgId, siteId } = await tenant();
    const identifier = await nas(orgId, siteId);
    const resolved = await resolve(identifier);
    expect(resolved).not.toBeNull();
    const portal = await deps.dbPlatform
      .selectFrom('captive_portals')
      .select(['is_platform_default', 'published_version_id'])
      .where('id', '=', resolved?.captivePortalId ?? '')
      .executeTakeFirstOrThrow();
    expect(portal.is_platform_default).toBe(true);
    expect(portal.published_version_id).not.toBeNull();
  });

  it('prefers the configured portal over an existing fallback', async () => {
    const { orgId, siteId } = await tenant();
    const identifier = await nas(orgId, siteId);
    // The fallback is created first, as it would be during bring-up.
    await resolve(identifier);
    const configured = await configuredPortal(orgId, siteId, 'active');
    expect((await resolve(identifier))?.captivePortalId).toBe(configured);
  });

  it('refuses rather than falling back when the configured portal is disabled', async () => {
    const { orgId, siteId } = await tenant();
    const identifier = await nas(orgId, siteId);
    // Bring-up created a fallback; the operator then built a real portal and later disabled it
    // to take the site's guest access offline.
    await resolve(identifier);
    const configured = await configuredPortal(orgId, siteId, 'active');
    expect((await resolve(identifier))?.captivePortalId).toBe(configured);
    await deps.dbPlatform
      .updateTable('captive_portals')
      .set({ status: 'disabled' })
      .where('id', '=', configured)
      .execute();

    // "Offline" must stay offline. Before this check the leftover fallback row was served here,
    // silently reopening the site as an anonymous click-through portal.
    expect(await resolve(identifier)).toBeNull();
    // ...and it says WHY. `no_portal` sends an operator to the portal they disabled;
    // `unknown_nas`, which this used to report, sent them to the NAS registration instead.
    expect(await resolveReason(identifier)).toBe('no_portal');
  });

  it('names a deleted site as tenant_inactive, not as an unknown NAS', async () => {
    const { orgId, siteId } = await tenant();
    const identifier = await nas(orgId, siteId);
    await configuredPortal(orgId, siteId, 'active');
    expect(await resolveReason(identifier)).toBeNull();
    await deps.dbPlatform
      .updateTable('sites')
      .set({ deleted_at: new Date() })
      .where('id', '=', siteId)
      .execute();
    // 2026-10-14: this reported `unknown_nas` and cost most of a day in the NAS registration
    // and its shared secret, both of which were correct the whole time.
    expect(await resolveReason(identifier)).toBe('tenant_inactive');
  });

  it('names an adapter the flavour does not serve as adapter_mismatch', async () => {
    const { orgId, siteId } = await tenant();
    const identifier = await nas(orgId, siteId);
    await configuredPortal(orgId, siteId, 'active');
    expect(await resolveReason(identifier)).toBeNull();
    // The third condition that arrived as `unknown_nas` in one day: a NAS recreated with a
    // sibling adapter the flavour's key list does not include.
    await deps.dbPlatform
      .updateTable('nas_clients')
      .set({ adapter_key: 'openwifi-uspot-uam', adapter_type_key: 'openwifi-uspot-uam' })
      .where('nas_identifier', '=', identifier)
      .where('deleted_at', 'is', null)
      .execute();
    expect(await resolveReason(identifier)).toBe('adapter_mismatch');
  });

  it('refuses rather than falling back when two configured portals match', async () => {
    const { orgId, siteId } = await tenant();
    const identifier = await nas(orgId, siteId);
    await configuredPortal(orgId, siteId, 'active');
    await deps.dbPlatform
      .insertInto('captive_portals')
      .values({
        organization_id: orgId,
        site_id: siteId,
        name: 'Second',
        public_slug: unique('p2').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 60),
        portal_type: 'mikrotik',
        network_ref: 'hotspot2',
        auth_methods: ['click_through'],
      })
      .execute();
    // Ambiguity among portals an operator configured is a misconfiguration to fix, never a
    // reason to admit guests anonymously.
    expect(await resolve(identifier)).toBeNull();
    const defaults = await deps.dbPlatform
      .selectFrom('captive_portals')
      .select(['id'])
      .where('site_id', '=', siteId)
      .where('is_platform_default', '=', true)
      .execute();
    expect(defaults).toEqual([]);
  });

  // -------------------------------------------------------------------------------------------
  // The post-back path (Cycle C). Its own resolution helper used to bypass these rules entirely,
  // and the query behind it did not select `is_platform_default`, so `!r.is_platform_default` was
  // `!undefined` for every row and the exclusion inside `pickPortal` silently did nothing. Both
  // halves are tested: the fallback must not be served, and it must not make a real portal
  // ambiguous either. `MERAKI_PORTAL_TYPE` is `'external'`, so a Meraki NAS creates exactly the
  // `external` fallback that collides with post-back resolution at the same site — this is a
  // reachable production path, not a hypothetical one.
  // -------------------------------------------------------------------------------------------

  const resolveExternal = (
    orgId: string,
    nasRow: { id: string; organization_id: string; site_id: string },
    rows: PortalRow[],
  ) =>
    withTenant(deps.db, orgId, (trx) =>
      resolveExternalPortalId(deps)(trx, nasRow, rows, logger),
    );

  async function externalRows(orgId: string, siteId: string) {
    const rows = await deps.dbPlatform
      .selectFrom('captive_portals')
      .select([...PORTAL_COLUMNS])
      .where('site_id', '=', siteId)
      .where('organization_id', '=', orgId)
      .where('status', '=', 'active')
      .where('portal_type', '=', 'external')
      .execute();
    return rows;
  }

  async function externalFallback(orgId: string, siteId: string) {
    return await withTenant(deps.db, orgId, (trx) =>
      ensurePlatformDefaultPortal(trx, { organization_id: orgId, site_id: siteId }, 'external'),
    );
  }

  async function externalConfigured(
    orgId: string,
    siteId: string,
    status: 'active' | 'disabled',
    networkRef = 'ext1',
  ) {
    const row = await deps.dbPlatform
      .insertInto('captive_portals')
      .values({
        organization_id: orgId,
        site_id: siteId,
        name: 'Controller portal',
        public_slug: unique('x').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 60),
        portal_type: 'external',
        network_ref: networkRef,
        auth_methods: ['click_through'],
        status,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  }

  it('post-back: never serves a platform default, even when it is the only external portal', async () => {
    const { orgId, siteId } = await tenant();
    const nasRow = { id: newId(), organization_id: orgId, site_id: siteId };
    const fallback = await externalFallback(orgId, siteId);
    expect(fallback).toBeDefined();
    const rows = await externalRows(orgId, siteId);
    expect(rows.some((r) => r.is_platform_default)).toBe(true);
    // A post-back hand-off needs a vendor profile and a validated login URL that a fallback does
    // not have, so absence fails closed here rather than inventing a portal.
    expect(await resolveExternal(orgId, nasRow, rows)).toBeNull();
  });

  it('post-back: a platform default does not make the real portal ambiguous', async () => {
    const { orgId, siteId } = await tenant();
    const nasRow = { id: newId(), organization_id: orgId, site_id: siteId };
    // The fallback is created first, as a Meraki NAS at this site would create it.
    await externalFallback(orgId, siteId);
    const configured = await externalConfigured(orgId, siteId, 'active');
    const rows = await externalRows(orgId, siteId);
    expect(rows).toHaveLength(2);
    // Before the fix this answered null: two unpinned rows read as ambiguous because the
    // fallback was not excluded, taking a working post-back site offline.
    expect(await resolveExternal(orgId, nasRow, rows)).toBe(configured);
  });

  it('post-back: a disabled configured portal is not overridden by the fallback', async () => {
    const { orgId, siteId } = await tenant();
    const nasRow = { id: newId(), organization_id: orgId, site_id: siteId };
    await externalFallback(orgId, siteId);
    const configured = await externalConfigured(orgId, siteId, 'active');
    expect(await resolveExternal(orgId, nasRow, await externalRows(orgId, siteId))).toBe(
      configured,
    );
    await deps.dbPlatform
      .updateTable('captive_portals')
      .set({ status: 'disabled' })
      .where('id', '=', configured)
      .execute();
    // The owner ruled that a NAS with nothing assigned gets a default. He did not rule that a
    // deliberate decision to disable a portal gets overridden.
    expect(await resolveExternal(orgId, nasRow, await externalRows(orgId, siteId))).toBeNull();
  });

  it('post-back: two configured external portals fail closed', async () => {
    const { orgId, siteId } = await tenant();
    const nasRow = { id: newId(), organization_id: orgId, site_id: siteId };
    await externalConfigured(orgId, siteId, 'active', 'ext1');
    await externalConfigured(orgId, siteId, 'active', 'ext2');
    expect(await resolveExternal(orgId, nasRow, await externalRows(orgId, siteId))).toBeNull();
  });
});
