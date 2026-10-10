/**
 * MikroTik RouterOS HotSpot vendor adapter (Cycle B, D-044; docs/VENDOR_INTEGRATION_RESEARCH.md
 * §2 F2, §3.3). Pure: no network, no I/O.
 *
 * Flow (vendor doc "Hotspot customisation", External authentication, read 2026-10-10,
 * https://help.mikrotik.com/docs/spaces/ROS/pages/87162881/Hotspot+customisation):
 *
 *  1. The router serves the ECLOUD-generated `login.html` ({@link renderMikrotikLoginHtml}). It
 *     sends the browser to the ECLOUD portal with the documented servlet variables as query
 *     parameters. The parameter NAMES are exactly the RouterOS variable names (`mac`, `ip`,
 *     `identity`, `link-login-only`, `link-orig`, `chap-id`, `chap-challenge`, `error`); each value
 *     is inserted with the documented `$(<name>-esc)` URL-escaped form. Nothing else is assumed.
 *  2. ECLOUD resolves the NAS by `identity` (= RADIUS NAS-Identifier, "Router's identity name";
 *     registered as the NAS identifier), validates the login target, issues a single-use broker
 *     credential bound to NAS + client MAC.
 *  3. The browser POSTs `username`, `password`, `dst`, `popup` (documented login.html parameters)
 *     to `$(link-login-only)`. With a `chap-id` the password is "an MD5 hash of the chap-id
 *     variable, password, and CHAP challenge" ({@link computeMikrotikChapPassword}); without it,
 *     plain PAP, which ECLOUD sends only to an `https:` login target (research §3.3).
 *
 * `$(chap-id)` / `$(chap-challenge)` are octal-escaped byte strings in the vendor doc examples
 * ("\371", "\357\015\330..."): {@link decodeMikrotikOctal} turns them into bytes. Whether the
 * `-esc` form preserves the backslashes exactly is REQUIRES_DEVICE_TEST.
 *
 * Anti-forgery: the redirect is static and unsigned. The CHAP challenge (when present) is the
 * replay nonce (`vendor-nonce`); without CHAP an ECLOUD login token (Cycle A) is the nonce. The
 * real gate stays the RADIUS binding: the credential only works in an Access-Request from the
 * registered router (packet source + per-NAS secret) for the bound client MAC.
 */
import { createHash } from 'node:crypto';
import type { EvidenceRef } from '@ecloud/shared';
import {
  MIKROTIK_DEFAULT_COA_PORT,
  MIKROTIK_HOTSPOT_CUSTOMISATION_DOC,
  MIKROTIK_HOTSPOT_DOC,
  MIKROTIK_RADIUS_DOC,
} from '../adapters/mikrotik-hotspot.js';
import type { Unsupported } from '../types.js';
import { normalizeMacAddress } from './accounting.js';
import type {
  AuthorizationHandoff,
  AuthorizationPlan,
  BrokerCredential,
  ContextValidation,
  HotspotContext,
  NasLookup,
  ParsedRedirect,
  SetupStep,
  VendorAdapter,
} from './types.js';
import { isPrivateIpv4, safeUserUrl } from './uam.js';

export const MIKROTIK_VENDOR_KEY = 'mikrotik';
export const MIKROTIK_ADAPTER_KEY = 'mikrotik-hotspot';
/** Portal entry the generated login.html redirects to (portal app + API flavour `mikrotik`). */
export const MIKROTIK_PORTAL_PATH = '/hotspot/mikrotik/';

/**
 * RouterOS servlet variables carried in the redirect (names verbatim from the vendor doc's
 * variable list). Unknown parameters are ignored; duplicates are refused.
 */
export const MIKROTIK_REDIRECT_PARAMS = [
  'mac',
  'ip',
  'identity',
  'link-login-only',
  'link-orig',
  'chap-id',
  'chap-challenge',
  'error',
] as const;

/** Documented login.html POST parameters (vendor doc "Available Pages" → login.html). */
export const MIKROTIK_LOGIN_FIELDS = ['username', 'password', 'dst', 'popup'] as const;

