/**
 * F3 external-portal post-back profiles (Cycle C, D-044; docs/VENDOR_INTEGRATION_RESEARCH.md
 * §1, §2 F3, §3.4; MULTI_VENDOR_INTEGRATION_PLAN.md §7.3 for Cambium).
 *
 * A profile is DATA: which redirect parameters carry the client MAC / AP MAC / NAS-ID / SSID /
 * client IP / continue URL / vendor token, where the browser posts the credential back (a login
 * URL on the AP or controller, never fetched by ECLOUD), the form field names, constant fields,
 * and the documented RADIUS behaviour. Every name below is taken from the research document,
 * which cites the vendor source; names that were not found in a vendor / vendor-community source
 * are listed in `requiresClarification` and are NOT part of the profile (never invented).
 *
 * Every profile is DOCUMENTED / REQUIRES_DEVICE_TEST: no device has been tested (D-028, D-034).
 */
import type { EvidenceRef } from '@ecloud/shared';

/** Engine adapter key of the family (policy-engine ADAPTER_KEYS). */
export const POSTBACK_ADAPTER_KEY = 'external-portal-postback';

/** Where the browser sends the ECLOUD credential. */
export type PostbackLoginTarget =
  | {
      /** A redirect parameter carries the complete login URL (Cisco `switch_url`, Fortinet `post`). */
      readonly kind: 'param-url';
      readonly param: string;
      readonly schemes: readonly ('http' | 'https')[];
      /** Allowed path shape (anchored), or an exact path. */
      readonly path: RegExp | string;
      /**
       * Allowed effective ports (review M1): only the documented ones, so a redirect cannot
       * aim the browser's form post at another LAN service (e.g. :6379).
       */
      readonly ports: readonly number[];
    }
  | {
      /**
       * A redirect parameter carries only the host (Cambium `ga_srvr`, Ruckus `sip`, Omada
       * `target`); scheme, port and path come from the profile (or from `portParam` /
       * `schemeParam` when the vendor sends them).
       */
      readonly kind: 'param-host';
      readonly param: string;
      readonly http: { readonly port: number | null } | null;
      readonly https: { readonly port: number | null } | null;
      readonly path: string;
      readonly portParam?: string;
      /** Ports `portParam` may name (review M1); required when `portParam` is set. */
      readonly allowedPorts?: readonly number[];
      readonly schemeParam?: string;
    }
  | {
      /** A fixed, vendor-intercepted name (Aruba `securelogin.arubanetworks.com`). */
      readonly kind: 'fixed-url';
      readonly url: string;
    };

export interface PostbackParamMap {
  /** Alternatives in preference order; the first present wins. */
  readonly clientMac: readonly string[];
  readonly apMac?: readonly string[];
  readonly nasId?: readonly string[];
  readonly ssid?: readonly string[];
  readonly clientIp?: readonly string[];
  readonly continueUrl?: readonly string[];
  /** Opaque vendor nonce (`magic`, `ga_Qv`): echoed unchanged, used as the replay nonce. */
  readonly vendorToken?: readonly string[];
}

export interface PostbackFieldMap {
  readonly username: string;
  readonly password: string;
  /** Form field that carries the continue URL (only sent when a safe one is known). */
  readonly continueUrl?: string;
  /** Constant fields (`cmd=authenticate`, `buttonClicked=4`, `authType=2`). */
  readonly constants?: Readonly<Record<string, string>>;
  /** Form field ← redirect parameter(s), echoed byte-for-byte as decoded (when present). */
  readonly echo?: Readonly<Record<string, readonly string[]>>;
}

export type PostbackFieldStatus = 'DOCUMENTED' | 'REQUIRES_DEVICE_TEST' | 'REQUIRES_CLARIFICATION';

export interface PostbackRadiusAttribute {
  readonly name: string;
  readonly status: PostbackFieldStatus;
  readonly note: string;
}

