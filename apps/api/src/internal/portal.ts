/**
 * Internal captive-portal endpoints (`/internal/portal/*`, X-Internal-Token; API_ARCHITECTURE.md
 * "Internal" table). The portal process holds no DB credentials and no UAM secret: it forwards
 * the raw UAM query here, and this module runs the L2 VendorAdapter contract
 * (MULTI_VENDOR_INTEGRATION_PLAN.md §6.2) — `parseRedirect` → `validateContext` (md signature,
 * NAS lookup, tenant, replay store, private uamip) → identity broker → single-use portal
 * credential → `authorizeSession` (browser-form 302 to `uamip:uamport/logon`, PAP-encoded).
 *
 *   POST /internal/portal/redirects            UAM entry and `res=` callbacks (one generic error)
 *   GET  /internal/portal/flows/:id            page data: methods, theme, terms, notices
 *   POST /internal/portal/flows/:id/identify   password | voucher | click_through → hand-off URL
 *   GET  /internal/portal/flows/:id/status     session status for the status page
 *   POST /internal/portal/flows/:id/logout     NAS logoff URL
 *
 * Branding bytes for the portal's `/a/{assetId}` come from `/internal/portal-assets/:assetId`
 * (portal administration, P6-B).
 *
 * `resolve-nas` of the API_ARCHITECTURE table is folded into `redirects`: resolving a NAS
 * without validating the signed redirect in the same step would hand the portal an unverified
 * tenant. Every validation failure (unknown NAS, bad signature, tenant mismatch, replay,
 * malformed) answers the same `{kind:"error"}`; the reason goes to the log only.
 */
import {
  LOGIN_TOKEN_MAX_TTL_S,
  MIKROTIK_ADAPTER_KEY,
  MIKROTIK_PORTAL_PATH,
  getVendorAdapter,
  loginOriginOf,
  postbackAdapterForNas,
  postbackContinueUrl,
  resolveLoginUrl,
  splitPostbackQuery,
  isPrivateIpv4,
  parseMikrotikLoginTarget,
  safeUserUrl,
  splitMikrotikQuery,
  splitUamQuery,
  type HotspotContext,
  type NasLookup,
  type RegisteredNas,
} from '@ecloud/adapters';
import { withPlatform, withTenant, type DbTransaction, type PortalType } from '@ecloud/db';
import { canonicalUnicastMac, isUuid, newId, type Logger } from '@ecloud/shared';
import { isVendorApiAdapterKey } from '@ecloud/vendor-api';
import express, { type Request, type Response, type Router } from 'express';
import { isIP } from 'node:net';
import { z } from 'zod';
import type { AppDeps } from '../context.js';
import { Envelope, openSecretRef, sealSecretRef, sha256Hex } from '../crypto.js';
import { logPortalSecurityEvent } from '../security-events.js';
import { consumePortalLoginToken, issuePortalLoginToken } from './login-token-store.js';
import { completeVendorApiAuthorization } from '../vendor-api/portal.js';
import { findNasByIdentity } from './nas-lookup.js';
import { registerPostbackRoutes } from './portal-postback.js';
import { PORTAL_COLUMNS, type PortalRow } from './portal-row.js';
import {
  buildSnapshot,
  loadPublishedSnapshot,
  offeredLegacyMethods,
  portalCapabilities,
  type PortalSnapshot,
} from './portal-snapshot.js';
import {
  MERAKI_ADAPTER_KEY,
  MERAKI_PORTAL_TYPE,
  consumeMerakiLoginToken,
  isMerakiFlow,
  merakiFlowView,
  merakiGrantHandoff,
  merakiMethods,
  merakiMode,
  merakiSuccessUrl,
} from './portal-meraki.js';
import {
  IdentityRejected,
  checkSubscriberLoginPassword,
  confirmSubscriberLogin,
  findSubscriberByUsername,
  verifyVoucherCode,
  type PasswordCheck,
} from './portal-identity.js';
import {
  CHAP_CREDENTIAL_PURPOSE,
  CREDENTIAL_TTL_S,
  FLOW_TTL_S,
  findIndexedFlow,
  indexFlow,
  isReplayed,
  loadFlow,
  newCredentialPair,
  replayKey,
  revokeCredential,
  saveFlow,
  storeCredential,
  type BrokerIdentity,
  type PortalFlow,
  type PortalMethod,
} from './portal-store.js';

/** UAM secrets are per-NAS shared secrets sealed like RADIUS secrets (SECURITY §5.2). */
// HKDF purpose label, not a secret. check-no-secrets: allow
export const UAM_SECRET_PURPOSE = 'ecloud:nas:secret:v1'; // check-no-secrets: allow

/** `captive_portals.uam_secret_ref` value for a UAM secret (`enc:v1…`, data key). */
export function sealUamSecret(dataEncryptionKey: string, secret: string): string {
  return sealSecretRef(new Envelope(dataEncryptionKey, UAM_SECRET_PURPOSE), secret);
}

const PORTAL_ACCESS = Object.freeze({ reason: 'portal', audit: false });

/**
 * Name of the portal created by {@link ensurePlatformDefaultPortal}. It says what it is in the
 * admin list without anyone having to know what `is_platform_default` means, and it says it is
 * temporary, because a fallback that looks like a choice outlives its purpose.
 */
export const PLATFORM_DEFAULT_PORTAL_NAME = 'Platform default (unconfigured site)';

/** Path-based adapter selection (`/uam/uspot/`, `/uam/chilli/`; API_ARCHITECTURE portal table). */
export const UAM_FLAVOURS = Object.freeze({
  uspot: {
    adapterKeys: ['openwifi-uspot-uam', 'uspot-upstream-uam'],
    portalType: 'uspot',
    path: '/uam/uspot/',
  },
  chilli: { adapterKeys: ['coovachilli-uam'], portalType: 'coovachilli', path: '/uam/chilli/' },
  // Cycle B (D-044): RouterOS Hotspot, EZECLOUD-generated login.html (vendor/mikrotik.ts).
  mikrotik: {
    adapterKeys: ['mikrotik-hotspot'],
    portalType: 'mikrotik',
    path: MIKROTIK_PORTAL_PATH,
  },
} as const);
export type UamFlavour = keyof typeof UAM_FLAVOURS;

/** Portal entry flavours: the UAM ones plus Meraki splash (Cycle E, `/meraki/<nasid>/`). */
export type PortalFlavour = UamFlavour | 'meraki';

function flavourSpec(flavour: PortalFlavour): {
  adapterKeys: readonly string[];
  portalType: 'uspot' | 'coovachilli' | 'mikrotik' | 'external';
} {
  return flavour === 'meraki'
    ? { adapterKeys: [MERAKI_ADAPTER_KEY], portalType: MERAKI_PORTAL_TYPE }
    : UAM_FLAVOURS[flavour];
}

/** Methods the pilot portal implements (Q64: no social IdP providers; MAC-auth has no page). */
export const PORTAL_METHODS: readonly PortalMethod[] = ['password', 'voucher', 'click_through'];

/**
 * Abuse limits (SECURITY_ARCHITECTURE.md §5.4-§5.5, API_ARCHITECTURE portal CSRF/rate-limit
 * note). Failures per NAS + client MAC lock the method for `lockS`; failures per (site,
 * lower(username)) lock that account at the portal however often the attacker rotates MAC/IP;
 * voucher failures per site lock voucher entry for the whole site (enumeration cap); per-IP and
 * per-site counters cap attempts of any outcome; flows per NAS and redirects per IP cap flow
 * creation. Every lock answers the same generic 429.
 */
export const PORTAL_LIMITS = Object.freeze({
  failures: {
    password: { max: 5, windowS: 300, lockS: 900 },
    voucher: { max: 10, windowS: 3600, lockS: 3600 },
    click_through: { max: 20, windowS: 300, lockS: 300 },
  } satisfies Record<PortalMethod, { max: number; windowS: number; lockS: number }>,
  accountFailures: { max: 10, windowS: 900, lockS: 900 },
  voucherFailuresPerSite: { max: 100, windowS: 3600, lockS: 900 },
  attemptsPerIp: { max: 60, windowS: 600 },
  attemptsPerSite: { max: 2000, windowS: 600 },
  redirectsPerIp: { max: 60, windowS: 60 },
  flowsPerNas: { max: 300, windowS: 3600 },
  /**
   * Cycle E (review F3): Meraki flows per client IP, counted BEFORE the per-NAS budget so
   * anonymous traffic to `/meraki/<id>/` cannot exhaust a NAS's flow budget.
   */
  merakiFlowsPerIp: { max: 20, windowS: 600 },
});

class RateLimited extends Error {
  constructor(readonly retryAfter: number) {
    super('rate limited');
  }
}

interface ResolvedPortal {
  readonly nas: RegisteredNas;
  readonly captivePortalId: string;
}


