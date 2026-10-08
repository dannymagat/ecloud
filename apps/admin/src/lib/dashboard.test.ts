// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { niceTicks } from '../components/ColumnChart';
import {
  axisLabel,
  buildReportParams,
  byteTickUnit,
  CHART_WINDOWS,
  chartRange,
  formatCount,
  formatExact,
  localDateLabel,
  NAS_ACTIVITY_LABEL,
  nasActivityDefinitions,
  numOrNull,
  pollUnlessError,
  validateReportParams,
  FORBIDDEN_DEVICE_WORDS,
  NAS_ACTIVITY_EXPLAINER,
} from './dashboard';

const win = (key: string) => CHART_WINDOWS.find((w) => w.key === key)!;

describe('dashboard helpers', () => {
  it('polls every 30 s and stops while the query is in error (Q73)', () => {
    expect(pollUnlessError({ state: { status: 'success' } })).toBe(30_000);
    expect(pollUnlessError({ state: { status: 'pending' } })).toBe(30_000);
    expect(pollUnlessError({ state: { status: 'error' } })).toBe(false);
  });

  it('formats counts compactly for tiles and exactly for tables, never inventing zeros', () => {
    expect(formatCount(1284)).toBe('1,284');
    expect(formatCount('12900')).toBe('12.9K');
    expect(formatCount(4_200_000)).toBe('4.2M');
    expect(formatCount(null)).toBe('—');
    expect(formatExact('123456')).toBe('123,456');
    expect(numOrNull(undefined)).toBeNull();
    expect(numOrNull('abc')).toBeNull();
    expect(numOrNull('0')).toBe(0);
  });

  it('builds hourly windows as ISO instants and daily windows as site-local date labels', () => {
    const now = new Date('2026-10-08T21:30:00Z');
    expect(chartRange(win('24h'), 'Asia/Dubai', now)).toEqual({});
    const hourly = chartRange(win('7d'), 'Asia/Dubai', now);
    expect(hourly.to).toBe('2026-10-08T22:00:00.000Z');
    expect(Date.parse(hourly.to!) - Date.parse(hourly.from!)).toBe(7 * 24 * 3_600_000);
    // 21:30 UTC is already 9 Oct in Dubai (UTC+4): the daily window ends on the local date.
    expect(localDateLabel(now, 'Asia/Dubai')).toBe('2026-10-09');
    expect(chartRange(win('13m'), 'Asia/Dubai', now)).toEqual({
      from: '2025-09-09',
      to: '2026-10-09',
    });
    expect(localDateLabel(now, 'mixed')).toBe('2026-10-08');
  });

  it('keeps the bucket windows within the API bounds (hour ≤ 31 days, day ≤ 13 months)', () => {
    for (const w of CHART_WINDOWS) {
      if (w.span === null) continue;
      if (w.granularity === 'hour') expect(w.span / 24).toBeLessThanOrEqual(31);
      else expect(w.span).toBeLessThanOrEqual(397);
    }
  });

  it('shortens API bucket labels for the axis', () => {
    expect(axisLabel('2026-10-08 14:00', 'hour')).toBe('08/10 14:00');
    expect(axisLabel('2026-10-08', 'day')).toBe('08/10');
    expect(axisLabel('odd', 'day')).toBe('odd');
  });

  it('defines observed NAS activity from the API thresholds without device-state words', () => {
    const defs = nasActivityDefinitions({ active_within_s: 1200, quiet_within_s: 86400 });
    expect(defs.active).toContain('20 min');
    expect(defs.quiet).toContain('1 d');
    expect(defs.silent).toContain('more than 1 d');
    const text = [
      ...Object.values(defs),
      ...Object.values(NAS_ACTIVITY_LABEL),
      NAS_ACTIVITY_EXPLAINER,
    ].join(' ');
    for (const word of FORBIDDEN_DEVICE_WORDS) expect(text).not.toMatch(word);
  });

  it('picks byte-axis units and nice ticks starting at zero', () => {
    expect(byteTickUnit(500)).toBe(1);
    expect(byteTickUnit(3 * 1024 ** 3)).toBe(1024 ** 3);
    expect(niceTicks(0)).toEqual([0, 1]);
    expect(niceTicks(87)).toEqual([0, 25, 50, 75, 100]);
    expect(niceTicks(3.2)[0]).toBe(0);
    expect(niceTicks(3.2).at(-1)).toBeGreaterThanOrEqual(3.2);
  });

  it('turns report form values into API params (monthly labels use day 01)', () => {
    const def = {
      params: [
        { name: 'period', type: 'string', required: false, default: 'daily', description: '' },
        { name: 'from', type: 'date', required: false, default: null, description: '' },
        { name: 'to', type: 'date', required: false, default: null, description: '' },
        { name: 'site_id', type: 'uuid', required: false, default: null, description: '' },
      ],
    };
    expect(buildReportParams(def, { period: 'monthly', from: '2026-01', to: '2026-03' })).toEqual({
      period: 'monthly',
      from: '2026-01-01',
      to: '2026-03-01',
    });
    expect(buildReportParams(def, { period: 'daily', from: '', site_id: 's1' })).toEqual({
      period: 'daily',
      site_id: 's1',
    });
    expect(validateReportParams(def, { from: '2026-03-01', to: '2026-02-01' })).toMatch(/before/);
    expect(validateReportParams(def, { from: '2026-02-01', to: '2026-03-01' })).toBeNull();
    expect(
      validateReportParams(
        {
          params: [{ name: 'from', type: 'date', required: true, default: null, description: '' }],
        },
        {},
      ),
    ).toMatch(/required/);
  });
});