export interface PostbackProfile {
  readonly key: string;
  /** Registry vendor key (registry/vendors.ts). */
  readonly vendorKey: string;
  readonly label: string;
  readonly productLines: string;
  /** H / M / L as in research §1 "Conf." */
  readonly confidence: 'H' | 'M' | 'L';
  readonly params: PostbackParamMap;
  /** Login targets by name; `defaultLoginTarget` unless the NAS config picks another. */
  readonly loginTargets: Readonly<Record<string, PostbackLoginTarget>>;
  readonly defaultLoginTarget: string;
  /** Default scheme for `param-host` targets offering both (NAS config `https` overrides). */
  readonly httpsDefault: boolean;
  readonly method: 'POST' | 'GET';
  readonly fields: PostbackFieldMap;
  /** Append the received query, byte-for-byte, to the login URL (Cambium C2). */
  readonly appendRawQuery: boolean;
  /** DNS names the AP / controller intercepts (accepted as login hosts without registration). */
  readonly interceptHosts: readonly string[];
  /** Vendor limit on the URL-encoded form body (Fortinet: 125 characters). */
  readonly maxPostDataChars?: number;
  /** Vendor limit on the password length (Ruckus ZD: 31). */
  readonly maxPasswordChars?: number;
  /** True when the redirect carries no usable NAS id and the portal URL path must name it. */
  readonly pathNasIdRequired: boolean;
  readonly radius: readonly PostbackRadiusAttribute[];
  readonly evidence: readonly EvidenceRef[];
  readonly requiresClarification: readonly string[];
}

const R1: EvidenceRef = { kind: 'doc-section', ref: 'docs/VENDOR_INTEGRATION_RESEARCH.md §1' };
const R34: EvidenceRef = {
  kind: 'doc-section',
  ref: 'docs/VENDOR_INTEGRATION_RESEARCH.md §3.4 (F3 profiles)',
};

const STD_TIMERS = (vendorNote: string): readonly PostbackRadiusAttribute[] => [
  { name: 'Session-Timeout', status: 'REQUIRES_DEVICE_TEST', note: vendorNote },
  { name: 'Idle-Timeout', status: 'REQUIRES_DEVICE_TEST', note: vendorNote },
  { name: 'Acct-Interim-Interval', status: 'REQUIRES_DEVICE_TEST', note: vendorNote },
  { name: 'Class', status: 'REQUIRES_DEVICE_TEST', note: vendorNote },
];

// ------------------------------------------------------------------------------------------
// Cambium cnPilot / cnMaestro External Hotspot (owner priority)
// ------------------------------------------------------------------------------------------
const CAMBIUM: PostbackProfile = {
  key: 'cambium-hotspot',
  vendorKey: 'cambium',
  label: 'Cambium cnPilot / cnMaestro External Hotspot',
  productLines:
    'cnPilot E-series APs, cnMaestro-managed (Guest Access, Portal Mode External Hotspot)',
  confidence: 'H',
  params: {
    clientMac: ['ga_cmac'],
    apMac: ['ga_ap_mac'],
    nasId: ['ga_nas_id'],
    ssid: ['ga_ssid'],
    continueUrl: ['ga_orig_url'],
    vendorToken: ['ga_Qv'],
  },
  loginTargets: {
    ap: {
      kind: 'param-host',
      param: 'ga_srvr',
      http: { port: 880 },
      https: { port: 444 },
      path: '/cgi-bin/hotspot_login.cgi',
    },
  },
  defaultLoginTarget: 'ap',
  httpsDefault: false,
  method: 'POST',
  fields: { username: 'ga_user', password: 'ga_pass' }, // form field name. check-no-secrets: allow
  appendRawQuery: true,
  interceptHosts: [],
  pathNasIdRequired: false,
  radius: [
    ...STD_TIMERS('documented as understood in Access-Accept (plan §7.3 C1 p.12-13)'),
    {
      name: 'WIFI_ALLIANCE_MAX_UP / WIFI_ALLIANCE_MAX_DOWN',
      status: 'REQUIRES_CLARIFICATION',
      note: 'documented by name only (C1); dictionary name, vendor id and units UNKNOWN, so not emitted',
    },
  ],
  evidence: [
    { kind: 'doc-section', ref: 'MULTI_VENDOR_INTEGRATION_PLAN.md §7.3 (C1 p.4-8, C2)' },
    {
      kind: 'url',
      ref: 'C1 Cambium "Guest Access Portal Integration" (2016)',
      url: 'https://community.cambiumnetworks.com/bstrc49894/attachments/bstrc49894/cnPilot_Indoor/328/1/Guest%20Access%20Portal%20Integration%20(002).pdf',
    },
    {
      kind: 'url',
      ref: 'C2 Cambium "Guest Access WLAN-External Hotspot with RADIUS Authentication" (2021)',
      url: 'https://community.cambiumnetworks.com/t/guest-access-wlan-external-hotspot-with-radius-authentication/82858',
    },
    R34,
  ],
  requiresClarification: [
    'Query appended to the POST URL (C2) vs carried only in Referer (C1): ECLOUD appends it byte-for-byte; REQUIRES_DEVICE_TEST (plan OQ-10/OQ-12).',
    'HTTPS port 444 depends on the AP certificate (UNKNOWN); default is HTTP port 880.',
    'ga_srvr may be a public IP when an external web server is used (C1); ECLOUD accepts private, registered-NAS or configured login hosts only (plan OQ-8).',
    'Client IP parameter: none documented.',
  ],
};