const unsupported = (reason: string): Unsupported => ({ unsupported: true, reason });

// ------------------------------------------------------------------------------------------
// CHAP (vendor doc: MD5(chap-id ‖ password ‖ chap-challenge); RFC 1994 §4.1 response shape)
// ------------------------------------------------------------------------------------------

const OCTAL_RE = /^(?:\\[0-3][0-7]{2})+$/;

/**
 * `"\371"` → `<Buffer f9>`. Only the strict `\ooo` form the vendor doc shows is accepted
 * (anything else → null, fail closed).
 */
export function decodeMikrotikOctal(value: string | undefined): Buffer | null {
  if (value === undefined || value.length === 0 || value.length > 4 * 64) return null;
  if (!OCTAL_RE.test(value)) return null;
  const bytes: number[] = [];
  for (let i = 0; i < value.length; i += 4) bytes.push(parseInt(value.slice(i + 1, i + 4), 8));
  return Buffer.from(bytes);
}

/** Lowercase hex MD5(id ‖ password ‖ challenge) — the value login.html's `hexMD5` produces. */
export function computeMikrotikChapPassword(
  chapId: Buffer,
  password: string,
  challenge: Buffer,
): string {
  if (chapId.length !== 1) throw new RangeError('chap-id must be exactly one byte');
  if (challenge.length === 0) throw new RangeError('chap-challenge must not be empty');
  return createHash('md5')
    .update(Buffer.concat([chapId, Buffer.from(password, 'latin1'), challenge]))
    .digest('hex');
}

// ------------------------------------------------------------------------------------------
// Login target ($(link-login-only)) — a browser target only, never fetched by ECLOUD
// ------------------------------------------------------------------------------------------

export interface MikrotikLoginTarget {
  /** Normalised URL the form posts to. */
  readonly url: string;
  /** `scheme://host:port` (explicit port) for the portal's form-action CSP. */
  readonly origin: string;
  readonly https: boolean;
}

const LOGIN_PATH_RE = /^(?:\/[A-Za-z0-9_-]{1,32})?\/login$/;

/**
 * Accepts `http(s)://<RFC 1918 / RFC 6598 IPv4>[:port]/login` (optionally under one language
 * sub-directory, vendor doc "/lv/login"), no credentials, query or fragment. A HotSpot `dns-name`
 * host is NOT accepted in Cycle B (REQUIRES_CLARIFICATION: needs the registered name per NAS).
 */
export function parseMikrotikLoginTarget(raw: string | undefined): MikrotikLoginTarget | null {
  if (raw === undefined || raw.length === 0 || raw.length > 512 || raw.includes('\\')) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '')
    return null;
  if (!isPrivateIpv4(url.hostname)) return null;
  if (!LOGIN_PATH_RE.test(url.pathname)) return null;
  const https = url.protocol === 'https:';
  const port = url.port === '' ? (https ? '443' : '80') : url.port;
  const origin = `${url.protocol}//${url.hostname}:${port}`;
  return { url: `${origin}${url.pathname}`, origin, https };
}

/** Registered browser login address of the NAS (review F1). */
export interface LoginTargetBinding {
  readonly address: string;
  readonly port: number | null;
}

/** Context field carrying the binding from validation to the hand-off (server-set only). */
export const HOTSPOT_BINDING_FIELD = 'ecloud:hotspot-address';

/** `nas.hotspotAddress` (+ port) as a binding; null when not registered / not private IPv4. */
export function loginTargetBinding(nas: {
  readonly hotspotAddress?: string | null;
  readonly hotspotPort?: number | null;
}): LoginTargetBinding | null {
  const address = (nas.hotspotAddress ?? '').replace(/\/32$/, '');
  if (!isPrivateIpv4(address)) return null;
  const port = nas.hotspotPort ?? null;
  if (port !== null && (!Number.isInteger(port) || port < 1 || port > 65535)) return null;
  return { address, port };
}

