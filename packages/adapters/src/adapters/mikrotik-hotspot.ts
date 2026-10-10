/**
 * `mikrotik-hotspot` (Cycle B, D-044; docs/VENDOR_INTEGRATION_RESEARCH.md §2 F2, §3.3): MikroTik
 * RouterOS HotSpot with an ECLOUD-generated `login.html` that sends the client to the ECLOUD
 * portal, which completes the login by POSTing back to the router's `$(link-login-only)`
 * (HTTP-CHAP when the router issued a `chap-id`, else PAP). The router is the RADIUS client
 * (`/radius` service=hotspot) and enforces the reply attributes itself, in front of any AP brand
 * (gateway) or on its own radios (native).
 *
 * Vendor documentation read 2026-10-10 (RouterOS 7.26 pages):
 *  - RADIUS: https://help.mikrotik.com/docs/spaces/ROS/pages/328097/RADIUS — Access-Accept
 *    attributes (Mikrotik-Rate-Limit, Session-Timeout, Idle-Timeout, Acct-Interim-Interval
 *    "HotSpot - only respected if radius-interim-update=received", Class "included in
 *    Accounting-Request unchanged"), `/radius incoming` (`accept` default no, `port` default
 *    1700, Disconnect-Messages, "RouterOS doesn't support POD"), the CoA-changeable attribute
 *    list, the MikroTik numeric attribute table (MIKROTIK_TOTAL_LIMIT 17,
 *    MIKROTIK_TOTAL_LIMIT_GIGAWORDS 18), Access-Request facts (NAS-Identifier = router identity,
 *    Calling-Station-Id = client MAC in capitals, Called-Station-Id = HotSpot server name).
 *  - Hotspot customisation: https://help.mikrotik.com/docs/spaces/ROS/pages/87162881/Hotspot+customisation
 *
 * Nothing is VERIFIED (no lab test, D-028 / plan V1, V12): every device-side cell is
 * DOCUMENTED / REQUIRES_DEVICE_TEST, burst is UNSUPPORTED (engine has none), VLAN UNKNOWN →
 * UNSUPPORTED (no documented HotSpot VLAN reply attribute), validity / voucher / schedule /
 * concurrency ECLOUD_SIDE_ONLY.
 */
import {
  MIKROTIK_RADIUS_DOCS,
  MIKROTIK_RATE_ATTRIBUTE,
  MIKROTIK_RATE_FAMILY,
  MIKROTIK_RATE_FIELD_DECLARATIONS,
  type AdapterCapabilities,
} from '@ecloud/policy-engine';
import type { EvidenceRef } from '@ecloud/shared';
import { attr, attributeTable, createAdapter, decl, fieldTable, sourced } from '../base.js';
import { EV } from '../evidence.js';
import type { NasAdapter } from '../types.js';

/** RouterOS `/radius incoming` default port (vendor doc), not RFC 5176's 3799. */
export const MIKROTIK_DEFAULT_COA_PORT = 1700;

export const MIKROTIK_TOTAL_LIMIT_ATTRIBUTE = 'Mikrotik-Total-Limit';
export const MIKROTIK_TOTAL_LIMIT_GIGAWORDS_ATTRIBUTE = 'Mikrotik-Total-Limit-Gigawords';

export const MIKROTIK_RADIUS_DOC: EvidenceRef = {
  kind: 'url',
  ref: 'MikroTik RouterOS 7.26 manual: RADIUS (Access-Accept attributes, /radius incoming, Change of Authorization, numeric attribute table)',
  url: 'https://help.mikrotik.com/docs/spaces/ROS/pages/328097/RADIUS',
};
export const MIKROTIK_HOTSPOT_CUSTOMISATION_DOC: EvidenceRef = {
  kind: 'url',
  ref: 'MikroTik RouterOS 7.26 manual: Hotspot customisation (login.html variables, HTTP-CHAP, external authentication)',
  url: 'https://help.mikrotik.com/docs/spaces/ROS/pages/87162881/Hotspot+customisation',
};
export const MIKROTIK_HOTSPOT_DOC: EvidenceRef = {
  kind: 'url',
  ref: 'MikroTik RouterOS 7.26 manual: HotSpot - Captive portal (/ip hotspot profile use-radius, login-by, radius-interim-update; walled-garden)',
  url: 'https://help.mikrotik.com/docs/spaces/ROS/pages/56459266/HotSpot+-+Captive+portal',
};
const F2: EvidenceRef = {
  kind: 'doc-section',
  ref: 'docs/VENDOR_INTEGRATION_RESEARCH.md §2 F2, §3.3 (mikrotik-hotspot)',
};
const RAD = [MIKROTIK_RADIUS_DOC, F2];

