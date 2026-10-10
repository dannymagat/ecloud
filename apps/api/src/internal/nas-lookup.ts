/**
 * Pre-tenant NAS resolution for portal redirects (Cycle A, D-044; research §3 "contract gaps",
 * `NasLookup.findNas`). Runs on the platform role BEFORE any tenant is known, so every rule fails
 * closed. AP MACs are visible over the air and registration is first-come (global unique index),
 * so an AP row is never trusted on its own word (Cycle A review M1):
 *
 *  - `nasid` given: the NAS is resolved by `nasid` ONLY (exactly one active NAS of an active
 *    site / organization; NAS identifiers are not unique across tenants, two matches are refused).
 *    The AP MAC is a hint: a live AP row of ANOTHER NAS does not block (that would let anyone who
 *    registers a sniffed MAC deny service); it is reported as `apMacClaimedElsewhere` so the
 *    caller logs `ap_mac_claimed_elsewhere` (no tenant detail). The NAS's own signature (UAM `md`)
 *    still decides.
 *  - AP MAC only (post-back / Meraki style flows): the AP row must be VERIFIED (`verified_at`, set
 *    when the NAS itself proved the AP: an authenticated RADIUS packet from that NAS carrying the
 *    AP MAC in Called-Station-Id, see `observeAccessPoint`; controller-inventory match later),
 *    active, and its NAS / site / organization active. Unverified -> `ap_unverified`.
 *  - neither resolvable: null.
 *
 * The reason is for the log only; the portal answers one generic error for every refusal.
 */
import { withPlatform, withTenant, type DbTransaction } from '@ecloud/db';
import { canonicalUnicastMac } from '@ecloud/shared';
import type { AppDeps } from '../context.js';

const LOOKUP_ACCESS = Object.freeze({ reason: 'portal', audit: false });

export interface ResolvedNasRow {
  id: string;
  organization_id: string;
  site_id: string;
  nas_identifier: string | null;
  adapter_key: string | null;
  deployment_mode: 'native' | 'gateway';
  controller_id: string | null;
  /** Migration 029 (review F1): the NAS's own browser login address (post-back target). */
  hotspot_address?: string | null;
  hotspot_port?: number | null;
}

export type NasIdentityResult =
  | {
      readonly ok: true;
      readonly nas: ResolvedNasRow;
      readonly via: 'nasid' | 'ap_mac' | 'both';
      /** `nasid` resolved, but the AP MAC is registered to another NAS (log, do not block). */
      readonly apMacClaimedElsewhere: boolean;
    }
  | {
      readonly ok: false;
      readonly reason:
        | 'no_identity'
        | 'unknown_nas'
        | 'ambiguous_nasid'
        | 'unknown_ap'
        | 'ap_inactive'
        | 'ap_unverified'
        | 'conflict';
    };

const NAS_COLUMNS = [
  'n.id',
  'n.organization_id',
  'n.site_id',
  'n.nas_identifier',
  'n.adapter_key',
  'n.deployment_mode',
  'n.controller_id',
  'n.hotspot_address',
  'n.hotspot_port',
] as const;

async function byNasid(trx: DbTransaction, nasid: string): Promise<ResolvedNasRow[]> {
  return await trx
    .selectFrom('nas_clients as n')
    .innerJoin('sites as s', 's.id', 'n.site_id')
    .innerJoin('organizations as o', 'o.id', 'n.organization_id')
    .select([...NAS_COLUMNS])
    .where('n.nas_identifier', '=', nasid)
    .where('n.status', '=', 'active')
    .where('n.deleted_at', 'is', null)
    .where('s.deleted_at', 'is', null)
    .where('s.status', '=', 'active')
    .where('o.status', '=', 'active')
    .limit(2)
    .execute();
}

interface ApRow extends ResolvedNasRow {
  ap_status: string;
  ap_verified_at: Date | null;
  nas_status: string;
  nas_deleted_at: Date | null;
  site_status: string;
  site_deleted_at: Date | null;
  org_status: string;
}

async function byApMac(trx: DbTransaction, mac: string): Promise<ApRow[]> {
  return await trx
    .selectFrom('nas_access_points as ap')
    .innerJoin('nas_clients as n', (j) =>
      j
        .onRef('n.id', '=', 'ap.nas_client_id')
        .onRef('n.organization_id', '=', 'ap.organization_id'),
    )
    .innerJoin('sites as s', 's.id', 'n.site_id')
    .innerJoin('organizations as o', 'o.id', 'n.organization_id')
    .select([
      ...NAS_COLUMNS,
      'ap.status as ap_status',
      'ap.verified_at as ap_verified_at',
      'n.status as nas_status',
      'n.deleted_at as nas_deleted_at',
      's.status as site_status',
      's.deleted_at as site_deleted_at',
      'o.status as org_status',
    ])
    .where('ap.mac', '=', mac)
    .where('ap.deleted_at', 'is', null)
    .limit(2)
    .execute();
}

