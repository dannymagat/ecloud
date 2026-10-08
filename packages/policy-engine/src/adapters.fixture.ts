/**
 * Synthetic adapter records for unit tests of the translation layer. They are NOT device claims;
 * the real, evidence-backed declarations live in `@ecloud/adapters`.
 */
import {
  POLICY_FIELDS,
  type AdapterFieldDeclaration,
  type AdapterFieldStatus,
  type EvidenceLevel,
  type PolicyField,
} from '@ecloud/shared';
import type { AdapterCapabilities, AttributeDeclaration } from './capabilities.js';

const EV = 'fixture (test only)';
/** Fixture evidence level (input-only addition, plan §8.1 AC2). */
const lvl = (status: AdapterFieldStatus): EvidenceLevel =>
  status === 'VERIFIED_SUPPORTED' ? 'VERIFIED_FROM_SOURCE' : 'DOCUMENTED';

function fields(
  overrides: Partial<Record<PolicyField, AdapterFieldStatus>>,
  base: AdapterFieldStatus,
): Record<PolicyField, AdapterFieldDeclaration> {
  const out = {} as Record<PolicyField, AdapterFieldDeclaration>;
  for (const f of POLICY_FIELDS) {
    const status = overrides[f] ?? base;
    out[f] = { field: f, status, evidence: EV, evidenceLevel: lvl(status) };
  }
  return out;
}

function attrs(
  list: [string, AdapterFieldStatus, AttributeDeclaration['vendor']?][],
): Record<string, AttributeDeclaration> {
  const out: Record<string, AttributeDeclaration> = {};
  for (const [name, status, vendor] of list)
    out[name] = vendor
      ? { name, status, evidence: EV, evidenceLevel: lvl(status), vendor }
      : { name, status, evidence: EV, evidenceLevel: lvl(status) };
  return out;
}

/** Captive-portal-like adapter: verified rates / 32-bit quota / timers / Class; VLAN untested. */
export const captive32: AdapterCapabilities = {
  key: 'openwifi-uspot-uam',
  version: 'fixture',
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
  vlanAttrs: ['Tunnel-Type', 'Tunnel-Medium-Type', 'Tunnel-Private-Group-Id'],
  classAttr: 'Class',
  disconnect: {
    status: 'REQUIRES_DEVICE_TEST',
    target: 'hostapd-das',
    identifyBy: ['Calling-Station-Id'],
    acctStopEmitted: false,
    evidence: EV,
    evidenceLevel: 'DOCUMENTED',
  },
  coaChange: { status: 'UNSUPPORTED', changeable: [], evidence: EV, evidenceLevel: 'DOCUMENTED' },
  macAuth: { status: 'VERIFIED_SUPPORTED', evidence: EV, evidenceLevel: 'VERIFIED_FROM_SOURCE' },
  fields: fields(
    {
      download_rate_kbps: 'VERIFIED_SUPPORTED',
      upload_rate_kbps: 'VERIFIED_SUPPORTED',
      burst_download_kbps: 'UNSUPPORTED',
      burst_upload_kbps: 'UNSUPPORTED',
      burst_duration_s: 'UNSUPPORTED',
      quota_daily_bytes: 'VERIFIED_SUPPORTED',
      quota_monthly_bytes: 'VERIFIED_SUPPORTED',
      quota_total_bytes: 'VERIFIED_SUPPORTED',
      session_timeout_s: 'VERIFIED_SUPPORTED',
      idle_timeout_s: 'VERIFIED_SUPPORTED',
      vlan_id: 'REQUIRES_DEVICE_TEST',
    },
    'ECLOUD_SIDE_ONLY',
  ),
  attributes: attrs([
    ['WISPr-Bandwidth-Max-Down', 'VERIFIED_SUPPORTED', 'WISPr'],
    ['WISPr-Bandwidth-Max-Up', 'VERIFIED_SUPPORTED', 'WISPr'],
    ['ChilliSpot-Bandwidth-Max-Down', 'VERIFIED_SUPPORTED', 'ChilliSpot'],
    ['ChilliSpot-Bandwidth-Max-Up', 'VERIFIED_SUPPORTED', 'ChilliSpot'],
    ['ChilliSpot-Max-Total-Octets', 'VERIFIED_SUPPORTED', 'ChilliSpot'],
    ['Session-Timeout', 'VERIFIED_SUPPORTED'],
    ['Idle-Timeout', 'VERIFIED_SUPPORTED'],
    ['Acct-Interim-Interval', 'VERIFIED_SUPPORTED'],
    ['Class', 'VERIFIED_SUPPORTED'],
    ['Tunnel-Type', 'REQUIRES_DEVICE_TEST'],
    ['Tunnel-Medium-Type', 'REQUIRES_DEVICE_TEST'],
    ['Tunnel-Private-Group-Id', 'REQUIRES_DEVICE_TEST'],
  ]),
};

