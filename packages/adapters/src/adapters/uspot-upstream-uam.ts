/**
 * `uspot-upstream-uam`: f00b4r0 upstream uspot (CAPTIVE_PORTAL_ARCHITECTURE.md §3 "(U)"). Kept
 * for the case EZEAP ships the upstream code base (A4 §0 item 1).
 */
import type { AdapterCapabilities } from '@ecloud/policy-engine';
import { attr, attributeTable, createAdapter, decl, fieldTable } from '../base.js';
import { EV } from '../evidence.js';
import type { NasAdapter } from '../types.js';

const RATE_VERIFIED =
  'CAPTIVE_PORTAL_ARCHITECTURE.md §3.4 reply table rows WISPr-Bandwidth-Max-Up/Down (U: yes), ChilliSpot-Bandwidth-Max-Up/Down (U: yes ×1000); POLICY_ENGINE.md §3.1 row rate_limit (uspot-upstream-uam): VERIFIED DOCS same attrs';
const QUOTA_VERIFIED =
  "CAPTIVE_PORTAL_ARCHITECTURE.md §3.4 reply table rows ChilliSpot-Max-Total-Octets (U: yes + Gigawords) and ChilliSpot-Max-Input/Output-Octets(+Gigawords) (U: yes); NETWORK_INTEGRATION.md §2 row 'Per-session total quota (captive)': upstream README lists ChilliSpot-Max-{Input,Output,Total}-{Octets,Gigawords}";
const QUOTA_NOTE =
  'period counter is ECLOUD-side (usage_counters); remaining emitted as Octets + Gigawords (64-bit). FreeRADIUS dictionary.chillispot lacks Gigawords 21-23 → ECLOUD ships dictionary additions (AAA_ARCHITECTURE.md §4.3, PROPOSED)';
const TIMEOUT_VERIFIED =
  'CAPTIVE_PORTAL_ARCHITECTURE.md §3.4 reply table row Session-Timeout (U: yes); POLICY_ENGINE.md §3.1 row session_timeout (uspot-upstream-uam): VERIFIED DOCS';
const IDLE_VERIFIED =
  'CAPTIVE_PORTAL_ARCHITECTURE.md §3.4 reply table row Idle-Timeout (U: yes); POLICY_ENGINE.md §3.1 row idle_timeout (uspot-upstream-uam): VERIFIED DOCS';
const INTERIM_VERIFIED =
  'CAPTIVE_PORTAL_ARCHITECTURE.md §3.4 reply table row Acct-Interim-Interval (U: same precedence — configured acct_interval overrides)';
const CLASS_VERIFIED =
  'CAPTIVE_PORTAL_ARCHITECTURE.md §3.4 reply table row Class (U: copied); AAA_ARCHITECTURE.md §4.3 row Correlation';
const VLAN_UNSUPPORTED =
  "CAPTIVE_PORTAL_ARCHITECTURE.md §3.4 reply table row 'WISPr-Redirection-URL, Filter-Id, VLAN attrs' (U: no); POLICY_ENGINE.md §3.1 row vlan (uspot-upstream-uam): UNSUPPORTED";
const DISCONNECT_RDT =
  'CAPTIVE_PORTAL_ARCHITECTURE.md §3.5 (U): src/radius-das.c UDP DAS on das_port 3799 (Disconnect + CoA), identifies by User-Name, NAS-IP-Address, NAS-Identifier, Framed-IP-Address, Called/Calling-Station-Id, Acct-Session-Id, CUI; not reachable through the uCentral schema (no das_secret key) → REQUIRES DEVICE TEST; AAA_ARCHITECTURE.md §6 row "uspot upstream"';

