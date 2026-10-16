/**
 * `ezeap-uam`: TIP-fork uspot on EZEAP (CAPTIVE_PORTAL_ARCHITECTURE.md §3 "(T)").
 * Assumed EZEAP adapter until the shipped uspot code base is confirmed (A4 §0 item 1).
 *
 * DEVICE LIMITATION (LAB, 2026-10-14): uspot's RADIUS client, radcli 1.3.0, adds
 * Message-Authenticator (attribute 80) only when the request carries EAP-Message
 * (lib/sendserver.c:676, the sole call site) -- so a PAP Access-Request never has it. The gate
 * is unconditional in the shipped source rather than a build option, so EVERY radcli-based
 * client is affected, not only this device. Every client EZECLOUD renders sets
 * `require_message_authenticator = yes` (CVE-2024-3596), and FreeRADIUS 3.2 discards such a
 * request SILENTLY: no reply, no log line, no `/internal/aaa/authorize` call. Accounting is
 * unaffected (different branch, `rc_md5_calc`), so 1813 works while 1812 is mute, which makes
 * this look like a firewall or secret fault for as long as you let it.
 * Fix on the device (patch radcli to gate on PW_ACCESS_REQUEST); as a last resort clear
 * `nas_clients.require_message_authenticator` for that NAS and accept the exposure.
 * See infra/freeradius/README.md §5b.
 *
 * ACCT-INTERIM-INTERVAL IS NAS-AUTHORITATIVE (LAB, 2026-10-14, mechanism for the note on that
 * attribute below). uspot.uc:215-222 reads `let interval = settings.acct_interval` and only
 * falls back to the reply attribute with `||`, so a non-empty UCI `acct_interval` short-circuits
 * before our value is consulted -- deliberate, per RFC 2869. Session-Timeout and Idle-Timeout are
 * the opposite way round (reply first, UCI as fallback), which is why a clamped Session-Timeout
 * does override the device. `acct_interval` is rendered from the controller's AP profile, so this
 * is fleet-wide rather than per-device: to get a server-defined cadence, clear it in the profile
 * first; setting AAA_INTERIM_INTERVAL_S alone has no effect while it is set.
 */
import type { AdapterCapabilities } from '@ecloud/policy-engine';
import { attr, attributeTable, createAdapter, decl, fieldTable, sourced } from '../base.js';
import { EV, EV_SOURCED } from '../evidence.js';
import { SRC } from '../source-refs.js';
import type { NasAdapter } from '../types.js';

const RATE_VERIFIED =
  "NETWORK_INTEGRATION.md §2 row 'Per-client cap from RADIUS (captive clients)': uspot reads WISPr-Bandwidth-Max-Up/Down (bps) or ChilliSpot-Bandwidth-Max-Up/Down (kbps×1000) → ubus ratelimit client_set, VERIFIED DOCS (uspot.uc l.179-204); CAPTIVE_PORTAL_ARCHITECTURE.md §3.4 reply table rows WISPr-Bandwidth-Max-Up/Down (T: yes), ChilliSpot-Bandwidth-Max-Up/Down (T: yes)";
const RATE_NOTE =
  'dictionary presence on the device (WISPr 14122 / ChilliSpot 14559) is REQUIRES DEVICE TEST (NETWORK_INTEGRATION.md §7.2); emit one family only (POLICY_ENGINE.md §4.1)';
const QUOTA_VERIFIED =
  "NETWORK_INTEGRATION.md §2 row 'Per-session total quota (captive)': uspot ChilliSpot-Max-Total-Octets terminates when bytes_ul+bytes_dl ≥ max, VERIFIED DOCS (uspot.uc l.225, l.349-353); CAPTIVE_PORTAL_ARCHITECTURE.md §3.4 row ChilliSpot-Max-Total-Octets (T: yes, 32-bit)";
const QUOTA_NOTE =
  'period counter is EZECLOUD-side (usage_counters); remaining bytes emitted per session as a 32-bit octet limit (< 4 GiB, clamp → overflow_clamped)';