/** 64-bit (Octets + Gigawords) variant. */
export const captive64: AdapterCapabilities = {
  ...captive32,
  key: 'uspot-upstream-uam',
  quotaAttributes: {
    total: 'ChilliSpot-Max-Total-Octets',
    totalGigawords: 'ChilliSpot-Max-Total-Gigawords',
  },
  octetWidth: 64,
  attributes: {
    ...captive32.attributes,
    ...attrs([['ChilliSpot-Max-Total-Gigawords', 'VERIFIED_SUPPORTED', 'ChilliSpot']]),
  },
};

/** hostapd-like adapter: everything per-client is REQUIRES_DEVICE_TEST, no octet attribute. */
export const untested: AdapterCapabilities = {
  ...captive32,
  key: 'openwifi-hostapd-radius',
  portalType: 'none-8021x-macauth',
  rateUnit: null,
  rateFamilies: [],
  quotaAttributes: {},
  octetWidth: null,
  fields: fields(
    {
      download_rate_kbps: 'REQUIRES_DEVICE_TEST',
      upload_rate_kbps: 'REQUIRES_DEVICE_TEST',
      burst_download_kbps: 'UNSUPPORTED',
      burst_upload_kbps: 'UNSUPPORTED',
      burst_duration_s: 'UNSUPPORTED',
      quota_daily_bytes: 'UNSUPPORTED',
      quota_monthly_bytes: 'UNSUPPORTED',
      quota_total_bytes: 'UNSUPPORTED',
      session_timeout_s: 'REQUIRES_DEVICE_TEST',
      idle_timeout_s: 'REQUIRES_DEVICE_TEST',
      vlan_id: 'REQUIRES_DEVICE_TEST',
    },
    'ECLOUD_SIDE_ONLY',
  ),
  attributes: attrs([
    ['Session-Timeout', 'REQUIRES_DEVICE_TEST'],
    ['Idle-Timeout', 'REQUIRES_DEVICE_TEST'],
    ['Acct-Interim-Interval', 'REQUIRES_DEVICE_TEST'],
    ['Class', 'REQUIRES_DEVICE_TEST'],
    ['Tunnel-Type', 'REQUIRES_DEVICE_TEST'],
    ['Tunnel-Medium-Type', 'REQUIRES_DEVICE_TEST'],
    ['Tunnel-Private-Group-Id', 'REQUIRES_DEVICE_TEST'],
  ]),
};

/** Config-push (per-SSID) adapter. */
export const perSsid: AdapterCapabilities = {
  ...captive32,
  key: 'openwifi-config',
  portalType: 'config-only',
  granularity: 'per-ssid',
  rateUnit: 'mbps-int',
  rateFamilies: [],
  quotaAttributes: {},
  octetWidth: null,
  sessionTimeoutAttr: null,
  idleTimeoutAttr: null,
  interimIntervalAttr: null,
  vlanAttrs: [],
  classAttr: null,
  fields: fields(
    {
      download_rate_kbps: 'VERIFIED_SUPPORTED',
      upload_rate_kbps: 'VERIFIED_SUPPORTED',
      burst_download_kbps: 'UNSUPPORTED',
      burst_upload_kbps: 'UNSUPPORTED',
      burst_duration_s: 'UNSUPPORTED',
      quota_daily_bytes: 'UNSUPPORTED',
      quota_monthly_bytes: 'UNSUPPORTED',
      quota_total_bytes: 'UNSUPPORTED',
      session_timeout_s: 'VERIFIED_SUPPORTED',
      idle_timeout_s: 'VERIFIED_SUPPORTED',
      vlan_id: 'REQUIRES_DEVICE_TEST',
    },
    'UNSUPPORTED',
  ),
  attributes: {},
};
