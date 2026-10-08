/**
 * D-025 retention dry run for platform administrators (Phase 8 P8-A; API_ARCHITECTURE.md
 * "P8-A" item 10). Computes the plan the worker's `retention.prune` job would apply right now,
 * with the same pure `planRetention` from `@ecloud/db`, and checks it against the current
 * partitions. Read-only: nothing is detached, dropped or deleted here.
 */
import {
  D025_RETENTION,
  RETENTION_PARTITION_NAME_RE,
  defaultPartitionRowsPastCutoff,
  listRetentionPartitions,
  planRetention,
  type PartitionWithEstimate,
} from '@ecloud/db';
import { z } from 'zod';
import type { AppDeps } from '../context.js';
import { problemResponses } from '../http/common.js';
import { defineRoute, type AnyRouteSpec } from '../http/route.js';
import { inPlatform } from '../tenant.js';

function monthStartUtc(at: Date, offset: number): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + offset, 1));
}

export interface RetentionCheck {
  name: string;
  ok: boolean;
  detail: string;
}

/** Pure checks of a plan against the partitions (exported for unit tests). */
export function retentionChecks(
  partitions: readonly PartitionWithEstimate[],
  dropNames: readonly string[],
  defaultPastCutoff: Readonly<Record<string, number>>,
  now: Date,
): RetentionCheck[] {
  const checks: RetentionCheck[] = [];
  for (const table of ['accounting_records', 'audit_logs'] as const) {
    const own = partitions.filter((p) => p.table === table && p.from !== null && p.to !== null);
    for (const [label, offset] of [
      ['current', 0],
      ['next', 1],
    ] as const) {
      const start = monthStartUtc(now, offset);
      const covered = own.some(
        (p) =>
          (p.from as Date).getTime() <= start.getTime() &&
          (p.to as Date).getTime() > start.getTime(),
      );
      checks.push({
        name: `${table}.${label}_month_partition`,
        ok: covered,
        detail: covered
          ? `a monthly partition covers ${start.toISOString().slice(0, 7)}`
          : `no partition covers ${start.toISOString().slice(0, 7)}: rows would land in ${table}_default (run partitions.ensure)`,
      });
    }
    const stranded = defaultPastCutoff[table] ?? 0;
    checks.push({
      name: `${table}.default_partition_past_cutoff`,
      ok: stranded === 0,
      detail:
        stranded === 0
          ? 'no row older than the cutoff sits in the DEFAULT partition'
          : `${String(stranded)} row(s) older than the cutoff sit in ${table}_default; the job never drops them`,
    });
  }
  const badNames = dropNames.filter((n) => !RETENTION_PARTITION_NAME_RE.test(n));
  checks.push({
    name: 'drop_candidates_named',
    ok: badNames.length === 0,
    detail:
      badNames.length === 0
        ? 'every drop candidate follows <table>_yYYYYmMM (the job only drops those)'
        : `skipped by the job (unexpected names): ${badNames.join(', ')}`,
  });
  return checks;
}

export function retentionRoutes(deps: AppDeps): AnyRouteSpec[] {
  const now = () => (deps.now ?? (() => new Date()))();

  const plan = defineRoute({
    method: 'get',
    path: '/api/v1/platform/retention/plan',
    summary: 'D-025 retention dry run: what retention.prune would drop now (nothing is deleted)',
    tags: ['platform'],
    auth: 'principal',
    permission: 'platform:health:read',
    scope: 'platform',
    responses: {
      200: {
        description: 'RetentionPlan',
        schema: z
          .looseObject({
            measured_at: z.string(),
            mode: z.literal('dry_run'),
            drop_partitions: z.array(z.string()),
            checks: z.array(z.object({ name: z.string(), ok: z.boolean(), detail: z.string() })),
          })
          .meta({ id: 'RetentionPlan' }),
      },
      ...problemResponses,
    },
    handler: async ({ ctx }) => {
      const at = now();
      const body = await inPlatform(deps, ctx, 'retention dry-run plan', async (trx) => {
        const partitions = await listRetentionPartitions(trx);
        const p = planRetention(partitions, at, D025_RETENTION);
        const stranded = await defaultPartitionRowsPastCutoff(trx, p.cutoffs);
        const raw = await trx
          .selectFrom('radius.radacct_raw')
          .select((eb) => eb.fn.countAll<number>().as('n'))
          .where('received_at', '<', p.cutoffs.raw)
          .executeTakeFirstOrThrow();
        const drop = new Set(p.dropPartitions.map((x) => x.partition));
        return {
          measured_at: at.toISOString(),
          mode: 'dry_run' as const,
          policy: {
            raw_days: D025_RETENTION.rawDays,
            accounting_months: D025_RETENTION.accountingMonths,
            audit_months: D025_RETENTION.auditMonths,
            source: 'D-025 pilot defaults (not a regulatory retention declaration)',
          },
          cutoffs: {
            raw: p.cutoffs.raw.toISOString(),
            accounting_records: p.cutoffs.accounting_records.toISOString(),
            audit_logs: p.cutoffs.audit_logs.toISOString(),
          },
          partitions: partitions.map((x) => ({
            table: x.table,
            partition: x.partition,
            from: x.from?.toISOString() ?? null,
            to: x.to?.toISOString() ?? null,
            action: drop.has(x.partition) ? 'drop' : 'keep',
            estimated_rows: x.estimatedRows,
          })),
          drop_partitions: [...drop],
          default_partition_rows_past_cutoff: stranded,
          raw_rows_older_than_cutoff: Number(raw.n),
          raw_note:
            'radius.radacct_raw rows are deleted only once the accounting drain cursor has passed them',
          checks: retentionChecks(partitions, [...drop], stranded, at),
        };
      });
      return { status: 200, body };
    },
  });

  return [plan];
}
