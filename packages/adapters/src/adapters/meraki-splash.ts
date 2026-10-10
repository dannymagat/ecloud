/**
 * `meraki-splash` (multi-vendor Cycle E, D-044; docs/VENDOR_INTEGRATION_RESEARCH.md §2 F4, §3.5):
 * Cisco Meraki MR access points with the splash page "Sign-on with my RADIUS server" and a
 * custom-hosted splash URL pointing at the ECLOUD portal. The browser POSTs the broker credential
 * to the Meraki-hosted `login_url`; the **Meraki Cloud** (not the AP) then sends a PAP
 * Access-Request and accounting to ECLOUD, and accepts RFC 5176 **Disconnect only** on the
 * organization's dashboard host, UDP 3799.
 *
 * Every device-side cell is DOCUMENTED / REQUIRES_DEVICE_TEST (no lab test, D-028). Bandwidth:
 * Meraki applies per-user limits only through a `Filter-Id` naming a pre-defined Dashboard group
 * policy, so ECLOUD cannot push arbitrary rates; no rate family is declared.
 */
import type { AdapterCapabilities } from '@ecloud/policy-engine';
import type { EvidenceRef } from '@ecloud/shared';
import { attr, attributeTable, createAdapter, decl, fieldTable, sourced } from '../base.js';
import { EV } from '../evidence.js';
import type { NasAdapter } from '../types.js';

const F4: EvidenceRef = {
  kind: 'doc-section',
  ref: 'docs/VENDOR_INTEGRATION_RESEARCH.md §2 F4, §3.5 (meraki-splash)',
};
/** Meraki documentation (fetched for research 2026-10-10; read again via a search extract in Cycle E). */
export const MERAKI_DOCS = {
  customSplash: {
    kind: 'url',
    ref: 'Meraki doc "Configuring a Custom-Hosted Splash Page to Work with the Meraki Cloud"',
    url: 'https://documentation.meraki.com/MR/MR_Splash_Page/Configuring_a_Custom-Hosted_Splash_Page_to_Work_with_the_Meraki_Cloud',
  },
  signOnApi: {
    kind: 'url',
    ref: 'Meraki Developer Hub "Captive Portal with Sign on API logic" (redirect + POST parameters)',
    url: 'https://developer.cisco.com/meraki/captive-portal-api/sign-on-api/',
  },
  clickThroughApi: {
    kind: 'url',
    ref: 'Meraki Developer Hub "Captive Portal with Click-through API logic" (grant parameters)',
    url: 'https://developer.cisco.com/meraki/captive-portal-api/click-through-api/',
  },
  radiusSignOn: {
    kind: 'url',
    ref: 'Meraki doc "Configuring RADIUS Authentication with a Sign-On Splash Page" (PAP, attributes, cloud source IPs)',
    url: 'https://documentation.meraki.com/Platform_Management/Dashboard_Administration/Design_and_Configure/Configuration_Guides/Splash_Page_Configuration/Configuring_RADIUS_Authentication_with_a_Sign-on_Splash_Page',
  },
  radiusAccounting: {
    kind: 'url',
    ref: 'Meraki doc "RADIUS Authentication and Accounting with a Sign-On Splash Page" (session timeout, idle timeout, stop timing)',
    url: 'https://documentation.meraki.com/General_Administration/Cross-Platform_Content/RADIUS_Authentication_and_Accounting_with_a_Sign-On_Splash_Page',
  },
  disconnect: {
    kind: 'url',
    ref: 'Meraki doc "CoA Disconnect for Splash Sign-on" (Disconnect only, dashboard FQDN UDP 3799, Acct-Session-Id + Event-Timestamp)',
    url: 'https://documentation.meraki.com/MR/Splash_Page/CoA_Disconnect_for_Splash_Sign-on',
  },
  groupPolicy: {
    kind: 'url',
    ref: 'Meraki doc "Using RADIUS Attributes to Apply Group Policies" (Filter-Id)',
    url: 'https://documentation.meraki.com/MR/Group_Policies_and_Block_Lists/Using_RADIUS_Attributes_to_Apply_Group_Policies',
  },
} as const satisfies Record<string, EvidenceRef>;

const R35 = 'docs/VENDOR_INTEGRATION_RESEARCH.md §3.5';

