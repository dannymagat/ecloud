/**
 * Compatibility registry rows (MULTI_VENDOR_INTEGRATION_PLAN.md §7.2–§7.4). Implemented rows
 * derive their capability cells from the engine records (single source, no drift); only the
 * DT-01 findings are LAB_VALIDATED (plan R-36). Third-party vendors appear here only as data:
 * no adapter exists for any of them.
 */
import type { EvidenceLevel, EvidenceRef } from '@ecloud/shared';
import { getAdapter } from '../registry.js';
import {
  APPLIES_COOVA_MASTER,
  APPLIES_TIP_USPOT,
  APPLIES_UPSTREAM_USPOT,
  SRC,
} from '../source-refs.js';
import { deriveCells, unknownCells } from './derive.js';
import { DT_RESULTS } from './dt-results.js';
import type {
  CapabilityGroup,
  CompatibilityProfile,
  CompatibilityRow,
  OpenItem,
  RegistryCell,
  RegistryFact,
} from './types.js';
import { CAMBIUM_SOURCES as C, ROADMAP_VENDORS } from './vendors.js';

export * from './types.js';

// ------------------------------------------------------------------------------------------
// Small builders
// ------------------------------------------------------------------------------------------

const doc = (ref: string): EvidenceRef => ({ kind: 'doc-section', ref });
const dt = (id: string): EvidenceRef => ({ kind: 'device-test', ref: id });
const source = (ref: string, appliesTo: string): EvidenceRef => ({
  kind: 'source',
  ref,
  appliesTo,
});

function fact(
  value: string,
  evidenceLevel: EvidenceLevel,
  evidenceRefs: readonly EvidenceRef[],
  label?: string,
): RegistryFact {
  return label
    ? { value, evidenceLevel, evidenceRefs, label }
    : { value, evidenceLevel, evidenceRefs };
}

function unknown(evidenceRefs: readonly EvidenceRef[] = [], label?: string): RegistryFact {
  return label
    ? { value: 'UNKNOWN', evidenceLevel: null, evidenceRefs, label }
    : { value: 'UNKNOWN', evidenceLevel: null, evidenceRefs };
}

function cell(
  capability: string,
  status: RegistryCell['status'],
  evidenceLevel: EvidenceLevel | null,
  evidenceRefs: readonly EvidenceRef[],
  note?: string,
): RegistryCell {
  return note
    ? { capability, status, evidenceLevel, evidenceRefs, note }
    : { capability, status, evidenceLevel, evidenceRefs };
}

function groups(
  partial: Partial<Record<CapabilityGroup, readonly RegistryCell[]>>,
): Readonly<Record<CapabilityGroup, readonly RegistryCell[]>> {
  return {
    captivePortal: partial.captivePortal ?? [],
    accounting: partial.accounting ?? [],
    bandwidth: partial.bandwidth ?? [],
    disconnect: partial.disconnect ?? [],
    monitoring: partial.monitoring ?? [],
    configuration: partial.configuration ?? [],
  };
}

const allUnknownProfile = (): CompatibilityProfile => ({
  licensing: unknown(),
  redirectProtocol: unknown(),
  authorizationMethod: unknown(),
  radiusAuth: unknown(),
  radiusAccounting: unknown(),
  accountingInterval: unknown(),
  disconnectCoa: unknown(),
  bandwidthAttributes: unknown(),
  quotaEnforcement: unknown(),
  sessionTimeout: unknown(),
  ipv6Behaviour: unknown(),
  roamingContinuity: unknown(),
  cloudDependencies: unknown(),
  transport: unknown(),
});

// ------------------------------------------------------------------------------------------
// Row 1 + companions — EZE-AP1832 / EZEAP 6 r32912 (plan §7.2)
// ------------------------------------------------------------------------------------------

const AP1832_MODEL = 'EZE-AP1832';
const AP1832_FIRMWARE = 'EZEAP 6 r32912-6639b15f62';
const DT01 = [dt('DT-01'), doc('PHASE2_VALIDATION.md §5.4 (DT-01 row)')];

const AP1832_IDENTITY: readonly RegistryFact[] = [
  fact('EZE-AP1832 (`ezelink,ap1832`, ipq50xx)', 'LAB_VALIDATED', DT01, 'hardwareModel'),
  fact(
    'EZEAP 6 r32912-6639b15f62 (TIP `EZEAP v6 de7aaa37`, devel), kernel 5.4.164',
    'LAB_VALIDATED',
    DT01,
    'firmware',
  ),
  fact(
    'uCentral client 4.2.0, schema 4.2.0 (`ucentral-schema` 2026.07.25~818569f4)',
    'LAB_VALIDATED',
    DT01,
    'ucentralSchema',
  ),
  fact(
    'EZE controller (ezecontroller) uCentral gateway; version not recorded',
    'DOCUMENTED',
    [doc('DECISIONS.md D-013 (not observed by DT-01)')],
    'controller',
  ),
  fact(
    'TIP fork (`wlan-ap/feeds/ucentral/uspot`, spotfilter + ratelimit, no DAS in uspot)',
    'LAB_VALIDATED',
    [...DT01, doc('DECISIONS.md D-035')],
    'uspotVariant',
  ),
];

const AP1832_CONTROLLER = {
  product: 'EZE controller (ezecontroller uCentral gateway)',
  version: 'UNKNOWN',
};

