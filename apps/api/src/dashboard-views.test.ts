import { ValidationError } from '@ecloud/shared';
import { describe, expect, it } from 'vitest';
import {
  activityDefinition,
  activityThresholds,
  addDays,
  classifyActivity,
  dayLabels,
  hourBuckets,
  localHourStart,
  localMidnight,
  monthLabels,
  resolveDayRange,
  resolveHourRange,
  scopeTimeZone,
  siteBounds,
  siteTodayStarts,
  windowBounds,
} from './dashboard-views.js';

const at = (iso: string) => new Date(iso);

describe('observed NAS activity (never an online/offline state)', () => {
  const t = activityThresholds(null);
  const now = at('2026-10-08T12:00:00Z');

  it('derives thresholds from the interim interval', () => {
    expect(t).toEqual({ active_within_s: 1200, quiet_within_s: 86_400 });
    expect(activityThresholds(300).active_within_s).toBe(600);
  });

  it('classifies by the newest observed activity with inclusive thresholds', () => {
    expect(classifyActivity(now, null, t)).toBe('never');
    expect(classifyActivity(now, at('2026-10-08T11:40:00Z'), t)).toBe('active'); // 1200 s
    expect(classifyActivity(now, at('2026-10-08T11:39:59Z'), t)).toBe('quiet');
    expect(classifyActivity(now, at('2026-10-07T12:00:00Z'), t)).toBe('quiet'); // 86 400 s
    expect(classifyActivity(now, at('2026-10-07T11:59:59Z'), t)).toBe('silent');
  });

  it('defines the status without device-state wording', () => {
    const text = activityDefinition(t);
    expect(text).toContain('not an online/offline state');
    expect(text).toContain('1200 s');
    expect(text).not.toMatch(/\bis (online|offline)\b/i);
  });

  it('computes dashboard windows ending now', () => {
    const w = windowBounds('24h', now);
    expect(w.to).toEqual(now);
    expect(w.from.toISOString()).toBe('2026-10-07T12:00:00.000Z');
  });
});

describe('hour buckets in the site timezone', () => {
  it('zero-fills one bucket per local hour, labelled in local time', () => {
    const b = hourBuckets(at('2026-10-08T10:15:00Z'), at('2026-10-08T13:00:00Z'), 'Asia/Dubai');
    expect(b.map((x) => x.start.toISOString())).toEqual([
      '2026-10-08T10:00:00.000Z',
      '2026-10-08T11:00:00.000Z',
      '2026-10-08T12:00:00.000Z',
    ]);
    expect(b.map((x) => x.label)).toEqual([
      '2026-10-08 14:00',
      '2026-10-08 15:00',
      '2026-10-08 16:00',
    ]);
    expect(b[2]?.end.toISOString()).toBe('2026-10-08T13:00:00.000Z');
  });

  it('aligns :30 offsets on the local hour (same rule as the worker rollup)', () => {
    expect(localHourStart(at('2026-10-08T13:47:00Z'), 'Asia/Kolkata').toISOString()).toBe(
      '2026-10-08T13:30:00.000Z',
    );
    const b = hourBuckets(at('2026-10-08T13:47:00Z'), at('2026-10-08T14:31:00Z'), 'Asia/Kolkata');
    expect(b.map((x) => x.label)).toEqual(['2026-10-08 19:00', '2026-10-08 20:00']);
  });

  it('shows the repeated fall-back hour twice and skips the spring-forward hour', () => {
    const fall = hourBuckets(
      at('2026-10-24T23:00:00Z'),
      at('2026-10-25T02:00:00Z'),
      'Europe/Berlin',
    );
    expect(fall.map((x) => x.label)).toEqual([
      '2026-10-25 01:00',
      '2026-10-25 02:00',
      '2026-10-25 02:00',
    ]);
    const spring = hourBuckets(
      at('2026-03-29T00:00:00Z'),
      at('2026-03-29T02:00:00Z'),
      'Europe/Berlin',
    );
    expect(spring.map((x) => x.label)).toEqual(['2026-03-29 01:00', '2026-03-29 03:00']);
  });

  it('bounds the range to 31 days and rejects an empty one', () => {
    expect(hourBuckets(at('2026-09-07T00:00:00Z'), at('2026-10-08T00:00:00Z'), 'UTC')).toHaveLength(
      744,
    );
    expect(() =>
      hourBuckets(at('2026-09-06T23:00:00Z'), at('2026-10-08T00:00:00Z'), 'UTC'),
    ).toThrow(ValidationError);
    expect(() =>
      hourBuckets(at('2026-10-08T00:00:00Z'), at('2026-10-08T00:00:00Z'), 'UTC'),
    ).toThrow(ValidationError);
  });

  it('defaults to the last 24 hours and validates instants', () => {
    const now = at('2026-10-08T12:34:00Z');
    const r = resolveHourRange(now);
    expect(r.to).toEqual(now);
    expect(r.from.toISOString()).toBe('2026-10-07T12:34:00.000Z');
    expect(() => resolveHourRange(now, '2026-10-08')).toThrow(ValidationError);
  });
});

