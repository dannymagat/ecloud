/**
 * Loads the facts `resolveEffectivePolicy` needs (POLICY_ENGINE.md §2) from the tenant
 * database: candidate assignments + policies (+ schedules), the organization default policy,
 * usage counters and active sessions. Shared by AAA authorize and the simulate endpoint.
 * Must run inside `withTenant()` (RLS scopes every query).
 */
import type { DbTransaction } from '@ecloud/db';
import {
  PolicyIntentSchema,
  localDateKey,
  type ActiveSessionRef,
  type Candidate,
  type PolicyIntent,
  type ResolutionInput,
  type Subject,
  type UsageCounters,
} from '@ecloud/policy-engine';
import type { Row } from './routes/crud.js';

/** DB `policies` row (+ optional joined schedule) → engine intent. */
export function policyRowToIntent(
  row: Row,
  schedule: { id: string; name: string; timezone: string; rules: unknown } | null,
): PolicyIntent {
  return PolicyIntentSchema.parse({
    id: row.id,
    organization_id: row.organization_id,
    site_id: row.site_id ?? null,
    name: row.name,
    description: row.description ?? null,
    scope_type: row.scope_type,
    status: row.status,
    version: row.version,
    priority: row.priority,
    is_default: row.is_default,
    download_rate_kbps: row.download_rate_kbps ?? null,
    upload_rate_kbps: row.upload_rate_kbps ?? null,
    burst_download_kbps: row.burst_download_kbps ?? null,
    burst_upload_kbps: row.burst_upload_kbps ?? null,
    burst_duration_s: row.burst_duration_s ?? null,
    quota_daily_bytes: row.quota_daily_bytes ?? null,
    quota_monthly_bytes: row.quota_monthly_bytes ?? null,
    quota_total_bytes: row.quota_total_bytes ?? null,
    session_timeout_s: row.session_timeout_s ?? null,
    idle_timeout_s: row.idle_timeout_s ?? null,
    max_concurrent_sessions: row.max_concurrent_sessions ?? null,
    max_devices: row.max_devices ?? null,
    valid_from: row.valid_from ?? null,
    valid_until: row.valid_until ?? null,
    vlan_id: row.vlan_id ?? null,
    schedule_id: row.schedule_id ?? null,
    schedule,
  });
}

async function loadSchedules(
  trx: DbTransaction,
  ids: readonly string[],
): Promise<Map<string, { id: string; name: string; timezone: string; rules: unknown }>> {
  if (ids.length === 0) return new Map();
  const rows = await trx
    .selectFrom('schedules')
    .select(['id', 'name', 'timezone', 'rules'])
    .where('id', 'in', [...new Set(ids)])
    .execute();
  return new Map(rows.map((r) => [r.id, r]));
}

export async function intentsFor(
  trx: DbTransaction,
  rows: readonly Row[],
): Promise<PolicyIntent[]> {
  const schedules = await loadSchedules(
    trx,
    rows.map((r) => r.schedule_id).filter((v): v is string => typeof v === 'string'),
  );
  return rows.map((row) =>
    policyRowToIntent(
      row,
      typeof row.schedule_id === 'string' ? (schedules.get(row.schedule_id) ?? null) : null,
    ),
  );
}

export interface ResolutionFacts {
  organizationId: string;
  siteId: string | null;
  timeZone: string;
  now: Date;
  subject: Subject;
  clientDeviceId: string | null;
  mac: string | null;
  groupIds: string[];
  voucherBatchId: string | null;
}