const AP1832_OPEN_ITEMS: readonly OpenItem[] = [
  {
    id: 'OQ-9',
    label: 'REQUIRES_DEVICE_TEST',
    text: 'IPv6 on captive SSIDs: enforcement or explicit guest-VLAN IPv6 restriction.',
  },
  {
    id: 'OQ-14',
    label: 'REQUIRES_DEVICE_TEST',
    text: 'First-party enforcement cells (DT-02…DT-24) and roaming/session continuity on EZEAP.',
  },
];

const AP1832_COMMON_PROFILE = {
  ipv6Behaviour: unknown([doc('MULTI_VENDOR_INTEGRATION_PLAN.md OQ-9')]),
  roamingContinuity: unknown([doc('MULTI_VENDOR_INTEGRATION_PLAN.md OQ-14')]),
  licensing: fact('none known beyond the EZE controller', 'DOCUMENTED', [
    doc('DECISIONS.md D-013'),
  ]),
  cloudDependencies: fact('none known beyond the EZE controller', 'DOCUMENTED', [
    doc('DECISIONS.md D-013'),
  ]),
  transport: fact(
    'topology A (gateway WireGuard peer) or C (RadSec via `radius-gw-proxy`, installed per DT-01; behaviour → DT-21); AP as WireGuard peer UNSUPPORTED on this firmware',
    'DOCUMENTED',
    [doc('DECISIONS.md D-010, D-032')],
  ),
} as const;

/** DT-01 negative finding (R-36 item 2): no wireguard/unetd package or kmod on r32912. */
const AP_WIREGUARD_PEER: RegistryCell = {
  capability: 'apWireguardPeer',
  status: 'UNSUPPORTED',
  evidenceLevel: 'LAB_VALIDATED',
  evidenceRefs: [...DT01, doc('DECISIONS.md D-010')],
  dtRefs: ['DT-01'],
  note: 'AP as WireGuard peer (topology B): no wireguard/unetd on this firmware (negative result, not enforcement).',
};

const TIP_ROW_ID = 'ezelink-eze-ap1832-r32912-tip-uspot';

const tipUspotRow: CompatibilityRow = {
  key: TIP_ROW_ID,
  vendorKey: 'ezelink',
  hardwareModel: AP1832_MODEL,
  firmware: AP1832_FIRMWARE,
  controller: AP1832_CONTROLLER,
  lifecycle: 'implemented',
  deploymentModes: ['native'],
  enforcementPoint: 'ap',
  adapterKey: 'openwifi-uspot-uam',
  sourceVersionMatchesDevice: true,
  identity: [
    ...AP1832_IDENTITY,
    fact(
      'true (scoped): DT-01 identified the on-device uspot as the TIP fork (spotfilter + ratelimit) and found the reply-attribute names in its code; the exact source revision analysed was not compared byte-for-byte, and attribute honouring is not tested',
      'LAB_VALIDATED',
      DT01,
      'sourceVersionMatchesDevice',
    ),
  ],
  profile: {
    ...AP1832_COMMON_PROFILE,
    redirectProtocol: fact(
      'ChilliSpot UAM (`res, uamip, uamport, challenge, mac, ip, called, nasid, ssid, sessionid, userurl, md`)',
      'VERIFIED_FROM_SOURCE',
      [
        source('V-042 · T portal.uc L221-238', APPLIES_TIP_USPOT),
        doc('CAPTIVE_PORTAL_ARCHITECTURE.md §3.2, §7.4'),
      ],
    ),
    authorizationMethod: fact(
      'browser-form, UAM `logon` (PAP XOR / CHAP), RADIUS',
      'VERIFIED_FROM_SOURCE',
      [
        source('V-044 · T handler-uam.uc L10-45', APPLIES_TIP_USPOT),
        doc('CAPTIVE_PORTAL_ARCHITECTURE.md §3.3'),
      ],
    ),
    radiusAuth: fact(
      'Access-Request: User-Name, User-Password/CHAP, Acct-Session-Id, Framed-IP-Address, Called-Station-Id (nasmac:ssid), Calling-Station-Id, NAS-IP-Address (formats → DT-03)',
      'VERIFIED_FROM_SOURCE',
      [source('V-048 · T portal.uc radius_init, src/radius.c', APPLIES_TIP_USPOT)],
    ),
    radiusAccounting: fact(
      'Start/Interim/Stop + Accounting-On/Off when acct_server and acct_secret set; 32-bit octets',
      'VERIFIED_FROM_SOURCE',
      [source('V-057 · T uspot.uc client_interim, radius_terminate', APPLIES_TIP_USPOT)],
    ),
    accountingInterval: fact(
      'Acct-Interim-Interval honoured only if NAS acct-interval unset (→ DT-05)',
      'VERIFIED_FROM_SOURCE',
      [SRC.V051_T],
    ),
    disconnectCoa: fact(
      'Disconnect: hostapd DAS → uspot kick, no Acct-Stop — REQUIRES_DEVICE_TEST (D-006, → DT-07); CoA attribute change: UNSUPPORTED (→ DT-08)',
      'VERIFIED_FROM_SOURCE',
      [
        source('V-058 · T uspot.uc hapd_subscriber_notify_cb l.362-368', APPLIES_TIP_USPOT),
        SRC.V059,
      ],
    ),
    bandwidthAttributes: fact(
      'per-client WISPr bit/s or ChilliSpot kbit/s → ratelimit (honouring → DT-04)',
      'VERIFIED_FROM_SOURCE',
      [SRC.V052, SRC.V053_T],
    ),
    quotaEnforcement: fact(
      '`ChilliSpot-Max-Total-Octets`, 32-bit (→ DT-06)',
      'VERIFIED_FROM_SOURCE',
      [SRC.V054_T],
    ),
    sessionTimeout: fact(
      'Session-Timeout, Idle-Timeout from the reply (→ DT-05)',
      'VERIFIED_FROM_SOURCE',
      [SRC.V050_T],
    ),
  },
  capabilities: deriveCells(getAdapter('openwifi-uspot-uam').capabilities(), {
    rowKey: TIP_ROW_ID,
    sourceVersionMatchesDevice: true,
    deviceFirmware: AP1832_FIRMWARE,
    dtResults: DT_RESULTS,
    extraCells: { configuration: [AP_WIREGUARD_PEER] },
  }),
  configurationKind: 'ucentral',
  openItems: AP1832_OPEN_ITEMS,
};

