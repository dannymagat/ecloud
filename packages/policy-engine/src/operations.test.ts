/**
 * Stage 8 operations gaps: reconnect cooldown (migration 044, requirement §6) and schedule
 * intersection (requirement §10).
 *
 * The intersection tests matter most. The engine used to apply only the winning layer's
 * schedule, so a user policy that happened to win silently discarded the site's opening hours —
 * a restriction an operator set, removed by a policy that said nothing about time at all.
 */
import { describe, expect, it } from 'vitest';
import { resolveEffectivePolicy as resolve } from './resolve.js';
import { validatePolicy } from './intent.js';
import { NOW, OFFICE, assignment, policy, workedExampleInput } from './resolve.fixture.js';

/** NOW is Tuesday 10:00 Asia/Dubai; OFFICE is Mon-Fri 09:00-18:00 in that zone. */
const MORNINGS = {
  id: 'sch-mornings',
  name: 'Mornings only',
  timezone: 'Asia/Dubai',
  rules: [{ days: [1, 2, 3, 4, 5], start: '06:00', end: '11:00' }],
};
const AFTERNOONS = {
  id: 'sch-afternoons',
  name: 'Afternoons only',
  timezone: 'Asia/Dubai',
  rules: [{ days: [1, 2, 3, 4, 5], start: '14:00', end: '18:00' }],
};

function layered(
  userOverrides: Parameters<typeof policy>[1],
  groupOverrides: Parameters<typeof policy>[1],
  rest: Parameters<typeof workedExampleInput>[0] = {},
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
    ...rest,
  });
}

describe('schedule intersection (§10)', () => {
  it('a winning layer without a schedule no longer discards the parent restriction', () => {
    // The old behaviour: pol-user wins, has no schedule, and the group's office hours vanish.
    const r = resolve(
      layered({ download_rate_kbps: 50_000 }, { schedule_id: OFFICE.id, schedule: OFFICE }),
    );
    expect(r.effective.schedules.map((s) => s.id)).toEqual([OFFICE.id]);
    // Tuesday 10:00 is inside office hours, so this one is permitted.
    expect(r.decision).toBe('accept');
  });

  it('refuses when any applicable schedule refuses, even if the winner allows', () => {
    // User layer allows mornings (10:00 is inside); group allows afternoons only.
    const r = resolve(
      layered(
        { schedule_id: MORNINGS.id, schedule: MORNINGS },
        { schedule_id: AFTERNOONS.id, schedule: AFTERNOONS },
      ),
    );
    expect(r.decision).toBe('reject');
    expect(r.reasonCode).toBe('schedule');
  });

  it('permits when every applicable schedule allows', () => {
    const r = resolve(
      layered(
        { schedule_id: MORNINGS.id, schedule: MORNINGS },
        { schedule_id: OFFICE.id, schedule: OFFICE },
      ),
    );
    expect(r.decision).toBe('accept');
    expect(r.effective.schedules).toHaveLength(2);
  });

  it('ends the window at the earliest of the intersecting ends', () => {
    // Mornings end 11:00, office hours 18:00. The session may run until 11:00, not 18:00.
    const r = resolve(
      layered(
        { schedule_id: MORNINGS.id, schedule: MORNINGS },
        { schedule_id: OFFICE.id, schedule: OFFICE },
      ),
    );
    // NOW is 10:00 local, so one hour remains.
    expect(r.clip.window_end_s).toBe(3600);
  });

  it('counts a schedule reached through two layers once', () => {
    const r = resolve(
      layered(
        { schedule_id: OFFICE.id, schedule: OFFICE },
        { schedule_id: OFFICE.id, schedule: OFFICE },
      ),
    );
    expect(r.effective.schedules).toHaveLength(1);
  });

  it('an unlimited schedule_id on the specific layer removes every restriction below it', () => {
    const r = resolve(
      layered(
        { unlimited_fields: ['schedule_id'] },
        { schedule_id: AFTERNOONS.id, schedule: AFTERNOONS },
      ),
    );
    expect(r.effective.schedules).toEqual([]);
    expect(r.decision).toBe('accept');
  });

  it('still names the winning layer schedule for display', () => {
    const r = resolve(
      layered(
        { schedule_id: MORNINGS.id, schedule: MORNINGS },
        { schedule_id: OFFICE.id, schedule: OFFICE },
      ),
    );
    expect(r.effective.schedule?.id).toBe(MORNINGS.id);
  });
});

describe('reconnect cooldown (§6, migration 044)', () => {
  const cooling = { reconnect_cooldown_s: 300 };

  it('refuses a subject whose last session ended inside the cooldown', () => {
    const r = resolve(layered(cooling, {}, { last_session_end: new Date(NOW.getTime() - 60_000) }));
    expect(r.decision).toBe('reject');
    expect(r.reasonCode).toBe('reconnect_cooldown');
    expect(r.reasonDetail).toContain('240s of the 300s cooldown remain');
  });

  it('permits once the cooldown has passed', () => {
    const r = resolve(
      layered(cooling, {}, { last_session_end: new Date(NOW.getTime() - 301_000) }),
    );
    expect(r.decision).toBe('accept');
  });

  it('permits a subject with no previous session rather than treating absence as a breach', () => {
    expect(resolve(layered(cooling, {}, { last_session_end: null })).decision).toBe('accept');
    expect(resolve(layered(cooling, {})).decision).toBe('accept');
  });

  it('does nothing when no layer sets a cooldown', () => {
    const r = resolve(layered({}, {}, { last_session_end: new Date(NOW.getTime() - 1000) }));
    expect(r.decision).toBe('accept');
  });

  it('reports the remaining wait as a control, so the portal can say how long', () => {
    const r = resolve(layered(cooling, {}, { last_session_end: new Date(NOW.getTime() - 60_000) }));
    const control = r.controls.find((c) => c.kind === 'reconnect_cooldown');
    expect(control?.params?.remaining_s).toBe(240);
  });

  it('is not subject to the 60 s timer floor: a short anti-flap cooldown is valid', () => {
    const errors = validatePolicy({
      id: 'p1',
      organization_id: 'org-1',
      name: 'p',
      scope_type: 'group',
      status: 'active',
      version: 1,
      reconnect_cooldown_s: 10,
    }).errors;
    expect(errors).toEqual([]);
  });

  it('refuses a cooldown below one second', () => {
    const errors = validatePolicy({
      id: 'p1',
      organization_id: 'org-1',
      name: 'p',
      scope_type: 'group',
      status: 'active',
      version: 1,
      reconnect_cooldown_s: 0,
    }).errors;
    expect(errors.map((e) => e.code)).toContain('not_positive');
  });
});
