import type { MigrationExecutor } from './migrate.js';
import { PARTITIONED_TABLES } from './tables.js';

export const DEFAULT_MONTHS_AHEAD = 2;

export interface EnsurePartitionsResult {
  table: string;
  created: string[];
}

/**
 * Calls `ensure_month_partitions(table, months_ahead)` for every partitioned table
 * (DATABASE_DESIGN.md §5 "Partition management": monthly partitions created 2 months ahead).
 * Idempotent; run from the CLI by cron / the worker scheduler before the month rolls.
 */
export async function ensureMonthPartitions(
  exec: MigrationExecutor,
  monthsAhead: number = DEFAULT_MONTHS_AHEAD,
  tables: readonly string[] = PARTITIONED_TABLES,
): Promise<EnsurePartitionsResult[]> {
  if (!Number.isInteger(monthsAhead) || monthsAhead < 0) {
    throw new RangeError('monthsAhead must be a non-negative integer');
  }
  const results: EnsurePartitionsResult[] = [];
  for (const table of tables) {
    const { rows } = await exec.query<{ ensure_month_partitions: string }>(
      'SELECT ensure_month_partitions($1::regclass, $2::integer)',
      [table, monthsAhead],
    );
    results.push({ table, created: rows.map((r) => r.ensure_month_partitions) });
  }
  return results;
}