const HOSTAPD_ROW_ID = 'ezelink-eze-ap1832-r32912-hostapd-radius';

const hostapdRow: CompatibilityRow = {
  key: HOSTAPD_ROW_ID,
  vendorKey: 'ezelink',
  hardwareModel: AP1832_MODEL,
  firmware: AP1832_FIRMWARE,
  controller: AP1832_CONTROLLER,
  lifecycle: 'implemented',
  deploymentModes: ['native'],
  enforcementPoint: 'ap',
  adapterKey: 'openwifi-hostapd-radius',
  sourceVersionMatchesDevice: null,
  identity: AP1832_IDENTITY,
  profile: {
    ...AP1832_COMMON_PROFILE,
    redirectProtocol: fact('none (802.1X / MAC-auth SSIDs, no portal)', 'DOCUMENTED', [
      doc('NETWORK_INTEGRATION.md §1.2'),
    ]),
    authorizationMethod: fact('802.1X or RADIUS MAC-auth by hostapd', 'DOCUMENTED', [
      doc('NETWORK_INTEGRATION.md §2 row "RADIUS MAC authentication"'),
    ]),
    radiusAuth: fact('hostapd Access-Request field formats → DT-03/DT-09', 'DOCUMENTED', [
      doc('PHASE2_VALIDATION.md V-032'),
    ]),
    radiusAccounting: fact('hostapd Start/Interim/Stop, acct_interval 60-600', 'DOCUMENTED', [
      doc('PHASE2_VALIDATION.md V-007'),
    ]),
    accountingInterval: fact(
      'hostapd acct_interval from SSID config; RADIUS effect unknown',
      'DOCUMENTED',
      [doc('POLICY_ENGINE.md §3.1 row interim_interval')],
    ),
    disconnectCoa: fact('hostapd DAS: REQUIRES_DEVICE_TEST (D-006, → DT-07/DT-08)', 'DOCUMENTED', [
      doc('PHASE2_VALIDATION.md V-008, V-009'),
    ]),
    bandwidthAttributes: fact('no verified per-client RADIUS bandwidth attribute', 'DOCUMENTED', [
      doc('PHASE2_VALIDATION.md V-004'),
    ]),
    quotaEnforcement: fact('none (no octet attribute)', 'DOCUMENTED', [
      doc('POLICY_ENGINE.md §3.1 row quota'),
    ]),
    sessionTimeout: fact('RADIUS Session-Timeout / Idle-Timeout honouring → DT-05', 'DOCUMENTED', [
      doc('PHASE2_VALIDATION.md V-005'),
    ]),
  },
  capabilities: deriveCells(getAdapter('openwifi-hostapd-radius').capabilities(), {
    rowKey: HOSTAPD_ROW_ID,
    sourceVersionMatchesDevice: null,
    deviceFirmware: AP1832_FIRMWARE,
    dtResults: DT_RESULTS,
  }),
  configurationKind: 'ucentral',
  openItems: AP1832_OPEN_ITEMS,
};

const CONFIG_ROW_ID = 'ezelink-eze-ap1832-r32912-ucentral-config';
const NOT_APPLICABLE = (ref: string): RegistryFact =>
  fact('not applicable (config-only adapter, no RADIUS path)', 'DOCUMENTED', [doc(ref)]);

const configRow: CompatibilityRow = {
  key: CONFIG_ROW_ID,
  vendorKey: 'ezelink',
  hardwareModel: AP1832_MODEL,
  firmware: AP1832_FIRMWARE,
  controller: AP1832_CONTROLLER,
  lifecycle: 'implemented',
  deploymentModes: ['native'],
  enforcementPoint: 'ap',
  adapterKey: 'openwifi-config',
  sourceVersionMatchesDevice: null,
  identity: AP1832_IDENTITY,
  profile: {
    ...AP1832_COMMON_PROFILE,
    redirectProtocol: NOT_APPLICABLE('POLICY_ENGINE.md §4.3 (e)'),
    authorizationMethod: NOT_APPLICABLE('POLICY_ENGINE.md §4.3 (e)'),
    radiusAuth: NOT_APPLICABLE('POLICY_ENGINE.md §4.3 (e)'),
    radiusAccounting: NOT_APPLICABLE('POLICY_ENGINE.md §4.3 (e)'),
    accountingInterval: NOT_APPLICABLE('POLICY_ENGINE.md §4.3 (e)'),
    disconnectCoa: fact(
      'no RFC 5176 path; config re-push resets portal sessions (→ DT-02)',
      'DOCUMENTED',
      [doc('NETWORK_INTEGRATION.md §5')],
    ),
    bandwidthAttributes: fact(
      'per-SSID `rate-limit` (integer Mbit/s, per-station ceiling) via `ucentral` push (→ DT-02)',
      'VERIFIED_FROM_SOURCE',
      [SRC.V001],
    ),
    quotaEnforcement: fact('none', 'DOCUMENTED', [
      doc('POLICY_ENGINE.md §3.1 row quota (openwifi-config)'),
    ]),
    sessionTimeout: fact(
      'per-SSID `captive.session-timeout` / `max-inactivity` defaults',
      'VERIFIED_FROM_SOURCE',
      [SRC.CAPTIVE_RENDERER_SESSION_TIMEOUT, SRC.V006],
    ),
  },
  capabilities: deriveCells(getAdapter('openwifi-config').capabilities(), {
    rowKey: CONFIG_ROW_ID,
    sourceVersionMatchesDevice: null,
    deviceFirmware: AP1832_FIRMWARE,
    dtResults: DT_RESULTS,
  }),
  configurationKind: 'ucentral',
  openItems: [
    ...AP1832_OPEN_ITEMS,
    {
      id: 'DT-02',
      label: 'REQUIRES_DEVICE_TEST',
      text: 'Per-SSID rate-limit on EZEAP firmware; renderer source version vs on-device ucentral-schema 2026.07.25~818569f4 not compared (sourceVersionMatchesDevice left null).',
    },
  ],
};

