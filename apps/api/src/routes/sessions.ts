/**
 * Sessions (Phase 8 P8-A; API_ARCHITECTURE.md "P8-A sessions & accounting API contract"):
 * filtered list, detail with the accounting timeline / anomalies / enforcement rows and the
 * Disconnect / Reauthorize availability, the two operations themselves and action polling.
 *
 * D-006 / D-028 V12: Disconnect and CoA are never "supported" without LAB/PRODUCTION evidence.
 * The operations refuse (409 problem+json with the registry-evidence reason) unless the
 * dispatcher is enabled; with ECLOUD_COA_ENABLED (lab mode) they commit a `session_actions` row
 * the worker enqueues on the existing dispatcher, and the result is still not device-enforced.
 */
import { NotFoundError, newId } from '@ecloud/shared';
import { normalizeMacAddress } from '@ecloud/adapters';
import type { DbTransaction, SessionStatus } from '@ecloud/db';
import { sql, type RawBuilder } from 'kysely';
import { z } from 'zod';
import {
  decodeTimeCursor,
  encodeTimeCursor,
  freshnessOf,
  operationAvailability,
  sessionLastAccounting,
  withDeltas,
  type OperationAvailability,
  type SessionOperation,
} from '../accounting-views.js';
import { writeAudit } from '../audit.js';
import { hitLimitFailOpen } from '../auth/rate-limit.js';
import { evaluate, permittedSites } from '../auth/authorize.js';
import type { AppDeps, RequestContext } from '../context.js';
import { resolveOpenSessionNow } from '../enforcement.js';
import { OrgIdParams, OrgParams, problemResponses } from '../http/common.js';
import { SessionOperationUnavailableError } from '../http/errors.js';
import { defineRoute, type AnyRouteSpec } from '../http/route.js';
import { nasAdapter } from '../nas-adapter.js';
import { inTenant, requireOnSite } from '../tenant.js';

const TAG = ['sessions'];
export const SESSION_STATUSES = ['authorized', 'active', 'stopped', 'stale', 'expired'] as const;
export const TIMELINE_LIMIT = 500;
export const ANOMALY_LIMIT = 100;
export const ENFORCEMENT_LIMIT = 50;

