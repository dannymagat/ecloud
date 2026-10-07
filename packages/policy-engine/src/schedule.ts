/**
 * Weekly schedule windows evaluated as wall-clock time in an IANA zone (POLICY_ENGINE.md §1.1
 * `schedule_id`, §2.4). Implemented on `Intl.DateTimeFormat` only (no moment/luxon): the engine
 * needs two primitives — "what is the local wall clock at instant X" and "which instant is local
 * wall clock Y" — and both are derivable from the formatter's offset at a given instant.
 */
import type { Schedule, ScheduleRule } from './intent.js';

export interface LocalDateTime {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number;
  minute: number;
  second: number;
  /** ISO weekday: 1 = Monday … 7 = Sunday (matches `schedules.rules[].days`). */
  isoWeekday: number;
}

export interface ScheduleWindow {
  readonly rule: ScheduleRule;
  readonly startsAt: Date;
  readonly endsAt: Date;
  /** Local calendar date (YYYY-MM-DD) the rule instance belongs to. */
  readonly localDate: string;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatterCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatterCache.set(timeZone, f);
  }
  return f;
}

function isoWeekdayOf(year: number, month: number, day: number): number {
  const d = new Date(Date.UTC(year, month - 1, day)).getUTCDay(); // 0 = Sunday
  return d === 0 ? 7 : d;
}

/** Wall-clock components of `at` in `timeZone`. Throws RangeError on an invalid zone. */
export function toLocal(at: Date, timeZone: string): LocalDateTime {
  const parts = formatter(timeZone).formatToParts(at);
  const get = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((p) => p.type === type);
    return part ? Number(part.value) : 0;
  };
  const year = get('year');
  const month = get('month');
  const day = get('day');
  return {
    year,
    month,
    day,
    hour: get('hour') % 24,
    minute: get('minute'),
    second: get('second'),
    isoWeekday: isoWeekdayOf(year, month, day),
  };
}

function localAsUtcMs(l: LocalDateTime): number {
  return Date.UTC(l.year, l.month - 1, l.day, l.hour, l.minute, l.second);
}

/** Zone offset (local − UTC) in ms at instant `utcMs`. */
export function offsetMs(utcMs: number, timeZone: string): number {
  const whole = Math.floor(utcMs / 1000) * 1000;
  return localAsUtcMs(toLocal(new Date(whole), timeZone)) - whole;
}

/**
 * Instant for a wall-clock time in `timeZone`. Across a DST gap (non-existent local time) the
 * later offset is used (the clock "jumps forward"); for an ambiguous time (fall back) the first
 * occurrence (earlier instant) is used — the same convention as most zoned-time libraries.
 */
export function fromLocal(
  timeZone: string,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second = 0,
): Date {
  const wall = Date.UTC(year, month - 1, day, hour, minute, second);
  const offset1 = offsetMs(wall, timeZone);
  let candidate = wall - offset1;
  const offset2 = offsetMs(candidate, timeZone);
  if (offset2 !== offset1) {
    const alt = wall - offset2;
    // Ambiguous: both map back to the wall time → earlier instant. Gap: neither maps back →
    // keep the candidate derived from the pre-transition offset (lands after the gap).
    const roundTrips = (ms: number): boolean =>
      localAsUtcMs(toLocal(new Date(ms), timeZone)) === wall;
    if (roundTrips(alt) && roundTrips(candidate)) candidate = Math.min(candidate, alt);
    else if (roundTrips(alt)) candidate = alt;
  }
  return new Date(candidate);
}

function parseHHMM(s: string): { hour: number; minute: number } {
  const [h, m] = s.split(':');
  return { hour: Number(h), minute: Number(m) };
}

