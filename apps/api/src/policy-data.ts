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
  localWeekStartKey,
  type ActiveSessionRef,
  type Candidate,
  type PolicyIntent,
  type ResolutionInput,
  type Subject,
  type UsageCounters,
} from '@ecloud/policy-engine';
import type { Row } from './routes/crud.js';

/** The rate fields a `bandwidth_profiles` row supplies (migration 040). */
export interface BandwidthProfileRates {
  readonly download_rate_kbps: number | null;
  readonly upload_rate_kbps: number | null;
  readonly burst_download_kbps: number | null;
  readonly burst_upload_kbps: number | null;
  readonly burst_duration_s: number | null;
}

/**
 * DB `policies` row (+ optional joined schedule and bandwidth profile) → engine intent.
 *
 * A policy that references a profile may not set its own rates (migration 040 CHECK), so the
 * profile's values are substituted here, before the engine sees the policy. Resolution,
 * translation and every adapter therefore deal in plain numbers and know nothing about
 * profiles — the indirection stops at this function, which is the point of putting it here
 * rather than in the engine.
 *
 * A referenced profile that cannot be loaded leaves the rates null rather than guessing. Null
 * means "inherit from the next layer", which for a rate is the safe direction: a lower layer's
 * cap still applies, and nothing is granted that was not configured.
 */
