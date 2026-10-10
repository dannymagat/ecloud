/**
 * `controllers.inventory` (multi-vendor Cycle D; plan §13.1 M1b "controller-inventory" hook,
 * migration 028 `nas_access_points.verification_source`):
 *
 *  1. For every active UniFi Network API credential of an ON-PREMISES / EMBEDDED controller with
 *     a PINNED TLS trust (CA or fingerprint), list the adopted devices through the SSRF-safe
 *     client and mark matching, still-unverified AP rows as CANDIDATES (`inventory_seen_at`,
 *     `inventory_controller_id`). It NEVER sets `verified_at` (review F1): a tenant controls
 *     both its credential and the server behind it, so an inventory alone could "prove" a sniffed
 *     MAC of someone else's AP. Verification needs the platform confirmation
 *     (`POST /api/v1/platform/access-points/confirm-inventory`) or RADIUS observation.
 *     TENANT-SCOPED: only AP rows of the SAME organization whose NAS is managed by THIS controller.
 *  2. Expires `vendor_api_sessions` whose granted duration has passed (ECLOUD's view only).
 *
 * Verification is additive: an AP that disappears from the inventory is NOT un-verified here
 * (a MAC / NAS change already resets `verified_at`, Cycle A). Omada (hotspot operator API has no
 * documented inventory), Mist (the WLAN API secret is not an org API token) and Ruckus are
 * REQUIRES_CLARIFICATION and skipped.
 *
 * Outbound calls are OFF unless `WORKER_CONTROLLER_INVENTORY_ENABLED=true` and the worker has the
 * DERIVED `VENDOR_API_SECRET_KEY` (review F4). A worker that was given the master
 * `DATA_ENCRYPTION_KEY` refuses to run the inventory. The sealed secret is opened in this
 * process, per controller, and dropped.
 * The job never logs a secret, a URL query or vendor text: only codes and counts.
 */
import { withPlatform, type Db } from '@ecloud/db';
import { canonicalUnicastMac, type Logger } from '@ecloud/shared';
import {
  VendorApiError,
  VendorHttpClient,
  isDerivedVendorApiKey,
  openVendorCredential,
  unifiClientOf,
  type StoredVendorCredential,
} from '@ecloud/vendor-api';
import { sql } from 'kysely';

export const INVENTORY_REASON = 'worker:controllers.inventory';
/** Controllers handled per run (sequential, each bounded by the client's deadline). */
export const INVENTORY_BATCH = 100;

export interface InventoryDeps {
  db: Db;
  logger: Logger;
  enabled: boolean;
  /** Derived `vapi1.…` key (review F4). */
  vendorApiKey: string | null;
  /** The master data key reached the worker: refuse (review F4). */
  masterKeyPresent?: boolean;
  denyCidrs?: string;
  http?: VendorHttpClient;
  now?: () => Date;
}

export interface InventoryReport {
  skipped:
    'disabled' | 'master_key_present' | 'no_vendor_api_key' | 'invalid_vendor_api_key' | null;
  controllers: number;
  /** AP rows newly / again marked as inventory candidates (never verified here). */
  candidates: number;
  failures: Record<string, number>;
  expiredApiSessions: number;
}

let sharedHttp: VendorHttpClient | null = null;