const TIMEOUT_VERIFIED =
  "CAPTIVE_PORTAL_ARCHITECTURE.md §3.4 reply table row Session-Timeout (T: yes, Stop cause 5); NETWORK_INTEGRATION.md §2 row 'Session timeout / idle timeout (captive)' VERIFIED CODE + DOCS (uspot.uc l.215-227)";
const IDLE_VERIFIED =
  "CAPTIVE_PORTAL_ARCHITECTURE.md §3.4 reply table row Idle-Timeout (T: yes, Stop cause 4); NETWORK_INTEGRATION.md §2 row 'Session timeout / idle timeout (captive)' VERIFIED CODE + DOCS";
const INTERIM_VERIFIED =
  "CAPTIVE_PORTAL_ARCHITECTURE.md §3.4 reply table row Acct-Interim-Interval (T: yes, but a configured acct_interval overrides it); NETWORK_INTEGRATION.md §7.2 row 'interim interval' VERIFIED DOCS (uspot.uc l.216-222)";
const CLASS_VERIFIED =
  'CAPTIVE_PORTAL_ARCHITECTURE.md §3.4 reply table row Class (T: copied to accounting); AAA_ARCHITECTURE.md §4.3 row Correlation';
const VLAN_UNSUPPORTED =
  "CAPTIVE_PORTAL_ARCHITECTURE.md §3.4 reply table row 'WISPr-Redirection-URL, Filter-Id, VLAN attrs' (T: no); POLICY_ENGINE.md §3.1 row vlan (ezeap-uam): UNSUPPORTED";
const IO_OCTETS_UNSUPPORTED =
  "CAPTIVE_PORTAL_ARCHITECTURE.md §3.4 reply table row 'ChilliSpot-Max-Input/Output-Octets(+Gigawords)' (T: no)";
const DISCONNECT_RDT =
  "CAPTIVE_PORTAL_ARCHITECTURE.md §3.5 (T): no RADIUS DAS in uspot; hostapd `coa` ubus notify → client_kick (VERIFIED source), no Acct-Stop on this path; hostapd.c side of the hook on the 25.12 build UNKNOWN → REQUIRES DEVICE TEST; AAA_ARCHITECTURE.md §6 row 'EZEAP uspot (TIP fork)'";

/** Source references back-filled from PHASE2_VALIDATION.md V-rows (rule V10). */
const RATE_SRC = sourced(RATE_VERIFIED, [SRC.V052, SRC.V053_T]);
const QUOTA_SRC = sourced(QUOTA_VERIFIED, [SRC.V054_T]);
const TIMEOUT_SRC = sourced(TIMEOUT_VERIFIED, [SRC.V050_T]);
const IDLE_SRC = sourced(IDLE_VERIFIED, [SRC.V050_T]);
const INTERIM_SRC = sourced(INTERIM_VERIFIED, [SRC.V051_T]);
const CLASS_SRC = sourced(CLASS_VERIFIED, [SRC.V056_T]);
const VLAN_UNSUP_SRC = sourced(VLAN_UNSUPPORTED, [SRC.V055_T]);
const IO_OCTETS_UNSUP_SRC = sourced(IO_OCTETS_UNSUPPORTED, [SRC.V054_T]);