// ------------------------------------------------------------------------------------------
// HPE Aruba Instant / Central (and AOS 8 with switchip) (owner priority)
// ------------------------------------------------------------------------------------------
const ARUBA: PostbackProfile = {
  key: 'aruba-ecp',
  vendorKey: 'aruba',
  label: 'HPE Aruba Instant / Central / AOS 8 external captive portal',
  productLines: 'Instant APs (IAP), Aruba Central (Instant), AOS 8 Mobility Controllers (switchip)',
  confidence: 'M',
  params: {
    clientMac: ['mac'],
    apMac: ['apmac'],
    ssid: ['essid'],
    clientIp: ['ip'],
    continueUrl: ['url'],
  },
  loginTargets: {
    securelogin: { kind: 'fixed-url', url: 'https://securelogin.arubanetworks.com/cgi-bin/login' },
    switchip: {
      kind: 'param-host',
      param: 'switchip',
      http: null,
      https: { port: null },
      path: '/cgi-bin/login',
    },
  },
  defaultLoginTarget: 'securelogin',
  httpsDefault: true,
  method: 'POST',
  fields: {
    username: 'user',
    password: 'password', // form field name. check-no-secrets: allow
    continueUrl: 'url',
    constants: { cmd: 'authenticate' },
  },
  appendRawQuery: false,
  interceptHosts: ['securelogin.arubanetworks.com'],
  pathNasIdRequired: false,
  radius: [
    ...STD_TIMERS('standard attributes; Aruba honouring not researched to vendor-doc level'),
    {
      name: 'Aruba-User-Role',
      status: 'REQUIRES_CLARIFICATION',
      note: 'Aruba VSAs were not researched (research §1); the policy engine models no role, so not emitted',
    },
  ],
  evidence: [
    R1,
    R34,
    {
      kind: 'url',
      ref: 'HPE Aruba Instant 8.x external captive portal (conf-ext-cp)',
      url: 'https://arubanetworking.hpe.com/techdocs/Instant_8.x_WebHelp/Content/instant-ug/captive-portal/conf-ext-cp.htm',
    },
    {
      kind: 'url',
      ref: 'HPE Aruba CLI-Bank aaa authentication captive-portal (AOS 8, url-hash-key)',
      url: 'https://arubanetworking.hpe.com/techdocs/CLI-Bank/Content/aos8/aaa-auth-cptv-prtl.htm',
    },
    {
      kind: 'url',
      ref: 'V-c HPE community "Howto Aruba external web authentication" (POST target, fields)',
      url: 'https://higherlogicdownload.s3.amazonaws.com/HPE/MigratedAssets/Howto%20Aruba%20external%20web%20authentication%20(EN).pdf',
    },
  ],
  requiresClarification: [
    'url-hash-key (AOS 8): the hash algorithm, the hashed bytes and the parameter carrying the hash are not documented in any source read (HPE CLI-Bank, HPE community thread "Configuring url-hash-key on Instant AP", HPE Central help page 403). Not verified; do NOT enable url-hash-key on the controller for ECLOUD. Unsigned redirects rely on the ECLOUD login token + RADIUS binding.',
    'POST target `cgi-bin/login` vs `swarm.cgi` and the field names come from vendor-community / third-party sources (confidence M): REQUIRES_DEVICE_TEST.',
    'AOS 8 AP MAC / client IP parameters appear only when the profile options ap-mac-in-redirection-url / ip-addr-in-redirection-url are enabled; their names on AOS 8: REQUIRES_DEVICE_TEST.',
    'Aruba Instant On: intercept hostname is firmware-dependent; not part of this profile.',
    'No NAS-ID parameter: identify the NAS through the portal URL path or a verified AP MAC.',
  ],
};