export async function runControllerInventory(deps: InventoryDeps): Promise<InventoryReport> {
  const now = (deps.now ?? (() => new Date()))();
  const report: InventoryReport = {
    skipped: null,
    controllers: 0,
    candidates: 0,
    failures: {},
    expiredApiSessions: 0,
  };
  report.expiredApiSessions = await withPlatform(
    deps.db,
    { reason: INVENTORY_REASON, audit: false },
    async (trx) => {
      const res = await trx
        .updateTable('vendor_api_sessions')
        .set({ status: 'expired' })
        .where('status', 'in', ['authorized', 'granted_url_issued'])
        .where('expires_at', '<', now)
        .executeTakeFirst();
      return Number(res.numUpdatedRows);
    },
  );
  if (!deps.enabled) return { ...report, skipped: 'disabled' };
  if (deps.masterKeyPresent === true) {
    deps.logger.error(
      { job: 'controllers.inventory' },
      'refusing controller inventory: the worker must receive VENDOR_API_SECRET_KEY, not DATA_ENCRYPTION_KEY',
    );
    return { ...report, skipped: 'master_key_present' };
  }
  if (deps.vendorApiKey === null) return { ...report, skipped: 'no_vendor_api_key' };
  if (!isDerivedVendorApiKey(deps.vendorApiKey)) {
    deps.logger.error(
      { job: 'controllers.inventory' },
      'VENDOR_API_SECRET_KEY is not a derived vapi1 key',
    );
    return { ...report, skipped: 'invalid_vendor_api_key' };
  }
  const secretKey = { kind: 'derived' as const, value: deps.vendorApiKey };
  const http =
    deps.http ??
    (sharedHttp ??= new VendorHttpClient(
      deps.denyCidrs !== undefined ? { denyCidrs: deps.denyCidrs } : {},
    ));

  const creds = await withPlatform(deps.db, { reason: INVENTORY_REASON, audit: false }, (trx) =>
    trx
      .selectFrom('vendor_api_credentials as v')
      .innerJoin('controllers as c', 'c.id', 'v.controller_id')
      .select([
        'v.organization_id',
        'v.controller_id',
        'c.kind',
        'v.api_kind',
        'v.base_url',
        'v.username',
        'v.secret_ref',
        'v.external_site_id',
        'v.settings',
        'v.tls_ca_pem',
        'v.tls_fingerprint_sha256',
      ])
      .where('v.api_kind', '=', 'unifi-network')
      .where('v.external_site_id', 'is not', null)
      .where('c.status', '=', 'active')
      .where('c.deleted_at', 'is', null)
      // Review F1: only on-prem / embedded controllers with a PINNED TLS trust anchor.
      .where('c.kind', 'in', ['on_premises', 'embedded'])
      .where((eb) =>
        eb.or([eb('v.tls_ca_pem', 'is not', null), eb('v.tls_fingerprint_sha256', 'is not', null)]),
      )
      .orderBy(sql`v.inventory_checked_at NULLS FIRST`)
      .limit(INVENTORY_BATCH)
      .execute(),
  );

  for (const row of creds) {
    report.controllers += 1;
    const stored: StoredVendorCredential = {
      controllerId: row.controller_id,
      controllerKind: row.kind,
      apiKind: 'unifi-network',
      baseUrl: row.base_url,
      username: row.username,
      secretRef: row.secret_ref,
      externalSiteId: row.external_site_id,
      settings: row.settings ?? {},
      tlsCaPem: row.tls_ca_pem,
      tlsFingerprintSha256: row.tls_fingerprint_sha256,
    };
    let code = 'ok';
    let macs: string[] = [];
    try {
      const raw = await unifiClientOf(
        http,
        openVendorCredential(secretKey, stored),
      ).listDeviceMacs();
      macs = [
        ...new Set(raw.map((m) => canonicalUnicastMac(m)).filter((m): m is string => m !== null)),
      ];
    } catch (error) {
      code = error instanceof VendorApiError ? error.code : 'secret_unavailable';
    }
    const matched = await withPlatform(
      deps.db,
      { reason: INVENTORY_REASON, audit: false },
      async (trx) => {
        let n = 0;
        if (code === 'ok' && macs.length > 0) {
          const updated = await trx
            .updateTable('nas_access_points')
            .set({ inventory_seen_at: now, inventory_controller_id: row.controller_id })
            .where('organization_id', '=', row.organization_id)
            .where('deleted_at', 'is', null)
            .where('verified_at', 'is', null)
            .where(sql<boolean>`mac = ANY(${macs}::macaddr[])`)
            .where('nas_client_id', 'in', (eb) =>
              eb
                .selectFrom('nas_clients')
                .select('id')
                .where('organization_id', '=', row.organization_id)
                .where('controller_id', '=', row.controller_id)
                .where('deleted_at', 'is', null),
            )
            .executeTakeFirst();
          n = Number(updated.numUpdatedRows);
        }
        await trx
          .updateTable('vendor_api_credentials')
          .set({
            inventory_checked_at: now,
            inventory_result: code,
            inventory_matched: code === 'ok' ? n : null,
          })
          .where('controller_id', '=', row.controller_id)
          .where('organization_id', '=', row.organization_id)
          .execute();
        return n;
      },
    );
    report.candidates += matched;
    if (code !== 'ok') report.failures[code] = (report.failures[code] ?? 0) + 1;
    deps.logger.info(
      {
        controllerId: row.controller_id,
        organizationId: row.organization_id,
        result: code,
        devices: macs.length,
        candidates: matched,
      },
      'controllers.inventory controller checked',
    );
  }
  return report;
}
