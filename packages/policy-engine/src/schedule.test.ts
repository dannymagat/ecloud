import { describe, expect, it } from 'vitest';
import type { Schedule } from './intent.js';
import {
  fromLocal,
  isInWindow,
  localDateKey,
  nextBoundary,
  nextLocalMidnight,
  nextLocalMonthStart,
  offsetMs,
  secondsUntil,
  toLocal,
} from './schedule.js';

const office: Schedule = {
  timezone: 'Asia/Dubai',
  rules: [{ days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00' }],
};

describe('toLocal / fromLocal', () => {
  it('converts instants to site wall clock with ISO weekday', () => {
    const l = toLocal(new Date('2026-10-06T06:00:00Z'), 'Asia/Dubai');
    expect(l).toEqual({
      year: 2026,
      month: 10,
      day: 6,
      hour: 10,
      minute: 0,
      second: 0,
      isoWeekday: 2,
    });
    expect(toLocal(new Date('2026-10-04T20:30:15Z'), 'Asia/Dubai')).toEqual({
      year: 2026,
      month: 10,
      day: 5,
      hour: 0,
      minute: 30,
      second: 15,
      isoWeekday: 1,
    });
  });

  it('round-trips wall clock → instant in zones with and without DST', () => {
    expect(fromLocal('Asia/Dubai', 2026, 10, 6, 10, 0)).toEqual(new Date('2026-10-06T06:00:00Z'));
    expect(fromLocal('America/New_York', 2026, 7, 1, 12, 0)).toEqual(
      new Date('2026-07-01T16:00:00Z'),
    );
    expect(fromLocal('America/New_York', 2026, 1, 1, 12, 0)).toEqual(
      new Date('2026-01-01T17:00:00Z'),
    );
    expect(offsetMs(Date.UTC(2026, 6, 1), 'Europe/London')).toBe(3_600_000);
    expect(offsetMs(Date.UTC(2026, 0, 1), 'Europe/London')).toBe(0);
  });

  it('spring-forward gap maps to the instant after the gap; fall-back ambiguity picks the first occurrence', () => {
    // New York 2026-03-08: 02:00-03:00 local does not exist. 02:30 → 03:30 EDT = 07:30Z.
    expect(fromLocal('America/New_York', 2026, 3, 8, 2, 30)).toEqual(
      new Date('2026-03-08T07:30:00Z'),
    );
    // New York 2026-11-01: 01:30 happens twice (05:30Z EDT and 06:30Z EST) → first.
    expect(fromLocal('America/New_York', 2026, 11, 1, 1, 30)).toEqual(
      new Date('2026-11-01T05:30:00Z'),
    );
  });
});

describe('isInWindow', () => {
  it('matches the §4.3 context (Tuesday 10:00 Dubai) and reports the window end', () => {
    const w = isInWindow(office, new Date('2026-10-06T06:00:00Z'));
    expect(w).not.toBeNull();
    expect(w?.endsAt).toEqual(new Date('2026-10-06T14:00:00Z'));
    expect(w?.startsAt).toEqual(new Date('2026-10-06T05:00:00Z'));
    expect(w?.localDate).toBe('2026-10-06');
    expect(secondsUntil(w?.endsAt as Date, new Date('2026-10-06T06:00:00Z'))).toBe(28800);
  });

  it('is exclusive at the end and inclusive at the start', () => {
    expect(isInWindow(office, new Date('2026-10-06T05:00:00Z'))).not.toBeNull();
    expect(isInWindow(office, new Date('2026-10-06T14:00:00Z'))).toBeNull();
    expect(isInWindow(office, new Date('2026-10-06T04:59:59Z'))).toBeNull();
  });

  it('rejects weekend days and honours the explicit timeZone override', () => {
    expect(isInWindow(office, new Date('2026-10-10T06:00:00Z'))).toBeNull(); // Saturday
    // 10:00 Dubai is 06:00Z; in Europe/London that is 07:00 local → out of 09:00-18:00
    expect(isInWindow(office, new Date('2026-10-06T06:00:00Z'), 'Europe/London')).toBeNull();
  });

  it('handles overnight windows (end < start) including the part after midnight', () => {
    const night: Schedule = {
      timezone: 'Asia/Dubai',
      rules: [{ days: [5], start: '22:00', end: '02:00' }],
    }; // Friday night
    const inFriday = isInWindow(night, new Date('2026-10-09T19:00:00Z')); // Fri 23:00 Dubai
    expect(inFriday?.localDate).toBe('2026-10-09');
    const afterMidnight = isInWindow(night, new Date('2026-10-09T21:30:00Z')); // Sat 01:30 Dubai
    expect(afterMidnight?.localDate).toBe('2026-10-09');
    expect(afterMidnight?.endsAt).toEqual(new Date('2026-10-09T22:00:00Z')); // Sat 02:00 Dubai
    expect(isInWindow(night, new Date('2026-10-09T22:00:00Z'))).toBeNull(); // Sat 02:00 → closed
    expect(isInWindow(night, new Date('2026-10-10T21:30:00Z'))).toBeNull(); // Sun 01:30 → Saturday not in days
  });

  it('spans DST transitions: window end computed in local time, duration shrinks/grows', () => {
    const ny: Schedule = {
      timezone: 'America/New_York',
      rules: [{ days: [7], start: '00:00', end: '06:00' }],
    };
    // Spring forward Sunday 2026-03-08: 00:00 EST = 05:00Z, 06:00 EDT = 10:00Z → 5 h window
    const spring = isInWindow(ny, new Date('2026-03-08T06:00:00Z'));
    expect(spring?.startsAt).toEqual(new Date('2026-03-08T05:00:00Z'));
    expect(spring?.endsAt).toEqual(new Date('2026-03-08T10:00:00Z'));
    // Fall back Sunday 2026-11-01: 00:00 EDT = 04:00Z, 06:00 EST = 11:00Z → 7 h window
    const fall = isInWindow(ny, new Date('2026-11-01T06:30:00Z'));
    expect(fall?.startsAt).toEqual(new Date('2026-11-01T04:00:00Z'));
    expect(fall?.endsAt).toEqual(new Date('2026-11-01T11:00:00Z'));
    expect(secondsUntil(fall?.endsAt as Date, new Date('2026-11-01T06:30:00Z'))).toBe(4.5 * 3600);
  });

  it('a window starting inside a DST gap still resolves (02:30 → after the gap)', () => {
    const gap: Schedule = {
      timezone: 'America/New_York',
      rules: [{ days: [7], start: '02:30', end: '04:00' }],
    };
    const w = isInWindow(gap, new Date('2026-03-08T07:45:00Z')); // 03:45 EDT
    expect(w?.startsAt).toEqual(new Date('2026-03-08T07:30:00Z'));
    expect(w?.endsAt).toEqual(new Date('2026-03-08T08:00:00Z'));
  });

  it('prefers the window ending last when rules overlap', () => {
    const overlapping: Schedule = {
      timezone: 'Asia/Dubai',
      rules: [
        { days: [2], start: '09:00', end: '12:00' },
        { days: [2], start: '08:00', end: '20:00' },
      ],
    };
    expect(isInWindow(overlapping, new Date('2026-10-06T06:00:00Z'))?.rule.end).toBe('20:00');
  });
});

describe('nextBoundary and reset clocks', () => {
  it('returns the next end while inside, the next start while outside', () => {
    const inside = nextBoundary(office, new Date('2026-10-06T06:00:00Z'));
    expect(inside?.kind).toBe('end');
    expect(inside?.at).toEqual(new Date('2026-10-06T14:00:00Z'));
    const friday = nextBoundary(office, new Date('2026-10-09T15:00:00Z')); // Fri 19:00 → Mon 09:00
    expect(friday?.kind).toBe('start');
    expect(friday?.at).toEqual(new Date('2026-10-12T05:00:00Z'));
  });

  it('returns null for a schedule with no matching days', () => {
    expect(nextBoundary({ timezone: 'Asia/Dubai', rules: [] }, new Date())).toBeNull();
  });

  it('computes site-local midnight and month start, including across DST and year end', () => {
    expect(nextLocalMidnight(new Date('2026-10-06T06:00:00Z'), 'Asia/Dubai')).toEqual(
      new Date('2026-10-06T20:00:00Z'),
    );
    // Fall-back night in New York: 2026-10-31 23:00 EDT (03:00Z Nov 1) → midnight Nov 2 is 05:00Z (EST)
    expect(nextLocalMidnight(new Date('2026-11-01T03:00:00Z'), 'America/New_York')).toEqual(
      new Date('2026-11-01T04:00:00Z'),
    );
    expect(nextLocalMidnight(new Date('2026-11-01T06:00:00Z'), 'America/New_York')).toEqual(
      new Date('2026-11-02T05:00:00Z'),
    );
    expect(nextLocalMonthStart(new Date('2026-12-15T12:00:00Z'), 'Asia/Dubai')).toEqual(
      new Date('2026-12-31T20:00:00Z'),
    );
    expect(nextLocalMonthStart(new Date('2026-10-06T06:00:00Z'), 'Asia/Dubai')).toEqual(
      new Date('2026-10-31T20:00:00Z'),
    );
    expect(localDateKey(new Date('2026-10-06T21:00:00Z'), 'Asia/Dubai')).toBe('2026-10-07');
    expect(localDateKey(new Date('2026-10-06T21:00:00Z'), 'UTC')).toBe('2026-10-06');
  });
});
