/**
 * The current site (the top-bar site chip and the dashboard tile links): the site of a site
 * route (`/orgs/:orgId/sites/:siteId/…`) or the `site_id` filter of a list screen. No site means
 * "All sites".
 */
import { useQuery } from '@tanstack/react-query';
import { buildUrl, request } from '../api/client';
import type { Me, Page, Row } from '../api/types';
import { display } from './format';
import { can } from './permissions';

export const SITE_PARAM = 'site_id';

/** List screens that filter by `?site_id=` (their API list endpoint accepts `site_id`). */
export const SITE_FILTER_PAGES: readonly string[] = [
  'sessions',
  'users',
  'nas',
  'reports',
  'usage',
];

/** Canonical UUID (8-4-4-4-12 hex); anything else in the URL means "All sites". */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isSiteId(value: string | null | undefined): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

/** The `?site_id=` filter of a URL search, or null when absent or not a UUID. */
export function siteParam(params: URLSearchParams): string | null {
  const v = params.get(SITE_PARAM);
  return isSiteId(v) ? v : null;
}

export function currentSiteId(pathname: string, search: string): string | null {
  const m = /^\/orgs\/[^/]+\/sites\/([^/]+)(\/|$)/.exec(pathname);
  if (isSiteId(m?.[1])) return m[1];
  return siteParam(new URLSearchParams(search));
}

/** `?site_id=…` for a link that keeps the site filter (empty without a site). */
export function siteQuery(siteId: string | null | undefined): string {
  return siteId ? `?${SITE_PARAM}=${encodeURIComponent(siteId)}` : '';
}

export interface SiteOption {
  id: string;
  name: string;
}

/**
 * The organization's sites (first 200) when `site:read` is granted on any site; shares its cache
 * entry with the dashboard scope picker.
 */
export function useSiteList(me: Me | null, orgId: string | null) {
  const enabled = !!orgId && can(me, 'site:read', { organizationId: orgId, anySite: true });
  const q = useQuery({
    queryKey: ['org', orgId, 'dashboard-site-list'],
    enabled,
    queryFn: ({ signal }) =>
      request<Page<Row>>(
        'get',
        buildUrl('/api/v1/orgs/{orgId}/sites', { orgId: orgId ?? '' }, { limit: 200 }),
        { signal },
      ),
  });
  const sites: SiteOption[] | null = q.data
    ? q.data.data.map((s) => ({ id: s.id, name: display(s.name ?? s.id) }))
    : null;
  return { enabled, sites, isPending: enabled && q.isPending, error: q.error };
}

/** Display name of a site from the site list, else null (unknown or not readable). */
export function useSiteName(me: Me | null, orgId: string | null, siteId: string | null) {
  const { sites } = useSiteList(me, siteId ? orgId : null);
  if (!siteId) return null;
  return sites?.find((s) => s.id === siteId)?.name ?? null;
}