// ------------------------------------------------------------------------------------------
// Generic upstream uspot row (no device in inventory)
// ------------------------------------------------------------------------------------------

const UPSTREAM_ROW_ID = 'openwrt-uspot-upstream';

const upstreamRow: CompatibilityRow = {
  key: UPSTREAM_ROW_ID,
  vendorKey: 'openwrt',
  hardwareModel: 'UNKNOWN',
  firmware: 'UNKNOWN',
  controller: null,
  lifecycle: 'implemented',
  deploymentModes: ['native'],
  enforcementPoint: 'ap',
  adapterKey: 'uspot-upstream-uam',
  sourceVersionMatchesDevice: null,
  identity: [
    fact(
      'f00b4r0 uspot e0c19eb / openwrt-packages 87080bf (source analysed; no device ships it in our inventory)',
      'VERIFIED_FROM_SOURCE',
      [source('V-040 · wlan-ap uspot Makefile, src/; f00b4r0 README', APPLIES_UPSTREAM_USPOT)],
      'sourceCodeBase',
    ),
  ],
  profile: {
    ...allUnknownProfile(),
    redirectProtocol: fact(
      'ChilliSpot UAM (+ timeleft, ssl, reply, lang; url-encoded userurl)',
      'VERIFIED_FROM_SOURCE',
      [source('V-042 · U portal.uc uam_url()', APPLIES_UPSTREAM_USPOT)],
    ),
    bandwidthAttributes: fact('WISPr bit/s or ChilliSpot kbit/s', 'VERIFIED_FROM_SOURCE', [
      SRC.V053_U,
    ]),
    quotaEnforcement: fact(
      'ChilliSpot-Max-{Input,Output,Total}-Octets + Gigawords',
      'VERIFIED_FROM_SOURCE',
      [SRC.V054_U],
    ),
    sessionTimeout: fact('Session-Timeout, Idle-Timeout', 'VERIFIED_FROM_SOURCE', [SRC.V050_U]),
    disconnectCoa: fact(
      'own DAS (radius-das.c) on das_port 3799, not reachable via uCentral — REQUIRES_DEVICE_TEST',
      'VERIFIED_FROM_SOURCE',
      [source('V-060 · f00b4r0 src/radius-das.c, README l.47-49', APPLIES_UPSTREAM_USPOT)],
    ),
  },
  capabilities: deriveCells(getAdapter('uspot-upstream-uam').capabilities(), {
    rowKey: UPSTREAM_ROW_ID,
    sourceVersionMatchesDevice: null,
    deviceFirmware: 'UNKNOWN',
    dtResults: DT_RESULTS,
  }),
  configurationKind: 'UNKNOWN',
  openItems: [{ id: 'OQ-9', label: 'REQUIRES_DEVICE_TEST', text: 'IPv6 behaviour unknown.' }],
};

// ------------------------------------------------------------------------------------------
// Row 2 — coova-chilli 1.2.9 on the EZE gateway (V11 override) + generic master row
// ------------------------------------------------------------------------------------------

const COOVA_REDIRECT = source(
  'V-070 · coova-chilli src/redir.c L413-600, L639',
  APPLIES_COOVA_MASTER,
);
const COOVA_LOGIN = source(
  'V-071 · redir.c L2238-2255, L2382-2480, L788-960; doc/hotspotlogin.cgi; www/ChilliLibrary.js',
  APPLIES_COOVA_MASTER,
);
const COOVA_WALLED = source('V-075 · doc/chilli.conf.5.in; cmdline.ggo', APPLIES_COOVA_MASTER);

