/**
 * The shared `captive_portals` row shape used by portal resolution.
 *
 * Its own module because there are several readers of these rows — the UAM/splash resolver
 * (`portal.ts`), the Cycle C post-back resolver (`portal-postback.ts`) and the vendor-API
 * resolver (`../vendor-api/portal.ts`) — and they diverged. Two of them selected `['id',
 * 'adapter_config']` and kept local two-column types, so after migration 041 added
 * `is_platform_default` they could not see it. One reached the shared picker through an
 * `as unknown as` cast, which erased exactly the mismatch the compiler would have reported.
 *
 * The consequences were not cosmetic. `pickPortal` reads `is_platform_default`, and on a row type
 * that lacks it `!r.is_platform_default` is `!undefined`, i.e. true for every row: the exclusion
 * silently does nothing, so a platform-default fallback both competed as an ordinary candidate
 * (making a real portal look ambiguous and taking a working site offline) and could be served to
 * a guest at a site whose operator had deliberately disabled its portal.
 *
 * So the rule is: any query feeding portal resolution selects `[...PORTAL_COLUMNS]` and passes
 * `PortalRow[]` with no cast. A narrower query is a compile error rather than a silent behaviour
 * change, which is the only version of this invariant that survives the next column.
 */

/** Columns every portal-resolution query must select. */
export const PORTAL_COLUMNS = [
  'id',
  'name',
  'site_id',
  'auth_methods',
  'theme_id',
  'terms_version',
  'redirect_url',
  'uam_secret_ref',
  'adapter_config',
  'status',
  'published_version_id',
  'is_platform_default',
] as const;

export interface PortalRow {
  id: string;
  name: string;
  site_id: string;
  auth_methods: string[];
  theme_id: string | null;
  terms_version: string | null;
  redirect_url: string | null;
  uam_secret_ref: string | null;
  adapter_config: Record<string, unknown>;
  status: string;
  /** Migration 038: the snapshot guests are served. NULL = draft only, nothing to serve. */
  published_version_id: string | null;
  /** Migration 041: a fallback this service created because the site had no portal. */
  is_platform_default: boolean;
}
