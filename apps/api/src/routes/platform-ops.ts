/**
 * Platform operations (API_ARCHITECTURE.md §3.2 "Platform"): role templates (read), the
 * cross-tenant audit log and the health report. All run on the platform connection through
 * `inPlatform(reason)` (audited `platform:access`).
 */
import { PARTITIONED_TABLES } from '@ecloud/db';
import { WORKER_QUEUE_NAMES, WORKER_QUEUE_PREFIX } from '@ecloud/shared';
import { sql } from 'kysely';
import { z } from 'zod';
import type { AppDeps } from '../context.js';
import type { QueueCounts } from '../kv.js';
import {
  PageSchema,
  PaginationQuery,
  decodeCursor,
  problemResponses,
  toPage,
} from '../http/common.js';
import { defineRoute, type AnyRouteSpec } from '../http/route.js';
import { inPlatform } from '../tenant.js';

const TAG = ['platform'];
const PROBE_TIMEOUT_MS = 2_000;

function withTimeout<T>(promise: Promise<T>, ms = PROBE_TIMEOUT_MS): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms).unref()),
  ]);
}

async function probe<T>(
  fn: () => Promise<T>,
): Promise<{ ok: true; value: T; ms: number } | { ok: false; error: string; ms: number }> {
  const started = Date.now();
  try {
    const value = await withTimeout(fn());
    return { ok: true, value, ms: Date.now() - started };
  } catch (error) {
    return { ok: false, error: (error as Error).message.slice(0, 200), ms: Date.now() - started };
  }
}

