/**
 * D-025 retention planning (pilot defaults: radius.radacct_raw 7 days, accounting_records
 * 13 months, audit_logs 24 months). Pure planning plus read-only catalogue queries, shared by the
 * worker's `retention.prune` job (which applies the plan only with RETENTION_APPLY=true) and the
 * API's platform dry-run report (`GET /api/v1/platform/retention/plan`, P8-A), so both always
 * compute the same plan.
 *
 * Partitioned append-only tables are pruned by dropping whole monthly partitions whose upper
 * bound is at or before the cutoff (DATABASE_DESIGN.md §5); rows in a DEFAULT partition are only
 * reported, never deleted.
 */
import { sql } from 'kysely';
import type { DbExecutor } from './client.js';

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

/** Partition naming the prune job requires before it drops anything (`<table>_yYYYYmMM`). */
export const RETENTION_PARTITION_NAME_RE = /^(accounting_records|audit_logs)_y\d{4}m\d{2}$/;

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

export interface PartitionWithEstimate extends PartitionInfo {
  /** `pg_class.reltuples` (planner estimate; -1 / 0 when never analysed). */
  estimatedRows: number;
}

/** Partitions of the retention tables with their bounds (read-only catalogue query). */
export async function listRetentionPartitions(db: DbExecutor): Promise<PartitionWithEstimate[]> {
  const result = await sql<{ parent: string; partition: string; bound: string; est: number }>`
    SELECT parent.relname AS parent, child.relname AS partition,
           pg_get_expr(child.relpartbound, child.oid) AS bound,
           child.reltuples::float8 AS est
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
    estimatedRows: Math.max(0, Math.round(Number(r.est))),
  }));
}

/** Rows of each table's DEFAULT partition older than its cutoff (never dropped by the job). */
export async function defaultPartitionRowsPastCutoff(
  db: DbExecutor,
  cutoffs: RetentionPlan['cutoffs'],
): Promise<Record<RetentionTable, number>> {
  const out = { accounting_records: 0, audit_logs: 0 } as Record<RetentionTable, number>;
  for (const table of RETENTION_TABLES) {
    const column = table === 'audit_logs' ? 'created_at' : 'received_at';
    const r = await sql<{ n: string | number }>`
      SELECT count(*)::bigint AS n FROM ${sql.table(`${table}_default`)}
       WHERE ${sql.ref(column)} < ${cutoffs[table]}
    `.execute(db);
    out[table] = Number(r.rows[0]?.n ?? 0);
  }
  return out;
}