export async function loadResolutionInput(
  trx: DbTransaction,
  facts: ResolutionFacts,
): Promise<ResolutionInput> {
  const userId =
    facts.subject.kind === 'user'
      ? facts.subject.user_id
      : facts.subject.kind === 'voucher'
        ? facts.subject.user_id
        : null;

  const assignments = await trx
    .selectFrom('policy_assignments as a')
    .innerJoin('policies as p', 'p.id', 'a.policy_id')
    .selectAll('a')
    .where('p.deleted_at', 'is', null)
    .where((eb) =>
      eb.or([eb('a.effective_until', 'is', null), eb('a.effective_until', '>', facts.now)]),
    )
    .where((eb) => {
      const ors = [];
      if (facts.siteId !== null) {
        ors.push(eb.and([eb('a.target_type', '=', 'site'), eb('a.site_id', '=', facts.siteId)]));
      }
      if (userId !== null) {
        ors.push(eb.and([eb('a.target_type', '=', 'user'), eb('a.user_id', '=', userId)]));
      }
      if (facts.groupIds.length > 0) {
        ors.push(
          eb.and([
            eb('a.target_type', '=', 'user_group'),
            eb('a.user_group_id', 'in', facts.groupIds),
          ]),
        );
      }
      if (facts.clientDeviceId !== null) {
        ors.push(
          eb.and([
            eb('a.target_type', '=', 'client_device'),
            eb('a.client_device_id', '=', facts.clientDeviceId),
          ]),
        );
      }
      if (facts.voucherBatchId !== null) {
        ors.push(
          eb.and([
            eb('a.target_type', '=', 'voucher_batch'),
            eb('a.voucher_batch_id', '=', facts.voucherBatchId),
          ]),
        );
      }
      return ors.length === 0 ? eb.val(false) : eb.or(ors);
    })
    .execute();

  const policyIds = [...new Set(assignments.map((a) => a.policy_id))];
  const policyRows =
    policyIds.length === 0
      ? []
      : await trx.selectFrom('policies').selectAll().where('id', 'in', policyIds).execute();
  const intents = await intentsFor(trx, policyRows);
  const byId = new Map(intents.map((p) => [p.id, p]));
  const candidates: Candidate[] = [];
  for (const a of assignments) {
    const policy = byId.get(a.policy_id);
    if (policy === undefined) continue;
    candidates.push({
      assignment: {
        id: a.id,
        policy_id: a.policy_id,
        target_type: a.target_type,
        user_id: a.user_id,
        user_group_id: a.user_group_id,
        site_id: a.site_id,
        client_device_id: a.client_device_id,
        voucher_batch_id: a.voucher_batch_id,
        effective_from: a.effective_from,
        effective_until: a.effective_until,
        priority: a.priority,
      },
      policy,
    });
  }

  const defaultRow = await trx
    .selectFrom('policies')
    .selectAll()
    .where('is_default', '=', true)
    .where('deleted_at', 'is', null)
    .executeTakeFirst();
  const [defaultPolicy] = defaultRow === undefined ? [null] : await intentsFor(trx, [defaultRow]);

  const subjectRef =
    facts.subject.kind === 'user'
      ? { type: 'user' as const, id: facts.subject.user_id }
      : facts.subject.kind === 'client_device'
        ? { type: 'client_device' as const, id: facts.subject.client_device_id }
        : facts.subject.user_id !== null
          ? { type: 'user' as const, id: facts.subject.user_id }
          : null;
  const usage: UsageCounters = {};
  if (subjectRef !== null) {
    const day = localDateKey(facts.now, facts.timeZone);
    const month = `${day.slice(0, 8)}01`;
    const counters = await trx
      .selectFrom('usage_counters')
      .select(['period_type', 'period_start', 'bytes_in', 'bytes_out'])
      .where('subject_type', '=', subjectRef.type)
      .where('subject_id', '=', subjectRef.id)
      .where((eb) =>
        eb.or([
          eb.and([eb('period_type', '=', 'daily'), eb('period_start', '=', day)]),
          eb.and([eb('period_type', '=', 'monthly'), eb('period_start', '=', month)]),
          eb.and([eb('period_type', '=', 'total'), eb('period_start', '=', '1970-01-01')]),
        ]),
      )
      .execute();
    for (const c of counters) {
      usage[c.period_type] = { bytes_in: BigInt(c.bytes_in), bytes_out: BigInt(c.bytes_out) };
    }
  }

  let activeSessions: ActiveSessionRef[] = [];
  if (userId !== null || facts.clientDeviceId !== null) {
    const rows = await trx
      .selectFrom('sessions')
      .select([
        'id',
        'mac',
        'user_id',
        'client_device_id',
        'started_at',
        'last_interim_at',
        'nas_client_id',
      ])
      // D-036: an authorized session (Accept sent, accounting not yet seen) occupies a slot.
      .where('status', 'in', ['authorized', 'active'])
      .where((eb) => {
        const ors = [];
        if (userId !== null) ors.push(eb('user_id', '=', userId));
        if (facts.clientDeviceId !== null)
          ors.push(eb('client_device_id', '=', facts.clientDeviceId));
        return eb.or(ors);
      })
      .execute();
    activeSessions = rows.map((s) => ({
      id: s.id,
      mac: s.mac ?? '',
      user_id: s.user_id,
      client_device_id: s.client_device_id,
      started_at: s.started_at,
      last_update_at: s.last_interim_at,
      nas_client_id: s.nas_client_id,
    }));
  }

  return {
    now: facts.now,
    timeZone: facts.timeZone,
    organization_id: facts.organizationId,
    site_id: facts.siteId,
    subject: facts.subject,
    client_device_id: facts.clientDeviceId,
    mac: facts.mac,
    group_ids: facts.groupIds,
    candidates,
    default_policy: defaultPolicy ?? null,
    usage,
    active_sessions: activeSessions,
  };
}
