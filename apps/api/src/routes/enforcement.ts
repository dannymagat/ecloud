/**
 * Session enforcement views (Phase 7 P7-A; API_ARCHITECTURE.md "Session-enforcement API
 * contract"): per open session, the policy snapshot resolved at authorize, the attributes
 * actually sent, each field's D-028 status, registry evidence level and V12 device_enforced flag,
 * and the pending change strategy. Read-only; permission `session:read`, site-filtered.
 *
 * `device_enforced` is true only for VERIFIED_SUPPORTED + LAB/PRODUCTION evidence with a DT
 * reference (registry) AND an attribute actually sent — never today (no DT has validated a cell).
 */
import {
  dynamicAuthorizationEvidence,
  fieldEvidence,
  getAdapter,
  isAdapterKey,
} from '@ecloud/adapters';
import { triggersOf, type DbTransaction } from '@ecloud/db';
import {
  chooseEnforcementStrategy,
  expectedReauthBy,
  type AdapterCapabilities,
} from '@ecloud/policy-engine';
import { NotFoundError, POLICY_FIELDS, type AdapterFieldStatus } from '@ecloud/shared';
import { z } from 'zod';
import { permittedSites } from '../auth/authorize.js';
import type { AppDeps } from '../context.js';
import {
  OrgIdParams,
  OrgParams,
  PageSchema,
  PaginationQuery,
  decodeCursor,
  problemResponses,
  toPage,
} from '../http/common.js';
import { defineRoute, type AnyRouteSpec } from '../http/route.js';
import {
  loadAuthorizeSnapshots,
  sessionTimeoutSent,
  type AuthorizeSnapshot,
} from '../enforcement.js';
import { inTenant, requireOnSite } from '../tenant.js';

const TAG = ['sessions'];
const STATE = z.enum(['pending', 'applied', 'unsupported', 'superseded']);
const HISTORY_LIMIT = 20;

function capsOf(adapterKey: string | null): AdapterCapabilities | null {
  return adapterKey !== null && isAdapterKey(adapterKey)
    ? getAdapter(adapterKey).capabilities()
    : null;
}

function effectiveFields(snapshot: AuthorizeSnapshot | undefined): Record<string, unknown> {
  const fields = snapshot?.effective?.fields;
  return typeof fields === 'object' && fields !== null ? (fields as Record<string, unknown>) : {};
}

const QUOTA_FIELDS = ['quota_daily_bytes', 'quota_monthly_bytes', 'quota_total_bytes'];

/**
 * Policy fields a reply attribute carries for an adapter. `policy_translations.emitted` stores the
 * RADIUS reply (name, value, vendor) only, so the mapping comes from the adapter declaration.
 */
export function fieldsForAttribute(caps: AdapterCapabilities | null, name: string): string[] {
  if (caps === null) return [];
  const out: string[] = [];
  for (const family of caps.rateFamilies) {
    if (family.down === name) out.push('download_rate_kbps');
    if (family.up === name) out.push('upload_rate_kbps');
  }
  if (Object.values(caps.quotaAttributes).includes(name)) out.push(...QUOTA_FIELDS);
  if (caps.sessionTimeoutAttr === name)
    out.push('session_timeout_s', 'valid_until', 'voucher_validity', 'schedule_id');
  if (caps.idleTimeoutAttr === name) out.push('idle_timeout_s');
  if (caps.vlanAttrs.includes(name)) out.push('vlan_id');
  return [...new Set(out)];
}

interface FieldView {
  field: string;
  value: unknown;
  set: boolean;
  status: AdapterFieldStatus;
  evidence: string;
  evidence_level: string | null;
  device_enforced: boolean;
  mechanism: 'radius' | 'ecloud_side' | 'none' | 'not_set';
  attributes: string[];
  amber: boolean;
  detail?: string;
}

