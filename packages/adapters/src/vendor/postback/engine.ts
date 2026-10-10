/**
 * F3 `external-portal-postback` engine (Cycle C, D-044; docs/VENDOR_INTEGRATION_RESEARCH.md
 * §2 F3, §3 "common to all families", §3.4). One `VendorAdapter` implementation, driven by a
 * profile (profiles.ts) and the NAS's validated `adapter_config` (config.ts):
 *
 *  1. `parseRedirect`: keeps the raw query byte-for-byte; decoded values are display copies.
 *     The NAS identifier may come from the ECLOUD portal URL path (`/pb/<profile>/<nasid>/`).
 *  2. `validateContext`: NAS resolved server-side (nasid when present, otherwise a VERIFIED AP
 *     MAC — enforced by the injected `findNas`), adapter + profile must match the registered
 *     NAS, tenant check, the login URL must name the AP / controller (private IPv4, the
 *     registered NAS address, an operator-configured login host, or a documented vendor
 *     intercept name; never an arbitrary site), and the vendor nonce (if any) is not replayed.
 *  3. `authorizeSession`: the single-use broker credential (`pc-…`, bound to NAS + client MAC)
 *     goes into a browser form posted to the validated login URL; ECLOUD never fetches it.
 *
 * The ECLOUD login token (vendor/login-token.ts) is issued and consumed by the API around the
 * credential issue; this module is pure (no network, no store, no logging).
 */
import { canonicalUnicastMac, type EvidenceRef } from '@ecloud/shared';
import type { EffectivePolicy, TranslationContext } from '@ecloud/policy-engine';
import { getAdapter } from '../../registry.js';
import { COMPATIBILITY_ROWS } from '../../registry/compatibility.js';
import { deriveCells, presentCells } from '../../registry/derive.js';
import { DT_RESULTS } from '../../registry/dt-results.js';
import type { SessionRef, Unsupported } from '../../types.js';
import { normalizeAccounting, normalizeMacAddress } from '../accounting.js';
import type {
  AuthorizationHandoff,
  AuthorizationPlan,
  BrokerCredential,
  CapabilityReport,
  ContextValidation,
  HandoffSecrets,
  HealthReport,
  HotspotContext,
  NasLookup,
  ParsedRedirect,
  SetupStep,
  SiteSignals,
  VendorAdapter,
} from '../types.js';
import { safeUserUrl } from '../uam.js';
import { normalizeLoginHost, parsePostbackNasConfig, profileForConfig } from './config.js';
import {
  GENERIC_POSTBACK_PROFILE_KEY,
  POSTBACK_ADAPTER_KEY,
  type PostbackLoginTarget,
  type PostbackProfile,
} from './profiles.js';

/** Portal host per CAPTIVE_PORTAL_ARCHITECTURE.md §7.4 (same constant as first-party.ts). */
const PORTAL_ORIGIN = 'https://portal.ezecloud.ezelink.ai';

export const POSTBACK_PATH_PREFIX = '/pb/';
/** Profile key in the portal path. */
export const POSTBACK_PROFILE_SEGMENT_RE = /^[a-z][a-z0-9-]{1,39}$/;
/** NAS identifier in the portal path (a strict subset of `nas_identifier`). */
export const POSTBACK_NASID_SEGMENT_RE = /^[A-Za-z0-9._:-]{1,64}$/;

const MAX_QUERY = 4096;
const MAX_LOGIN_URL = 512;
const MAX_VALUE = 1024;

const unsupported = (reason: string): Unsupported => ({ unsupported: true, reason });

// ------------------------------------------------------------------------------------------
// Query handling
// ------------------------------------------------------------------------------------------

export interface PostbackQuery {
  /** First value of each parameter, decoded (display / lookup copies). */
  readonly params: Readonly<Record<string, string>>;
  /** First value of each parameter exactly as received (opaque tokens). */
  readonly rawValues: Readonly<Record<string, string>>;
  readonly duplicates: readonly string[];
}

function decode(value: string): string | null {
  try {
    return decodeURIComponent(value.replace(/\+/g, ' '));
  } catch {
    return null;
  }
}

/** Splits a raw query on `&`; undecodable names/values are kept raw and reported as such. */
export function splitPostbackQuery(rawQuery: string): PostbackQuery {
  // Review L2: prototype-less maps, so `constructor` / `toString` / `__proto__` are plain names.
  const params = Object.create(null) as Record<string, string>;
  const rawValues = Object.create(null) as Record<string, string>;
  const duplicates = new Set<string>();
  for (const part of rawQuery.split('&')) {
    if (part === '') continue;
    const eq = part.indexOf('=');
    const rawName = eq < 0 ? part : part.slice(0, eq);
    const rawValue = eq < 0 ? '' : part.slice(eq + 1);
    const name = decode(rawName) ?? rawName;
    if (Object.hasOwn(params, name)) {
      duplicates.add(name);
      continue;
    }
    params[name] = decode(rawValue) ?? rawValue;
    rawValues[name] = rawValue;
  }
  return { params, rawValues, duplicates: [...duplicates] };
}

