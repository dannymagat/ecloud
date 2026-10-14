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

/**
 * Which octets the data quotas count (migration 036), named from the client's perspective like
 * every other rate here: `upload` is Acct-Input-Octets, `download` is Acct-Output-Octets.
 */
export const QUOTA_DIRECTIONS = ['combined', 'upload', 'download'] as const;

export type PolicyScopeType = (typeof POLICY_SCOPE_TYPES)[number];
export type PolicyStatus = (typeof POLICY_STATUSES)[number];
export type ConcurrencyMode = (typeof CONCURRENCY_MODES)[number];
export type QuotaDirection = (typeof QUOTA_DIRECTIONS)[number];

/** Accounting periods a quota can be expressed over (migration 036 added `weekly`). */
export const QUOTA_PERIODS = ['daily', 'weekly', 'monthly', 'total'] as const;

/**
 * What an exhausted data or online-time allowance does (migration 037). `deny` when no layer
 * sets one, which is the behaviour every policy had before the column existed.
 */
export const QUOTA_EXHAUSTION_ACTIONS = ['deny', 'reduce_speed', 'require_renewal'] as const;
export type QuotaExhaustionAction = (typeof QUOTA_EXHAUSTION_ACTIONS)[number];

/**
 * Fields a policy may declare unlimited (migration 039), i.e. where "no cap" is a meaningful
 * answer. `vlan_id` has no unlimited state, the quota modifiers are not limits, and `valid_from`
 * is a start rather than a cap. `valid_until` and `schedule_id` are here because "never expires"
 * and "no time restriction" are the things an operator needs to say about one account inside an
 * otherwise restricted group.
 *
 * `reconnect_cooldown_s` (migration 044) is deliberately absent: migration 039's SQL CHECK
 * enumerates this list, so adding it here without extending that constraint would let the API
 * accept a declaration the database then rejects. Extending it is a migration nobody has asked
 * for yet, and a child that needs no cooldown can be given one of 1 second.
 */
export const UNLIMITABLE_FIELDS = [
  'download_rate_kbps',
  'upload_rate_kbps',
  'burst_download_kbps',
  'burst_upload_kbps',
  'burst_duration_s',
  'quota_daily_bytes',
  'quota_weekly_bytes',
  'quota_monthly_bytes',
  'quota_total_bytes',
  'online_time_daily_s',
  'online_time_weekly_s',
  'online_time_monthly_s',
  'online_time_total_s',
  'session_timeout_s',
  'idle_timeout_s',
  'max_concurrent_sessions',
  'max_devices',
  'valid_until',
  'schedule_id',
] as const;
export type UnlimitableField = (typeof UNLIMITABLE_FIELDS)[number];

export function isUnlimitableField(value: unknown): value is UnlimitableField {
  return typeof value === 'string' && (UNLIMITABLE_FIELDS as readonly string[]).includes(value);
}

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
  quota_weekly_bytes: positiveBigint.nullable().default(null),
  quota_monthly_bytes: positiveBigint.nullable().default(null),
  quota_total_bytes: positiveBigint.nullable().default(null),
  /** null = inherit; the engine falls back to `combined` when no layer sets one. */
  quota_direction: z.enum(QUOTA_DIRECTIONS).nullable().default(null),
  /**
   * Cumulative connected seconds per period. Distinct from `valid_until` (eligibility window)
   * and `session_timeout_s` (one connection): this is time actually spent online, summed across
   * a subject's devices, and it is enforced EZECLOUD-side by clipping Session-Timeout.
   */
  online_time_daily_s: z.number().int().nullable().default(null),
  online_time_weekly_s: z.number().int().nullable().default(null),
  online_time_monthly_s: z.number().int().nullable().default(null),
  online_time_total_s: z.number().int().nullable().default(null),
  quota_exhaustion_action: z.enum(QUOTA_EXHAUSTION_ACTIONS).nullable().default(null),
  /** Rates used after exhaustion when the action is `reduce_speed`. */
  reduced_download_rate_kbps: z.number().int().nullable().default(null),
  reduced_upload_rate_kbps: z.number().int().nullable().default(null),
  session_timeout_s: z.number().int().nullable().default(null),
  idle_timeout_s: z.number().int().nullable().default(null),
  /**
   * Seconds a subject must wait after a session ends before a new one is authorized
   * (migration 044). Per subject, not per device: counting per device would let a guest with
   * two phones alternate and never wait.
   */
  reconnect_cooldown_s: z.number().int().nullable().default(null),
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
  /**
   * Fields this policy declares to have no cap (migration 039). A declared field wins the merge
   * exactly as a set value does: the third state beside "a value" and "inherit", so a more
   * specific layer can lift a parent per-session cap instead of only raising it.
   */
  unlimited_fields: z.array(z.string()).default([]),
  /** §4.2 field-level override: these fields force `strict_reject` when unenforceable. */
  critical_fields: z.array(z.string()).default([]),
});