/** Exact host match; the port must match when one is registered. */
export function targetMatchesBinding(
  target: MikrotikLoginTarget,
  binding: LoginTargetBinding,
): boolean {
  const u = new URL(target.url);
  if (u.hostname !== binding.address) return false;
  if (binding.port === null) return true;
  const port = u.port === '' ? (target.https ? 443 : 80) : Number(u.port);
  return port === binding.port;
}

function bindingText(b: LoginTargetBinding): string {
  return b.port === null ? b.address : `${b.address}:${String(b.port)}`;
}

function parseBindingText(value: string | undefined): LoginTargetBinding | null {
  if (value === undefined) return null;
  const m = /^(\d{1,3}(?:\.\d{1,3}){3})(?::(\d{1,5}))?$/.exec(value);
  if (m === null || m[1] === undefined) return null;
  return loginTargetBinding({
    hotspotAddress: m[1],
    hotspotPort: m[2] === undefined ? null : Number(m[2]),
  });
}

// ------------------------------------------------------------------------------------------
// Redirect parsing / validation
// ------------------------------------------------------------------------------------------

export interface MikrotikQuery {
  readonly params: Readonly<Record<string, string>>;
  readonly duplicates: readonly string[];
}

/** Decodes the query (form encoding); keeps only the documented names. */
export function splitMikrotikQuery(rawQuery: string): MikrotikQuery {
  const params: Record<string, string> = {};
  const duplicates: string[] = [];
  const allowed = new Set<string>(MIKROTIK_REDIRECT_PARAMS);
  for (const [k, v] of new URLSearchParams(rawQuery)) {
    if (!allowed.has(k)) continue;
    if (k in params) duplicates.push(k);
    else params[k] = v;
  }
  return { params, duplicates };
}

/** CHAP material of a redirect: both present and well-formed, or both absent. */
export function mikrotikChap(
  params: Readonly<Record<string, string>>,
): { readonly id: Buffer; readonly challenge: Buffer } | null | 'malformed' {
  const rawId = params['chap-id'] ?? '';
  const rawChallenge = params['chap-challenge'] ?? '';
  if (rawId === '' && rawChallenge === '') return null;
  const id = decodeMikrotikOctal(rawId);
  const challenge = decodeMikrotikOctal(rawChallenge);
  if (id === null || challenge === null || id.length !== 1 || challenge.length < 8)
    return 'malformed';
  return { id, challenge };
}

function fail(
  reason: Exclude<ContextValidation, { ok: true }>['reason'],
  detail: string,
): ContextValidation {
  return { ok: false, reason, detail };
}

