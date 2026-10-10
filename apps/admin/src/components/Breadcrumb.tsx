/**
 * Breadcrumb bar under each page title (home › organization › [parent list ›] page). The shell
 * provides the context (organization names); outside the shell (isolated page tests) no
 * breadcrumb is rendered.
 */
import { Home } from 'lucide-react';
import { createContext, useContext, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router';
import { navLabel } from '../lib/nav';

export interface BreadcrumbContextValue {
  organizationName: (id: string) => string | undefined;
}

const BreadcrumbContext = createContext<BreadcrumbContextValue | null>(null);

export function BreadcrumbProvider({
  value,
  children,
}: {
  value: BreadcrumbContextValue;
  children: ReactNode;
}) {
  return <BreadcrumbContext.Provider value={value}>{children}</BreadcrumbContext.Provider>;
}

export interface Crumb {
  label: string;
  /** Omitted for the current page. */
  to?: string;
}

const shortId = (id: string) => (id.length > 12 ? `${id.slice(0, 8)}…` : id);

/** Crumbs between home and the current page, derived from the route. */
export function crumbsFor(
  pathname: string,
  organizationName: (id: string) => string | undefined,
): Crumb[] {
  const parts = pathname.split('/').filter(Boolean).map(decodeURIComponent);
  if (parts[0] === 'orgs' && parts[1]) {
    const orgId = parts[1];
    const base = `/orgs/${orgId}`;
    const crumbs: Crumb[] = [
      { label: organizationName(orgId) ?? 'Organization', to: `${base}/dashboard` },
    ];
    const [list, id, sub] = parts.slice(2);
    if (list && id) {
      crumbs.push({ label: navLabel('org', list) ?? list, to: `${base}/${list}` });
      if (sub && !(list === 'sites' && sub === 'dashboard')) {
        crumbs.push({ label: shortId(id), to: `${base}/${list}/${id}` });
      }
    }
    return crumbs;
  }
  if (parts[0] === 'platform') return [{ label: 'Platform' }];
  return [];
}

export function Breadcrumb({ current }: { current: string }) {
  const ctx = useContext(BreadcrumbContext);
  const { pathname } = useLocation();
  if (!ctx) return null;
  const crumbs = crumbsFor(pathname, ctx.organizationName);
  return (
    <nav
      aria-label="Breadcrumb"
      className="mb-4 rounded-md border border-border bg-muted/60 px-3 py-2 text-sm text-subtle print:hidden"
    >
      <ol className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <li className="flex items-center">
          <Link
            to="/"
            className="rounded hover:text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
          >
            <Home aria-hidden="true" className="h-4 w-4" />
            <span className="sr-only">Home</span>
          </Link>
        </li>
        {[...crumbs, { label: current }].map((c, i) => (
          <li key={`${String(i)}-${c.label}`} className="flex min-w-0 items-center gap-2">
            <span aria-hidden="true">›</span>
            {c.to ? (
              <Link
                to={c.to}
                className="truncate rounded hover:text-primary hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
              >
                {c.label}
              </Link>
            ) : (
              <span aria-current="page" className="truncate text-fg">
                {c.label}
              </span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}