function clientIpOf(value: unknown): string | null {
  return typeof value === 'string' && isIP(value) !== 0 ? value : null;
}

function uamServerUrl(deps: AppDeps, flavour: UamFlavour, config: Record<string, unknown>) {
  const configured = config.uam_server_url;
  if (typeof configured === 'string' && /^https?:\/\/[^?#\s]+$/.test(configured)) return configured;
  return `${deps.config.base.origins.portal.replace(/\/+$/, '')}${UAM_FLAVOURS[flavour].path}`;
}

/**
 * Outcome of portal resolution for a NAS. The three cases are distinct because they must lead to
 * different behaviour, and a bare `null` conflated two of them: `ambiguous` is an operator
 * misconfiguration that must fail CLOSED, while `none` is the unconfigured site the platform
 * default exists to serve. Returning one nullable row made a site with two pinned portals — the
 * case the code deliberately refuses — fall through to creating an anonymous connect portal.
 */
export type PortalPick =
  /** A portal an operator configured. Usable as-is; no fallback rules apply. */
  | { readonly kind: 'configured'; readonly row: PortalRow }
  /**
   * An existing platform default. **Not usable on its own**: the caller must still establish that
   * the operator has configured nothing for this (site, portal_type), because a fallback must
   * never override a portal somebody disabled on purpose. This is a separate outcome from
   * `configured` precisely so that check cannot be forgotten — while a fallback came back as a
   * bare "found", every new caller inherited the bug by default.
   */
  | { readonly kind: 'fallback'; readonly row: PortalRow }
  /** Nothing configured for this site and type: a fallback may be created. */
  | { readonly kind: 'none' }
  /** More than one configured candidate: refuse, never guess and never fall back. */
  | { readonly kind: 'ambiguous'; readonly count: number };

/**
 * The captive portal serving a NAS: pinned by `adapter_config.nas_client_id`, else the only
 * unpinned one, else — migration 041 — the site's active platform default if one exists.
 *
 * Platform defaults are excluded from the candidate sets on purpose. They are not portals anyone
 * chose, so counting one as a candidate would make every real portal ambiguous and take a working
 * site offline the moment a fallback existed. A deliberately configured portal always wins; the
 * fallback is only reached when there is nothing configured at all.
 */
export function pickPortal(rows: PortalRow[], nasId: string): PortalPick {
  const chosen = rows.filter((r) => !r.is_platform_default);
  const pinned = chosen.filter((r) => r.adapter_config.nas_client_id === nasId);
  const first = pinned[0];
  if (pinned.length === 1 && first !== undefined) return { kind: 'configured', row: first };
  // Ambiguity among portals an operator configured stays a refusal: guessing which of two pinned
  // portals was meant is worse than the error page, and serving an anonymous fallback instead of
  // one of them is worse than either.
  if (pinned.length > 1) return { kind: 'ambiguous', count: pinned.length };
  const unpinned = chosen.filter((r) => typeof r.adapter_config.nas_client_id !== 'string');
  const only = unpinned[0];
  if (unpinned.length === 1 && only !== undefined) return { kind: 'configured', row: only };
  if (unpinned.length > 1) return { kind: 'ambiguous', count: unpinned.length };
  const fallback = rows.find((r) => r.is_platform_default);
  return fallback === undefined ? { kind: 'none' } : { kind: 'fallback', row: fallback };
}

function openUamSecret(deps: AppDeps, ref: string | null): string | null {
  if (ref === null || ref === '') return null;
  try {
    return openSecretRef(new Envelope(deps.config.dataEncryptionKey, UAM_SECRET_PURPOSE), ref);
  } catch {
    return null;
  }
}

/**
 * Whether an operator has configured a portal for this (site, portal_type) — **whatever its
 * status**. Migration 041: this is the one rule that decides whether a platform-default fallback
 * may be used, and it lives in one function because applying it on the creation path but not the
 * serving path is exactly the gap that let a disabled portal fall back to anonymous access.
 *
 * Status is deliberately not filtered. Disabling a portal is how an operator takes a site's guest
 * access offline, so a disabled portal is evidence of a decision, and serving an anonymous
 * fallback instead would be the worst available reading of it. The resolution query filters on
 * active, so this is the only place that can see a disabled row.
 *
 * A DELETED portal leaves no row and therefore no evidence, so a site whose portal was deleted
 * is indistinguishable from one that never had a portal and does fall back. Closing that would
 * need a tombstone; it is recorded as a limitation rather than guessed at.
 */
export async function configuredPortalExists(
  trx: DbTransaction,
  nas: { readonly organization_id: string; readonly site_id: string },
  portalType: PortalType,
): Promise<boolean> {
  const row = await trx
    .selectFrom('captive_portals')
    .select(['id'])
    .where('site_id', '=', nas.site_id)
    .where('organization_id', '=', nas.organization_id)
    .where('portal_type', '=', portalType)
    .where('is_platform_default', '=', false)
    .executeTakeFirst();
  return row !== undefined;
}

/**
 * Migration 041: the site's platform-default portal for this portal type, created and published
 * if it does not exist yet (owner request: a NAS nobody has configured still serves a working
 * connect page).
 *
 * DELIBERATE OVERRIDE OF NAS_PENDING_ADOPTION_REQUIREMENTS.md — owner decision, 2026-10-14.
 * That document (§5) puts a NAS with no applicable policy in Pending with new access Denied, and
 * (§7, §8) forbids an unrestricted global fallback and warns specifically against applying the
 * rule in the captive portal while other paths bypass it. This code is the fallback it rules out.
 *
 * The owner was shown both readings — a deny-by-default Pending state, and an honest
 * "not yet configured" page that keeps the bring-up diagnostics without granting access — and
 * chose the permissive fallback with a 10/10 Mbps, one-day default plan. §7's prohibition is
 * against treating a global fallback as valid assignment *accidentally*; this one is a recorded
 * decision, which is the difference. Do not revert it as a bug: it is working as the owner asked.
 *
 * What makes it survivable is that it is visible. See `is_platform_default`: the admin badge,
 * the `?is_platform_default=true` filter, the `portal_platform_default_served` log line and the
 * `platformDefaultPortal` flag on the credential all exist so a forgotten access point cannot
 * serve anonymous access indefinitely without an operator being able to see it. Removing any of
 * those is what would turn this decision into the problem the specification describes.
 *
 * Why the resolver writes it rather than NAS provisioning: the point of the feature is that a NAS
 * nobody configured works, so there is no configuration step to hang the creation off. It is one
 * insert per (site, portal_type) for the lifetime of the site — the second guest finds the row.
 *
 * Concurrency: two guests on two unconfigured access points of the same site race here. The
 * partial unique index `uq_captive_portals_platform_default` is the arbiter; the loser's insert
 * does nothing and it re-reads. Returning `undefined` is possible only if the row was created and
 * then deleted inside this transaction's window, which the caller treats as unresolved.
 *
 * The snapshot is published in the same transaction as the insert, so the row can never exist in
 * the draft-only state that would serve guests nothing. That is the structural part: there is no
 * publish step for anyone to forget.
 */
export async function ensurePlatformDefaultPortal(
  trx: DbTransaction,
  nas: { readonly organization_id: string; readonly site_id: string },
  portalType: PortalType,
): Promise<PortalRow | undefined> {
  // `status = 'active'`: disabling the fallback row is the operator's only way to switch this
  // feature off for a site, so a disabled default must not be served. The partial unique index
  // still counts the disabled row, so the insert below conflicts and nothing is recreated —
  // which is what makes "off" stay off.
  const existing = await trx
    .selectFrom('captive_portals')
    .select([...PORTAL_COLUMNS])
    .where('site_id', '=', nas.site_id)
    .where('organization_id', '=', nas.organization_id)
    .where('portal_type', '=', portalType)
    .where('is_platform_default', '=', true)
    .where('status', '=', 'active')
    .executeTakeFirst();
  if (existing !== undefined) return existing;

  // A configured portal — even a disabled one — means the operator made a decision about this
  // site, and a fallback must not override it.
  if (await configuredPortalExists(trx, nas, portalType)) return undefined;

  const id = newId();
  const snapshot = buildSnapshot({
    name: PLATFORM_DEFAULT_PORTAL_NAME,
    template_key: 'quick_connect',
    auth_methods: ['click_through'],
    // Explicit rather than inherited: the registry's fallback order happens to put click-through
    // first today, and this portal must keep offering exactly one button whatever is added to the
    // registry later.
    method_order: ['click_through'],
    identity_provider_ids: [],
    redirect_url: null,
    // No terms document: there is no operator to have written one. The page shows the
    // "no terms provided" line rather than promising a document it cannot show.
    terms_version: null,
    registration_fields: [],
    locales: [],
    theme: null,
  });
  await trx
    .insertInto('captive_portals')
    .values({
      id,
      organization_id: nas.organization_id,
      site_id: nas.site_id,
      name: PLATFORM_DEFAULT_PORTAL_NAME,
      // Globally unique, and recognisable in a URL as something the platform made.
      public_slug: `default-${id.replace(/-/g, '').slice(0, 24)}`,
      portal_type: portalType,
      // Unique per (site, network_ref), so the portal type is part of it: a site may need a
      // fallback for more than one gateway family.
      network_ref: `_platform_default_${portalType}`,
      auth_methods: ['click_through'],
      method_order: ['click_through'],
      template_key: 'quick_connect',
      is_platform_default: true,
      status: 'active',
    })
    .onConflict((oc) => oc.doNothing())
    .execute();

  // Same `status = 'active'` filter as the lookup above, and for the same reason: when the insert
  // above conflicted with a row an operator had DISABLED, re-reading without the filter would
  // hand back the disabled fallback and serve it — silently undoing the only off switch there is.
  const created = await trx
    .selectFrom('captive_portals')
    .select([...PORTAL_COLUMNS])
    .where('site_id', '=', nas.site_id)
    .where('organization_id', '=', nas.organization_id)
    .where('portal_type', '=', portalType)
    .where('is_platform_default', '=', true)
    .where('status', '=', 'active')
    .executeTakeFirst();
  if (created === undefined) return undefined;
  if (created.published_version_id !== null) return created;

  const versionId = newId();
  await trx
    .insertInto('portal_versions')
    .values({
      id: versionId,
      organization_id: nas.organization_id,
      captive_portal_id: created.id,
      version: 1,
      snapshot: JSON.stringify(snapshot),
      published_by: null,
    })
    .onConflict((oc) => oc.doNothing())
    .execute();
  const published = await trx
    .updateTable('captive_portals')
    .set({ published_version_id: versionId })
    .where('id', '=', created.id)
    .where('published_version_id', 'is', null)
    .returning([...PORTAL_COLUMNS])
    .executeTakeFirst();
  return (published ?? { ...created, published_version_id: versionId });
}

/**
 * The whole portal-resolution decision for a NAS, including the migration-041 fallback rules.
 *
 * Both entry paths go through here — the UAM/splash resolver and the Cycle C post-back resolver —
 * because the rules are security rules and a second implementation is a second place for them to
 * drift. They did drift: the post-back path had its own one-line version that returned whatever
 * `pickPortal` found, which (a) never applied {@link configuredPortalExists}, so a site whose
 * operator had DISABLED its portal was served the anonymous fallback, and (b) ran against a query
 * that did not select `is_platform_default`, so `!r.is_platform_default` was `!undefined` for
 * every row and the exclusion inside `pickPortal` silently did nothing — which also meant a
 * fallback competed as an ordinary candidate and could take a working post-back site offline by
 * making its real portal ambiguous.
 *
 * `allowFallback` is the one legitimate difference between the two callers. The UAM/splash paths
 * may create and serve a fallback for a site that has none, which is the owner's ruling. The
 * post-back path may do neither: a post-back hand-off needs a vendor profile and a validated
 * login URL in `adapter_config`, and a fallback has neither, so serving one would produce a page
 * that cannot complete its hand-off — the same "a button that always fails is worse than no
 * button" problem, one layer down. Absence therefore fails closed on that path by design.
 *
 * Note this is deliberately not a "do not create" flag. Not creating would still have served a
 * fallback that already existed, and one will exist at any site where a Meraki NAS has been seen:
 * `MERAKI_PORTAL_TYPE` is `'external'`, the same portal type post-back resolves.
 */
async function resolvePortalRow(opts: {
  readonly trx: DbTransaction;
  readonly nas: { readonly id: string; readonly organization_id: string; readonly site_id: string };
  readonly portalType: PortalType;
  readonly rows: PortalRow[];
  readonly logger: Logger;
  readonly allowFallback: boolean;
}): Promise<PortalRow | null> {
  const { trx, nas, portalType, rows, logger, allowFallback } = opts;
  const picked = pickPortal(rows, nas.id);
  if (picked.kind === 'ambiguous') {
    // Fail closed. Two portals an operator configured is a misconfiguration to be fixed, not a
    // reason to admit the guest anonymously.
    logger.warn(
      {
        event: 'portal_resolution_ambiguous',
        nasId: nas.id,
        siteId: nas.site_id,
        count: picked.count,
      },
      'portal resolution refused: more than one configured portal matches this NAS',
    );
    return null;
  }
  // A fallback may only be used when the operator has configured nothing for this
  // (site, portal_type). The check cannot live only inside `ensurePlatformDefaultPortal`,
  // because once a fallback row exists — and it will, for any site that was ever unconfigured —
  // `pickPortal` returns it directly and the creation path never runs. Without this, disabling
  // the real portal to take a site offline silently reopened it as an anonymous portal.
  //
  // This is also the line between the owner's ruling and something he did not rule on: he said a
  // NAS with NOTHING ASSIGNED gets a default, not that a deliberate decision to disable a portal
  // gets overridden.
  if (picked.kind === 'configured') return picked.row;
  // Everything below is the fallback path: `fallback` (one exists) or `none` (one may be made).
  // Paths that cannot complete a hand-off with a fallback refuse one outright, before the
  // configured-portal query: there is nothing a fallback could usefully do for them.
  if (!allowFallback) return null;
  if (await configuredPortalExists(trx, nas, portalType)) {
    logger.warn(
      { event: 'portal_fallback_refused_configured', nasId: nas.id, siteId: nas.site_id },
      'portal fallback refused: this site has a configured portal, so guest access stays closed',
    );
    return null;
  }
  const portal =
    picked.kind === 'fallback'
      ? picked.row
      : ((await ensurePlatformDefaultPortal(trx, nas, portalType)) ?? null);
  if (portal === null) return null;
  // Visible in the operator's logs, not only in the admin list: an access point running on the
  // fallback is giving anonymous access and somebody should finish configuring it.
  logger.warn(
    { event: 'portal_platform_default_served', nasId: nas.id, siteId: nas.site_id },
    'portal served from the platform default: this site has no configured portal',
  );
  return portal;
}

/**
 * Portal resolution for the `external` portal type: the Cycle C post-back paths and the Cycle D
 * vendor-API paths (`../vendor-api/portal.ts`).
 *
 * **Use this rather than calling `pickPortal` directly.** It is exported in preference to the
 * picker because composing the picker with `configuredPortalExists` correctly is the step that
 * went wrong three times: a caller that forgets the gate serves an anonymous fallback at a site
 * whose operator deliberately disabled its portal, and a caller whose query omits
 * `is_platform_default` also takes correctly configured sites offline by making their real portal
 * look ambiguous. Both mistakes are impossible through this function — the gate is inside it, and
 * the `PortalRow[]` parameter makes a narrower query a compile error.
 *
 * `allowFallback: false` for every caller here: an external hand-off needs a vendor profile and a
 * validated login URL in `adapter_config`, and a platform-default row has neither, so a fallback
 * could only ever produce a page that cannot complete its hand-off. Both absence of a portal and
 * a leftover fallback therefore fail closed on these paths, by design rather than by omission.
 *
 * Also exported so tests drive the function the router wires in rather than a copy of it — the
 * defect this replaces was in the wiring, and a test against a reimplementation would have missed
 * it.
 */
export function resolveExternalPortalId(
  deps: AppDeps,
): (
  trx: DbTransaction,
  nas: { id: string; organization_id: string; site_id: string },
  rows: PortalRow[],
) => Promise<string | null> {
  return async (trx, nas, rows) => {
    const portal = await resolvePortalRow({
      trx,
      nas,
      portalType: 'external',
      // No cast. The caller's query must select `[...PORTAL_COLUMNS]`, and the compiler says so.
      rows,
      logger: deps.logger,
      allowFallback: false,
    });
    return portal === null ? null : portal.id;
  };
}

/**
 * NAS by `nasid` (= the EZECLOUD-assigned NAS identifier, CP §7.3) and/or the AP MAC from `called`
 * (Cycle A, migration 028 `nas_access_points`), via `findNasByIdentity` (nas-lookup.ts): anything
 * but exactly one active NAS fails closed, and `nasid` + a registered AP MAC of another NAS is a
 * conflict. The UAM `md` signature is still verified against the resolved NAS's secret.
 */
export async function resolvePortal(
  deps: AppDeps,
  flavour: PortalFlavour,
  identity: { nasid: string | undefined; apMac: string | null },
  logger: Logger,
): Promise<ResolvedPortal | null> {
  const found = await findNasByIdentity(deps, {
    nasid: identity.nasid ?? null,
    apMac: identity.apMac,
  });
  if (!found.ok) return null;
  if (found.apMacClaimedElsewhere) {
    // Review M1a: a hint only; the NAS's own `md` signature still decides. No tenant detail.
    logPortalSecurityEvent(logger, 'ap_mac_claimed_elsewhere', { apMac: identity.apMac });
  }
  const n = found.nas;
  return withPlatform(deps.dbPlatform, PORTAL_ACCESS, async (trx) => {
    const spec = flavourSpec(flavour);
    if (!spec.adapterKeys.includes(n.adapter_key ?? '')) {
      return null;
    }
    const portals = (await trx
      .selectFrom('captive_portals')
      .select([...PORTAL_COLUMNS])
      .where('site_id', '=', n.site_id)
      .where('organization_id', '=', n.organization_id)
      .where('status', '=', 'active')
      .where('portal_type', '=', spec.portalType)
      .execute()) as PortalRow[];
    const portal = await resolvePortalRow({
      trx,
      nas: n,
      portalType: spec.portalType,
      rows: portals,
      logger,
      // The owner's ruling: a NAS whose site has no portal still serves a connect page.
      allowFallback: true,
    });
    if (portal === null) return null;
    const deploymentMode = n.deployment_mode;
    return {
      captivePortalId: portal.id,
      nas: {
        id: n.id,
        organizationId: n.organization_id,
        siteId: n.site_id,
        identifier: n.nas_identifier,
        adapterKey: n.adapter_key,
        controllerId: n.controller_id,
        deploymentMode,
        uamServerUrl:
          flavour === 'meraki' ? null : uamServerUrl(deps, flavour, portal.adapter_config),
        uamSecret: openUamSecret(deps, portal.uam_secret_ref),
        hotspotAddress: n.hotspot_address ?? null,
        hotspotPort: n.hotspot_port ?? null,
      },
    };
  });
}

async function loadPortalRow(trx: DbTransaction, id: string): Promise<PortalRow | undefined> {
  return await trx
    .selectFrom('captive_portals')
    .select([...PORTAL_COLUMNS])
    .where('id', '=', id)
    .executeTakeFirst();
}

/**
 * Migration 038: what a guest is offered comes from the PUBLISHED snapshot, never from the draft
 * row an administrator may be editing. A portal with no published version serves nothing.
 *
 * `loadPortalRow` still reads the draft row because the parts that are not public configuration
 * live there: the UAM secret, the adapter config and the active/disabled status.
 */
async function publishedConfig(
  deps: AppDeps,
  trx: DbTransaction,
  portal: PortalRow,
): Promise<{ snapshot: PortalSnapshot; methods: PortalMethod[] } | null> {
  const published = await loadPublishedSnapshot(trx, portal);
  if (published === null) return null;
  const capabilities = await portalCapabilities(trx, {
    mailerConfigured: deps.config.base.mail !== null,
  });
  return {
    snapshot: published.snapshot,
    methods: offeredLegacyMethods(published.snapshot, capabilities),
  };
}

async function counter(deps: AppDeps, key: string, max: number, windowS: number): Promise<void> {
  if (deps.config.rateLimitDisabled) return;
  const n = await deps.kv.incr(key, windowS);
  if (n > max) throw new RateLimited((await deps.kv.ttl(key)) || windowS);
}

const lockKey = (m: PortalMethod, nasId: string, mac: string) => `pf:lock:${m}:${nasId}:${mac}`;
const failKey = (m: PortalMethod, nasId: string, mac: string) => `pf:fail:${m}:${nasId}:${mac}`;

/** Per-account key: (site, lower(username)), hashed so no username lands in Redis. */
const accountKey = (siteId: string, username: string) =>
  `${siteId}:${sha256Hex(username.toLowerCase())}`;

interface FailureCounter {
  readonly fail: string;
  readonly lock: string;
  readonly limit: { readonly max: number; readonly windowS: number; readonly lockS: number };
}

/** The failure counters an identify attempt with `input` is subject to. */
function failureCounters(flow: PortalFlow, input: { method: PortalMethod; username?: string }) {
  const m = input.method;
  const counters: FailureCounter[] = [
    {
      fail: failKey(m, flow.nasId, flow.clientMac),
      lock: lockKey(m, flow.nasId, flow.clientMac),
      limit: PORTAL_LIMITS.failures[m],
    },
  ];
  if (m === 'password' && input.username !== undefined) {
    const k = accountKey(flow.siteId, input.username);
    counters.push({
      fail: `pf:fail:acct:${k}`,
      lock: `pf:lock:acct:${k}`,
      limit: PORTAL_LIMITS.accountFailures,
    });
  }
  if (m === 'voucher') {
    counters.push({
      fail: `pf:fail:voucher-site:${flow.siteId}`,
      lock: `pf:lock:voucher-site:${flow.siteId}`,
      limit: PORTAL_LIMITS.voucherFailuresPerSite,
    });
  }
  return counters;
}

async function assertNotLocked(deps: AppDeps, counters: readonly FailureCounter[]): Promise<void> {
  if (deps.config.rateLimitDisabled) return;
  for (const c of counters) {
    const ttl = await deps.kv.ttl(c.lock);
    if (ttl > 0) throw new RateLimited(ttl);
  }
}

/**
 * Counts one failure against every counter; returns true when it activated a lock (recorded as
 * `portal_login_attempts.triggered_lockout`, migration 026, so lockouts are reportable).
 */
async function recordFailure(deps: AppDeps, counters: readonly FailureCounter[]): Promise<boolean> {
  if (deps.config.rateLimitDisabled) return false;
  let locked = false;
  for (const c of counters) {
    const n = await deps.kv.incr(c.fail, c.limit.windowS);
    if (n >= c.limit.max) {
      await deps.kv.set(c.lock, '1', c.limit.lockS);
      await deps.kv.del(c.fail);
      locked = true;
    }
  }
  return locked;
}

/** Success clears the per-device and per-account counters (never the site-wide voucher cap). */
async function clearFailures(deps: AppDeps, counters: readonly FailureCounter[]): Promise<void> {
  if (deps.config.rateLimitDisabled) return;
  for (const c of counters) {
    if (!c.fail.startsWith('pf:fail:voucher-site:')) await deps.kv.del(c.fail);
  }
}

/** Was the last session of this device on this NAS ended by a timeout? (expired notice) */
async function previousSessionExpired(
  deps: AppDeps,
  nas: RegisteredNas,
  mac: string,
  now: Date,
): Promise<boolean> {
  const since = new Date(now.getTime() - 24 * 3600 * 1000);
  const last = await withTenant(deps.db, nas.organizationId, (trx) =>
    trx
      .selectFrom('sessions')
      .select(['terminate_cause', 'stopped_at'])
      .where('nas_client_id', '=', nas.id)
      .where('mac', '=', mac)
      .where('started_at', '>=', since)
      .orderBy('started_at', 'desc')
      .limit(1)
      .executeTakeFirst(),
  );
  const cause = (last?.terminate_cause ?? '').toLowerCase().replace(/[^a-z]+/g, '_');
  return (
    last !== undefined &&
    last.stopped_at !== null &&
    (cause === 'session_timeout' || cause === 'idle_timeout')
  );
}

function contextOf(flow: PortalFlow, now: Date): HotspotContext {
  return {
    organizationId: flow.organizationId,
    siteId: flow.siteId,
    vendorKey: flow.vendorKey,
    controllerId: flow.controllerId,
    nas: { id: flow.nasId, identifier: flow.nasIdentifier, adapterKey: flow.adapterKey },
    apMac: flow.apMac,
    clientMac: flow.clientMac,
    ssid: flow.ssid,
    clientIp: flow.clientIp,
    nasSessionId: flow.sessionId,
    policyRef: null,
    deploymentMode: flow.deploymentMode,
    vendorOpaque: { raw: flow.postback?.rawQuery ?? '', fields: flow.fields },
    receivedAt: now,
  };
}

/**
 * Origin the browser may be sent to for this flow: `http://uamip:uamport` (UAM), or the
 * validated `$(link-login-only)` origin of a MikroTik flow (`http(s)://<private IPv4>:<port>`).
 */
function nasBase(flow: PortalFlow): string | null {
  if (flow.adapterKey === MIKROTIK_ADAPTER_KEY) {
    return parseMikrotikLoginTarget(flow.fields['link-login-only'])?.origin ?? null;
  }
  const ip = flow.fields.uamip ?? '';
  const port = flow.fields.uamport ?? '';
  if (!isPrivateIpv4(ip) || !/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
    return null;
  }
  return `http://${ip}:${port}`;
}

/** Cycle C: the post-back adapter + profile of a post-back flow (null = refuse). */
function postbackOf(flow: PortalFlow) {
  if (flow.postback === undefined) return null;
  const built = postbackAdapterForNas({
    adapterConfig: flow.postback.adapterConfig,
    nasIp: flow.postback.nasIp,
    hotspotAddress: flow.postback.hotspotAddress ?? null,
  });
  return built !== null && built.profile.key === flow.postback.profile ? built : null;
}

/** Cycle C: login origin (`scheme://host[:port]`) and continue URL of a post-back flow. */
function postbackView(
  flow: PortalFlow,
): { loginOrigin: string; continueUrl: string | null } | null {
  const built = postbackOf(flow);
  if (built === null || flow.postback === undefined) return null;
  const params = splitPostbackQuery(flow.postback.rawQuery).params;
  const cfg = flow.postback.adapterConfig;
  const loginUrl = resolveLoginUrl(
    built.profile,
    {
      https: typeof cfg.https === 'boolean' ? cfg.https : null,
      loginTarget: typeof cfg.login_target === 'string' ? cfg.login_target : null,
      loginHosts: Array.isArray(cfg.login_hosts)
        ? cfg.login_hosts.filter((h): h is string => typeof h === 'string')
        : [],
      nasIp: flow.postback.nasIp,
      hotspotAddress: flow.postback.hotspotAddress ?? null,
      strictLoginHosts: cfg.strict_login_hosts === true,
    },
    params,
  );
  const origin = loginUrl === null ? null : loginOriginOf(loginUrl);
  if (origin === null) return null;
  return { loginOrigin: origin, continueUrl: postbackContinueUrl(built.profile, params, loginUrl) };
}

const RedirectBody = z.object({
  flavour: z.enum(['uspot', 'chilli', 'mikrotik', 'meraki']),
  raw_query: z.string().max(8192),
  client_ip: z.string().max(64).optional(),
  /** Meraki only: the `/meraki/<nasid>/` path segment (= the NAS-Identifier registered in EZECLOUD). */
  nasid: z
    .string()
    .regex(/^[A-Za-z0-9._:-]{3,128}$/)
    .optional(),
});

/**
 * EZECLOUD login token of a Cycle C post-back flow or a Cycle E Meraki flow (required there,
 * ignored for UAM flows).
 */
const LoginTokenField = z.string().min(1).max(1024).optional();

const IdentifyBody = z.discriminatedUnion('method', [
  z.object({
    method: z.literal('password'),
    username: z.string().min(1).max(253),
    password: z.string().min(1).max(256),
    client_ip: z.string().max(64).optional(),
    login_token: LoginTokenField,
  }),
  z.object({
    method: z.literal('voucher'),
    code: z.string().min(1).max(64),
    client_ip: z.string().max(64).optional(),
    login_token: LoginTokenField,
  }),
  z.object({
    method: z.literal('click_through'),
    accept_terms: z.literal(true),
    client_ip: z.string().max(64).optional(),
    login_token: LoginTokenField,
  }),
]);

function unavailable(res: Response): void {
  res.status(503).json({ result: 'unavailable' });
}

export function portalInternalRouter(deps: AppDeps): Router {
  const now = deps.now ?? (() => new Date());
  const router = express.Router();

  /**
   * Cycle E: Meraki splash entry (`/meraki/<nasid>/`). Same contract as the UAM entry
   * (parseRedirect → validateContext → flow), but the NAS comes from the path segment, the
   * freshness value is `login_url`, and the feature is refused while MERAKI_CLOUD_RADIUS_ENABLED
   * is false (build/test only, D-043/D-044). Every refusal is the same generic error.
   */
  async function merakiRedirect(
    raw: string,
    nasid: string | undefined,
    clientIp: string | null,
    at: Date,
  ): Promise<
    { kind: 'flow'; flow_id: string; expires_at: string } | { refused: string; detail?: string }
  > {
    if (!deps.config.merakiCloudRadius.enabled) return { refused: 'meraki_cloud_radius_disabled' };
    if (nasid === undefined) return { refused: 'malformed', detail: 'no NAS path segment' };
    const adapter = getVendorAdapter(MERAKI_ADAPTER_KEY);
    const parsed = adapter.parseRedirect({ url: `/?${raw}`, method: 'GET' });
    if ('unsupported' in parsed) return { refused: 'malformed', detail: parsed.reason };
    const apMac = canonicalUnicastMac(parsed.params.ap_mac ?? parsed.params.node_mac);
    const resolved = await resolvePortal(deps, 'meraki', { nasid, apMac }, deps.logger);
    const lookup: NasLookup = {
      findNas: () => Promise.resolve(resolved?.nas ?? null),
      expectedOrganizationId: null,
      isReplay: (k) => isReplayed(deps.kv, k),
      now: () => at,
    };
    // `ecloud_nasid` is EZECLOUD-internal (from the path); the Meraki query parser ignores
    // undocumented names, so the query itself can never supply it.
    const validation = await adapter.validateContext(
      { ...parsed, params: { ...parsed.params, ecloud_nasid: nasid } },
      lookup,
    );
    if (!validation.ok || resolved === null) {
      return validation.ok
        ? { refused: 'unknown_nas' }
        : { refused: validation.reason, detail: validation.detail };
    }
    const ctx = validation.context;
    if (clientIp !== null) {
      const ipl = PORTAL_LIMITS.merakiFlowsPerIp;
      await counter(deps, `pf:rl:mflows:${clientIp}`, ipl.max, ipl.windowS);
    }
    const l = PORTAL_LIMITS.flowsPerNas;
    await counter(deps, `pf:rl:flows:${ctx.nas.id}`, l.max, l.windowS);
    const fields = ctx.vendorOpaque.fields;
    const flow: PortalFlow = {
      id: newId(),
      organizationId: ctx.organizationId,
      siteId: ctx.siteId,
      nasId: ctx.nas.id,
      nasIdentifier: ctx.nas.identifier,
      adapterKey: MERAKI_ADAPTER_KEY,
      vendorKey: ctx.vendorKey,
      deploymentMode: ctx.deploymentMode,
      controllerId: ctx.controllerId,
      captivePortalId: resolved.captivePortalId,
      clientMac: ctx.clientMac,
      apMac: ctx.apMac,
      clientIp: ctx.clientIp ?? clientIp,
      ssid: null,
      sessionId: null,
      // The vendor nonce: marked consumed when AAA accepts the credential of this flow.
      challenge: fields.login_url ?? '',
      fields,
      createdAt: at.toISOString(),
      expiresAt: new Date(at.getTime() + FLOW_TTL_S * 1000).toISOString(),
      state: 'ARRIVED',
      credentialUsername: null,
      previousSessionExpired: await previousSessionExpired(deps, resolved.nas, ctx.clientMac, at),
    };
    await saveFlow(deps.kv, flow, at);
    deps.logger.info(
      { flowId: flow.id, organizationId: flow.organizationId, nasClientId: flow.nasId },
      'portal meraki flow started',
    );
    return { kind: 'flow', flow_id: flow.id, expires_at: flow.expiresAt };
  }

  // ------------------------------------------------------------------ UAM entry + callbacks
  router.post('/redirects', async (req: Request, res: Response) => {
    const parsedBody = RedirectBody.safeParse(req.body);
    if (!parsedBody.success) {
      res.status(400).json({ kind: 'error' });
      return;
    }
    const { flavour, raw_query: raw } = parsedBody.data;
    const clientIp = clientIpOf(parsedBody.data.client_ip);
    const at = now();
    const generic = (reason: string, detail?: string) => {
      req.log.info({ reason, detail, flavour }, 'portal redirect refused');
      res.json({ kind: 'error' });
    };
    try {
      if (clientIp !== null) {
        const l = PORTAL_LIMITS.redirectsPerIp;
        await counter(deps, `pf:rl:redir:${clientIp}`, l.max, l.windowS);
      }
      if (flavour === 'meraki') {
        const result = await merakiRedirect(raw, parsedBody.data.nasid, clientIp, at);
        if ('refused' in result) {
          generic(result.refused, result.detail);
          return;
        }
        res.json(result);
        return;
      }
      // MikroTik: NAS identity = router identity (RADIUS NAS-Identifier); no AP MAC variable.
      const identity =
        flavour === 'mikrotik'
          ? { nasid: splitMikrotikQuery(raw).params.identity, apMac: null }
          : (() => {
              const split = splitUamQuery(raw);
              return {
                nasid: split.params.nasid,
                apMac: canonicalUnicastMac(split.params.called),
              };
            })();
      const resolved = await resolvePortal(deps, flavour, identity, req.log);
      const adapter = getVendorAdapter(
        resolved?.nas.adapterKey ?? UAM_FLAVOURS[flavour].adapterKeys[0],
      );
      const parsed = adapter.parseRedirect({ url: `/?${raw}`, method: 'GET' });
      if ('unsupported' in parsed) {
        generic('malformed', parsed.reason);
        return;
      }
      const callback =
        parsed.result === 'success' ||
        parsed.result === 'already' ||
        parsed.result === 'failed' ||
        parsed.result === 'logoff';
      const lookup: NasLookup = {
        findNas: () => Promise.resolve(resolved?.nas ?? null),
        expectedOrganizationId: null,
        // Callbacks legitimately repeat a consumed redirect identity (same sessionid/challenge).
        isReplay: (k) => (callback ? Promise.resolve(false) : isReplayed(deps.kv, k)),
        now: () => at,
      };
      const validation = await adapter.validateContext(parsed, lookup);
      if (!validation.ok || resolved === null) {
        generic(
          validation.ok ? 'unknown_nas' : validation.reason,
          validation.ok ? undefined : validation.detail,
        );
        return;
      }
      const ctx = validation.context;
      const indexKey = { nasId: ctx.nas.id, clientMac: ctx.clientMac, sessionId: ctx.nasSessionId };

      if (callback) {
        const flow = await findIndexedFlow(deps.kv, indexKey, at);
        if (parsed.result === 'success' || parsed.result === 'already') {
          // SECURITY §5.6: success only for a flow that handed a credential to this NAS.
          if (flow !== null && (flow.state === 'LOGON_SENT' || flow.state === 'AUTHORIZED')) {
            flow.state = 'AUTHORIZED';
            await saveFlow(deps.kv, flow, at);
            res.json({ kind: 'success', flow_id: flow.id });
            return;
          }
          if (parsed.result === 'already') {
            res.json({ kind: 'already', flow_id: null });
            return;
          }
          generic('success_without_flow');
          return;
        }
        if (parsed.result === 'failed') {
          if (flow !== null && flow.state !== 'ENDED') {
            if (flow.credentialUsername !== null) {
              await revokeCredential(deps.kv, flow.credentialUsername);
            }
            flow.state = 'REJECTED';
            flow.credentialUsername = null;
            await saveFlow(deps.kv, flow, at);
            res.json({ kind: 'failed', flow_id: flow.id });
            return;
          }
          generic('failed_without_flow');
          return;
        }
        if (flow !== null) {
          flow.state = 'ENDED';
          await saveFlow(deps.kv, flow, at);
        }
        res.json({ kind: 'logoff' });
        return;
      }

      const l = PORTAL_LIMITS.flowsPerNas;
      await counter(deps, `pf:rl:flows:${ctx.nas.id}`, l.max, l.windowS);
      const { md: _md, ...fields } = ctx.vendorOpaque.fields;
      const flowId = newId();
      // Cycle B (MikroTik, unsigned redirect): the CHAP challenge is the replay nonce; without
      // CHAP the id of an EZECLOUD login token is. The token is consumed once before a credential.
      const isMikrotik = resolved.nas.adapterKey === MIKROTIK_ADAPTER_KEY;
      const loginToken = isMikrotik
        ? issuePortalLoginToken(
            deps,
            {
              organizationId: ctx.organizationId,
              siteId: ctx.siteId,
              nasId: ctx.nas.id,
              clientMac: ctx.clientMac,
              flowId,
            },
            at,
            LOGIN_TOKEN_MAX_TTL_S,
          )
        : null;
      const chapHex = fields['chap-challenge-hex'];
      const nonce: Pick<PortalFlow, 'challenge' | 'nonceKind'> = !isMikrotik
        ? { challenge: fields.challenge ?? '' }
        : chapHex !== undefined
          ? { challenge: chapHex, nonceKind: 'vendor-nonce' }
          : { challenge: loginToken?.tokenId ?? '', nonceKind: 'ecloud-login-token' };
      const flow: PortalFlow = {
        id: flowId,
        organizationId: ctx.organizationId,
        siteId: ctx.siteId,
        nasId: ctx.nas.id,
        nasIdentifier: ctx.nas.identifier,
        adapterKey: resolved.nas.adapterKey ?? '',
        vendorKey: ctx.vendorKey,
        deploymentMode: ctx.deploymentMode,
        controllerId: ctx.controllerId,
        captivePortalId: resolved.captivePortalId,
        clientMac: ctx.clientMac,
        apMac: ctx.apMac,
        clientIp: ctx.clientIp,
        ssid: ctx.ssid,
        sessionId: ctx.nasSessionId,
        ...nonce,
        ...(loginToken !== null ? { loginToken: loginToken.token } : {}),
        fields,
        createdAt: at.toISOString(),
        expiresAt: new Date(at.getTime() + FLOW_TTL_S * 1000).toISOString(),
        state: 'ARRIVED',
        credentialUsername: null,
        previousSessionExpired: await previousSessionExpired(deps, resolved.nas, ctx.clientMac, at),
      };
      await saveFlow(deps.kv, flow, at);
      await indexFlow(deps.kv, flow);
      req.log.info(
        { flowId: flow.id, organizationId: flow.organizationId, nasClientId: flow.nasId },
        'portal flow started',
      );
      res.json({ kind: 'flow', flow_id: flow.id, expires_at: flow.expiresAt });
    } catch (error) {
      if (error instanceof RateLimited) {
        res.status(429).json({ kind: 'rate_limited', retry_after: error.retryAfter });
        return;
      }
      req.log.error({ err: error }, 'portal redirect failed: backend unavailable');
      unavailable(res);
    }
  });

  // Cycle C: external captive portal post-back redirects (portal-postback.ts).
  registerPostbackRoutes(
    router,
    deps,
    {
      counter: (key, max, windowS) => counter(deps, key, max, windowS),
      isRateLimited: (error): error is RateLimited => error instanceof RateLimited,
      limits: PORTAL_LIMITS,
      resolvePortalId: resolveExternalPortalId(deps),
      previousSessionExpired: (nas, mac, at) => previousSessionExpired(deps, nas, mac, at),
    },
    now,
  );

  // ---------------------------------------------------------------------- flow page data
  router.get('/flows/:id', async (req: Request, res: Response) => {
    const id = String(req.params.id);
    try {
      const flow = isUuid(id) ? await loadFlow(deps.kv, id, now()) : null;
      if (flow === null) {
        res.status(404).json({ result: 'flow_not_found' });
        return;
      }
      const view = await withTenant(deps.db, flow.organizationId, async (trx) => {
        const portal = await loadPortalRow(trx, flow.captivePortalId);
        if (portal === undefined || portal.status !== 'active') return null;
        // Migration 038: the published snapshot, not the draft row the designer may be editing.
        const config = await publishedConfig(deps, trx, portal);
        if (config === null) return null;
        const { snapshot } = config;
        const site = await trx
          .selectFrom('sites')
          .select(['name'])
          .where('id', '=', flow.siteId)
          .executeTakeFirst();
        const theme = snapshot.theme ?? undefined;
        let terms: { version: string; text: string } | null = null;
        if (snapshot.terms_version !== null && /^\d{1,9}$/.test(snapshot.terms_version)) {
          const row = await trx
            .selectFrom('portal_terms_versions')
            .select(['body'])
            .where('captive_portal_id', '=', portal.id)
            .where('version', '=', Number(snapshot.terms_version))
            .where('locale', '=', 'en')
            .executeTakeFirst();
          if (row !== undefined) terms = { version: snapshot.terms_version, text: row.body };
        }
        const base = nasBase(flow);
        const fallback =
          snapshot.redirect_url !== null ? safeUserUrl(snapshot.redirect_url, null) : null;
        // Cycle C: post-back flows carry the validated login origin and a fresh single-use
        // login token (consumed by identify before a credential is handed out).
        const pb = flow.postback === undefined ? undefined : postbackView(flow);
        if (pb === null) return null;
        const postback =
          pb === undefined
            ? undefined
            : {
                login_origin: pb.loginOrigin,
                login_token: issuePortalLoginToken(
                  deps,
                  {
                    organizationId: flow.organizationId,
                    siteId: flow.siteId,
                    nasId: flow.nasId,
                    clientMac: flow.clientMac,
                    flowId: flow.id,
                  },
                  now(),
                  LOGIN_TOKEN_MAX_TTL_S,
                ).token,
              };
        return {
          id: flow.id,
          state: flow.state,
          expires_at: flow.expiresAt,
          methods: config.methods,
          portal: { id: portal.id, name: snapshot.name, site_name: site?.name ?? '' },
          theme:
            theme === undefined
              ? null
              : {
                  colors: theme.colors,
                  strings: theme.strings,
                  logo_asset_id:
                    theme.logo_asset_id !== null && isUuid(theme.logo_asset_id)
                      ? theme.logo_asset_id
                      : null,
                },
          terms,
          nas: base === null ? null : { origin: base },
          ...(postback === undefined ? {} : { postback }),
          continue_url:
            (pb !== undefined
              ? pb.continueUrl
              : flow.adapterKey === MIKROTIK_ADAPTER_KEY
                ? safeUserUrl(flow.fields['link-orig'], null)
                : safeUserUrl(flow.fields.userurl, flow.fields.uamip ?? null)) ?? fallback,
          notice: flow.previousSessionExpired ? 'session_expired' : null,
          // Cycle E: Meraki flows add the hand-off origin, a fresh login token and their methods.
          ...(isMerakiFlow(flow)
            ? (() => {
                const m = merakiFlowView(deps, flow, now());
                return {
                  methods: merakiMethods(flow, config.methods),
                  meraki: {
                    mode: m.mode,
                    handoff_origin: m.handoff_origin,
                    login_token: m.login_token,
                  },
                  continue_url: m.continue_url ?? fallback,
                  notice: m.notice ?? (flow.previousSessionExpired ? 'session_expired' : null),
                };
              })()
            : {}),
        };
      });
      if (view === null) {
        res.status(404).json({ result: 'flow_not_found' });
        return;
      }
      res.json(view);
    } catch (error) {
      req.log.error({ err: error }, 'portal flow read failed');
      unavailable(res);
    }
  });

  // ------------------------------------------------------------------------ identity broker
  router.post('/flows/:id/identify', async (req: Request, res: Response) => {
    const id = String(req.params.id);
    const body = IdentifyBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ result: 'invalid' });
      return;
    }
    const input = body.data;
    const method = input.method;
    const clientIp = clientIpOf(input.client_ip);
    const at = now();
    try {
      const flow = isUuid(id) ? await loadFlow(deps.kv, id, at) : null;
      if (flow === null) {
        res.status(404).json({ result: 'flow_not_found' });
        return;
      }
      if (
        flow.state === 'AUTHORIZED' ||
        flow.state === 'ENDED' ||
        // Cycle D review F5: a vendor flow (e.g. a Mist grant in LOGON_SENT) is never re-identified
        (isVendorApiAdapterKey(flow.adapterKey) && flow.state !== 'ARRIVED')
      ) {
        res.status(409).json({ result: 'flow_state' });
        return;
      }
      if (isMerakiFlow(flow)) {
        // Cycle E: platform flag first (build/test-only feature), then the single-use login token.
        if (!deps.config.merakiCloudRadius.enabled) {
          res.status(422).json({ result: 'handoff_unavailable' });
          return;
        }
        if (!(await consumeMerakiLoginToken(deps, flow, input.login_token, at))) {
          req.log.info({ flowId: flow.id, reason: 'login_token' }, 'portal identify refused');
          res.status(403).json({ result: 'login_token_invalid' });
          return;
        }
        if (merakiMode(flow) === 'click-through' && method !== 'click_through') {
          res.status(403).json({ result: 'method_not_allowed' });
          return;
        }
      }
      const counters = failureCounters(flow, input);
      await assertNotLocked(deps, counters);
      if (clientIp !== null) {
        const l = PORTAL_LIMITS.attemptsPerIp;
        await counter(deps, `pf:rl:ip:${clientIp}`, l.max, l.windowS);
      }
      const ls = PORTAL_LIMITS.attemptsPerSite;
      await counter(deps, `pf:rl:site:${flow.siteId}`, ls.max, ls.windowS);

      // Cycle C: a post-back flow needs its EZECLOUD login token back exactly once (anti-forgery,
      // vendor/login-token.ts); the portal re-renders the form with a fresh token on refusal.
      let loginTokenId: string | null = null;
      if (flow.postback !== undefined) {
        const consumed = await consumePortalLoginToken(
          deps,
          input.login_token,
          {
            organizationId: flow.organizationId,
            siteId: flow.siteId,
            nasId: flow.nasId,
            clientMac: flow.clientMac,
            flowId: flow.id,
          },
          at,
        );
        if (!consumed.ok) {
          req.log.info({ flowId: flow.id, reason: consumed.reason }, 'portal login token refused');
          res.status(403).json({ result: 'login_token_invalid' });
          return;
        }
        loginTokenId = consumed.tokenId;
      }

      // B-3: the Argon2id verify (~45 ms CPU) runs with no pg connection held. A short tenant
      // transaction reads the credential, the verify runs outside it, and the decision
      // transaction below re-reads the user and requires the credential unchanged.
      //
      // The published snapshot is resolved HERE, in the same pre-read, not inside the decision
      // transaction. Two reasons. It is immutable once published, so reading it early cannot be
      // stale in a way that matters — §8 wants an in-progress journey to keep the version it
      // started on, which is exactly what this gives. And the decision transaction is a
      // serialisation point for concurrent identifies on one flow: adding two queries to it
      // widened the race window enough that a second concurrent submission stopped losing on the
      // flow-state guard (409, "you are already connected") and started losing on the spent
      // voucher instead (422, "sign-in failed"), which is the wrong thing to tell a guest whose
      // other tab just succeeded.
      let passwordCheck: PasswordCheck | null = null;
      const resolved = await withTenant(deps.db, flow.organizationId, async (trx) => {
        const portal = await loadPortalRow(trx, flow.captivePortalId);
        if (portal === undefined || portal.status !== 'active') return null;
        const config = await publishedConfig(deps, trx, portal);
        if (config === null) return null;
        // `looked` is separate from `user` on purpose: an UNKNOWN username must still cost one
        // Argon2id verify against the dummy hash, or response time tells an attacker which
        // usernames exist. `user: undefined` means "no such user", not "not looked up", and
        // conflating the two removed that timing floor.
        const looked = input.method === 'password' && config.methods.includes('password');
        const user = looked ? await findSubscriberByUsername(trx, input.username) : undefined;
        return { methods: config.methods, looked, user };
      });
      if (input.method === 'password' && resolved?.looked === true) {
        passwordCheck = await checkSubscriberLoginPassword(resolved.user, input.password, {
          argon2MemoryKib: deps.config.base.argon2.memoryKib,
          verify: deps.verifyPassword,
        });
      }

      type Outcome =
        | {
            ok: true;
            identity: BrokerIdentity;
            uamSecret: string | null;
            platformDefaultPortal: boolean;
          }
        | { ok: false; reason: string; status: 403 | 404 | 422 };
      const outcome: Outcome = await withTenant(deps.db, flow.organizationId, async (trx) => {
        const portal = await loadPortalRow(trx, flow.captivePortalId);
        if (portal === undefined || portal.status !== 'active') {
          return { ok: false, reason: 'portal_inactive', status: 404 } as const;
        }
        // Resolved in the pre-read above; an unpublished portal serves nothing at all.
        if (resolved === null) {
          return { ok: false, reason: 'portal_unpublished', status: 404 } as const;
        }
        // The published snapshot decides, so a method enabled only in the draft cannot be
        // submitted directly even by a client that guesses the route.
        if (!resolved.methods.includes(method)) {
          return { ok: false, reason: 'method_not_allowed', status: 403 } as const;
        }
        let identity: BrokerIdentity;
        let prefix: string | null = null;
        let failure: string | null = null;
        try {
          if (input.method === 'password') {
            prefix = input.username.slice(0, 3);
            const user = await confirmSubscriberLogin(trx, {
              username: input.username,
              check: passwordCheck,
              siteId: flow.siteId,
              now: at,
            });
            identity = { kind: 'user', userId: user.id };
          } else if (input.method === 'voucher') {
            prefix = input.code.replace(/[\s-]/g, '').toUpperCase().slice(0, 2);
            const voucher = await verifyVoucherCode(trx, {
              pepper: deps.config.voucherPepper,
              code: input.code,
              siteId: flow.siteId,
              now: at,
            });
            identity = { kind: 'voucher', voucherId: voucher.id };
          } else {
            identity = { kind: 'click_through' };
          }
        } catch (error) {
          if (!(error instanceof IdentityRejected)) throw error;
          failure = error.reason;
          identity = { kind: 'click_through' };
        }
        // Counted before the attempt row so the row can say whether it activated a lock.
        const triggeredLockout = failure !== null ? await recordFailure(deps, counters) : false;
        await trx
          .insertInto('portal_login_attempts')
          .values({
            organization_id: flow.organizationId,
            captive_portal_id: portal.id,
            method,
            username_or_code_prefix: prefix,
            mac: flow.clientMac,
            client_ip: clientIp,
            result: failure === null ? 'accept' : 'reject',
            reason: failure,
            triggered_lockout: triggeredLockout,
          })
          .execute();
        if (failure !== null) return { ok: false, reason: failure, status: 422 } as const;
        return {
          ok: true,
          identity,
          uamSecret: openUamSecret(deps, portal.uam_secret_ref),
          // Migration 041: recorded on the credential so AAA and the session know the guest was
          // admitted by a fallback portal rather than one somebody configured.
          platformDefaultPortal: portal.is_platform_default,
        };
      });

      if (!outcome.ok) {
        req.log.info(
          { flowId: flow.id, method, reason: outcome.reason },
          'portal identify refused',
        );
        const result =
          outcome.status === 422
            ? 'rejected'
            : outcome.status === 403
              ? 'method_not_allowed'
              : 'flow_not_found';
        res.status(outcome.status).json({ result });
        return;
      }
      await clearFailures(deps, counters);

      // Cycle B (post-back vendor): the flow's login token is accepted exactly once, so one
      // redirect yields at most one credential (a failed router login comes back as a new
      // redirect with a fresh CHAP challenge). Store errors are 503 (fail closed).
      if (flow.adapterKey === MIKROTIK_ADAPTER_KEY) {
        const token = await consumePortalLoginToken(
          deps,
          flow.loginToken,
          {
            organizationId: flow.organizationId,
            siteId: flow.siteId,
            nasId: flow.nasId,
            clientMac: flow.clientMac,
            flowId: flow.id,
          },
          at,
        );
        if (!token.ok) {
          req.log.info({ flowId: flow.id, reason: token.reason }, 'portal login token refused');
          res.status(422).json({ result: 'handoff_unavailable' });
          return;
        }
      }
      // Cycle D: controller-API / signed-grant vendors take no portal credential; the API
      // authorises the client at the controller (or signs the Mist grant) instead.
      // Dispatch: post-back (below, by flow.postback) / MikroTik (token above) / vendor-API here.
      if (flow.postback === undefined && isVendorApiAdapterKey(flow.adapterKey)) {
        const done = await completeVendorApiAuthorization(
          deps,
          flow,
          outcome.identity,
          at,
          req.log,
        );
        res.status(done.status).json(done.body);
        return;
      }

      if (isMerakiFlow(flow) && merakiMode(flow) === 'click-through') {
        // Meraki click-through: no RADIUS, no credential; the grant URL is the whole hand-off.
        const grant = merakiGrantHandoff(flow);
        if (grant === null) {
          res.status(422).json({ result: 'handoff_unavailable' });
          return;
        }
        flow.state = 'AUTHORIZED';
        await saveFlow(deps.kv, flow, at);
        req.log.info({ flowId: flow.id, method }, 'portal meraki grant issued');
        res.json({ result: 'ok', handoff: { method: 'GET-302', url: grant, fields: {} } });
        return;
      }

      // Identity broker: a fresh single-use credential bound to NAS + MAC + sessionid.
      if (flow.credentialUsername !== null) {
        await revokeCredential(deps.kv, flow.credentialUsername);
      }
      const pair = newCredentialPair();
      const expiresAt = new Date(at.getTime() + CREDENTIAL_TTL_S * 1000);
      const postbackAdapter = flow.postback === undefined ? null : postbackOf(flow);
      if (flow.postback !== undefined && postbackAdapter === null) {
        req.log.warn({ flowId: flow.id }, 'portal hand-off unavailable: post-back profile changed');
        res.status(422).json({ result: 'handoff_unavailable' });
        return;
      }
      // Cycle E: the Meraki sign-on hand-off carries EZECLOUD's success URL as `success_url`.
      const handoffCtx = isMerakiFlow(flow)
        ? (() => {
            const c = contextOf(flow, at);
            return {
              ...c,
              vendorOpaque: {
                ...c.vendorOpaque,
                fields: { ...flow.fields, ecloud_success_url: merakiSuccessUrl(deps) },
              },
            };
          })()
        : contextOf(flow, at);
      const handoff = (
        postbackAdapter?.adapter ?? getVendorAdapter(flow.adapterKey)
      ).authorizeSession(
        handoffCtx,
        {
          username: pair.username,
          password: pair.password,
          expiresAt,
          boundNasId: flow.nasId,
          boundClientMac: flow.clientMac,
        },
        { uamSecret: outcome.uamSecret },
      );
      if ('unsupported' in handoff || handoff.browser === undefined) {
        req.log.warn(
          { flowId: flow.id, reason: 'unsupported' in handoff ? handoff.reason : 'no browser' },
          'portal hand-off unavailable',
        );
        res.status(422).json({ result: 'handoff_unavailable' });
        return;
      }
      await storeCredential(deps.kv, {
        username: pair.username,
        passwordSha256: sha256Hex(pair.password),
        ...(outcome.platformDefaultPortal ? { platformDefaultPortal: true } : {}),
        flowId: flow.id,
        organizationId: flow.organizationId,
        siteId: flow.siteId,
        nasId: flow.nasId,
        clientMac: flow.clientMac,
        sessionId: flow.sessionId,
        replayKey: replayKey(
          flow.postback === undefined
            ? {
                // UAM challenge, Cycle B (MikroTik): the CHAP challenge as the vendor nonce, or
                // Cycle E (Meraki): its `login_url` freshness value (vendor nonce namespace).
                nasId: flow.nasId,
                sessionId: flow.sessionId,
                challenge: flow.challenge,
                clientMac: flow.clientMac,
                ...(flow.nonceKind !== undefined
                  ? { nonceKind: flow.nonceKind }
                  : isMerakiFlow(flow)
                    ? { nonceKind: 'vendor-nonce' as const }
                    : {}),
              }
            : flow.postback.vendorNonce !== null
              ? {
                  nasId: flow.nasId,
                  sessionId: null,
                  challenge: flow.postback.vendorNonce,
                  clientMac: '', // review L3: NAS + nonce only (same key as validateContext)
                  nonceKind: 'vendor-nonce',
                }
              : {
                  nasId: flow.nasId,
                  sessionId: null,
                  challenge: loginTokenId ?? '',
                  clientMac: flow.clientMac,
                  nonceKind: 'ecloud-login-token',
                },
        ),
        identity: outcome.identity,
        expiresAt: expiresAt.toISOString(),
        // MikroTik HTTP-CHAP: AAA must hand the cleartext to FreeRADIUS `chap` (contract rule 2).
        ...(flow.adapterKey === MIKROTIK_ADAPTER_KEY && flow.fields['chap-challenge-hex']
          ? {
              chapPasswordRef: sealSecretRef(
                new Envelope(deps.config.dataEncryptionKey, CHAP_CREDENTIAL_PURPOSE),
                pair.password,
              ),
            }
          : {}),
      });
      flow.state = 'LOGON_SENT';
      flow.credentialUsername = pair.username;
      await saveFlow(deps.kv, flow, at);
      req.log.info({ flowId: flow.id, method }, 'portal credential issued');
      res.json({
        result: 'ok',
        handoff: {
          method: handoff.browser.method,
          url: handoff.browser.url,
          // POST-form hand-offs (MikroTik, Cycle C post-back, Meraki) carry the fields the browser
          // submits, including the single-use credential (rendered into an auto-submitting form,
          // never logged); GET-302 ones have them in the URL already.
          ...(handoff.browser.method === 'POST-form' ? { fields: handoff.browser.fields } : {}),
        },
        expires_at: expiresAt.toISOString(),
      });
    } catch (error) {
      if (error instanceof RateLimited) {
        res.status(429).json({ result: 'rate_limited', retry_after: error.retryAfter });
        return;
      }
      req.log.error({ err: error }, 'portal identify failed: backend unavailable');
      unavailable(res);
    }
  });

  // -------------------------------------------------------------------------- status/logout
  router.get('/flows/:id/status', async (req: Request, res: Response) => {
    const id = String(req.params.id);
    try {
      const flow = isUuid(id) ? await loadFlow(deps.kv, id, now()) : null;
      if (flow === null) {
        res.status(404).json({ result: 'flow_not_found' });
        return;
      }
      const session = await withTenant(deps.db, flow.organizationId, (trx) => {
        let q = trx
          .selectFrom('sessions')
          .select(['status', 'started_at', 'input_octets', 'output_octets', 'session_time_s'])
          .where('nas_client_id', '=', flow.nasId)
          .where('mac', '=', flow.clientMac)
          .where('started_at', '>=', new Date(Date.parse(flow.createdAt)));
        if (flow.sessionId !== null) q = q.where('acct_session_id', '=', flow.sessionId);
        return q.orderBy('started_at', 'desc').limit(1).executeTakeFirst();
      });
      res.json({
        flow_state: flow.state,
        session:
          session === undefined
            ? null
            : {
                status: session.status,
                started_at: session.started_at.toISOString(),
                input_octets: String(session.input_octets),
                output_octets: String(session.output_octets),
                session_time_s: Number(session.session_time_s),
              },
      });
    } catch (error) {
      req.log.error({ err: error }, 'portal status failed');
      unavailable(res);
    }
  });

  router.post('/flows/:id/logout', async (req: Request, res: Response) => {
    const id = String(req.params.id);
    try {
      const flow = isUuid(id) ? await loadFlow(deps.kv, id, now()) : null;
      const base = flow === null ? null : nasBase(flow);
      if (flow === null || base === null) {
        res.status(404).json({ result: 'flow_not_found' });
        return;
      }
      // CP §3.3 / §7.4: `GET http://uamip:uamport/logoff` (uspot T/U and CoovaChilli);
      // MikroTik: `$(link-logout)` is `<origin>/logout` (vendor doc variable list).
      const path = flow.adapterKey === MIKROTIK_ADAPTER_KEY ? '/logout' : '/logoff';
      res.json({ result: 'ok', url: `${base}${path}` });
    } catch (error) {
      req.log.error({ err: error }, 'portal logout failed');
      unavailable(res);
    }
  });

  return router;
}
