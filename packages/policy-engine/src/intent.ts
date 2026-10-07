/**
 * Policy intent model (POLICY_ENGINE.md §1, columns of DATABASE_DESIGN.md §3.4 `policies` and
 * `schedules`). Units: rates kbit/s, sizes bytes (SI), durations seconds, instants `Date` (UTC).
 *
 * Quota columns are PostgreSQL `bigint`; JavaScript `number` is only exact up to 2^53 - 1
 * (about 9 PB), and JSON has no bigint literal. The engine therefore carries quotas as native
 * `bigint` and the schema accepts `bigint | safe integer | decimal string` on input, so API
 * payloads (strings) and DB rows (`pg` returns bigint columns as strings) both parse losslessly.
 * `serializeIntent()` turns them back into decimal strings for JSON snapshots.
 */
import { z } from 'zod';
import { type AdapterFieldStatus, type PolicyField } from '@ecloud/shared';

const DECIMAL_STRING = /^(0|[1-9][0-9]*)$/;
const HHMM = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

/** 32-bit RADIUS integer ceiling (`WISPr-Bandwidth-Max-*` is bit/s = kbps × 1000). */
export const MAX_RATE_KBPS = 4_294_967;
export const RADIUS_UINT32_MAX = 4_294_967_295;
export const MIN_TIMEOUT_S = 60;

const bigintBytes = z
  .union([z.bigint(), z.number().int().safe(), z.string().regex(DECIMAL_STRING)])
  .transform((v) => BigInt(v));

const positiveBigint = bigintBytes.refine((v) => v > 0n, { message: 'must be a positive bigint' });

const instant = z.union([z.date(), z.iso.datetime({ offset: true })]).transform((v) => new Date(v));

export const ScheduleRuleSchema = z.object({
  days: z.array(z.number().int().min(1).max(7)).min(1),
  start: z.string().regex(HHMM, 'HH:MM 24h'),
  end: z.string().regex(HHMM, 'HH:MM 24h'),
});

export const ScheduleSchema = z.object({
  id: z.string().optional(),
  name: z.string().optional(),
  /** IANA zone (`schedules.timezone`); wall-clock rules are evaluated in it. */
  timezone: z.string().min(1),
  rules: z.array(ScheduleRuleSchema).min(1),
});

export type ScheduleRule = z.infer<typeof ScheduleRuleSchema>;
export type Schedule = z.infer<typeof ScheduleSchema>;

export const POLICY_SCOPE_TYPES = ['user', 'group', 'site', 'temporary'] as const;
export const POLICY_STATUSES = ['draft', 'active', 'retired'] as const;
export const CONCURRENCY_MODES = ['reject', 'disconnect_oldest'] as const;

export type PolicyScopeType = (typeof POLICY_SCOPE_TYPES)[number];
export type PolicyStatus = (typeof POLICY_STATUSES)[number];
export type ConcurrencyMode = (typeof CONCURRENCY_MODES)[number];

/**
 * One `policies` row (plus its joined schedule). `null` = inherit from the next layer
 * (POLICY_ENGINE.md §2.3 field-level fall-through).
 */
export const PolicyIntentSchema = z.object({
  id: z.string().min(1),
  organization_id: z.string().min(1),
  site_id: z.string().nullable().default(null),
  name: z.string().min(1).max(200),
  description: z.string().nullable().default(null),
  scope_type: z.enum(POLICY_SCOPE_TYPES),
  status: z.enum(POLICY_STATUSES).default('draft'),
  version: z.number().int().min(1).default(1),
  priority: z.number().int().default(100),
  is_default: z.boolean().default(false),

  download_rate_kbps: z.number().int().nullable().default(null),
  upload_rate_kbps: z.number().int().nullable().default(null),
  burst_download_kbps: z.number().int().nullable().default(null),
  burst_upload_kbps: z.number().int().nullable().default(null),
  burst_duration_s: z.number().int().nullable().default(null),
  quota_daily_bytes: positiveBigint.nullable().default(null),
  quota_monthly_bytes: positiveBigint.nullable().default(null),
  quota_total_bytes: positiveBigint.nullable().default(null),
  session_timeout_s: z.number().int().nullable().default(null),
  idle_timeout_s: z.number().int().nullable().default(null),
  max_concurrent_sessions: z.number().int().nullable().default(null),
  max_devices: z.number().int().nullable().default(null),
  valid_from: instant.nullable().default(null),
  valid_until: instant.nullable().default(null),
  vlan_id: z.number().int().nullable().default(null),
  schedule_id: z.string().nullable().default(null),
  /** Joined `schedules` row when `schedule_id` is set. */
  schedule: ScheduleSchema.nullable().default(null),

  /** §2.6: per-policy override of the tenant default concurrency mode. */
  concurrency_mode: z.enum(CONCURRENCY_MODES).nullable().default(null),
  /** §4.2 field-level override: these fields force `strict_reject` when unenforceable. */
  critical_fields: z.array(z.string()).default([]),
});

