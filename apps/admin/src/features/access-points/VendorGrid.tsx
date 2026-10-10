/**
 * Grid of vendor tiles with official logos (D-045). As links ("How to configure your access
 * points?" → Network › Setup guides › vendor) or as a single-choice picker (Add Access Point
 * wizard step 1). The trademark notice is shown under the grid.
 */
import { Check } from 'lucide-react';
import { Link } from 'react-router';
import { cx } from '../../components/ui';
import type { CatalogueEntry } from '../setup-guides/types';
import { LOGO_NOTICE, VendorLogo } from './VendorLogo';

const tileClass =
  'group flex h-full w-full min-w-0 flex-col items-center justify-start gap-2 rounded-lg border bg-surface p-3 text-center shadow-sm transition ' +
  'hover:border-primary/60 hover:shadow-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary';

function TileBody({ entry }: { entry: CatalogueEntry }) {
  return (
    <>
      <VendorLogo vendorKey={entry.vendor_key} name={entry.display_name} size="lg" decorative />
      <span className="text-sm font-medium leading-snug text-fg">{entry.display_name}</span>
    </>
  );
}

export function VendorGrid({
  entries,
  label,
  hrefFor,
  selected,
  onSelect,
}: {
  entries: readonly CatalogueEntry[];
  label: string;
  /** Link mode: the setup-guide URL of a vendor. */
  hrefFor?: (entry: CatalogueEntry) => string;
  /** Picker mode. */
  selected?: string | null;
  onSelect?: (entry: CatalogueEntry) => void;
}) {
  return (
    <div>
      <ul
        aria-label={label}
        className={cx(
          'grid grid-cols-2 gap-2.5 sm:grid-cols-3',
          // The wizard picker sits in a dialog: fewer, wider tiles keep the logos legible.
          hrefFor === undefined ? 'lg:grid-cols-4' : 'md:grid-cols-4 xl:grid-cols-6',
        )}
      >
        {entries.map((e) => {
          const isSelected = selected === e.vendor_key;
          return (
            <li key={e.vendor_key} className="min-w-0">
              {hrefFor !== undefined ? (
                <Link
                  to={hrefFor(e)}
                  data-testid={`vendor-${e.vendor_key}`}
                  aria-label={`${e.display_name}: open the setup guide`}
                  className={cx(tileClass, 'border-border')}
                >
                  <TileBody entry={e} />
                </Link>
              ) : (
                <button
                  type="button"
                  data-testid={`vendor-${e.vendor_key}`}
                  aria-pressed={isSelected}
                  onClick={() => onSelect?.(e)}
                  className={cx(
                    tileClass,
                    'relative',
                    isSelected ? 'border-primary ring-2 ring-primary/40' : 'border-border',
                  )}
                >
                  {isSelected ? (
                    <Check
                      aria-hidden="true"
                      className="absolute right-1.5 top-1.5 h-4 w-4 text-primary"
                    />
                  ) : null}
                  <TileBody entry={e} />
                </button>
              )}
            </li>
          );
        })}
      </ul>
      <p className="mt-3 text-xs text-subtle">{LOGO_NOTICE}</p>
    </div>
  );
}
