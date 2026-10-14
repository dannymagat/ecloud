/**
 * Migration 042: group and site aggregates.
 *
 * Two things are worth testing here and they pull in opposite directions. The shared quota and
 * the member ceiling must actually refuse, because they are the enforceable half. The rate pool
 * must NOT refuse and must not be presented as enforcement, because nothing can enforce it —
 * a test that let the pool quietly become a cap would be testing the bug the module exists to
 * avoid.
 */
import { describe, expect, it } from 'vitest';
import {
  evaluateAggregate,
  firstAggregateRejection,
  type AggregateInput,
  type AggregateLimits,
  type AggregateUsage,
} from './aggregate.js';

const NO_LIMITS: AggregateLimits = {
  download_kbps: null,
  upload_kbps: null,
  quota_daily_bytes: null,
  quota_weekly_bytes: null,
  quota_monthly_bytes: null,
  quota_total_bytes: null,
  max_active_members: null,
  max_active_sessions: null,
};

const NO_USAGE: AggregateUsage = {
  bytes: {},
  active_members: 0,
  active_sessions: 0,
  granted_download_kbps: 0,
  granted_upload_kbps: 0,
};

function input(
  limits: Partial<AggregateLimits>,
  usage: Partial<AggregateUsage> = {},
  subjectAlreadyActive = false,
): AggregateInput {
  return {
    level: 'user_group',
    id: 'grp-guest',
    limits: { ...NO_LIMITS, ...limits },
    usage: { ...NO_USAGE, ...usage },
    subjectAlreadyActive,
  };
}

describe('the rate pool is observed, never enforced', () => {
  // The infographic's headline example: 100 Mbit/s shared, 10 Mbit/s each.
  const pool = { download_kbps: 100_000, upload_kbps: 100_000 };

  it('never refuses, however far over the pool the granted total is', () => {
    const r = evaluateAggregate(
      input(pool, { granted_download_kbps: 500_000, granted_upload_kbps: 500_000 }),
    );
    expect(r.reject).toBeNull();
  });

  it('reports the breach rather than acting on it', () => {
    const r = evaluateAggregate(input(pool, { granted_download_kbps: 150_000 }));
    expect(r.pool?.over_download).toBe(true);
    expect(r.pool?.granted_download_kbps).toBe(150_000);
    expect(r.pool?.configured_download_kbps).toBe(100_000);
  });

  it('states its enforcement status in the data, not only in a comment', () => {
    const r = evaluateAggregate(input(pool));
    expect(r.pool?.enforcement).toBe('unsupported');
    expect(r.pool?.note).toContain('no enforcement point');
  });

  it('reports nothing when no pool is configured, rather than a pool of zero', () => {
    expect(evaluateAggregate(input({})).pool).toBeNull();
  });

  it('is not over when the granted total is within the pool', () => {
    const r = evaluateAggregate(input(pool, { granted_download_kbps: 90_000 }));
    expect(r.pool?.over_download).toBe(false);
  });
});

describe('shared data allowance (enforced)', () => {
  it('refuses when the group has spent the shared allowance', () => {
    const r = evaluateAggregate(
      input({ quota_daily_bytes: 1_000n }, { bytes: { daily: 1_000n } }),
    );
    expect(r.reject).toBe('aggregate_quota_daily');
    expect(r.detail).toContain('grp-guest');
  });

  it('permits below it and reports the remainder', () => {
    const r = evaluateAggregate(input({ quota_daily_bytes: 1_000n }, { bytes: { daily: 400n } }));
    expect(r.reject).toBeNull();
    expect(r.quota.daily).toEqual({ limit: 1_000n, used: 400n, remaining: 600n });
  });

  it('is separate from any member quota: an unused member allowance does not rescue it', () => {
    // The group is spent; this member has used nothing of their own. §7's distinction.
    const r = evaluateAggregate(
      input({ quota_monthly_bytes: 10n }, { bytes: { monthly: 10n } }),
    );
    expect(r.reject).toBe('aggregate_quota_monthly');
  });

  it('checks the shortest configured period first', () => {
    const r = evaluateAggregate(
      input(
        { quota_daily_bytes: 10n, quota_monthly_bytes: 1_000n },
        { bytes: { daily: 10n, monthly: 10n } },
      ),
    );
    expect(r.reject).toBe('aggregate_quota_daily');
  });
});

describe('active member and session ceilings (enforced)', () => {
  it('refuses a new member once the member ceiling is full', () => {
    const r = evaluateAggregate(input({ max_active_members: 2 }, { active_members: 2 }));
    expect(r.reject).toBe('aggregate_members');
  });

  it('does not count a member who is already online against the member ceiling', () => {
    // Their second device must not be refused because their own first session filled the slot.
    const r = evaluateAggregate(input({ max_active_members: 2 }, { active_members: 2 }, true));
    expect(r.reject).toBeNull();
  });

  it('counts every new session against the session ceiling, already-online or not', () => {
    const r = evaluateAggregate(input({ max_active_sessions: 3 }, { active_sessions: 3 }, true));
    expect(r.reject).toBe('aggregate_sessions');
  });

  it('separates the two semantics: members full, sessions free, still refused', () => {
    const r = evaluateAggregate(
      input({ max_active_members: 2, max_active_sessions: 50 }, { active_members: 2, active_sessions: 4 }),
    );
    expect(r.reject).toBe('aggregate_members');
  });
});

describe('across levels', () => {
  it('reports the first refusal and none when every level permits', () => {
    const group = evaluateAggregate(input({ max_active_members: 1 }, { active_members: 1 }));
    const site = evaluateAggregate({
      ...input({}),
      level: 'site',
      id: 'site-1',
    });
    expect(firstAggregateRejection([group, site])?.reject).toBe('aggregate_members');
    expect(firstAggregateRejection([site])).toBeNull();
  });
});