function coovaProfile(accessRequest: RegistryFact): CompatibilityProfile {
  return {
    ...allUnknownProfile(),
    redirectProtocol: fact(
      'UAM params incl. `md` (uppercase hex MD5(url+uamsecret), appended last)',
      'VERIFIED_FROM_SOURCE',
      [COOVA_REDIRECT],
    ),
    authorizationMethod: fact('`/logon` PAP / CHAP / MSCHAPv2, `/json/*`', 'VERIFIED_FROM_SOURCE', [
      COOVA_LOGIN,
    ]),
    radiusAuth: accessRequest,
    accountingInterval: fact('Acct-Interim-Interval (< 60 ignored)', 'VERIFIED_FROM_SOURCE', [
      SRC.V073,
    ]),
    bandwidthAttributes: fact(
      'WISPr bit/s + CoovaChilli kbit/s rate attributes',
      'VERIFIED_FROM_SOURCE',
      [SRC.V073],
    ),
    quotaEnforcement: fact(
      'CoovaChilli-Max-Input/Output/Total-Octets + Gigawords',
      'VERIFIED_FROM_SOURCE',
      [SRC.V073],
    ),
    sessionTimeout: fact(
      'Session-Timeout, Idle-Timeout, WISPr-Session-Terminate-Time',
      'VERIFIED_FROM_SOURCE',
      [SRC.V073],
    ),
    disconnectCoa: fact(
      '`coaport` default 0 (disabled); `User-Name` mandatory — REQUIRES_DEVICE_TEST (D-006)',
      'VERIFIED_FROM_SOURCE',
      [SRC.V074],
    ),
    transport: fact('gateway as WireGuard peer (topology A)', 'DOCUMENTED', [
      doc('DECISIONS.md D-010'),
    ]),
  };
}

const WALLED_GARDEN: RegistryCell = cell(
  'walledGarden',
  'REQUIRES_DEVICE_TEST',
  'VERIFIED_FROM_SOURCE',
  [COOVA_WALLED],
  '`uamallowed`, `uamdomain`, `uamregex` (master source); behaviour on the device not tested',
);

const EZEGATE_ROW_ID = 'coova-chilli-1.2.9-ezegate';
const EZEGATE_FIRMWARE = 'coova-chilli 1.2.9';

const ezegateRow: CompatibilityRow = {
  key: EZEGATE_ROW_ID,
  vendorKey: 'coova',
  hardwareModel: 'UNKNOWN',
  firmware: EZEGATE_FIRMWARE,
  controller: null,
  lifecycle: 'implemented',
  deploymentModes: ['gateway'],
  enforcementPoint: 'gateway',
  adapterKey: 'coovachilli-uam',
  sourceVersionMatchesDevice: false,
  identity: [
    fact(
      'coova-chilli 1.2.9 (`coova-chilli-1.2.9-1.x86_64.rpm`), local FreeRADIUS precedent, multi-instance per VLAN',
      'VERIFIED_FROM_SOURCE',
      [
        source(
          'V-077 · EZEGATE Ezeinstall/post-install-script.sh L224-269, L573-575, L783; Ezeinstall/sudoers L11',
          'EZEGATE install scripts (coova-chilli 1.2.9)',
        ),
        doc('DECISIONS.md D-002'),
      ],
      'software',
    ),
    unknown(
      [doc('PHASE2_VALIDATION.md V-111; MULTI_VENDOR_INTEGRATION_PLAN.md OQ-7')],
      'gatewayHardware',
    ),
  ],
  profile: coovaProfile(
    unknown([doc('PHASE2_VALIDATION.md V-072 (master verified; 1.2.9 unknown → DT-15)')]),
  ),
  capabilities: deriveCells(getAdapter('coovachilli-uam').capabilities(), {
    rowKey: EZEGATE_ROW_ID,
    sourceVersionMatchesDevice: false,
    deviceFirmware: EZEGATE_FIRMWARE,
    dtResults: DT_RESULTS,
    extraCells: { captivePortal: [WALLED_GARDEN] },
  }),
  configurationKind: 'coova-chilli-conf',
  openItems: [
    {
      id: 'OQ-7',
      label: 'REQUIRES_CLARIFICATION',
      text: 'EZE gateway hardware model (V-111) and whether 1.2.9 may be upgraded (Q41).',
    },
    {
      id: 'DT-15',
      label: 'REQUIRES_DEVICE_TEST',
      text: 'CoovaChilli gateway day: Access-Request content and reply-attribute honouring on 1.2.9 (source analysed is upstream master).',
    },
    { id: 'OQ-9', label: 'REQUIRES_DEVICE_TEST', text: 'IPv6 behaviour unknown.' },
  ],
};

const COOVA_MASTER_ROW_ID = 'coova-chilli-master';

const coovaMasterRow: CompatibilityRow = {
  key: COOVA_MASTER_ROW_ID,
  vendorKey: 'coova',
  hardwareModel: 'UNKNOWN',
  firmware: 'coova-chilli master',
  controller: null,
  lifecycle: 'implemented',
  deploymentModes: ['gateway'],
  enforcementPoint: 'gateway',
  adapterKey: 'coovachilli-uam',
  sourceVersionMatchesDevice: null,
  identity: [
    fact(
      'coova-chilli upstream master (source analysed; no device)',
      'VERIFIED_FROM_SOURCE',
      [COOVA_REDIRECT],
      'sourceCodeBase',
    ),
  ],
  profile: coovaProfile(
    fact(
      'Message-Authenticator, NAS-Identifier, Called-Station-Id, Acct-Session-Id, WISPr-Location-*, CoovaChilli-Version/Lang/OriginalURL',
      'VERIFIED_FROM_SOURCE',
      [
        source(
          'V-072 · src/chilli.c config_radius_session L3947-4075; doc/attributes',
          APPLIES_COOVA_MASTER,
        ),
      ],
    ),
  ),
  capabilities: deriveCells(getAdapter('coovachilli-uam').capabilities(), {
    rowKey: COOVA_MASTER_ROW_ID,
    sourceVersionMatchesDevice: null,
    deviceFirmware: 'coova-chilli master',
    dtResults: DT_RESULTS,
    extraCells: { captivePortal: [WALLED_GARDEN] },
  }),
  configurationKind: 'coova-chilli-conf',
  openItems: [{ id: 'OQ-9', label: 'REQUIRES_DEVICE_TEST', text: 'IPv6 behaviour unknown.' }],
};