function pick(
  q: Readonly<Record<string, string>>,
  names: readonly string[] | undefined,
): { name: string; value: string } | null {
  for (const n of names ?? []) {
    const v = own(q, n);
    if (v !== undefined && v !== '') return { name: n, value: v };
  }
  return null;
}

/** Own-property read (review L2): inherited names (`constructor`, `toString`) are absent. */
function own(q: Readonly<Record<string, string>>, name: string): string | undefined {
  if (!Object.hasOwn(q, name)) return undefined;
  const v: unknown = q[name];
  return typeof v === 'string' ? v : undefined;
}

/** `/pb/<profile>[/<nasid>][/]?query` → parts; any other path = query only. */
export function parsePostbackPath(url: string): {
  profile: string | null;
  pathNasId: string | null;
  rawQuery: string;
  ok: boolean;
} {
  const q = url.indexOf('?');
  const hash = url.indexOf('#', q < 0 ? 0 : q);
  const rawQuery = q < 0 ? '' : url.slice(q + 1, hash < 0 ? undefined : hash);
  const path = q < 0 ? (hash < 0 ? url : url.slice(0, hash)) : url.slice(0, q);
  if (!path.startsWith(POSTBACK_PATH_PREFIX))
    return { profile: null, pathNasId: null, rawQuery, ok: true };
  const segs = path.slice(POSTBACK_PATH_PREFIX.length).split('/');
  if (segs[segs.length - 1] === '') segs.pop();
  const [profile, nasid, ...rest] = segs;
  if (profile === undefined || !POSTBACK_PROFILE_SEGMENT_RE.test(profile) || rest.length > 0)
    return { profile: null, pathNasId: null, rawQuery, ok: false };
  if (nasid !== undefined && !POSTBACK_NASID_SEGMENT_RE.test(nasid))
    return { profile, pathNasId: null, rawQuery, ok: false };
  return { profile, pathNasId: nasid ?? null, rawQuery, ok: true };
}

// ------------------------------------------------------------------------------------------
// Login URL validation (never an arbitrary site; browser target only, never fetched)
// ------------------------------------------------------------------------------------------

export interface LoginUrlRules {
  readonly schemes: readonly ('http' | 'https')[];
  /** Exact port (null / absent = scheme default) unless `ports` is given. */
  readonly port?: number | null;
  /** Allowed effective ports (review M1: documented ports only; never "any"). */
  readonly ports?: readonly number[];
  /**
   * Review M2: only `allowedHosts` / `interceptHosts`, no "any private IPv4" (the operator
   * enabled strict login hosts).
   */
  readonly strictHosts?: boolean;
  readonly path: RegExp | string;
  /** Exact extra hosts (registered NAS address, operator login hosts). */
  readonly allowedHosts: ReadonlySet<string>;
  /** Documented vendor-intercepted DNS names. */
  readonly interceptHosts: readonly string[];
  readonly allowQuery?: boolean;
}

const DEFAULT_PORT = { http: 80, https: 443 } as const;

/**
 * RFC 1918 only (review M2): the CGNAT / WireGuard range 100.64.0.0/10 is not a login-page
 * address class; such an address must be the registered NAS IP or a configured login host.
 */
export function isRfc1918Ipv4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if ([m[1], m[2], m[3], m[4]].some((o) => Number(o) > 255)) return false;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/**
 * Accepts `raw` only when it is an http(s) URL without credentials or fragment whose host is a
 * private (RFC 1918 / RFC 6598) IPv4 address, an allowed host, or a documented intercept name;
 * loopback, link-local / metadata, unspecified, multicast, IPv6 and public hosts are refused.
 * Returns the normalised URL or null.
 */