const R33 = 'docs/VENDOR_INTEGRATION_RESEARCH.md §3.3';
const RDT = `documented by the vendor; not lab-tested (D-028; ${R33})`;

const TIMEOUT_RDT = sourced(
  `Session-Timeout "Overrides session-timeout in the default configuration" (MikroTik RADIUS manual): ${RDT}`,
  RAD,
);
const IDLE_RDT = sourced(
  `Idle-Timeout "Overrides idle-timeout in the default configuration" (MikroTik RADIUS manual): ${RDT}`,
  RAD,
);
const INTERIM_RDT = sourced(
  `Acct-Interim-Interval: "HotSpot - only respected if radius-interim-update=received in HotSpot server profile" (MikroTik RADIUS manual): ${RDT}`,
  [...RAD, MIKROTIK_HOTSPOT_DOC],
);
const CLASS_RDT = sourced(
  `Class: "Cookie. Will be included in Accounting-Request unchanged" (MikroTik RADIUS manual): ${RDT}`,
  RAD,
);
const QUOTA_RDT = sourced(
  'Mikrotik-Total-Limit (14988/17) + Mikrotik-Total-Limit-Gigawords (14988/18) are listed in the vendor numeric attribute table; the page describes only Recv/Xmit-Limit semantics, so a session-scoped total byte cap is REQUIRES_DEVICE_TEST; daily/monthly accounting stays ECLOUD-side (watcher + drain time; docs/VENDOR_INTEGRATION_RESEARCH.md §3.3)',
  RAD,
);
const VLAN_UNSUPPORTED = sourced(
  'no HotSpot VLAN reply attribute is documented (Mikrotik-Wireless-VLANID is "Wireless only"); VLAN is UNKNOWN for hotspot users (docs/VENDOR_INTEGRATION_RESEARCH.md §3.3)',
  RAD,
);
const DISCONNECT_RDT = sourced(
  `/radius incoming: Disconnect-Messages terminate the session; accept default no, port default ${String(MIKROTIK_DEFAULT_COA_PORT)}; "RouterOS doesn't support POD". Identification attributes and Acct-Stop behaviour are not documented: REQUIRES_DEVICE_TEST (D-006; ${R33})`,
  RAD,
);
const COA_RDT = sourced(
  'Change of Authorization (RFC 3576): the vendor lists Mikrotik-Rate-Limit, Session-Timeout and Idle-Timeout (among others) as CoA-changeable; no lab test (D-006, D-028; docs/VENDOR_INTEGRATION_RESEARCH.md §3.3)',
  RAD,
);
const MAC_AUTH_UNSUPPORTED = sourced(
  'HotSpot `login-by=mac` is not wired to ECLOUD MAC authentication in Cycle B (User-Name / password format of MAC login REQUIRES_CLARIFICATION; docs/VENDOR_INTEGRATION_RESEARCH.md §3.3)',
  [MIKROTIK_HOTSPOT_DOC, F2],
);

