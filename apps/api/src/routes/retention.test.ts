import { describe, expect, it } from 'vitest';
import { retentionChecks } from './retention.js';

function month(table: 'accounting_records' | 'audit_logs', y: number, m: number) {
  return {
    table,
    partition: `${table}_y${String(y)}m${String(m).padStart(2, '0')}`,
    from: new Date(Date.UTC(y, m - 1, 1)),
    to: new Date(Date.UTC(y, m, 1)),
    estimatedRows: 0,
  };
}

describe('retention dry-run checks (D-025)', () => {
  const now = new Date('2026-10-08T12:00:00Z');

  it('passes with current + next month partitions and nothing stranded', () => {
    const parts = (['accounting_records', 'audit_logs'] as const).flatMap((t) => [
      month(t, 2026, 10),
      month(t, 2026, 11),
    ]);
    const checks = retentionChecks(parts, [], { accounting_records: 0, audit_logs: 0 }, now);
    expect(checks.every((c) => c.ok)).toBe(true);
    expect(checks).toHaveLength(7);
  });

  it('flags a missing next-month partition, stranded DEFAULT rows and odd drop names', () => {
    const parts = [month('accounting_records', 2026, 10), month('audit_logs', 2026, 10)];
    const checks = retentionChecks(
      parts,
      ['accounting_records_old'],
      { accounting_records: 3, audit_logs: 0 },
      now,
    );
    const failed = checks.filter((c) => !c.ok).map((c) => c.name);
    expect(failed).toEqual([
      'accounting_records.next_month_partition',
      'accounting_records.default_partition_past_cutoff',
      'audit_logs.next_month_partition',
      'drop_candidates_named',
    ]);
  });
});
