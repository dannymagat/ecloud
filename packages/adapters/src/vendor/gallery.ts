/**
 * "How to configure your access points" gallery (multi-vendor Cycle F;
 * docs/VENDOR_INTEGRATION_RESEARCH.md §5). One entry per vendor or product line, each bound to
 * an existing adapter (and post-back profile), and a NAS-independent guide built from the
 * adapters' own `buildSetupGuide` steps plus, for the controller-API vendors that have no step
 * builder, steps written here.
 *
 * Rules (research §5):
 *  - ECLOUD's own wording only; vendor menu / field names are factual identifiers and may be
 *    quoted. No third-party guide text, scripts, screenshots or file names; no vendor logos.
 *  - The status comes from evidence: "Tested on device" ONLY when a registry cell is
 *    VERIFIED_SUPPORTED with LAB_VALIDATED / PRODUCTION_VALIDATED evidence and a device-test
 *    reference (rule V12). Long-tail vendors served by the generic post-back profile say plainly
 *    that a captured redirect is needed first (D-034).
 *  - Values are filled by the caller from configuration (portal origin, RADIUS address and
 *    ports); every secret stays a placeholder (D-033). This module is pure.
 */
import type { EvidenceRef } from '@ecloud/shared';
import { COMPATIBILITY_ROWS } from '../registry/compatibility.js';
import type { CompatibilityRow } from '../registry/types.js';
import { MIKROTIK_DEFAULT_COA_PORT } from '../adapters/mikrotik-hotspot.js';
import { getVendorAdapter, PORTAL_ORIGIN } from './first-party.js';
import { merakiSetupGuide } from './meraki.js';
import { mikrotikSetupGuide } from './mikrotik.js';
import { parsePostbackNasConfig, profileForConfig } from './postback/config.js';
import { postbackSetupGuide } from './postback/engine.js';
import {
  builtinPostbackProfile,
  GENERIC_POSTBACK_PROFILE_KEY,
  type PostbackProfile,
} from './postback/profiles.js';
import { teltonikaSetupGuide } from './teltonika.js';
import type { SetupStep } from './types.js';

export const GALLERY_FAMILIES = [
  'uam',
  'router-hotspot',
  'external-portal',
  'cloud-splash',
  'controller-api',
  'radius-8021x',
] as const;
export type GalleryFamily = (typeof GALLERY_FAMILIES)[number];

export const GALLERY_FAMILY_LABELS: Readonly<Record<GalleryFamily, string>> = {
  uam: 'UAM captive portal',
  'router-hotspot': 'Router hotspot',
  'external-portal': 'External portal',
  'cloud-splash': 'Cloud splash + RADIUS',
  'controller-api': 'Controller API',
  'radius-8021x': '802.1X / MAC auth',
};

export const GALLERY_STATUSES = ['tested_on_device', 'documented', 'generic_profile'] as const;
export type GalleryStatus = (typeof GALLERY_STATUSES)[number];

export const GALLERY_STATUS_LABELS: Readonly<Record<GalleryStatus, string>> = {
  tested_on_device: 'Tested on device',
  documented: 'Documented, not yet device-tested',
  generic_profile: 'Via generic profile: needs a captured redirect',
};

export interface GalleryEntry {
  /** Stable gallery key (URL segment). */
  readonly vendorKey: string;
  readonly displayName: string;
  readonly productLine: string;
  /** NAS adapter key the "Add this access point" form preselects. */
  readonly adapterKey: string;
  /** Post-back profile key (external-portal-postback only), else null. */
  readonly profile: string | null;
  readonly family: GalleryFamily;
  /** Registry vendor (registry/vendors.ts) whose rows carry the evidence. */
  readonly registryVendorKey: string;
  /** Served by the configurable `postback-generic` profile (no documented parameter names). */
  readonly longTail: boolean;
  /** Pre-flight checklist (ECLOUD wording). */
  readonly preflight: readonly string[];
  /** Vendor-specific notes for long-tail entries (factual UI labels only). */
  readonly vendorNotes?: readonly string[];
}

