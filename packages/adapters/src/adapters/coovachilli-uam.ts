/**
 * `coovachilli-uam`: CoovaChilli routed gateway (EZE gateway precedent). All reply-attribute
 * facts are VERIFIED FROM OFFICIAL DOCUMENTATION (CAPTIVE_PORTAL_ARCHITECTURE.md §4); the live
 * gateway test is still due (POLICY_ENGINE.md §9.3 item 10).
 */
import type { AdapterCapabilities } from '@ecloud/policy-engine';
import { attr, attributeTable, createAdapter, decl, fieldTable } from '../base.js';
import { EV } from '../evidence.js';
import type { NasAdapter } from '../types.js';

const RATE_VERIFIED =
  "CAPTIVE_PORTAL_ARCHITECTURE.md §4 RADIUS bullet: honours WISPr-Bandwidth-Max-Up/Down (bit/s), CoovaChilli-Bandwidth-Max-Up/Down (kbit/s ×1000) (VERIFIED FROM OFFICIAL DOCUMENTATION); §6 row 'Rate attrs'; POLICY_ENGINE.md §3.1 row rate_limit (coovachilli-uam)";
const QUOTA_VERIFIED =
  "CAPTIVE_PORTAL_ARCHITECTURE.md §4 RADIUS bullet: CoovaChilli-Max-Input/Output/Total-Octets + -Gigawords (VERIFIED FROM OFFICIAL DOCUMENTATION); §6 row 'Quota attrs'; POLICY_ENGINE.md §3.1 row quota (coovachilli-uam)";
const QUOTA_NOTE =
  'period counter is ECLOUD-side (usage_counters); remaining emitted as Octets + Gigawords; CoovaChilli-* share vendor id 14559 with ChilliSpot (AAA_ARCHITECTURE.md §4.3 alias dictionary, PROPOSED)';
const TIMEOUT_VERIFIED =
  "CAPTIVE_PORTAL_ARCHITECTURE.md §4 RADIUS bullet: Session-Timeout (also WISPr-Session-Terminate-Time); §6 row 'Timeouts'; POLICY_ENGINE.md §3.1 row session_timeout (coovachilli-uam)";
const IDLE_VERIFIED =
  "CAPTIVE_PORTAL_ARCHITECTURE.md §4 RADIUS bullet: Idle-Timeout; §6 row 'Timeouts'; POLICY_ENGINE.md §3.1 row idle_timeout (coovachilli-uam)";
const INTERIM_VERIFIED =
  "CAPTIVE_PORTAL_ARCHITECTURE.md §4 RADIUS bullet: Acct-Interim-Interval (<60 → ignored); §6 row 'Acct'; POLICY_ENGINE.md §3.1 row interim_interval (coovachilli-uam): honoured if ≥ 60";
const CLASS_VERIFIED =
  'CAPTIVE_PORTAL_ARCHITECTURE.md §4 RADIUS bullet: Class echo; AAA_ARCHITECTURE.md §4.3 row Correlation (chilli: Class echoed)';
const VLAN_RDT =
  'CAPTIVE_PORTAL_ARCHITECTURE.md §7.5 row VLAN: CoovaChilli-VLAN-Id → REQUIRES DEVICE TEST; POLICY_ENGINE.md §3.1 row vlan (coovachilli-uam)';
const DISCONNECT_RDT =
  'CAPTIVE_PORTAL_ARCHITECTURE.md §4 CoA/Disconnect bullet: coaport (default 0 = disabled), source must be a configured RADIUS server unless coanoipcheck, User-Name mandatory, Acct-Session-Id optional (VERIFIED FROM OFFICIAL DOCUMENTATION); gateway test still due (POLICY_ENGINE.md §9.3 item 10, D4) → REQUIRES DEVICE TEST; AAA_ARCHITECTURE.md §6 row CoovaChilli';