export function platformOpsRoutes(deps: AppDeps): AnyRouteSpec[] {
  const now = deps.now ?? (() => new Date());

  const roleTemplates = defineRoute({
    method: 'get',
    path: '/api/v1/platform/role-templates',
    summary: 'Role templates with their permission keys (seeded from @ecloud/shared)',
    tags: TAG,
    auth: 'principal',
    permission: 'role:read',
    scope: 'platform',
    responses: {
      200: {
        description: 'Templates (read-only: `ecloud-db seed` owns their content)',
        schema: z.object({ data: z.array(z.looseObject({ key: z.string() })) }),
      },
      ...problemResponses,
    },
    handler: async ({ ctx }) => {
      const data = await inPlatform(deps, ctx, 'read role templates', async (trx) => {
        const roles = await trx
          .selectFrom('roles')
          .select(['id', 'key', 'name', 'description', 'template_version', 'updated_at'])
          .where('is_template', '=', true)
          .where('organization_id', 'is', null)
          .orderBy('key')
          .execute();
        if (roles.length === 0) return [];
        const perms = await trx
          .selectFrom('role_permissions')
          .select(['role_id', 'permission_key'])
          .where(
            'role_id',
            'in',
            roles.map((r) => r.id),
          )
          .orderBy('permission_key')
          .execute();
        return roles.map((r) => ({
          ...r,
          permissions: perms.filter((p) => p.role_id === r.id).map((p) => p.permission_key),
        }));
      });
      return { status: 200, body: { data } };
    },
  });

  const auditLog = defineRoute({
    method: 'get',
    path: '/api/v1/platform/audit-log',
    summary: 'Cross-tenant audit log (newest first)',
    tags: TAG,
    auth: 'principal',
    permission: 'audit_log:read',
    scope: 'platform',
    query: PaginationQuery.extend({
      organization_id: z.uuid().optional(),
      /** `true`: only platform-level rows (organization_id IS NULL). */
      platform_only: z.enum(['true', 'false']).optional(),
      action: z.string().max(100).optional(),
      actor_id: z.uuid().optional(),
      target_id: z.uuid().optional(),
      from: z.iso.datetime({ offset: true }).optional(),
      to: z.iso.datetime({ offset: true }).optional(),
    }),
    responses: {
      200: { description: 'Audit rows (newest first)', schema: PageSchema },
      ...problemResponses,
    },
    handler: async ({ query, ctx }) => {
      const cursor = decodeCursor(query.cursor);
      const rows = await inPlatform(
        deps,
        ctx,
        'read platform audit log',
        (trx) => {
          let q = trx.selectFrom('audit_logs').selectAll();
          if (query.organization_id) q = q.where('organization_id', '=', query.organization_id);
          if (query.platform_only === 'true') q = q.where('organization_id', 'is', null);
          if (query.action) q = q.where('action', '=', query.action);
          if (query.actor_id) q = q.where('actor_id', '=', query.actor_id);
          if (query.target_id) q = q.where('target_id', '=', query.target_id);
          if (query.from) q = q.where('created_at', '>=', new Date(query.from));
          if (query.to) q = q.where('created_at', '<', new Date(query.to));
          if (typeof cursor === 'number') q = q.where('id', '<', cursor);
          return q
            .orderBy('id', 'desc')
            .limit(query.limit + 1)
            .execute();
        },
        query.organization_id ?? null,
      );
      return { status: 200, body: toPage(rows, query.limit, (r) => r.id) };
    },
  });

  const health = defineRoute({
    method: 'get',
    path: '/api/v1/platform/health',
    summary: 'Platform health: database, Redis, queues, sessions, partitions, NAS adapters',
    tags: TAG,
    auth: 'principal',
    permission: 'platform:health:read',
    scope: 'platform',
    responses: {
      200: {
        description:
          'Health report (always 200; `status` is ok | degraded). FreeRADIUS Status-Server ' +
          'and WireGuard handshakes are not probed from the API process (reported as such).',
        schema: z.looseObject({ status: z.enum(['ok', 'degraded']), checked_at: z.string() }),
      },
      ...problemResponses,
    },
    handler: async ({ ctx }) => {
      const at = now();
      const redis = await probe(() => deps.kv.ping());
      const counts = deps.kv.queueCounts?.bind(deps.kv);
      const queues: Record<string, QueueCounts> | null =
        counts === undefined || !redis.ok
          ? null
          : Object.fromEntries(
              await Promise.all(
                WORKER_QUEUE_NAMES.map(
                  async (name) =>
                    [
                      name,
                      await withTimeout(counts(WORKER_QUEUE_PREFIX, name)).catch(() => ({
                        waiting: -1,
                        active: -1,
                        delayed: -1,
                        failed: -1,
                      })),
                    ] as const,
                ),
              ),
            );
      const database = await probe(() =>
        inPlatform(deps, ctx, 'platform health', async (trx) => {
          const migrations = await sql<{ name: string; n: number }>`
            SELECT max(name) AS name, count(*)::int AS n FROM schema_migrations`.execute(trx);
          const sessions = await trx
            .selectFrom('sessions')
            .select(['status', (eb) => eb.fn.countAll<number>().as('n')])
            .where('status', 'in', ['authorized', 'active', 'stale'])
            .groupBy('status')
            .execute();
          const oldestAuthorized = await trx
            .selectFrom('sessions')
            .select((eb) => eb.fn.min('started_at').as('started_at'))
            .where('status', '=', 'authorized')
            .executeTakeFirst();
          const horizons = await sql<{ table: string; horizon: Date | null }>`
            SELECT p.relname AS table,
                   max(substring(pg_get_expr(c.relpartbound, c.oid) FROM 'TO \\(''([^'']+)''\\)')::timestamptz) AS horizon
              FROM pg_class p
              JOIN pg_inherits i ON i.inhparent = p.oid
              JOIN pg_class c ON c.oid = i.inhrelid
             WHERE p.relname = ANY(${[...PARTITIONED_TABLES]}::text[])
               AND p.relnamespace = 'public'::regnamespace
             GROUP BY p.relname
             ORDER BY p.relname`.execute(trx);
          const nas = await trx
            .selectFrom('nas_clients')
            .select([
              (eb) => eb.fn.countAll<number>().as('total'),
              (eb) =>
                eb.fn
                  .count<number>('id')
                  .filterWhere('adapter_key', 'is', null)
                  .as('without_adapter_key'),
            ])
            .where('deleted_at', 'is', null)
            .executeTakeFirstOrThrow();
          return {
            migrations: {
              latest: migrations.rows[0]?.name ?? null,
              applied: migrations.rows[0]?.n ?? 0,
            },
            sessions: Object.fromEntries(sessions.map((s) => [s.status, Number(s.n)])),
            oldest_authorized_at: oldestAuthorized?.started_at ?? null,
            partitions: horizons.rows.map((h) => ({ table: h.table, horizon: h.horizon })),
            nas: { total: Number(nas.total), without_adapter_key: Number(nas.without_adapter_key) },
          };
        }),
      );
      const status = database.ok && redis.ok ? 'ok' : 'degraded';
      return {
        status: 200,
        body: {
          status,
          checked_at: at.toISOString(),
          database: database.ok
            ? { ok: true, latency_ms: database.ms }
            : { ok: false, latency_ms: database.ms, error: database.error },
          redis: redis.ok
            ? { ok: true, latency_ms: redis.ms }
            : { ok: false, latency_ms: redis.ms, error: redis.error },
          queues,
          ...(database.ok ? database.value : {}),
          freeradius: {
            status: 'not_checked',
            detail: 'Status-Server is probed by the infrastructure checks, not by the API process.',
          },
          wireguard: {
            status: 'not_checked',
            detail: 'WireGuard handshakes are host-level (Phase 5 deployment); not probed here.',
          },
        },
      };
    },
  });

  return [roleTemplates, auditLog, health];
}
