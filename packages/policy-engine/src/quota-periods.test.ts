/**
 * Migration 036: the weekly period, directional data quotas and the online-time allowance.
 *
 * These are the three things the quota model could not express before, and each has a way of
 * going wrong that a happy-path test would miss: a weekly allowance that resets on the wrong
 * day, a download-only allowance quietly consumed by uploads, and a time allowance that a guest
 * who downloads nothing never spends.
 */
import { describe, expect, it } from 'vitest';
import { localWeekStartKey, nextLocalWeekStart } from './schedule.js';
import { resolveEffectivePolicy as resolve } from './resolve.js';
import { NOW, assignment, policy, workedExampleInput } from './resolve.fixture.js';

/** A single assigned policy, so the merge is not what is under test here. */
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
    ...rest,
  });
}

describe('weekly period boundaries', () => {
  // NOW is Tuesday 2026-10-06 10:00 Asia/Dubai.
  it('starts the week on the local Monday, not on the local day', () => {
    expect(localWeekStartKey(NOW, 'Asia/Dubai')).toBe('2026-10-05');
  });

  it('is the ISO week of the site, so a zone that has already rolled over gets the next week', () => {
    const sundayLateUtc = new Date('2026-10-11T20:00:00Z'); // Monday 00:00 in Asia/Dubai
    expect(localWeekStartKey(sundayLateUtc, 'UTC')).toBe('2026-10-05');
    expect(localWeekStartKey(sundayLateUtc, 'Asia/Dubai')).toBe('2026-10-12');
  });

  it('resets at the next local Monday midnight', () => {
    expect(nextLocalWeekStart(NOW, 'Asia/Dubai').toISOString()).toBe('2026-10-11T20:00:00.000Z');
  });

  it('a Monday rolls to the following Monday, never to today', () => {
    const monday = new Date('2026-10-05T08:00:00Z');
    expect(nextLocalWeekStart(monday, 'Asia/Dubai').toISOString()).toBe('2026-10-11T20:00:00.000Z');
  });
});

describe('weekly data quota', () => {
  it('rejects when the weekly allowance is spent, naming the weekly period', () => {
    const result = resolve(
      withPolicy(
        { quota_weekly_bytes: '1000000000' },
        { usage: { weekly: { bytes_in: 600_000_000n, bytes_out: 400_000_000n } } },
      ),
    );
    expect(result.decision).toBe('reject');
    expect(result.reasonCode).toBe('quota_weekly');
  });

  it('accepts below it and reports the weekly remainder', () => {
    const result = resolve(
      withPolicy(
        { quota_weekly_bytes: '1000000000' },
        {
          usage: { weekly: { bytes_in: 100_000_000n, bytes_out: 100_000_000n } },
          active_sessions: [],
        },
      ),
    );
    expect(result.decision).toBe('accept');
    expect(result.clip.remaining_period).toBe('weekly');
    expect(result.clip.remaining_octets).toBe(800_000_000n);
  });

  it('clips Session-Timeout to the weekly reset when weekly is the only period set', () => {
    const result = resolve(
      withPolicy({ quota_weekly_bytes: '1000000000' }, { active_sessions: [] }),
    );
    // NOW -> Monday 2026-10-12 00:00 Asia/Dubai is 5 days 14 hours.
    expect(result.clip.quota_reset_s).toBe(482_400);
  });
});