const pf = {
  nas: 'Create the NAS in ECLOUD first ("Add this access point"): the RADIUS shared secret is shown once at that moment.',
  radiusReach:
    'The device must reach the ECLOUD RADIUS address over UDP (LAN or the site WireGuard tunnel).',
  portalReach: 'Guest devices must reach the ECLOUD portal host before login (walled garden).',
  apMacs:
    'Register each AP MAC under Access points; it is verified after its first RADIUS request.',
  controller:
    'Register the controller under Controllers (its API credential is sealed and never shown again).',
} as const;

const POSTBACK = 'external-portal-postback';

const LONG_TAIL_PREFLIGHT = [
  'Capture one real redirect from the device in a lab (D-034): ECLOUD has no documented parameter names for this vendor.',
  'Enter the captured parameter names in the NAS post-back profile editor (profile "Any vendor").',
  pf.nas,
  pf.radiusReach,
  pf.portalReach,
];

function longTail(
  vendorKey: string,
  displayName: string,
  productLine: string,
  registryVendorKey: string,
  vendorNotes: readonly string[],
): GalleryEntry {
  return {
    vendorKey,
    displayName,
    productLine,
    adapterKey: POSTBACK,
    profile: GENERIC_POSTBACK_PROFILE_KEY,
    family: 'external-portal',
    registryVendorKey,
    longTail: true,
    preflight: LONG_TAIL_PREFLIGHT,
    vendorNotes,
  };
}

function postback(
  vendorKey: string,
  displayName: string,
  productLine: string,
  profile: string,
  registryVendorKey: string,
  preflight: readonly string[],
): GalleryEntry {
  return {
    vendorKey,
    displayName,
    productLine,
    adapterKey: POSTBACK,
    profile,
    family: 'external-portal',
    registryVendorKey,
    longTail: false,
    preflight: [...preflight, pf.nas, pf.radiusReach, pf.apMacs],
  };
}

