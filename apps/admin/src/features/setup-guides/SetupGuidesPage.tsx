/**
 * "How to configure your access points" gallery (multi-vendor Cycle F; research §5). A grid of
 * vendor tiles with the vendor's official logo (D-045, self-hosted; a text wordmark when none),
 * each with its integration-family badge and an evidence status pill, filterable by family and
 * searchable.
 * A tile opens the vendor guide (`setup-guides/:vendorKey`).
 */
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { buildUrl, request } from '../../api/client';
import { ProblemAlert } from '../../components/ProblemAlert';
import { Badge, Card, EmptyState, PageHeader, Spinner, cx } from '../../components/ui';
import { RequireOrgPermission } from '../../layout/guards';
import { useOrgId } from '../../lib/org';
import { SITE_PARAM, siteParam } from '../../lib/sites';
import { LOGO_NOTICE, VendorLogo } from '../access-points/VendorLogo';
import { STATUS_TONE, type Catalogue, type CatalogueEntry, type GalleryFamily } from './types';

const PATH = '/api/v1/orgs/{orgId}/setup-guides';

export function useCatalogue(orgId: string) {
  return useQuery({
    queryKey: ['org', orgId, 'setup-guides'],
    retry: false,
    queryFn: () =>
      request<Catalogue>('get', buildUrl(PATH, { orgId }, undefined), { pathTemplate: PATH }),
  });
}

function matches(entry: CatalogueEntry, needle: string): boolean {
  if (needle === '') return true;
  const hay = `${entry.display_name} ${entry.product_line} ${entry.family_label}`.toLowerCase();
  return needle
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => hay.includes(w));
}

function VendorTile({ entry, href }: { entry: CatalogueEntry; href: string }) {
  return (
    <li className="min-w-0">
      <Link
        to={href}
        data-testid={`vendor-tile-${entry.vendor_key}`}
        aria-label={`${entry.display_name}: ${entry.product_line}. ${entry.family_label}. ${entry.status_label}. Open the setup guide.`}
        className={cx(
          'group flex h-full min-h-[11rem] flex-col justify-between gap-4 rounded-lg border border-border bg-surface p-4 shadow-sm transition',
          'hover:-translate-y-px hover:border-primary/60 hover:shadow-md motion-reduce:transform-none motion-reduce:transition-none',
          'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary',
        )}
      >
        <div className="min-w-0 space-y-2">
          <div className="flex items-start justify-between gap-2">
            <VendorLogo vendorKey={entry.vendor_key} name={entry.display_name} decorative />
            <Badge>{entry.family_label}</Badge>
          </div>
          <h3 className="break-words text-lg font-semibold leading-snug tracking-tight text-fg">
            {entry.display_name}
          </h3>
          <p className="text-sm leading-snug text-subtle">{entry.product_line}</p>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Badge tone={STATUS_TONE[entry.status]}>{entry.status_label}</Badge>
          <span
            aria-hidden="true"
            className="inline-flex items-center gap-1 text-xs font-medium text-primary group-hover:underline"
          >
            Guide <ArrowRight className="h-3.5 w-3.5" />
          </span>
        </div>
      </Link>
    </li>
  );
}

function Gallery() {
  const orgId = useOrgId();
  const [params] = useSearchParams();
  const siteId = siteParam(params);
  const catalogue = useCatalogue(orgId);
  const [query, setQuery] = useState('');
  const [family, setFamily] = useState<GalleryFamily | 'all'>('all');

  const entries = useMemo(
    () =>
      (catalogue.data?.data ?? []).filter(
        (e) => (family === 'all' || e.family === family) && matches(e, query.trim()),
      ),
    [catalogue.data, family, query],
  );
  const families = catalogue.data?.families ?? [];
  const suffix = siteId === null ? '' : `?${SITE_PARAM}=${encodeURIComponent(siteId)}`;

  return (
    <div>
      <PageHeader
        title="Setup guides"
        description="How to configure your access points: pick your vendor for step-by-step settings with the ECLOUD values filled in. Secrets are never shown here; a NAS secret is shown once when you add the NAS."
      />
      <Card>
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div className="w-full lg:max-w-sm">
            <label htmlFor="vendor-search" className="mb-1 block text-sm font-medium">
              Search vendors
            </label>
            <div className="relative">
              <Search
                aria-hidden="true"
                className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-subtle"
              />
              <input
                id="vendor-search"
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Vendor, product or family"
                className="w-full rounded-md border border-border bg-surface py-2 pl-8 pr-3 text-sm text-fg placeholder:text-subtle focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
              />
            </div>
          </div>
          <div
            role="group"
            aria-label="Filter by integration family"
            className="flex flex-wrap gap-1.5"
          >
            {[{ key: 'all' as const, label: 'All' }, ...families].map((f) => (
              <button
                key={f.key}
                type="button"
                aria-pressed={family === f.key}
                onClick={() => setFamily(f.key)}
                className={cx(
                  'rounded-full border px-3 py-1 text-xs font-medium transition-colors',
                  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary',
                  family === f.key
                    ? 'border-primary bg-primary text-primary-fg'
                    : 'border-border bg-surface text-fg hover:bg-muted',
                )}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>
        <p role="status" className="mt-3 text-xs text-subtle">
          {catalogue.isPending
            ? 'Loading vendors…'
            : `${String(entries.length)} of ${String(catalogue.data?.data.length ?? 0)} vendors`}
        </p>
      </Card>

      <div className="mt-4">
        <ProblemAlert error={catalogue.error} />
        {catalogue.isPending ? (
          <div className="py-10 text-center">
            <Spinner label="Loading setup guides" />
          </div>
        ) : entries.length === 0 && catalogue.data ? (
          <EmptyState title="No vendor matches">
            Try another search or family. Any vendor with RADIUS can use the 802.1X / MAC auth or
            the external portal guide.
          </EmptyState>
        ) : (
          <ul
            aria-label="Vendors"
            className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4"
          >
            {entries.map((e) => (
              <VendorTile
                key={e.vendor_key}
                entry={e}
                href={`/orgs/${orgId}/setup-guides/${e.vendor_key}${suffix}`}
              />
            ))}
          </ul>
        )}
      </div>
      <p className="mt-4 text-xs text-subtle">
        Status comes from ECLOUD&apos;s own evidence: &quot;Tested on device&quot; appears only
        after a recorded lab or production device test. Vendor names are used for identification
        only. {LOGO_NOTICE}
      </p>
    </div>
  );
}

export function SetupGuidesPage() {
  return (
    <RequireOrgPermission permission="nas:read">
      <Gallery />
    </RequireOrgPermission>
  );
}