/** Per-field view of a session's authorize snapshot against its adapter declaration. */
export function fieldViews(
  adapterKey: string | null,
  snapshot: AuthorizeSnapshot | undefined,
): FieldView[] {
  const caps = capsOf(adapterKey);
  const values = effectiveFields(snapshot);
  const emitted = snapshot?.emitted ?? [];
  const unsupported = snapshot?.unsupported ?? [];
  return POLICY_FIELDS.map((field) => {
    const raw = values[field];
    const value = raw === undefined ? null : raw;
    const set = value !== null;
    const decl = caps?.fields[field];
    const status: AdapterFieldStatus = decl?.status ?? 'UNSUPPORTED';
    const ev =
      caps === null || adapterKey === null
        ? { evidenceLevel: null, deviceEnforced: false }
        : fieldEvidence(adapterKey, field, status);
    const attributes = emitted
      .filter(
        (a) =>
          typeof a.name === 'string' &&
          a.experimental !== true &&
          fieldsForAttribute(caps, a.name).includes(field),
      )
      .map((a) => String(a.name));
    const mechanism: FieldView['mechanism'] = !set
      ? 'not_set'
      : attributes.length > 0
        ? 'radius'
        : status === 'ECLOUD_SIDE_ONLY'
          ? 'ecloud_side'
          : 'none';
    const flagged = unsupported.find((u) => u.field === field);
    const detail =
      caps === null
        ? 'NAS has no engine adapter: no policy attributes are sent'
        : typeof flagged?.detail === 'string'
          ? flagged.detail
          : undefined;
    return {
      field,
      value,
      set,
      status,
      evidence: decl?.evidence ?? 'no adapter declaration',
      evidence_level: ev.evidenceLevel,
      device_enforced: set && ev.deviceEnforced && attributes.length > 0,
      mechanism,
      attributes,
      amber: set && (status === 'REQUIRES_DEVICE_TEST' || status === 'ECLOUD_SIDE_ONLY'),
      ...(set && detail !== undefined ? { detail } : {}),
    };
  });
}

interface EnforcementRow {
  id: string;
  change_id: string;
  trigger: string;
  strategy: string;
  state: string;
  reason: string;
  policy_id: string | null;
  expected_apply_by: Date | null;
  created_at: Date;
  resolved_at: Date | null;
  detail: unknown;
}

/**
 * Plain meaning of each stored state (review fix 6). `applied` does NOT mean a device applied
 * anything: the session ended, and the next login is resolved with the current policy.
 */
export const STATE_MEANING: Readonly<Record<string, string>> = {
  pending: 'waiting: the session still runs with the policy it was authorized with',
  applied: 'session ended; the next login uses the current policy (no device confirmation)',
  unsupported: 'cannot be applied: the NAS has no engine adapter',
  superseded: 'replaced by a newer change, or the session is back to its authorized policy',
};

function detailOf(r: EnforcementRow): Record<string, unknown> {
  return typeof r.detail === 'object' && r.detail !== null
    ? (r.detail as Record<string, unknown>)
    : {};
}

function change(r: EnforcementRow): Record<string, unknown> {
  const d = detailOf(r);
  return {
    id: r.id,
    change_id: r.change_id,
    trigger: r.trigger,
    triggers: triggersOf(r.trigger, d),
    strategy: r.strategy,
    state: r.state,
    state_meaning: STATE_MEANING[r.state] ?? r.state,
    resolution: typeof d.resolution === 'string' ? d.resolution : null,
    unevaluated: d.unevaluated === true,
    reason: r.reason,
    policy_id: r.policy_id,
    expected_apply_by: r.expected_apply_by?.toISOString() ?? null,
    created_at: r.created_at.toISOString(),
    resolved_at: r.resolved_at?.toISOString() ?? null,
  };
}

