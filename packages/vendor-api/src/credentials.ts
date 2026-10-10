/**
 * Stored controller credential → in-process client wiring (Cycle D; the "HandoffSecrets"
 * gap left open by Cycle A, research §3 contract gaps).
 *
 * The sealed `secret_ref` is opened ONLY here, in the process that makes the call, right before
 * the call; the {@link OpenedVendorCredential} object is passed down the call stack and dropped.
 * It is never serialised, logged, queued or returned by an API.
 */
import { VendorApiError } from './errors.js';
import {
  type VendorHttpClient,
  isCertificatePem,
  normalizeFingerprint,
  type ControllerKind,
  type TlsTrust,
  type VendorTarget,
} from './http.js';
import { MIST_DEFAULT_PORTAL_HOST, buildMistGrant, isMistPortalHost } from './mist.js';
import { OmadaHotspotClient } from './omada.js';
import { RUCKUS_NBI_STATUS } from './ruckus.js';
import { openSealedSecret, VENDOR_API_SECRET_PURPOSE, type VendorSecretKey } from './sealed.js';
import { UnifiNetworkClient } from './unifi.js';

export type VendorApiKind =
  'unifi-network' | 'omada-controller' | 'mist' | 'ruckus-nbi' | 'ruckus-one' | 'meraki-dashboard';

/** Kinds with an implemented outbound client / signer in Cycle D. */
export const IMPLEMENTED_API_KINDS: readonly VendorApiKind[] = [
  'unifi-network',
  'omada-controller',
  'mist',
];

/** Non-secret per-adapter settings (`vendor_api_credentials.settings`, migration 031). */
export interface VendorApiSettings {
  /** Omada CONTROLLER_ID path segment (needed before any omada-controller call). */
  readonly omada_controller_id?: string;
  /** Mist portal host (default `portal.mist.com`). */
  readonly mist_portal_host?: string;
  /** Mist guest WLAN ids this credential (WLAN API secret) belongs to; redirects must match. */
  readonly mist_wlan_ids?: readonly string[];
  /** UniFi site *name* seen in the redirect path `/guest/s/<name>/` (the API needs the id). */
  readonly unifi_site_name?: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Validates settings for `kind`; returns the normalised object or an issue list. */
export function validateVendorApiSettings(
  kind: VendorApiKind,
  raw: unknown,
):
  | { ok: true; settings: VendorApiSettings }
  | { ok: false; issues: { path: string; message: string }[] } {
  const issues: { path: string; message: string }[] = [];
  const input = (raw ?? {}) as Record<string, unknown>;
  if (typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, issues: [{ path: 'settings', message: 'must be an object' }] };
  }
  const allowed: Record<VendorApiKind, readonly string[]> = {
    'unifi-network': ['unifi_site_name'],
    'omada-controller': ['omada_controller_id'],
    mist: ['mist_portal_host', 'mist_wlan_ids'],
    'ruckus-nbi': [],
    'ruckus-one': [],
    'meraki-dashboard': [],
  };
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!allowed[kind].includes(key)) {
      issues.push({ path: `settings.${key}`, message: `not a setting of ${kind}` });
      continue;
    }
    if (key === 'omada_controller_id') {
      if (typeof value !== 'string' || !/^[A-Za-z0-9]{1,64}$/.test(value)) {
        issues.push({
          path: `settings.${key}`,
          message: '1-64 letters / digits (Omada CONTROLLER_ID)',
        });
      } else out[key] = value;
    } else if (key === 'mist_portal_host') {
      if (typeof value !== 'string' || !isMistPortalHost(value)) {
        issues.push({
          path: `settings.${key}`,
          message: 'portal.mist.com or portal.<region>.mist.com',
        });
      } else out[key] = value;
    } else if (key === 'mist_wlan_ids') {
      if (
        !Array.isArray(value) ||
        value.length > 64 ||
        !value.every((v) => typeof v === 'string' && UUID_RE.test(v.toLowerCase()))
      ) {
        issues.push({ path: `settings.${key}`, message: 'up to 64 Mist WLAN UUIDs' });
      } else out[key] = [...new Set(value.map((v: string) => v.toLowerCase()))];
    } else if (key === 'unifi_site_name') {
      if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(value)) {
        issues.push({ path: `settings.${key}`, message: '1-64 of A-Z a-z 0-9 _ -' });
      } else out[key] = value;
    }
  }
  // Missing adapter settings (Omada CONTROLLER_ID, UniFi site id) are not refused here: a
  // credential may be stored first and completed later; the client refuses to call without them
  // (`invalid_target`), and "Test connection" reports it.
  return issues.length > 0 ? { ok: false, issues } : { ok: true, settings: out };
}