/** Gallery catalogue, in display order (first party, owner priorities, then alphabetical tail). */
export const GALLERY_ENTRIES: readonly GalleryEntry[] = Object.freeze([
  {
    vendorKey: 'ezeap-openwifi',
    displayName: 'EZEAP / OpenWiFi',
    productLine: 'EzeLink EZEAP access points (TIP OpenWiFi, uspot captive portal)',
    adapterKey: 'openwifi-uspot-uam',
    profile: null,
    family: 'uam',
    registryVendorKey: 'ezelink',
    longTail: false,
    preflight: [
      'Firmware with the TIP uspot captive portal (registry row EZE-AP1832 r32912).',
      'A UAM secret is mandatory: ECLOUD refuses unsigned redirects.',
      pf.nas,
      pf.radiusReach,
    ],
  },
  {
    vendorKey: 'openwrt-uspot',
    displayName: 'OpenWrt',
    productLine: 'OpenWrt with the upstream uspot captive portal',
    adapterKey: 'uspot-upstream-uam',
    profile: null,
    family: 'uam',
    registryVendorKey: 'openwrt',
    longTail: false,
    preflight: [
      'OpenWrt with the uspot package installed and a captive SSID / interface.',
      'A UAM secret is mandatory: ECLOUD refuses unsigned redirects.',
      pf.nas,
      pf.radiusReach,
    ],
  },
  {
    vendorKey: 'coovachilli',
    displayName: 'CoovaChilli',
    productLine: 'CoovaChilli gateways (OpenWrt or Linux, EZEGATE)',
    adapterKey: 'coovachilli-uam',
    profile: null,
    family: 'uam',
    registryVendorKey: 'coova',
    longTail: false,
    preflight: [
      'CoovaChilli 1.2.9 or later in front of the access points (gateway mode).',
      'A UAM secret is mandatory: ECLOUD refuses unsigned redirects.',
      pf.nas,
      pf.radiusReach,
    ],
  },
  {
    vendorKey: 'teltonika',
    displayName: 'Teltonika',
    productLine: 'Teltonika RutOS routers (Hotspot, CoovaChilli based)',
    adapterKey: 'coovachilli-uam',
    profile: null,
    family: 'uam',
    registryVendorKey: 'teltonika',
    longTail: false,
    preflight: [
      'RutOS with the Hotspot service; RutOS menu labels are REQUIRES_CLARIFICATION (vendor wiki not readable).',
      'A UAM secret is mandatory: ECLOUD refuses unsigned redirects.',
      pf.nas,
      pf.radiusReach,
    ],
  },
  {
    vendorKey: 'mikrotik',
    displayName: 'MikroTik',
    productLine: 'RouterOS HotSpot (router or gateway in front of any AP)',
    adapterKey: 'mikrotik-hotspot',
    profile: null,
    family: 'router-hotspot',
    registryVendorKey: 'mikrotik',
    longTail: false,
    preflight: [
      'RouterOS with a HotSpot server on the guest interface.',
      'You upload the ECLOUD-generated login.html to the router (no secret inside).',
      pf.nas,
      pf.radiusReach,
    ],
  },
  postback(
    'cambium',
    'Cambium Networks',
    'cnPilot E-series / cnMaestro External Hotspot',
    'cambium-hotspot',
    'cambium',
    ['cnPilot E-series AP or cnMaestro with Guest Access (External Hotspot).'],
  ),
  postback(
    'aruba',
    'HPE Aruba',
    'Instant / Central / AOS 8 external captive portal',
    'aruba-ecp',
    'aruba',
    [
      'Instant or Central: the AP intercepts securelogin.arubanetworks.com. AOS 8: switch IP in the redirect.',
    ],
  ),
  postback(
    'cisco-wlc',
    'Cisco Catalyst 9800 / WLC',
    'Catalyst 9800 (IOS-XE) and AireOS WLC external web authentication',
    'cisco-webauth',
    'cisco',
    ['A virtual IP on the WLC; AireOS pre-auth ACLs hold at most 20 entries (third-party note).'],
  ),
  {
    vendorKey: 'cisco-meraki',
    displayName: 'Cisco Meraki',
    productLine: 'Meraki MR splash: sign-on with my RADIUS server',
    adapterKey: 'meraki-splash',
    profile: null,
    family: 'cloud-splash',
    registryVendorKey: 'cisco-meraki',
    longTail: false,
    preflight: [
      'RADIUS comes from the Meraki Cloud, not from the site: the platform must enable Meraki cloud RADIUS (OFF by default) and expose the listener ports.',
      'Leave the NAS IP empty: ECLOUD generates the NAS-Identifier and allocates the listener ports.',
      pf.nas,
    ],
  },
  postback(
    'fortinet',
    'Fortinet',
    'FortiGate / FortiWiFi (and FortiAP managed by FortiGate)',
    'fortinet-ecp',
    'fortinet',
    ['The form post is limited to 125 characters; ECLOUD keeps its fields within it.'],
  ),
  postback(
    'ruckus',
    'Ruckus',
    'ZoneDirector / Unleashed / SmartZone WISPr hotspot (browser login)',
    'ruckus-wispr',
    'ruckus',
    [
      'SmartZone: turn off MAC / IP encryption in the redirect. Passwords are at most 31 characters.',
    ],
  ),
  postback(
    'tplink-omada-portal',
    'TP-Link Omada (portal)',
    'Omada controller external portal with RADIUS',
    'omada-external-portal',
    'tplink-omada',
    ['Cloud-based controllers need the paid Standard plan for captive portal (third-party note).'],
  ),
  {
    vendorKey: 'tplink-omada-api',
    displayName: 'TP-Link Omada (API)',
    productLine: 'Omada controller external portal without RADIUS (hotspot operator API, 6.2.10+)',
    adapterKey: 'omada-api',
    profile: null,
    family: 'controller-api',
    registryVendorKey: 'tplink-omada',
    longTail: false,
    preflight: [
      'Omada controller 6.2.10 or later (the 5.x request body is not built).',
      'ECLOUD must reach the controller over HTTPS (LAN or WireGuard); TLS is always verified.',
      pf.controller,
      pf.apMacs,
    ],
  },
  {
    vendorKey: 'ubiquiti-unifi',
    displayName: 'Ubiquiti UniFi',
    productLine: 'UniFi Network 9.1.105+ Hotspot with External Portal Server',
    adapterKey: 'unifi-external-portal',
    profile: null,
    family: 'controller-api',
    registryVendorKey: 'ubiquiti-unifi',
    longTail: false,
    preflight: [
      'UniFi Network 9.1.105 or later with an API key (Network API).',
      'ECLOUD must reach the controller over HTTPS (LAN or WireGuard); TLS is always verified.',
      pf.controller,
      pf.apMacs,
    ],
  },
  {
    vendorKey: 'juniper-mist',
    displayName: 'Juniper Mist',
    productLine: 'Mist guest portal: forward to external portal (signed grant)',
    adapterKey: 'mist-guest-portal',
    profile: null,
    family: 'controller-api',
    registryVendorKey: 'juniper-mist',
    longTail: false,
    preflight: [
      'A guest WLAN whose portal forwards to an external portal; its API secret signs ECLOUD grants.',
      pf.controller,
      pf.apMacs,
    ],
  },
  postback(
    'huawei',
    'Huawei',
    'AC / FAT AP and eKit cloud external portal (HTTP relay authentication)',
    'huawei-portal',
    'huawei',
    ['The AC HTTP mode without the Huawei Portal protocol is REQUIRES_CLARIFICATION (lab test).'],
  ),
  {
    vendorKey: 'generic-8021x',
    displayName: 'Any vendor: 802.1X / MAC auth',
    productLine: 'WPA2/WPA3-Enterprise or MAC authentication on any vendor (no portal)',
    adapterKey: 'generic-radius-8021x',
    profile: null,
    family: 'radius-8021x',
    registryVendorKey: 'generic-radius',
    longTail: false,
    preflight: [
      'Any AP or controller that can use an external RADIUS server for 802.1X or MAC authentication.',
      pf.nas,
      pf.radiusReach,
    ],
  },
  longTail('grandstream', 'Grandstream', 'GWN76xx (local or GWN Cloud)', 'grandstream', [
    'Third-party notes mention turning off "HTTPS Redirection" and "Secure Portal", and "Pre-authentication rules" for the portal host.',
  ]),
  longTail('engenius', 'EnGenius', 'EnGenius Cloud access points', 'engenius', [
    'Third-party notes mention a "Walled garden" list and an "HTTPS Login" option.',
  ]),
  longTail('zyxel', 'Zyxel', 'Nebula access points', 'zyxel', [
    'Third-party notes: the walled garden holds at most 20 entries; whether RADIUS comes from the AP or the cloud is UNKNOWN.',
  ]),
  longTail('draytek', 'DrayTek', 'Vigor routers (hotspot web portal)', 'draytek', [
    'Third-party notes mention disabling "HTTPS Redirection" and a "Whitelist" of destination domains.',
  ]),
  longTail('ruijie', 'Ruijie', 'Reyee EG gateways with RAP access points', 'ruijie', [
    'Third-party notes mention "Auth Protocol: WISPr" and a "Pre-auth Allowlist".',
  ]),
  longTail('extreme', 'Extreme Networks', 'ExtremeCloud IQ / WiNG', 'extreme', [
    'WiNG substitutes URL tags (for example the AP and client MAC) into the login URL you configure.',
  ]),
  longTail(
    'alcatel-lucent',
    'Alcatel-Lucent',
    'OmniAccess Stellar (Express, OmniVista Cirrus)',
    'alcatel',
    ['Third-party notes mention an "Allow List" of domains and HTTPS redirection turned off.'],
  ),
  longTail('tanaza', 'Tanaza', 'TanazaOS access points', 'tanaza', [
    'Third-party notes mention pre-built domain sets for the walled garden.',
  ]),
  longTail('openmesh', 'OpenMesh', 'CloudTrax (hosted remotely splash + RADIUS)', 'openmesh', [
    'Product availability is UNKNOWN; third-party notes suggest fixed RADIUS ports 1812/1813.',
  ]),
  longTail(
    'generic-portal',
    'Any vendor: external portal',
    'Any AP or gateway with an external captive portal and RADIUS',
    'generic-postback',
    [],
  ),
]);