async function validateMikrotikContext(
  parsed: ParsedRedirect,
  lookup: NasLookup,
): Promise<ContextValidation> {
  const split = splitMikrotikQuery(parsed.rawQuery);
  if (split.duplicates.length > 0)
    return fail('malformed', `duplicate parameter(s): ${split.duplicates.join(', ')}`);
  const p = split.params;
  const missing = (['mac', 'identity', 'link-login-only'] as const).filter((k) => !p[k]);
  if (missing.length > 0) return fail('malformed', `missing parameter(s): ${missing.join(', ')}`);
  const clientMac = normalizeMacAddress(p.mac);
  if (clientMac === null) return fail('malformed', 'client MAC is not a MAC address');
  const chap = mikrotikChap(p);
  if (chap === 'malformed') return fail('malformed', 'chap-id / chap-challenge malformed');
  const target = parseMikrotikLoginTarget(p['link-login-only']);
  if (target === null)
    return fail(
      'private_address_required',
      'link-login-only must be http(s)://<private IPv4>[:port]/login',
    );

  // NAS identity: the router identity = RADIUS NAS-Identifier (vendor doc). No AP MAC exists
  // in the RouterOS variable set, so none is used.
  const nas = await lookup.findNas({ nasid: p.identity ?? null, called: null, apMac: null });
  if (!nas) return fail('unknown_nas', 'no registered NAS for this router identity');
  if (nas.adapterKey !== MIKROTIK_ADAPTER_KEY)
    return fail('unknown_nas', `NAS is registered for adapter ${String(nas.adapterKey)}`);
  if (lookup.expectedOrganizationId === undefined)
    return fail('tenant_mismatch', 'caller did not state the expected organization (fail closed)');
  if (
    lookup.expectedOrganizationId !== null &&
    lookup.expectedOrganizationId !== nas.organizationId
  )
    return fail('tenant_mismatch', 'NAS belongs to another organization');

  // Review F1: the login target must be the NAS's REGISTERED HotSpot address (and port when
  // registered). Otherwise anyone on the LAN could name their own host and receive the
  // victim's CHAP response (replayable to the real router) or a PAP password.
  const binding = loginTargetBinding(nas);
  if (binding === null)
    return fail('unknown_nas', 'NAS has no registered hotspot_address (fail closed)');
  if (!targetMatchesBinding(target, binding))
    return fail(
      'private_address_required',
      'link-login-only is not the registered hotspot address',
    );

  if (typeof lookup.isReplay !== 'function')
    return fail('replayed', 'no replay check configured (fail closed)');
  if (
    chap !== null &&
    (await lookup.isReplay({
      nasId: nas.id,
      sessionId: null,
      challenge: chap.challenge.toString('hex'),
      clientMac,
      nonceKind: 'vendor-nonce',
    }))
  )
    return fail('replayed', 'CHAP challenge already consumed');

  const fields: Record<string, string> = {
    ...p,
    'link-login-only': target.url,
    // Server-side binding re-checked at hand-off (not a RouterOS variable, so a query can never
    // supply it: splitMikrotikQuery keeps documented names only).
    [HOTSPOT_BINDING_FIELD]: bindingText(binding),
  };
  if (chap !== null) fields['chap-challenge-hex'] = chap.challenge.toString('hex');
  return {
    ok: true,
    context: {
      organizationId: nas.organizationId,
      siteId: nas.siteId,
      vendorKey: MIKROTIK_VENDOR_KEY,
      controllerId: nas.controllerId,
      nas: { id: nas.id, identifier: nas.identifier, adapterKey: nas.adapterKey },
      apMac: null,
      clientMac,
      ssid: null,
      clientIp: p.ip !== undefined && isPrivateIpv4(p.ip) ? p.ip : null,
      nasSessionId: null,
      policyRef: null,
      deploymentMode: nas.deploymentMode,
      vendorOpaque: { raw: parsed.rawQuery, fields },
      receivedAt: lookup.now ? lookup.now() : new Date(),
    },
  };
}

/**
 * Browser POST hand-off to `$(link-login-only)`: CHAP when the router issued a chap-id, PAP only
 * to an https target (research §3.3: never a cleartext password over http).
 */
export function authorizeMikrotikSession(
  ctx: HotspotContext,
  credential: BrokerCredential,
): AuthorizationHandoff | Unsupported {
  if (ctx.nas.adapterKey !== MIKROTIK_ADAPTER_KEY)
    return unsupported(`context NAS uses adapter ${String(ctx.nas.adapterKey)}, not mikrotik`);
  if (credential.boundNasId !== ctx.nas.id || credential.boundClientMac !== ctx.clientMac)
    return unsupported('credential is not bound to this NAS and client (SECURITY §5.6)');
  if (credential.expiresAt.getTime() <= ctx.receivedAt.getTime())
    return unsupported('credential expired before the hand-off (single-use, TTL 90 s)');
  const f = ctx.vendorOpaque.fields;
  const target = parseMikrotikLoginTarget(f['link-login-only']);
  if (target === null) return unsupported('link-login-only missing or not a private LAN target');
  const binding = parseBindingText(f[HOTSPOT_BINDING_FIELD]);
  if (binding === null || !targetMatchesBinding(target, binding))
    return unsupported('login target is not the registered hotspot address of the NAS');
  const chap = mikrotikChap(f);
  if (chap === 'malformed') return unsupported('chap-id / chap-challenge malformed');
  let password: string;
  if (chap !== null) {
    password = computeMikrotikChapPassword(chap.id, credential.password, chap.challenge);
  } else if (target.https) {
    password = credential.password;
  } else {
    return unsupported(
      'no chap-id and an http login target: cleartext PAP refused (enable login-by=http-chap or https)',
    );
  }
  const fields: Record<string, string> = {
    username: credential.username,
    password,
    dst: safeUserUrl(f['link-orig'], null) ?? '',
    popup: 'false',
  };
  if (fields.dst === '') delete fields.dst;
  return {
    strategy: 'browser-form',
    browser: { method: 'POST-form', url: target.url, fields },
    state: 'pending',
  };
}

