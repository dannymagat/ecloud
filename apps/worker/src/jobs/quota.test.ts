import { describe, expect, it } from 'vitest';
import { decideEnforcement, describeAdapterDisconnect, evaluateQuota } from './quota.js';

describe('evaluateQuota', () => {
  const limits = { daily: 1000, monthly: 10_000, total: null };
  it('returns no breach below every limit', () => {
    expect(evaluateQuota(limits, { daily: { bytesIn: 400, bytesOut: 599 } })).toEqual([]);
  });
  it('breaches when in + out reaches the limit (>=)', () => {
    expect(evaluateQuota(limits, { daily: { bytesIn: 400, bytesOut: 600 } })).toEqual([
      { period: 'daily', limit: 1000, used: 1000 },
    ]);
  });
  it('reports every breached period and ignores unset / non-positive limits', () => {
    const usage = {
      daily: { bytesIn: 5000, bytesOut: 0 },
      monthly: { bytesIn: 6000, bytesOut: 6000 },
      total: { bytesIn: 1e12, bytesOut: 0 },
    };
    expect(evaluateQuota(limits, usage).map((b) => b.period)).toEqual(['daily', 'monthly']);
    expect(evaluateQuota({ daily: 0, monthly: null, total: null }, usage)).toEqual([]);
  });
  it('treats a missing counter row as zero usage', () => {
    expect(evaluateQuota({ daily: 1, monthly: null, total: null }, {})).toEqual([]);
  });
});

describe('decideEnforcement (D-006)', () => {
  const chilli = describeAdapterDisconnect('coovachilli-uam');
  it('never disconnects while ECLOUD_COA_ENABLED is false', () => {
    for (const key of [
      'coovachilli-uam',
      'openwifi-uspot-uam',
      'openwifi-hostapd-radius',
      'uspot-upstream-uam',
    ]) {
      expect(
        decideEnforcement({
          coaEnabled: false,
          disconnect: describeAdapterDisconnect(key),
          nasCoaSupported: null,
        }),
      ).toEqual({ action: 'pending', reason: 'coa_disabled' });
    }
  });
  it('disconnects when enabled and the adapter declares a Disconnect target', () => {
    expect(chilli?.status).toBe('REQUIRES_DEVICE_TEST');
    expect(
      decideEnforcement({ coaEnabled: true, disconnect: chilli, nasCoaSupported: null }),
    ).toEqual({
      action: 'disconnect',
    });
  });
  it('stays pending for adapters without Disconnect, NAS opt-out or unknown adapters', () => {
    expect(
      decideEnforcement({
        coaEnabled: true,
        disconnect: describeAdapterDisconnect('openwifi-config'),
        nasCoaSupported: null,
      }),
    ).toEqual({ action: 'pending', reason: 'disconnect_unsupported' });
    expect(
      decideEnforcement({ coaEnabled: true, disconnect: chilli, nasCoaSupported: false }),
    ).toEqual({
      action: 'pending',
      reason: 'nas_coa_unsupported',
    });
    expect(describeAdapterDisconnect('nope')).toBeNull();
    expect(
      decideEnforcement({ coaEnabled: true, disconnect: null, nasCoaSupported: true }),
    ).toEqual({
      action: 'pending',
      reason: 'unknown_adapter',
    });
    expect(
      decideEnforcement({
        coaEnabled: true,
        disconnect: { status: 'ECLOUD_SIDE_ONLY', target: 'coaport' },
        nasCoaSupported: true,
      }),
    ).toEqual({ action: 'pending', reason: 'disconnect_unsupported' });
  });
});

describe('adapter key aliases (migration 011 keys)', () => {
  it('maps unambiguous DB keys and leaves uspot / generic_radius unmapped', () => {
    expect(describeAdapterDisconnect('coovachilli')?.target).toBe('coaport');
    expect(describeAdapterDisconnect('openwifi_ucentral')?.target).toBe('hostapd-das');
    expect(describeAdapterDisconnect('uspot')).toBeNull();
    expect(describeAdapterDisconnect('generic_radius')).toBeNull();
  });
});