// ------------------------------------------------------------------------------------------
// Cisco Catalyst 9800 / AireOS WLC external web authentication
// ------------------------------------------------------------------------------------------
const CISCO: PostbackProfile = {
  key: 'cisco-webauth',
  vendorKey: 'cisco',
  label: 'Cisco Catalyst 9800 / AireOS WLC external web authentication',
  productLines:
    'Catalyst 9800 (IOS-XE) EWA; AireOS WLC 8.x (same POST shape, REQUIRES_DEVICE_TEST)',
  confidence: 'H',
  params: {
    clientMac: ['client_mac'],
    apMac: ['ap_mac'],
    ssid: ['ssid'],
  },
  loginTargets: {
    wlc: {
      kind: 'param-url',
      param: 'switch_url',
      schemes: ['http', 'https'],
      path: /^\/[A-Za-z0-9._~/-]{0,128}$/,
      // Virtual IP on the default ports (Cisco 217457 example http://192.0.2.1/login.html).
      ports: [80, 443],
    },
  },
  defaultLoginTarget: 'wlc',
  httpsDefault: false,
  method: 'POST',
  fields: {
    username: 'username',
    password: 'password', // form field name. check-no-secrets: allow
    continueUrl: 'redirectUrl',
    constants: { buttonClicked: '4', err_flag: '0' },
  },
  appendRawQuery: false,
  interceptHosts: [],
  pathNasIdRequired: false,
  radius: STD_TIMERS('session timeout documented; others standard, untested (research §3.4)'),
  evidence: [
    R1,
    R34,
    {
      kind: 'url',
      ref: 'Cisco 9800 "Configure and Troubleshoot External Web Authentication" (217457)',
      url: 'https://www.cisco.com/c/en/us/support/docs/wireless/catalyst-9800-series-wireless-controllers/217457-configure-and-troubleshoot-external-web.html',
    },
  ],
  requiresClarification: [
    'Form field spelling `redirectUrl` (vendor text) vs `redirect_url` (common form): REQUIRES_DEVICE_TEST (research §6 item 4).',
    'AireOS redirect names `wlan` / `redirect` are third-party only: not in the profile (SSID / continue URL absent on AireOS).',
    'The virtual IP (switch_url host) is often a non-RFC 1918 address (e.g. 192.0.2.1): add it to the NAS "login hosts".',
    'No NAS-ID parameter: identify the WLC through the portal URL path or a verified AP MAC.',
  ],
};

// ------------------------------------------------------------------------------------------
// Fortinet FortiGate / FortiWiFi (+ FortiAP) external captive portal
// ------------------------------------------------------------------------------------------
const FORTINET: PostbackProfile = {
  key: 'fortinet-ecp',
  vendorKey: 'fortinet',
  label: 'Fortinet FortiGate / FortiWiFi external captive portal',
  productLines: 'FortiGate / FortiWiFi, FortiAP managed by FortiGate',
  confidence: 'H',
  params: {
    clientMac: ['usermac'],
    apMac: ['apmac'],
    ssid: ['ssid'],
    clientIp: ['userip'],
    vendorToken: ['magic'],
  },
  loginTargets: {
    fortigate: {
      kind: 'param-url',
      param: 'post',
      schemes: ['http', 'https'],
      path: /^\/fgtauth$/,
      // Documented example http://<fgt>:1000/fgtauth; the auth-secure-http port is not
      // documented in the sources read (REQUIRES_CLARIFICATION), so only 1000.
      ports: [1000],
    },
  },
  defaultLoginTarget: 'fortigate',
  httpsDefault: false,
  method: 'POST',
  fields: { username: 'username', password: 'password', echo: { magic: ['magic'] } }, // form field name. check-no-secrets: allow
  appendRawQuery: false,
  interceptHosts: [],
  maxPostDataChars: 125,
  pathNasIdRequired: false,
  radius: STD_TIMERS('standard attributes (PAP); Fortinet honouring untested (research §3.4)'),
  evidence: [
    R1,
    R34,
    {
      kind: 'url',
      ref: 'Fortinet FortiWiFi and FortiAP configuration guide 7.4.2 (external captive portal)',
      url: 'https://docs.fortinet.com/document/fortiap/7.4.2/fortiwifi-and-fortiap-configuration-guide/292926',
    },
    {
      kind: 'url',
      ref: 'V-c Fortinet community 101546 (captive portal workflow)',
      url: 'https://community.fortinet.com/fortiauthenticator-8/technical-tip-the-typical-captive-portal-workflow-for-an-end-user-with-a-fortigate-fortiwifi-101546',
    },
  ],
  requiresClarification: [
    'The `post` URL path is `/fgtauth` in the documented example; other paths are refused until a device capture shows them.',
    'FortiAP Cloud / FortiLAN Cloud variant: not covered (RADIUS from the vendor cloud, research §6 item 1).',
    'No NAS-ID parameter: identify the FortiGate through the portal URL path or a verified AP MAC.',
  ],
};

