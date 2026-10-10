/**
 * `generic-radius-8021x` (Cycle A, D-044; docs/VENDOR_INTEGRATION_RESEARCH.md §2 F9, §3.1):
 * vendor-neutral WPA2/WPA3-Enterprise (802.1X / EAP terminated by ECLOUD FreeRADIUS) and
 * MAC-authentication (MAB) NAS of ANY vendor. No captive portal.
 *
 * Only IETF-standard reply attributes are declared (plus the WISPr bandwidth pair, which many
 * enterprise vendors document). Nothing is VERIFIED: there is no vendor source and no lab test,
 * so every device-side cell is DOCUMENTED / REQUIRES_DEVICE_TEST (D-028, plan V1/V12). Per-vendor
 * dictionaries (Cisco AVPair, Aruba-User-Role, Ruckus, ...) are deliberately not declared here;
 * they belong to vendor profiles after lab capture.
 */
import type { AdapterCapabilities } from '@ecloud/policy-engine';
import type { EvidenceRef } from '@ecloud/shared';
import { attr, attributeTable, createAdapter, decl, fieldTable, sourced } from '../base.js';
import { EV } from '../evidence.js';
import type { NasAdapter } from '../types.js';

const F9: EvidenceRef = {
  kind: 'doc-section',
  ref: 'docs/VENDOR_INTEGRATION_RESEARCH.md §2 F9, §3.1 (generic-radius-8021x)',
};
const RFC2865: EvidenceRef = {
  kind: 'url',
  ref: 'RFC 2865 §5.27 Session-Timeout, §5.28 Idle-Timeout, §5.25 Class',
  url: 'https://www.rfc-editor.org/rfc/rfc2865',
};
const RFC2869: EvidenceRef = {
  kind: 'url',
  ref: 'RFC 2869 §5.16 Acct-Interim-Interval',
  url: 'https://www.rfc-editor.org/rfc/rfc2869',
};
const RFC3580: EvidenceRef = {
  kind: 'url',
  ref: 'RFC 3580 §3.31 Tunnel-Type=VLAN, Tunnel-Medium-Type=802, Tunnel-Private-Group-ID',
  url: 'https://www.rfc-editor.org/rfc/rfc3580',
};
const RFC5176: EvidenceRef = {
  kind: 'url',
  ref: 'RFC 5176 Dynamic Authorization (Disconnect-Request / CoA-Request)',
  url: 'https://www.rfc-editor.org/rfc/rfc5176',
};

const NOT_PER_VENDOR =
  'standard attribute; honouring is vendor- and firmware-specific and untested (no lab result, D-028; docs/VENDOR_INTEGRATION_RESEARCH.md §3.1)';
const R31 = 'docs/VENDOR_INTEGRATION_RESEARCH.md §3.1';