export function getGalleryEntry(vendorKey: string): GalleryEntry | null {
  return GALLERY_ENTRIES.find((e) => e.vendorKey === vendorKey) ?? null;
}

// ------------------------------------------------------------------------------------------
// Status from evidence
// ------------------------------------------------------------------------------------------

function deviceTested(row: CompatibilityRow): boolean {
  return Object.values(row.capabilities)
    .flat()
    .some(
      (c) =>
        c.status === 'VERIFIED_SUPPORTED' &&
        (c.evidenceLevel === 'LAB_VALIDATED' || c.evidenceLevel === 'PRODUCTION_VALIDATED') &&
        (c.dtRefs ?? []).length > 0,
    );
}

/** Registry rows that carry the evidence of an entry (its vendor, with this adapter or none). */
export function galleryRows(
  entry: GalleryEntry,
  rows: readonly CompatibilityRow[] = COMPATIBILITY_ROWS,
): CompatibilityRow[] {
  return rows.filter(
    (r) =>
      r.vendorKey === entry.registryVendorKey &&
      (r.adapterKey === null || r.adapterKey === entry.adapterKey),
  );
}

export function galleryStatus(
  entry: GalleryEntry,
  rows: readonly CompatibilityRow[] = COMPATIBILITY_ROWS,
): GalleryStatus {
  if (galleryRows(entry, rows).some(deviceTested)) return 'tested_on_device';
  return entry.longTail ? 'generic_profile' : 'documented';
}

