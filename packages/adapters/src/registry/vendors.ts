/**
 * Vendor entries (MULTI_VENDOR_INTEGRATION_PLAN.md §7.2–§7.4). Presence on the Social WiFi live
 * hardware list is a roadmap reference only, never compatibility evidence (plan §7.4).
 */
import type { EvidenceRef } from '@ecloud/shared';
import type { RoadmapPhase, VendorEntry } from './types.js';

/** Cambium sources actually read on 2026-10-08 (plan §7.3, §12). */
export const CAMBIUM_SOURCES = {
  C1: {
    kind: 'url',
    ref: 'C1 · Cambium "Guest Access Portal Integration — cnPilot E400, E500, ePMP1000 Hotspot" (2016)',
    url: 'https://community.cambiumnetworks.com/bstrc49894/attachments/bstrc49894/cnPilot_Indoor/328/1/Guest%20Access%20Portal%20Integration%20(002).pdf',
  },
  C2: {
    kind: 'url',
    ref: 'C2 · "Guest Access WLAN-External Hotspot with RADIUS Authentication" (Cambium community, 2021-12-08)',
    url: 'https://community.cambiumnetworks.com/t/guest-access-wlan-external-hotspot-with-radius-authentication/82858',
  },
  C2_PDF: {
    kind: 'url',
    ref: 'C2 (PDF form)',
    url: 'https://community.cambiumnetworks.com/uploads/short-url/vjDQ142pgECAJcUvoXyLklkJrla.pdf',
  },
  C3: {
    kind: 'url',
    ref: 'C3 · cnMaestro 5.2.2 (Cloud) Release Notes',
    url: 'https://community.cambiumnetworks.com/t/cnmaestro-5-2-2-cloud-release-notes/106564',
  },
  C4: {
    kind: 'url',
    ref: 'C4 · Guidance for cnMaestro Enterprise Customers (updated 24 Sep 2026)',
    url: 'https://community.cambiumnetworks.com/t/guidance-for-cnmaestro-enterprise-customers-updated-24-sep-2026/108849',
  },
  C5: {
    kind: 'url',
    ref: 'C5 · "Third party captive portals" (Cambium community, 2018)',
    url: 'https://community.cambiumnetworks.com/t/third-party-captive-portals/57831',
  },
  S1: {
    kind: 'url',
    ref: 'S1 · Social WiFi cnMaestro guide (third-party, functional reference only)',
    url: 'https://academy.socialwifi.com/en/hardware-and-installation/installation-guides/cambium-networks/cnmaestro/',
  },
} as const satisfies Record<string, EvidenceRef>;

const SOCIAL_WIFI_LIST = 'https://socialwifi.com/hardware-integrations/';

interface RoadmapVendor {
  readonly key: string;
  readonly name: string;
  readonly phase: RoadmapPhase;
  readonly onSocialWifiList: boolean;
  readonly note?: string;
}