// ------------------------------------------------------------------------------------------
// Row 3 — Cambium (researched only, no adapter; plan §7.3)
// ------------------------------------------------------------------------------------------

const CAMBIUM_ROW_ID = 'cambium-cnpilot-e-external-hotspot';

const cambiumRow: CompatibilityRow = {
  key: CAMBIUM_ROW_ID,
  vendorKey: 'cambium',
  hardwareModel: 'UNKNOWN',
  firmware: 'UNKNOWN',
  controller: null,
  lifecycle: 'researched',
  deploymentModes: ['native'],
  enforcementPoint: 'ap',
  adapterKey: null,
  sourceVersionMatchesDevice: null,
  identity: [
    fact(
      'documented for cnPilot E400, E500, ePMP1000 (2016 document); installed model/firmware UNKNOWN (OQ-3)',
      'DOCUMENTED',
      [C.C1],
      'documentedModels',
    ),
    fact(
      'AP firmware 3.11.3-r7 and newer, tested up to 4.2.3.1-r7 (third-party report; not evidence for ECLOUD)',
      'DOCUMENTED',
      [C.S1],
      'thirdPartyFirmwareRange',
    ),
  ],
  profile: {
    licensing: fact(
      'EasyPass Third-Party Integration APIs in Essentials and X; all other APIs require cnMaestro X',
      'DOCUMENTED',
      [C.C3],
    ),
    redirectProtocol: fact(
      '`ga_ap_mac`, `ga_nas_id`, `ga_srvr`, `ga_cmac`, `ga_orig_url`, `ga_Qv` (returned unchanged), `c_timeout`, `ga_error_code`; newer example adds `ga_ssid`, `ga_rssi`; no signature parameter documented',
      'DOCUMENTED',
      [C.C1, C.C2],
    ),
    authorizationMethod: fact(
      'browser POST (application/x-www-form-urlencoded) to AP `/cgi-bin/hotspot_login.cgi` port 880 (HTTPS 444) with `ga_user`, `ga_pass`; form variant REQUIRES_DEVICE_TEST (OQ-10, OQ-12)',
      'DOCUMENTED',
      [C.C1, C.C2],
    ),
    radiusAuth: fact(
      'Framed-IP-Address, NAS-IP-Address, Called-Station-Id (MAC:SSID), NAS-Identifier, NAS-Port-Id (SSID), NAS-Port-Type 802.11, Calling-Station-Id',
      'DOCUMENTED',
      [C.C1],
    ),
    radiusAccounting: fact(
      'Start-Interim-Stop mode and interim interval exist as cnMaestro AAA settings (attributes, Gigawords UNKNOWN)',
      'DOCUMENTED',
      [C.S1],
    ),
    accountingInterval: fact(
      'Acct-Interim-Interval ("ACCT_INTERIM_INTVL") understood in Access-Accept',
      'DOCUMENTED',
      [C.C1],
    ),
    disconnectCoa: unknown(),
    bandwidthAttributes: fact(
      '`WIFI_ALLIANCE_MAX_UP` / `WIFI_ALLIANCE_MAX_DOWN`; dictionary name, vendor id and units UNKNOWN (OQ-11)',
      'DOCUMENTED',
      [C.C1],
    ),
    quotaEnforcement: unknown(),
    sessionTimeout: fact(
      'Session-Timeout, Idle-Timeout understood in Access-Accept',
      'DOCUMENTED',
      [C.C1],
    ),
    ipv6Behaviour: unknown(),
    roamingContinuity: unknown(),
    cloudDependencies: fact(
      'cnMaestro Cloud may not support Enterprise devices after end of October 2026; on-prem 6.0 lacks some EasyPass features — ECLOUD must not depend on cnMaestro Cloud',
      'DOCUMENTED',
      [C.C4],
    ),
    transport: unknown(),
  },
  capabilities: groups({
    captivePortal: [
      cell(
        'redirectParameters',
        'UNKNOWN',
        'DOCUMENTED',
        [C.C1, C.C2],
        'documented set; current firmware UNKNOWN (OQ-12)',
      ),
      cell(
        'loginHandshake',
        'REQUIRES_DEVICE_TEST',
        'DOCUMENTED',
        [C.C1, C.C2],
        'browser-form candidate: POST to hotspot_login.cgi (OQ-10, OQ-12)',
      ),
      cell(
        'logout',
        'UNKNOWN',
        'DOCUMENTED',
        [C.C1],
        'hotspot_logout.cgi sample; current firmware UNKNOWN',
      ),
      cell('session_timeout_s', 'REQUIRES_DEVICE_TEST', 'DOCUMENTED', [C.C1]),
      cell('idle_timeout_s', 'REQUIRES_DEVICE_TEST', 'DOCUMENTED', [C.C1]),
      cell(
        'cnMaestroEasyPass',
        'UNKNOWN',
        'DOCUMENTED',
        [C.C3, C.C4],
        'endpoint paths, schemas, auth: UNKNOWN (OQ-4)',
      ),
    ],
    accounting: [
      cell('interimInterval', 'REQUIRES_DEVICE_TEST', 'DOCUMENTED', [C.C1]),
      cell(
        'accountingAttributes',
        'UNKNOWN',
        'DOCUMENTED',
        [C.S1],
        'third-party UI reference only',
      ),
      cell(
        'quota',
        'UNKNOWN',
        null,
        [],
        'no quota attribute documented (unknown, not unsupported)',
      ),
    ],
    bandwidth: [
      cell(
        'rateLimit',
        'REQUIRES_DEVICE_TEST',
        'DOCUMENTED',
        [C.C1],
        'WIFI_ALLIANCE_MAX_UP/DOWN: vendor id, number, units UNKNOWN (OQ-11)',
      ),
    ],
    disconnect: [
      cell('disconnect', 'UNKNOWN', null, [], 'none documented; D-006 applies'),
      cell('coaChange', 'UNKNOWN', null, [], 'none documented; D-006 applies'),
    ],
    monitoring: [cell('monitoring:*', 'UNKNOWN', null, [])],
    configuration: [
      cell(
        'configuration:*',
        'UNKNOWN',
        null,
        [],
        'no uCentral; never targeted by openwifi-config',
      ),
    ],
  }),
  configurationKind: 'vendor-ui',
  openItems: [
    {
      id: 'OQ-3',
      label: 'REQUIRES_CLARIFICATION',
      text: 'Installed Cambium model(s), AP firmware, cnMaestro deployment and licence tier.',
    },
    {
      id: 'OQ-4',
      label: 'REQUIRES_CLARIFICATION',
      text: 'Is the cnMaestro EasyPass Third-Party Integration wanted at all (C4)? API documentation from Cambium.',
    },
    {
      id: 'OQ-8',
      label: 'REQUIRES_CLARIFICATION',
      text: 'Accept `ga_srvr` public-IP mode? Default: reject non-private `ga_srvr`.',
    },
    {
      id: 'OQ-10',
      label: 'REQUIRES_DEVICE_TEST',
      text: 'HTTPS portal → http://AP:880 POST (mixed content, private-network access); HTTPS 444 certificate on captive browsers.',
    },
    {
      id: 'OQ-11',
      label: 'REQUIRES_DEVICE_TEST',
      text: '`WIFI_ALLIANCE_MAX_UP/DOWN` exact attribute, units, direction.',
    },
    {
      id: 'OQ-12',
      label: 'REQUIRES_DEVICE_TEST',
      text: 'Current firmware redirect parameters, login POST form, `ga_Qv` lifetime, `ga_user`/`ga_pass` limits, logout, accounting, Disconnect/CoA.',
    },
    {
      id: 'OQ-13',
      label: 'REQUIRES_DEVICE_TEST',
      text: 'RadSec support / reachability of ECLOUD RADIUS through a site WireGuard gateway.',
    },
  ],
};