const TIMEOUT_RDT = sourced(`Session-Timeout (RFC 2865): ${NOT_PER_VENDOR}`, [F9, RFC2865]);
const IDLE_RDT = sourced(`Idle-Timeout (RFC 2865): ${NOT_PER_VENDOR}`, [F9, RFC2865]);
const INTERIM_RDT = sourced(`Acct-Interim-Interval (RFC 2869): ${NOT_PER_VENDOR}`, [F9, RFC2869]);
const CLASS_RDT = sourced(`Class (RFC 2865 §5.25) echo into accounting: ${NOT_PER_VENDOR}`, [
  F9,
  RFC2865,
]);
const VLAN_RDT = sourced(`RFC 3580 VLAN triplet: ${NOT_PER_VENDOR}`, [F9, RFC3580]);
const RATE_RDT = sourced(
  'WISPr-Bandwidth-Max-Down/Up (bit/s) are documented by several enterprise vendors but not vendor-neutral; per-vendor rate attributes are UNKNOWN until lab capture (docs/VENDOR_INTEGRATION_RESEARCH.md §3.1)',
  [F9],
);
const QUOTA_UNSUPPORTED = sourced(
  'no vendor-neutral octet-limit reply attribute (docs/VENDOR_INTEGRATION_RESEARCH.md §3.1 "quotas UNKNOWN" per vendor); bounded ECLOUD-side by the accounting watcher + Session-Timeout drain time (POLICY_ENGINE.md D3)',
  [F9],
);
const DISCONNECT_RDT = sourced(
  `RFC 5176 Disconnect-Request to the NAS DAS port (nas_clients.coa_port); support, identification attributes and Acct-Stop behaviour are per vendor and untested (D-006; ${R31})`,
  [F9, RFC5176],
);
const COA_RDT = sourced(
  `RFC 5176 CoA-Request attribute changes are per vendor and untested; no attribute is declared changeable (D-006; ${R31})`,
  [F9, RFC5176],
);
const MAC_AUTH_RDT = sourced(
  `MAC authentication (MAB): the NAS sends User-Name = client MAC (format per vendor), usually with Service-Type = Call-Check or User-Password = MAC; ECLOUD accepts it only when it equals Calling-Station-Id and the device has MAC auth enabled (AAA_ARCHITECTURE.md §2.3; ${R31})`,
  [F9],
);

