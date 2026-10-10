import { describe, expect, it } from 'vitest';
import {
  ADAPTER_FIELD_STATUSES,
  POLICY_FIELDS,
  type AdapterFieldStatus,
  type PolicyField,
} from '@ecloud/shared';
import { ADAPTER_KEYS, type AdapterKey } from '@ecloud/policy-engine';
import { listCapabilities } from './registry.js';

/**
 * VERIFIED_SUPPORTED sets per adapter, transcribed from POLICY_ENGINE.md §3.1 (VERIFIED rows) and
 * the cited NETWORK_INTEGRATION.md §2 / CAPTIVE_PORTAL_ARCHITECTURE.md §3–§6 rows. Anything not
 * listed here must not be VERIFIED_SUPPORTED (brief rule 3, D-028).
 */
const EXPECTED_VERIFIED: Record<AdapterKey, PolicyField[]> = {
  'openwifi-hostapd-radius': [],
  'openwifi-uspot-uam': [
    'download_rate_kbps',
    'upload_rate_kbps',
    'quota_daily_bytes',
    'quota_monthly_bytes',
    'quota_total_bytes',
    'session_timeout_s',
    'idle_timeout_s',
  ],
  'uspot-upstream-uam': [
    'download_rate_kbps',
    'upload_rate_kbps',
    'quota_daily_bytes',
    'quota_monthly_bytes',
    'quota_total_bytes',
    'session_timeout_s',
    'idle_timeout_s',
  ],
  'coovachilli-uam': [
    'download_rate_kbps',
    'upload_rate_kbps',
    'quota_daily_bytes',
    'quota_monthly_bytes',
    'quota_total_bytes',
    'session_timeout_s',
    'idle_timeout_s',
  ],
  'openwifi-config': [
    'download_rate_kbps',
    'upload_rate_kbps',
    'session_timeout_s',
    'idle_timeout_s',
  ],
  // Cycle A (D-044): vendor-neutral, no vendor source and no lab test → nothing VERIFIED.
  'generic-radius-8021x': [],
  // Cycle C (D-044): post-back family, no vendor source and no lab test → nothing VERIFIED.
  'external-portal-postback': [],
};

/** Full per-field status table (the enforceability preview source), for cross-checking. */
const EXPECTED_STATUS: Record<AdapterKey, Partial<Record<PolicyField, AdapterFieldStatus>>> = {
  'openwifi-hostapd-radius': {
    download_rate_kbps: 'REQUIRES_DEVICE_TEST',
    upload_rate_kbps: 'REQUIRES_DEVICE_TEST',
    burst_download_kbps: 'UNSUPPORTED',
    quota_daily_bytes: 'UNSUPPORTED',
    session_timeout_s: 'REQUIRES_DEVICE_TEST',
    idle_timeout_s: 'REQUIRES_DEVICE_TEST',
    max_devices: 'ECLOUD_SIDE_ONLY',
    schedule_id: 'ECLOUD_SIDE_ONLY',
    vlan_id: 'REQUIRES_DEVICE_TEST',
  },
  'openwifi-uspot-uam': {
    burst_upload_kbps: 'UNSUPPORTED',
    vlan_id: 'UNSUPPORTED',
    max_concurrent_sessions: 'ECLOUD_SIDE_ONLY',
    voucher_validity: 'ECLOUD_SIDE_ONLY',
  },
  'uspot-upstream-uam': {
    burst_duration_s: 'UNSUPPORTED',
    vlan_id: 'UNSUPPORTED',
    valid_until: 'ECLOUD_SIDE_ONLY',
  },
  'coovachilli-uam': {
    vlan_id: 'REQUIRES_DEVICE_TEST',
    burst_download_kbps: 'UNSUPPORTED',
    valid_from: 'ECLOUD_SIDE_ONLY',
  },
  'openwifi-config': {
    quota_daily_bytes: 'UNSUPPORTED',
    max_devices: 'UNSUPPORTED',
    schedule_id: 'UNSUPPORTED',
    vlan_id: 'REQUIRES_DEVICE_TEST',
    burst_upload_kbps: 'UNSUPPORTED',
  },
  'generic-radius-8021x': {
    download_rate_kbps: 'REQUIRES_DEVICE_TEST',
    upload_rate_kbps: 'REQUIRES_DEVICE_TEST',
    burst_download_kbps: 'UNSUPPORTED',
    quota_total_bytes: 'UNSUPPORTED',
    session_timeout_s: 'REQUIRES_DEVICE_TEST',
    idle_timeout_s: 'REQUIRES_DEVICE_TEST',
    max_concurrent_sessions: 'ECLOUD_SIDE_ONLY',
    valid_until: 'ECLOUD_SIDE_ONLY',
    schedule_id: 'ECLOUD_SIDE_ONLY',
    vlan_id: 'REQUIRES_DEVICE_TEST',
  },
  // Cycle C: no rate / quota / VLAN attribute is emitted (never shown as device-enforced).
  'external-portal-postback': {
    download_rate_kbps: 'UNSUPPORTED',
    upload_rate_kbps: 'UNSUPPORTED',
    quota_total_bytes: 'UNSUPPORTED',
    session_timeout_s: 'REQUIRES_DEVICE_TEST',
    idle_timeout_s: 'REQUIRES_DEVICE_TEST',
    max_concurrent_sessions: 'ECLOUD_SIDE_ONLY',
    valid_until: 'ECLOUD_SIDE_ONLY',
    vlan_id: 'UNSUPPORTED',
  },
};