export const capabilities: AdapterCapabilities = {
  key: 'uspot-upstream-uam',
  version: '0.1.0',
  portalType: 'uam-chillispot+capport',
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
  quotaAttributes: {
    total: 'ChilliSpot-Max-Total-Octets',
    input: 'ChilliSpot-Max-Input-Octets',
    output: 'ChilliSpot-Max-Output-Octets',
    totalGigawords: 'ChilliSpot-Max-Total-Gigawords',
    inputGigawords: 'ChilliSpot-Max-Input-Gigawords',
    outputGigawords: 'ChilliSpot-Max-Output-Gigawords',
  },
  octetWidth: 64,
  sessionTimeoutAttr: 'Session-Timeout',
  idleTimeoutAttr: 'Idle-Timeout',
  interimIntervalAttr: 'Acct-Interim-Interval',
  vlanAttrs: [],
  classAttr: 'Class',
  disconnect: {
    status: 'REQUIRES_DEVICE_TEST',
    target: 'uspot-das',
    identifyBy: [
      'User-Name',
      'NAS-IP-Address',
      'NAS-Identifier',
      'Framed-IP-Address',
      'Calling-Station-Id',
      'Acct-Session-Id',
    ],
    acctStopEmitted: true,
    evidence: DISCONNECT_RDT,
    note: 'NAKs on any unsupported attribute incl. Message-Authenticator, Event-Timestamp, Service-Type, VSAs (A4 §3.5)',
  },
  coaChange: {
    status: 'REQUIRES_DEVICE_TEST',
    changeable: ['Session-Timeout', 'Idle-Timeout', 'Acct-Interim-Interval'],
    evidence:
      'CAPTIVE_PORTAL_ARCHITECTURE.md §3.5 (U): CoA may change Session-Timeout, Idle-Timeout, Acct-Interim-Interval; NAKs on VSAs; POLICY_ENGINE.md §3.1 row coa_change (uspot-upstream-uam): REQUIRES DEVICE TEST',
  },
  macAuth: {
    status: 'VERIFIED_SUPPORTED',
    evidence:
      'CAPTIVE_PORTAL_ARCHITECTURE.md §3.6 MAC-auth: (U) same via client_auth without username',
    usernameRule: 'User-Name = formatted MAC (+ mac_suffix); Service-Type = Call-Check',
  },
  fields: fieldTable([
    decl(
      'download_rate_kbps',
      'VERIFIED_SUPPORTED',
      RATE_VERIFIED,
      'emit one family only (POLICY_ENGINE.md §4.1)',
    ),
    decl(
      'upload_rate_kbps',
      'VERIFIED_SUPPORTED',
      RATE_VERIFIED,
      'emit one family only (POLICY_ENGINE.md §4.1)',
    ),
    decl('burst_download_kbps', 'UNSUPPORTED', EV.burstRadius),
    decl('burst_upload_kbps', 'UNSUPPORTED', EV.burstRadius),
    decl('burst_duration_s', 'UNSUPPORTED', EV.burstRadius),
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
      'kbit/s',
    ),
    attr(
      'ChilliSpot-Bandwidth-Max-Up',
      'VERIFIED_SUPPORTED',
      RATE_VERIFIED,
      'ChilliSpot',
      'kbit/s',
    ),
    attr('ChilliSpot-Max-Total-Octets', 'VERIFIED_SUPPORTED', QUOTA_VERIFIED, 'ChilliSpot'),
    attr(
      'ChilliSpot-Max-Total-Gigawords',
      'VERIFIED_SUPPORTED',
      QUOTA_VERIFIED,
      'ChilliSpot',
      'attribute 23 missing from FreeRADIUS dictionary.chillispot (AAA_ARCHITECTURE.md §4.3)',
    ),
    attr('ChilliSpot-Max-Input-Octets', 'VERIFIED_SUPPORTED', QUOTA_VERIFIED, 'ChilliSpot'),
    attr('ChilliSpot-Max-Input-Gigawords', 'VERIFIED_SUPPORTED', QUOTA_VERIFIED, 'ChilliSpot'),
    attr('ChilliSpot-Max-Output-Octets', 'VERIFIED_SUPPORTED', QUOTA_VERIFIED, 'ChilliSpot'),
    attr('ChilliSpot-Max-Output-Gigawords', 'VERIFIED_SUPPORTED', QUOTA_VERIFIED, 'ChilliSpot'),
    attr('Session-Timeout', 'VERIFIED_SUPPORTED', TIMEOUT_VERIFIED),
    attr('Idle-Timeout', 'VERIFIED_SUPPORTED', IDLE_VERIFIED),
    attr(
      'Acct-Interim-Interval',
      'VERIFIED_SUPPORTED',
      INTERIM_VERIFIED,
      undefined,
      'honoured only if NAS acct-interval unset (A4 §3.4)',
    ),
    attr('Class', 'VERIFIED_SUPPORTED', CLASS_VERIFIED),
  ]),
};

export const adapter: NasAdapter = createAdapter(capabilities, {
  disconnectMandatory: [],
  disconnectNote:
    'Any of the identification attributes selects the session; the DAS port/secret cannot be rendered via uCentral today. REQUIRES DEVICE TEST.',
});
