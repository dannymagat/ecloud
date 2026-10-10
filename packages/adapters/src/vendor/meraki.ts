/**
 * `meraki-splash` vendor adapter pieces (multi-vendor Cycle E, D-044; docs/VENDOR_INTEGRATION_RESEARCH.md
 * §3.5). Pure: no network, no DB, no logging. ECLOUD NEVER fetches a Meraki URL; `login_url` and
 * `base_grant_url` are browser targets only.
 *
 * Redirect parameters, ONLY as documented (no other name is read):
 *  - Sign-on splash (Meraki Developer Hub "Captive Portal with Sign on API logic"; Meraki doc
 *    "Configuring a Custom-Hosted Splash Page to Work with the Meraki Cloud"):
 *      `login_url` (opaque, "must be used exactly as provided"), `continue_url`, `ap_mac`,
 *      `ap_name`, `ap_tags`, `client_ip`, `client_mac`; on a RADIUS error Meraki sends the
 *      client back to the splash page with `error_message`.
 *    Completion: browser POST to `login_url` with `username`, `password` and `success_url`
 *    (`success_url` takes precedence over `continue_url`; Meraki appends `logout_url` to it).
 *  - Click-through splash (Developer Hub "Captive Portal with Click-through API logic"):
 *      `base_grant_url`, `user_continue_url`, `node_id`, `node_mac`, `gateway_id`, `client_ip`,
 *      `client_mac`. Completion: browser GET `base_grant_url?continue_url=…[&duration=<s>]`,
 *      duration ≤ 2592000 s. No RADIUS: ECLOUD enforces nothing beyond `duration`.
 *
 * Host allow-list: the documented examples are `https://n143.network-auth.com/splash/login?mauth=…`
 * and `https://n143.network-auth.com/splash/grant`. Only `https://n<digits>.network-auth.com` (no
 * userinfo, no explicit port) is accepted; any other Meraki host is REQUIRES_CLARIFICATION and is
 * refused (open-redirect / SSRF guard: the portal only ever renders a form/redirect to an
 * allow-listed host and the CSP `form-action` names exactly that origin).
 */
import { canonicalUnicastMac, type EvidenceRef } from '@ecloud/shared';
import type { EffectivePolicy, TranslationContext } from '@ecloud/policy-engine';
import { isIP } from 'node:net';
import { MERAKI_DOCS } from '../adapters/meraki-splash.js';
import type { SessionRef, Unsupported } from '../types.js';
import type {
  AuthorizationHandoff,
  AuthorizationPlan,
  BrokerCredential,
  ContextValidation,
  HandoffSecrets,
  HotspotContext,
  NasLookup,
  ParsedRedirect,
  SetupStep,
  VendorAdapter,
} from './types.js';
import { safeUserUrl } from './uam.js';

export const MERAKI_VENDOR_KEY = 'cisco-meraki';
export const MERAKI_ADAPTER_KEY = 'meraki-splash';

/** Documented sign-on redirect parameters (Developer Hub sign-on table + `error_message`). */
export const MERAKI_SIGN_ON_PARAMS = [
  'login_url',
  'continue_url',
  'ap_mac',
  'ap_name',
  'ap_tags',
  'client_ip',
  'client_mac',
  'error_message',
] as const;
/** Documented click-through redirect parameters (Developer Hub click-through table). */
export const MERAKI_CLICK_THROUGH_PARAMS = [
  'base_grant_url',
  'user_continue_url',
  'node_id',
  'node_mac',
  'gateway_id',
  'client_ip',
  'client_mac',
] as const;

/** Developer Hub click-through: "duration … Max = 2592000". */
export const MERAKI_MAX_GRANT_DURATION_S = 2_592_000;
const MAX_QUERY = 8192;
const MAX_URL = 4096;