async function pendingBySession(
  trx: DbTransaction,
  ids: readonly string[],
): Promise<Map<string, EnforcementRow>> {
  if (ids.length === 0) return new Map();
  const rows = await trx
    .selectFrom('session_enforcement')
    .select([
      'id',
      'session_id',
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
    .where('session_id', 'in', [...ids])
    .where('state', '=', 'pending')
    .execute();
  return new Map(rows.map((r) => [r.session_id, r]));
}

const ChangeSchema = z
  .object({
    id: z.string(),
    change_id: z.string(),
    trigger: z.string(),
    triggers: z.array(z.string()),
    strategy: z.string(),
    state: STATE,
    state_meaning: z.string(),
    resolution: z.string().nullable(),
    unevaluated: z.boolean(),
    reason: z.string(),
    policy_id: z.string().nullable(),
    expected_apply_by: z.string().nullable(),
    created_at: z.string(),
    resolved_at: z.string().nullable(),
  })
  .meta({ id: 'EnforcementChange' });

const MechanismSchema = z.object({
  status: z.string(),
  evidence_level: z.string().nullable(),
  device_enforced: z.boolean(),
});

const ViewSchema = z
  .looseObject({
    session_id: z.string(),
    status: z.string(),
    adapter_key: z.string().nullable(),
    snapshot: z.looseObject({}).nullable(),
    attributes_sent: z.array(z.looseObject({ name: z.string(), device_enforced: z.boolean() })),
    fields: z.array(
      z.looseObject({
        field: z.string(),
        status: z.string(),
        evidence_level: z.string().nullable(),
        device_enforced: z.boolean(),
        amber: z.boolean(),
      }),
    ),
    session_timeout: z.object({
      value_s: z.number().nullable(),
      sent: z.boolean(),
      expected_reauth_by: z.string().nullable(),
    }),
    strategy_evidence: z.object({
      coa_change: MechanismSchema.nullable(),
      disconnect: MechanismSchema.nullable(),
      dispatcher_enabled: z.boolean(),
      strategy: z.string(),
    }),
    pending_change: ChangeSchema.nullable(),
    history: z.array(ChangeSchema),
    counter_anomalies: z.array(z.looseObject({ id: z.string(), applied: z.boolean() })),
  })
  .meta({
    id: 'SessionEnforcementView',
    description:
      'Effective policy snapshot, attributes sent, per-field evidence and the pending change strategy of one session (P7-A).',
  });

function mechanismView(
  m: { status: string; evidenceLevel: string | null; deviceEnforced: boolean } | null,
): Record<string, unknown> | null {
  return m === null
    ? null
    : { status: m.status, evidence_level: m.evidenceLevel, device_enforced: m.deviceEnforced };
}

export function enforcementRoutes(deps: AppDeps): AnyRouteSpec[] {
  const list = defineRoute({
    method: 'get',
    path: '/api/v1/orgs/:orgId/session-enforcement',
    summary: 'Sessions with their enforcement summary (pending change, amber fields)',
    tags: TAG,
    auth: 'principal',
    permission: 'session:read',
    scope: 'any-site',
    params: OrgParams,
    query: PaginationQuery.extend({
      site_id: z.uuid().optional(),
      state: STATE.optional(),
      open_only: z.enum(['true', 'false']).default('true'),
    }),
    responses: {
      200: { description: 'SessionEnforcementSummary page', schema: PageSchema },
      ...problemResponses,
    },
    handler: async ({ params, query, ctx }) => {
      const sites = permittedSites(ctx.principal, 'session:read', params.orgId);
      const cursor = decodeCursor(query.cursor);
      const page = await inTenant(deps, params.orgId, async (trx) => {
        if (sites !== 'all' && sites.length === 0) return toPage([], query.limit, () => '');
        let q = trx
          .selectFrom('sessions as s')
          .innerJoin('nas_clients as n', 'n.id', 's.nas_client_id')
          .leftJoin('policies as p', 'p.id', 's.policy_id')
          .select([
            's.id',
            's.status',
            's.site_id',
            's.nas_client_id',
            'n.adapter_key',
            's.username_raw',
            's.mac',
            's.started_at',
            's.policy_id',
            'p.name as policy_name',
            's.policy_version',
          ]);
        if (sites !== 'all') q = q.where('s.site_id', 'in', sites);
        if (query.site_id) q = q.where('s.site_id', '=', query.site_id);
        if (query.open_only === 'true') q = q.where('s.status', 'in', ['authorized', 'active']);
        if (query.state) {
          const state = query.state;
          q = q.where((eb) =>
            eb.exists(
              eb
                .selectFrom('session_enforcement as e')
                .select('e.id')
                .whereRef('e.session_id', '=', 's.id')
                .where('e.state', '=', state),
            ),
          );
        }
        if (typeof cursor === 'string') q = q.where('s.id', '<', cursor);
        const rows = await q
          .orderBy('s.id', 'desc')
          .limit(query.limit + 1)
          .execute();
        const ids = rows.map((r) => r.id);
        const [snapshots, pending] = await Promise.all([
          loadAuthorizeSnapshots(trx, ids),
          pendingBySession(trx, ids),
        ]);
        const data = rows.map((r) => {
          const fields = fieldViews(r.adapter_key, snapshots.get(r.id));
          const p = pending.get(r.id);
          return {
            session_id: r.id,
            status: r.status,
            site_id: r.site_id,
            nas_client_id: r.nas_client_id,
            adapter_key: r.adapter_key,
            username: r.username_raw,
            mac: r.mac,
            started_at: r.started_at.toISOString(),
            policy_id: r.policy_id,
            policy_name: r.policy_name,
            policy_version: r.policy_version,
            pending_change: p === undefined ? null : change(p),
            amber_fields: fields.filter((f) => f.amber).map((f) => f.field),
            unsupported_fields: fields
              .filter((f) => f.set && f.status === 'UNSUPPORTED')
              .map((f) => f.field),
            device_enforced_fields: fields.filter((f) => f.device_enforced).map((f) => f.field),
          };
        });
        return toPage(data, query.limit, (r) => r.session_id);
      });
      return { status: 200, body: page };
    },
  });

  const view = defineRoute({
    method: 'get',
    path: '/api/v1/orgs/:orgId/sessions/:id/enforcement',
    summary: 'Enforcement view of one session: snapshot, attributes sent, evidence, pending change',
    tags: TAG,
    auth: 'principal',
    permission: 'session:read',
    scope: 'any-site',
    params: OrgIdParams,
    responses: {
      200: { description: 'SessionEnforcementView', schema: ViewSchema },
      ...problemResponses,
    },
    handler: async ({ params, ctx }) => {
      const body = await inTenant(deps, params.orgId, async (trx) => {
        const s = await trx
          .selectFrom('sessions as s')
          .innerJoin('nas_clients as n', 'n.id', 's.nas_client_id')
          .select([
            's.id',
            's.status',
            's.site_id',
            's.nas_client_id',
            's.started_at',
            's.policy_id',
            's.policy_version',
            'n.adapter_key',
          ])
          .where('s.id', '=', params.id)
          .executeTakeFirst();
        if (s === undefined) throw new NotFoundError('session', params.id);
        requireOnSite(ctx, 'session:read', params.orgId, s.site_id, 'session');
        const snapshot = (await loadAuthorizeSnapshots(trx, [s.id])).get(s.id);
        const caps = capsOf(s.adapter_key);
        const history = (await trx
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
          .where('session_id', '=', s.id)
          .orderBy('created_at', 'desc')
          .limit(HISTORY_LIMIT)
          .execute()) as EnforcementRow[];
        const anomalies = await trx
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
          .where('session_id', '=', s.id)
          .orderBy('created_at', 'desc')
          .limit(HISTORY_LIMIT)
          .execute();
        const evidence = dynamicAuthorizationEvidence(caps === null ? null : s.adapter_key);
        const strategy = chooseEnforcementStrategy({
          adapterKey: evidence === null ? null : s.adapter_key,
          coaChange: evidence?.coaChange ?? null,
          disconnect: evidence?.disconnect ?? null,
          dispatcherEnabled: deps.config.coaEnabled,
        });
        const timeout = sessionTimeoutSent(snapshot);
        const effective = snapshot?.effective ?? null;
        return {
          session_id: s.id,
          status: s.status,
          site_id: s.site_id,
          nas_client_id: s.nas_client_id,
          adapter_key: s.adapter_key,
          adapter_version: snapshot?.adapterVersion ?? null,
          snapshot:
            snapshot === undefined
              ? null
              : {
                  policy_id: snapshot.policyId,
                  policy_version: snapshot.policyVersion,
                  hash: snapshot.hash,
                  authorized_at: snapshot.createdAt.toISOString(),
                  effective: {
                    ...effectiveFields(snapshot),
                    schedule: effective?.schedule ?? null,
                  },
                },
          attributes_sent: (snapshot?.emitted ?? []).map((a) => ({
            name: a.name,
            value: a.value,
            // `field` (first policy field carried, or null) as published in the contract for
            // P7-B; `fields` lists every policy field the attribute carries.
            field:
              typeof a.name === 'string' ? (fieldsForAttribute(caps, a.name)[0] ?? null) : null,
            fields: typeof a.name === 'string' ? fieldsForAttribute(caps, a.name) : [],
            status:
              caps !== null && typeof a.name === 'string'
                ? (caps.attributes[a.name]?.status ?? null)
                : null,
            // Reply attributes are not registry cells: the level is the adapter declaration's;
            // no attribute is device-enforced (no device test covers one), V12.
            evidence_level:
              caps !== null && typeof a.name === 'string'
                ? (caps.attributes[a.name]?.evidenceLevel ?? null)
                : null,
            device_enforced: false,
            ...(a.experimental === true ? { experimental: true } : {}),
          })),
          fields: fieldViews(s.adapter_key, snapshot),
          unenforceable: snapshot?.unsupported ?? [],
          session_timeout: {
            value_s: timeout,
            sent: timeout !== null,
            expected_reauth_by: expectedReauthBy(s.started_at, timeout)?.toISOString() ?? null,
          },
          strategy_evidence: {
            coa_change: mechanismView(evidence?.coaChange ?? null),
            disconnect: mechanismView(evidence?.disconnect ?? null),
            dispatcher_enabled: deps.config.coaEnabled,
            strategy: strategy.strategy,
          },
          pending_change: (() => {
            const p = history.find((h) => h.state === 'pending');
            return p === undefined ? null : change(p);
          })(),
          history: history.map(change),
          counter_anomalies: anomalies.map((a) => ({
            id: a.id,
            kind: a.kind,
            counter: a.counter,
            previous: Number(a.previous),
            observed: Number(a.observed),
            estimated_lost_bytes: Number(a.estimated_lost_bytes),
            applied: a.applied,
            reason: a.reason,
            created_at: a.created_at.toISOString(),
          })),
        };
      });
      return { status: 200, body };
    },
  });

  return [list, view];
}
