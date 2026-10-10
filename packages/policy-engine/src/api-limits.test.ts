import { POLICY_FIELDS } from '@ecloud/shared';
import { describe, expect, it } from 'vitest';
import { API_LIMIT_TARGETS, translateApiLimits } from './api-limits.js';

const fields = {
  download_rate_kbps: 8000,
  upload_rate_kbps: 2000,
  session_timeout_s: 3_725, // 62 min 5 s
  quota_total_bytes: 2_500_000_000n,
  quota_daily_bytes: 700_400_000n,
};

describe('translateApiLimits (Cycle D API limits target)', () => {
  it('declares every policy field exactly once, never VERIFIED_SUPPORTED, always DOCUMENTED', () => {
    for (const target of API_LIMIT_TARGETS) {
      const plan = translateApiLimits(target, { fields });
      expect(plan.fields.map((f) => f.field).sort()).toEqual([...POLICY_FIELDS].sort());
      for (const f of plan.fields) {
        expect(f.status).not.toBe('VERIFIED_SUPPORTED');
        expect(f.evidenceLevel).toBe('DOCUMENTED');
        expect(f.note.length).toBeGreaterThan(10);
      }
    }
  });

  it('UniFi: minutes and MB rounded down, rx = download (labelled assumption)', () => {
    const plan = translateApiLimits('unifi-network', { fields });
    expect(plan.unifi).toEqual({
      timeLimitMinutes: 62,
      dataUsageLimitMBytes: 700,
      rxRateLimitKbps: 8000,
      txRateLimitKbps: 2000,
    });
    expect(plan.limits).toEqual({
      durationS: 3720,
      dataLimitBytes: 700_000_000n,
      downloadKbps: 8000,
      uploadKbps: 2000,
    });
    const rx = plan.fields.find((f) => f.field === 'download_rate_kbps');
    expect(rx).toMatchObject({ status: 'REQUIRES_DEVICE_TEST', apiField: 'rxRateLimitKbps' });
    expect(rx?.note).toMatch(/ASSUMPTION/);
    expect(plan.fields.find((f) => f.field === 'quota_daily_bytes')?.status).toBe('UNSUPPORTED');
    expect(plan.fields.find((f) => f.field === 'idle_timeout_s')?.status).toBe('UNSUPPORTED');
    expect(plan.fields.find((f) => f.field === 'valid_until')?.status).toBe('ECLOUD_SIDE_ONLY');
  });

  it('Omada: millisecond duration, byte quota, kbps rates', () => {
    const plan = translateApiLimits('omada-controller', {
      fields,
      sessionCapS: 1800,
      remainingQuotaBytes: 5_000n,
    });
    expect(plan.omada).toEqual({
      timeMs: 1_800_000,
      totalTrafficLimitBytes: 5000,
      downloadRateLimitKbps: 8000,
      uploadRateLimitKbps: 2000,
    });
    expect(plan.fields.find((f) => f.field === 'session_timeout_s')?.note).toMatch(
      /REQUIRES_DEVICE_TEST/,
    );
  });

  it('Mist: only the duration is expressible', () => {
    const plan = translateApiLimits('mist', { fields });
    expect(plan.mist).toEqual({ authorizeMinutes: 62 });
    expect(plan.limits.downloadKbps).toBeNull();
    expect(plan.limits.dataLimitBytes).toBeNull();
    for (const f of ['download_rate_kbps', 'upload_rate_kbps', 'quota_total_bytes'] as const) {
      expect(plan.fields.find((x) => x.field === f)?.status).toBe('UNSUPPORTED');
    }
  });

  it('defaults the duration, keeps a minimum of one minute / one MB, omits unset fields', () => {
    const empty = translateApiLimits('unifi-network', { fields: {} });
    expect(empty.unifi).toEqual({ timeLimitMinutes: 24 * 60 });
    expect(empty.fields.find((f) => f.field === 'download_rate_kbps')?.mechanism).toBe('not_set');
    const tiny = translateApiLimits('unifi-network', {
      fields: { session_timeout_s: 10, quota_total_bytes: 10n },
    });
    expect(tiny.unifi).toEqual({ timeLimitMinutes: 1, dataUsageLimitMBytes: 1 });
    expect(() =>
      translateApiLimits('omada-controller', { fields: { download_rate_kbps: 1e12 } }),
    ).toThrow(RangeError);
  });
});