/** Plan §7.4: 23 roadmap vendors, lifecycle `planned`, every capability `UNKNOWN`. */
export const ROADMAP_VENDORS: readonly RoadmapVendor[] = [
  {
    key: 'mikrotik',
    name: 'MikroTik',
    phase: 'phase-b',
    onSocialWifiList: true,
    note: 'also a gateway-mode candidate (spec §2); UNKNOWN',
  },
  { key: 'ubiquiti-unifi', name: 'Ubiquiti UniFi', phase: 'phase-b', onSocialWifiList: true },
  {
    key: 'tplink-omada',
    name: 'TP-Link Omada',
    phase: 'phase-b',
    onSocialWifiList: true,
    note: 'research lead only (third-party, https://academy.socialwifi.com/en/hardware-and-installation/hardware-faqs/recommended-devices/): Omada cloud "Essentials" plan reportedly lacks captive-portal functionality',
  },
  { key: 'aruba', name: 'Aruba', phase: 'phase-c', onSocialWifiList: true },
  { key: 'cisco', name: 'Cisco', phase: 'phase-c', onSocialWifiList: true },
  {
    key: 'cisco-meraki',
    name: 'Cisco Meraki',
    phase: 'phase-c',
    onSocialWifiList: false,
    note: 'separate variant required by spec §2',
  },
  { key: 'ruckus', name: 'Ruckus', phase: 'phase-c', onSocialWifiList: true },
  { key: 'grandstream', name: 'Grandstream', phase: 'phase-c', onSocialWifiList: true },
  { key: 'engenius', name: 'EnGenius', phase: 'phase-c', onSocialWifiList: true },
  { key: 'fortinet', name: 'Fortinet', phase: 'phase-c', onSocialWifiList: true },
  { key: 'huawei', name: 'Huawei', phase: 'phase-c', onSocialWifiList: true },
  { key: 'ruijie', name: 'Ruijie', phase: 'phase-c', onSocialWifiList: true },
  { key: 'zyxel', name: 'Zyxel', phase: 'phase-c', onSocialWifiList: true },
  { key: 'juniper-mist', name: 'Juniper Mist', phase: 'phase-c', onSocialWifiList: true },
  { key: 'extreme', name: 'Extreme Networks', phase: 'phase-c', onSocialWifiList: true },
  { key: 'alcatel', name: 'Alcatel', phase: 'phase-c', onSocialWifiList: true },
  { key: 'dcn', name: 'DCN', phase: 'phase-c', onSocialWifiList: true },
  { key: 'draytek', name: 'DrayTek', phase: 'phase-c', onSocialWifiList: true },
  { key: 'openmesh', name: 'OpenMesh', phase: 'phase-c', onSocialWifiList: true },
  { key: 'tanaza', name: 'Tanaza', phase: 'phase-c', onSocialWifiList: true },
  { key: 'teltonika', name: 'Teltonika', phase: 'phase-c', onSocialWifiList: true },
  {
    key: 'aerohive',
    name: 'Aerohive',
    phase: 'legacy-candidate',
    onSocialWifiList: false,
    note: 'spec: investigate only, no assumed support',
  },
  {
    key: 'ignitenet',
    name: 'IgniteNet',
    phase: 'legacy-candidate',
    onSocialWifiList: false,
    note: 'spec: investigate only, no assumed support',
  },
];

function roadmapNotes(v: RoadmapVendor): string {
  const list = v.onSocialWifiList
    ? `On the Social WiFi live list (${SOCIAL_WIFI_LIST}, read 2026-10-08) — roadmap reference only, not compatibility evidence.`
    : 'Not on the Social WiFi live list.';
  return v.note ? `${list} ${v.note}` : list;
}

/**
 * Roadmap vendors promoted by a multi-vendor cycle: they leave the `planned` placeholder set
 * (their `<key>-planned` row is no longer generated) and get an explicit entry below.
 */
export const PROMOTED_VENDOR_ENTRIES: readonly VendorEntry[] = [
  // Cycle B (D-044): MikroTik RouterOS Hotspot adapter + Teltonika RutOS profile.
  {
    key: 'mikrotik',
    name: 'MikroTik',
    lifecycle: 'implemented',
    roadmapPhase: 'phase-b',
    docLinks: [
      {
        kind: 'url',
        ref: 'MikroTik RouterOS 7.26 manual: RADIUS',
        url: 'https://help.mikrotik.com/docs/spaces/ROS/pages/328097/RADIUS',
      },
      {
        kind: 'url',
        ref: 'MikroTik RouterOS 7.26 manual: Hotspot customisation',
        url: 'https://help.mikrotik.com/docs/spaces/ROS/pages/87162881/Hotspot+customisation',
      },
      { kind: 'doc-section', ref: 'docs/VENDOR_INTEGRATION_RESEARCH.md §3.3 (mikrotik-hotspot)' },
    ],
    notes:
      'Cycle B: `mikrotik-hotspot` adapter (native or gateway in front of any AP). DOCUMENTED / REQUIRES_DEVICE_TEST only; no lab test (D-028).',
  },
  {
    key: 'teltonika',
    name: 'Teltonika',
    lifecycle: 'implemented',
    roadmapPhase: 'phase-c',
    docLinks: [
      {
        kind: 'doc-section',
        ref: 'docs/VENDOR_INTEGRATION_RESEARCH.md §3.2 (Teltonika on coovachilli-uam)',
      },
    ],
    notes:
      'Cycle B: RutOS Hotspot profile on the existing `coovachilli-uam` adapter. UAM parameter set, `md`, password encoding and CoA REQUIRES_DEVICE_TEST / REQUIRES_CLARIFICATION (vendor wiki not fetchable, HTTP 403).',
  },
];

export const PROMOTED_VENDOR_KEYS: ReadonlySet<string> = new Set(
  PROMOTED_VENDOR_ENTRIES.map((v) => v.key),
);