export const capabilities: AdapterCapabilities = {
  key: 'generic-radius-8021x',
  version: '0.1.0',
  portalType: 'none-8021x-macauth',
  granularity: 'per-client',
  rateUnit: 'bps',
  rateFamilies: [
    {
      family: 'wispr',
      unit: 'bps',
      down: 'WISPr-Bandwidth-Max-Down',
      up: 'WISPr-Bandwidth-Max-Up',
      vendor: 'WISPr',
    },
  ],
  quotaAttributes: {},
  octetWidth: null,
  sessionTimeoutAttr: 'Session-Timeout',
  idleTimeoutAttr: 'Idle-Timeout',
  interimIntervalAttr: 'Acct-Interim-Interval',
  vlanAttrs: ['Tunnel-Type', 'Tunnel-Medium-Type', 'Tunnel-Private-Group-Id'],
  classAttr: 'Class',
  disconnect: {
    status: 'REQUIRES_DEVICE_TEST',
    target: 'rfc5176-das',
    identifyBy: [
      'User-Name',
      'Acct-Session-Id',
      'Calling-Station-Id',
      'NAS-IP-Address',
      'NAS-Identifier',
    ],
    acctStopEmitted: 'unknown',
    evidence: DISCONNECT_RDT.text,
    evidenceRefs: DISCONNECT_RDT.refs,
    evidenceLevel: 'DOCUMENTED',
    note: 'DAS port = nas_clients.coa_port (vendor default differs: 3799 per RFC 5176, MikroTik 1700); Meraki accepts Disconnect only (D-044)',
  },
  coaChange: {
    status: 'REQUIRES_DEVICE_TEST',
    changeable: [],
    evidence: COA_RDT.text,
    evidenceRefs: COA_RDT.refs,
    evidenceLevel: 'DOCUMENTED',
  },
  macAuth: {
    status: 'REQUIRES_DEVICE_TEST',
    evidence: MAC_AUTH_RDT.text,
    evidenceRefs: MAC_AUTH_RDT.refs,
    evidenceLevel: 'DOCUMENTED',
    usernameRule:
      'User-Name is a MAC (aa:bb:cc:dd:ee:ff, AA-BB-CC-DD-EE-FF, aabb.ccdd.eeff or aabbccddeeff) equal to Calling-Station-Id; password absent or the same MAC',
  },
  fields: fieldTable([
    decl('download_rate_kbps', 'REQUIRES_DEVICE_TEST', 'DOCUMENTED', RATE_RDT),
    decl('upload_rate_kbps', 'REQUIRES_DEVICE_TEST', 'DOCUMENTED', RATE_RDT),
    decl('burst_download_kbps', 'UNSUPPORTED', 'DOCUMENTED', EV.burstRadius),
    decl('burst_upload_kbps', 'UNSUPPORTED', 'DOCUMENTED', EV.burstRadius),
    decl('burst_duration_s', 'UNSUPPORTED', 'DOCUMENTED', EV.burstRadius),
    decl('quota_daily_bytes', 'UNSUPPORTED', 'DOCUMENTED', QUOTA_UNSUPPORTED),
    decl('quota_monthly_bytes', 'UNSUPPORTED', 'DOCUMENTED', QUOTA_UNSUPPORTED),
    decl('quota_total_bytes', 'UNSUPPORTED', 'DOCUMENTED', QUOTA_UNSUPPORTED),
    decl('session_timeout_s', 'REQUIRES_DEVICE_TEST', 'DOCUMENTED', TIMEOUT_RDT),
    decl('idle_timeout_s', 'REQUIRES_DEVICE_TEST', 'DOCUMENTED', IDLE_RDT),
    decl('max_concurrent_sessions', 'ECLOUD_SIDE_ONLY', 'DOCUMENTED', EV.concurrencyEcloudSide),
    decl('max_devices', 'ECLOUD_SIDE_ONLY', 'DOCUMENTED', EV.concurrencyEcloudSide),
    decl('valid_from', 'ECLOUD_SIDE_ONLY', 'DOCUMENTED', EV.validityEcloudSide),
    decl('valid_until', 'ECLOUD_SIDE_ONLY', 'DOCUMENTED', EV.validityEcloudSide),
    decl('voucher_validity', 'ECLOUD_SIDE_ONLY', 'DOCUMENTED', EV.voucherEcloudSide),
    decl('schedule_id', 'ECLOUD_SIDE_ONLY', 'DOCUMENTED', EV.scheduleEcloudSide),
    decl(
      'vlan_id',
      'REQUIRES_DEVICE_TEST',
      'DOCUMENTED',
      VLAN_RDT,
      'RFC 3580 triplet; the VLAN must exist on the NAS/switch side (untested per vendor)',
    ),
  ]),
  attributes: attributeTable([
    attr('WISPr-Bandwidth-Max-Down', 'REQUIRES_DEVICE_TEST', 'DOCUMENTED', RATE_RDT, 'WISPr'),
    attr('WISPr-Bandwidth-Max-Up', 'REQUIRES_DEVICE_TEST', 'DOCUMENTED', RATE_RDT, 'WISPr'),
    attr('Session-Timeout', 'REQUIRES_DEVICE_TEST', 'DOCUMENTED', TIMEOUT_RDT),
    attr('Idle-Timeout', 'REQUIRES_DEVICE_TEST', 'DOCUMENTED', IDLE_RDT),
    attr('Acct-Interim-Interval', 'REQUIRES_DEVICE_TEST', 'DOCUMENTED', INTERIM_RDT),
    attr('Tunnel-Type', 'REQUIRES_DEVICE_TEST', 'DOCUMENTED', VLAN_RDT, undefined, 'VLAN (13)'),
    attr(
      'Tunnel-Medium-Type',
      'REQUIRES_DEVICE_TEST',
      'DOCUMENTED',
      VLAN_RDT,
      undefined,
      'IEEE-802 (6)',
    ),
    attr(
      'Tunnel-Private-Group-Id',
      'REQUIRES_DEVICE_TEST',
      'DOCUMENTED',
      VLAN_RDT,
      undefined,
      'tagged string "<vlan_id>"',
    ),
    attr('Class', 'REQUIRES_DEVICE_TEST', 'DOCUMENTED', CLASS_RDT),
  ]),
};

export const adapter: NasAdapter = createAdapter(capabilities, {
  disconnectMandatory: ['Calling-Station-Id'],
  disconnectNote:
    'Calling-Station-Id identifies the station; User-Name / Acct-Session-Id / NAS-Identifier are added when known. Vendor DAS behaviour REQUIRES_DEVICE_TEST (D-006).',
});