/** Attribute names exactly as in the FreeRADIUS dictionaries (AAA_ARCHITECTURE.md §4.3) plus the Gigawords additions. */
const KNOWN_ATTRIBUTES = new Set([
  'WISPr-Bandwidth-Max-Down',
  'WISPr-Bandwidth-Max-Up',
  'WISPr-Session-Terminate-Time',
  'WISPr-Redirection-URL',
  'ChilliSpot-Bandwidth-Max-Down',
  'ChilliSpot-Bandwidth-Max-Up',
  'ChilliSpot-Max-Total-Octets',
  'ChilliSpot-Max-Input-Octets',
  'ChilliSpot-Max-Output-Octets',
  'ChilliSpot-Max-Total-Gigawords',
  'ChilliSpot-Max-Input-Gigawords',
  'ChilliSpot-Max-Output-Gigawords',
  'CoovaChilli-Bandwidth-Max-Down',
  'CoovaChilli-Bandwidth-Max-Up',
  'CoovaChilli-Max-Total-Octets',
  'CoovaChilli-Max-Input-Octets',
  'CoovaChilli-Max-Output-Octets',
  'CoovaChilli-Max-Total-Gigawords',
  'CoovaChilli-Max-Input-Gigawords',
  'CoovaChilli-Max-Output-Gigawords',
  'CoovaChilli-VLAN-Id',
  'CoovaChilli-Session-State',
  'Session-Timeout',
  'Idle-Timeout',
  'Acct-Interim-Interval',
  'Class',
  'Tunnel-Type',
  'Tunnel-Medium-Type',
  'Tunnel-Private-Group-Id',
]);

const DOC_CITATION =
  /(POLICY_ENGINE|NETWORK_INTEGRATION|CAPTIVE_PORTAL_ARCHITECTURE|AAA_ARCHITECTURE|VENDOR_INTEGRATION_RESEARCH)\.md §/;