// ------------------------------------------------------------------------------------------
// Generic 802.1X / MAC-auth row (Cycle A, D-044) — any vendor, no device claim
// ------------------------------------------------------------------------------------------

const GENERIC_8021X_ROW_ID = 'generic-radius-8021x';
const F9_DOC = doc('docs/VENDOR_INTEGRATION_RESEARCH.md §2 F9, §3.1');

const generic8021xRow: CompatibilityRow = {
  key: GENERIC_8021X_ROW_ID,
  vendorKey: 'generic-radius',
  hardwareModel: 'UNKNOWN',
  firmware: 'UNKNOWN',
  controller: null,
  lifecycle: 'implemented',
  deploymentModes: ['native'],
  enforcementPoint: 'UNKNOWN',
  adapterKey: 'generic-radius-8021x',
  sourceVersionMatchesDevice: null,
  identity: [],
  profile: {
    ...allUnknownProfile(),
    redirectProtocol: fact('none (802.1X / MAC-auth SSID, no portal)', 'DOCUMENTED', [F9_DOC]),
    authorizationMethod: fact(
      '802.1X EAP terminated by ECLOUD FreeRADIUS (EAP-TTLS/PAP; opt-in, certificate REQUIRES_CLARIFICATION) or MAC authentication (User-Name = client MAC)',
      'DOCUMENTED',
      [F9_DOC, doc('AAA_ARCHITECTURE.md §2.4'), doc('infra/freeradius/README.md (EAP)')],
    ),
    radiusAuth: fact(
      'standard Access-Request; NAS identified by packet source (D-032/D-042)',
      'DOCUMENTED',
      [F9_DOC],
    ),
    radiusAccounting: fact('standard Start / Interim-Update / Stop (RFC 2866)', 'DOCUMENTED', [
      F9_DOC,
    ]),
    disconnectCoa: fact('RFC 5176 per vendor: REQUIRES_DEVICE_TEST (D-006)', 'DOCUMENTED', [
      F9_DOC,
    ]),
    bandwidthAttributes: fact(
      'WISPr-Bandwidth-Max-Down/Up declared REQUIRES_DEVICE_TEST; per-vendor rate attributes UNKNOWN',
      'DOCUMENTED',
      [F9_DOC],
    ),
    sessionTimeout: fact(
      'Session-Timeout, Idle-Timeout (RFC 2865): REQUIRES_DEVICE_TEST',
      'DOCUMENTED',
      [F9_DOC],
    ),
  },
  capabilities: deriveCells(getAdapter('generic-radius-8021x').capabilities(), {
    rowKey: GENERIC_8021X_ROW_ID,
    sourceVersionMatchesDevice: null,
    deviceFirmware: 'UNKNOWN',
    dtResults: DT_RESULTS,
  }),
  configurationKind: 'vendor-ui',
  openItems: [
    {
      id: 'CA-1',
      label: 'REQUIRES_CLARIFICATION',
      text: 'Production EAP server certificate and CA (issuer, distribution to clients); dev uses a throw-away self-signed certificate that is never committed.',
    },
    {
      id: 'CA-2',
      label: 'REQUIRES_DEVICE_TEST',
      text: 'Per vendor: Called-Station-Id format, MAC-auth User-Name / password format, Session-Timeout / Idle-Timeout / VLAN / WISPr rate honouring, Disconnect support and port.',
    },
  ],
};