const RATE_UNSUPPORTED = sourced(
  `Meraki applies per-user bandwidth only through Filter-Id naming a pre-defined Dashboard group policy (documented for 802.1X SSIDs; on splash sign-on REQUIRES_DEVICE_TEST); arbitrary ECLOUD rate values cannot be pushed (${R35})`,
  [F4, MERAKI_DOCS.groupPolicy],
);
const QUOTA_UNSUPPORTED = sourced(
  `no octet-limit reply attribute is documented for Meraki splash sign-on (${R35}: quotas UNKNOWN on the device); bounded ECLOUD-side by the accounting watcher + Session-Timeout (POLICY_ENGINE.md D3)`,
  [F4],
);
const TIMEOUT_RDT = sourced(
  `Session-Timeout: Meraki documents that the RADIUS session timeout overrides the Dashboard splash frequency (${R35}); untested (D-028)`,
  [F4, MERAKI_DOCS.radiusAccounting],
);
const IDLE_RDT = sourced(
  `Idle-Timeout: with RADIUS accounting, Meraki deauthenticates idle clients only when the RADIUS server sets an idle timeout (Meraki accounting doc; ${R35} listed it UNKNOWN before Cycle E); untested`,
  [F4, MERAKI_DOCS.radiusAccounting],
);
const CLASS_RDT = sourced(
  `Class (RFC 2865 §5.25) echo into Meraki Cloud accounting is not documented (${R35}); REQUIRES_DEVICE_TEST, the drainer also matches by Acct-Session-Id`,
  [F4],
);
const VLAN_UNSUPPORTED = sourced(
  `no VLAN reply attribute is documented for splash sign-on (${R35}: VLAN UNKNOWN); ECLOUD sends none`,
  [F4],
);
const DISCONNECT_RDT = sourced(
  `RFC 5176 Disconnect-Request to the organization's Meraki dashboard host (n<digits>.meraki.com) on UDP 3799 with Acct-Session-Id + Event-Timestamp (within 300 s), sent from the public address of the RADIUS server; untested (D-006; ${R35})`,
  [F4, MERAKI_DOCS.disconnect],
);
const COA_UNSUPPORTED = sourced(
  `Meraki: "the only dynamic authorization supported are disconnect messages" (${R35}); no CoA attribute change`,
  [F4, MERAKI_DOCS.disconnect],
);
const MAC_AUTH_UNSUPPORTED = sourced(
  `splash sign-on authenticates the user credential posted to login_url; MAC authentication is not part of this adapter (${R35})`,
  [F4],
);

export const capabilities: AdapterCapabilities = {
  key: 'meraki-splash',
  version: '0.1.0',
  portalType: 'meraki-splash-signon',
  granularity: 'per-client',
  rateUnit: null,
  rateFamilies: [],
  quotaAttributes: {},
  octetWidth: null,
  sessionTimeoutAttr: 'Session-Timeout',
  idleTimeoutAttr: 'Idle-Timeout',
  interimIntervalAttr: null,
  vlanAttrs: [],
  classAttr: 'Class',
  disconnect: {
    status: 'REQUIRES_DEVICE_TEST',
    target: 'meraki-cloud-das',
    identifyBy: ['Acct-Session-Id'],
    acctStopEmitted: 'unknown',
    evidence: DISCONNECT_RDT.text,
    evidenceRefs: DISCONNECT_RDT.refs,
    evidenceLevel: 'DOCUMENTED',
    note: 'Target = nas_clients.das_host:3799 (Meraki ignores additional attributes); off unless ECLOUD_COA_ENABLED and MERAKI_CLOUD_RADIUS_ENABLED',
  },
  coaChange: {
    status: 'UNSUPPORTED',
    changeable: [],
    evidence: COA_UNSUPPORTED.text,
    evidenceRefs: COA_UNSUPPORTED.refs,
    evidenceLevel: 'DOCUMENTED',
  },
  macAuth: {
    status: 'UNSUPPORTED',
    evidence: MAC_AUTH_UNSUPPORTED.text,
    evidenceRefs: MAC_AUTH_UNSUPPORTED.refs,
    evidenceLevel: 'DOCUMENTED',
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
    attr('Class', 'REQUIRES_DEVICE_TEST', 'DOCUMENTED', CLASS_RDT),
  ]),
};

export const adapter: NasAdapter = createAdapter(capabilities, {
  disconnectMandatory: ['Acct-Session-Id'],
  disconnectNote:
    'Meraki requires Acct-Session-Id (as in the accounting Start) and Event-Timestamp within 300 s; other attributes are ignored. Sent to nas_clients.das_host:3799. REQUIRES_DEVICE_TEST (D-006).',
});
