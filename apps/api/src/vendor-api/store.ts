/**
 * Cycle D: reading the stored controller-API credential for an outbound call. The row (with its
 * sealed `secret_ref`) is read inside a transaction; the secret is opened by the caller, in this
 * process, only after the transaction has ended (no DB connection is held during vendor I/O).
 */
import type { DbTransaction } from '@ecloud/db';
import { VendorHttpClient, type StoredVendorCredential } from '@ecloud/vendor-api';
import type { AppDeps } from '../context.js';

let shared: VendorHttpClient | null = null;

/** The injected client (tests) or one process-wide client (shared per-controller buckets). */
export function vendorHttpOf(deps: AppDeps): VendorHttpClient {
  if (deps.vendorHttp !== undefined) return deps.vendorHttp;
  shared ??= new VendorHttpClient(
    deps.config.vendorApiDenyCidrs !== undefined
      ? { denyCidrs: deps.config.vendorApiDenyCidrs }
      : {},
  );
  return shared;
}

/** Credential + controller kind of an ACTIVE, non-deleted controller (RLS / tenant tx). */
export async function loadStoredCredential(
  trx: DbTransaction,
  controllerId: string,
): Promise<StoredVendorCredential | null> {
  const row = await trx
    .selectFrom('vendor_api_credentials as v')
    .innerJoin('controllers as c', 'c.id', 'v.controller_id')
    .select([
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
    .where('v.controller_id', '=', controllerId)
    .where('c.deleted_at', 'is', null)
    .where('c.status', '=', 'active')
    .executeTakeFirst();
  if (row === undefined) return null;
  return {
    controllerId: row.controller_id,
    controllerKind: row.kind,
    apiKind: row.api_kind,
    baseUrl: row.base_url,
    username: row.username,
    secretRef: row.secret_ref,
    externalSiteId: row.external_site_id,
    settings: row.settings ?? {},
    tlsCaPem: row.tls_ca_pem,
    tlsFingerprintSha256: row.tls_fingerprint_sha256,
  };
}

/** Adapter key → the controller API kind it needs. */
export const ADAPTER_API_KIND = Object.freeze({
  'unifi-external-portal': 'unifi-network',
  'omada-api': 'omada-controller',
  'mist-guest-portal': 'mist',
} as const);