// ------------------------------------------------------------------------------------------
// Cisco Meraki MR splash sign-on row (Cycle E, D-044) — cloud-sourced RADIUS, no device test
// ------------------------------------------------------------------------------------------

const MERAKI_ROW_ID = 'cisco-meraki-mr-splash-signon';
const F4_DOC = doc('docs/VENDOR_INTEGRATION_RESEARCH.md §2 F4, §3.5');
const SEC36_DOC = doc('SECURITY_ARCHITECTURE.md §3.5');

const merakiSplashRow: CompatibilityRow = {
  key: MERAKI_ROW_ID,
  vendorKey: 'cisco-meraki',
  hardwareModel: 'UNKNOWN',
  firmware: 'UNKNOWN',
  controller: null,
  lifecycle: 'implemented',
  deploymentModes: ['native'],
  enforcementPoint: 'UNKNOWN',
  adapterKey: 'meraki-splash',
  sourceVersionMatchesDevice: null,
  identity: [],
  profile: {
    ...allUnknownProfile(),
    redirectProtocol: fact(
      'Meraki custom-hosted splash: GET to the ECLOUD portal with login_url, continue_url, ap_mac, ap_name, ap_tags, client_ip, client_mac (sign-on) or base_grant_url, user_continue_url, node_mac, client_mac (click-through)',
      'DOCUMENTED',
      [F4_DOC],
    ),
    authorizationMethod: fact(
      'browser POST username / password / success_url to the Meraki-hosted login_url (https://n<digits>.network-auth.com only); click-through: GET base_grant_url',
      'DOCUMENTED',
      [F4_DOC],
    ),
    radiusAuth: fact(
      'PAP Access-Request from the Meraki Cloud (shared public ranges): per-NAS listener + per-NAS secret, NAS-Identifier must match (MERAKI_CLOUD_RADIUS_ENABLED, default OFF)',
      'DOCUMENTED',
      [F4_DOC, SEC36_DOC],
    ),
    radiusAccounting: fact(
      'Start / Stop from the Meraki Cloud (splash accounting may need Meraki support); attributed by the per-NAS listener client shortname',
      'DOCUMENTED',
      [F4_DOC],
    ),
    disconnectCoa: fact(
      'Disconnect only (RFC 5176) to the dashboard host n<digits>.meraki.com:3799 with Acct-Session-Id + Event-Timestamp; CoA changes unsupported by Meraki: REQUIRES_DEVICE_TEST',
      'DOCUMENTED',
      [F4_DOC],
    ),
    bandwidthAttributes: fact(
      'none pushable: Meraki applies rates only via Filter-Id → Dashboard group policy',
      'DOCUMENTED',
      [F4_DOC],
    ),
    sessionTimeout: fact(
      'Session-Timeout (overrides splash frequency), Idle-Timeout: REQUIRES_DEVICE_TEST',
      'DOCUMENTED',
      [F4_DOC],
    ),
  },
  capabilities: deriveCells(getAdapter('meraki-splash').capabilities(), {
    rowKey: MERAKI_ROW_ID,
    sourceVersionMatchesDevice: null,
    deviceFirmware: 'UNKNOWN',
    dtResults: DT_RESULTS,
  }),
  configurationKind: 'vendor-ui',
  openItems: [
    {
      id: 'CE-1',
      label: 'REQUIRES_CLARIFICATION',
      text: 'Public RADIUS exposure for the Meraki Cloud (conflicts with the LAN-only pilot, D-043): public address, listener port range, Meraki source ranges (Dashboard Help > Firewall info).',
    },
    {
      id: 'CE-2',
      label: 'REQUIRES_DEVICE_TEST',
      text: 'NAS-Identifier content on splash Access-Requests, Message-Authenticator, Class echo, Session-Timeout / Idle-Timeout honouring, Disconnect from the RADIUS public address.',
    },
  ],
};

// ------------------------------------------------------------------------------------------
// Roadmap rows — planned, everything UNKNOWN (plan §7.4)
// ------------------------------------------------------------------------------------------

const roadmapRows: CompatibilityRow[] = ROADMAP_VENDORS.map((v) => ({
  key: `${v.key}-planned`,
  vendorKey: v.key,
  hardwareModel: 'UNKNOWN',
  firmware: 'UNKNOWN',
  controller: null,
  lifecycle: 'planned',
  deploymentModes: [],
  enforcementPoint: 'UNKNOWN',
  adapterKey: null,
  sourceVersionMatchesDevice: null,
  identity: [],
  profile: allUnknownProfile(),
  capabilities: unknownCells(),
  configurationKind: 'UNKNOWN',
  openItems: [],
}));

export const COMPATIBILITY_ROWS: readonly CompatibilityRow[] = Object.freeze([
  tipUspotRow,
  hostapdRow,
  configRow,
  upstreamRow,
  ezegateRow,
  coovaMasterRow,
  cambiumRow,
  generic8021xRow,
  merakiSplashRow,
  ...roadmapRows,
]);

export function getCompatibilityRow(key: string): CompatibilityRow | undefined {
  return COMPATIBILITY_ROWS.find((r) => r.key === key);
}