export function checkLoginUrl(raw: string, rules: LoginUrlRules): string | null {
  if (raw.length === 0 || raw.length > MAX_LOGIN_URL) return null;
  // Backslashes and control / space characters are normalised differently by browsers.
  if (raw.includes('\\') || /\s/.test(raw)) return null;
  for (let i = 0; i < raw.length; i += 1) {
    const c = raw.charCodeAt(i);
    if (c < 0x21 || c === 0x7f) return null;
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const scheme = url.protocol.replace(/:$/, '');
  if (scheme !== 'http' && scheme !== 'https') return null;
  if (!rules.schemes.includes(scheme)) return null;
  if (url.username !== '' || url.password !== '' || url.hash !== '') return null;
  if (raw.includes('#')) return null;
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (host.startsWith('[') || host.includes(':')) return null; // IPv6 literal
  const isIpv4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
  let hostOk = false;
  if (isIpv4) {
    hostOk = rules.allowedHosts.has(host) || (rules.strictHosts !== true && isRfc1918Ipv4(host));
    if (normalizeLoginHost(host) === null) hostOk = false;
  } else {
    hostOk =
      normalizeLoginHost(host) !== null &&
      (rules.interceptHosts.includes(host) || rules.allowedHosts.has(host));
  }
  if (!hostOk) return null;
  const effectivePort = url.port === '' ? DEFAULT_PORT[scheme] : Number(url.port);
  if (rules.ports !== undefined) {
    if (!rules.ports.includes(effectivePort)) return null;
  } else if (effectivePort !== (rules.port ?? DEFAULT_PORT[scheme])) return null;
  const pathOk =
    typeof rules.path === 'string' ? url.pathname === rules.path : rules.path.test(url.pathname);
  if (!pathOk) return null;
  if (url.search !== '' && (rules.allowQuery !== true || url.search.length > 256)) return null;
  return url.toString();
}

export interface PostbackOptions {
  readonly https: boolean | null;
  readonly loginTarget: string | null;
  readonly loginHosts: readonly string[];
  /** Registered `nas_clients.nas_ip` (a valid login host). */
  readonly nasIp: string | null;
  /**
   * Cycle B/C merge: registered `nas_clients.hotspot_address` (the NAS's browser login address),
   * also a known NAS login host (strict mode included). Absent / null = none registered.
   */
  readonly hotspotAddress?: string | null;
  /** Review M2: only the NAS IP / login hosts / intercept names (when any is known). */
  readonly strictLoginHosts?: boolean;
}

export const DEFAULT_POSTBACK_OPTIONS: PostbackOptions = Object.freeze({
  https: null,
  loginTarget: null,
  loginHosts: [],
  nasIp: null,
});

function allowedHosts(options: PostbackOptions): Set<string> {
  const set = new Set<string>();
  for (const h of options.loginHosts) {
    const n = normalizeLoginHost(h);
    if (n !== null) set.add(n);
  }
  const ip = options.nasIp === null ? null : normalizeLoginHost(options.nasIp.replace(/\/32$/, ''));
  if (ip !== null) set.add(ip);
  const hotspot =
    options.hotspotAddress === undefined || options.hotspotAddress === null
      ? null
      : normalizeLoginHost(options.hotspotAddress.replace(/\/32$/, ''));
  if (hotspot !== null) set.add(hotspot);
  return set;
}

function targetOf(profile: PostbackProfile, options: PostbackOptions): PostbackLoginTarget | null {
  const name = options.loginTarget ?? profile.defaultLoginTarget;
  return Object.prototype.hasOwnProperty.call(profile.loginTargets, name)
    ? (profile.loginTargets[name] ?? null)
    : null;
}

/** The validated login URL for this redirect, or null (refused). */
export function resolveLoginUrl(
  profile: PostbackProfile,
  options: PostbackOptions,
  params: Readonly<Record<string, string>>,
): string | null {
  const target = targetOf(profile, options);
  if (target === null) return null;
  const hosts = allowedHosts(options);
  const intercept = profile.interceptHosts;
  // Strict mode applies once there is something to be strict about (NAS IP or login hosts).
  const strictHosts = options.strictLoginHosts === true && hosts.size > 0;
  if (target.kind === 'fixed-url') {
    return checkLoginUrl(target.url, {
      schemes: ['https', 'http'],
      path: new URL(target.url).pathname,
      allowedHosts: hosts,
      interceptHosts: intercept,
      port: null,
      strictHosts,
    });
  }
  const value = own(params, target.param);
  if (value === undefined || value === '' || value.length > MAX_LOGIN_URL) return null;
  if (target.kind === 'param-url') {
    return checkLoginUrl(value, {
      schemes: target.schemes,
      ports: target.ports,
      path: target.path,
      allowedHosts: hosts,
      interceptHosts: intercept,
      allowQuery: true,
      strictHosts,
    });
  }
  // param-host: the parameter must be a bare host (no scheme, path, port, credentials).
  const host = normalizeLoginHost(value);
  if (host === null || host !== value.trim().toLowerCase().replace(/\.$/, '')) return null;
  let useHttps = options.https ?? profile.httpsDefault;
  if (target.schemeParam !== undefined) {
    const s = own(params, target.schemeParam);
    if (s === 'https') useHttps = true;
    else if (s === 'http') useHttps = false;
    else if (s !== undefined && s !== '') return null;
  }
  if (useHttps && target.https === null) useHttps = false;
  if (!useHttps && target.http === null) useHttps = true;
  const def = useHttps ? target.https : target.http;
  if (def === null) return null;
  let port = def.port;
  const portValue = target.portParam === undefined ? undefined : own(params, target.portParam);
  if (portValue !== undefined) {
    if (!/^\d{1,5}$/.test(portValue) || Number(portValue) < 1 || Number(portValue) > 65535)
      return null;
    port = Number(portValue);
  }
  const scheme = useHttps ? 'https' : 'http';
  const candidate = `${scheme}://${host}${port === null ? '' : `:${String(port)}`}${target.path}`;
  return checkLoginUrl(candidate, {
    schemes: [scheme],
    ...(target.allowedPorts === undefined ? { port } : { ports: target.allowedPorts }),
    path: target.path,
    allowedHosts: hosts,
    interceptHosts: intercept,
    strictHosts,
  });
}

// ------------------------------------------------------------------------------------------
// Hand-off
// ------------------------------------------------------------------------------------------

/** Form fields of the post-back (constants, echoed vendor fields, credential, continue URL). */
export function buildPostbackFields(
  profile: PostbackProfile,
  params: Readonly<Record<string, string>>,
  credential: { readonly username: string; readonly password: string },
  continueUrl: string | null,
): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const [k, v] of Object.entries(profile.fields.constants ?? {})) fields[k] = v;
  for (const [field, names] of Object.entries(profile.fields.echo ?? {})) {
    const hit = pick(params, names);
    if (hit !== null && hit.value.length <= MAX_VALUE) fields[field] = hit.value;
  }
  if (profile.fields.continueUrl !== undefined && continueUrl !== null)
    fields[profile.fields.continueUrl] = continueUrl;
  fields[profile.fields.username] = credential.username;
  fields[profile.fields.password] = credential.password;
  return fields;
}

