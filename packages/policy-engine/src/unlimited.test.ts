/**
 * Migration 039: "unlimited" as a third state beside a value and inherit.
 *
 * The whole point is the case that used to be impossible: a specific layer saying "no cap here"
 * and the merge respecting it instead of falling through to the parent's number. Everything else
 * in this file exists to show that the third state did not disturb the other two.
 */
import { describe, expect, it } from 'vitest';
import { resolveEffectivePolicy as resolve, merge } from './resolve.js';
import { validatePolicy } from './intent.js';
import { OFFICE, assignment, policy, workedExampleInput } from './resolve.fixture.js';

/** A user-layer policy over a group-layer policy; the user layer is the more specific one. */
function twoLayers(
  userOverrides: Parameters<typeof policy>[1],
  groupOverrides: Parameters<typeof policy>[1],
) {
  return workedExampleInput({
    active_sessions: [],
    usage: {},
    candidates: [
      {
        assignment: assignment('as-user', 'pol-user', { target_type: 'user', user_id: 'user-1' }),
        policy: policy('pol-user', { scope_type: 'user', ...userOverrides }),
      },
      {
        assignment: assignment('as-group', 'pol-group', {
          target_type: 'user_group',
          user_group_id: 'grp-staff',
        }),
        policy: policy('pol-group', groupOverrides),
      },
    ],
  });
}

describe('the three states', () => {
  it('inherit (null) still falls through to the parent, as it always did', () => {
    const r = resolve(twoLayers({}, { download_rate_kbps: 10_000 }));
    expect(r.effective.fields.download_rate_kbps).toBe(10_000);
    expect(r.effective.unlimited).toEqual([]);
  });

  it('a value on the specific layer still wins', () => {
    const r = resolve(
      twoLayers({ download_rate_kbps: 50_000 }, { download_rate_kbps: 10_000 }),
    );
    expect(r.effective.fields.download_rate_kbps).toBe(50_000);
  });

  it('unlimited on the specific layer lifts the parent cap instead of only raising it', () => {
    const r = resolve(
      twoLayers({ unlimited_fields: ['download_rate_kbps'] }, { download_rate_kbps: 10_000 }),
    );
    expect(r.effective.fields.download_rate_kbps).toBeNull();
    expect(r.effective.unlimited).toEqual(['download_rate_kbps']);
  });

  it('names the layer that decided, so the display can say more than "no limit"', () => {
    const r = resolve(
      twoLayers({ unlimited_fields: ['download_rate_kbps'] }, { download_rate_kbps: 10_000 }),
    );
    expect(r.effective.provenance.download_rate_kbps?.layer_name).toBe('user');
    expect(r.effective.provenance.download_rate_kbps?.policy_id).toBe('pol-user');
  });

  it('distinguishes a decided no-cap from a field nobody had an opinion about', () => {
    const r = resolve(twoLayers({ unlimited_fields: ['upload_rate_kbps'] }, {}));
    // Both read as null in `fields`; only one was a decision.
    expect(r.effective.fields.upload_rate_kbps).toBeNull();
    expect(r.effective.fields.download_rate_kbps).toBeNull();
    expect(r.effective.unlimited).toEqual(['upload_rate_kbps']);
    expect(r.effective.provenance.upload_rate_kbps).toBeDefined();
    expect(r.effective.provenance.download_rate_kbps).toBeUndefined();
  });

  it('is per field: unlimiting one does not release the others', () => {
    const r = resolve(
      twoLayers(
        { unlimited_fields: ['download_rate_kbps'] },
        { download_rate_kbps: 10_000, upload_rate_kbps: 2000, quota_daily_bytes: '1000000' },
      ),
    );
    expect(r.effective.fields.download_rate_kbps).toBeNull();
    expect(r.effective.fields.upload_rate_kbps).toBe(2000);
    expect(r.effective.fields.quota_daily_bytes).toBe(1_000_000n);
  });

  it('a lower layer cannot undo an unlimited declared above it', () => {
    // The group declares unlimited; the site below it still has a number. The group is more
    // specific, so its decision stands - the same way its value would have.
    const r = resolve(
      workedExampleInput({
        active_sessions: [],
        usage: {},
        candidates: [
          {
            assignment: assignment('as-group', 'pol-group', {
              target_type: 'user_group',
              user_group_id: 'grp-staff',
            }),
            policy: policy('pol-group', { unlimited_fields: ['session_timeout_s'] }),
          },
          {
            assignment: assignment('as-site', 'pol-site', {
              target_type: 'site',
              site_id: 'site-1',
            }),
            policy: policy('pol-site', { scope_type: 'site', session_timeout_s: 600 }),
          },
        ],
      }),
    );
    expect(r.effective.fields.session_timeout_s).toBeNull();
  });
});

describe('unlimited quotas and schedules', () => {
  it('an unlimited quota is not evaluated, so spent usage cannot reject', () => {
    const r = resolve(
      twoLayers(
        { unlimited_fields: ['quota_daily_bytes'] },
        { quota_daily_bytes: '1000' },
      ),
    );
    expect(r.decision).toBe('accept');
    expect(r.clip.remaining_octets).toBeNull();
  });

  it('an unlimited schedule removes the parent time restriction, not just its own', () => {
    const restricted = policy('pol-group', { schedule_id: OFFICE.id, schedule: OFFICE });
    const r = resolve(
      workedExampleInput({
        active_sessions: [],
        usage: {},
        // Sunday 02:00 local: outside the Mon-Fri 09:00-18:00 window.
        now: new Date('2026-10-10T22:00:00Z'),
        candidates: [
          {
            assignment: assignment('as-user', 'pol-user', {
              target_type: 'user',
              user_id: 'user-1',
            }),
            policy: policy('pol-user', {
              scope_type: 'user',
              unlimited_fields: ['schedule_id'],
            }),
          },
          {
            assignment: assignment('as-group', 'pol-group', {
              target_type: 'user_group',
              user_group_id: 'grp-staff',
            }),
            policy: restricted,
          },
        ],
      }),
    );
    expect(r.decision).toBe('accept');
    expect(r.effective.schedule).toBeNull();
  });
});

describe('merge with no candidates', () => {
  it('reports nothing unlimited rather than undefined', () => {
    expect(merge([], []).unlimited).toEqual([]);
  });
});

describe('validation (rule 14)', () => {
  const base = {
    id: 'p1',
    organization_id: 'org-1',
    name: 'p',
    scope_type: 'group' as const,
    status: 'active' as const,
    version: 1,
  };
  const codes = (input: Record<string, unknown>): string[] =>
    validatePolicy({ ...base, ...input }).errors.map((e) => e.code);

  it('refuses a field with no unlimited state', () => {
    expect(codes({ unlimited_fields: ['vlan_id'] })).toContain('not_unlimitable');
  });

  it('refuses a field that is both declared unlimited and given a value', () => {
    expect(
      codes({ unlimited_fields: ['download_rate_kbps'], download_rate_kbps: 1000 }),
    ).toContain('unlimited_and_set');
  });

  it('refuses a duplicate declaration', () => {
    expect(
      codes({ unlimited_fields: ['download_rate_kbps', 'download_rate_kbps'] }),
    ).toContain('duplicate_unlimited');
  });

  it('accepts a plain declaration', () => {
    expect(codes({ unlimited_fields: ['download_rate_kbps', 'quota_total_bytes'] })).toEqual([]);
  });
});