export const capabilities: AdapterCapabilities = {
  key: 'ezeap-uam',
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
    // Device test 2026-10-16 11:02Z (AP1832, D-078): Calling-Station-Id alone is answered with
    // CoA-NAK Error-Cause=Missing-Attribute — hostapd's DAS wants a session identity before it
    // matches a station. User-Name first (what hostapd saw at authentication), then the MAC.
    identifyBy: ['User-Name', 'Calling-Station-Id'],
    acctStopEmitted: false,
    evidence: DISCONNECT_RDT,
    evidenceLevel: 'DOCUMENTED',
    note: 'EZECLOUD must close the session itself after Disconnect-ACK (no Acct-Stop, A4 §3.5 / POLICY_ENGINE.md §2.6)',
  },
  coaChange: {
    status: 'UNSUPPORTED',
    changeable: [],
    evidenceLevel: 'VERIFIED_FROM_SOURCE',
    evidenceRefs: [SRC.V059],
    evidence:
      'CAPTIVE_PORTAL_ARCHITECTURE.md §7.4 uspot-uam CoA: attribute changes are not applied by T → re-authentication is the only way to change a live rate; POLICY_ENGINE.md §3.1 row coa_change (ezeap-uam): UNSUPPORTED',
  },
  macAuth: {
    status: 'VERIFIED_SUPPORTED',
    evidence: 'CAPTIVE_PORTAL_ARCHITECTURE.md §3.6 MAC-auth (T handler.uc L22-37)',
    evidenceLevel: 'VERIFIED_FROM_SOURCE',
    evidenceRefs: [SRC.V061_T],
    usernameRule:
      'User-Name = formatted MAC + mac_suffix; User-Password = mac_passwd || formatted MAC; Service-Type = Call-Check',
  },
  fields: fieldTable([
    decl('download_rate_kbps', 'VERIFIED_SUPPORTED', 'VERIFIED_FROM_SOURCE', RATE_SRC, RATE_NOTE),
    decl('upload_rate_kbps', 'VERIFIED_SUPPORTED', 'VERIFIED_FROM_SOURCE', RATE_SRC, RATE_NOTE),
    decl('burst_download_kbps', 'UNSUPPORTED', 'VERIFIED_FROM_SOURCE', EV_SOURCED.burstAbsent),
    decl('burst_upload_kbps', 'UNSUPPORTED', 'VERIFIED_FROM_SOURCE', EV_SOURCED.burstAbsent),
    decl('burst_duration_s', 'UNSUPPORTED', 'VERIFIED_FROM_SOURCE', EV_SOURCED.burstAbsent),
    decl('quota_daily_bytes', 'VERIFIED_SUPPORTED', 'VERIFIED_FROM_SOURCE', QUOTA_SRC, QUOTA_NOTE),
    decl('quota_weekly_bytes', 'VERIFIED_SUPPORTED', 'VERIFIED_FROM_SOURCE', QUOTA_SRC, QUOTA_NOTE),
    decl(
      'quota_monthly_bytes',
      'VERIFIED_SUPPORTED',
      'VERIFIED_FROM_SOURCE',
      QUOTA_SRC,
      QUOTA_NOTE,
    ),
    decl('quota_total_bytes', 'VERIFIED_SUPPORTED', 'VERIFIED_FROM_SOURCE', QUOTA_SRC, QUOTA_NOTE),
    decl('session_timeout_s', 'VERIFIED_SUPPORTED', 'VERIFIED_FROM_SOURCE', TIMEOUT_SRC),
    decl('idle_timeout_s', 'VERIFIED_SUPPORTED', 'VERIFIED_FROM_SOURCE', IDLE_SRC),
    decl('max_concurrent_sessions', 'ECLOUD_SIDE_ONLY', 'DOCUMENTED', EV.concurrencyEcloudSide),
    decl('max_devices', 'ECLOUD_SIDE_ONLY', 'DOCUMENTED', EV.concurrencyEcloudSide),
    decl('valid_from', 'ECLOUD_SIDE_ONLY', 'DOCUMENTED', EV.validityEcloudSide),
    decl('valid_until', 'ECLOUD_SIDE_ONLY', 'DOCUMENTED', EV.validityEcloudSide),
    decl('voucher_validity', 'ECLOUD_SIDE_ONLY', 'DOCUMENTED', EV.voucherEcloudSide),
    decl('schedule_id', 'ECLOUD_SIDE_ONLY', 'DOCUMENTED', EV.scheduleEcloudSide),
    decl('vlan_id', 'UNSUPPORTED', 'VERIFIED_FROM_SOURCE', VLAN_UNSUP_SRC),
  ]),
  attributes: attributeTable([
    attr(
      'WISPr-Bandwidth-Max-Down',
      'VERIFIED_SUPPORTED',
      'VERIFIED_FROM_SOURCE',
      RATE_SRC,
      'WISPr',
      'bit/s',
    ),
    attr(
      'WISPr-Bandwidth-Max-Up',
      'VERIFIED_SUPPORTED',
      'VERIFIED_FROM_SOURCE',
      RATE_SRC,
      'WISPr',
      'bit/s',
    ),
    attr(
      'ChilliSpot-Bandwidth-Max-Down',
      'VERIFIED_SUPPORTED',
      'VERIFIED_FROM_SOURCE',
      RATE_SRC,
      'ChilliSpot',
      'kbit/s (×1000 in uspot)',
    ),
    attr(
      'ChilliSpot-Bandwidth-Max-Up',
      'VERIFIED_SUPPORTED',
      'VERIFIED_FROM_SOURCE',
      RATE_SRC,
      'ChilliSpot',
      'kbit/s (×1000 in uspot)',
    ),
    attr(
      'ChilliSpot-Max-Total-Octets',
      'VERIFIED_SUPPORTED',
      'VERIFIED_FROM_SOURCE',
      QUOTA_SRC,
      'ChilliSpot',
      '32-bit; behaviour at 4294967295 REQUIRES DEVICE TEST (POLICY_ENGINE.md §9.3 item 2)',
    ),
    attr(
      'ChilliSpot-Max-Total-Gigawords',
      'UNSUPPORTED',
      'VERIFIED_FROM_SOURCE',
      IO_OCTETS_UNSUP_SRC,
      'ChilliSpot',
      'T honours the 32-bit total only',
    ),
    attr(
      'ChilliSpot-Max-Input-Octets',
      'UNSUPPORTED',
      'VERIFIED_FROM_SOURCE',
      IO_OCTETS_UNSUP_SRC,
      'ChilliSpot',
    ),
    attr(
      'ChilliSpot-Max-Output-Octets',
      'UNSUPPORTED',
      'VERIFIED_FROM_SOURCE',
      IO_OCTETS_UNSUP_SRC,
      'ChilliSpot',
    ),
    attr('Session-Timeout', 'VERIFIED_SUPPORTED', 'VERIFIED_FROM_SOURCE', TIMEOUT_SRC),
    attr('Idle-Timeout', 'VERIFIED_SUPPORTED', 'VERIFIED_FROM_SOURCE', IDLE_SRC),
    attr(
      'Acct-Interim-Interval',
      'VERIFIED_SUPPORTED',
      'VERIFIED_FROM_SOURCE',
      INTERIM_SRC,
      undefined,
      'honoured only if NAS acct-interval unset (A4 §3.4); renderer default injection REQUIRES DEVICE TEST (A4 §10 item 5)',
    ),
    attr('Class', 'VERIFIED_SUPPORTED', 'VERIFIED_FROM_SOURCE', CLASS_SRC),
  ]),
};