describe('adapter capability declarations (D-028)', () => {
  const all = listCapabilities();

  it('ships the five adapters of POLICY_ENGINE.md §3 plus generic-radius-8021x (Cycle A)', () => {
    expect(all.map((a) => a.key)).toEqual([...ADAPTER_KEYS]);
    expect(ADAPTER_KEYS).toEqual([
      'openwifi-hostapd-radius',
      'openwifi-uspot-uam',
      'uspot-upstream-uam',
      'coovachilli-uam',
      'openwifi-config',
      'generic-radius-8021x',
      'external-portal-postback',
    ]);
  });

  it('the status enum is exactly the four D-028 states', () => {
    expect([...ADAPTER_FIELD_STATUSES]).toEqual([
      'VERIFIED_SUPPORTED',
      'REQUIRES_DEVICE_TEST',
      'UNSUPPORTED',
      'ECLOUD_SIDE_ONLY',
    ]);
  });

  it.each(all.map((a) => [a.key, a] as const))(
    '%s declares every POLICY_FIELDS entry exactly once with a valid status and cited evidence',
    (_key, caps) => {
      const declared = Object.keys(caps.fields).sort();
      expect(declared).toEqual([...POLICY_FIELDS].sort());
      for (const field of POLICY_FIELDS) {
        const d = caps.fields[field];
        expect(d.field).toBe(field);
        expect(ADAPTER_FIELD_STATUSES).toContain(d.status);
        expect(d.evidence.trim().length).toBeGreaterThan(20);
        expect(d.evidence).toMatch(DOC_CITATION);
      }
      for (const flag of [caps.disconnect, caps.coaChange, caps.macAuth]) {
        expect(ADAPTER_FIELD_STATUSES).toContain(flag.status);
        expect(flag.evidence).toMatch(DOC_CITATION);
      }
      for (const [name, decl] of Object.entries(caps.attributes)) {
        expect(decl.name).toBe(name);
        expect(KNOWN_ATTRIBUTES.has(name)).toBe(true);
        expect(ADAPTER_FIELD_STATUSES).toContain(decl.status);
        expect(decl.evidence).toMatch(DOC_CITATION);
      }
    },
  );

  it.each(all.map((a) => [a.key, a] as const))(
    '%s marks VERIFIED_SUPPORTED only the fields the Phase 2 docs verified',
    (key, caps) => {
      const verified = POLICY_FIELDS.filter(
        (f) => caps.fields[f].status === 'VERIFIED_SUPPORTED',
      ).sort();
      expect(verified).toEqual([...EXPECTED_VERIFIED[key]].sort());
      for (const [field, status] of Object.entries(EXPECTED_STATUS[key]) as [
        PolicyField,
        AdapterFieldStatus,
      ][]) {
        expect(caps.fields[field].status, `${key}.${field}`).toBe(status);
      }
    },
  );

  it('burst is UNSUPPORTED everywhere; concurrency/validity/schedule are never device-enforced', () => {
    for (const caps of all) {
      for (const f of ['burst_download_kbps', 'burst_upload_kbps', 'burst_duration_s'] as const)
        expect(caps.fields[f].status).toBe('UNSUPPORTED');
      for (const f of [
        'max_concurrent_sessions',
        'max_devices',
        'valid_from',
        'valid_until',
        'voucher_validity',
        'schedule_id',
      ] as const) {
        expect(['ECLOUD_SIDE_ONLY', 'UNSUPPORTED']).toContain(caps.fields[f].status);
      }
    }
  });

  it('Disconnect is REQUIRES_DEVICE_TEST on every RADIUS adapter (D4); VLAN attributes are never VERIFIED', () => {
    for (const caps of all) {
      if (caps.key === 'openwifi-config') {
        expect(caps.disconnect).toMatchObject({ status: 'UNSUPPORTED', target: 'none' });
      } else {
        expect(caps.disconnect.status).toBe('REQUIRES_DEVICE_TEST');
      }
      for (const name of [
        'Tunnel-Type',
        'Tunnel-Medium-Type',
        'Tunnel-Private-Group-Id',
        'CoovaChilli-VLAN-Id',
      ]) {
        const decl = caps.attributes[name];
        if (decl) expect(decl.status).toBe('REQUIRES_DEVICE_TEST');
      }
      expect(caps.fields.vlan_id.status).not.toBe('VERIFIED_SUPPORTED');
    }
  });

  it('rate families, quota attributes and octet widths match §3.1', () => {
    const by = Object.fromEntries(all.map((a) => [a.key, a])) as Record<
      AdapterKey,
      (typeof all)[number]
    >;
    expect(by['openwifi-hostapd-radius'].rateFamilies).toEqual([]);
    expect(by['openwifi-hostapd-radius'].octetWidth).toBeNull();
    expect(
      by['openwifi-uspot-uam'].rateFamilies.map((f) => [f.family, f.unit, f.down, f.up]),
    ).toEqual([
      ['wispr', 'bps', 'WISPr-Bandwidth-Max-Down', 'WISPr-Bandwidth-Max-Up'],
      ['chillispot', 'kbps', 'ChilliSpot-Bandwidth-Max-Down', 'ChilliSpot-Bandwidth-Max-Up'],
    ]);
    expect(by['openwifi-uspot-uam'].octetWidth).toBe(32);
    expect(by['openwifi-uspot-uam'].quotaAttributes).toEqual({
      total: 'ChilliSpot-Max-Total-Octets',
    });
    expect(by['openwifi-uspot-uam'].attributes['ChilliSpot-Max-Input-Octets']?.status).toBe(
      'UNSUPPORTED',
    );
    expect(by['uspot-upstream-uam'].octetWidth).toBe(64);
    expect(by['uspot-upstream-uam'].quotaAttributes.totalGigawords).toBe(
      'ChilliSpot-Max-Total-Gigawords',
    );
    expect(by['coovachilli-uam'].rateFamilies[1]?.down).toBe('CoovaChilli-Bandwidth-Max-Down');
    expect(by['coovachilli-uam'].quotaAttributes.totalGigawords).toBe(
      'CoovaChilli-Max-Total-Gigawords',
    );
    expect(by['coovachilli-uam'].octetWidth).toBe(64);
    expect(by['openwifi-config'].granularity).toBe('per-ssid');
    expect(by['openwifi-config'].rateUnit).toBe('mbps-int');
    expect(Object.keys(by['openwifi-config'].attributes)).toEqual([]);
    expect(by['openwifi-uspot-uam'].coaChange.status).toBe('UNSUPPORTED');
    // D-006: no adapter may claim verified dynamic policy modification before device tests
    for (const [key, caps] of Object.entries(by)) {
      expect(caps.coaChange.status, `${key}.coaChange`).not.toBe('VERIFIED_SUPPORTED');
      expect(caps.disconnect.status, `${key}.disconnect`).not.toBe('VERIFIED_SUPPORTED');
    }
    expect(by['uspot-upstream-uam'].coaChange.changeable).toEqual([
      'Session-Timeout',
      'Idle-Timeout',
      'Acct-Interim-Interval',
    ]);
    expect(by['openwifi-uspot-uam'].disconnect.acctStopEmitted).toBe(false);
  });
});