function addDays(l: LocalDateTime, days: number): { year: number; month: number; day: number } {
  const d = new Date(Date.UTC(l.year, l.month - 1, l.day + days));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/**
 * Concrete window instances of `rule` anchored on the local calendar date `dayOffset` days from
 * `at`'s local date. `end <= start` means the window crosses midnight into the next day.
 */
function ruleInstance(
  rule: ScheduleRule,
  anchor: LocalDateTime,
  dayOffset: number,
  timeZone: string,
): ScheduleWindow | null {
  const date = addDays(anchor, dayOffset);
  const weekday = isoWeekdayOf(date.year, date.month, date.day);
  if (!rule.days.includes(weekday)) return null;
  const s = parseHHMM(rule.start);
  const e = parseHHMM(rule.end);
  const crossesMidnight = e.hour * 60 + e.minute <= s.hour * 60 + s.minute;
  const endDate = crossesMidnight ? addDays({ ...anchor, ...date }, 1) : date;
  const startsAt = fromLocal(timeZone, date.year, date.month, date.day, s.hour, s.minute);
  const endsAt = fromLocal(timeZone, endDate.year, endDate.month, endDate.day, e.hour, e.minute);
  if (endsAt.getTime() <= startsAt.getTime()) return null; // degenerate (DST edge), skip
  return { rule, startsAt, endsAt, localDate: `${date.year}-${pad(date.month)}-${pad(date.day)}` };
}

/**
 * The window containing `at`, or `null` when out of window. Overnight windows that started the
 * previous local day are considered. When several windows overlap, the one ending last wins
 * (most permissive, so `Session-Timeout` is not clipped too early).
 */
export function isInWindow(
  schedule: Schedule,
  at: Date,
  timeZone = schedule.timezone,
): ScheduleWindow | null {
  const anchor = toLocal(at, timeZone);
  const t = at.getTime();
  let best: ScheduleWindow | null = null;
  for (const rule of schedule.rules) {
    for (const offset of [-1, 0]) {
      const w = ruleInstance(rule, anchor, offset, timeZone);
      if (!w) continue;
      if (w.startsAt.getTime() <= t && t < w.endsAt.getTime()) {
        if (!best || w.endsAt.getTime() > best.endsAt.getTime()) best = w;
      }
    }
  }
  return best;
}

export interface ScheduleBoundary {
  readonly at: Date;
  readonly kind: 'start' | 'end';
  readonly window: ScheduleWindow;
}

/**
 * Next window start or end strictly after `at` (within the next 8 local days — a weekly
 * schedule always has one unless it has no rules). Used for drain-time `Session-Timeout`
 * (window end) and for grace handling (window start).
 */
export function nextBoundary(
  schedule: Schedule,
  at: Date,
  timeZone = schedule.timezone,
): ScheduleBoundary | null {
  const anchor = toLocal(at, timeZone);
  const t = at.getTime();
  let best: ScheduleBoundary | null = null;
  const consider = (candidate: ScheduleBoundary): void => {
    if (candidate.at.getTime() > t && (!best || candidate.at.getTime() < best.at.getTime()))
      best = candidate;
  };
  for (const rule of schedule.rules) {
    for (let offset = -1; offset <= 8; offset++) {
      const w = ruleInstance(rule, anchor, offset, timeZone);
      if (!w) continue;
      consider({ at: w.startsAt, kind: 'start', window: w });
      consider({ at: w.endsAt, kind: 'end', window: w });
    }
  }
  return best;
}

/** Whole seconds from `from` to `to`, never negative. */
export function secondsUntil(to: Date, from: Date): number {
  return Math.max(0, Math.floor((to.getTime() - from.getTime()) / 1000));
}

/** Next local midnight (daily quota reset, POLICY_ENGINE.md D6) in `timeZone` after `at`. */
export function nextLocalMidnight(at: Date, timeZone: string): Date {
  const l = toLocal(at, timeZone);
  const next = addDays(l, 1);
  return fromLocal(timeZone, next.year, next.month, next.day, 0, 0);
}

/** First local midnight of the next calendar month (monthly quota reset, D6). */
export function nextLocalMonthStart(at: Date, timeZone: string): Date {
  const l = toLocal(at, timeZone);
  const year = l.month === 12 ? l.year + 1 : l.year;
  const month = l.month === 12 ? 1 : l.month + 1;
  return fromLocal(timeZone, year, month, 1, 0, 0);
}

/** Local calendar date `YYYY-MM-DD` of `at` (daily `usage_counters.period_start`). */
export function localDateKey(at: Date, timeZone: string): string {
  const l = toLocal(at, timeZone);
  return `${l.year}-${pad(l.month)}-${pad(l.day)}`;
}
