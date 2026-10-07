import { describe, expect, it } from 'vitest';
import {
  D025_RETENTION,
  parsePartitionBound,
  planRetention,
  retentionCutoffs,
  subtractMonths,
  type PartitionInfo,
} from './retention.js';

function month(table: PartitionInfo['table'], y: number, m: number): PartitionInfo {
  return {
    table,
    partition: `${table}_y${String(y)}m${String(m).padStart(2, '0')}`,
    from: new Date(Date.UTC(y, m - 1, 1)),
    to: new Date(Date.UTC(y, m, 1)),
  };
}

describe('retention plan (D-025)', () => {
  const now = new Date('2026-10-07T03:30:00Z');

  it('computes the cutoffs: raw 7 days, accounting 13 months, audit 24 months', () => {
    const c = retentionCutoffs(now, D025_RETENTION);
    expect(c.raw.toISOString()).toBe('2026-09-30T03:30:00.000Z');
    expect(c.accounting_records.toISOString()).toBe('2025-09-07T03:30:00.000Z');
    expect(c.audit_logs.toISOString()).toBe('2024-10-07T03:30:00.000Z');
  });

  it('drops only partitions entirely older than the cutoff and never DEFAULT', () => {
    const partitions: PartitionInfo[] = [
      month('accounting_records', 2025, 7),
      month('accounting_records', 2025, 8), // ends 2025-09-01 <= cutoff 2025-09-07 → drop
      month('accounting_records', 2025, 9), // straddles the cutoff → keep
      month('accounting_records', 2026, 10),
      {
        table: 'accounting_records',
        partition: 'accounting_records_default',
        from: null,
        to: null,
      },
      month('audit_logs', 2024, 9), // ends 2024-10-01 → drop
      month('audit_logs', 2024, 10), // straddles → keep
    ];
    const plan = planRetention(partitions, now);
    expect(plan.dropPartitions.map((p) => p.partition)).toEqual([
      'accounting_records_y2025m07',
      'accounting_records_y2025m08',
      'audit_logs_y2024m09',
    ]);
    expect(plan.keepPartitions.map((p) => p.partition)).toContain('accounting_records_default');
    expect(plan.keepPartitions.map((p) => p.partition)).toContain('accounting_records_y2025m09');
  });

  it('subtractMonths clamps the day of month', () => {
    expect(subtractMonths(new Date('2026-03-31T00:00:00Z'), 1).toISOString()).toBe(
      '2026-02-28T00:00:00.000Z',
    );
    expect(subtractMonths(new Date('2024-03-31T00:00:00Z'), 1).toISOString()).toBe(
      '2024-02-29T00:00:00.000Z',
    );
    expect(subtractMonths(new Date('2026-01-15T10:00:00Z'), 13).toISOString()).toBe(
      '2024-12-15T10:00:00.000Z',
    );
  });

  it('parses partition bounds', () => {
    expect(
      parsePartitionBound(
        "FOR VALUES FROM ('2026-10-01 00:00:00+00') TO ('2026-11-01 00:00:00+00')",
      ),
    ).toEqual({ from: new Date('2026-10-01T00:00:00Z'), to: new Date('2026-11-01T00:00:00Z') });
    expect(parsePartitionBound('DEFAULT')).toEqual({ from: null, to: null });
  });
});