// ------------------------------------------------------------------------------------------
// Ruckus ZoneDirector / Unleashed / SmartZone WISPr hotspot (browser login)
// ------------------------------------------------------------------------------------------
const RUCKUS: PostbackProfile = {
  key: 'ruckus-wispr',
  vendorKey: 'ruckus',
  label: 'Ruckus WISPr hotspot (browser login)',
  productLines:
    'ZoneDirector / Unleashed (login :9997 / :9998); SmartZone with MAC/IP encryption off',
  confidence: 'M',
  params: {
    clientMac: ['client_mac'],
    apMac: ['mac'],
    ssid: ['ssid'],
    clientIp: ['uip'],
    continueUrl: ['url'],
  },
  loginTargets: {
    controller: {
      kind: 'param-host',
      param: 'sip',
      http: { port: 9997 },
      https: { port: 9998 },
      path: '/login',
    },
  },
  defaultLoginTarget: 'controller',
  httpsDefault: false,
  method: 'POST',
  fields: { username: 'username', password: 'password', echo: { ip: ['uip'] } }, // form field name. check-no-secrets: allow
  appendRawQuery: false,
  interceptHosts: [],
  maxPasswordChars: 31,
  pathNasIdRequired: false,
  radius: STD_TIMERS(
    'session timeout + interim accounting documented for ZoneDirector (2009 app note)',
  ),
  evidence: [
    R1,
    R34,
    {
      kind: 'url',
      ref: 'Ruckus ZoneDirector WISPr app note (2009)',
      url: 'https://webresources.ruckuswireless.com/pdf/appnotes/appnote-wispr.pdf',
    },
    {
      kind: 'url',
      ref: 'Ruckus One WISPr API (redirect parameter names)',
      url: 'https://docs.cloud.ruckuswireless.com/ruckusone/wispr-api/index.html',
    },
  ],
  requiresClarification: [
    'ZoneDirector / Unleashed redirects (2009 app note) carry no client MAC; ECLOUD binds the credential to the client MAC, so such a redirect is refused. `client_mac` is the Ruckus One / SmartZone name and must be sent unencrypted.',
    'SmartZone browser-login path: research §6 item 8. The ZD/Unleashed `/login` on :9997 / :9998 is used.',
    'NBI (backend) login is Cycle D, not this profile.',
  ],
};

// ------------------------------------------------------------------------------------------
// TP-Link Omada external portal with RADIUS (portal mode)
// ------------------------------------------------------------------------------------------
const OMADA_ECHO: Readonly<Record<string, readonly string[]>> = {
  clientMac: ['clientMac'],
  clientIP: ['clientIp', 'clientIP'],
  apMac: ['apMac'],
  gatewayMac: ['gatewayMac', 'GatewayMac'],
  ssidName: ['ssidName'],
  vid: ['vid'],
  radioId: ['radioId'],
  originUrl: ['originUrl', 'originalUrl'],
};

