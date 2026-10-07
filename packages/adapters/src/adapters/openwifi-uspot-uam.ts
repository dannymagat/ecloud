/**
 * `openwifi-uspot-uam`: TIP-fork uspot on EZEAP (CAPTIVE_PORTAL_ARCHITECTURE.md §3 "(T)").
 * Assumed EZEAP adapter until the shipped uspot code base is confirmed (A4 §0 item 1).
 */
import type { AdapterCapabilities } from '@ecloud/policy-engine';
import { attr, attributeTable, createAdapter, decl, fieldTable } from '../base.js';
import { EV } from '../evidence.js';
import type { NasAdapter } from '../types.js';

const RATE_VERIFIED =
  "NETWORK_INTEGRATION.md §2 row 'Per-client cap from RADIUS (captive clients)': uspot reads WISPr-Bandwidth-Max-Up/Down (bps) or ChilliSpot-Bandwidth-Max-Up/Down (kbps×1000) → ubus ratelimit client_set, VERIFIED DOCS (uspot.uc l.179-204); CAPTIVE_PORTAL_ARCHITECTURE.md §3.4 reply table rows WISPr-Bandwidth-Max-Up/Down (T: yes), ChilliSpot-Bandwidth-Max-Up/Down (T: yes)";
const RATE_NOTE =
  'dictionary presence on the device (WISPr 14122 / ChilliSpot 14559) is REQUIRES DEVICE TEST (NETWORK_INTEGRATION.md §7.2); emit one family only (POLICY_ENGINE.md §4.1)';
const QUOTA_VERIFIED =
  "NETWORK_INTEGRATION.md §2 row 'Per-session total quota (captive)': uspot ChilliSpot-Max-Total-Octets terminates when bytes_ul+bytes_dl ≥ max, VERIFIED DOCS (uspot.uc l.225, l.349-353); CAPTIVE_PORTAL_ARCHITECTURE.md §3.4 row ChilliSpot-Max-Total-Octets (T: yes, 32-bit)";
const QUOTA_NOTE =
  'period counter is ECLOUD-side (usage_counters); remaining bytes emitted per session as a 32-bit octet limit (< 4 GiB, clamp → overflow_clamped)';
const TIMEOUT_VERIFIED =
  "CAPTIVE_PORTAL_ARCHITECTURE.md §3.4 reply table row Session-Timeout (T: yes, Stop cause 5); NETWORK_INTEGRATION.md §2 row 'Session timeout / idle timeout (captive)' VERIFIED CODE + DOCS (uspot.uc l.215-227)";
const IDLE_VERIFIED =
  "CAPTIVE_PORTAL_ARCHITECTURE.md §3.4 reply table row Idle-Timeout (T: yes, Stop cause 4); NETWORK_INTEGRATION.md §2 row 'Session timeout / idle timeout (captive)' VERIFIED CODE + DOCS";
const INTERIM_VERIFIED =
  "CAPTIVE_PORTAL_ARCHITECTURE.md §3.4 reply table row Acct-Interim-Interval (T: yes, but a configured acct_interval overrides it); NETWORK_INTEGRATION.md §7.2 row 'interim interval' VERIFIED DOCS (uspot.uc l.216-222)";
const CLASS_VERIFIED =
  'CAPTIVE_PORTAL_ARCHITECTURE.md §3.4 reply table row Class (T: copied to accounting); AAA_ARCHITECTURE.md §4.3 row Correlation';
const VLAN_UNSUPPORTED =
  "CAPTIVE_PORTAL_ARCHITECTURE.md §3.4 reply table row 'WISPr-Redirection-URL, Filter-Id, VLAN attrs' (T: no); POLICY_ENGINE.md §3.1 row vlan (openwifi-uspot-uam): UNSUPPORTED";
const IO_OCTETS_UNSUPPORTED =
  "CAPTIVE_PORTAL_ARCHITECTURE.md §3.4 reply table row 'ChilliSpot-Max-Input/Output-Octets(+Gigawords)' (T: no)";
const DISCONNECT_RDT =
  "CAPTIVE_PORTAL_ARCHITECTURE.md §3.5 (T): no RADIUS DAS in uspot; hostapd `coa` ubus notify → client_kick (VERIFIED source), no Acct-Stop on this path; hostapd.c side of the hook on the 25.12 build UNKNOWN → REQUIRES DEVICE TEST; AAA_ARCHITECTURE.md §6 row 'EZEAP uspot (TIP fork)'";