export const capabilities: AdapterCapabilities = {
  key: 'coovachilli-uam',
  version: '0.1.0',
  portalType: 'uam-chillispot+wispr+json',
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
      down: 'CoovaChilli-Bandwidth-Max-Down',
      up: 'CoovaChilli-Bandwidth-Max-Up',
      vendor: 'CoovaChilli',
    },
  ],
  quotaAttributes: {
    total: 'CoovaChilli-Max-Total-Octets',
    input: 'CoovaChilli-Max-Input-Octets',
    output: 'CoovaChilli-Max-Output-Octets',
    totalGigawords: 'CoovaChilli-Max-Total-Gigawords',
    inputGigawords: 'CoovaChilli-Max-Input-Gigawords',
    outputGigawords: 'CoovaChilli-Max-Output-Gigawords',
  },
  octetWidth: 64,
  sessionTimeoutAttr: 'Session-Timeout',
  idleTimeoutAttr: 'Idle-Timeout',
  interimIntervalAttr: 'Acct-Interim-Interval',
  vlanAttrs: ['CoovaChilli-VLAN-Id'],
  classAttr: 'Class',
  disconnect: {
    status: 'REQUIRES_DEVICE_TEST',
    target: 'coaport',
    identifyBy: ['User-Name', 'Acct-Session-Id'],
    acctStopEmitted: true,
    evidence: DISCONNECT_RDT,
    note: 'Disconnect terminates with cause Admin-Reset; coaport must be enabled on the gateway (default 0)',
  },
  coaChange: {
    // Owner rule D-006 / D-034 (2026-10-07): CoA, Disconnect and dynamic policy
    // modification stay REQUIRES_DEVICE_TEST until the gateway test (DT-15) passes,
    // even though CoovaChilli documentation describes coaport CoA re-apply.
    status: 'REQUIRES_DEVICE_TEST',
    changeable: [
      'Session-Timeout',
      'Idle-Timeout',
      'Acct-Interim-Interval',
      'WISPr-Bandwidth-Max-Down',
      'WISPr-Bandwidth-Max-Up',
      'CoovaChilli-Bandwidth-Max-Down',
      'CoovaChilli-Bandwidth-Max-Up',
      'CoovaChilli-Max-Total-Octets',
      'CoovaChilli-Max-Total-Gigawords',
      'CoovaChilli-Max-Input-Octets',
      'CoovaChilli-Max-Input-Gigawords',
      'CoovaChilli-Max-Output-Octets',
      'CoovaChilli-Max-Output-Gigawords',
      'CoovaChilli-Session-State',
    ],
    evidence:
      'CAPTIVE_PORTAL_ARCHITECTURE.md §4 CoA/Disconnect bullet: CoA re-applies config_radius_session (timeouts/bandwidth/quota) and honours CoovaChilli-Session-State (VERIFIED FROM OFFICIAL DOCUMENTATION); POLICY_ENGINE.md §3.1 row coa_change (coovachilli-uam): VERIFIED DOCS',
    note: 'live confirmation on the EZE gateway pending (POLICY_ENGINE.md §9.3 item 10); same coaport/source-IP preconditions as Disconnect',
  },
  macAuth: {
    status: 'VERIFIED_SUPPORTED',
    evidence:
      'CAPTIVE_PORTAL_ARCHITECTURE.md §4 MAC auth bullet: macauth, macreauth, macsuffix, macpasswd (default password) (VERIFIED FROM OFFICIAL DOCUMENTATION)',
    usernameRule: 'User-Name = MAC (+ macsuffix); User-Password = macpasswd (default "password")',
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
    decl('vlan_id', 'REQUIRES_DEVICE_TEST', VLAN_RDT),
  ]),
  attributes: attributeTable([
    attr('WISPr-Bandwidth-Max-Down', 'VERIFIED_SUPPORTED', RATE_VERIFIED, 'WISPr', 'bit/s'),
    attr('WISPr-Bandwidth-Max-Up', 'VERIFIED_SUPPORTED', RATE_VERIFIED, 'WISPr', 'bit/s'),
    attr(
      'CoovaChilli-Bandwidth-Max-Down',
      'VERIFIED_SUPPORTED',
      RATE_VERIFIED,
      'CoovaChilli',
      'kbit/s',
    ),
    attr(
      'CoovaChilli-Bandwidth-Max-Up',
      'VERIFIED_SUPPORTED',
      RATE_VERIFIED,
      'CoovaChilli',
      'kbit/s',
    ),
    attr('CoovaChilli-Max-Total-Octets', 'VERIFIED_SUPPORTED', QUOTA_VERIFIED, 'CoovaChilli'),
    attr('CoovaChilli-Max-Total-Gigawords', 'VERIFIED_SUPPORTED', QUOTA_VERIFIED, 'CoovaChilli'),
    attr('CoovaChilli-Max-Input-Octets', 'VERIFIED_SUPPORTED', QUOTA_VERIFIED, 'CoovaChilli'),
    attr('CoovaChilli-Max-Input-Gigawords', 'VERIFIED_SUPPORTED', QUOTA_VERIFIED, 'CoovaChilli'),
    attr('CoovaChilli-Max-Output-Octets', 'VERIFIED_SUPPORTED', QUOTA_VERIFIED, 'CoovaChilli'),
    attr('CoovaChilli-Max-Output-Gigawords', 'VERIFIED_SUPPORTED', QUOTA_VERIFIED, 'CoovaChilli'),
    attr('Session-Timeout', 'VERIFIED_SUPPORTED', TIMEOUT_VERIFIED),
    attr(
      'WISPr-Session-Terminate-Time',
      'VERIFIED_SUPPORTED',
      TIMEOUT_VERIFIED,
      'WISPr',
      'declared; the engine emits Session-Timeout instead',
    ),
    attr('Idle-Timeout', 'VERIFIED_SUPPORTED', IDLE_VERIFIED),
    attr(
      'Acct-Interim-Interval',
      'VERIFIED_SUPPORTED',
      INTERIM_VERIFIED,
      undefined,
      '< 60 ignored by CoovaChilli',
    ),
    attr('Class', 'VERIFIED_SUPPORTED', CLASS_VERIFIED),
    attr('CoovaChilli-VLAN-Id', 'REQUIRES_DEVICE_TEST', VLAN_RDT, 'CoovaChilli'),
    attr(
      'CoovaChilli-Session-State',
      'VERIFIED_SUPPORTED',
      'CAPTIVE_PORTAL_ARCHITECTURE.md §4 CoA/Disconnect bullet: CoA honours CoovaChilli-Session-State Authorized/NotAuthorized',
      'CoovaChilli',
      'CoA only',
    ),
    attr(
      'WISPr-Redirection-URL',
      'VERIFIED_SUPPORTED',
      'CAPTIVE_PORTAL_ARCHITECTURE.md §7.5 row "Redirect after login": WISPr-Redirection-URL (CoovaChilli)',
      'WISPr',
      'declared; not produced by the policy engine',
    ),
  ]),
};

export const adapter: NasAdapter = createAdapter(capabilities, {
  disconnectMandatory: ['User-Name'],
  disconnectNote:
    'User-Name is mandatory; Acct-Session-Id narrows to one session. Source IP must be a configured RADIUS server (or coanoipcheck). REQUIRES DEVICE TEST on the EZE gateway.',
});