export const capabilities: AdapterCapabilities = {
  key: 'mikrotik-hotspot',
  version: '0.1.0',
  portalType: 'mikrotik-hotspot',
  granularity: 'per-client',
  rateUnit: 'mikrotik-rate-string',
  rateFamilies: [MIKROTIK_RATE_FAMILY],
  quotaAttributes: {
    total: MIKROTIK_TOTAL_LIMIT_ATTRIBUTE,
    totalGigawords: MIKROTIK_TOTAL_LIMIT_GIGAWORDS_ATTRIBUTE,
  },
  octetWidth: 64,
  sessionTimeoutAttr: 'Session-Timeout',
  idleTimeoutAttr: 'Idle-Timeout',
  interimIntervalAttr: 'Acct-Interim-Interval',
  vlanAttrs: [],
  classAttr: 'Class',
  disconnect: {
    status: 'REQUIRES_DEVICE_TEST',
    target: 'rfc5176-das',
    identifyBy: ['User-Name', 'Acct-Session-Id', 'Calling-Station-Id', 'Framed-IP-Address'],
    acctStopEmitted: 'unknown',
    evidence: DISCONNECT_RDT.text,
    evidenceRefs: DISCONNECT_RDT.refs,
    evidenceLevel: 'DOCUMENTED',
    defaultPort: MIKROTIK_DEFAULT_COA_PORT,
    note: `DAS port = nas_clients.coa_port, else the RouterOS default ${String(MIKROTIK_DEFAULT_COA_PORT)}; the setup guide enables /radius incoming accept=yes`,
  },
  coaChange: {
    status: 'REQUIRES_DEVICE_TEST',
    changeable: ['Mikrotik-Rate-Limit', 'Session-Timeout', 'Idle-Timeout'],
    evidence: COA_RDT.text,
    evidenceRefs: COA_RDT.refs,
    evidenceLevel: 'DOCUMENTED',
  },
  macAuth: {
    status: 'UNSUPPORTED',
    evidence: MAC_AUTH_UNSUPPORTED.text,
    evidenceRefs: MAC_AUTH_UNSUPPORTED.refs,
    evidenceLevel: 'DOCUMENTED',
  },
  fields: fieldTable([
    ...MIKROTIK_RATE_FIELD_DECLARATIONS.map((d) => ({ ...d, evidence: `${d.evidence} (${R33})` })),
    decl('quota_daily_bytes', 'REQUIRES_DEVICE_TEST', 'DOCUMENTED', QUOTA_RDT),
    decl('quota_monthly_bytes', 'REQUIRES_DEVICE_TEST', 'DOCUMENTED', QUOTA_RDT),
    decl('quota_total_bytes', 'REQUIRES_DEVICE_TEST', 'DOCUMENTED', QUOTA_RDT),
    decl('session_timeout_s', 'REQUIRES_DEVICE_TEST', 'DOCUMENTED', TIMEOUT_RDT),
    decl('idle_timeout_s', 'REQUIRES_DEVICE_TEST', 'DOCUMENTED', IDLE_RDT),
    decl('max_concurrent_sessions', 'ECLOUD_SIDE_ONLY', 'DOCUMENTED', EV.concurrencyEcloudSide),
    decl('max_devices', 'ECLOUD_SIDE_ONLY', 'DOCUMENTED', EV.concurrencyEcloudSide),
    decl('valid_from', 'ECLOUD_SIDE_ONLY', 'DOCUMENTED', EV.validityEcloudSide),
    decl('valid_until', 'ECLOUD_SIDE_ONLY', 'DOCUMENTED', EV.validityEcloudSide),
    decl('voucher_validity', 'ECLOUD_SIDE_ONLY', 'DOCUMENTED', EV.voucherEcloudSide),
    decl('schedule_id', 'ECLOUD_SIDE_ONLY', 'DOCUMENTED', EV.scheduleEcloudSide),
    decl('vlan_id', 'UNSUPPORTED', 'DOCUMENTED', VLAN_UNSUPPORTED),
  ]),
  attributes: attributeTable([
    { ...MIKROTIK_RATE_ATTRIBUTE, evidence: `${MIKROTIK_RATE_ATTRIBUTE.evidence} (${R33})` },
    attr(
      MIKROTIK_TOTAL_LIMIT_ATTRIBUTE,
      'REQUIRES_DEVICE_TEST',
      'DOCUMENTED',
      QUOTA_RDT,
      'Mikrotik',
      'bits 0..31 of the remaining session byte budget',
    ),
    attr(
      MIKROTIK_TOTAL_LIMIT_GIGAWORDS_ATTRIBUTE,
      'REQUIRES_DEVICE_TEST',
      'DOCUMENTED',
      QUOTA_RDT,
      'Mikrotik',
      'bits 32..63 of the remaining session byte budget',
    ),
    attr('Session-Timeout', 'REQUIRES_DEVICE_TEST', 'DOCUMENTED', TIMEOUT_RDT),
    attr('Idle-Timeout', 'REQUIRES_DEVICE_TEST', 'DOCUMENTED', IDLE_RDT),
    attr(
      'Acct-Interim-Interval',
      'REQUIRES_DEVICE_TEST',
      'DOCUMENTED',
      INTERIM_RDT,
      undefined,
      'needs radius-interim-update=received on the HotSpot server profile',
    ),
    attr('Class', 'REQUIRES_DEVICE_TEST', 'DOCUMENTED', CLASS_RDT),
  ]),
};

/** Re-exported for the setup guide / docs (the policy-engine set plus the hotspot pages). */
export const MIKROTIK_DOCS: readonly EvidenceRef[] = Object.freeze([
  MIKROTIK_RADIUS_DOC,
  MIKROTIK_HOTSPOT_CUSTOMISATION_DOC,
  MIKROTIK_HOTSPOT_DOC,
  ...MIKROTIK_RADIUS_DOCS,
]);

export const adapter: NasAdapter = createAdapter(capabilities, {
  disconnectMandatory: ['Calling-Station-Id'],
  disconnectNote: `Calling-Station-Id (client MAC) plus User-Name / Acct-Session-Id / Framed-IP-Address when known; RouterOS matching rules are not documented: REQUIRES_DEVICE_TEST (D-006). Port: nas_clients.coa_port, else ${String(MIKROTIK_DEFAULT_COA_PORT)}.`,
});
