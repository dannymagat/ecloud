/**
 * `openwifi-hostapd-radius`: 802.1X / MAC-auth clients on EZEAP (hostapd as RADIUS client).
 * Nothing per-client is VERIFIED for this path in the Phase 2 docs (POLICY_ENGINE.md §3.1
 * column 1); every RADIUS attribute is REQUIRES_DEVICE_TEST.
 */
import type { AdapterCapabilities } from '@ecloud/policy-engine';
import { attr, attributeTable, createAdapter, decl, fieldTable } from '../base.js';
import { EV } from '../evidence.js';
import type { NasAdapter } from '../types.js';

const RATE_RDT =
  "NETWORK_INTEGRATION.md §2 row 'Per-client cap from RADIUS (802.1X / MAC-auth clients)': no handler found in renderer/hostapd options, UNKNOWN → REQUIRES DEVICE TEST; POLICY_ENGINE.md §3.1 row rate_limit (openwifi-hostapd-radius)";
const TIMEOUT_RDT =
  "NETWORK_INTEGRATION.md §2 row 'Session/idle timeout (802.1X)': RADIUS Session-Timeout honouring by hostapd not verified, UNKNOWN / REQUIRES DEVICE TEST; POLICY_ENGINE.md §3.1 row session_timeout";
const IDLE_RDT =
  "NETWORK_INTEGRATION.md §2 row 'Session/idle timeout (802.1X)': hostapd max_inactivity ← ssids[].max-inactivity is per-SSID only; RADIUS Idle-Timeout UNKNOWN; POLICY_ENGINE.md §3.1 row idle_timeout";
const QUOTA_UNSUPPORTED =
  "POLICY_ENGINE.md §3.1 row quota (openwifi-hostapd-radius): UNSUPPORTED (nothing verified; A2 §7.2 '—'); NETWORK_INTEGRATION.md §7.2 row 'per-session quota', 802.1X column '—'";
const VLAN_RDT =
  "NETWORK_INTEGRATION.md §2 row 'Dynamic VLAN from RADIUS': renderer sets dynamic_vlan=1 VERIFIED CODE, attributes REQUIRES DEVICE TEST; §7.2 row VLAN: Tunnel-Type=VLAN, Tunnel-Medium-Type=IEEE-802, Tunnel-Private-Group-Id; AAA_ARCHITECTURE.md §4.3 row VLAN";
const INTERIM_RDT =
  "NETWORK_INTEGRATION.md §2 row 'Accounting': hostapd acct_interval ← ssids[].radius.accounting.interval 60-600 (VERIFIED CODE); POLICY_ENGINE.md §3.1 row interim_interval (openwifi-hostapd-radius): RADIUS Acct-Interim-Interval effect UNKNOWN";
const CLASS_RDT =
  'AAA_ARCHITECTURE.md §4.3 row Correlation: `Class` (standard) — label VERIFIED only for uspot/chilli; hostapd echo into accounting not verified in Phase 2 docs';
const DISCONNECT_RDT =
  "NETWORK_INTEGRATION.md §5 row 'RADIUS Disconnect-Request → hostapd DAS': config path VERIFIED CODE+DOCS, packet handling REQUIRES DEVICE TEST (identifying attributes, secret handling, NAT-mode reachability); AAA_ARCHITECTURE.md §6 row 'EZEAP hostapd (802.1X / MAC-auth)'";

