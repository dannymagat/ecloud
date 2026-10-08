/**
 * Accounting freshness (spec §6): usage derived from accounting lags by up to the NAS accounting
 * interval, so every usage figure carries when it was measured and how old its newest
 * accounting record is.
 */
import { freshnessLevel, freshnessText, type Freshness } from '../lib/accounting';
import { formatDateTime } from '../lib/format';
import { Badge } from './ui';

const TONE = { fresh: 'neutral', lagging: 'warning', stale: 'danger', none: 'neutral' } as const;

export const FRESHNESS_EXPLAINER =
  'Usage comes from RADIUS accounting, which the NAS sends at intervals: figures can lag the real traffic by up to one accounting interval.';

export function FreshnessBadge({ freshness }: { freshness: Freshness | null | undefined }) {
  const level = freshnessLevel(freshness);
  return (
    <span data-freshness={level}>
      <Badge tone={TONE[level]} title={FRESHNESS_EXPLAINER}>
        {freshnessText(freshness)}
      </Badge>
    </span>
  );
}

/** Full line for a dashboard / detail header. */
export function FreshnessLine({ freshness }: { freshness: Freshness | null | undefined }) {
  return (
    <p className="flex flex-wrap items-center gap-2 text-xs text-subtle" aria-live="polite">
      <FreshnessBadge freshness={freshness} />
      <span>
        Measured {formatDateTime(freshness?.measured_at)} · last accounting{' '}
        {formatDateTime(freshness?.last_accounting_at)}
      </span>
      <span className="sr-only">{FRESHNESS_EXPLAINER}</span>
    </p>
  );
}