// ------------------------------------------------------------------------------------------
// Guide
// ------------------------------------------------------------------------------------------

/** Placeholders that stand for a secret: never filled, never copyable. */
export const SECRET_PLACEHOLDERS = [
  '<RADIUS_SECRET>',
  '<UAM_SECRET>',
  '<DAE_SECRET>',
  '<UNIFI_API_KEY>',
  '<OMADA_OPERATOR_PASSWORD>',
  '<MIST_WLAN_API_SECRET>',
] as const;

export interface GuideValues {
  /** PUBLIC_PORTAL_ORIGIN (scheme + host [+ port]). */
  readonly portalOrigin: string;
  /** Address the devices send RADIUS to; null = not configured (placeholder kept). */
  readonly radiusAddress: string | null;
  readonly authPort: number;
  readonly acctPort: number;
  /** Default Disconnect / CoA port on the NAS. */
  readonly coaPort: number;
  /** Acct-Interim-Interval ECLOUD sends; null = not configured. */
  readonly interimS: number | null;
}

export interface GalleryStep {
  readonly id: string;
  readonly title: string;
  readonly setting: string;
  readonly value: string;
  readonly evidence: readonly string[];
  /** The value holds a secret placeholder: shown once at NAS creation, never here. */
  readonly secret: boolean;
}

export interface GalleryGuide {
  readonly portalUrl: string | null;
  readonly walledGarden: readonly string[];
  readonly radius: {
    readonly address: string | null;
    readonly authPort: number;
    readonly acctPort: number;
    readonly coaPort: number;
  } | null;
  readonly steps: readonly GalleryStep[];
}