/** Row fields needed to build a client (vendor_api_credentials + controllers.kind). */
export interface StoredVendorCredential {
  readonly controllerId: string;
  readonly controllerKind: ControllerKind;
  readonly apiKind: VendorApiKind;
  readonly baseUrl: string;
  readonly username: string | null;
  readonly secretRef: string;
  readonly externalSiteId: string | null;
  readonly settings: VendorApiSettings;
  readonly tlsCaPem: string | null;
  readonly tlsFingerprintSha256: string | null;
}

/** In-process only (see module header). */
export interface OpenedVendorCredential extends Omit<StoredVendorCredential, 'secretRef'> {
  readonly secret: string;
}

export function tlsTrustOf(
  row: Pick<StoredVendorCredential, 'tlsCaPem' | 'tlsFingerprintSha256'>,
): TlsTrust {
  if (row.tlsFingerprintSha256 !== null) {
    const sha256 = normalizeFingerprint(row.tlsFingerprintSha256);
    if (sha256 === null) throw new VendorApiError('invalid_target');
    return { mode: 'fingerprint', sha256 };
  }
  if (row.tlsCaPem !== null) {
    if (!isCertificatePem(row.tlsCaPem)) throw new VendorApiError('invalid_target');
    return { mode: 'ca', caPem: row.tlsCaPem };
  }
  return { mode: 'system' };
}

/**
 * `key`: the API passes its master data key (string); the worker passes
 * `{kind: 'derived', value: VENDOR_API_SECRET_KEY}` (review F4).
 */
export function openVendorCredential(
  key: string | VendorSecretKey,
  row: StoredVendorCredential,
): OpenedVendorCredential {
  const { secretRef, ...rest } = row;
  return {
    ...rest,
    secret: openSealedSecret(key, secretRef, VENDOR_API_SECRET_PURPOSE),
  };
}

export function vendorTargetOf(cred: Omit<StoredVendorCredential, 'secretRef'>): VendorTarget {
  return {
    controllerId: cred.controllerId,
    baseUrl: cred.baseUrl,
    kind: cred.controllerKind,
    tls: tlsTrustOf(cred),
  };
}

export function unifiClientOf(
  http: VendorHttpClient,
  cred: OpenedVendorCredential,
): UnifiNetworkClient {
  if (cred.apiKind !== 'unifi-network' || cred.externalSiteId === null) {
    throw new VendorApiError('invalid_target');
  }
  return new UnifiNetworkClient(http, vendorTargetOf(cred), cred.secret, cred.externalSiteId);
}

export function omadaClientOf(
  http: VendorHttpClient,
  cred: OpenedVendorCredential,
): OmadaHotspotClient {
  const omadacId = cred.settings.omada_controller_id;
  if (cred.apiKind !== 'omada-controller' || cred.username === null || omadacId === undefined) {
    throw new VendorApiError('invalid_target');
  }
  return new OmadaHotspotClient(http, vendorTargetOf(cred), {
    operator: cred.username,
    password: cred.secret,
    omadacId,
  });
}

export interface ConnectionTestResult {
  readonly ok: boolean;
  /** `ok` or a {@link VendorApiError} code. */
  readonly code: string;
  /** True when a network request was made (Mist / stubs make none). */
  readonly contacted: boolean;
  readonly detail: string;
}

/** "Test connection": one read-only (UniFi) or login-only (Omada) call; Mist signs locally. */
export async function testVendorConnection(
  http: VendorHttpClient,
  cred: OpenedVendorCredential,
): Promise<ConnectionTestResult> {
  try {
    switch (cred.apiKind) {
      case 'unifi-network':
        await unifiClientOf(http, cred).testConnection();
        return {
          ok: true,
          code: 'ok',
          contacted: true,
          detail: 'listed clients of the configured UniFi site',
        };
      case 'omada-controller':
        await omadaClientOf(http, cred).testConnection();
        return {
          ok: true,
          code: 'ok',
          contacted: true,
          detail: 'hotspot operator login succeeded',
        };
      case 'mist': {
        // No documented server-side endpoint takes the WLAN API secret: the grant is signed
        // locally and only the browser contacts Mist. The test proves the settings + secret.
        buildMistGrant({
          secret: cred.secret,
          wlanId: cred.settings.mist_wlan_ids?.[0] ?? '00000000-0000-0000-0000-000000000000',
          apMac: '020000000000',
          clientMac: '020000000001',
          authorizeMinutes: 1,
          expires: 1,
          host: cred.settings.mist_portal_host ?? MIST_DEFAULT_PORTAL_HOST,
        });
        return {
          ok: true,
          code: 'ok',
          contacted: false,
          detail: 'grant signing works; Mist is not contacted server-side (browser 302 only)',
        };
      }
      default:
        return {
          ok: false,
          code: 'not_implemented',
          contacted: false,
          detail: `${cred.apiKind} is not implemented in Cycle D (${RUCKUS_NBI_STATUS})`,
        };
    }
  } catch (error) {
    if (error instanceof VendorApiError) {
      return {
        ok: false,
        code: error.code,
        contacted: error.code !== 'invalid_target',
        detail: error.message,
      };
    }
    throw error;
  }
}
