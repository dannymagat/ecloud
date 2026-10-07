import { describe, expect, it } from 'vitest';
import {
  NOW,
  OFFICE,
  assignment,
  policy,
  staffPolicy,
  workedExampleInput,
} from './resolve.fixture.js';
import {
  LAYERS,
  normalizeMac,
  resolveEffectivePolicy,
  type Candidate,
  type ResolutionInput,
} from './resolve.js';

describe('resolveEffectivePolicy — worked example (§4.3)', () => {
  it('accepts with the expected effective fields, clip and controls', () => {
    const r = resolveEffectivePolicy(workedExampleInput());
    expect(r.decision).toBe('accept');
    expect(r.reasonCode).toBeNull();
    expect(r.effective.fields.download_rate_kbps).toBe(20000);
    expect(r.effective.fields.upload_rate_kbps).toBe(5000);
    expect(r.effective.fields.quota_daily_bytes).toBe(1_000_000_000n);
    expect(r.effective.fields.idle_timeout_s).toBe(600);
    expect(r.effective.fields.max_devices).toBe(2);
    expect(r.effective.schedule).toEqual(OFFICE);
    expect(r.effective.winner).toEqual({
      policy_id: 'pol-staff',
      policy_version: 3,
      assignment_id: 'as-staff',
      layer: LAYERS.user_group,
      layer_name: 'user_group',
      target_type: 'user_group',
    });
    expect(r.clip.window_end_s).toBe(28800);
    expect(r.clip.remaining_octets).toBe(700_000_000n);
    expect(r.clip.remaining_period).toBe('daily');
    expect(r.clip.drain_time_s).toBe(300); // ceil(700e6*8/25e6)=224 → floor 300
    expect(r.clip.quota_reset_s).toBe(14 * 3600); // 10:00 → 00:00 Dubai
    expect(r.clip.policy_session_timeout_s).toBeNull();
    expect(r.controls.map((c) => c.kind).sort()).toEqual([
      'concurrency',
      'quota_watcher',
      'schedule_end',
    ]);
    expect(r.controls.find((c) => c.kind === 'schedule_end')?.at).toEqual(
      new Date('2026-10-06T14:00:00Z'),
    );
    expect(r.controls.find((c) => c.kind === 'quota_watcher')?.params?.limit).toBe('700000000');
    expect(r.snapshot.policy_id).toBe('pol-staff');
    expect(r.snapshot.policy_version).toBe(3);
    expect(r.snapshot.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces a per-field trace with provenance', () => {
    const r = resolveEffectivePolicy(workedExampleInput());
    const fieldTrace = r.trace.filter((t) => t.step === 'field');
    expect(fieldTrace.map((t) => (t.step === 'field' ? t.field : ''))).toEqual([
      'download_rate_kbps',
      'upload_rate_kbps',
      'quota_daily_bytes',
      'idle_timeout_s',
      'max_devices',
      'schedule_id',
      'schedule',
    ]);
    expect(r.trace.some((t) => t.step === 'candidate' && t.included && t.order === 0)).toBe(true);
    expect(r.trace.at(-1)).toEqual({ step: 'decision', detail: 'accept', data: {} });
  });

  it('is deterministic: same input → same snapshot hash; different values → different hash', () => {
    const a = resolveEffectivePolicy(workedExampleInput());
    const b = resolveEffectivePolicy(workedExampleInput({ now: new Date('2026-10-06T07:00:00Z') }));
    expect(a.snapshot.hash).toBe(b.snapshot.hash);
    const c = resolveEffectivePolicy(
      workedExampleInput({
        candidates: [
          {
            ...(workedExampleInput().candidates[0] as Candidate),
            policy: { ...staffPolicy, download_rate_kbps: 30000 },
          },
        ],
      }),
    );
    expect(c.snapshot.hash).not.toBe(a.snapshot.hash);
  });
});

describe('specificity and fall-through (§2.2 / §2.3)', () => {
  const sitePolicy = policy('pol-site', {
    scope_type: 'site',
    download_rate_kbps: 10000,
    upload_rate_kbps: 2000,
    vlan_id: 20,
    idle_timeout_s: 900,
  });
  const userPolicy = policy('pol-user', { scope_type: 'user', download_rate_kbps: 50000 });
  const devicePolicy = policy('pol-device', {
    scope_type: 'user',
    download_rate_kbps: 2000,
    upload_rate_kbps: 1000,
  });
  const defaultPolicy = policy('pol-default', {
    scope_type: 'site',
    is_default: true,
    quota_monthly_bytes: '50000000000',
    session_timeout_s: 3600,
  });

  const base = (): ResolutionInput =>
    workedExampleInput({
      candidates: [
        {
          assignment: assignment('as-site', 'pol-site', { target_type: 'site', site_id: 'site-1' }),
          policy: sitePolicy,
        },
        {
          assignment: assignment('as-user', 'pol-user', { target_type: 'user', user_id: 'user-1' }),
          policy: userPolicy,
        },
        {
          assignment: assignment('as-dev', 'pol-device', {
            target_type: 'client_device',
            client_device_id: 'dev-2',
          }),
          policy: devicePolicy,
        },
        {
          assignment: assignment('as-staff', 'pol-staff', {
            target_type: 'user_group',
            user_group_id: 'grp-staff',
          }),
          policy: staffPolicy,
        },
      ],
      default_policy: defaultPolicy,
      usage: {},
      active_sessions: [],
    });

  it('client_device beats user beats user_group beats site beats org default; NULL fields fall through', () => {
    const r = resolveEffectivePolicy(base());
    expect(r.decision).toBe('accept');
    expect(r.effective.fields.download_rate_kbps).toBe(2000); // device
    expect(r.effective.provenance.download_rate_kbps?.layer_name).toBe('client_device');
    expect(r.effective.fields.upload_rate_kbps).toBe(1000); // device
    expect(r.effective.fields.quota_daily_bytes).toBe(1_000_000_000n); // group (user has none)
    expect(r.effective.provenance.quota_daily_bytes?.layer_name).toBe('user_group');
    expect(r.effective.fields.idle_timeout_s).toBe(600); // group over site 900
    expect(r.effective.fields.vlan_id).toBe(20); // site
    expect(r.effective.provenance.vlan_id?.layer_name).toBe('site');
    expect(r.effective.fields.quota_monthly_bytes).toBe(50_000_000_000n); // org default
    expect(r.effective.provenance.quota_monthly_bytes?.target_type).toBe('organization_default');
    expect(r.effective.provenance.quota_monthly_bytes?.assignment_id).toBeNull();
    expect(r.effective.fields.session_timeout_s).toBe(3600);
    expect(r.effective.winner?.policy_id).toBe('pol-device');
    expect(r.effective.schedule).toEqual(OFFICE);
  });

  it('without the device assignment the user layer wins the rate', () => {
    const input = base();
    const r = resolveEffectivePolicy({
      ...input,
      candidates: input.candidates.filter((c) => c.assignment.id !== 'as-dev'),
    });
    expect(r.effective.fields.download_rate_kbps).toBe(50000);
    expect(r.effective.fields.upload_rate_kbps).toBe(5000); // group fills the user NULL
    expect(r.effective.provenance.upload_rate_kbps?.layer_name).toBe('user_group');
  });

  it('a temporary (bounded) assignment on the user wins layer 0 even over a device policy', () => {
    const boost = policy('pol-boost', { scope_type: 'temporary', download_rate_kbps: 100000 });
    const input = base();
    const r = resolveEffectivePolicy({
      ...input,
      candidates: [
        ...input.candidates,
        {
          assignment: assignment('as-boost', 'pol-boost', {
            target_type: 'user',
            user_id: 'user-1',
            effective_until: new Date('2026-10-06T08:00:00Z'),
          }),
          policy: boost,
        },
      ],
    });
    expect(r.effective.fields.download_rate_kbps).toBe(100000);
    expect(r.effective.provenance.download_rate_kbps?.layer).toBe(0);
    expect(r.effective.fields.upload_rate_kbps).toBe(1000); // falls through to the device layer
    expect(r.controls.find((c) => c.kind === 'temp_policy_expiry')?.at).toEqual(
      new Date('2026-10-06T08:00:00Z'),
    );
  });

  it('an expired temporary assignment is excluded with a trace reason', () => {
    const boost = policy('pol-boost', { scope_type: 'temporary', download_rate_kbps: 100000 });
    const input = base();
    const r = resolveEffectivePolicy({
      ...input,
      candidates: [
        ...input.candidates,
        {
          assignment: assignment('as-boost', 'pol-boost', {
            target_type: 'user',
            user_id: 'user-1',
            effective_until: new Date('2026-10-06T05:00:00Z'),
          }),
          policy: boost,
        },
      ],
    });
    expect(r.effective.fields.download_rate_kbps).toBe(2000);
    expect(
      r.trace.find((t) => t.step === 'candidate' && t.assignment_id === 'as-boost'),
    ).toMatchObject({ included: false, reason: 'assignment_expired' });
  });

  it('assignment priority beats layer; then policy priority; ties broken by effective_from desc then id', () => {
    const input = base();
    const prioritisedSite = {
      ...(input.candidates[0] as Candidate),
      assignment: { ...(input.candidates[0] as Candidate).assignment, priority: 10 },
    };
    const r = resolveEffectivePolicy({
      ...input,
      candidates: [prioritisedSite, ...input.candidates.slice(1)],
    });
    expect(r.effective.fields.download_rate_kbps).toBe(10000);
    expect(r.effective.winner?.policy_id).toBe('pol-site');

    const p1 = policy('pol-a', { scope_type: 'user', download_rate_kbps: 1, priority: 50 });
    const p2 = policy('pol-b', { scope_type: 'user', download_rate_kbps: 2, priority: 100 });
    const r2 = resolveEffectivePolicy(
      workedExampleInput({
        candidates: [
          {
            assignment: assignment('as-b', 'pol-b', { target_type: 'user', user_id: 'user-1' }),
            policy: p2,
          },
          {
            assignment: assignment('as-a', 'pol-a', { target_type: 'user', user_id: 'user-1' }),
            policy: p1,
          },
        ],
        usage: {},
        active_sessions: [],
      }),
    );
    expect(r2.effective.fields.download_rate_kbps).toBe(1);

    const p3 = policy('pol-c', { scope_type: 'user', download_rate_kbps: 3 });
    const p4 = policy('pol-d', { scope_type: 'user', download_rate_kbps: 4 });
    const r3 = resolveEffectivePolicy(
      workedExampleInput({
        candidates: [
          {
            assignment: assignment('as-c', 'pol-c', {
              target_type: 'user',
              user_id: 'user-1',
              effective_from: new Date('2026-01-01T00:00:00Z'),
            }),
            policy: p3,
          },
          {
            assignment: assignment('as-d', 'pol-d', {
              target_type: 'user',
              user_id: 'user-1',
              effective_from: new Date('2026-06-01T00:00:00Z'),
            }),
            policy: p4,
          },
        ],
        usage: {},
        active_sessions: [],
      }),
    );
    expect(r3.effective.fields.download_rate_kbps).toBe(4); // most recent wins on full tie
    const r4 = resolveEffectivePolicy(
      workedExampleInput({
        candidates: [
          {
            assignment: assignment('as-z', 'pol-c', { target_type: 'user', user_id: 'user-1' }),
            policy: p3,
          },
          {
            assignment: assignment('as-a', 'pol-d', { target_type: 'user', user_id: 'user-1' }),
            policy: p4,
          },
        ],
        usage: {},
        active_sessions: [],
      }),
    );
    expect(r4.effective.fields.download_rate_kbps).toBe(4); // id asc: as-a before as-z
  });

  it('the organization default is always the lowest layer, even against low-priority assignments', () => {
    const input = base();
    const lowPrioritySite = {
      ...(input.candidates[0] as Candidate),
      assignment: { ...(input.candidates[0] as Candidate).assignment, priority: 10_000 },
    };
    const r = resolveEffectivePolicy({ ...input, candidates: [lowPrioritySite] });
    expect(r.effective.winner?.policy_id).toBe('pol-site');
    expect(r.effective.fields.session_timeout_s).toBe(3600); // still inherits from default
  });

  it('excludes non-matching, inactive, not-yet-valid, expired and foreign candidates', () => {
    const input = base();
    const r = resolveEffectivePolicy({
      ...input,
      candidates: [
        {
          assignment: assignment('as-other-user', 'pol-user', {
            target_type: 'user',
            user_id: 'user-9',
          }),
          policy: userPolicy,
        },
        {
          assignment: assignment('as-draft', 'pol-user', {
            target_type: 'user',
            user_id: 'user-1',
          }),
          policy: { ...userPolicy, status: 'draft' },
        },
        {
          assignment: assignment('as-future', 'pol-user', {
            target_type: 'user',
            user_id: 'user-1',
          }),
          policy: { ...userPolicy, valid_from: new Date('2027-01-01T00:00:00Z') },
        },
        {
          assignment: assignment('as-expired', 'pol-user', {
            target_type: 'user',
            user_id: 'user-1',
          }),
          policy: { ...userPolicy, valid_until: new Date('2026-01-01T00:00:00Z') },
        },
        {
          assignment: assignment('as-later', 'pol-user', {
            target_type: 'user',
            user_id: 'user-1',
            effective_from: new Date('2027-01-01T00:00:00Z'),
          }),
          policy: userPolicy,
        },
        {
          assignment: assignment('as-foreign', 'pol-user', {
            target_type: 'user',
            user_id: 'user-1',
          }),
          policy: { ...userPolicy, organization_id: 'org-2' },
        },
        {
          assignment: assignment('as-other-site', 'pol-site', {
            target_type: 'site',
            site_id: 'site-9',
          }),
          policy: sitePolicy,
        },
        {
          assignment: assignment('as-other-group', 'pol-staff', {
            target_type: 'user_group',
            user_group_id: 'grp-x',
          }),
          policy: staffPolicy,
        },
        {
          assignment: assignment('as-voucher', 'pol-staff', {
            target_type: 'voucher_batch',
            voucher_batch_id: 'vb-1',
          }),
          policy: staffPolicy,
        },
      ],
      default_policy: null,
    });
    expect(r.decision).toBe('reject');
    expect(r.reasonCode).toBe('no_policy');
    const reasons = r.trace
      .filter((t) => t.step === 'candidate')
      .map((t) => (t.step === 'candidate' ? t.reason : ''));
    expect(reasons).toEqual([
      'target_mismatch',
      'policy_status_draft',
      'policy_not_yet_valid',
      'policy_expired',
      'assignment_not_yet_effective',
      'organization_mismatch',
      'target_mismatch',
      'target_mismatch',
      'target_mismatch',
    ]);
    expect(r.reasonDetail).toContain('policy_expired');
  });

  it('rejects with no_policy when nothing applies and there is no default (or the default is inactive)', () => {
    const r = resolveEffectivePolicy(workedExampleInput({ candidates: [], default_policy: null }));
    expect(r).toMatchObject({
      decision: 'reject',
      reasonCode: 'no_policy',
      reasonDetail: 'no applicable policy and no organization default',
    });
    const r2 = resolveEffectivePolicy(
      workedExampleInput({
        candidates: [],
        default_policy: { ...defaultPolicy, status: 'retired' },
      }),
    );
    expect(r2.reasonCode).toBe('no_policy');
    expect(r2.trace[0]).toMatchObject({
      step: 'candidate',
      included: false,
      reason: 'policy_status_retired',
    });
  });

  it('a default that expired or is not yet valid is skipped; a valid one applies', () => {
    const r = resolveEffectivePolicy(
      workedExampleInput({
        candidates: [],
        default_policy: { ...defaultPolicy, valid_until: new Date('2026-01-01T00:00:00Z') },
      }),
    );
    expect(r.trace[0]).toMatchObject({ reason: 'policy_expired' });
    const r2 = resolveEffectivePolicy(
      workedExampleInput({
        candidates: [],
        default_policy: { ...defaultPolicy, valid_from: new Date('2027-01-01T00:00:00Z') },
      }),
    );
    expect(r2.trace[0]).toMatchObject({ reason: 'policy_not_yet_valid' });
    const r3 = resolveEffectivePolicy(
      workedExampleInput({
        candidates: [],
        default_policy: defaultPolicy,
        usage: {},
        active_sessions: [],
      }),
    );
    expect(r3.decision).toBe('accept');
    expect(r3.effective.winner?.target_type).toBe('organization_default');
  });

  it('matches client_device assignments for MAC-auth subjects and voucher_batch for vouchers', () => {
    const r = resolveEffectivePolicy(
      workedExampleInput({
        subject: { kind: 'client_device', client_device_id: 'dev-7' },
        client_device_id: null,
        candidates: [
          {
            assignment: assignment('as-dev', 'pol-device', {
              target_type: 'client_device',
              client_device_id: 'dev-7',
            }),
            policy: devicePolicy,
          },
        ],
        usage: {},
        active_sessions: [],
      }),
    );
    expect(r.effective.winner?.policy_id).toBe('pol-device');
    const v = resolveEffectivePolicy(
      workedExampleInput({
        subject: { kind: 'voucher', user_id: 'user-v', voucher: { batch_id: 'vb-1' } },
        candidates: [
          {
            assignment: assignment('as-vb', 'pol-staff', {
              target_type: 'voucher_batch',
              voucher_batch_id: 'vb-1',
            }),
            policy: staffPolicy,
          },
        ],
        usage: {},
        active_sessions: [],
      }),
    );
    expect(v.effective.winner?.layer_name).toBe('voucher_batch');
  });
});

describe('schedule evaluation (§2.4)', () => {
  it('rejects out of window with the next start in the detail', () => {
    const r = resolveEffectivePolicy(workedExampleInput({ now: new Date('2026-10-06T15:00:00Z') })); // 19:00 Dubai
    expect(r.decision).toBe('reject');
    expect(r.reasonCode).toBe('schedule');
    expect(r.reasonDetail).toContain('2026-10-07T05:00:00.000Z');
  });

  it('applies grace before the window start and after its end', () => {
    const before = resolveEffectivePolicy(
      workedExampleInput({
        now: new Date('2026-10-06T04:58:00Z'),
        tenant: { schedule_grace_s: 300 },
      }),
    );
    expect(before.decision).toBe('accept');
    expect(before.clip.window_end_s).toBe(9 * 3600 + 120 + 300);
    const tooEarly = resolveEffectivePolicy(
      workedExampleInput({
        now: new Date('2026-10-06T04:50:00Z'),
        tenant: { schedule_grace_s: 300 },
      }),
    );
    expect(tooEarly.reasonCode).toBe('schedule');
    const capped = resolveEffectivePolicy(
      workedExampleInput({ tenant: { schedule_grace_s: 5000 } }),
    );
    expect(capped.clip.window_end_s).toBe(28800 + 900); // grace capped at 900
  });

  it('forces the tenant out_of_window_policy on top instead of rejecting', () => {
    const afterHours = policy('pol-after', {
      scope_type: 'site',
      download_rate_kbps: 1000,
      upload_rate_kbps: 500,
    });
    const r = resolveEffectivePolicy(
      workedExampleInput({
        now: new Date('2026-10-06T15:00:00Z'),
        tenant: { out_of_window_policy: afterHours },
        active_sessions: [],
      }),
    );
    expect(r.decision).toBe('accept');
    expect(r.effective.fields.download_rate_kbps).toBe(1000);
    expect(r.effective.provenance.download_rate_kbps?.target_type).toBe('out_of_window_override');
    expect(r.effective.fields.quota_daily_bytes).toBe(1_000_000_000n); // other fields still fall through
    expect(r.clip.window_end_s).toBe(14 * 3600); // until Wed 09:00 Dubai
    expect(r.controls.find((c) => c.kind === 'schedule_end')?.params?.reason).toBe(
      'out_of_window_override_ends',
    );
  });
});

describe('quota evaluation (§2.5)', () => {
  it('rejects when a period is exhausted, naming the period', () => {
    const r = resolveEffectivePolicy(
      workedExampleInput({ usage: { daily: { bytes_in: 900_000_000n, bytes_out: 100_000_000n } } }),
    );
    expect(r).toMatchObject({ decision: 'reject', reasonCode: 'quota_daily' });
    expect(r.clip.remaining_octets).toBe(0n);
  });

  it('takes the smallest remaining across periods and computes drain time from the combined rate', () => {
    const multi = {
      ...staffPolicy,
      quota_monthly_bytes: 10_000_000_000n,
      quota_total_bytes: 100_000_000_000n,
    };
    const r = resolveEffectivePolicy(
      workedExampleInput({
        candidates: [
          {
            assignment: assignment('as-staff', 'pol-staff', {
              target_type: 'user_group',
              user_group_id: 'grp-staff',
            }),
            policy: multi,
          },
        ],
        usage: {
          daily: { bytes_in: 0n, bytes_out: 0n },
          monthly: { bytes_in: 9_900_000_000n, bytes_out: 0n },
          total: { bytes_in: 0n, bytes_out: 0n },
        },
      }),
    );
    expect(r.clip.remaining_octets).toBe(100_000_000n);
    expect(r.clip.remaining_period).toBe('monthly');
    expect(r.clip.drain_time_s).toBe(300); // 32 s → floor 300
    const big = resolveEffectivePolicy(
      workedExampleInput({ usage: {}, tenant: { min_session_s: 60 } }),
    );
    expect(big.clip.remaining_octets).toBe(1_000_000_000n);
    expect(big.clip.drain_time_s).toBe(320); // 1e9*8/25e6 = 320
    const monthlyOnly = resolveEffectivePolicy(
      workedExampleInput({
        candidates: [
          {
            assignment: assignment('as-staff', 'pol-staff', {
              target_type: 'user_group',
              user_group_id: 'grp-staff',
            }),
            policy: {
              ...staffPolicy,
              quota_daily_bytes: null,
              quota_monthly_bytes: 10_000_000_000n,
            },
          },
        ],
        usage: {},
      }),
    );
    expect(monthlyOnly.clip.quota_reset_s).toBe(
      Math.floor((Date.UTC(2026, 9, 31, 20) - NOW.getTime()) / 1000),
    );
  });

  it('subtracts the estimated unreported bytes of active sessions and rejects when nothing is left', () => {
    const stale = workedExampleInput({
      usage: { daily: { bytes_in: 990_000_000n, bytes_out: 0n } },
      active_sessions: [
        {
          id: 'sess-1',
          mac: 'aa:bb:cc:dd:ee:01',
          user_id: 'user-1',
          started_at: new Date('2026-10-06T05:00:00Z'),
          last_update_at: new Date('2026-10-06T05:55:00Z'),
        },
      ],
    });
    // remaining 10 MB; 300 s at 25 Mbit/s = 937.5 MB estimated → nothing left
    const r = resolveEffectivePolicy(stale);
    expect(r).toMatchObject({ decision: 'reject', reasonCode: 'quota_daily' });
    expect(r.reasonDetail).toContain('reserved');
    const partial = resolveEffectivePolicy(
      workedExampleInput({
        active_sessions: [
          {
            id: 'sess-1',
            mac: 'aa:bb:cc:dd:ee:01',
            user_id: 'user-1',
            started_at: new Date('2026-10-06T05:00:00Z'),
            last_update_at: new Date('2026-10-06T05:59:20Z'),
          },
        ],
      }),
    );
    expect(partial.decision).toBe('accept');
    expect(partial.clip.remaining_octets).toBe(700_000_000n - BigInt((25_000_000 / 8) * 40));
  });

  it('with no rate set, no drain time is computed and the watcher alone enforces; reset clipping can be disabled', () => {
    const noRate = { ...staffPolicy, download_rate_kbps: null, upload_rate_kbps: null };
    const r = resolveEffectivePolicy(
      workedExampleInput({
        candidates: [
          {
            assignment: assignment('as-staff', 'pol-staff', {
              target_type: 'user_group',
              user_group_id: 'grp-staff',
            }),
            policy: noRate,
          },
        ],
        tenant: { clip_session_to_quota_reset: false },
      }),
    );
    expect(r.clip.drain_time_s).toBeNull();
    expect(r.clip.quota_reset_s).toBeNull();
    expect(r.controls.some((c) => c.kind === 'quota_watcher')).toBe(true);
  });

  it('no quota → no remaining, no watcher', () => {
    const r = resolveEffectivePolicy(
      workedExampleInput({
        candidates: [
          {
            assignment: assignment('as-staff', 'pol-staff', {
              target_type: 'user_group',
              user_group_id: 'grp-staff',
            }),
            policy: { ...staffPolicy, quota_daily_bytes: null },
          },
        ],
      }),
    );
    expect(r.clip.remaining_octets).toBeNull();
    expect(r.controls.some((c) => c.kind === 'quota_watcher')).toBe(false);
    expect(r.trace.find((t) => t.step === 'quota')).toMatchObject({ detail: 'no quota' });
  });
});

describe('concurrency (§2.6)', () => {
  const sessions = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      id: `sess-${i}`,
      mac: `aa:bb:cc:dd:ee:0${i}`,
      user_id: 'user-1',
      started_at: new Date(2026, 9, 6, 5, i),
      last_update_at: NOW,
      disconnect_status: 'REQUIRES_DEVICE_TEST' as const,
    }));

  it('a second device within max_devices is accepted; a third is rejected (reject is the default)', () => {
    const ok = resolveEffectivePolicy(workedExampleInput({ active_sessions: sessions(1) }));
    expect(ok.decision).toBe('accept');
    const r = resolveEffectivePolicy(
      workedExampleInput({ active_sessions: sessions(2), mac: 'aa-bb-cc-dd-ee-09' }),
    );
    expect(r).toMatchObject({ decision: 'reject', reasonCode: 'concurrency_devices' });
    expect(r.controls.find((c) => c.kind === 'concurrency')?.params).toMatchObject({
      active_devices: 2,
      max_devices: 2,
    });
  });

  it('a device that already has a session is not a new device (re-auth)', () => {
    const r = resolveEffectivePolicy(
      workedExampleInput({ active_sessions: sessions(2), mac: 'AA:BB:CC:DD:EE:01' }),
    );
    expect(r.decision).toBe('accept');
    expect(normalizeMac('AA-BB-CC-DD-EE-01')).toBe('aabbccddee01');
  });

  it('max_concurrent_sessions is checked before devices', () => {
    const p = { ...staffPolicy, max_concurrent_sessions: 1, max_devices: 5 };
    const r = resolveEffectivePolicy(
      workedExampleInput({
        candidates: [
          {
            assignment: assignment('as-staff', 'pol-staff', {
              target_type: 'user_group',
              user_group_id: 'grp-staff',
            }),
            policy: p,
          },
        ],
        active_sessions: sessions(1),
      }),
    );
    expect(r.reasonCode).toBe('concurrency_sessions');
  });

  it('disconnect_oldest enqueues a Disconnect only when the oldest session adapter has Disconnect VERIFIED_SUPPORTED', () => {
    const p = { ...staffPolicy, concurrency_mode: 'disconnect_oldest' as const };
    const cands = [
      {
        assignment: assignment('as-staff', 'pol-staff', {
          target_type: 'user_group',
          user_group_id: 'grp-staff',
        }),
        policy: p,
      },
    ];
    const unverified = resolveEffectivePolicy(
      workedExampleInput({
        candidates: cands,
        active_sessions: sessions(2),
        mac: 'aa:bb:cc:dd:ee:09',
      }),
    );
    expect(unverified.decision).toBe('reject');
    expect(unverified.reasonDetail).toContain('not VERIFIED_SUPPORTED');
    const verified = resolveEffectivePolicy(
      workedExampleInput({
        candidates: cands,
        active_sessions: sessions(2).map((s) => ({
          ...s,
          disconnect_status: 'VERIFIED_SUPPORTED' as const,
        })),
        mac: 'aa:bb:cc:dd:ee:09',
      }),
    );
    expect(verified.decision).toBe('accept');
    expect(verified.actions).toEqual([
      { kind: 'disconnect', session_id: 'sess-0', reason: 'concurrency_disconnect_oldest' },
    ]);
    const tenantDefault = resolveEffectivePolicy(
      workedExampleInput({
        tenant: { default_concurrency_mode: 'disconnect_oldest' },
        active_sessions: sessions(2).map((s) => ({
          ...s,
          disconnect_status: 'VERIFIED_SUPPORTED' as const,
        })),
        mac: 'aa:bb:cc:dd:ee:09',
      }),
    );
    expect(tenantDefault.actions).toHaveLength(1);
  });

  it('sessions of other subjects are ignored', () => {
    const r = resolveEffectivePolicy(
      workedExampleInput({
        active_sessions: sessions(3).map((s) => ({ ...s, user_id: 'user-other' })),
      }),
    );
    expect(r.decision).toBe('accept');
  });
});