export type PolicyIntentInput = z.input<typeof PolicyIntentSchema>;
export type PolicyIntent = z.output<typeof PolicyIntentSchema>;

/** `policies` columns among POLICY_FIELDS (`voucher_validity` lives on the voucher batch). */
/**
 * Columns the layer merge resolves. `PolicyField` is the set an adapter declares a capability
 * for; `quota_direction` and the `online_time_*` allowances are deliberately not in it, because
 * no NAS attribute carries them. Their enforcement is EZECLOUD-side — denial at the next
 * Access-Request and a clipped Session-Timeout — so declaring a per-adapter status for them
 * would invent a device capability rather than describe one.
 */
export type IntentColumn =
  | Exclude<PolicyField, 'voucher_validity'>
  | 'quota_direction'
  | 'online_time_daily_s'
  | 'online_time_weekly_s'
  | 'online_time_monthly_s'
  | 'online_time_total_s'
  | 'quota_exhaustion_action'
  | 'reduced_download_rate_kbps'
  | 'reduced_upload_rate_kbps'
  | 'reconnect_cooldown_s';

/** Enforcement-relevant columns only (the ones that fall through layer by layer). */
/** The merge columns an adapter declares a capability for; the ones `translate()` can act on. */
export type TranslatedColumn = Exclude<PolicyField, 'voucher_validity'>;

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
  'quota_weekly_bytes',
  'quota_monthly_bytes',
  'quota_total_bytes',
  'quota_direction',
  'online_time_daily_s',
  'online_time_weekly_s',
  'online_time_monthly_s',
  'online_time_total_s',
  'quota_exhaustion_action',
  'reduced_download_rate_kbps',
  'reduced_upload_rate_kbps',
  'session_timeout_s',
  'idle_timeout_s',
  'reconnect_cooldown_s',
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

  // Rule 3: positive quotas (schema) and a shorter period may never exceed a longer one.
  // A "5 GB a day, 2 GB a month" plan is not a plan, it is a typo the guest would discover.
  const QUOTA_ORDER = [
    ['quota_daily_bytes', 'quota_weekly_bytes'],
    ['quota_weekly_bytes', 'quota_monthly_bytes'],
    ['quota_monthly_bytes', 'quota_total_bytes'],
    ['quota_daily_bytes', 'quota_monthly_bytes'],
    ['quota_daily_bytes', 'quota_total_bytes'],
    ['quota_weekly_bytes', 'quota_total_bytes'],
  ] as const;
  for (const [shorter, longer] of QUOTA_ORDER) {
    const a = p[shorter];
    const b = p[longer];
    if (a !== null && b !== null && a > b)
      err(shorter, 3, 'quota_order', `${shorter} must be <= ${longer}`);
  }
  // A direction with nothing to apply it to is a setting that silently does nothing.
  if (
    p.quota_direction !== null &&
    p.quota_daily_bytes === null &&
    p.quota_weekly_bytes === null &&
    p.quota_monthly_bytes === null &&
    p.quota_total_bytes === null
  )
    err(
      'quota_direction',
      3,
      'direction_without_quota',
      'quota_direction applies to the data quotas; set at least one, or leave the direction unset to inherit',
    );

  // Rule 12: online-time allowances (migration 036). Same ordering discipline as the data
  // quotas, and the same minimum as the timers: a cap below one minute cannot be enforced by a
  // Session-Timeout the NAS only re-reads at the next Access-Request.
  const TIME_ORDER = [
    ['online_time_daily_s', 'online_time_weekly_s'],
    ['online_time_weekly_s', 'online_time_monthly_s'],
    ['online_time_monthly_s', 'online_time_total_s'],
    ['online_time_daily_s', 'online_time_monthly_s'],
    ['online_time_daily_s', 'online_time_total_s'],
    ['online_time_weekly_s', 'online_time_total_s'],
  ] as const;
  for (const key of [
    'online_time_daily_s',
    'online_time_weekly_s',
    'online_time_monthly_s',
    'online_time_total_s',
  ] as const) {
    const v = p[key];
    if (v !== null && v < MIN_TIMEOUT_S)
      err(key, 12, 'online_time_too_short', `${key} must be >= ${MIN_TIMEOUT_S} s`);
  }
  for (const [shorter, longer] of TIME_ORDER) {
    const a = p[shorter];
    const b = p[longer];
    if (a !== null && b !== null && a > b)
      err(shorter, 12, 'online_time_order', `${shorter} must be <= ${longer}`);
  }

  // Rule 13: exhaustion action (migration 037).
  for (const key of ['reduced_download_rate_kbps', 'reduced_upload_rate_kbps'] as const) {
    const v = p[key];
    if (v === null) continue;
    if (v < 1) err(key, 13, 'rate_not_positive', `${key} must be >= 1 kbit/s when set`);
    else if (v > MAX_RATE_KBPS)
      err(key, 13, 'rate_overflow', `${key} must be <= ${MAX_RATE_KBPS} kbit/s (32-bit bit/s)`);
  }
  // A reduction that raises the rate is a typo, and one that silently does nothing is worse:
  // the operator believes exhausted guests are throttled and they are not.
  for (const [reduced, base] of [
    ['reduced_download_rate_kbps', 'download_rate_kbps'],
    ['reduced_upload_rate_kbps', 'upload_rate_kbps'],
  ] as const) {
    const r = p[reduced];
    const b = p[base];
    if (r !== null && b !== null && r > b)
      err(reduced, 13, 'reduced_above_base', `${reduced} must be <= ${base}`);
  }
  if (
    p.quota_exhaustion_action === 'reduce_speed' &&
    p.reduced_download_rate_kbps === null &&
    p.reduced_upload_rate_kbps === null
  )
    err(
      'quota_exhaustion_action',
      13,
      'reduce_speed_without_rate',
      'reduce_speed needs reduced_download_rate_kbps or reduced_upload_rate_kbps, otherwise an exhausted guest keeps the full rate',
    );
  if (
    p.quota_exhaustion_action !== null &&
    p.quota_exhaustion_action !== 'reduce_speed' &&
    (p.reduced_download_rate_kbps !== null || p.reduced_upload_rate_kbps !== null)
  )
    err(
      'quota_exhaustion_action',
      13,
      'reduced_rate_unused',
      `reduced rates apply only to reduce_speed; this policy would ${p.quota_exhaustion_action} instead`,
    );
  // The action only has something to act on when an allowance exists.
  const hasAllowance =
    p.quota_daily_bytes !== null ||
    p.quota_weekly_bytes !== null ||
    p.quota_monthly_bytes !== null ||
    p.quota_total_bytes !== null ||
    p.online_time_daily_s !== null ||
    p.online_time_weekly_s !== null ||
    p.online_time_monthly_s !== null ||
    p.online_time_total_s !== null;
  if (p.quota_exhaustion_action !== null && !hasAllowance)
    err(
      'quota_exhaustion_action',
      13,
      'action_without_allowance',
      'quota_exhaustion_action applies when a data or online-time allowance runs out; this policy sets none',
    );

  // Rule 14: unlimited declarations (migration 039).
  const seenUnlimited = new Set<string>();
  for (const field of p.unlimited_fields) {
    if (!isUnlimitableField(field)) {
      err(
        'unlimited_fields',
        14,
        'not_unlimitable',
        `${field} has no unlimited state; allowed: ${UNLIMITABLE_FIELDS.join(', ')}`,
      );
      continue;
    }
    if (seenUnlimited.has(field))
      err('unlimited_fields', 14, 'duplicate_unlimited', `${field} is listed twice`);
    seenUnlimited.add(field);
    // Declaring a field unlimited AND giving it a value is two answers to one question. The
    // merge would have to pick one silently, so the policy is refused instead.
    if ((p as Record<string, unknown>)[field] !== null)
      err(
        'unlimited_fields',
        14,
        'unlimited_and_set',
        `${field} is declared unlimited and also set to a value; choose one`,
      );
  }

  // Rule 4: timers ≥ 60 s.
  for (const key of ['session_timeout_s', 'idle_timeout_s'] as const) {
    const v = p[key];
    if (v !== null && v < MIN_TIMEOUT_S)
      err(key, 4, 'timeout_too_short', `${key} must be >= ${MIN_TIMEOUT_S} s`);
  }

  // Rule 15: reconnect cooldown (migration 044). Deliberately NOT subject to rule 4's 60 s
  // floor: that floor exists because a NAS ignores shorter timers, and nothing is sent to a NAS
  // here. A ten-second anti-flap cooldown is legitimate.
  if (p.reconnect_cooldown_s !== null && p.reconnect_cooldown_s < 1)
    err('reconnect_cooldown_s', 15, 'not_positive', 'reconnect_cooldown_s must be >= 1 s');

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
    quota_weekly_bytes: p.quota_weekly_bytes,
    quota_monthly_bytes: p.quota_monthly_bytes,
    quota_total_bytes: p.quota_total_bytes,
    quota_direction: p.quota_direction,
    online_time_daily_s: p.online_time_daily_s,
    online_time_weekly_s: p.online_time_weekly_s,
    online_time_monthly_s: p.online_time_monthly_s,
    online_time_total_s: p.online_time_total_s,
    quota_exhaustion_action: p.quota_exhaustion_action,
    reduced_download_rate_kbps: p.reduced_download_rate_kbps,
    reduced_upload_rate_kbps: p.reduced_upload_rate_kbps,
    session_timeout_s: p.session_timeout_s,
    idle_timeout_s: p.idle_timeout_s,
    reconnect_cooldown_s: p.reconnect_cooldown_s,
    max_concurrent_sessions: p.max_concurrent_sessions,
    max_devices: p.max_devices,
    valid_from: p.valid_from,
    valid_until: p.valid_until,
    schedule_id: p.schedule_id,
    vlan_id: p.vlan_id,
  };
}