describe('quota direction', () => {
  const usage = { total: { bytes_in: 900_000_000n, bytes_out: 100_000_000n } };

  it('counts both directions when no layer set one, so old policies keep their meaning', () => {
    const result = resolve(
      withPolicy({ quota_total_bytes: '1000000000' }, { usage, active_sessions: [] }),
    );
    expect(result.decision).toBe('reject');
    expect(result.reasonCode).toBe('quota_total');
  });

  it('a download-only allowance is not spent by uploads', () => {
    const result = resolve(
      withPolicy(
        { quota_total_bytes: '1000000000', quota_direction: 'download' },
        { usage, active_sessions: [] },
      ),
    );
    expect(result.decision).toBe('accept');
    // Only the 100 MB downloaded counts against the gigabyte.
    expect(result.clip.remaining_octets).toBe(900_000_000n);
  });

  it('an upload-only allowance is spent by uploads alone', () => {
    const result = resolve(
      withPolicy(
        { quota_total_bytes: '1000000000', quota_direction: 'upload' },
        { usage, active_sessions: [] },
      ),
    );
    expect(result.decision).toBe('accept');
    expect(result.clip.remaining_octets).toBe(100_000_000n);
  });

  it('reserves only the counted direction against an active session', () => {
    // 10 Mbit/s down, 1 Mbit/s up. A download-only allowance must not be reserved at 11 Mbit/s.
    const base = {
      quota_total_bytes: '1000000000',
      download_rate_kbps: 10_000,
      upload_rate_kbps: 1000,
    };
    const sessions = [
      {
        id: 'sess-1',
        mac: 'aa:bb:cc:dd:ee:01',
        user_id: 'user-1',
        started_at: new Date(NOW.getTime() - 60_000),
        last_update_at: new Date(NOW.getTime() - 60_000),
      },
    ];
    const combined = resolve(withPolicy(base, { usage: {}, active_sessions: sessions })).clip
      .remaining_octets;
    const download = resolve(
      withPolicy(
        { ...base, quota_direction: 'download' },
        { usage: {}, active_sessions: sessions },
      ),
    ).clip.remaining_octets;
    // 60 s at 11 Mbit/s vs 60 s at 10 Mbit/s: the directional reserve is strictly smaller.
    expect(combined).not.toBeNull();
    expect(download).not.toBeNull();
    expect(download as bigint).toBeGreaterThan(combined as bigint);
  });
});

describe('online-time quota', () => {
  it('rejects once the allowance is spent, whatever the byte counters say', () => {
    const result = resolve(
      withPolicy(
        { online_time_daily_s: 7200 },
        {
          usage: { daily: { bytes_in: 0n, bytes_out: 0n, session_time_s: 7200n } },
          active_sessions: [],
        },
      ),
    );
    expect(result.decision).toBe('reject');
    expect(result.reasonCode).toBe('online_time_daily');
  });

  it('is distinct from the data quota: an untouched byte allowance does not rescue it', () => {
    const result = resolve(
      withPolicy(
        { online_time_daily_s: 7200, quota_daily_bytes: '1000000000' },
        {
          usage: { daily: { bytes_in: 0n, bytes_out: 0n, session_time_s: 7200n } },
          active_sessions: [],
        },
      ),
    );
    expect(result.decision).toBe('reject');
    expect(result.reasonCode).toBe('online_time_daily');
  });

  it('clips Session-Timeout to what is left, so the NAS ends the session at the boundary', () => {
    const result = resolve(
      withPolicy(
        { online_time_daily_s: 7200, session_timeout_s: 3600 },
        {
          usage: { daily: { bytes_in: 0n, bytes_out: 0n, session_time_s: 6600n } },
          active_sessions: [],
        },
      ),
    );
    expect(result.decision).toBe('accept');
    expect(result.clip.remaining_time_s).toBe(600);
    expect(result.clip.remaining_time_period).toBe('daily');
  });

  it('picks the tightest period when several are set', () => {
    const result = resolve(
      withPolicy(
        { online_time_daily_s: 7200, online_time_monthly_s: 36_000 },
        {
          usage: {
            daily: { bytes_in: 0n, bytes_out: 0n, session_time_s: 3600n },
            monthly: { bytes_in: 0n, bytes_out: 0n, session_time_s: 34_200n },
          },
          active_sessions: [],
        },
      ),
    );
    expect(result.clip.remaining_time_period).toBe('monthly');
    expect(result.clip.remaining_time_s).toBe(1800);
  });

  it('treats a counter with no recorded time as unused rather than exhausted', () => {
    const result = resolve(
      withPolicy(
        { online_time_total_s: 3600 },
        { usage: { total: { bytes_in: 9n, bytes_out: 9n } }, active_sessions: [] },
      ),
    );
    expect(result.decision).toBe('accept');
    expect(result.clip.remaining_time_s).toBe(3600);
  });
});
