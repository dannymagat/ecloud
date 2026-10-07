import { describe, expect, it } from 'vitest';
import {
  MAX_RATE_KBPS,
  PolicyIntentSchema,
  enforcementFields,
  isValidTimeZone,
  validatePolicy,
  type PolicyIntent,
  type PolicyIntentInput,
} from './intent.js';

const NOW = new Date('2026-10-06T06:00:00Z');

export function basePolicy(overrides: Partial<PolicyIntentInput> = {}): PolicyIntentInput {
  return {
    id: 'pol-1',
    organization_id: 'org-1',
    name: 'Staff 20/5 daily 1GB',
    scope_type: 'group',
    status: 'active',
    version: 3,
    download_rate_kbps: 20000,
    upload_rate_kbps: 5000,
    quota_daily_bytes: '1000000000',
    idle_timeout_s: 600,
    max_devices: 2,
    schedule_id: 'sch-1',
    schedule: {
      id: 'sch-1',
      name: 'Office hours',
      timezone: 'Asia/Dubai',
      rules: [{ days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00' }],
    },
    ...overrides,
  };
}

function errorsOf(
  input: PolicyIntentInput,
  context = {},
): { path: string; rule: number; code: string }[] {
  return validatePolicy(input, { now: NOW, ...context }).errors.map(({ path, rule, code }) => ({
    path,
    rule,
    code,
  }));
}

describe('PolicyIntentSchema', () => {
  it('parses the §1.2 example and carries quotas as bigint', () => {
    const r = PolicyIntentSchema.safeParse(basePolicy());
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.quota_daily_bytes).toBe(1_000_000_000n);
    expect(r.data.quota_monthly_bytes).toBeNull();
    expect(r.data.burst_download_kbps).toBeNull();
    expect(r.data.priority).toBe(100);
    expect(r.data.is_default).toBe(false);
  });

  it('accepts bigint, safe number and decimal string for quotas and rejects non-positive / invalid values', () => {
    expect(
      PolicyIntentSchema.parse(basePolicy({ quota_total_bytes: 5_000_000_000n })).quota_total_bytes,
    ).toBe(5_000_000_000n);
    expect(PolicyIntentSchema.parse(basePolicy({ quota_total_bytes: 42 })).quota_total_bytes).toBe(
      42n,
    );
    expect(
      PolicyIntentSchema.parse(basePolicy({ quota_total_bytes: '18446744073709551615' }))
        .quota_total_bytes,
    ).toBe(18446744073709551615n);
    expect(PolicyIntentSchema.safeParse(basePolicy({ quota_total_bytes: '0' })).success).toBe(
      false,
    );
    expect(PolicyIntentSchema.safeParse(basePolicy({ quota_total_bytes: '-5' })).success).toBe(
      false,
    );
    expect(PolicyIntentSchema.safeParse(basePolicy({ quota_total_bytes: '1e9' })).success).toBe(
      false,
    );
  });

  it('accepts Date and ISO string instants', () => {
    const p = PolicyIntentSchema.parse(
      basePolicy({
        valid_from: '2026-01-01T00:00:00Z',
        valid_until: new Date('2026-12-31T00:00:00Z'),
      }),
    );
    expect(p.valid_from).toEqual(new Date('2026-01-01T00:00:00Z'));
    expect(p.valid_until).toEqual(new Date('2026-12-31T00:00:00Z'));
  });

  it('reports schema errors as rule 0 with a path', () => {
    const r = validatePolicy({ ...basePolicy(), scope_type: 'planet' });
    expect(r.ok).toBe(false);
    expect(r.policy).toBeUndefined();
    expect(r.errors[0]?.rule).toBe(0);
    expect(r.errors[0]?.path).toBe('scope_type');
  });
});

describe('validatePolicy — §1.3 rules', () => {
  it('passes the worked example with no errors or warnings', () => {
    const r = validatePolicy(basePolicy(), { now: NOW });
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  it('rule 1: rates >= 1 and <= 4 294 967 kbit/s', () => {
    expect(errorsOf(basePolicy({ download_rate_kbps: 0 }))).toEqual([
      { path: 'download_rate_kbps', rule: 1, code: 'rate_not_positive' },
    ]);
    expect(errorsOf(basePolicy({ upload_rate_kbps: MAX_RATE_KBPS + 1 }))).toEqual([
      { path: 'upload_rate_kbps', rule: 1, code: 'rate_overflow' },
    ]);
    expect(errorsOf(basePolicy({ upload_rate_kbps: MAX_RATE_KBPS }))).toEqual([]);
  });

  it('rule 2: burst >= base rate, duration required, always warns', () => {
    expect(errorsOf(basePolicy({ burst_download_kbps: 10000, burst_duration_s: 30 }))).toEqual([
      { path: 'burst_download_kbps', rule: 2, code: 'burst_below_rate' },
    ]);
    expect(errorsOf(basePolicy({ burst_upload_kbps: 1000, burst_duration_s: 30 }))).toEqual([
      { path: 'burst_upload_kbps', rule: 2, code: 'burst_below_rate' },
    ]);
    expect(errorsOf(basePolicy({ burst_download_kbps: 30000 }))).toEqual([
      { path: 'burst_duration_s', rule: 2, code: 'burst_duration_required' },
    ]);
    expect(errorsOf(basePolicy({ burst_download_kbps: 30000, burst_duration_s: 0 }))).toEqual([
      { path: 'burst_duration_s', rule: 2, code: 'burst_duration_not_positive' },
    ]);
    const ok = validatePolicy(
      basePolicy({ burst_download_kbps: 30000, burst_upload_kbps: 6000, burst_duration_s: 10 }),
      { now: NOW },
    );
    expect(ok.ok).toBe(true);
    expect(ok.warnings).toEqual(['burst is UNSUPPORTED on all current adapters']);
  });

  it('rule 3: daily <= monthly <= total', () => {
    expect(errorsOf(basePolicy({ quota_daily_bytes: '10', quota_monthly_bytes: '5' }))).toEqual([
      { path: 'quota_daily_bytes', rule: 3, code: 'quota_order' },
    ]);
    expect(
      errorsOf(
        basePolicy({ quota_daily_bytes: '1', quota_monthly_bytes: '10', quota_total_bytes: '5' }),
      ),
    ).toEqual([{ path: 'quota_monthly_bytes', rule: 3, code: 'quota_order' }]);
    expect(errorsOf(basePolicy({ quota_daily_bytes: '10', quota_total_bytes: '5' }))).toEqual([
      { path: 'quota_daily_bytes', rule: 3, code: 'quota_order' },
    ]);
    expect(
      errorsOf(
        basePolicy({ quota_daily_bytes: '1', quota_monthly_bytes: '10', quota_total_bytes: '100' }),
      ),
    ).toEqual([]);
  });

  it('rule 4: timers >= 60 s', () => {
    expect(errorsOf(basePolicy({ session_timeout_s: 59 }))).toEqual([
      { path: 'session_timeout_s', rule: 4, code: 'timeout_too_short' },
    ]);
    expect(errorsOf(basePolicy({ idle_timeout_s: 30 }))).toEqual([
      { path: 'idle_timeout_s', rule: 4, code: 'timeout_too_short' },
    ]);
    expect(errorsOf(basePolicy({ session_timeout_s: 60, idle_timeout_s: 60 }))).toEqual([]);
  });

  it('rule 5: max_concurrent_sessions >= max_devices, both positive', () => {
    expect(errorsOf(basePolicy({ max_concurrent_sessions: 1, max_devices: 2 }))).toEqual([
      { path: 'max_concurrent_sessions', rule: 5, code: 'sessions_below_devices' },
    ]);
    expect(errorsOf(basePolicy({ max_devices: 0 }))).toEqual([
      { path: 'max_devices', rule: 5, code: 'not_positive' },
    ]);
    expect(errorsOf(basePolicy({ max_concurrent_sessions: 3, max_devices: 2 }))).toEqual([]);
  });

  it('rule 6: valid_until > valid_from; expired policies cannot be active', () => {
    expect(
      errorsOf(
        basePolicy({ valid_from: '2026-02-01T00:00:00Z', valid_until: '2026-01-01T00:00:00Z' }),
      ),
    ).toEqual([
      { path: 'valid_until', rule: 6, code: 'validity_window_inverted' },
      { path: 'status', rule: 6, code: 'expired_cannot_be_active' },
    ]);
    expect(errorsOf(basePolicy({ status: 'draft', valid_until: '2026-01-01T00:00:00Z' }))).toEqual(
      [],
    );
    expect(errorsOf(basePolicy({ valid_until: '2027-01-01T00:00:00Z' }))).toEqual([]);
  });

  it('rule 7: schedule rules and IANA zone', () => {
    expect(
      errorsOf(
        basePolicy({
          schedule: {
            timezone: 'Mars/Olympus',
            rules: [{ days: [1], start: '09:00', end: '09:00' }],
          },
        }),
      ),
    ).toEqual([
      { path: 'schedule.timezone', rule: 7, code: 'invalid_timezone' },
      { path: 'schedule.rules[0].end', rule: 7, code: 'empty_window' },
    ]);
    expect(
      errorsOf(
        basePolicy({
          schedule: {
            timezone: 'Europe/London',
            rules: [{ days: [1, 1], start: '09:00', end: '10:00' }],
          },
        }),
      ),
    ).toEqual([{ path: 'schedule.rules[0].days', rule: 7, code: 'duplicate_days' }]);
    expect(errorsOf(basePolicy({ schedule: null }))).toEqual([
      { path: 'schedule', rule: 7, code: 'schedule_missing' },
    ]);
    const bad = validatePolicy(
      basePolicy({
        schedule: {
          timezone: 'Europe/London',
          rules: [{ days: [8], start: '9:00', end: '25:00' }],
        },
      }),
    );
    expect(bad.ok).toBe(false);
    expect(bad.errors.map((e) => e.path)).toEqual([
      'schedule.rules.0.days.0',
      'schedule.rules.0.start',
      'schedule.rules.0.end',
    ]);
    expect(isValidTimeZone('Asia/Dubai')).toBe(true);
    expect(isValidTimeZone('Not/AZone')).toBe(false);
  });

  it('rule 8: vlan range and adapter warning', () => {
    expect(errorsOf(basePolicy({ vlan_id: 0 }))).toEqual([
      { path: 'vlan_id', rule: 8, code: 'vlan_out_of_range' },
    ]);
    expect(errorsOf(basePolicy({ vlan_id: 4095 }))).toEqual([
      { path: 'vlan_id', rule: 8, code: 'vlan_out_of_range' },
    ]);
    const r = validatePolicy(basePolicy({ vlan_id: 100 }), {
      now: NOW,
      targetAdapterVlanStatuses: ['UNSUPPORTED', 'REQUIRES_DEVICE_TEST'],
    });
    expect(r.ok).toBe(true);
    expect(r.warnings).toEqual([
      'vlan_id is UNSUPPORTED on at least one adapter targeted by this policy',
    ]);
  });

  it('rule 9: org default scope and uniqueness', () => {
    expect(errorsOf(basePolicy({ is_default: true, scope_type: 'temporary' }))).toEqual([
      { path: 'scope_type', rule: 9, code: 'default_scope' },
    ]);
    expect(
      errorsOf(basePolicy({ is_default: true, scope_type: 'site', site_id: 'site-1' })),
    ).toEqual([{ path: 'site_id', rule: 9, code: 'default_site_bound' }]);
    expect(
      errorsOf(basePolicy({ is_default: true, scope_type: 'site' }), {
        existingDefaultPolicyId: 'pol-other',
      }),
    ).toEqual([{ path: 'is_default', rule: 9, code: 'duplicate_default' }]);
    expect(
      errorsOf(basePolicy({ is_default: true, scope_type: 'site' }), {
        existingDefaultPolicyId: 'pol-1',
      }),
    ).toEqual([]);
  });

  it('rule 10: temporary scope requires bounded assignments', () => {
    const ctx = {
      assignments: [
        { id: 'a-1', effective_until: null },
        { id: 'a-2', effective_until: new Date('2026-10-07T00:00:00Z') },
      ],
    };
    expect(errorsOf(basePolicy({ scope_type: 'temporary' }), ctx)).toEqual([
      { path: 'assignments', rule: 10, code: 'temporary_unbounded' },
    ]);
    expect(errorsOf(basePolicy({ scope_type: 'user' }), ctx)).toEqual([]);
  });

  it('rule 11: active edits bump the version; retired policies are immutable', () => {
    const previous = PolicyIntentSchema.parse(basePolicy());
    expect(errorsOf(basePolicy({ download_rate_kbps: 30000 }), { previous })).toEqual([
      { path: 'version', rule: 11, code: 'version_bump_required' },
    ]);
    expect(errorsOf(basePolicy({ download_rate_kbps: 30000, version: 4 }), { previous })).toEqual(
      [],
    );
    expect(errorsOf(basePolicy({ description: 'cosmetic' }), { previous })).toEqual([]);
    const retired: PolicyIntent = { ...previous, status: 'retired' };
    expect(
      errorsOf(basePolicy({ status: 'retired', idle_timeout_s: 900, version: 4 }), {
        previous: retired,
      }),
    ).toEqual([{ path: 'status', rule: 11, code: 'retired_immutable' }]);
    expect(errorsOf(basePolicy({ status: 'retired' }), { previous: retired })).toEqual([]);
    expect(
      errorsOf(basePolicy({ status: 'retired', valid_until: '2027-01-01T00:00:00Z' }), {
        previous: retired,
      }),
    ).toEqual([{ path: 'status', rule: 11, code: 'retired_immutable' }]);
  });

  it('enforcementFields() returns the policies columns only', () => {
    const p = PolicyIntentSchema.parse(basePolicy());
    const f = enforcementFields(p);
    expect(Object.keys(f).sort()).toEqual(
      [
        'burst_download_kbps',
        'burst_duration_s',
        'burst_upload_kbps',
        'download_rate_kbps',
        'idle_timeout_s',
        'max_concurrent_sessions',
        'max_devices',
        'quota_daily_bytes',
        'quota_monthly_bytes',
        'quota_total_bytes',
        'schedule_id',
        'session_timeout_s',
        'upload_rate_kbps',
        'valid_from',
        'valid_until',
        'vlan_id',
      ].sort(),
    );
    expect(f.quota_daily_bytes).toBe(1_000_000_000n);
  });
});
