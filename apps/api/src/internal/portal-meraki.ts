/**
 * Meraki splash pieces of the internal portal API (multi-vendor Cycle E, D-044;
 * docs/VENDOR_INTEGRATION_RESEARCH.md §3.5; SECURITY_ARCHITECTURE.md §3.5). Used by portal.ts.
 *
 *  - Entry: the custom splash URL is `https://<portal>/meraki/<NAS-Identifier>/`; Meraki appends
 *    its documented parameters. The portal forwards the raw query plus the path segment.
 *  - Anti-forgery: the redirect is unsigned. (1) `login_url` is the vendor nonce (replay store,
 *    marked consumed when AAA accepts the credential); (2) every credential form carries an
 *    ECLOUD login token (vendor/login-token.ts) bound to {org, site, NAS, client MAC, flow},
 *    single use, consumed before any identity check; (3) the broker credential is bound to the
 *    NAS and client MAC and is only accepted on that NAS's own listener with its own secret.
 *  - Hand-off: an auto-submitted POST form to the allow-listed `login_url` (sign-on) or a 302 to
 *    the allow-listed `base_grant_url` (click-through). ECLOUD never fetches either URL.
 */
import {
  LOGIN_TOKEN_MAX_TTL_S,
  buildMerakiGrantUrl,
  merakiHostedUrl,
  merakiOrigin,
  safeUserUrl,
} from '@ecloud/adapters';
import type { AppDeps } from '../context.js';
import { consumePortalLoginToken, issuePortalLoginToken } from './login-token-store.js';
import type { PortalFlow } from './portal-store.js';

export const MERAKI_ADAPTER_KEY = 'meraki-splash';
/** Captive portal record serving Meraki NAS (`captive_portals.portal_type`, migration 006). */
export const MERAKI_PORTAL_TYPE = 'external' as const;
/** Portal path (API_ARCHITECTURE.md "Portal public"). */
export const MERAKI_PORTAL_PATH = '/meraki/';
/** ECLOUD page Meraki redirects to after a successful sign-on (`success_url`). */
export const MERAKI_SUCCESS_PATH = '/meraki-done';

export function isMerakiFlow(flow: Pick<PortalFlow, 'adapterKey'>): boolean {
  return flow.adapterKey === MERAKI_ADAPTER_KEY;
}

export function merakiMode(flow: PortalFlow): 'sign-on' | 'click-through' {
  return flow.fields.login_url !== undefined ? 'sign-on' : 'click-through';
}

/** Methods offered: click-through splash has no RADIUS, so only "accept terms" makes sense. */
export function merakiMethods<T extends string>(flow: PortalFlow, enabled: readonly T[]): T[] {
  return merakiMode(flow) === 'click-through'
    ? enabled.filter((m) => m === 'click_through')
    : [...enabled];
}

/** Extra flow-view fields for the portal page (no secret; the login token authorises nothing alone). */
export interface MerakiFlowView {
  vendor: 'meraki';
  mode: 'sign-on' | 'click-through';
  handoff_origin: string | null;
  login_token: string;
  continue_url: string | null;
  notice: 'login_failed' | null;
}

export function merakiFlowView(deps: AppDeps, flow: PortalFlow, now: Date): MerakiFlowView {
  const target =
    merakiMode(flow) === 'sign-on'
      ? merakiHostedUrl(flow.fields.login_url)
      : merakiHostedUrl(flow.fields.base_grant_url);
  const token = issuePortalLoginToken(
    deps,
    {
      organizationId: flow.organizationId,
      siteId: flow.siteId,
      nasId: flow.nasId,
      clientMac: flow.clientMac,
      flowId: flow.id,
    },
    now,
    LOGIN_TOKEN_MAX_TTL_S,
  );
  return {
    vendor: 'meraki' as const,
    mode: merakiMode(flow),
    /** CSP form-action / redirect origin; null when the stored target fails the allow-list. */
    handoff_origin: target === null ? null : merakiOrigin(target),
    login_token: token.token,
    continue_url:
      safeUserUrl(flow.fields.continue_url ?? flow.fields.user_continue_url, null) ?? null,
    notice: flow.fields.error_message !== undefined ? ('login_failed' as const) : null,
  };
}

/** Consumes the login token of an identify call; false = refuse (generic 403 at the portal). */
export async function consumeMerakiLoginToken(
  deps: AppDeps,
  flow: PortalFlow,
  token: unknown,
  now: Date,
): Promise<boolean> {
  const result = await consumePortalLoginToken(
    deps,
    token,
    {
      organizationId: flow.organizationId,
      siteId: flow.siteId,
      nasId: flow.nasId,
      clientMac: flow.clientMac,
      flowId: flow.id,
    },
    now,
  );
  return result.ok;
}

export function merakiSuccessUrl(deps: AppDeps): string {
  return `${deps.config.base.origins.portal.replace(/\/+$/, '')}${MERAKI_SUCCESS_PATH}`;
}

/** Click-through hand-off: GET base_grant_url?continue_url=… (no credential, no RADIUS). */
export function merakiGrantHandoff(flow: PortalFlow): string | null {
  return buildMerakiGrantUrl({
    baseGrantUrl: flow.fields.base_grant_url ?? '',
    continueUrl: flow.fields.user_continue_url ?? null,
  });
}