/** `to_char` of a timestamptz as exact UTC text (keyset cursors, microsecond precision). */
export function tsText(ref: string): RawBuilder<string> {
  return sql<string>`to_char(${sql.ref(ref)} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}

const statusList = z
  .string()
  .max(100)
  .transform((v) =>
    v
      .split(',')
      .map((x) => x.trim())
      .filter((x) => x !== ''),
  )
  .pipe(z.array(z.enum(SESSION_STATUSES)).min(1));

const ListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(300).optional(),
  status: statusList.optional(),
  open: z.enum(['true', 'false']).optional(),
  site_id: z.uuid().optional(),
  nas_client_id: z.uuid().optional(),
  user_id: z.uuid().optional(),
  client_device_id: z.uuid().optional(),
  voucher_id: z.uuid().optional(),
  mac: z.string().max(32).optional(),
  username: z.string().min(1).max(253).optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
});

const SessionSummarySchema = z
  .looseObject({
    id: z.string(),
    status: z.enum(SESSION_STATUSES),
    site_id: z.string(),
    site_name: z.string(),
    nas_client_id: z.string(),
    nas_name: z.string(),
    adapter_key: z.string().nullable(),
    coa_supported: z.boolean().nullable(),
    policy_name: z.string().nullable(),
    username_raw: z.string().nullable(),
    mac: z.string().nullable(),
    started_at: z.string(),
    last_interim_at: z.string().nullable(),
    stopped_at: z.string().nullable(),
    input_octets: z.number(),
    output_octets: z.number(),
    bytes_total: z.number(),
    session_time_s: z.number(),
    last_accounting_at: z.string().nullable(),
    freshness_s: z.number().nullable(),
  })
  .meta({
    id: 'SessionSummary',
    description:
      'A session row with NAS / policy / site names and its accounting freshness (P8-A).',
  });

const SessionPageSchema = z
  .object({
    data: z.array(SessionSummarySchema),
    next_cursor: z.string().nullable(),
    measured_at: z.string(),
  })
  .meta({ id: 'SessionPage' });

const EvidenceSchema = z.object({
  status: z.string().nullable(),
  evidence_level: z.string().nullable(),
  device_enforced: z.boolean(),
  declaration: z.string().nullable(),
});

export const OperationAvailabilitySchema = z
  .object({
    operation: z.enum(['disconnect', 'reauthorize']),
    permission: z.enum(['session:disconnect', 'session:coa']),
    permitted: z.boolean(),
    available: z.boolean(),
    mode: z.enum(['validated', 'lab']).nullable(),
    device_enforced: z.boolean(),
    code: z
      .enum([
        'session_not_open',
        'no_adapter',
        'coa_unsupported',
        'nas_coa_disabled',
        'dispatcher_disabled',
      ])
      .nullable(),
    reason: z.string(),
    evidence: EvidenceSchema,
    dispatcher_enabled: z.boolean(),
  })
  .meta({
    id: 'SessionOperationAvailability',
    description:
      'Whether Disconnect / Reauthorize would be accepted now, with the registry-evidence reason (D-006, V12).',
  });

const SessionActionSchema = z
  .object({
    id: z.string(),
    session_id: z.string(),
    action: z.enum(['disconnect', 'coa_update']),
    status: z.enum(['pending', 'sent', 'ack', 'nak', 'timeout', 'unsupported']),
    error: z.string().nullable(),
    payload: z.looseObject({}),
    requested_by: z.string().nullable(),
    request_id: z.string().nullable(),
    created_at: z.string(),
    completed_at: z.string().nullable(),
  })
  .meta({ id: 'SessionAction' });

const AccountingRecordSchema = z
  .looseObject({
    id: z.number(),
    received_at: z.string(),
    event_time: z.string().nullable(),
    status_type: z.enum(['start', 'interim', 'stop', 'accounting_on', 'accounting_off']),
    acct_session_id: z.string(),
    acct_unique_id: z.string(),
    nas_ip: z.string(),
    username: z.string().nullable(),
    calling_station_id: z.string().nullable(),
    input_octets: z.number().nullable(),
    output_octets: z.number().nullable(),
    session_time_s: z.number().nullable(),
    terminate_cause: z.string().nullable(),
    session_id: z.string().nullable(),
  })
  .meta({ id: 'AccountingRecord' });

const SessionDetailSchema = SessionSummarySchema.extend({
  session_actions: z.array(SessionActionSchema),
  nas: z.object({
    id: z.string(),
    name: z.string(),
    nas_ip: z.string(),
    adapter_key: z.string().nullable(),
    coa_supported: z.boolean().nullable(),
  }),
  freshness: z.object({
    measured_at: z.string(),
    last_accounting_at: z.string().nullable(),
    freshness_s: z.number().nullable(),
    expected_lag_s: z.number(),
  }),
  timeline: z.array(
    AccountingRecordSchema.extend({
      delta_input_octets: z.number().nullable(),
      delta_output_octets: z.number().nullable(),
    }),
  ),
  timeline_truncated: z.boolean(),
  anomalies: z.array(z.looseObject({ id: z.string(), kind: z.string(), applied: z.boolean() })),
  enforcement: z.array(
    z.looseObject({ id: z.string(), trigger: z.string(), strategy: z.string(), state: z.string() }),
  ),
  operations: z.object({
    disconnect: OperationAvailabilitySchema,
    reauthorize: OperationAvailabilitySchema,
  }),
}).meta({
  id: 'SessionDetail',
  description:
    'Session with accounting timeline, anomalies, enforcement rows and operation availability (P8-A).',
});

const OperationBody = z.object({ reason: z.string().trim().min(1).max(500).optional() });

const OperationAcceptedSchema = z
  .object({
    session_action: SessionActionSchema,
    deduplicated: z.boolean(),
    mode: z.enum(['validated', 'lab']),
    device_enforced: z.boolean(),
    message: z.string(),
  })
  .meta({ id: 'SessionOperationAccepted' });

const ACTION_COLUMNS = [
  'id',
  'session_id',
  'action',
  'status',
  'error',
  'payload',
  'requested_by',
  'request_id',
  'created_at',
  'completed_at',
] as const;

interface ActionRow {
  id: string;
  session_id: string;
  action: 'disconnect' | 'coa_update';
  status: string;
  error: string | null;
  payload: unknown;
  requested_by: string | null;
  request_id: string | null;
  created_at: Date;
  completed_at: Date | null;
}

/** Public view of a session_actions row; the CoA `plan` (reply attributes) stays server-side. */
export function actionView(a: ActionRow): Record<string, unknown> {
  const payload =
    typeof a.payload === 'object' && a.payload !== null && !Array.isArray(a.payload)
      ? Object.fromEntries(Object.entries(a.payload).filter(([k]) => k !== 'plan'))
      : {};
  return {
    id: a.id,
    session_id: a.session_id,
    action: a.action,
    status: a.status,
    error: a.error,
    payload,
    requested_by: a.requested_by,
    request_id: a.request_id,
    created_at: a.created_at.toISOString(),
    completed_at: a.completed_at?.toISOString() ?? null,
  };
}

interface SessionJoined {
  id: string;
  status: string;
  site_id: string;
  started_at: Date;
  last_interim_at: Date | null;
  stopped_at: Date | null;
  input_octets: number;
  output_octets: number;
  [k: string]: unknown;
}

function summaryOf<T extends SessionJoined>(row: T, now: Date): T & Record<string, unknown> {
  const last = sessionLastAccounting(row);
  const { cursor_ts: _ignored, ...rest } = row as T & { cursor_ts?: string };
  return {
    ...(rest as T),
    bytes_total: Number(row.input_octets) + Number(row.output_octets),
    last_accounting_at: last?.toISOString() ?? null,
    freshness_s:
      last === null ? null : Math.max(0, Math.floor((now.getTime() - last.getTime()) / 1000)),
  };
}

function sessionBase(trx: DbTransaction) {
  return trx
    .selectFrom('sessions as s')
    .innerJoin('nas_clients as n', 'n.id', 's.nas_client_id')
    .innerJoin('sites as st', 'st.id', 's.site_id')
    .leftJoin('policies as p', 'p.id', 's.policy_id')
    .selectAll('s')
    .select([
      'n.name as nas_name',
      'n.nas_ip',
      'n.adapter_key',
      'n.coa_supported',
      'p.name as policy_name',
      'st.name as site_name',
    ]);
}

const OPERATION_PERMISSION = {
  disconnect: 'session:disconnect',
  reauthorize: 'session:coa',
} as const;

export function sessionRoutes(deps: AppDeps): AnyRouteSpec[] {
  const now = () => (deps.now ?? (() => new Date()))();

  const list = defineRoute({
    method: 'get',
    path: '/api/v1/orgs/:orgId/sessions',
    summary: 'List sessions (filters, newest first, keyset cursor, freshness)',
    tags: TAG,
    auth: 'principal',
    permission: 'session:read',
    scope: 'any-site',
    params: OrgParams,
    query: ListQuery,
    responses: { 200: { description: 'Sessions', schema: SessionPageSchema }, ...problemResponses },
    handler: async ({ params, query, ctx }) => {
      const at = now();
      const sites = permittedSites(ctx.principal, 'session:read', params.orgId);
      const cursor = decodeTimeCursor(query.cursor);
      let mac: string | null = null;
      if (query.mac !== undefined) {
        mac = normalizeMacAddress(query.mac);
        if (mac === null) {
          return {
            status: 200,
            body: { data: [], next_cursor: null, measured_at: at.toISOString() },
          };
        }
      }
      const rows =
        sites !== 'all' && sites.length === 0
          ? []
          : await inTenant(deps, params.orgId, (trx) => {
              let q = sessionBase(trx).select(tsText('s.started_at').as('cursor_ts'));
              if (sites !== 'all') q = q.where('s.site_id', 'in', sites);
              const statuses: readonly SessionStatus[] | undefined =
                query.open === 'true' ? ['authorized', 'active'] : query.status;
              if (statuses !== undefined) q = q.where('s.status', 'in', [...statuses]);
              if (query.site_id) q = q.where('s.site_id', '=', query.site_id);
              if (query.nas_client_id) q = q.where('s.nas_client_id', '=', query.nas_client_id);
              if (query.user_id) q = q.where('s.user_id', '=', query.user_id);
              if (query.client_device_id)
                q = q.where('s.client_device_id', '=', query.client_device_id);
              if (query.voucher_id) q = q.where('s.voucher_id', '=', query.voucher_id);
              if (mac !== null) q = q.where('s.mac', '=', mac);
              if (query.username) q = q.where('s.username_raw', '=', query.username);
              if (query.from) q = q.where('s.started_at', '>=', new Date(query.from));
              if (query.to) q = q.where('s.started_at', '<', new Date(query.to));
              if (cursor !== null) {
                q = q.where(
                  sql<boolean>`(s.started_at, s.id) < (${cursor.at}::timestamptz, ${cursor.id}::uuid)`,
                );
              }
              return q
                .orderBy('s.started_at', 'desc')
                .orderBy('s.id', 'desc')
                .limit(query.limit + 1)
                .execute();
            });
      const hasMore = rows.length > query.limit;
      const page = hasMore ? rows.slice(0, query.limit) : rows;
      const last = page[page.length - 1];
      return {
        status: 200,
        body: {
          data: page.map((r) => summaryOf(r, at)),
          next_cursor:
            hasMore && last !== undefined ? encodeTimeCursor(last.cursor_ts, last.id) : null,
          measured_at: at.toISOString(),
        },
      };
    },
  });

  const detail = defineRoute({
    method: 'get',
    path: '/api/v1/orgs/:orgId/sessions/:id',
    summary: 'Session detail: accounting timeline, anomalies, enforcement, operation availability',
    tags: TAG,
    auth: 'principal',
    permission: 'session:read',
    scope: 'any-site',
    params: OrgIdParams,
    responses: {
      200: { description: 'SessionDetail', schema: SessionDetailSchema },
      ...problemResponses,
    },
    handler: async ({ params, ctx }) => {
      const at = now();
      const body = await inTenant(deps, params.orgId, async (trx) => {
        const row = await sessionBase(trx).where('s.id', '=', params.id).executeTakeFirst();
        if (row === undefined) throw new NotFoundError('session', params.id);
        requireOnSite(ctx, 'session:read', params.orgId, row.site_id, 'session');
        // One bounded query per collection (no N+1).
        const [actions, timelineRows, anomalies, enforcement] = await Promise.all([
          trx
            .selectFrom('session_actions')
            .select(ACTION_COLUMNS)
            .where('session_id', '=', row.id)
            .orderBy('created_at')
            .execute(),
          trx
            .selectFrom('accounting_records')
            .select([
              'id',
              'received_at',
              'event_time',
              'status_type',
              'acct_session_id',
              'acct_unique_id',
              'nas_ip',
              'nas_identifier',
              'username',
              'calling_station_id',
              'called_station_id',
              'framed_ip',
              'input_octets',
              'output_octets',
              'session_time_s',
              'terminate_cause',
              'session_id',
              'raw',
            ])
            .where('session_id', '=', row.id)
            // partition pruning: nothing of this session can predate its start by a day
            .where('received_at', '>=', new Date(row.started_at.getTime() - 86_400_000))
            .where('received_at', '<', new Date(at.getTime() + 86_400_000))
            .orderBy('received_at')
            .orderBy('id')
            .limit(TIMELINE_LIMIT + 1)
            .execute(),
          trx
            .selectFrom('accounting_anomalies')
            .select([
              'id',
              'kind',
              'counter',
              'previous',
              'observed',
              'estimated_lost_bytes',
              'applied',
              'reason',
              'created_at',
            ])
            .where('session_id', '=', row.id)
            .orderBy('created_at', 'desc')
            .limit(ANOMALY_LIMIT)
            .execute(),
          trx
            .selectFrom('session_enforcement')
            .select([
              'id',
              'change_id',
              'trigger',
              'strategy',
              'state',
              'reason',
              'policy_id',
              'expected_apply_by',
              'created_at',
              'resolved_at',
              'detail',
            ])
            .where('session_id', '=', row.id)
            .orderBy('created_at', 'desc')
            .limit(ENFORCEMENT_LIMIT)
            .execute(),
        ]);
        const truncated = timelineRows.length > TIMELINE_LIMIT;
        const timeline = withDeltas(
          (truncated ? timelineRows.slice(0, TIMELINE_LIMIT) : timelineRows).map((r) => ({
            ...r,
            input_octets: r.input_octets === null ? null : Number(r.input_octets),
            output_octets: r.output_octets === null ? null : Number(r.output_octets),
          })),
        );
        const ops = (op: SessionOperation): OperationAvailability =>
          operationAvailability({
            operation: op,
            adapterKey: row.adapter_key,
            nasCoaSupported: row.coa_supported,
            sessionStatus: row.status,
            dispatcherEnabled: deps.config.coaEnabled,
            permitted: evaluate(ctx.principal, OPERATION_PERMISSION[op], {
              organizationId: params.orgId,
              siteId: row.site_id,
            }),
          });
        const summary = summaryOf(row, at);
        return {
          ...summary,
          session_actions: actions.map((a) => actionView(a as ActionRow)),
          nas: {
            id: row.nas_client_id,
            name: row.nas_name,
            nas_ip: row.nas_ip,
            adapter_key: row.adapter_key,
            coa_supported: row.coa_supported,
          },
          freshness: freshnessOf(at, sessionLastAccounting(row), deps.config.aaaInterimIntervalS),
          timeline,
          timeline_truncated: truncated,
          anomalies: anomalies.map((a) => ({
            ...a,
            previous: Number(a.previous),
            observed: Number(a.observed),
            estimated_lost_bytes: Number(a.estimated_lost_bytes),
          })),
          enforcement,
          operations: { disconnect: ops('disconnect'), reauthorize: ops('reauthorize') },
        };
      });
      return { status: 200, body };
    },
  });

  function operationRoute(op: SessionOperation): AnyRouteSpec {
    const permission = OPERATION_PERMISSION[op];
    const actionType = op === 'disconnect' ? 'disconnect' : 'coa_update';
    const event = op === 'disconnect' ? 'session.disconnect_requested' : 'session.coa_requested';
    return defineRoute({
      method: 'post',
      path: `/api/v1/orgs/:orgId/sessions/:id/${op}`,
      summary:
        op === 'disconnect'
          ? 'Request a RADIUS Disconnect of a session (refused unless the dispatcher is enabled; D-006)'
          : 'Request a CoA carrying the re-resolved policy (refused unless the dispatcher is enabled; D-006)',
      tags: TAG,
      auth: 'principal',
      permission,
      scope: 'any-site',
      params: OrgIdParams,
      body: OperationBody,
      idempotency: 'optional',
      responses: {
        202: {
          description: 'Action queued (or the open one returned)',
          schema: OperationAcceptedSchema,
        },
        409: {
          description:
            'session-operation-unavailable: refused with `code` and the registry-evidence `reason`',
        },
        429: { description: 'More than 30 refused attempts per minute by this principal' },
        ...problemResponses,
      },
      handler: async ({ params, body, ctx }) => {
        const at = now();
        const outcome = await inTenant(deps, params.orgId, (trx) =>
          requestOperation(trx, deps, ctx, {
            op,
            permission,
            actionType,
            event,
            orgId: params.orgId,
            sessionId: params.id,
            reason: body.reason ?? null,
            now: at,
          }),
        );
        if (outcome.kind === 'refused') {
          throw new SessionOperationUnavailableError(outcome.problem);
        }
        return { status: 202, body: outcome.body };
      },
    });
  }

  const getAction = defineRoute({
    method: 'get',
    path: '/api/v1/orgs/:orgId/session-actions/:id',
    summary: 'Poll a Disconnect / CoA action',
    tags: TAG,
    auth: 'principal',
    permission: 'session:read',
    scope: 'any-site',
    params: OrgIdParams,
    responses: {
      200: { description: 'SessionAction', schema: SessionActionSchema },
      ...problemResponses,
    },
    handler: async ({ params, ctx }) => {
      const body = await inTenant(deps, params.orgId, async (trx) => {
        const a = await trx
          .selectFrom('session_actions as a')
          .innerJoin('sessions as s', 's.id', 'a.session_id')
          .select([
            'a.id',
            'a.session_id',
            'a.action',
            'a.status',
            'a.error',
            'a.payload',
            'a.requested_by',
            'a.request_id',
            'a.created_at',
            'a.completed_at',
            's.site_id',
          ])
          .where('a.id', '=', params.id)
          .executeTakeFirst();
        if (a === undefined) throw new NotFoundError('session_action', params.id);
        requireOnSite(ctx, 'session:read', params.orgId, a.site_id, 'session_action');
        return actionView(a);
      });
      return { status: 200, body };
    },
  });

  return [list, detail, operationRoute('disconnect'), operationRoute('reauthorize'), getAction];
}

type OperationOutcome =
  | { kind: 'accepted'; body: Record<string, unknown> }
  | {
      kind: 'refused';
      problem: { operation: string; code: string; reason: string } & Record<string, unknown>;
    };

interface OperationRequest {
  op: SessionOperation;
  permission: 'session:disconnect' | 'session:coa';
  actionType: 'disconnect' | 'coa_update';
  event: string;
  orgId: string;
  sessionId: string;
  reason: string | null;
  now: Date;
}

/** Refused Disconnect / Reauthorize attempts per principal (audited, so capped). */
export const REFUSED_OPERATION_LIMIT = Object.freeze({ perWindow: 30, windowSeconds: 60 });

function principalKey(ctx: RequestContext): string {
  const p = ctx.principal;
  return p?.kind === 'admin' ? p.administratorId : p?.kind === 'api_key' ? p.apiKeyId : 'anonymous';
}

function actorAdminId(ctx: RequestContext): string | null {
  return ctx.principal?.kind === 'admin' && ctx.principal.impersonation === null
    ? ctx.principal.administratorId
    : null;
}

/**
 * One transaction: lock the session row (serialises concurrent requests for idempotency), gate
 * on evidence, return the open action of the same kind or insert a new pending one, outbox event
 * and audit. A refusal is audited too and committed; the caller then answers 409.
 */
async function requestOperation(
  trx: DbTransaction,
  deps: AppDeps,
  ctx: RequestContext,
  r: OperationRequest,
): Promise<OperationOutcome> {
  const session = await trx
    .selectFrom('sessions')
    .select(['id', 'site_id', 'status', 'nas_client_id'])
    .where('id', '=', r.sessionId)
    .forUpdate()
    .executeTakeFirst();
  if (session === undefined) throw new NotFoundError('session', r.sessionId);
  requireOnSite(ctx, r.permission, r.orgId, session.site_id, 'session', 'session:read');
  const nas = await trx
    .selectFrom('nas_clients')
    .select(['adapter_key', 'coa_supported'])
    .where('id', '=', session.nas_client_id)
    .executeTakeFirstOrThrow();
  const gate = operationAvailability({
    operation: r.op,
    adapterKey: nas.adapter_key,
    nasCoaSupported: nas.coa_supported,
    sessionStatus: session.status,
    dispatcherEnabled: deps.config.coaEnabled,
    permitted: true,
  });

  const refuse = async (code: string, reason: string): Promise<OperationOutcome> => {
    const problem = {
      operation: r.op,
      code,
      reason,
      evidence: gate.evidence,
      dispatcher_enabled: gate.dispatcher_enabled,
    };
    // Refusals are audited; cap them per principal so a script (or a stuck button) cannot flood
    // the audit log. Over the cap: 429 and the transaction rolls back (no audit row).
    await hitLimitFailOpen(
      deps,
      `session-op-refused:${principalKey(ctx)}`,
      REFUSED_OPERATION_LIMIT.perWindow,
      REFUSED_OPERATION_LIMIT.windowSeconds,
    );
    await writeAudit(trx, ctx, {
      organizationId: r.orgId,
      action: `session:${r.op}_refused`,
      targetType: 'session',
      targetId: session.id,
      after: { code, reason, requested_reason: r.reason },
    });
    return { kind: 'refused', problem };
  };

  if (!gate.available || gate.mode === null || gate.code !== null) {
    return refuse(gate.code ?? 'coa_unsupported', gate.reason);
  }

  const open = await trx
    .selectFrom('session_actions')
    .select(ACTION_COLUMNS)
    .where('session_id', '=', session.id)
    .where('action', '=', r.actionType)
    .where('status', 'in', ['pending', 'sent'])
    .orderBy('created_at', 'desc')
    .executeTakeFirst();
  if (open !== undefined) {
    await writeAudit(trx, ctx, {
      organizationId: r.orgId,
      action: `session:${r.op}`,
      targetType: 'session',
      targetId: session.id,
      after: { session_action_id: open.id, deduplicated: true, mode: gate.mode },
    });
    return {
      kind: 'accepted',
      body: {
        session_action: actionView(open),
        deduplicated: true,
        mode: gate.mode,
        device_enforced: gate.device_enforced,
        message: `A ${r.op} request for this session is already ${open.status}.`,
      },
    };
  }

  let plan: unknown = undefined;
  let targetPolicyId: string | null = null;
  if (r.op === 'reauthorize') {
    const resolved = await resolveOpenSessionNow(trx, r.orgId, session.id, r.now);
    if (resolved === null) {
      return refuse(
        'session_not_open',
        'The session is no longer open or its subject cannot be resolved; nothing to reauthorize.',
      );
    }
    const adapter = nasAdapter(nas.adapter_key);
    if (adapter === null) return refuse('no_adapter', gate.reason);
    if (resolved.resolution.decision === 'reject') {
      return refuse(
        'policy_rejects',
        `The current policy rejects this session (${resolved.resolution.reasonCode ?? 'policy_reject'}${resolved.resolution.reasonDetail ? `: ${resolved.resolution.reasonDetail}` : ''}); use Disconnect instead.`,
      );
    }
    const translated = adapter.translate(resolved.resolution.effective, {
      clip: resolved.resolution.clip,
      controls: resolved.resolution.controls,
      now: r.now,
      interimIntervalS: deps.config.aaaInterimIntervalS,
    });
    if (translated.decision === 'reject') {
      return refuse(
        'policy_rejects',
        `The re-resolved policy cannot be enforced on ${nas.adapter_key ?? 'this NAS'} (${translated.reasonCode ?? 'unenforceable'}); use Disconnect instead.`,
      );
    }
    plan = translated;
    targetPolicyId = resolved.resolution.snapshot.policy_id;
  }

  const inserted = await trx
    .insertInto('session_actions')
    .values({
      id: newId(),
      organization_id: r.orgId,
      session_id: session.id,
      action: r.actionType,
      status: 'pending',
      requested_by: actorAdminId(ctx),
      request_id: ctx.requestId,
      payload: JSON.stringify({
        reason: r.reason,
        mode: gate.mode,
        requested_via: 'api',
        trigger: 'admin',
        ...(plan !== undefined ? { plan, policy_id: targetPolicyId } : {}),
      }),
    })
    .returning(ACTION_COLUMNS)
    .executeTakeFirstOrThrow();
  await trx
    .insertInto('outbox')
    .values({
      organization_id: r.orgId,
      event: r.event,
      request_id: ctx.requestId,
      payload: JSON.stringify({
        site_id: session.site_id,
        data: {
          session_id: session.id,
          session_action_id: inserted.id,
          action: r.actionType,
          reason: r.reason ?? 'admin',
          mode: gate.mode,
          device_enforced: gate.device_enforced,
        },
      }),
    })
    .execute();
  await writeAudit(trx, ctx, {
    organizationId: r.orgId,
    action: `session:${r.op}`,
    targetType: 'session',
    targetId: session.id,
    after: {
      session_action_id: inserted.id,
      mode: gate.mode,
      device_enforced: gate.device_enforced,
      reason: r.reason,
      ...(targetPolicyId !== null ? { policy_id: targetPolicyId } : {}),
    },
  });
  return {
    kind: 'accepted',
    body: {
      session_action: actionView(inserted),
      deduplicated: false,
      mode: gate.mode,
      device_enforced: gate.device_enforced,
      message: gate.reason,
    },
  };
}