export type PolicyIntentInput = z.input<typeof PolicyIntentSchema>;
export type PolicyIntent = z.output<typeof PolicyIntentSchema>;

/** `policies` columns among POLICY_FIELDS (`voucher_validity` lives on the voucher batch). */
export type IntentColumn = Exclude<PolicyField, 'voucher_validity'>;

/** Enforcement-relevant columns only (the ones that fall through layer by layer). */
export type EnforcementFields = Pick<PolicyIntent, IntentColumn>;

export interface IntentValidationIssue {
  /** JSON-pointer-like path, e.g. `download_rate_kbps`, `schedule.rules[0].start`. */
  readonly path: string;
  /** Rule number from POLICY_ENGINE.md §1.3 (0 = schema/type error). */
  readonly rule: number;
  readonly code: string;
  readonly message: string;
}

export interface ValidationContext {
  /** Clock for rule 6 (`valid_until < now` cannot be `active`). Defaults to `new Date()`. */
  readonly now?: Date;
  /** Assignments of this policy, for rule 10 (`temporary` requires `effective_until`). */
  readonly assignments?: readonly { readonly id: string; readonly effective_until: Date | null }[];
  /** Id of the organization's existing default policy, for rule 9 (one per org). */
  readonly existingDefaultPolicyId?: string | null;
  /** `vlan_id` statuses of the adapters behind this policy's assignments, for rule 8 warning. */
  readonly targetAdapterVlanStatuses?: readonly AdapterFieldStatus[];
  /** Stored version of the policy being edited, for rule 11. */
  readonly previous?: PolicyIntent | null;
}

export interface ValidationResult {
  readonly ok: boolean;
  /** Parsed, defaulted intent (present also when rules fail, absent on schema errors). */
  readonly policy?: PolicyIntent;
  readonly errors: readonly IntentValidationIssue[];
  readonly warnings: readonly string[];
}

export const INTENT_COLUMNS: readonly IntentColumn[] = [
  'download_rate_kbps',
  'upload_rate_kbps',
  'burst_download_kbps',
  'burst_upload_kbps',
  'burst_duration_s',
  'quota_daily_bytes',
  'quota_monthly_bytes',
  'quota_total_bytes',
  'session_timeout_s',
  'idle_timeout_s',
  'max_concurrent_sessions',
  'max_devices',
  'valid_from',
  'valid_until',
  'schedule_id',
  'vlan_id',
];

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(0);
    return true;
  } catch {
    return false;
  }
}

function sameInstant(a: Date | null, b: Date | null): boolean {
  return a === null || b === null ? a === b : a.getTime() === b.getTime();
}

/** True when any enforcement column differs between two versions (rule 11). */
export function enforcementFieldsDiffer(a: PolicyIntent, b: PolicyIntent): boolean {
  for (const key of INTENT_COLUMNS) {
    const va = a[key];
    const vb = b[key];
    if (va instanceof Date || vb instanceof Date) {
      if (!sameInstant(va as Date | null, vb as Date | null)) return true;
    } else if (va !== vb) {
      return true;
    }
  }
  return JSON.stringify(a.schedule) !== JSON.stringify(b.schedule);
}

/**
 * Implements the eleven validation rules of POLICY_ENGINE.md §1.3 on top of the zod schema.
 * Pure: no DB access; the caller supplies the context facts the rules need.
 */
