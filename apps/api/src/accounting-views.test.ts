import { ValidationError } from '@ecloud/shared';
import { describe, expect, it } from 'vitest';
import {
  bucketCount,
  bucketStart,
  currentPeriodEndsAt,
  currentPeriodStart,
  decodeTimeCursor,
  encodeTimeCursor,
  expectedLagS,
  freshnessOf,
  operationAvailability,
  periodEndKey,
  quotaPeriods,
  seriesRange,
  sessionLastAccounting,
  withDeltas,
} from './accounting-views.js';
import { NAS_ADAPTER_KEYS } from './nas-adapter.js';

describe('freshness (spec §6)', () => {
  it('reports the lag since the newest accounting and the expected lag', () => {
    const now = new Date('2026-10-08T12:00:00Z');
    expect(freshnessOf(now, new Date('2026-10-08T11:58:30Z'), 300)).toEqual({
      measured_at: '2026-10-08T12:00:00.000Z',
      last_accounting_at: '2026-10-08T11:58:30.000Z',
      freshness_s: 90,
      expected_lag_s: 305,
    });
    expect(freshnessOf(now, null, null)).toMatchObject({
      last_accounting_at: null,
      freshness_s: null,
      expected_lag_s: 605,
    });
    expect(expectedLagS(60)).toBe(65);
  });

  it('a session without accounting has no last-accounting time', () => {
    const started = new Date('2026-10-08T10:00:00Z');
    const interim = new Date('2026-10-08T10:10:00Z');
    expect(
      sessionLastAccounting({
        status: 'authorized',
        started_at: started,
        last_interim_at: null,
        stopped_at: null,
      }),
    ).toBeNull();
    expect(
      sessionLastAccounting({
        status: 'active',
        started_at: started,
        last_interim_at: interim,
        stopped_at: null,
      }),
    ).toEqual(interim);
    expect(
      sessionLastAccounting({
        status: 'active',
        started_at: started,
        last_interim_at: null,
        stopped_at: null,
      }),
    ).toEqual(started);
  });
});

describe('keyset cursor', () => {
  it('round-trips microsecond timestamps and rejects garbage', () => {
    const c = encodeTimeCursor(
      '2026-10-08T12:00:00.123456Z',
      '0192aa00-0000-7000-8000-000000000001',
    );
    expect(decodeTimeCursor(c)).toEqual({
      at: '2026-10-08T12:00:00.123456Z',
      id: '0192aa00-0000-7000-8000-000000000001',
    });
    expect(decodeTimeCursor(undefined)).toBeNull();
    expect(() => decodeTimeCursor('nonsense')).toThrow();
    expect(() => decodeTimeCursor(encodeTimeCursor("x'; DROP", '1'))).toThrow();
  });
});

describe('periods in the site timezone (Q65)', () => {
  it('labels and ends buckets', () => {
    expect(periodEndKey('daily', '2026-10-31')).toBe('2026-11-01');
    expect(periodEndKey('monthly', '2026-12-01')).toBe('2027-01-01');
    expect(periodEndKey('total', '1970-01-01')).toBeNull();
    expect(bucketStart('monthly', '2026-10-17')).toBe('2026-10-01');
    expect(bucketCount('daily', '2026-01-01', '2026-12-31')).toBe(365);
    expect(bucketCount('monthly', '2025-11-01', '2026-10-01')).toBe(12);
  });

  it('uses the local calendar: 22:30 UTC is already the next day in Dubai', () => {
    const now = new Date('2026-10-08T22:30:00Z');
    expect(currentPeriodStart('daily', now, 'Asia/Dubai')).toBe('2026-10-09');
    expect(currentPeriodStart('daily', now, 'UTC')).toBe('2026-10-08');
    expect(currentPeriodEndsAt('daily', now, 'Asia/Dubai')?.toISOString()).toBe(
      '2026-10-09T20:00:00.000Z',
    );
    expect(currentPeriodEndsAt('monthly', now, 'UTC')?.toISOString()).toBe(
      '2026-11-01T00:00:00.000Z',
    );
    expect(currentPeriodEndsAt('total', now, 'UTC')).toBeNull();
  });

  it('Pacific/Auckland past local midnight is already the next day and month', () => {
    const now = new Date('2026-10-31T11:30:00Z'); // 1 Nov 00:30 NZDT (UTC+13)
    expect(currentPeriodStart('daily', now, 'Pacific/Auckland')).toBe('2026-11-01');
    expect(currentPeriodStart('monthly', now, 'Pacific/Auckland')).toBe('2026-11-01');
    expect(currentPeriodStart('monthly', now, 'UTC')).toBe('2026-10-01');
    expect(currentPeriodEndsAt('daily', now, 'Pacific/Auckland')?.toISOString()).toBe(
      '2026-11-01T11:00:00.000Z',
    );
  });

  it('defaults and bounds the series range', () => {
    const now = new Date('2026-10-08T12:00:00Z');
    expect(seriesRange('daily', now, 'UTC')).toEqual({ from: '2026-09-08', to: '2026-10-08' });
    expect(seriesRange('monthly', now, 'UTC')).toEqual({ from: '2025-10-01', to: '2026-10-01' });
    expect(seriesRange('total', now, 'UTC')).toEqual({ from: '1970-01-01', to: '1970-01-01' });
    expect(() => seriesRange('daily', now, 'UTC', '2024-01-01', '2026-01-01')).toThrow(
      ValidationError,
    );
    expect(() => seriesRange('daily', now, 'UTC', '2026-10-09', '2026-10-01')).toThrow();
  });
});

