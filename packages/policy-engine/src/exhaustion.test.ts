/**
 * Migration 037: what an exhausted allowance does.
 *
 * The interesting cases are not "deny still denies". They are the ones where continuing is
 * supposed to work: a reduced session must not then be cut off by the very allowance it has
 * already spent, and a renewal denial must stay a denial while carrying a reason the portal can
 * act on.
 */
import { describe, expect, it } from 'vitest';
import { resolveEffectivePolicy as resolve } from './resolve.js';
import { validatePolicy } from './intent.js';
import { NOW, assignment, policy, workedExampleInput } from './resolve.fixture.js';

const SPENT = { daily: { bytes_in: 600_000_000n, bytes_out: 400_000_000n } };

function withPolicy(
  overrides: Parameters<typeof policy>[1],
  rest: Parameters<typeof workedExampleInput>[0] = {},
) {
  return workedExampleInput({
    candidates: [
      {
        assignment: assignment('as-1', 'pol-1', {
          target_type: 'user_group',
          user_group_id: 'grp-staff',
        }),
        policy: policy('pol-1', overrides),
      },
    ],
    active_sessions: [],
    ...rest,
  });
}

const BASE = {
  quota_daily_bytes: '1000000000',
  download_rate_kbps: 20_000,
  upload_rate_kbps: 5000,
};

describe('deny (the default)', () => {
  it('an unset action behaves exactly as before the column existed', () => {
    const result = resolve(withPolicy(BASE, { usage: SPENT }));
    expect(result.decision).toBe('reject');
    expect(result.reasonCode).toBe('quota_daily');
  });

  it('an explicit deny is the same', () => {
    const result = resolve(
      withPolicy({ ...BASE, quota_exhaustion_action: 'deny' }, { usage: SPENT }),
    );
    expect(result.decision).toBe('reject');
    expect(result.reasonCode).toBe('quota_daily');
  });
});

describe('require_renewal', () => {
  it('still denies, but names a reason the portal can act on', () => {
    const result = resolve(
      withPolicy({ ...BASE, quota_exhaustion_action: 'require_renewal' }, { usage: SPENT }),
    );
    expect(result.decision).toBe('reject');
    expect(result.reasonCode).toBe('renewal_required');
    // The allowance that ran out is still identifiable in the detail.
    expect(result.reasonDetail ?? '').toContain('quota_daily');
  });

  it('applies to an exhausted online-time allowance too', () => {
    const result = resolve(
      withPolicy(
        { online_time_daily_s: 7200, quota_exhaustion_action: 'require_renewal' },
        { usage: { daily: { bytes_in: 0n, bytes_out: 0n, session_time_s: 7200n } } },
      ),
    );
    expect(result.decision).toBe('reject');
    expect(result.reasonCode).toBe('renewal_required');
    expect(result.reasonDetail ?? '').toContain('online_time_daily');
  });
});

describe('reduce_speed', () => {
  const reducing = {
    ...BASE,
    quota_exhaustion_action: 'reduce_speed' as const,
    reduced_download_rate_kbps: 1000,
    reduced_upload_rate_kbps: 500,
  };

  it('keeps the guest online at the reduced rate', () => {
    const result = resolve(withPolicy(reducing, { usage: SPENT }));
    expect(result.decision).toBe('accept');
    expect(result.effective.fields.download_rate_kbps).toBe(1000);
    expect(result.effective.fields.upload_rate_kbps).toBe(500);
  });

  it('leaves the full rate alone while the allowance lasts', () => {
    const result = resolve(
      withPolicy(reducing, { usage: { daily: { bytes_in: 1n, bytes_out: 1n } } }),
    );
    expect(result.decision).toBe('accept');
    expect(result.effective.fields.download_rate_kbps).toBe(20_000);
  });

  it('stops the spent allowance clipping the session it is meant to allow', () => {
    const result = resolve(withPolicy(reducing, { usage: SPENT }));
    // A remainder of zero would otherwise drive Session-Timeout to the floor and cut a session
    // that policy says may continue.
    expect(result.clip.remaining_octets).toBeNull();
    expect(result.clip.drain_time_s).toBeNull();
  });

  it('reports the reduction as a control, so the operator can see why the rate differs', () => {
    const result = resolve(withPolicy(reducing, { usage: SPENT }));
    const control = result.controls.find((c) => c.kind === 'quota_reduced');
    expect(control?.params?.reason).toBe('quota_daily');
    expect(control?.params?.download_rate_kbps).toBe(1000);
  });

  it('reduces only the direction that has a reduced rate', () => {
    const result = resolve(
      withPolicy(
        { ...BASE, quota_exhaustion_action: 'reduce_speed', reduced_download_rate_kbps: 1000 },
        { usage: SPENT },
      ),
    );
    expect(result.effective.fields.download_rate_kbps).toBe(1000);
    expect(result.effective.fields.upload_rate_kbps).toBe(5000);
  });

  it('does not rescue a denial that is about eligibility rather than an allowance', () => {
    // An expired policy is refused whatever the exhaustion action says.
    const result = resolve(
      withPolicy(
        { ...reducing, valid_until: new Date(NOW.getTime() - 1000).toISOString() },
        { usage: SPENT },
      ),
    );
    expect(result.decision).toBe('reject');
    expect(result.reasonCode).not.toBe('quota_daily');
  });
});

describe('validation (rule 13)', () => {
  const base = {
    id: 'p1',
    organization_id: 'org-1',
    name: 'p',
    scope_type: 'group' as const,
    status: 'active' as const,
    version: 1,
  };
  const codes = (input: Record<string, unknown>): string[] => {
    const r = validatePolicy({ ...base, ...input });
    return r.errors.map((e) => e.code);
  };

  it('refuses reduce_speed with no reduced rate: the guest would keep the full rate', () => {
    expect(codes({ quota_daily_bytes: '1000', quota_exhaustion_action: 'reduce_speed' })).toContain(
      'reduce_speed_without_rate',
    );
  });

  it('refuses a reduced rate above the policy rate', () => {
    expect(
      codes({
        quota_daily_bytes: '1000',
        download_rate_kbps: 1000,
        quota_exhaustion_action: 'reduce_speed',
        reduced_download_rate_kbps: 2000,
      }),
    ).toContain('reduced_above_base');
  });

  it('refuses reduced rates on an action that would never use them', () => {
    expect(
      codes({
        quota_daily_bytes: '1000',
        quota_exhaustion_action: 'deny',
        reduced_download_rate_kbps: 100,
      }),
    ).toContain('reduced_rate_unused');
  });

  it('refuses an action on a policy with no allowance to exhaust', () => {
    expect(codes({ quota_exhaustion_action: 'deny' })).toContain('action_without_allowance');
  });

  it('accepts an online-time allowance as the thing the action acts on', () => {
    expect(
      codes({ online_time_total_s: 3600, quota_exhaustion_action: 'require_renewal' }),
    ).toEqual([]);
  });
});