const R36: EvidenceRef = {
  kind: 'doc-section',
  ref: 'docs/VENDOR_INTEGRATION_RESEARCH.md §3.6, §8 (unifi-external-portal)',
};
const R37: EvidenceRef = {
  kind: 'doc-section',
  ref: 'docs/VENDOR_INTEGRATION_RESEARCH.md §3.7, §8 (omada-api)',
};
const R38: EvidenceRef = {
  kind: 'doc-section',
  ref: 'docs/VENDOR_INTEGRATION_RESEARCH.md §3.8, §8 (mist-guest-portal)',
};
const R5: EvidenceRef = {
  kind: 'doc-section',
  ref: 'docs/VENDOR_INTEGRATION_RESEARCH.md §5, §6 item 11 (long-tail vendors)',
};

function s(
  id: string,
  title: string,
  setting: string,
  value: string,
  refs: readonly EvidenceRef[],
): SetupStep {
  return { id, title, setting, value, evidenceRefs: refs };
}

function controllerApiSteps(entry: GalleryEntry): SetupStep[] {
  switch (entry.adapterKey) {
    case 'unifi-external-portal':
      return [
        s(
          'unifi-portal',
          'Hotspot: send guests to an external portal server (ECLOUD)',
          'Hotspot Manager > Portal > External Portal Server',
          '<PORTAL_HOST>',
          [R36],
        ),
        s(
          'unifi-path',
          'UniFi adds /guest/s/<site>/ and the guest parameters itself; ECLOUD accepts this path',
          'Redirect path (sent by UniFi)',
          '<PORTAL_ORIGIN>/guest/s/<UNIFI_SITE>/',
          [R36],
        ),
        s(
          'unifi-preauth',
          'Pre-authorization access: the ECLOUD portal host',
          'Pre-Authorization Allowances',
          '<PORTAL_HOST>',
          [R36],
        ),
        s(
          'unifi-api-key',
          'Create a Network API key and store it on the ECLOUD controller (write-only, sealed)',
          'Integrations > API key',
          '<UNIFI_API_KEY>',
          [R36],
        ),
        s(
          'unifi-controller',
          'Register the controller in ECLOUD: UniFi Network API, base URL, Network API site id and the UniFi site name of the redirect path',
          'ECLOUD > Controllers {api_kind, base URL, site id, UniFi site name}',
          'unifi-network, https://<CONTROLLER_HOST>, <UNIFI_SITE_ID>, <UNIFI_SITE>',
          [R36],
        ),
        s(
          'unifi-nas',
          'Register the site as a NAS with adapter unifi-external-portal, then each AP MAC under Access points (the guest is matched by a verified AP MAC)',
          'ECLOUD > NAS + Access points',
          '<AP_MAC>',
          [R36],
        ),
      ];
    case 'omada-api':
      return [
        s(
          'omada-portal',
          'Portal: authentication by an external portal server without RADIUS (ECLOUD)',
          'Portal > Authentication Type > External Portal Server',
          '<PORTAL_ORIGIN>/ext/omada',
          [R37],
        ),
        s(
          'omada-preauth',
          'Pre-Authentication Access: the ECLOUD portal host',
          'Pre-Authentication Access',
          '<PORTAL_HOST>',
          [R37],
        ),
        s(
          'omada-operator',
          'Create a Hotspot Operator account for ECLOUD and store its password on the ECLOUD controller (write-only, sealed)',
          'Hotspot Manager > Operators {name, password}',
          '<OMADA_OPERATOR_NAME>, <OMADA_OPERATOR_PASSWORD>',
          [R37],
        ),
        s(
          'omada-controller',
          'Register the controller in ECLOUD: Omada controller (operator), base URL and the CONTROLLER_ID path segment',
          'ECLOUD > Controllers {api_kind, base URL, username, CONTROLLER_ID}',
          'omada-controller, https://<CONTROLLER_HOST>:<PORT>, <OMADA_OPERATOR_NAME>, <OMADA_CONTROLLER_ID>',
          [R37],
        ),
        s(
          'omada-nas',
          'Register the site as a NAS with adapter omada-api, then each AP MAC under Access points',
          'ECLOUD > NAS + Access points',
          '<AP_MAC>',
          [R37],
        ),
      ];
    case 'mist-guest-portal':
      return [
        s(
          'mist-forward',
          'Guest portal: forward to external portal (ECLOUD)',
          'WLAN > Guest Portal > Forward to external portal > Portal URL',
          '<PORTAL_ORIGIN>/ext/mist',
          [R38],
        ),
        s(
          'mist-allowed',
          'Allowed hostnames before login: the ECLOUD portal host',
          'WLAN > Guest Portal > Allowed Hostnames',
          '<PORTAL_HOST>',
          [R38],
        ),
        s(
          'mist-secret',
          'Copy the guest WLAN API secret into the ECLOUD controller (write-only, sealed); it signs the time-limited authorise URL',
          'WLAN > Guest Portal > API secret',
          '<MIST_WLAN_API_SECRET>',
          [R38],
        ),
        s(
          'mist-controller',
          'Register the controller in ECLOUD: Juniper Mist, portal host of your Mist cloud and the guest WLAN ids',
          'ECLOUD > Controllers {api_kind, Mist portal host, guest WLAN ids}',
          'mist, portal.mist.com (or portal.<region>.mist.com), <MIST_WLAN_ID>',
          [R38],
        ),
        s(
          'mist-nas',
          'Register the site as a NAS with adapter mist-guest-portal, then each AP MAC under Access points',
          'ECLOUD > NAS + Access points',
          '<AP_MAC>',
          [R38],
        ),
      ];
    default:
      return [];
  }
}