export const adapter: NasAdapter = createAdapter(capabilities, {
  disconnectMandatory: ['Calling-Station-Id'],
  // A CoA-Request, not a Disconnect-Request: TIP hostapd raises the ubus `coa` event (which
  // uspot answers by removing the captive session) from hostapd_das_coa only; its Disconnect
  // handler deauthenticates the station and leaves the uspot session authorized, so the client
  // re-associates straight back onto the internet. No NAS-Identifier: the captive BSS carries
  // none. User-Name + Calling-Station-Id: the MAC alone drew Missing-Attribute on the device.
  disconnectPacket: 'coa',
  // hostapd's CoA parser (radius_das.c, CONFIG_HS20) answers CoA-NAK Error-Cause=Missing-Attribute
  // ("No supported authorization change attribute") unless the request carries the WFA HS2.0
  // T-C-Filtering VSA (vendor 40808, type 9); only then does it reach hostapd_das_coa and the ubus
  // hook uspot answers. Value 0 = no T&C filtering, also accepted on the non-ubus path. Raw form:
  // the worker's radclient dictionary has no dictionary.wfa. Device test AP1832 2026-10-16 11:02Z:
  // three NAKs without it (session_actions 01a14460…, 01a14461…).
  disconnectExtraAttributes: [{ name: 'Attr-26.40808.9', value: '0x00000000' }],
  disconnectNote:
    'Send a CoA-Request (not Disconnect) to the hostapd DAS of the captive SSID (ssid.radius.dynamic-authorization) identified by User-Name and Calling-Station-Id; hostapd hands it to uspot over ubus (coa) which removes the session; expect CoA-ACK; EZECLOUD closes the session (no Acct-Stop). REQUIRES DEVICE TEST.',
});