// ------------------------------------------------------------------------------------------
// Generated artefacts + setup guide
// ------------------------------------------------------------------------------------------

/** URL-escape-safe template query: `name=$(name-esc)` for each redirect variable. */
export function mikrotikRedirectTemplateQuery(): string {
  return MIKROTIK_REDIRECT_PARAMS.map((n) => `${n}=$(${n}-esc)`).join('&');
}

/**
 * The `login.html` ECLOUD generates for the router's HotSpot HTML directory. Static (the router
 * fills the `$(...)` variables): a meta refresh plus a plain link, no script, no secret.
 * `portalUrl` must be an absolute https URL ending in {@link MIKROTIK_PORTAL_PATH}.
 */
export function renderMikrotikLoginHtml(portalUrl: string): string {
  const u = new URL(portalUrl);
  if (u.protocol !== 'https:' || !u.pathname.endsWith(MIKROTIK_PORTAL_PATH) || u.search !== '')
    throw new RangeError(`portal URL must be https://…${MIKROTIK_PORTAL_PATH} without a query`);
  const href = `${u.origin}${u.pathname}?${mikrotikRedirectTemplateQuery()}`.replace(/&/g, '&amp;');
  return [
    '<!doctype html>',
    '<html><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    `<meta http-equiv="refresh" content="0; url=${href}">`,
    '<title>Wi-Fi login</title></head>',
    `<body><p><a href="${href}">Continue to the Wi-Fi login page</a></p></body></html>`,
    '',
  ].join('\n');
}

const F2: EvidenceRef = {
  kind: 'doc-section',
  ref: 'docs/VENDOR_INTEGRATION_RESEARCH.md §3.3, §5 (mikrotik-hotspot setup guide)',
};
const HC = [MIKROTIK_HOTSPOT_CUSTOMISATION_DOC, F2];
const HS = [MIKROTIK_HOTSPOT_DOC, F2];
const RAD = [MIKROTIK_RADIUS_DOC, F2];

function step(
  id: string,
  title: string,
  setting: string,
  value: string,
  refs: readonly EvidenceRef[],
): SetupStep {
  return { id, title, setting, value, evidenceRefs: refs };
}