describe('validity and vouchers (§2.7)', () => {
  it('clips to valid_until and arms validity_end', () => {
    const until = new Date('2026-10-06T07:00:00Z');
    const r = resolveEffectivePolicy(
      workedExampleInput({
        candidates: [
          {
            assignment: assignment('as-staff', 'pol-staff', {
              target_type: 'user_group',
              user_group_id: 'grp-staff',
            }),
            policy: { ...staffPolicy, valid_until: until },
          },
        ],
      }),
    );
    expect(r.clip.validity_end_s).toBe(3600);
    expect(r.controls.find((c) => c.kind === 'validity_end')?.at).toEqual(until);
  });

  it('rejects expired / not-yet-valid vouchers before resolving and clips to the earlier of batch end and expires_at', () => {
    const expired = resolveEffectivePolicy(
      workedExampleInput({
        subject: {
          kind: 'voucher',
          user_id: 'user-1',
          voucher: { batch_id: 'vb-1', expires_at: new Date('2026-10-06T05:00:00Z') },
        },
      }),
    );
    expect(expired).toMatchObject({ decision: 'reject', reasonCode: 'voucher_expired' });
    const early = resolveEffectivePolicy(
      workedExampleInput({
        subject: {
          kind: 'voucher',
          user_id: 'user-1',
          voucher: { batch_id: 'vb-1', batch_valid_from: new Date('2027-01-01T00:00:00Z') },
        },
      }),
    );
    expect(early.reasonCode).toBe('voucher_not_yet_valid');
    const ok = resolveEffectivePolicy(
      workedExampleInput({
        subject: {
          kind: 'voucher',
          user_id: 'user-1',
          voucher: {
            batch_id: 'vb-1',
            expires_at: new Date('2026-10-06T08:00:00Z'),
            batch_valid_until: new Date('2026-10-06T07:30:00Z'),
          },
        },
      }),
    );
    expect(ok.decision).toBe('accept');
    expect(ok.clip.voucher_end_s).toBe(5400);
    expect(ok.controls.find((c) => c.kind === 'voucher_expiry')?.at).toEqual(
      new Date('2026-10-06T07:30:00Z'),
    );
  });

  it('derives expiry from duration_s on first use (not yet activated) and from activated_at afterwards', () => {
    const first = resolveEffectivePolicy(
      workedExampleInput({
        subject: {
          kind: 'voucher',
          user_id: 'user-1',
          voucher: { batch_id: 'vb-1', duration_s: 7200 },
        },
      }),
    );
    expect(first.clip.voucher_end_s).toBe(7200);
    const activated = resolveEffectivePolicy(
      workedExampleInput({
        subject: {
          kind: 'voucher',
          user_id: 'user-1',
          voucher: {
            batch_id: 'vb-1',
            duration_s: 7200,
            activated_at: new Date('2026-10-06T05:00:00Z'),
          },
        },
      }),
    );
    expect(activated.clip.voucher_end_s).toBe(3600);
    const unbounded = resolveEffectivePolicy(
      workedExampleInput({
        subject: { kind: 'voucher', user_id: 'user-1', voucher: { batch_id: 'vb-1' } },
      }),
    );
    expect(unbounded.clip.voucher_end_s).toBeNull();
  });
});