function loginHostOf(loginUrl: string): string | null {
  try {
    return new URL(loginUrl).hostname;
  } catch {
    return null;
  }
}

export function postbackContinueUrl(
  profile: PostbackProfile,
  params: Readonly<Record<string, string>>,
  loginUrl: string | null,
): string | null {
  const hit = pick(params, profile.params.continueUrl);
  return safeUserUrl(hit?.value, loginUrl === null ? null : loginHostOf(loginUrl));
}

/** Raw vendor nonce of a redirect (replay identity), or null when the profile has none. */
export function postbackVendorNonce(profile: PostbackProfile, rawQuery: string): string | null {
  const q = splitPostbackQuery(rawQuery);
  return pick(q.rawValues, profile.params.vendorToken)?.value ?? null;
}

/** Origin (`scheme://host[:port]`) of a validated login URL. */
export function loginOriginOf(loginUrl: string): string | null {
  try {
    return new URL(loginUrl).origin;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------------------------------
// Setup guide (ECLOUD wording; filled values; placeholders for every secret)
// ------------------------------------------------------------------------------------------

function guideStep(
  id: string,
  title: string,
  setting: string,
  value: string,
  refs: readonly EvidenceRef[],
): SetupStep {
  return { id, title, setting, value, evidenceRefs: refs };
}

export function postbackPortalUrl(profileKey: string, nasIdentifier: string | null): string {
  const nas =
    nasIdentifier !== null && POSTBACK_NASID_SEGMENT_RE.test(nasIdentifier)
      ? `${nasIdentifier}/`
      : '<NAS_IDENTIFIER>/';
  return `${PORTAL_ORIGIN}${POSTBACK_PATH_PREFIX}${profileKey}/${nas}`;
}

function vendorSteps(profile: PostbackProfile, nasId: string): SetupStep[] {
  const ev = profile.evidence;
  const portalUrl = postbackPortalUrl(profile.key, nasId);
  switch (profile.key) {
    case 'cambium-hotspot':
      return [
        guideStep(
          'cambium-portal-mode',
          'Guest Access: send guests to an external hotspot',
          'Guest Access > Portal Mode',
          'External Hotspot',
          ev,
        ),
        guideStep(
          'cambium-access-policy',
          'Guests are authorised by RADIUS (ECLOUD)',
          'Guest Access > Access Policy',
          'Radius',
          ev,
        ),
        guideStep(
          'cambium-external-url',
          'External portal URL (ECLOUD)',
          'Guest Access > External Portal URL',
          portalUrl,
          ev,
        ),
        guideStep(
          'cambium-server-protocol',
          'Protocol the browser uses to post back to the AP (HTTPS needs a trusted AP certificate)',
          'AP Server Protocol',
          'HTTP (port 880); HTTPS (port 444) only with https=true in ECLOUD',
          ev,
        ),
        guideStep(
          'cambium-nas-id',
          'WLAN NAS-ID = the ECLOUD NAS identifier (sent as ga_nas_id)',
          'WLAN > RADIUS > NAS-ID',
          nasId,
          ev,
        ),
      ];
    case 'aruba-ecp':
      return [
        guideStep(
          'aruba-ecp-profile',
          'External captive portal profile: ECLOUD portal host, HTTPS, port 443',
          'External Captive Portal > Server / URL / Port / Use HTTPS',
          portalUrl,
          ev,
        ),
        guideStep(
          'aruba-auth',
          'Authentication through RADIUS (ECLOUD); the AP posts to securelogin.arubanetworks.com',
          'Captive portal type / Authentication server',
          'RADIUS Authentication, <ECLOUD_RADIUS_ADDRESS>',
          ev,
        ),
        guideStep(
          'aruba-url-hash',
          'Leave url-hash-key unset (algorithm not documented; ECLOUD cannot verify it)',
          'url-hash-key',
          '<UNSET>',
          ev,
        ),
        guideStep(
          'aruba-redirect-options',
          'AOS 8 only: include AP MAC and switch IP in the redirection URL; set login_target=switchip in ECLOUD',
          'ap-mac-in-redirection-url, switchip-in-redirection-url',
          'enabled',
          ev,
        ),
      ];
    case 'cisco-webauth':
      return [
        guideStep(
          'cisco-param-map',
          'Web-auth parameter map: type webauth, ECLOUD portal as login URL',
          'parameter-map type webauth <NAME> > redirect for-login',
          portalUrl,
          ev,
        ),
        guideStep(
          'cisco-append',
          'Append the AP MAC, client MAC and SSID with exactly these names',
          'redirect append ap-mac tag / client-mac tag / wlan-ssid tag',
          'ap_mac, client_mac, ssid',
          ev,
        ),
        guideStep(
          'cisco-virtual-ip',
          'Virtual IP: add it to the ECLOUD NAS login hosts unless it is an RFC 1918 address',
          'virtual-ip ipv4',
          '<VIRTUAL_IP>',
          ev,
        ),
        guideStep(
          'cisco-preauth',
          'Pre-auth URL filter / ACL allowing the ECLOUD portal',
          'URL filter PRE_AUTH / Portal IPv4',
          'portal.ezecloud.ezelink.ai',
          ev,
        ),
      ];
    case 'fortinet-ecp':
      return [
        guideStep(
          'fortinet-portal',
          'SSID / interface security: captive portal, external portal URL (ECLOUD)',
          'Security mode Captive Portal > Portal type External',
          portalUrl,
          ev,
        ),
        guideStep(
          'fortinet-radius',
          'User group with the ECLOUD RADIUS server',
          'User & Authentication > RADIUS Servers',
          '<ECLOUD_RADIUS_ADDRESS>, <RADIUS_SECRET>',
          ev,
        ),
        guideStep(
          'fortinet-secure-http',
          'Secure the credential post (optional, needs a trusted FortiGate certificate)',
          'config user setting > set auth-secure-http',
          'enable',
          ev,
        ),
        guideStep(
          'fortinet-exempt',
          'Exempt destinations: the ECLOUD portal',
          'Exempt Destinations/Services',
          'portal.ezecloud.ezelink.ai',
          ev,
        ),
      ];
    case 'ruckus-wispr':
      return [
        guideStep(
          'ruckus-hotspot',
          'Hotspot (WISPr) service: login page = ECLOUD portal',
          'Hotspot Services > Login Page',
          portalUrl,
          ev,
        ),
        guideStep(
          'ruckus-encrypt',
          'SmartZone: send client MAC and IP unencrypted (client_mac, uip)',
          'MAC / IP encryption',
          'disabled',
          ev,
        ),
        guideStep(
          'ruckus-walled-garden',
          'Walled garden: the ECLOUD portal',
          'Walled Garden',
          'portal.ezecloud.ezelink.ai',
          ev,
        ),
      ];
    case 'omada-external-portal':
      return [
        guideStep(
          'omada-portal',
          'Portal: authentication by an external RADIUS server, external web portal (ECLOUD)',
          'Portal > Authentication Type / External Web Portal URL',
          portalUrl,
          ev,
        ),
        guideStep(
          'omada-radius',
          'RADIUS profile with ECLOUD (PAP)',
          'RADIUS Profile',
          '<ECLOUD_RADIUS_ADDRESS>, 1812/1813, <RADIUS_SECRET>',
          ev,
        ),
        guideStep(
          'omada-preauth',
          'Pre-Authentication Access: the ECLOUD portal',
          'Pre-Authentication Access',
          'portal.ezecloud.ezelink.ai',
          ev,
        ),
        guideStep(
          'omada-cloud',
          'Cloud-based controller: add the controller host to the ECLOUD NAS login hosts (HTTPS only)',
          'login hosts (ECLOUD)',
          '<CONTROLLER_HOST>',
          ev,
        ),
      ];
    case 'huawei-portal':
      return [
        guideStep(
          'huawei-template',
          'Relay authentication URL template: ECLOUD portal',
          'URL template > URL',
          portalUrl,
          ev,
        ),
        guideStep(
          'huawei-keywords',
          'URL template parameters, exactly these names',
          'user-mac / device-mac / login URL / redirect URL keywords',
          'user-mac, device-mac, loginurl, redirect-url',
          ev,
        ),
      ];
    default:
      return [
        guideStep(
          'generic-names',
          'Portal parameter names: enter the names your device sends (from a captured redirect) in the ECLOUD NAS profile editor',
          'ECLOUD NAS > Post-back profile',
          '<CAPTURED_PARAMETER_NAMES>',
          ev,
        ),
        guideStep(
          'generic-portal',
          'External portal URL (ECLOUD; the path names this NAS)',
          'External portal / splash URL',
          portalUrl,
          ev,
        ),
      ];
  }
}

export function postbackSetupGuide(
  profile: PostbackProfile,
  site: { readonly siteId: string; readonly nasId: string },
): readonly SetupStep[] {
  const ev = profile.evidence;
  const nasId = POSTBACK_NASID_SEGMENT_RE.test(site.nasId) ? site.nasId : '<NAS_IDENTIFIER>';
  const portalUrl = postbackPortalUrl(profile.key, nasId);
  // The portal URL is shown once: at the vendor step that names the device setting it goes in
  // (with the note that it carries this NAS identifier); the generic step only when no vendor
  // step does.
  const vendor = vendorSteps(profile, nasId).map((st) =>
    st.value === portalUrl && !/\bNAS\b/.test(st.title)
      ? { ...st, title: `${st.title}; the URL includes this NAS identifier` }
      : st,
  );
  const vendorHasUrl = vendor.some((st) => st.value === portalUrl);
  return [
    ...(vendorHasUrl
      ? []
      : [
          guideStep(
            'portal-url',
            'External portal URL (ECLOUD; includes this NAS identifier)',
            'External portal URL',
            portalUrl,
            ev,
          ),
        ]),
    ...vendor,
    guideStep(
      'radius-auth',
      'RADIUS authentication server (PAP)',
      'RADIUS auth server {address, port, shared secret}',
      '<ECLOUD_RADIUS_ADDRESS>, 1812, <RADIUS_SECRET>',
      ev,
    ),
    guideStep(
      'radius-acct',
      'RADIUS accounting server (Start / Interim-Update / Stop)',
      'RADIUS accounting server {address, port, shared secret}',
      '<ECLOUD_RADIUS_ADDRESS>, 1813, <RADIUS_SECRET>',
      ev,
    ),
    guideStep(
      'nas-source',
      'Send RADIUS from the address registered as the NAS IP',
      'RADIUS source interface / NAS-IP',
      '<REGISTERED_NAS_IP>',
      ev,
    ),
    guideStep(
      'walled-garden',
      'Walled garden / pre-authentication allow-list: the ECLOUD portal host',
      'Walled garden',
      'portal.ezecloud.ezelink.ai',
      ev,
    ),
    guideStep(
      'access-points',
      'Register each AP MAC under Access points in ECLOUD (verified automatically after its first RADIUS request)',
      'ECLOUD > Access points',
      '<AP_MAC>',
      ev,
    ),
    guideStep(
      'login-hosts',
      'Login host check: by default the browser may post to any RFC 1918 address (needed when every AP serves its own login page, e.g. Cambium ga_srvr). When all guests log in at one controller / gateway address, enter it as a login host and enable "strict login hosts" so no other LAN address is accepted',
      'ECLOUD NAS > login hosts / strict login hosts',
      '<CONTROLLER_OR_GATEWAY_IP>',
      ev,
    ),
    guideStep(
      'transport',
      'Prefer HTTPS to the device when it has a trusted certificate: over http:// the single-use credential (valid 90 s, bound to this NAS and client MAC) crosses the guest network in clear text',
      'Device login protocol / ECLOUD NAS "post back over HTTPS"',
      profile.httpsDefault ? 'HTTPS' : 'HTTP (HTTPS when the device certificate is trusted)',
      ev,
    ),
    ...(profile.method === 'GET'
      ? [
          guideStep(
            'get-warning',
            'Warning: this device logs in with GET, so the single-use credential appears in the URL (browser history, proxy and device logs). Use POST if the device supports it',
            'Post-back method',
            'GET (not recommended)',
            ev,
          ),
        ]
      : []),
  ];
}

// ------------------------------------------------------------------------------------------
// VendorAdapter
// ------------------------------------------------------------------------------------------

const WG_STALE_S = 180;
const DEFAULT_INTERIM_S = 600;

/** Builds the post-back adapter for `profile`, bound to one NAS's options. */
export function createPostbackVendorAdapter(
  profile: PostbackProfile | null,
  options: PostbackOptions = DEFAULT_POSTBACK_OPTIONS,
): VendorAdapter {
  const engine = getAdapter(POSTBACK_ADAPTER_KEY);
  const profileKey = profile?.key ?? GENERIC_POSTBACK_PROFILE_KEY;

  const authorizeSession = (
    ctx: HotspotContext,
    credential: BrokerCredential,
    _secrets?: HandoffSecrets,
  ): AuthorizationHandoff | Unsupported => {
    if (profile === null) return unsupported('post-back profile not configured for this NAS');
    if (ctx.nas.adapterKey !== POSTBACK_ADAPTER_KEY)
      return unsupported(`context NAS uses adapter ${String(ctx.nas.adapterKey)}`);
    if (credential.boundNasId !== ctx.nas.id || credential.boundClientMac !== ctx.clientMac)
      return unsupported('credential is not bound to this NAS and client (SECURITY §5.6)');
    if (credential.expiresAt.getTime() <= ctx.receivedAt.getTime())
      return unsupported('credential expired before the hand-off');
    if (
      profile.maxPasswordChars !== undefined &&
      credential.password.length > profile.maxPasswordChars
    )
      return unsupported('credential password longer than the vendor limit');
    const raw = ctx.vendorOpaque.raw;
    if (raw.length === 0 || raw.length > MAX_QUERY) return unsupported('redirect query missing');
    const q = splitPostbackQuery(raw);
    if (q.duplicates.length > 0) return unsupported('duplicate redirect parameters');
    const loginUrl = resolveLoginUrl(profile, options, q.params);
    if (loginUrl === null) return unsupported('login URL is not the AP / controller');
    const fields = buildPostbackFields(
      profile,
      q.params,
      credential,
      postbackContinueUrl(profile, q.params, loginUrl),
    );
    if (
      profile.maxPostDataChars !== undefined &&
      new URLSearchParams(fields).toString().length > profile.maxPostDataChars
    )
      return unsupported('post data exceeds the vendor limit');
    if (profile.method === 'GET') {
      const extra = profile.appendRawQuery ? `${raw}&` : '';
      const sep = loginUrl.includes('?') ? '&' : '?';
      return {
        strategy: 'browser-form',
        browser: {
          method: 'GET-302',
          url: `${loginUrl}${sep}${extra}${new URLSearchParams(fields).toString()}`,
          fields,
        },
        state: 'pending',
      };
    }
    const sep = loginUrl.includes('?') ? '&' : '?';
    return {
      strategy: 'browser-form',
      browser: {
        method: 'POST-form',
        url: profile.appendRawQuery ? `${loginUrl}${sep}${raw}` : loginUrl,
        fields,
      },
      state: 'pending',
    };
  };

  return {
    key: POSTBACK_ADAPTER_KEY,
    vendorKey: profile?.vendorKey ?? 'generic-postback',
    engine,
    strategies: ['browser-form'],

    discoverCapabilities(): CapabilityReport {
      const row = COMPATIBILITY_ROWS.find((r) => r.adapterKey === POSTBACK_ADAPTER_KEY);
      const capabilities =
        row?.capabilities ??
        deriveCells(engine.capabilities(), {
          rowKey: `${POSTBACK_ADAPTER_KEY}:engine`,
          sourceVersionMatchesDevice: null,
          deviceFirmware: 'UNKNOWN',
          dtResults: DT_RESULTS,
        });
      return {
        adapterKey: POSTBACK_ADAPTER_KEY,
        vendorKey: profile?.vendorKey ?? 'generic-postback',
        rowKey: row?.key ?? null,
        lifecycle: row?.lifecycle ?? null,
        sourceVersionMatchesDevice: row?.sourceVersionMatchesDevice ?? null,
        cells: presentCells(capabilities),
      };
    },

    parseRedirect(req): ParsedRedirect | Unsupported {
      if (profile === null) return unsupported('post-back profile not configured');
      if (req.method.toUpperCase() !== 'GET')
        return unsupported('post-back redirects are GET requests');
      const path = parsePostbackPath(req.url);
      if (!path.ok) return unsupported('malformed post-back portal path');
      if (path.profile !== null && path.profile !== profileKey)
        return unsupported('portal path names another profile');
      if (path.rawQuery.length > MAX_QUERY) return unsupported('redirect query too long');
      const q = splitPostbackQuery(path.rawQuery);
      return {
        vendorKey: profile.vendorKey,
        params: q.params,
        rawQuery: path.rawQuery,
        signature: { kind: 'none', value: null },
        result: null,
        pathNasId: path.pathNasId,
      };
    },

    async validateContext(parsed, lookup: NasLookup): Promise<ContextValidation> {
      const fail = (reason: Exclude<ContextValidation, { ok: true }>['reason'], detail: string) =>
        ({ ok: false, reason, detail }) as const;
      if (profile === null) return fail('malformed', 'post-back profile not configured');
      const q = splitPostbackQuery(parsed.rawQuery);
      if (q.duplicates.length > 0)
        return fail('malformed', `duplicate parameter(s): ${q.duplicates.join(', ')}`);
      const p = q.params;
      const macHit = pick(p, profile.params.clientMac);
      const clientMac = normalizeMacAddress(macHit?.value);
      if (clientMac === null || canonicalUnicastMac(clientMac) === null)
        return fail('malformed', 'client MAC missing or not a unicast MAC address');
      const pathNasId = parsed.pathNasId ?? null;
      const paramNasId = pick(p, profile.params.nasId)?.value ?? null;
      if (pathNasId !== null && paramNasId !== null && pathNasId !== paramNasId)
        return fail('malformed', 'portal path and redirect name different NAS identifiers');
      if (profile.pathNasIdRequired && pathNasId === null)
        return fail('malformed', 'this profile needs the NAS identifier in the portal path');
      const nasid = pathNasId ?? paramNasId;
      const apRaw = pick(p, profile.params.apMac)?.value ?? null;
      const apMac = canonicalUnicastMac(apRaw);
      if (nasid === null && apMac === null)
        return fail('unknown_nas', 'no NAS identifier and no AP MAC in the redirect');

      const nas = await lookup.findNas({ nasid, called: null, apMac });
      if (!nas) return fail('unknown_nas', 'no registered NAS for this redirect');
      if (nas.adapterKey !== POSTBACK_ADAPTER_KEY)
        return fail('unknown_nas', `NAS is registered for adapter ${String(nas.adapterKey)}`);
      const cfg = parsePostbackNasConfig(nas.adapterConfig ?? null);
      if (!cfg.ok || cfg.config.profile !== profileKey)
        return fail('unknown_nas', 'NAS is not configured for this post-back profile');
      if (lookup.expectedOrganizationId === undefined)
        return fail(
          'tenant_mismatch',
          'caller did not state the expected organization (fail closed)',
        );
      if (
        lookup.expectedOrganizationId !== null &&
        lookup.expectedOrganizationId !== nas.organizationId
      )
        return fail('tenant_mismatch', 'NAS belongs to another organization');

      const loginUrl = resolveLoginUrl(
        profile,
        {
          ...options,
          nasIp: nas.nasIp ?? options.nasIp,
          hotspotAddress: nas.hotspotAddress ?? options.hotspotAddress ?? null,
        },
        p,
      );
      if (loginUrl === null)
        return fail(
          'private_address_required',
          'login URL must be the AP / controller (private address, registered NAS IP, configured login host or documented intercept name)',
        );

      if (typeof lookup.isReplay !== 'function')
        return fail('replayed', 'no replay check configured (fail closed)');
      const token = pick(q.rawValues, profile.params.vendorToken);
      if (
        token !== null &&
        (await lookup.isReplay({
          nasId: nas.id,
          sessionId: null,
          challenge: token.value,
          // Review L3: a vendor nonce is single-use per NAS whatever client presents it
          // (exact bytes, no case folding); the client MAC is not part of its identity.
          clientMac: '',
          nonceKind: 'vendor-nonce',
        }))
      )
        return fail('replayed', 'vendor nonce already consumed');

      const clientIp = pick(p, profile.params.clientIp)?.value ?? null;
      const ssid = pick(p, profile.params.ssid)?.value ?? null;
      return {
        ok: true,
        context: {
          organizationId: nas.organizationId,
          siteId: nas.siteId,
          vendorKey: profile.vendorKey,
          controllerId: nas.controllerId,
          nas: { id: nas.id, identifier: nas.identifier, adapterKey: nas.adapterKey },
          apMac,
          clientMac,
          ssid: ssid !== null && ssid.length <= 64 ? ssid : null,
          clientIp: clientIp !== null && /^[0-9a-fA-F.:]{2,45}$/.test(clientIp) ? clientIp : null,
          nasSessionId: null,
          policyRef: null,
          deploymentMode: nas.deploymentMode,
          vendorOpaque: { raw: parsed.rawQuery, fields: { ...p } },
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
      const enforcement = engine.translate(effective, tctx);
      return {
        enforcement,
        replyAttributes: engine.buildReplyAttributes(enforcement),
        handoff,
        gatewaySuggestion: null,
      };
    },

    authorizeSession,

    revokeSession(session: SessionRef) {
      return engine.buildDisconnect(session);
    },

    normalizeAccounting(row) {
      return normalizeAccounting(row);
    },

    buildSetupGuide(site) {
      return profile === null ? [] : postbackSetupGuide(profile, site);
    },

    healthCheck(signals: SiteSignals): HealthReport {
      const age = (d: Date | null | undefined): number | null =>
        d ? (signals.now.getTime() - d.getTime()) / 1000 : null;
      const interim = signals.interimIntervalS ?? DEFAULT_INTERIM_S;
      const accAge = age(signals.lastAccountingAt);
      const out: HealthReport['signals'][number][] = [
        {
          name: 'radius-access-request',
          state: signals.lastAccessRequestAt ? 'ok' : 'missing',
          lastSeenAt: signals.lastAccessRequestAt,
        },
        {
          name: 'radius-accounting',
          state: accAge === null ? 'missing' : accAge > 3 * interim ? 'stale' : 'ok',
          lastSeenAt: signals.lastAccountingAt,
        },
      ];
      if (signals.lastWireguardHandshakeAt === undefined) {
        out.push({ name: 'wireguard-handshake', state: 'unknown', lastSeenAt: null });
      } else {
        const wgAge = age(signals.lastWireguardHandshakeAt);
        out.push({
          name: 'wireguard-handshake',
          state: wgAge === null ? 'missing' : wgAge > WG_STALE_S ? 'stale' : 'ok',
          lastSeenAt: signals.lastWireguardHandshakeAt,
        });
      }
      return { signals: out };
    },
  };
}

/**
 * The post-back adapter for a registered NAS: profile and options from its validated
 * `adapter_config`; null when the config is missing or invalid (fail closed).
 */
export function postbackAdapterForNas(nas: {
  readonly adapterConfig?: Readonly<Record<string, unknown>> | null;
  readonly nasIp?: string | null;
  readonly hotspotAddress?: string | null;
}): { adapter: VendorAdapter; profile: PostbackProfile } | null {
  const cfg = parsePostbackNasConfig(nas.adapterConfig ?? null);
  if (!cfg.ok) return null;
  const profile = profileForConfig(cfg.config);
  if (profile === null) return null;
  return {
    profile,
    adapter: createPostbackVendorAdapter(profile, {
      https: cfg.config.https,
      loginTarget: cfg.config.login_target,
      loginHosts: cfg.config.login_hosts,
      nasIp: nas.nasIp ?? null,
      hotspotAddress: nas.hotspotAddress ?? null,
      strictLoginHosts: cfg.config.strict_login_hosts,
    }),
  };
}