let genericProfile: PostbackProfile | null = null;

/** The generic post-back profile used for guide steps (the names are entered per NAS). */
function genericPostbackProfile(): PostbackProfile {
  if (genericProfile !== null) return genericProfile;
  const cfg = parsePostbackNasConfig({
    profile: GENERIC_POSTBACK_PROFILE_KEY,
    generic: {
      params: { client_mac: 'client_mac', login_url: 'login_url' },
      fields: {},
      method: 'POST',
      login_path: '/login',
    },
  });
  const profile = cfg.ok ? profileForConfig(cfg.config) : null;
  if (profile === null) throw new Error('generic post-back profile cannot be built');
  genericProfile = profile;
  return profile;
}

const SITE = { siteId: '<SITE_ID>', nasId: '<NAS_IDENTIFIER>' };

/** Unresolved steps of an entry (adapter builders; portal origin passed where they take it). */
function rawSteps(entry: GalleryEntry, origin: string): readonly SetupStep[] {
  switch (entry.adapterKey) {
    case 'mikrotik-hotspot':
      return mikrotikSetupGuide(origin);
    case 'meraki-splash':
      return merakiSetupGuide();
    case 'unifi-external-portal':
    case 'omada-api':
    case 'mist-guest-portal':
      return controllerApiSteps(entry);
    case POSTBACK: {
      const profile = entry.longTail
        ? genericPostbackProfile()
        : builtinPostbackProfile(entry.profile ?? '');
      if (profile === null) return [];
      const steps = postbackSetupGuide(profile, SITE);
      if (!entry.longTail) return steps;
      return [
        s(
          'capture-redirect',
          'Lab first: capture one real redirect from the device (parameter names and the login URL it posts to); ECLOUD does not guess them',
          'Captured redirect (lab, D-034)',
          '<CAPTURED_REDIRECT>',
          [R5],
        ),
        ...steps,
      ];
    }
    default:
      if (entry.vendorKey === 'teltonika') return teltonikaSetupGuide(origin, SITE);
      return getVendorAdapter(entry.adapterKey).buildSetupGuide(SITE);
  }
}

