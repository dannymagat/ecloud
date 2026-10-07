/**
 * `retention.prune` (D-025 pilot defaults): radius.radacct_raw 7 days, accounting_records
 * 13 months, audit_logs 24 months. Dry-run (plan only, logged) unless RETENTION_APPLY=true.
 *
 * Partitioned append-only tables are pruned by dropping whole monthly partitions whose upper
 * bound is at or before the cutoff (DATABASE_DESIGN.md §5: "dropping a partition is the
 * retention operation"); row DELETEs are blocked there by `forbid_mutation()`. Old rows that
 * landed in a `_default` partition are reported, never deleted. `radacct_raw` (plain table)
 * loses rows older than 7 days that the drain cursor has already passed.
 */
import { withPlatform, type Db } from '@ecloud/db';
import { sql } from 'kysely';
import { DRAIN_CURSOR } from '../accounting/drain.js';
import type { WorkerState } from '../infra/state.js';

export const RETENTION_REASON = 'worker:retention.prune';

export interface RetentionPolicy {
  rawDays: number;
  accountingMonths: number;
  auditMonths: number;
}

export const D025_RETENTION: RetentionPolicy = Object.freeze({
  rawDays: 7,
  accountingMonths: 13,
  auditMonths: 24,
});

export const RETENTION_TABLES = ['accounting_records', 'audit_logs'] as const;
export type RetentionTable = (typeof RETENTION_TABLES)[number];

export interface PartitionInfo {
  table: RetentionTable;
  partition: string;
  /** null for the DEFAULT partition. */
  from: Date | null;
  to: Date | null;
}

export interface RetentionPlan {
  cutoffs: { raw: Date; accounting_records: Date; audit_logs: Date };
  dropPartitions: PartitionInfo[];
  keepPartitions: PartitionInfo[];
}

/** UTC calendar subtraction; day-of-month clamps (Mar 31 − 1 month → Feb 28/29). */
export function subtractMonths(at: Date, months: number): Date {
  const y = at.getUTCFullYear();
  const m = at.getUTCMonth() - months;
  const target = new Date(
    Date.UTC(y, m, 1, at.getUTCHours(), at.getUTCMinutes(), at.getUTCSeconds()),
  );
  const lastDay = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(at.getUTCDate(), lastDay));
  return target;
}

export function retentionCutoffs(now: Date, policy: RetentionPolicy): RetentionPlan['cutoffs'] {
  return {
    raw: new Date(now.getTime() - policy.rawDays * 86_400_000),
    accounting_records: subtractMonths(now, policy.accountingMonths),
    audit_logs: subtractMonths(now, policy.auditMonths),
  };
}

/** Pure: which partitions may be dropped (whole range older than the table's cutoff). */
export function planRetention(
  partitions: readonly PartitionInfo[],
  now: Date,
  policy: RetentionPolicy = D025_RETENTION,
): RetentionPlan {
  const cutoffs = retentionCutoffs(now, policy);
  const dropPartitions: PartitionInfo[] = [];
  const keepPartitions: PartitionInfo[] = [];
  for (const p of partitions) {
    const cutoff = cutoffs[p.table];
    if (p.to !== null && p.to.getTime() <= cutoff.getTime()) dropPartitions.push(p);
    else keepPartitions.push(p);
  }
  return { cutoffs, dropPartitions, keepPartitions };
}

const BOUND_RE = /FROM \('([^']+)'\) TO \('([^']+)'\)/;

/** Parses `pg_get_expr(relpartbound)`; DEFAULT → nulls. */
export function parsePartitionBound(expr: string): { from: Date | null; to: Date | null } {
  const m = BOUND_RE.exec(expr);
  if (m?.[1] === undefined || m[2] === undefined) return { from: null, to: null };
  return { from: new Date(m[1]), to: new Date(m[2]) };
}

export async function listPartitions(db: Db): Promise<PartitionInfo[]> {
  const result = await sql<{ parent: string; partition: string; bound: string }>`
    SELECT parent.relname AS parent, child.relname AS partition,
           pg_get_expr(child.relpartbound, child.oid) AS bound
      FROM pg_inherits i
      JOIN pg_class parent ON parent.oid = i.inhparent
      JOIN pg_class child  ON child.oid = i.inhrelid
      JOIN pg_namespace ns ON ns.oid = parent.relnamespace
     WHERE ns.nspname = 'public' AND parent.relname IN ('accounting_records', 'audit_logs')
     ORDER BY parent.relname, child.relname
  `.execute(db);
  return result.rows.map((r) => ({
    table: r.parent as RetentionTable,
    partition: r.partition,
    ...parsePartitionBound(r.bound),
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
  defaultPartitionRowsPastCutoff: Record<string, number>;
}

const PARTITION_NAME_RE = /^(accounting_records|audit_logs)_y\d{4}m\d{2}$/;

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

  const defaultPastCutoff: Record<string, number> = {};
  for (const table of RETENTION_TABLES) {
    const column = table === 'audit_logs' ? 'created_at' : 'received_at';
    const r = await sql<{ n: number }>`
      SELECT count(*)::bigint AS n FROM ${sql.table(`${table}_default`)}
       WHERE ${sql.ref(column)} < ${plan.cutoffs[table]}
    `.execute(deps.db);
    defaultPastCutoff[table] = r.rows[0]?.n ?? 0;
  }

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
    defaultPartitionRowsPastCutoff: defaultPastCutoff,
  };
  if (!deps.apply) return report;

  await withPlatform(deps.db, { reason: RETENTION_REASON }, async (trx) => {
    for (const p of plan.dropPartitions) {
      if (!PARTITION_NAME_RE.test(p.partition)) continue;
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
  });
  return report;
}
