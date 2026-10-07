import { describe, expect, it } from 'vitest';
import { captive32, captive64, perSsid, untested } from './adapters.fixture.js';
import { workedExampleInput } from './resolve.fixture.js';
import { simulate } from './simulate.js';

describe('simulate', () => {
  it('resolves once and returns a per-adapter plan and field table', () => {
    const s = simulate({
      resolution: workedExampleInput(),
      adapters: [captive32, captive64, untested, perSsid],
      translation: { sessionId: 'preview', interimIntervalS: 300, nasAcctIntervalUnset: true },
    });
    expect(s.resolution.decision).toBe('accept');
    expect(s.resolution.trigger).toBe('preview');
    expect(s.capabilitiesUsed).toEqual([
      'openwifi-uspot-uam@fixture',
      'uspot-upstream-uam@fixture',
      'openwifi-hostapd-radius@fixture',
      'openwifi-config@fixture',
    ]);
    expect(s.perAdapter.map((a) => a.adapter)).toEqual([
      'openwifi-uspot-uam',
      'uspot-upstream-uam',
      'openwifi-hostapd-radius',
      'openwifi-config',
    ]);
    const rate = (key: string) =>
      s.perAdapter
        .find((a) => a.adapter === key)
        ?.fieldTable.find((f) => f.field === 'download_rate_kbps');
    expect(rate('openwifi-uspot-uam')?.deviceEnforced).toBe(true);
    expect(rate('openwifi-hostapd-radius')).toMatchObject({
      deviceEnforced: false,
      status: 'REQUIRES_DEVICE_TEST',
      mechanism: 'none',
    });
    expect(rate('openwifi-config')).toMatchObject({
      deviceEnforced: false,
      mechanism: 'none',
      detail: expect.stringContaining('per-SSID') as string,
    });
    expect(s.perAdapter.every((a) => a.fieldTable.length === 17)).toBe(true);
    expect(
      s.perAdapter[0]?.plan?.radiusReplyAttributes.some(
        (a) => a.name === 'Class' && a.value === 'ecloud:preview',
      ),
    ).toBe(true);
  });

  it('keeps an explicit trigger and still translates on a rejected resolution', () => {
    const s = simulate({
      resolution: {
        ...workedExampleInput({ now: new Date('2026-10-06T15:00:00Z') }),
        trigger: 'authorize',
      },
      adapters: [captive32],
    });
    expect(s.resolution.trigger).toBe('authorize');
    expect(s.resolution.decision).toBe('reject');
    expect(s.perAdapter[0]?.plan?.radiusReplyAttributes.map((a) => a.name)).toEqual([
      'WISPr-Bandwidth-Max-Down',
      'WISPr-Bandwidth-Max-Up',
      'Idle-Timeout',
    ]);
  });
});

describe('capability helpers', () => {
  it('read field and attribute statuses', async () => {
    const { attributeStatus, fieldStatus, isVerified } = await import('./capabilities.js');
    expect(fieldStatus(captive32, 'download_rate_kbps')).toBe('VERIFIED_SUPPORTED');
    expect(fieldStatus(untested, 'quota_daily_bytes')).toBe('UNSUPPORTED');
    expect(attributeStatus(captive32, 'Class')).toBe('VERIFIED_SUPPORTED');
    expect(attributeStatus(captive32, 'Filter-Id')).toBeNull();
    expect(isVerified('VERIFIED_SUPPORTED')).toBe(true);
    expect(isVerified('REQUIRES_DEVICE_TEST')).toBe(false);
    expect(isVerified(null)).toBe(false);
  });
});