function portalUrlOf(entry: GalleryEntry, origin: string): string | null {
  switch (entry.adapterKey) {
    case 'openwifi-uspot-uam':
    case 'uspot-upstream-uam':
      return `${origin}/uam/uspot/`;
    case 'coovachilli-uam':
      return `${origin}/uam/chilli/`;
    case 'mikrotik-hotspot':
      return `${origin}/hotspot/mikrotik/`;
    case 'meraki-splash':
      return `${origin}/meraki/<NAS_IDENTIFIER>/`;
    case 'unifi-external-portal':
      return `${origin}/guest/s/<UNIFI_SITE>/`;
    case 'omada-api':
      return `${origin}/ext/omada`;
    case 'mist-guest-portal':
      return `${origin}/ext/mist`;
    case POSTBACK:
      return `${origin}/pb/${entry.profile ?? GENERIC_POSTBACK_PROFILE_KEY}/<NAS_IDENTIFIER>/`;
    default:
      return null;
  }
}

function usesSiteRadius(entry: GalleryEntry): boolean {
  return entry.family !== 'controller-api' && entry.family !== 'cloud-splash';
}

/**
 * The NAS-independent guide of an entry with ECLOUD values filled in. Per-NAS values (NAS
 * identifier, NAS IP, AP MACs) and every secret stay placeholders.
 */
export function buildGalleryGuide(entry: GalleryEntry, values: GuideValues): GalleryGuide {
  const origin = values.portalOrigin.replace(/\/+$/, '');
  const host = new URL(origin).host;
  const defaultHost = new URL(PORTAL_ORIGIN).host;
  const coaPort =
    entry.adapterKey === 'mikrotik-hotspot' ? MIKROTIK_DEFAULT_COA_PORT : values.coaPort;
  const fill: Record<string, string> = {
    '<PORTAL_ORIGIN>': origin,
    '<PORTAL_HOST>': host,
    '<PORTAL_MERAKI_URL>': `${origin}/meraki/<NAS_IDENTIFIER>/`,
    '<DAS_PORT>': String(coaPort),
  };
  if (values.radiusAddress !== null && usesSiteRadius(entry)) {
    fill['<ECLOUD_RADIUS_ADDRESS>'] = values.radiusAddress;
  }
  if (values.interimS !== null) fill['<INTERIM_SECONDS>'] = String(values.interimS);
  const resolve = (text: string, ports = true): string => {
    let out = text.split(PORTAL_ORIGIN).join(origin);
    if (host !== defaultHost) out = out.split(defaultHost).join(host);
    // Walled-garden lists: the tenant's identity-provider hosts are added by the operator.
    out = out.replace(/,\s*<IDP_HOSTS>/g, '');
    out = out.replace(/<[A-Z_]+>/g, (token) => fill[token] ?? token);
    if (ports && usesSiteRadius(entry)) {
      out = out
        .replace(/\b1812\b/g, String(values.authPort))
        .replace(/\b1813\b/g, String(values.acctPort));
    }
    return out;
  };
  const steps = rawSteps(entry, origin).map((st): GalleryStep => {
    const value = resolve(st.value);
    return {
      id: st.id,
      title: resolve(st.title, false),
      setting: st.setting,
      value,
      evidence: st.evidenceRefs.map((r) => r.ref),
      secret: SECRET_PLACEHOLDERS.some((p) => value.includes(p)),
    };
  });
  return {
    portalUrl: portalUrlOf(entry, origin),
    walledGarden: [host],
    radius: usesSiteRadius(entry)
      ? {
          address: values.radiusAddress,
          authPort: values.authPort,
          acctPort: values.acctPort,
          coaPort,
        }
      : null,
    steps,
  };
}