export const capabilities: AdapterCapabilities = {
  key: 'openwifi-uspot-uam',
  version: '0.1.0',
  portalType: 'uam-chillispot',
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
    {
      family: 'chillispot',
      unit: 'kbps',
      down: 'ChilliSpot-Bandwidth-Max-Down',
      up: 'ChilliSpot-Bandwidth-Max-Up',
      vendor: 'ChilliSpot',
    },
  ],
  quotaAttributes: { total: 'ChilliSpot-Max-Total-Octets' },
  octetWidth: 32,
  sessionTimeoutAttr: 'Session-Timeout',
  idleTimeoutAttr: 'Idle-Timeout',
  interimIntervalAttr: 'Acct-Interim-Interval',
  vlanAttrs: [],
  classAttr: 'Class',
  disconnect: {
    status: 'REQUIRES_DEVICE_TEST',
    target: 'hostapd-das',
    identifyBy: ['Calling-Station-Id', 'NAS-Identifier'],
    acctStopEmitted: false,
    evidence: DISCONNECT_RDT,
    note: 'ECLOUD must close the session itself after Disconnect-ACK (no Acct-Stop, A4 §3.5 / POLICY_ENGINE.md §2.6)',
  },
  coaChange: {
    status: 'UNSUPPORTED',
    changeable: [],
    evidence:
      'CAPTIVE_PORTAL_ARCHITECTURE.md §7.4 uspot-uam CoA: attribute changes are not applied by T → re-authentication is the only way to change a live rate; POLICY_ENGINE.md §3.1 row coa_change (openwifi-uspot-uam): UNSUPPORTED',
  },
  macAuth: {
    status: 'VERIFIED_SUPPORTED',
    evidence: 'CAPTIVE_PORTAL_ARCHITECTURE.md §3.6 MAC-auth (T handler.uc L22-37)',
    usernameRule:
      'User-Name = formatted MAC + mac_suffix; User-Password = mac_passwd || formatted MAC; Service-Type = Call-Check',
  },
  fields: fieldTable([
    decl('download_rate_kbps', 'VERIFIED_SUPPORTED', RATE_VERIFIED, RATE_NOTE),
    decl('upload_rate_kbps', 'VERIFIED_SUPPORTED', RATE_VERIFIED, RATE_NOTE),
    decl('burst_download_kbps', 'UNSUPPORTED', EV.burstAbsent),
    decl('burst_upload_kbps', 'UNSUPPORTED', EV.burstAbsent),
    decl('burst_duration_s', 'UNSUPPORTED', EV.burstAbsent),
    decl('quota_daily_bytes', 'VERIFIED_SUPPORTED', QUOTA_VERIFIED, QUOTA_NOTE),
    decl('quota_monthly_bytes', 'VERIFIED_SUPPORTED', QUOTA_VERIFIED, QUOTA_NOTE),
    decl('quota_total_bytes', 'VERIFIED_SUPPORTED', QUOTA_VERIFIED, QUOTA_NOTE),
    decl('session_timeout_s', 'VERIFIED_SUPPORTED', TIMEOUT_VERIFIED),
    decl('idle_timeout_s', 'VERIFIED_SUPPORTED', IDLE_VERIFIED),
    decl('max_concurrent_sessions', 'ECLOUD_SIDE_ONLY', EV.concurrencyEcloudSide),
    decl('max_devices', 'ECLOUD_SIDE_ONLY', EV.concurrencyEcloudSide),
    decl('valid_from', 'ECLOUD_SIDE_ONLY', EV.validityEcloudSide),
    decl('valid_until', 'ECLOUD_SIDE_ONLY', EV.validityEcloudSide),
    decl('voucher_validity', 'ECLOUD_SIDE_ONLY', EV.voucherEcloudSide),
    decl('schedule_id', 'ECLOUD_SIDE_ONLY', EV.scheduleEcloudSide),
    decl('vlan_id', 'UNSUPPORTED', VLAN_UNSUPPORTED),
  ]),
  attributes: attributeTable([
    attr('WISPr-Bandwidth-Max-Down', 'VERIFIED_SUPPORTED', RATE_VERIFIED, 'WISPr', 'bit/s'),
    attr('WISPr-Bandwidth-Max-Up', 'VERIFIED_SUPPORTED', RATE_VERIFIED, 'WISPr', 'bit/s'),
    attr(
      'ChilliSpot-Bandwidth-Max-Down',
      'VERIFIED_SUPPORTED',
      RATE_VERIFIED,
      'ChilliSpot',
      'kbit/s (×1000 in uspot)',
    ),
    attr(
      'ChilliSpot-Bandwidth-Max-Up',
      'VERIFIED_SUPPORTED',
      RATE_VERIFIED,
      'ChilliSpot',
      'kbit/s (×1000 in uspot)',
    ),
    attr(
      'ChilliSpot-Max-Total-Octets',
      'VERIFIED_SUPPORTED',
      QUOTA_VERIFIED,
      'ChilliSpot',
      '32-bit; behaviour at 4294967295 REQUIRES DEVICE TEST (POLICY_ENGINE.md §9.3 item 2)',
    ),
    attr(
      'ChilliSpot-Max-Total-Gigawords',
      'UNSUPPORTED',
      IO_OCTETS_UNSUPPORTED,
      'ChilliSpot',
      'T honours the 32-bit total only',
    ),
    attr('ChilliSpot-Max-Input-Octets', 'UNSUPPORTED', IO_OCTETS_UNSUPPORTED, 'ChilliSpot'),
    attr('ChilliSpot-Max-Output-Octets', 'UNSUPPORTED', IO_OCTETS_UNSUPPORTED, 'ChilliSpot'),
    attr('Session-Timeout', 'VERIFIED_SUPPORTED', TIMEOUT_VERIFIED),
    attr('Idle-Timeout', 'VERIFIED_SUPPORTED', IDLE_VERIFIED),
    attr(
      'Acct-Interim-Interval',
      'VERIFIED_SUPPORTED',
      INTERIM_VERIFIED,
      undefined,
      'honoured only if NAS acct-interval unset (A4 §3.4); renderer default injection REQUIRES DEVICE TEST (A4 §10 item 5)',
    ),
    attr('Class', 'VERIFIED_SUPPORTED', CLASS_VERIFIED),
  ]),
};

export const adapter: NasAdapter = createAdapter(capabilities, {
  disconnectMandatory: ['Calling-Station-Id'],
  disconnectNote:
    'Send to the hostapd DAS of the captive SSID (ssid.radius.dynamic-authorization); expect ACK; ECLOUD closes the session (no Acct-Stop). REQUIRES DEVICE TEST.',
});
