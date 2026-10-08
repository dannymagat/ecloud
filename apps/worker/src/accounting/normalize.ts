/**
 * Accounting normalisation for the drainer (AAA_ARCHITECTURE.md §5.3).
 *
 * The pure per-record rules (Class parsing, status mapping, event time, MAC and terminate-cause
 * normalisation, counter deltas) live in `@ecloud/adapters` (`src/vendor/accounting.ts`), the
 * single implementation shared with `VendorAdapter.normalizeAccounting`
 * (MULTI_VENDOR_INTEGRATION_PLAN.md §6.1, relocated in L3 §8.2). This module re-exports them
 * unchanged and keeps only the period bucketing in the site timezone, which needs the policy
 * engine's calendar helpers.
 */
import { localDateKey, offsetMs, toLocal } from '@ecloud/policy-engine';

export {
  EVENT_TIME_TOLERANCE_MS,
  counterDelta,
  deriveTimes,
  mapStatusType,
  maxCounters,
  normalizeAccounting,
  normalizeMacAddress,
  normalizeTerminateCause,
  parseClassSessionId,
  type NormalizedAccounting,
  type RawAccountingRow,
  type SessionCounters,
} from '@ecloud/adapters';

export const TOTAL_PERIOD_START = '1970-01-01';

export interface PeriodStarts {
  daily: string;
  monthly: string;
  total: string;
}

/** `usage_counters.period_start` values for `at` in the site's IANA timezone (D6). */
export function periodStarts(at: Date, timeZone: string): PeriodStarts {
  const local = toLocal(at, timeZone);
  return {
    daily: localDateKey(at, timeZone),
    monthly: `${String(local.year)}-${String(local.month).padStart(2, '0')}-01`,
    total: TOTAL_PERIOD_START,
  };
}

const HOUR_MS = 3_600_000;

/**
 * `usage_hourly.hour_start` for `at` (migration 026, P9-A): the instant the site-local hour
 * containing `at` began. Subtracting the local minutes / seconds keeps it exact for :30 / :45
 * offsets and gives a repeated (DST fall-back) local hour its own bucket.
 */
export function localHourStart(at: Date, timeZone: string): Date {
  const ms = at.getTime();
  const local = ms + offsetMs(ms, timeZone);
  return new Date(ms - (((local % HOUR_MS) + HOUR_MS) % HOUR_MS));
}