/** Documented host shape of `login_url` / `base_grant_url` (examples use n143). */
const NETWORK_AUTH_HOST = /^n[0-9]{1,6}\.network-auth\.com$/;
/** Documented dashboard host shape for Disconnect ("n165.meraki.com", UDP 3799). */
export const MERAKI_DAS_HOST_RE = /^n[0-9]{1,6}\.meraki\.com$/;
/** NAS-Identifier accepted for a Meraki NAS (DB CHECK ck_nas_clients_meraki_identifier). */
export const MERAKI_NAS_IDENTIFIER_RE = /^[A-Za-z0-9._:-]{3,128}$/;

const unsupported = (reason: string): Unsupported => ({ unsupported: true, reason });

/**
 * Strict allow-list check of a Meraki-hosted browser target (`login_url`, `base_grant_url`):
 * https, host `n<digits>.network-auth.com`, default port, no userinfo, no backslash, no fragment.
 * Returns the URL string EXACTLY as received (Meraki: "must not be modified") or null.
 */
export function merakiHostedUrl(raw: string | undefined | null): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_URL) return null;
  if (raw.includes('\\') || /[\s"'<>]/.test(raw) || raw.includes('#')) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (url.username !== '' || url.password !== '' || url.port !== '') return null;
  if (!NETWORK_AUTH_HOST.test(url.hostname)) return null;
  // The parsed host must also be what the raw string literally starts with (no IDN / case tricks).
  if (!raw.startsWith(`https://${url.hostname}/`)) return null;
  return raw;
}

/** `https://n<digits>.network-auth.com` origin of an allow-listed URL (CSP form-action). */
export function merakiOrigin(allowListed: string): string {
  return new URL(allowListed).origin;
}

export type MerakiRedirect =
  | {
      readonly mode: 'sign-on';
      readonly loginUrl: string;
      readonly continueUrl: string | null;
      readonly apMac: string | null;
      readonly apName: string | null;
      readonly clientMac: string;
      readonly clientIp: string | null;
      /** Present when Meraki returned the client after a RADIUS reject (display: generic text only). */
      readonly hadError: boolean;
    }
  | {
      readonly mode: 'click-through';
      readonly baseGrantUrl: string;
      readonly continueUrl: string | null;
      readonly apMac: string | null;
      readonly clientMac: string;
      readonly clientIp: string | null;
    };

export type MerakiRedirectResult =
  | {
      readonly ok: true;
      readonly redirect: MerakiRedirect;
      readonly params: Record<string, string>;
    }
  | { readonly ok: false; readonly reason: string };

/**
 * Parses the raw query Meraki appended to the custom splash URL. Fails closed on duplicates,
 * on both or neither of `login_url` / `base_grant_url`, on a non-allow-listed host and on a
 * missing / non-unicast `client_mac`. Unknown parameters are ignored (never echoed).
 */
export function parseMerakiRedirect(rawQuery: string): MerakiRedirectResult {
  if (rawQuery.length > MAX_QUERY) return { ok: false, reason: 'query too long' };
  const search = new URLSearchParams(rawQuery);
  const documented = new Set<string>([...MERAKI_SIGN_ON_PARAMS, ...MERAKI_CLICK_THROUGH_PARAMS]);
  const params: Record<string, string> = {};
  for (const [k, v] of search) {
    if (!documented.has(k)) continue;
    if (Object.hasOwn(params, k)) return { ok: false, reason: `duplicate parameter ${k}` };
    params[k] = v;
  }
  const signOn = params.login_url !== undefined;
  const grant = params.base_grant_url !== undefined;
  if (signOn === grant) {
    return { ok: false, reason: 'exactly one of login_url / base_grant_url is required' };
  }
  const clientMac = canonicalUnicastMac(params.client_mac);
  if (clientMac === null) return { ok: false, reason: 'client_mac missing or not a unicast MAC' };
  const clientIp =
    params.client_ip !== undefined && isIP(params.client_ip) !== 0 ? params.client_ip : null;
  if (signOn) {
    const loginUrl = merakiHostedUrl(params.login_url);
    if (loginUrl === null) return { ok: false, reason: 'login_url host is not allow-listed' };
    return {
      ok: true,
      params,
      redirect: {
        mode: 'sign-on',
        loginUrl,
        continueUrl: safeUserUrl(params.continue_url, null),
        apMac: canonicalUnicastMac(params.ap_mac),
        apName: params.ap_name !== undefined ? params.ap_name.slice(0, 128) : null,
        clientMac,
        clientIp,
        hadError: params.error_message !== undefined,
      },
    };
  }
  const baseGrantUrl = merakiHostedUrl(params.base_grant_url);
  if (baseGrantUrl === null || baseGrantUrl.includes('?')) {
    return { ok: false, reason: 'base_grant_url host is not allow-listed' };
  }
  return {
    ok: true,
    params,
    redirect: {
      mode: 'click-through',
      baseGrantUrl,
      continueUrl: safeUserUrl(params.user_continue_url, null),
      apMac: canonicalUnicastMac(params.node_mac),
      clientMac,
      clientIp,
    },
  };
}

function portalUrl(raw: string): string | null {
  if (raw.length > MAX_URL || raw.includes('\\') || /[\s"'<>]/.test(raw)) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (url.username !== '' || url.password !== '') return null;
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * Sign-on completion (documented): POST `username`, `password`, `success_url` to `login_url`.
 * `success_url` is the ECLOUD portal's own page (Meraki appends `logout_url`).
 */
export function buildMerakiSignOnHandoff(input: {
  readonly loginUrl: string;
  readonly username: string;
  readonly password: string;
  readonly successUrl: string | null;
}): AuthorizationHandoff | Unsupported {
  const url = merakiHostedUrl(input.loginUrl);
  if (url === null) return unsupported('login_url is not a Meraki-hosted URL (allow-list)');
  if (input.username.length === 0 || input.password.length === 0) {
    return unsupported('credential missing');
  }
  const fields: Record<string, string> = { username: input.username, password: input.password };
  if (input.successUrl !== null) {
    // Built server-side from the ECLOUD portal origin (https in production, D-039); never from
    // the query, so only its shape is checked (no userinfo, no backslash, http(s)).
    const success = portalUrl(input.successUrl);
    if (success === null) return unsupported('success_url must be an http(s) ECLOUD portal URL');
    fields.success_url = success;
  }
  return {
    strategy: 'browser-form',
    browser: { method: 'POST-form', url, fields },
    state: 'pending',
  };
}

/** Click-through completion (documented): GET `base_grant_url?continue_url=…[&duration=…]`. */
export function buildMerakiGrantUrl(input: {
  readonly baseGrantUrl: string;
  readonly continueUrl: string | null;
  readonly durationS?: number | null;
}): string | null {
  const base = merakiHostedUrl(input.baseGrantUrl);
  if (base === null || base.includes('?')) return null;
  const q = new URLSearchParams();
  const cont = safeUserUrl(input.continueUrl ?? undefined, null);
  if (cont !== null) q.set('continue_url', cont);
  const d = input.durationS;
  if (d !== undefined && d !== null) {
    if (!Number.isInteger(d) || d < 1 || d > MERAKI_MAX_GRANT_DURATION_S) return null;
    q.set('duration', String(d));
  }
  const qs = q.toString();
  return qs === '' ? base : `${base}?${qs}`;
}

// ------------------------------------------------------------------------------------------
// Setup guide (Meraki Dashboard; ECLOUD wording; placeholders only)
// ------------------------------------------------------------------------------------------

const F4: EvidenceRef = {
  kind: 'doc-section',
  ref: 'docs/VENDOR_INTEGRATION_RESEARCH.md §3.5 (meraki-splash)',
};
const SEC36: EvidenceRef = {
  kind: 'doc-section',
  ref: 'SECURITY_ARCHITECTURE.md §3.5 (cloud-sourced RADIUS trust model)',
};

function step(
  id: string,
  title: string,
  setting: string,
  value: string,
  refs: readonly EvidenceRef[],
): SetupStep {
  return { id, title, setting, value, evidenceRefs: refs };
}

/**
 * Meraki Dashboard steps. Menu labels are quoted from Meraki documentation as factual
 * identifiers; the text is ECLOUD's own. Every value is a placeholder that the API resolves for
 * display (never a secret: the RADIUS secret is shown once at NAS creation / rotation).
 */
export function merakiSetupGuide(): readonly SetupStep[] {
  return [
    step(
      'platform-flag',
      'ECLOUD platform: Meraki cloud RADIUS must be enabled (MERAKI_CLOUD_RADIUS_ENABLED) and the listener ports publicly reachable from the Meraki Cloud. OFF by default; the LAN-only pilot (D-043) does not allow it.',
      'MERAKI_CLOUD_RADIUS_ENABLED',
      '<MERAKI_CLOUD_RADIUS_STATE>',
      [SEC36],
    ),
    step(
      'splash-mode',
      'Dashboard > Wireless > Configure > Access control, select the SSID: Splash page = "Sign-on with my RADIUS server"',
      'Access control > Splash page',
      'Sign-on with my RADIUS server',
      [F4, MERAKI_DOCS.radiusSignOn],
    ),
    step(
      'radius-auth',
      'RADIUS servers: add the ECLOUD RADIUS server (public address, this NAS’s dedicated port, this NAS’s secret). Meraki sends these requests from the Meraki Cloud, not from the access point.',
      'Access control > RADIUS servers {Host, Port, Secret}',
      '<ECLOUD_RADIUS_PUBLIC_ADDRESS>, <MERAKI_AUTH_PORT>, <RADIUS_SECRET>',
      [F4, MERAKI_DOCS.radiusSignOn, SEC36],
    ),
    step(
      'radius-acct',
      'RADIUS accounting servers: same host and secret, this NAS’s accounting port. Meraki notes that splash RADIUS accounting may have to be enabled by Meraki support.',
      'Access control > RADIUS accounting servers {Host, Port, Secret}',
      '<ECLOUD_RADIUS_PUBLIC_ADDRESS>, <MERAKI_ACCT_PORT>, <RADIUS_SECRET>',
      [F4, MERAKI_DOCS.radiusAccounting],
    ),
    step(
      'nas-identifier',
      'NAS-Identifier: ECLOUD rejects any request whose NAS-Identifier differs from the value registered for this NAS. Set a custom NAS-ID if your Dashboard offers it (whether splash requests carry it is REQUIRES_DEVICE_TEST).',
      'NAS-Identifier',
      '<NAS_IDENTIFIER>',
      [F4, SEC36],
    ),
    step(
      'custom-splash-url',
      'Splash page: custom splash URL = the ECLOUD portal URL of this NAS (Meraki appends login_url, continue_url, ap_mac, client_mac, client_ip)',
      'Splash page > Custom splash URL',
      '<PORTAL_MERAKI_URL>',
      [F4, MERAKI_DOCS.customSplash],
    ),
    step(
      'after-splash',
      'Where should users go after the splash page: "The URL they were trying to fetch" (needed for continue_url)',
      'Splash page > Where should users go after the splash page',
      'The URL they were trying to fetch',
      [MERAKI_DOCS.customSplash],
    ),
    step(
      'walled-garden',
      'Walled garden: allow the ECLOUD portal (Meraki may require an IP address instead of a host name unless Meraki support enables walled-garden domain names)',
      'Access control > Walled garden ranges',
      '<PORTAL_HOST>',
      [F4, MERAKI_DOCS.customSplash],
    ),
    step(
      'source-ranges',
      'Meraki Cloud source addresses: read them from Dashboard > Help > Firewall info and give them to the ECLOUD platform operator (MERAKI_RADIUS_SOURCE_CIDRS). They may change over time.',
      'Help > Firewall info',
      '<MERAKI_SOURCE_CIDRS>',
      [MERAKI_DOCS.radiusSignOn],
    ),
    step(
      'disconnect',
      'Disconnect (CoA): Meraki listens for RFC 5176 Disconnect only, on UDP 3799 of your dashboard host (the nNNN.meraki.com name in the Dashboard browser URL); register it in ECLOUD as the Disconnect host. CoA attribute changes are not supported by Meraki. REQUIRES_DEVICE_TEST.',
      'ECLOUD NAS > Disconnect host',
      '<MERAKI_DAS_HOST>:3799',
      [F4, MERAKI_DOCS.disconnect],
    ),
    step(
      'message-authenticator',
      'Message-Authenticator: ECLOUD requires it on every Access-Request by default (BlastRADIUS). Whether the Meraki Cloud sends it is REQUIRES_DEVICE_TEST; relaxing it is a per-NAS decision.',
      'require_message_authenticator',
      '<REQUIRE_MESSAGE_AUTHENTICATOR>',
      [SEC36],
    ),
  ];
}

// ------------------------------------------------------------------------------------------
// VendorAdapter overrides on top of the generic first-party wrapper
// ------------------------------------------------------------------------------------------

/**
 * Returns `base` (the first-party wrapper of the `meraki-splash` engine) with the Meraki redirect
 * parsing, context validation and sign-on hand-off. `validateContext` resolves the NAS by the
 * `nasid` path segment ECLOUD put in the custom splash URL (the caller passes it as the
 * ECLOUD-internal `ecloud_nasid` param; the query parser never reads undocumented names, so a
 * query cannot set it) and uses `login_url` as the vendor nonce (`nonceKind: 'vendor-nonce'`).
 * The redirect is unsigned: the ECLOUD login token (vendor/login-token.ts) guards the identify
 * step, and a forged redirect only yields a credential usable through the registered NAS's own
 * listener and secret, for the bound client MAC (SECURITY §3.5).
 */
export function withMerakiSplash(base: VendorAdapter): VendorAdapter {
  const authorizeSession = (
    ctx: HotspotContext,
    credential: BrokerCredential,
    _secrets?: HandoffSecrets,
  ): AuthorizationHandoff | Unsupported => {
    if (ctx.nas.adapterKey !== MERAKI_ADAPTER_KEY) {
      return unsupported(`context NAS uses adapter ${String(ctx.nas.adapterKey)}`);
    }
    if (credential.boundNasId !== ctx.nas.id || credential.boundClientMac !== ctx.clientMac) {
      return unsupported('credential is not bound to this NAS and client (SECURITY §5.6)');
    }
    if (credential.expiresAt.getTime() <= ctx.receivedAt.getTime()) {
      return unsupported('credential expired before the hand-off');
    }
    const f = ctx.vendorOpaque.fields;
    if (f.login_url === undefined) {
      return unsupported('click-through flows carry no credential (use the grant URL)');
    }
    return buildMerakiSignOnHandoff({
      loginUrl: f.login_url,
      username: credential.username,
      password: credential.password,
      successUrl: f.ecloud_success_url ?? null,
    });
  };

  return {
    ...base,
    vendorKey: MERAKI_VENDOR_KEY,
    strategies: ['browser-form'],

    parseRedirect(req): ParsedRedirect | Unsupported {
      if (req.method.toUpperCase() !== 'GET') return unsupported('Meraki redirects are GET');
      const q = req.url.indexOf('?');
      const rawQuery = q < 0 ? '' : req.url.slice(q + 1);
      const parsed = parseMerakiRedirect(rawQuery);
      if (!parsed.ok) return unsupported(parsed.reason);
      return {
        vendorKey: MERAKI_VENDOR_KEY,
        params: parsed.params,
        rawQuery,
        signature: { kind: 'none', value: null },
        // A Meraki `error_message` return is NOT a UAM callback: it starts a fresh flow whose
        // page shows a generic failure notice (the vendor text is never echoed).
        result: null,
      };
    },

    async validateContext(parsed, lookup: NasLookup): Promise<ContextValidation> {
      const r = parseMerakiRedirect(parsed.rawQuery);
      if (!r.ok) return { ok: false, reason: 'malformed', detail: r.reason };
      const nasid = parsed.params.ecloud_nasid ?? null;
      if (nasid === null || !MERAKI_NAS_IDENTIFIER_RE.test(nasid)) {
        return { ok: false, reason: 'malformed', detail: 'missing ECLOUD NAS path segment' };
      }
      const nas = await lookup.findNas({ nasid, called: null, apMac: r.redirect.apMac });
      if (!nas) return { ok: false, reason: 'unknown_nas', detail: 'no registered Meraki NAS' };
      if (nas.adapterKey !== MERAKI_ADAPTER_KEY) {
        return { ok: false, reason: 'unknown_nas', detail: 'NAS is not a Meraki NAS' };
      }
      if (lookup.expectedOrganizationId === undefined) {
        return { ok: false, reason: 'tenant_mismatch', detail: 'no expected organization' };
      }
      if (
        lookup.expectedOrganizationId !== null &&
        lookup.expectedOrganizationId !== nas.organizationId
      ) {
        return { ok: false, reason: 'tenant_mismatch', detail: 'NAS of another organization' };
      }
      // Freshness: the sign-on `login_url` carries Meraki's per-redirect opaque `mauth` token
      // (research §3 "contract gaps": `login_url` is the Meraki vendor nonce). Click-through has
      // no nonce and issues no credential, so it has nothing to replay.
      if (typeof lookup.isReplay !== 'function') {
        return {
          ok: false,
          reason: 'replayed',
          detail: 'no replay check configured (fail closed)',
        };
      }
      if (
        r.redirect.mode === 'sign-on' &&
        (await lookup.isReplay({
          nasId: nas.id,
          sessionId: null,
          challenge: r.redirect.loginUrl,
          clientMac: r.redirect.clientMac,
          nonceKind: 'vendor-nonce',
        }))
      ) {
        return { ok: false, reason: 'replayed', detail: 'login_url already used' };
      }
      const fields: Record<string, string> = { ...r.params };
      return {
        ok: true,
        context: {
          organizationId: nas.organizationId,
          siteId: nas.siteId,
          vendorKey: MERAKI_VENDOR_KEY,
          controllerId: nas.controllerId,
          nas: { id: nas.id, identifier: nas.identifier, adapterKey: nas.adapterKey },
          apMac: r.redirect.apMac,
          clientMac: r.redirect.clientMac,
          ssid: null,
          clientIp: r.redirect.clientIp,
          nasSessionId: null,
          policyRef: null,
          deploymentMode: nas.deploymentMode,
          vendorOpaque: { raw: parsed.rawQuery, fields },
          receivedAt: lookup.now ? lookup.now() : new Date(),
        },
      };
    },

    buildAuthorization(
      ctx: HotspotContext,
      identity: BrokerCredential,
      effective: EffectivePolicy,
      tctx: TranslationContext,
      secrets?: HandoffSecrets,
    ): AuthorizationPlan | Unsupported {
      const handoff = authorizeSession(ctx, identity, secrets);
      if ('unsupported' in handoff) return handoff;
      if (base.engine === null) return unsupported('no engine adapter');
      const enforcement = base.engine.translate(effective, tctx);
      return {
        enforcement,
        replyAttributes: base.engine.buildReplyAttributes(enforcement),
        handoff,
        gatewaySuggestion: null,
      };
    },

    authorizeSession,

    revokeSession(session: SessionRef) {
      return base.revokeSession(session);
    },

    buildSetupGuide() {
      return merakiSetupGuide();
    },
  };
}
