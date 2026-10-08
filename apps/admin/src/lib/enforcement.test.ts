// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  amberFlags,
  formatBound,
  impactSummary,
  isAmberStatus,
  showDeviceEnforced,
  strategyLabel,
  type ImpactPreview,
} from './enforcement';

function impact(over: Partial<ImpactPreview>): ImpactPreview {
  return {
    policy_id: 'p',
    evaluated_sessions: 5,
    affected_sessions: 3,
    by_strategy: { next_reauth: 3 },
    max_apply_latency_s: null,
    session_timeout_cap_s: 1800,
    sessions: [],
    truncated: false,
    ...over,
  };
}

describe('impactSummary', () => {
  it('the P7-B wording: N sessions affected; strategy next_reauth; at most the Session-Timeout cap', () => {
    expect(impactSummary(impact({}))).toBe(
      '3 sessions affected; strategy next_reauth; applies at next login, at most 30 min',
    );
    expect(impactSummary(impact({ affected_sessions: 1, by_strategy: { next_reauth: 1 } }))).toBe(
      '1 session affected; strategy next_reauth; applies at next login, at most 30 min',
    );
  });

  it('prefers the longest expected wait reported by the API over the cap', () => {
    expect(impactSummary(impact({ max_apply_latency_s: 600 }))).toMatch(/at most 10 min$/);
  });

  it('says there is no upper bound when the cap is disabled (0) and no latency is known', () => {
    expect(impactSummary(impact({ session_timeout_cap_s: 0 }))).toBe(
      '3 sessions affected; strategy next_reauth; applies at next login (no Session-Timeout cap configured, so no upper bound)',
    );
  });

  it('zero affected and mixed strategies', () => {
    expect(impactSummary(impact({ affected_sessions: 0, by_strategy: {} }))).toBe(
      'No open sessions affected (5 sessions evaluated).',
    );
    expect(
      impactSummary(impact({ affected_sessions: 4, by_strategy: { next_reauth: 3, none: 1 } })),
    ).toBe(
      '4 sessions affected; strategies 3 next_reauth, 1 none; next_reauth applies at next login, at most 30 min',
    );
  });
});

describe('amber flags and V12 guard', () => {
  it('REQUIRES_DEVICE_TEST, ECLOUD_SIDE_ONLY and unknown statuses are amber', () => {
    expect(isAmberStatus('REQUIRES_DEVICE_TEST')).toBe(true);
    expect(isAmberStatus('ECLOUD_SIDE_ONLY')).toBe(true);
    expect(isAmberStatus('SOMETHING_NEW')).toBe(true);
    expect(isAmberStatus('VERIFIED_SUPPORTED')).toBe(false);
    expect(isAmberStatus('UNSUPPORTED')).toBe(false);
  });

  it('never shows device-enforced for source-verified evidence, even if a payload claims it', () => {
    expect(showDeviceEnforced(true, 'VERIFIED_SUPPORTED', 'VERIFIED_FROM_SOURCE')).toBe(false);
    expect(showDeviceEnforced(true, 'REQUIRES_DEVICE_TEST', 'LAB_VALIDATED')).toBe(false);
    expect(showDeviceEnforced(false, 'VERIFIED_SUPPORTED', 'LAB_VALIDATED')).toBe(false);
    expect(showDeviceEnforced(true, 'VERIFIED_SUPPORTED', 'LAB_VALIDATED')).toBe(true);
  });

  it('amberFlags lists changed fields per adapter, limited to the given adapters', () => {
    const columns = [
      {
        adapter: 'openwifi-uspot-uam',
        fields: [
          { field: 'download_rate_kbps', status: 'REQUIRES_DEVICE_TEST' },
          { field: 'quota_daily_bytes', status: 'ECLOUD_SIDE_ONLY' },
          { field: 'idle_timeout_s', status: 'VERIFIED_SUPPORTED' },
        ],
      },
      {
        adapter: 'coovachilli-uam',
        fields: [{ field: 'download_rate_kbps', status: 'REQUIRES_DEVICE_TEST' }],
      },
    ];
    const fields = ['download_rate_kbps', 'quota_daily_bytes', 'idle_timeout_s'];
    expect(amberFlags(columns, fields).map((f) => `${f.adapter}:${f.field}:${f.status}`)).toEqual([
      'openwifi-uspot-uam:download_rate_kbps:REQUIRES_DEVICE_TEST',
      'openwifi-uspot-uam:quota_daily_bytes:ECLOUD_SIDE_ONLY',
      'coovachilli-uam:download_rate_kbps:REQUIRES_DEVICE_TEST',
    ]);
    expect(amberFlags(columns, fields, ['coovachilli-uam'])).toHaveLength(1);
  });

  it('labels and bounds', () => {
    expect(strategyLabel('next_reauth')).toBe('At next re-authentication');
    expect(strategyLabel('bogus')).toBe('Unknown strategy (bogus)');
    expect(formatBound(45)).toBe('45 s');
    expect(formatBound(1800)).toBe('30 min');
    expect(formatBound(10_800)).toBe('3 h');
  });
});
