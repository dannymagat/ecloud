import { describe, expect, it } from 'vitest';
import {
  ADAPTER_FIELD_STATUSES,
  POLICY_FIELDS,
  POLICY_FIELD_ALIASES,
  isAdapterFieldStatus,
  isPolicyField,
} from './adapter-status.js';

describe('adapter status (D-028)', () => {
  it('has exactly the four owner states', () => {
    expect([...ADAPTER_FIELD_STATUSES]).toEqual([
      'VERIFIED_SUPPORTED',
      'REQUIRES_DEVICE_TEST',
      'UNSUPPORTED',
      'ECLOUD_SIDE_ONLY',
    ]);
    expect(isAdapterFieldStatus('UNSUPPORTED')).toBe(true);
    expect(isAdapterFieldStatus('SUPPORTED')).toBe(false);
  });

  it('lists the POLICY_ENGINE.md §1.1 intent fields once each', () => {
    expect(new Set(POLICY_FIELDS).size).toBe(POLICY_FIELDS.length);
    for (const field of [
      'download_rate_kbps',
      'quota_monthly_bytes',
      'max_devices',
      'vlan_id',
      'schedule_id',
    ]) {
      expect(isPolicyField(field)).toBe(true);
    }
    expect(isPolicyField('max_concurrent_devices')).toBe(false);
    expect(POLICY_FIELD_ALIASES.max_concurrent_devices).toBe('max_devices');
  });
});