export const VENDORS: readonly VendorEntry[] = Object.freeze([
  {
    key: 'ezelink',
    name: 'EzeLink (EZEAP, TIP OpenWiFi)',
    lifecycle: 'implemented',
    roadmapPhase: 'pilot',
    docLinks: [
      { kind: 'doc-section', ref: 'PHASE2_VALIDATION.md §2.1, §2.2, §5.4 (DT-01)' },
      { kind: 'doc-section', ref: 'DECISIONS.md D-002, D-012, D-013, D-035' },
    ],
  },
  {
    key: 'coova',
    name: 'CoovaChilli (EzeLink gateway)',
    lifecycle: 'implemented',
    roadmapPhase: 'pilot',
    docLinks: [
      { kind: 'doc-section', ref: 'PHASE2_VALIDATION.md §2.3 (V-070…V-079)' },
      { kind: 'doc-section', ref: 'CAPTIVE_PORTAL_ARCHITECTURE.md §4, §5' },
    ],
  },
  {
    key: 'openwrt',
    name: 'OpenWrt uspot (upstream f00b4r0)',
    lifecycle: 'implemented',
    roadmapPhase: 'pilot',
    docLinks: [{ kind: 'doc-section', ref: 'CAPTIVE_PORTAL_ARCHITECTURE.md §3 (U)' }],
    notes:
      'Vendor key added in L2 for the generic `openwrt-uspot-upstream` row (plan §7.2); no device in inventory.',
  },
  {
    key: 'generic-radius',
    name: 'Any vendor: 802.1X / MAC-auth (generic RADIUS NAS)',
    lifecycle: 'implemented',
    roadmapPhase: 'pilot',
    docLinks: [
      {
        kind: 'doc-section',
        ref: 'docs/VENDOR_INTEGRATION_RESEARCH.md §2 F9, §3.1 (generic-radius-8021x)',
      },
      { kind: 'doc-section', ref: 'DECISIONS.md D-044 (Cycle A)' },
    ],
    notes:
      'Pseudo-vendor for the vendor-neutral 802.1X / MAC-auth adapter (Cycle A). Not a hardware claim: every capability stays DOCUMENTED / REQUIRES_DEVICE_TEST until a lab test per vendor (D-028).',
  },
  {
    key: 'generic-postback',
    name: 'Any vendor: external captive portal post-back',
    lifecycle: 'implemented',
    roadmapPhase: 'pilot',
    docLinks: [
      {
        kind: 'doc-section',
        ref: 'docs/VENDOR_INTEGRATION_RESEARCH.md §2 F3, §3.4 (external-portal-postback)',
      },
      { kind: 'doc-section', ref: 'MULTI_VENDOR_INTEGRATION_PLAN.md §15 (Cycle C)' },
    ],
    notes:
      'Pseudo-vendor for the F3 post-back engine (Cycle C): built-in profiles for Cambium, Aruba, Cisco, Fortinet, Ruckus, Omada, Huawei and an admin-configured generic profile. Not a hardware claim: DOCUMENTED / REQUIRES_DEVICE_TEST until a lab test per vendor (D-028).',
  },
  {
    key: 'cambium',
    name: 'Cambium Networks',
    lifecycle: 'researched',
    roadmapPhase: 'phase-a',
    docLinks: Object.values(CAMBIUM_SOURCES),
    notes:
      'Researched only (plan §7.3). ECLOUD must not depend on cnMaestro Cloud (C4); AP-side External Hotspot + RADIUS is the primary candidate; no adapter.',
  },
  ...ROADMAP_VENDORS.filter((v) => !PROMOTED_VENDOR_KEYS.has(v.key)).map((v): VendorEntry =>
    v.key === 'cisco-meraki'
      ? {
          // Cycle E (D-044): the MR splash sign-on row is implemented (build/test only:
          // MERAKI_CLOUD_RADIUS_ENABLED default OFF); the roadmap row stays planned, so
          // cisco-meraki is deliberately not a PROMOTED_VENDOR_ENTRIES vendor.
          key: v.key,
          name: v.name,
          lifecycle: 'implemented',
          roadmapPhase: v.phase,
          docLinks: [
            {
              kind: 'doc-section',
              ref: 'docs/VENDOR_INTEGRATION_RESEARCH.md §2 F4, §3.5 (meraki-splash)',
            },
            { kind: 'doc-section', ref: 'DECISIONS.md D-044 (Cycle E)' },
          ],
          notes: `${roadmapNotes(v)} Cycle E: meraki-splash implemented; nothing lab-validated (D-028).`,
        }
      : {
          key: v.key,
          name: v.name,
          lifecycle: 'planned',
          roadmapPhase: v.phase,
          docLinks: [],
          notes: roadmapNotes(v),
        },
  ),
  ...PROMOTED_VENDOR_ENTRIES,
]);