describe('quota position', () => {
  it('matches the worker rule (used >= limit is exceeded) and skips unset limits', () => {
    const now = new Date('2026-10-08T12:00:00Z');
    const q = quotaPeriods(
      { quota_daily_bytes: 1000, quota_monthly_bytes: null, quota_total_bytes: 0 },
      { daily: 1000, monthly: 5000 },
      now,
      'UTC',
    );
    expect(q).toEqual([
      {
        period: 'daily',
        limit_bytes: 1000,
        used_bytes: 1000,
        remaining_bytes: 0,
        exceeded: true,
        period_start: '2026-10-08',
        period_end: '2026-10-09T00:00:00.000Z',
      },
    ]);
  });
});

describe('timeline deltas', () => {
  it('computes non-negative deltas vs the previous record', () => {
    const out = withDeltas([
      { input_octets: 0, output_octets: 0 },
      { input_octets: 100, output_octets: 50 },
      { input_octets: null, output_octets: null },
      { input_octets: 90, output_octets: 80 },
    ]);
    expect(out.map((r) => [r.delta_input_octets, r.delta_output_octets])).toEqual([
      [0, 0],
      [100, 50],
      [null, null],
      [0, 30],
    ]);
  });
});

describe('Disconnect / Reauthorize gate (D-006, D-028 V12)', () => {
  const base = {
    nasCoaSupported: null,
    sessionStatus: 'active',
    permitted: true,
  } as const;

  it('refuses every NAS adapter today while the dispatcher is disabled, citing the evidence', () => {
    for (const adapterKey of NAS_ADAPTER_KEYS) {
      for (const operation of ['disconnect', 'reauthorize'] as const) {
        const a = operationAvailability({
          ...base,
          operation,
          adapterKey,
          dispatcherEnabled: false,
        });
        expect(a.available).toBe(false);
        expect(a.device_enforced).toBe(false);
        expect(a.evidence.device_enforced).toBe(false);
        expect(['dispatcher_disabled', 'coa_unsupported']).toContain(a.code);
        expect(a.reason.length).toBeGreaterThan(20);
        if (a.code === 'dispatcher_disabled')
          expect(a.reason).toContain('ECLOUD_COA_ENABLED=false');
      }
    }
  });

  it('lab mode accepts but never reports device enforcement', () => {
    const a = operationAvailability({
      ...base,
      operation: 'disconnect',
      adapterKey: 'openwifi-hostapd-radius',
      dispatcherEnabled: true,
    });
    expect(a).toMatchObject({
      available: true,
      mode: 'lab',
      device_enforced: false,
      code: null,
      permission: 'session:disconnect',
    });
    expect(a.reason).toContain('V12');
    expect(a.evidence.status).toBe('REQUIRES_DEVICE_TEST');
  });

  it('refuses closed sessions, NAS without adapter and NAS with CoA turned off', () => {
    expect(
      operationAvailability({
        ...base,
        operation: 'disconnect',
        adapterKey: 'openwifi-hostapd-radius',
        dispatcherEnabled: true,
        sessionStatus: 'stopped',
      }).code,
    ).toBe('session_not_open');
    expect(
      operationAvailability({
        ...base,
        operation: 'disconnect',
        adapterKey: null,
        dispatcherEnabled: true,
      }).code,
    ).toBe('no_adapter');
    expect(
      operationAvailability({
        ...base,
        operation: 'disconnect',
        adapterKey: 'openwifi-config',
        dispatcherEnabled: true,
      }).code,
    ).toBe('no_adapter');
    expect(
      operationAvailability({
        ...base,
        operation: 'reauthorize',
        adapterKey: 'openwifi-hostapd-radius',
        dispatcherEnabled: true,
        nasCoaSupported: false,
      }),
    ).toMatchObject({ code: 'nas_coa_disabled', permission: 'session:coa', available: false });
  });
});