describe('day labels in the site timezone (Q65)', () => {
  it('defaults to N local days ending today in the timezone', () => {
    // 22:30 UTC on 8 Oct is already 9 Oct in Dubai
    const r = resolveDayRange(at('2026-10-08T22:30:00Z'), 'Asia/Dubai', 31, 397);
    expect(r).toEqual({ from: '2026-09-09', to: '2026-10-09' });
    expect(dayLabels(r.from, r.to)).toHaveLength(31);
  });

  it('accepts up to 13 months of days and rejects more or invalid dates', () => {
    const now = at('2026-10-08T00:00:00Z');
    expect(resolveDayRange(now, 'UTC', 31, 397, '2025-09-07', '2026-10-08').from).toBe(
      '2025-09-07',
    );
    expect(() => resolveDayRange(now, 'UTC', 31, 397, '2025-09-06', '2026-10-08')).toThrow(
      ValidationError,
    );
    expect(() => resolveDayRange(now, 'UTC', 31, 397, '2026-02-30')).toThrow(ValidationError);
    expect(() => resolveDayRange(now, 'UTC', 31, 397, '2026-10-09', '2026-10-08')).toThrow(
      ValidationError,
    );
  });

  it('computes per-site instant bounds and local midnights', () => {
    expect(localMidnight('2026-10-08', 'Asia/Dubai').toISOString()).toBe(
      '2026-10-07T20:00:00.000Z',
    );
    const b = siteBounds(
      [
        { id: 'a', timezone: 'Asia/Dubai' },
        { id: 'b', timezone: 'UTC' },
      ],
      '2026-10-01',
      '2026-10-02',
    );
    expect(b[0]?.from_at.toISOString()).toBe('2026-09-30T20:00:00.000Z');
    expect(b[0]?.to_at.toISOString()).toBe('2026-10-02T20:00:00.000Z');
    expect(b[1]?.to_at.toISOString()).toBe('2026-10-03T00:00:00.000Z');
    const today = siteTodayStarts(
      [{ id: 'akl', timezone: 'Pacific/Auckland' }],
      at('2026-10-08T11:30:00Z'),
    );
    expect(today[0]?.label).toBe('2026-10-09');
    expect(today[0]?.since.toISOString()).toBe('2026-10-08T11:00:00.000Z');
  });

  it('lists months and days, and names a mixed scope', () => {
    expect(monthLabels('2025-11-01', '2026-02-01')).toEqual([
      '2025-11-01',
      '2025-12-01',
      '2026-01-01',
      '2026-02-01',
    ]);
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01');
    expect(scopeTimeZone([{ timezone: 'UTC' }, { timezone: 'UTC' }])).toBe('UTC');
    expect(scopeTimeZone([{ timezone: 'UTC' }, { timezone: 'Asia/Dubai' }])).toBe('mixed');
    expect(scopeTimeZone([])).toBe('UTC');
  });
});
