/**
 * `external-portal-postback` (Cycle C, D-044; docs/VENDOR_INTEGRATION_RESEARCH.md §2 F3, §3.4):
 * engine record of the external captive portal post-back family. The AP / controller redirects
 * the browser to ECLOUD, ECLOUD issues a single-use portal credential (`pc-…`), and the browser
 * posts it back to a login URL on the AP / controller, which sends the RADIUS Access-Request.
 * Vendor differences (parameter names, login target, field names) live in data profiles
 * (`vendor/postback/profiles.ts`); the RADIUS reply is the same for every profile.
 *
 * Only IETF-standard reply attributes are emitted. No vendor rate attribute is modelled: the
 * research found none documented to vendor-doc level for Cisco, Aruba, Fortinet, Ruckus, Omada or
 * Huawei, and Cambium's `WIFI_ALLIANCE_MAX_UP/DOWN` has an unknown dictionary name, vendor id and
 * unit (plan §7.3). Rate, quota and VLAN are therefore NOT device-enforced (UNSUPPORTED here, so
 * the editor never shows them as enforced); every emitted attribute is DOCUMENTED /
 * REQUIRES_DEVICE_TEST (D-028). Nothing is VERIFIED: no vendor source, no lab test.
 */
import type { AdapterCapabilities } from '@ecloud/policy-engine';
import type { EvidenceRef } from '@ecloud/shared';
import { attr, attributeTable, createAdapter, decl, fieldTable, sourced } from '../base.js';
import { EV } from '../evidence.js';
import type { NasAdapter } from '../types.js';

const F3: EvidenceRef = {
  kind: 'doc-section',
  ref: 'docs/VENDOR_INTEGRATION_RESEARCH.md §2 F3, §3.4 (external-portal-postback)',
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
const RFC5176: EvidenceRef = {
  kind: 'url',
  ref: 'RFC 5176 Dynamic Authorization (Disconnect-Request)',
  url: 'https://www.rfc-editor.org/rfc/rfc5176',
};

const R34 = 'docs/VENDOR_INTEGRATION_RESEARCH.md §3.4';
const PER_PROFILE = `standard attribute; documented for Cambium (plan §7.3 C1), Cisco and Ruckus ZD session timeout (${R34}); honouring per vendor and firmware is untested (D-028)`;

const TIMEOUT_RDT = sourced(`Session-Timeout (RFC 2865): ${PER_PROFILE}`, [F3, RFC2865]);
const IDLE_RDT = sourced(`Idle-Timeout (RFC 2865): ${PER_PROFILE}`, [F3, RFC2865]);
const INTERIM_RDT = sourced(
  `Acct-Interim-Interval (RFC 2869): interim accounting documented for Ruckus ZD, Cisco, Cambium, Omada (${R34}); untested`,
  [F3, RFC2869],
);
const CLASS_RDT = sourced(
  `Class (RFC 2865 §5.25) echoed into accounting: documented for Cambium (plan §7.3 C1); other vendors untested (${R34})`,
  [F3, RFC2865],
);
const RATE_UNSUPPORTED = sourced(
  `no vendor-documented rate reply attribute is modelled for the post-back family: ${R34} "up/down rate UNKNOWN"; Cambium WIFI_ALLIANCE_MAX_UP/DOWN dictionary name, vendor id and units UNKNOWN (MULTI_VENDOR_INTEGRATION_PLAN.md §7.3); never assumed to be WISPr (${R34} §6 item 13). Not device-enforced; use a gateway adapter for enforced rates`,
  [F3],
);
const QUOTA_UNSUPPORTED = sourced(
  `no vendor-documented octet-limit attribute (${R34} "quotas UNKNOWN"); bounded ECLOUD-side by the accounting watcher (POLICY_ENGINE.md D3)`,
  [F3],
);
const VLAN_UNSUPPORTED = sourced(
  `VLAN assignment for post-back captive portals is not documented for any F3 vendor (${R34} "VLAN UNKNOWN"); not emitted`,
  [F3],
);
const DISCONNECT_RDT = sourced(
  `RFC 5176 Disconnect-Request to nas_clients.coa_port: a CoA/DA option exists in the Cisco 9800, FortiGate and Aruba IAP UIs per third-party guides only (${R34}); support and identification attributes untested (D-006)`,
  [F3, RFC5176],
);
const COA_RDT = sourced(
  `CoA attribute change undocumented for every F3 vendor (${R34} "CoA change UNKNOWN"); no attribute declared changeable (D-006)`,
  [F3, RFC5176],
);

export const capabilities: AdapterCapabilities = {
  key: 'external-portal-postback',
  version: '0.1.0',
  portalType: 'external-postback',
  granularity: 'per-client',
  rateUnit: 'bps',
  rateFamilies: [],
  quotaAttributes: {},
  octetWidth: null,
  sessionTimeoutAttr: 'Session-Timeout',
  idleTimeoutAttr: 'Idle-Timeout',
  interimIntervalAttr: 'Acct-Interim-Interval',
  vlanAttrs: [],
  classAttr: 'Class',
  disconnect: {
    status: 'REQUIRES_DEVICE_TEST',
    target: 'rfc5176-das',
    identifyBy: ['User-Name', 'Acct-Session-Id', 'Calling-Station-Id', 'NAS-IP-Address'],
    acctStopEmitted: 'unknown',
    evidence: DISCONNECT_RDT.text,
    evidenceRefs: DISCONNECT_RDT.refs,
    evidenceLevel: 'DOCUMENTED',
    note: 'DAS port = nas_clients.coa_port; per-vendor DAS behaviour REQUIRES_DEVICE_TEST (D-006)',
  },
  coaChange: {
    status: 'REQUIRES_DEVICE_TEST',
    changeable: [],
    evidence: COA_RDT.text,
    evidenceRefs: COA_RDT.refs,
    evidenceLevel: 'DOCUMENTED',
  },
  macAuth: {
    status: 'UNSUPPORTED',
    evidence: `the post-back family authenticates through the portal credential (pc-…); MAC-as-username authentication is limited to generic-radius-8021x (AAA_ARCHITECTURE.md §2.3; ${R34})`,
    evidenceRefs: [F3],
    evidenceLevel: 'DOCUMENTED',
    usernameRule: 'not applicable (portal credential pc-<16 hex>)',
  },
  fields: fieldTable([
    decl('download_rate_kbps', 'UNSUPPORTED', 'DOCUMENTED', RATE_UNSUPPORTED),
    decl('upload_rate_kbps', 'UNSUPPORTED', 'DOCUMENTED', RATE_UNSUPPORTED),
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
    decl('vlan_id', 'UNSUPPORTED', 'DOCUMENTED', VLAN_UNSUPPORTED),
  ]),
  attributes: attributeTable([
    attr('Session-Timeout', 'REQUIRES_DEVICE_TEST', 'DOCUMENTED', TIMEOUT_RDT),
    attr('Idle-Timeout', 'REQUIRES_DEVICE_TEST', 'DOCUMENTED', IDLE_RDT),
    attr('Acct-Interim-Interval', 'REQUIRES_DEVICE_TEST', 'DOCUMENTED', INTERIM_RDT),
    attr('Class', 'REQUIRES_DEVICE_TEST', 'DOCUMENTED', CLASS_RDT),
  ]),
};

export const adapter: NasAdapter = createAdapter(capabilities, {
  disconnectMandatory: ['Calling-Station-Id'],
  disconnectNote:
    'Calling-Station-Id identifies the station; User-Name / Acct-Session-Id are added when known. Vendor DAS behaviour REQUIRES_DEVICE_TEST (D-006).',
});
