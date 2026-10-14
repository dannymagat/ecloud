import { describe, expect, it } from 'vitest';
import {
  decideEnforcement,
  describeAdapterDisconnect,
  evaluateOnlineTime,
  evaluateQuota,
} from './quota.js';

describe('evaluateQuota', () => {
  const limits = { daily: 1000, weekly: null, monthly: 10_000, total: null };
  it('returns no breach below every limit', () => {
    expect(evaluateQuota(limits, { daily: { bytesIn: 400, bytesOut: 599 } })).toEqual([]);
  });
  it('breaches when in + out reaches the limit (>=)', () => {
    expect(evaluateQuota(limits, { daily: { bytesIn: 400, bytesOut: 600 } })).toEqual([
      { kind: 'data', period: 'daily', limit: 1000, used: 1000 },
    ]);
  });
  it('reports every breached period and ignores unset / non-positive limits', () => {
    const usage = {
      daily: { bytesIn: 5000, bytesOut: 0 },
      monthly: { bytesIn: 6000, bytesOut: 6000 },
      total: { bytesIn: 1e12, bytesOut: 0 },
    };
    expect(evaluateQuota(limits, usage).map((b) => b.period)).toEqual(['daily', 'monthly']);
    expect(
      evaluateQuota({ daily: 0, weekly: null, monthly: null, total: null }, usage),
    ).toEqual([]);
  });
  it('treats a missing counter row as zero usage', () => {
    expect(evaluateQuota({ daily: 1, weekly: null, monthly: null, total: null }, {})).toEqual([]);
  });
});

describe('evaluateOnlineTime (migration 036)', () => {
  const limits = { daily: 7200, weekly: null, monthly: 36_000, total: null };

  it('counts connected seconds, not bytes: a quiet session still spends the allowance', () => {
    const usage = { daily: { bytesIn: 0, bytesOut: 0, sessionTimeS: 7200 } };
    expect(evaluateOnlineTime(limits, usage)).toEqual([
      { kind: 'time', period: 'daily', limit: 7200, used: 7200 },
    ]);
  });

  it('does not breach below the allowance', () => {
    expect(evaluateOnlineTime(limits, { daily: { bytesIn: 0, bytesOut: 0, sessionTimeS: 7199 } }))
      .toEqual([]);
  });

  it('treats a counter row without session time as zero, not as a breach', () => {
    expect(evaluateOnlineTime(limits, { daily: { bytesIn: 9e9, bytesOut: 9e9 } })).toEqual([]);
  });

  it('reports every breached period', () => {
    const usage = {
      daily: { bytesIn: 0, bytesOut: 0, sessionTimeS: 7200 },
      monthly: { bytesIn: 0, bytesOut: 0, sessionTimeS: 40_000 },
    };
    expect(evaluateOnlineTime(limits, usage).map((b) => b.period)).toEqual(['daily', 'monthly']);
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
        // D-035: openwifi-config is SSID configuration, never a NAS adapter
        disconnect: describeAdapterDisconnect('openwifi-config'),
        nasCoaSupported: null,
      }),
    ).toEqual({ action: 'pending', reason: 'unknown_adapter' });
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

describe('NAS adapter_key (D-035, no aliases)', () => {
  it('resolves engine keys only; legacy keys, openwifi-config and NULL have no Disconnect', () => {
    expect(describeAdapterDisconnect('coovachilli-uam')?.target).toBe('coaport');
    expect(describeAdapterDisconnect('openwifi-hostapd-radius')?.target).toBe('hostapd-das');
    expect(describeAdapterDisconnect('coovachilli')).toBeNull();
    expect(describeAdapterDisconnect('openwifi_ucentral')).toBeNull();
    expect(describeAdapterDisconnect('openwifi-config')).toBeNull();
    expect(describeAdapterDisconnect(null)).toBeNull();
  });
});
