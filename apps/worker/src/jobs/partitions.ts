/** `partitions.ensure` (daily): monthly partitions 2 months ahead for every partitioned table. */
import {
  DEFAULT_MONTHS_AHEAD,
  ensureMonthPartitions,
  withPlatform,
  type Db,
  type EnsurePartitionsResult,
  type MigrationExecutor,
} from '@ecloud/db';
import { CompiledQuery } from 'kysely';

export const PARTITIONS_REASON = 'worker:partitions.ensure';

export async function ensurePartitions(
  db: Db,
  monthsAhead: number = DEFAULT_MONTHS_AHEAD,
): Promise<EnsurePartitionsResult[]> {
  return withPlatform(db, { reason: PARTITIONS_REASON }, (trx) => {
    const exec: MigrationExecutor = {
      query: async <R extends Record<string, unknown>>(
        text: string,
        values?: readonly unknown[],
      ) => {
        const result = await trx.executeQuery<R>(CompiledQuery.raw(text, [...(values ?? [])]));
        return { rows: [...result.rows] };
      },
    };
    return ensureMonthPartitions(exec, monthsAhead);
  });
}