/** RouterOS CLI steps; every address and secret is a placeholder (D-033). */
export function mikrotikSetupGuide(portalOrigin: string): readonly SetupStep[] {
  const portalHost = new URL(portalOrigin).host;
  return [
    step(
      'identity',
      'Router identity = the NAS identifier registered in ECLOUD (sent as RADIUS NAS-Identifier; a different value is rejected)',
      '/system identity set name=',
      '<REGISTERED_NAS_IDENTIFIER>',
      RAD,
    ),
    step(
      'radius-server',
      'RADIUS server for the HotSpot service (authentication + accounting); keep require-message-auth at its default yes-for-request-resp',
      '/radius add service=hotspot address= secret= authentication-port= accounting-port= src-address=',
      '<ECLOUD_RADIUS_ADDRESS>, <RADIUS_SECRET>, 1812, 1813, <REGISTERED_NAS_IP>',
      RAD,
    ),
    step(
      'radius-incoming',
      `Accept Disconnect / CoA from ECLOUD (default accept=no). ECLOUD sends to the NAS CoA port, default ${String(MIKROTIK_DEFAULT_COA_PORT)} for this adapter (REQUIRES_DEVICE_TEST, D-006)`,
      '/radius incoming set accept=yes port=',
      `<DAS_PORT> (RouterOS default ${String(MIKROTIK_DEFAULT_COA_PORT)})`,
      RAD,
    ),
    step(
      'hotspot-profile',
      'HotSpot server profile: RADIUS authentication + accounting, interim interval from RADIUS, HTTP-CHAP login (no cookie login: ECLOUD credentials are single use); add https only with a router certificate',
      '/ip hotspot profile set <HOTSPOT_PROFILE> use-radius= radius-accounting= radius-interim-update= login-by=',
      'yes, yes, received, http-chap',
      HS,
    ),
    step(
      'walled-garden',
      'Walled garden: the ECLOUD portal and the identity-provider hosts the tenant enabled',
      '/ip hotspot walled-garden add dst-host=',
      `${portalHost}, <IDP_HOSTS>`,
      HS,
    ),
    step(
      'login-html',
      'Replace login.html in the profile html-directory with the ECLOUD-generated file (redirects to the ECLOUD portal with the RouterOS variables; no secret inside)',
      '/ip hotspot profile html-directory → login.html',
      `<ECLOUD_GENERATED_LOGIN_HTML> (redirect target ${portalOrigin}${MIKROTIK_PORTAL_PATH})`,
      HC,
    ),
    step(
      'ecloud-nas',
      'Register the router in ECLOUD: adapter mikrotik-hotspot, NAS IP = RADIUS source address, NAS identifier = router identity, hotspot address = the router HotSpot interface IP (the host of its login page; ECLOUD posts logins nowhere else), CoA port 1700 unless changed above',
      'ECLOUD NAS {nas_ip, nas_identifier, adapter_key, hotspot_address, hotspot_port?, coa_port}',
      `<REGISTERED_NAS_IP>, <REGISTERED_NAS_IDENTIFIER>, mikrotik-hotspot, <HOTSPOT_INTERFACE_IP>, <LOGIN_PORT_IF_NOT_80_443>, ${String(MIKROTIK_DEFAULT_COA_PORT)}`,
      [F2],
    ),
    step(
      'ecloud-portal',
      'ECLOUD captive portal of type mikrotik for the site (optionally pinned to this NAS)',
      'ECLOUD captive portal {portal_type, nas_client_id}',
      'mikrotik, <NAS_ID>',
      [F2],
    ),
  ];
}

/** Composes the MikroTik behaviour onto the engine-backed wrapper (first-party.ts). */
export function withMikrotikHotspot(base: VendorAdapter, portalOrigin: string): VendorAdapter {
  const engine = base.engine;
  return {
    ...base,
    vendorKey: MIKROTIK_VENDOR_KEY,
    strategies: ['browser-form'],
    parseRedirect(req): ParsedRedirect | Unsupported {
      if (req.method.toUpperCase() !== 'GET')
        return unsupported('MikroTik login.html redirects are GET requests');
      const q = req.url.indexOf('?');
      const hash = req.url.indexOf('#', q < 0 ? 0 : q);
      const rawQuery = q < 0 ? '' : req.url.slice(q + 1, hash < 0 ? undefined : hash);
      return {
        vendorKey: MIKROTIK_VENDOR_KEY,
        params: splitMikrotikQuery(rawQuery).params,
        rawQuery,
        signature: { kind: 'none', value: null },
        result: 'notyet',
      };
    },
    validateContext: validateMikrotikContext,
    authorizeSession: (ctx, credential) => authorizeMikrotikSession(ctx, credential),
    buildAuthorization(ctx, identity, effective, tctx): AuthorizationPlan | Unsupported {
      const handoff = authorizeMikrotikSession(ctx, identity);
      if ('unsupported' in handoff) return handoff;
      if (engine === null) return unsupported('no engine adapter');
      const enforcement = engine.translate(effective, tctx);
      return {
        enforcement,
        replyAttributes: engine.buildReplyAttributes(enforcement),
        handoff,
        gatewaySuggestion: null,
      };
    },
    buildSetupGuide() {
      return mikrotikSetupGuide(portalOrigin);
    },
  };
}