export function policyRowToIntent(
  row: Row,
  schedule: { id: string; name: string; timezone: string; rules: unknown } | null,
  profile: BandwidthProfileRates | null = null,
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
    download_rate_kbps: profile?.download_rate_kbps ?? row.download_rate_kbps ?? null,
    upload_rate_kbps: profile?.upload_rate_kbps ?? row.upload_rate_kbps ?? null,
    burst_download_kbps: profile?.burst_download_kbps ?? row.burst_download_kbps ?? null,
    burst_upload_kbps: profile?.burst_upload_kbps ?? row.burst_upload_kbps ?? null,
    burst_duration_s: profile?.burst_duration_s ?? row.burst_duration_s ?? null,
    quota_daily_bytes: row.quota_daily_bytes ?? null,
    quota_weekly_bytes: row.quota_weekly_bytes ?? null,
    quota_monthly_bytes: row.quota_monthly_bytes ?? null,
    quota_total_bytes: row.quota_total_bytes ?? null,
    quota_direction: row.quota_direction ?? null,
    online_time_daily_s: row.online_time_daily_s ?? null,
    online_time_weekly_s: row.online_time_weekly_s ?? null,
    online_time_monthly_s: row.online_time_monthly_s ?? null,
    online_time_total_s: row.online_time_total_s ?? null,
    quota_exhaustion_action: row.quota_exhaustion_action ?? null,
    reduced_download_rate_kbps: row.reduced_download_rate_kbps ?? null,
    reduced_upload_rate_kbps: row.reduced_upload_rate_kbps ?? null,
    unlimited_fields: row.unlimited_fields ?? [],
    session_timeout_s: row.session_timeout_s ?? null,
    idle_timeout_s: row.idle_timeout_s ?? null,
    reconnect_cooldown_s: row.reconnect_cooldown_s ?? null,
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

async function loadProfiles(
  trx: DbTransaction,
  ids: readonly string[],
): Promise<Map<string, BandwidthProfileRates>> {
  if (ids.length === 0) return new Map();
  const rows = await trx
    .selectFrom('bandwidth_profiles')
    .select([
      'id',
      'download_rate_kbps',
      'upload_rate_kbps',
      'burst_download_kbps',
      'burst_upload_kbps',
      'burst_duration_s',
    ])
    .where('id', 'in', [...new Set(ids)])
    .where('deleted_at', 'is', null)
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
  const profiles = await loadProfiles(
    trx,
    rows.map((r) => r.bandwidth_profile_id).filter((v): v is string => typeof v === 'string'),
  );
  return rows.map((row) =>
    policyRowToIntent(
      row,
      typeof row.schedule_id === 'string' ? (schedules.get(row.schedule_id) ?? null) : null,
      typeof row.bandwidth_profile_id === 'string'
        ? (profiles.get(row.bandwidth_profile_id) ?? null)
        : null,
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

/**
 * Migration 043's fleet-wide fallback, as a PolicyIntent, or null when it is off.
 *
 * WHY THIS EXISTS AT ALL: until now nothing loaded this row, so `input.platform_default` was
 * undefined on every production path and the resolver's `platform_default` branch was
 * unreachable. The table, the layer, the candidate builder and the trace entry were all in place
 * and inert — and `policyAvailabilityForSites` was already reporting `platform_default` as an
 * availability state, so the Pending list could say a policy would resolve at a site where a real
 * session still got `no_policy`. Loading it here is what makes those two agree.
 *
 * BEHAVIOUR-NEUTRAL UNTIL SOMEONE ENABLES IT. The migration deliberately creates no row, and
 * `enabled` defaults to false, so "not configured" and "switched off" are the same state and both
 * return null here. Turning it on is an operator decision with real consequences — every
 * unassigned access point starts serving guests instead of rejecting them — and it is not one
 * this function makes.
 *
 * The synthetic identity fields are what they are because the row is a singleton with no policy
 * identity of its own: `id` is a stable sentinel so a trace or a provenance record names it
 * recognisably, `organization_id` is the organization being resolved FOR (not an owner, since it
 * has none), and `version` is 1 because the table has no version column. A limit change therefore
 * does not move the version — re-authorization is driven by the snapshot hash, which does change.
 */
export const PLATFORM_DEFAULT_POLICY_ID = 'platform-default';

export async function loadPlatformDefaultPolicy(
  trx: DbTransaction,
  organizationId: string,
): Promise<PolicyIntent | null> {
  const row = await trx.selectFrom('platform_default_policy').selectAll().executeTakeFirst();
  if (row === undefined || row.enabled !== true) return null;
  return PolicyIntentSchema.parse({
    id: PLATFORM_DEFAULT_POLICY_ID,
    organization_id: organizationId,
    site_id: null,
    name: 'Platform default',
    description: row.description === '' ? null : row.description,
    scope_type: 'site',
    status: 'active',
    version: 1,
    // Lowest precedence there is; the resolver injects it at its own layer regardless, so this
    // only matters if someone ever ranks it alongside configured policies.
    priority: Number.MAX_SAFE_INTEGER,
    is_default: false,
    download_rate_kbps: row.download_rate_kbps ?? null,
    upload_rate_kbps: row.upload_rate_kbps ?? null,
    session_timeout_s: row.session_timeout_s ?? null,
    idle_timeout_s: row.idle_timeout_s ?? null,
    quota_daily_bytes: row.quota_daily_bytes ?? null,
    quota_total_bytes: row.quota_total_bytes ?? null,
    online_time_total_s: row.online_time_total_s ?? null,
    max_concurrent_sessions: row.max_concurrent_sessions ?? null,
    max_devices: row.max_devices ?? null,
    valid_from: null,
    valid_until: null,
    schedule: null,
    // No validity window: migration 043 gives this row `enabled` and limits, and nothing else.
    // `enabled` is the whole of its lifecycle, so there is no date to filter against and no
    // reason to take `now`.
  });
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
    const week = localWeekStartKey(facts.now, facts.timeZone);
    const month = `${day.slice(0, 8)}01`;
    const counters = await trx
      .selectFrom('usage_counters')
      .select(['period_type', 'period_start', 'bytes_in', 'bytes_out', 'session_time_s'])
      .where('subject_type', '=', subjectRef.type)
      .where('subject_id', '=', subjectRef.id)
      .where((eb) =>
        eb.or([
          eb.and([eb('period_type', '=', 'daily'), eb('period_start', '=', day)]),
          eb.and([eb('period_type', '=', 'weekly'), eb('period_start', '=', week)]),
          eb.and([eb('period_type', '=', 'monthly'), eb('period_start', '=', month)]),
          eb.and([eb('period_type', '=', 'total'), eb('period_start', '=', '1970-01-01')]),
        ]),
      )
      .execute();
    for (const c of counters) {
      usage[c.period_type] = {
        bytes_in: BigInt(c.bytes_in),
        bytes_out: BigInt(c.bytes_out),
        session_time_s: BigInt(c.session_time_s),
      };
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
    // Reached only when nothing an operator configured applied, so it cannot override a choice.
    // Null whenever the row is absent or disabled, which is every estate until someone enables it.
    platform_default: await loadPlatformDefaultPolicy(trx, facts.organizationId),
    usage,
    active_sessions: activeSessions,
  };
}