const OMADA: PostbackProfile = {
  key: 'omada-external-portal',
  vendorKey: 'tplink-omada',
  label: 'TP-Link Omada external portal with RADIUS',
  productLines: 'Omada Controller (software / hardware / cloud) ≥ 5.3.1, external portal + RADIUS',
  confidence: 'H',
  params: {
    clientMac: ['clientMac'],
    apMac: ['apMac', 'gatewayMac', 'GatewayMac'],
    ssid: ['ssidName'],
    clientIp: ['clientIp', 'clientIP'],
    continueUrl: ['originUrl', 'originalUrl'],
  },
  loginTargets: {
    controller: {
      kind: 'param-host',
      param: 'target',
      http: { port: null },
      https: { port: null },
      path: '/portal/radius/browserauth',
      portParam: 'targetPort',
      // 8088 (HTTP) / 8843 (HTTPS) per research §1 (third-party); other ports refused.
      allowedPorts: [8088, 8843],
      schemeParam: 'scheme',
    },
  },
  defaultLoginTarget: 'controller',
  httpsDefault: true,
  method: 'POST',
  fields: {
    username: 'username',
    password: 'password', // form field name. check-no-secrets: allow
    constants: { authType: '2' },
    echo: OMADA_ECHO,
  },
  appendRawQuery: false,
  interceptHosts: [],
  pathNasIdRequired: false,
  radius: STD_TIMERS('PAP + interim accounting documented (third-party 600 s); untested'),
  evidence: [
    R1,
    R34,
    {
      kind: 'url',
      ref: 'Omada "external portal server with RADIUS" (document 13025)',
      url: 'https://support.omadanetworks.com/ae/document/13025/',
    },
  ],
  requiresClarification: [
    'Vendor document mixes clientIp/clientIP, originUrl/originalUrl, gatewayMac/GatewayMac: both spellings accepted, the documented POST field names are sent (research §6 item 5).',
    'Cloud controller: only HTTPS POST to browserauth is supported (vendor doc); the cloud host must be added to the NAS "login hosts".',
    'JSON POST /portal/radius/auth (RSA-wrapped AES key) is not used.',
    'No NAS-ID parameter: identify the controller through the portal URL path or a verified AP MAC.',
  ],
};

// ------------------------------------------------------------------------------------------
// Huawei eKit relay authentication (HTTP external portal only; Portal 2.0 UDP out of scope)
// ------------------------------------------------------------------------------------------
const HUAWEI: PostbackProfile = {
  key: 'huawei-portal',
  vendorKey: 'huawei',
  label: 'Huawei external portal (HTTP relay authentication)',
  productLines: 'Huawei eKit cloud APs (≥ V200R023C00SPC200) "Relay Authentication" URL template',
  confidence: 'L',
  params: {
    clientMac: ['user-mac'],
    apMac: ['device-mac'],
    continueUrl: ['redirect-url'],
  },
  loginTargets: {
    relay: {
      kind: 'param-url',
      param: 'loginurl',
      schemes: ['https', 'http'],
      path: /^\/[A-Za-z0-9._~/-]{0,128}$/,
      ports: [443, 80],
    },
  },
  defaultLoginTarget: 'relay',
  httpsDefault: true,
  method: 'POST',
  fields: { username: 'username', password: 'password' }, // form field name. check-no-secrets: allow
  appendRawQuery: false,
  interceptHosts: [],
  pathNasIdRequired: false,
  radius: STD_TIMERS('PAP + real-time accounting (third-party); untested'),
  evidence: [R1, R34],
  requiresClarification: [
    'Huawei parameter names are operator-configurable URL template keywords; the names here are the ones the ECLOUD setup guide tells the operator to configure (third-party source only, confidence L).',
    'Huawei AC (V200R019/R020) HTTP-based mode: the AC login path on port 8000 and whether it works without the Huawei Portal protocol (UDP 50100) are REQUIRES_CLARIFICATION (research §6 item 10); use the generic profile after a lab capture.',
    'Huawei Portal 2.0 (UDP) protocol: out of scope.',
  ],
};

/** Built-in profiles (append-only list; order = admin dropdown order). */
export const BUILTIN_POSTBACK_PROFILES: readonly PostbackProfile[] = Object.freeze([
  CAMBIUM,
  ARUBA,
  CISCO,
  FORTINET,
  RUCKUS,
  OMADA,
  HUAWEI,
]);

/** Key of the admin-configured profile ("any vendor"). */
export const GENERIC_POSTBACK_PROFILE_KEY = 'postback-generic';

export function builtinPostbackProfile(key: string): PostbackProfile | null {
  return BUILTIN_POSTBACK_PROFILES.find((p) => p.key === key) ?? null;
}

/** Every selectable profile key (built-in + generic). */
export function postbackProfileKeys(): string[] {
  return [...BUILTIN_POSTBACK_PROFILES.map((p) => p.key), GENERIC_POSTBACK_PROFILE_KEY];
}