export const capabilities: AdapterCapabilities = {
  key: 'openwifi-hostapd-radius',
  version: '0.1.0',
  portalType: 'none-8021x-macauth',
  granularity: 'per-client',
  rateUnit: null,
  rateFamilies: [],
  quotaAttributes: {},
  octetWidth: null,
  sessionTimeoutAttr: 'Session-Timeout',
  idleTimeoutAttr: 'Idle-Timeout',
  interimIntervalAttr: 'Acct-Interim-Interval',
  vlanAttrs: ['Tunnel-Type', 'Tunnel-Medium-Type', 'Tunnel-Private-Group-Id'],
  classAttr: 'Class',
  disconnect: {
    status: 'REQUIRES_DEVICE_TEST',
    target: 'hostapd-das',
    identifyBy: ['Calling-Station-Id', 'NAS-Identifier', 'User-Name', 'Acct-Session-Id'],
    acctStopEmitted: 'unknown',
    evidence: DISCONNECT_RDT,
    evidenceLevel: 'DOCUMENTED',
    note: 'hostapd DAS via ssid.radius.dynamic-authorization{host,port,secret}; NAS-Identifier selects the BSS on a shared DAS port (A4 §3.5)',
  },
  coaChange: {
    status: 'REQUIRES_DEVICE_TEST',
    changeable: [],
    evidenceLevel: 'DOCUMENTED',
    evidence:
      "NETWORK_INTEGRATION.md §5 row 'RADIUS CoA-Request → hostapd': UNKNOWN → REQUIRES DEVICE TEST; POLICY_ENGINE.md §3.1 row coa_change",
  },
  macAuth: {
    status: 'REQUIRES_DEVICE_TEST',
    evidenceLevel: 'DOCUMENTED',
    evidence:
      "NETWORK_INTEGRATION.md §2 row 'RADIUS MAC authentication': mac-filter VERIFIED CODE + DOCS; POLICY_ENGINE.md §3.1 row mac_auth: username/password format REQUIRES DEVICE TEST (A2 §11 item 7)",
  },
  fields: fieldTable([
    decl(
      'download_rate_kbps',
      'REQUIRES_DEVICE_TEST',
      'DOCUMENTED',
      RATE_RDT,
      'no verified per-client rate attribute for hostapd; site-scoped intent can fall back to SSID rate-limit via openwifi-config',
    ),
    decl(
      'upload_rate_kbps',
      'REQUIRES_DEVICE_TEST',
      'DOCUMENTED',
      RATE_RDT,
      'no verified per-client rate attribute for hostapd; site-scoped intent can fall back to SSID rate-limit via openwifi-config',
    ),
    decl('burst_download_kbps', 'UNSUPPORTED', 'DOCUMENTED', EV.burstAbsent),
    decl('burst_upload_kbps', 'UNSUPPORTED', 'DOCUMENTED', EV.burstAbsent),
    decl('burst_duration_s', 'UNSUPPORTED', 'DOCUMENTED', EV.burstAbsent),
    decl(
      'quota_daily_bytes',
      'UNSUPPORTED',
      'DOCUMENTED',
      QUOTA_UNSUPPORTED,
      'no octet attribute; bounded by Session-Timeout drain time + accounting watcher (POLICY_ENGINE.md D3)',
    ),
    decl(
      'quota_monthly_bytes',
      'UNSUPPORTED',
      'DOCUMENTED',
      QUOTA_UNSUPPORTED,
      'no octet attribute; bounded by Session-Timeout drain time + accounting watcher (POLICY_ENGINE.md D3)',
    ),
    decl(
      'quota_total_bytes',
      'UNSUPPORTED',
      'DOCUMENTED',
      QUOTA_UNSUPPORTED,
      'no octet attribute; bounded by Session-Timeout drain time + accounting watcher (POLICY_ENGINE.md D3)',
    ),
    decl('session_timeout_s', 'REQUIRES_DEVICE_TEST', 'DOCUMENTED', TIMEOUT_RDT),
    decl(
      'idle_timeout_s',
      'REQUIRES_DEVICE_TEST',
      'DOCUMENTED',
      IDLE_RDT,
      'per-SSID max-inactivity only (config)',
    ),
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
      'RFC 3580 triplet; VLAN pre-existence / vlan-awareness requirements untested (POLICY_ENGINE.md §9.3 item 6)',
    ),
  ]),
  attributes: attributeTable([
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
    'Calling-Station-Id identifies the station; add NAS-Identifier on shared DAS ports (A4 §3.5). ACK/NAK and Acct-Stop behaviour REQUIRES DEVICE TEST (POLICY_ENGINE.md §9.3 item 4).',
});