function strip(row: ApRow): ResolvedNasRow {
  return {
    id: row.id,
    organization_id: row.organization_id,
    site_id: row.site_id,
    nas_identifier: row.nas_identifier,
    adapter_key: row.adapter_key,
    deployment_mode: row.deployment_mode,
    controller_id: row.controller_id,
    hotspot_address: row.hotspot_address ?? null,
    hotspot_port: row.hotspot_port ?? null,
  };
}

/** Pure decision over the candidate rows (unit-tested without a database). */
export function decideNasIdentity(input: {
  nasid: string | null;
  apMac: string | null;
  byNasid: readonly ResolvedNasRow[] | null;
  byApMac: readonly ApRow[] | null;
}): NasIdentityResult {
  const { nasid, apMac } = input;
  if (nasid === null && apMac === null) return { ok: false, reason: 'no_identity' };
  const apRows = apMac === null ? [] : (input.byApMac ?? []);

  if (nasid !== null) {
    // nasid decides; the AP row is only a hint (review M1a).
    const rows = input.byNasid ?? [];
    if (rows.length > 1) return { ok: false, reason: 'ambiguous_nasid' };
    const nas = rows[0];
    if (nas === undefined) return { ok: false, reason: 'unknown_nas' };
    const sameNas = apRows.some(
      (r) => r.id === nas.id && r.organization_id === nas.organization_id,
    );
    const elsewhere = apRows.some(
      (r) => r.id !== nas.id || r.organization_id !== nas.organization_id,
    );
    return {
      ok: true,
      nas,
      via: sameNas ? 'both' : 'nasid',
      apMacClaimedElsewhere: elsewhere,
    };
  }

  // MAC-only: never trust an AP row alone (review M1b).
  if (apRows.length > 1) return { ok: false, reason: 'conflict' };
  const ap = apRows[0];
  if (ap === undefined) return { ok: false, reason: 'unknown_ap' };
  if (
    ap.ap_status !== 'active' ||
    ap.nas_status !== 'active' ||
    ap.nas_deleted_at !== null ||
    ap.site_status !== 'active' ||
    ap.site_deleted_at !== null ||
    ap.org_status !== 'active'
  ) {
    return { ok: false, reason: 'ap_inactive' };
  }
  if (ap.ap_verified_at === null) return { ok: false, reason: 'ap_unverified' };
  return { ok: true, nas: strip(ap), via: 'ap_mac', apMacClaimedElsewhere: false };
}

/**
 * RADIUS-observed AP verification (review M1b). Called by `/internal/aaa/authorize` once the NAS
 * is resolved from server-side facts (UDP source / clients.conf shortname, i.e. the packet passed
 * the NAS shared-secret / Message-Authenticator check in FreeRADIUS): an AP row of THIS NAS whose
 * MAC equals the packet's Called-Station-Id MAC is marked verified. A row of another NAS is never
 * touched. Best effort: an error is logged by the caller, never fails the authorization.
 */
export async function observeAccessPoint(
  deps: AppDeps,
  input: { organizationId: string; nasId: string; calledStationId: string | undefined },
  now: Date,
): Promise<boolean> {
  const apMac = calledStationMac(input.calledStationId);
  if (apMac === null) return false;
  return withTenant(deps.db, input.organizationId, async (trx) => {
    const res = await trx
      .updateTable('nas_access_points')
      .set({ verified_at: now, verification_source: 'radius-called-station' })
      .where('nas_client_id', '=', input.nasId)
      .where('mac', '=', apMac)
      .where('deleted_at', 'is', null)
      .where('verified_at', 'is', null)
      .executeTakeFirst();
    return Number(res.numUpdatedRows) > 0;
  });
}

/** AP MAC of a Called-Station-Id (`AA-BB-CC-DD-EE-FF` or `AA-BB-CC-DD-EE-FF:ssid`), strict. */
export function calledStationMac(value: string | undefined): string | null {
  if (value === undefined) return null;
  const whole = canonicalUnicastMac(value);
  if (whole !== null) return whole;
  const m = /^([0-9A-Fa-f]{2}(?:[-:]?[0-9A-Fa-f]{2}){5})[:;]/.exec(value);
  return m?.[1] === undefined ? null : canonicalUnicastMac(m[1]);
}

/**
 * Resolves the registered NAS of a redirect from `nasid` and/or an AP MAC (any spelling; a
 * non-MAC or group address counts as absent). Platform transaction, read-only.
 */
export async function findNasByIdentity(
  deps: AppDeps,
  query: { readonly nasid?: string | null; readonly apMac?: string | null },
): Promise<NasIdentityResult> {
  const nasid =
    typeof query.nasid === 'string' && query.nasid !== '' && query.nasid.length <= 253
      ? query.nasid
      : null;
  const apMac = canonicalUnicastMac(query.apMac ?? null);
  if (nasid === null && apMac === null) return { ok: false, reason: 'no_identity' };
  return withPlatform(deps.dbPlatform, LOOKUP_ACCESS, async (trx) =>
    decideNasIdentity({
      nasid,
      apMac,
      byNasid: nasid === null ? null : await byNasid(trx, nasid),
      byApMac: apMac === null ? null : await byApMac(trx, apMac),
    }),
  );
}
