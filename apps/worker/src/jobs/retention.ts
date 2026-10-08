/**
 * `retention.prune` (D-025 pilot defaults): radius.radacct_raw 7 days, accounting_records
 * 13 months, audit_logs 24 months. Dry-run (plan only, logged) unless RETENTION_APPLY=true.
 *
 * Partitioned append-only tables are pruned by dropping whole monthly partitions whose upper
 * bound is at or before the cutoff (DATABASE_DESIGN.md §5: "dropping a partition is the
 * retention operation"); row DELETEs are blocked there by `forbid_mutation()`. Old rows that
 * landed in a `_default` partition are reported, never deleted. `radacct_raw` (plain table)
 * loses rows older than 7 days that the drain cursor has already passed. The `usage_hourly`
 * rollup (plain table, migration 026) follows the accounting retention: hours older than the
 * accounting cutoff are deleted (the dashboard reads at most 31 days of hours).
 *
 * The pure plan lives in `@ecloud/db` (P8-A) so the API's platform dry-run report computes the
 * exact same plan; it is re-exported here unchanged.
 */
import {
  D025_RETENTION,
  RETENTION_PARTITION_NAME_RE,
  defaultPartitionRowsPastCutoff,
  listRetentionPartitions,
  planRetention,
  withPlatform,
  type Db,
  type PartitionInfo,
  type RetentionPolicy,
} from '@ecloud/db';
import { sql } from 'kysely';
import { DRAIN_CURSOR } from '../accounting/drain.js';
import type { WorkerState } from '../infra/state.js';

export {
  D025_RETENTION,
  RETENTION_TABLES,
  parsePartitionBound,
  planRetention,
  retentionCutoffs,
  subtractMonths,
  type PartitionInfo,
  type RetentionPlan,
  type RetentionPolicy,
  type RetentionTable,
} from '@ecloud/db';

export const RETENTION_REASON = 'worker:retention.prune';

export async function listPartitions(db: Db): Promise<PartitionInfo[]> {
  return (await listRetentionPartitions(db)).map(({ table, partition, from, to }) => ({
    table,
    partition,
    from,
    to,
  }));
}

export interface RetentionDeps {
  db: Db;
  state: WorkerState;
  apply: boolean;
  policy?: RetentionPolicy;
  now?: () => Date;
}

export interface RetentionReport {
  applied: boolean;
  cutoffs: Record<string, string>;
  dropPartitions: string[];
  rawRowsEligible: number;
  rawRowsDeleted: number;
  usageHourlyRowsEligible: number;
  usageHourlyRowsDeleted: number;
  defaultPartitionRowsPastCutoff: Record<string, number>;
}

export async function pruneRetention(deps: RetentionDeps): Promise<RetentionReport> {
  const now = (deps.now ?? (() => new Date()))();
  const plan = planRetention(await listPartitions(deps.db), now, deps.policy ?? D025_RETENTION);
  const cursor = await deps.state.getCursor(DRAIN_CURSOR);

  const eligible = await deps.db
    .selectFrom('radius.radacct_raw')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .where('received_at', '<', plan.cutoffs.raw)
    .where('radacctid', '<=', cursor)
    .executeTakeFirstOrThrow();
  const hourlyEligible = await deps.db
    .selectFrom('usage_hourly')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .where('hour_start', '<', plan.cutoffs.accounting_records)
    .executeTakeFirstOrThrow();

  const report: RetentionReport = {
    applied: deps.apply,
    cutoffs: {
      raw: plan.cutoffs.raw.toISOString(),
      accounting_records: plan.cutoffs.accounting_records.toISOString(),
      audit_logs: plan.cutoffs.audit_logs.toISOString(),
    },
    dropPartitions: plan.dropPartitions.map((p) => p.partition),
    rawRowsEligible: eligible.n,
    rawRowsDeleted: 0,
    usageHourlyRowsEligible: Number(hourlyEligible.n),
    usageHourlyRowsDeleted: 0,
    defaultPartitionRowsPastCutoff: await defaultPartitionRowsPastCutoff(deps.db, plan.cutoffs),
  };
  if (!deps.apply) return report;

  await withPlatform(deps.db, { reason: RETENTION_REASON }, async (trx) => {
    for (const p of plan.dropPartitions) {
      if (!RETENTION_PARTITION_NAME_RE.test(p.partition)) continue;
      await sql`ALTER TABLE ${sql.table(p.table)} DETACH PARTITION ${sql.table(p.partition)}`.execute(
        trx,
      );
      await sql`DROP TABLE ${sql.table(p.partition)}`.execute(trx);
    }
    const deleted = await trx
      .deleteFrom('radius.radacct_raw')
      .where('received_at', '<', plan.cutoffs.raw)
      .where('radacctid', '<=', cursor)
      .executeTakeFirst();
    report.rawRowsDeleted = Number(deleted.numDeletedRows);
    const hourlyDeleted = await trx
      .deleteFrom('usage_hourly')
      .where('hour_start', '<', plan.cutoffs.accounting_records)
      .executeTakeFirst();
    report.usageHourlyRowsDeleted = Number(hourlyDeleted.numDeletedRows);
  });
  return report;
}