export function validatePolicy(input: unknown, context: ValidationContext = {}): ValidationResult {
  const parsed = PolicyIntentSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((issue) => ({
        path: issue.path.map(String).join('.'),
        rule: 0,
        code: 'schema',
        message: issue.message,
      })),
      warnings: [],
    };
  }
  const p = parsed.data;
  const now = context.now ?? new Date();
  const errors: IntentValidationIssue[] = [];
  const warnings: string[] = [];
  const err = (path: string, rule: number, code: string, message: string): void => {
    errors.push({ path, rule, code, message });
  };

  // Rule 1: rates ≥ 1 and ≤ 4 294 967 kbit/s (WISPr bit/s is a 32-bit integer).
  for (const key of ['download_rate_kbps', 'upload_rate_kbps'] as const) {
    const v = p[key];
    if (v === null) continue;
    if (v < 1) err(key, 1, 'rate_not_positive', `${key} must be >= 1 kbit/s when set`);
    else if (v > MAX_RATE_KBPS)
      err(key, 1, 'rate_overflow', `${key} must be <= ${MAX_RATE_KBPS} kbit/s (32-bit bit/s)`);
  }

  // Rule 2: burst ≥ base rate; burst_duration_s required with any burst rate; always a warning.
  const burstSet = p.burst_download_kbps !== null || p.burst_upload_kbps !== null;
  if (p.burst_download_kbps !== null && p.download_rate_kbps !== null) {
    if (p.burst_download_kbps < p.download_rate_kbps)
      err(
        'burst_download_kbps',
        2,
        'burst_below_rate',
        'burst_download_kbps must be >= download_rate_kbps',
      );
  }
  if (p.burst_upload_kbps !== null && p.upload_rate_kbps !== null) {
    if (p.burst_upload_kbps < p.upload_rate_kbps)
      err(
        'burst_upload_kbps',
        2,
        'burst_below_rate',
        'burst_upload_kbps must be >= upload_rate_kbps',
      );
  }
  if (burstSet && p.burst_duration_s === null)
    err(
      'burst_duration_s',
      2,
      'burst_duration_required',
      'burst_duration_s is required when a burst rate is set',
    );
  if (p.burst_duration_s !== null && p.burst_duration_s < 1)
    err('burst_duration_s', 2, 'burst_duration_not_positive', 'burst_duration_s must be >= 1');
  if (burstSet || p.burst_duration_s !== null)
    warnings.push('burst is UNSUPPORTED on all current adapters');

  // Rule 3: positive quotas (schema) and daily ≤ monthly ≤ total.
  if (
    p.quota_daily_bytes !== null &&
    p.quota_monthly_bytes !== null &&
    p.quota_daily_bytes > p.quota_monthly_bytes
  )
    err('quota_daily_bytes', 3, 'quota_order', 'quota_daily_bytes must be <= quota_monthly_bytes');
  if (
    p.quota_monthly_bytes !== null &&
    p.quota_total_bytes !== null &&
    p.quota_monthly_bytes > p.quota_total_bytes
  )
    err(
      'quota_monthly_bytes',
      3,
      'quota_order',
      'quota_monthly_bytes must be <= quota_total_bytes',
    );
  if (
    p.quota_daily_bytes !== null &&
    p.quota_total_bytes !== null &&
    p.quota_daily_bytes > p.quota_total_bytes
  )
    err('quota_daily_bytes', 3, 'quota_order', 'quota_daily_bytes must be <= quota_total_bytes');

  // Rule 4: timers ≥ 60 s.
  for (const key of ['session_timeout_s', 'idle_timeout_s'] as const) {
    const v = p[key];
    if (v !== null && v < MIN_TIMEOUT_S)
      err(key, 4, 'timeout_too_short', `${key} must be >= ${MIN_TIMEOUT_S} s`);
  }

  // Rule 5: concurrency.
  for (const key of ['max_concurrent_sessions', 'max_devices'] as const) {
    const v = p[key];
    if (v !== null && v < 1) err(key, 5, 'not_positive', `${key} must be >= 1`);
  }
  if (
    p.max_concurrent_sessions !== null &&
    p.max_devices !== null &&
    p.max_concurrent_sessions < p.max_devices
  )
    err(
      'max_concurrent_sessions',
      5,
      'sessions_below_devices',
      'max_concurrent_sessions must be >= max_devices',
    );

  // Rule 6: validity window.
  if (
    p.valid_from !== null &&
    p.valid_until !== null &&
    p.valid_until.getTime() <= p.valid_from.getTime()
  )
    err('valid_until', 6, 'validity_window_inverted', 'valid_until must be > valid_from');
  if (p.valid_until !== null && p.status === 'active' && p.valid_until.getTime() < now.getTime())
    err(
      'status',
      6,
      'expired_cannot_be_active',
      'a policy whose valid_until is in the past cannot be active',
    );

  // Rule 7: schedule rules.
  if (p.schedule !== null) {
    if (!isValidTimeZone(p.schedule.timezone))
      err(
        'schedule.timezone',
        7,
        'invalid_timezone',
        `${p.schedule.timezone} is not a valid IANA time zone`,
      );
    p.schedule.rules.forEach((rule, i) => {
      if (rule.start === rule.end)
        err(`schedule.rules[${i}].end`, 7, 'empty_window', 'start and end must differ');
      if (new Set(rule.days).size !== rule.days.length)
        err(`schedule.rules[${i}].days`, 7, 'duplicate_days', 'days must be unique');
    });
  }
  if (p.schedule_id !== null && p.schedule === null)
    err('schedule', 7, 'schedule_missing', 'schedule_id is set but the schedule was not provided');

  // Rule 8: VLAN range + adapter warning.
  if (p.vlan_id !== null) {
    if (p.vlan_id < 1 || p.vlan_id > 4094)
      err('vlan_id', 8, 'vlan_out_of_range', 'vlan_id must be between 1 and 4094');
    if (context.targetAdapterVlanStatuses?.some((s) => s === 'UNSUPPORTED'))
      warnings.push('vlan_id is UNSUPPORTED on at least one adapter targeted by this policy');
  }

  // Rule 9: org default.
  if (p.is_default) {
    if (p.scope_type === 'temporary' || p.scope_type === 'user')
      err(
        'scope_type',
        9,
        'default_scope',
        'an org default policy must have scope_type site or group',
      );
    if (p.site_id !== null)
      err('site_id', 9, 'default_site_bound', 'an org default policy cannot be bound to a site');
    if (context.existingDefaultPolicyId && context.existingDefaultPolicyId !== p.id)
      err('is_default', 9, 'duplicate_default', 'the organization already has a default policy');
  }

  // Rule 10: temporary scope requires bounded assignments.
  if (p.scope_type === 'temporary' && context.assignments) {
    for (const a of context.assignments) {
      if (a.effective_until === null)
        err(
          'assignments',
          10,
          'temporary_unbounded',
          `assignment ${a.id} of a temporary policy must carry effective_until`,
        );
    }
  }

  // Rule 11: versioning / immutability.
  const prev = context.previous;
  if (prev) {
    const changed =
      enforcementFieldsDiffer(prev, p) || prev.priority !== p.priority || prev.status !== p.status;
    if (prev.status === 'retired' && changed)
      err('status', 11, 'retired_immutable', 'retired policies are immutable');
    else if (
      prev.status === 'active' &&
      enforcementFieldsDiffer(prev, p) &&
      p.version <= prev.version
    )
      err(
        'version',
        11,
        'version_bump_required',
        `editing an active policy requires version > ${prev.version}`,
      );
  }

  return { ok: errors.length === 0, policy: p, errors, warnings };
}

/** Extracts only the enforcement columns (the layer-merge inputs). */
export function enforcementFields(p: PolicyIntent): EnforcementFields {
  return {
    download_rate_kbps: p.download_rate_kbps,
    upload_rate_kbps: p.upload_rate_kbps,
    burst_download_kbps: p.burst_download_kbps,
    burst_upload_kbps: p.burst_upload_kbps,
    burst_duration_s: p.burst_duration_s,
    quota_daily_bytes: p.quota_daily_bytes,
    quota_monthly_bytes: p.quota_monthly_bytes,
    quota_total_bytes: p.quota_total_bytes,
    session_timeout_s: p.session_timeout_s,
    idle_timeout_s: p.idle_timeout_s,
    max_concurrent_sessions: p.max_concurrent_sessions,
    max_devices: p.max_devices,
    valid_from: p.valid_from,
    valid_until: p.valid_until,
    schedule_id: p.schedule_id,
    vlan_id: p.vlan_id,
  };
}
