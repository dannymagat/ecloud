/**
 * "Any NAS IP" (owner decision D-086, 2026-10-21): an EZELINK NAS row may carry no `nas_ip`.
 * FreeRADIUS admits the unknown source address through the dynamic-client lookup with the one
 * static fleet secret (D-085) and the shortname `ANY_IP_SHORTNAME`; the request is then matched
 * to a NAS row by its NAS-Identifier among the any-IP rows. Several rows may share one
 * NAS-Identifier: they are interchangeable when they belong to ONE site, and the oldest row wins.
 * Rows of different organizations or sites sharing the identifier are ambiguous and refuse the
 * request (SECURITY_ARCHITECTURE.md §3.2 still holds: a reported identifier never picks between
 * tenants).
 */
export const ANY_IP_SHORTNAME = 'anyip';

/** Adapters whose NAS may have no fixed address. */
export const ANY_IP_ADAPTERS: ReadonlySet<string> = new Set(['ezeap-uam', 'ezecloud-uam']);

export function isAnyIpAdapter(adapterKey: string | null | undefined): boolean {
  return adapterKey != null && ANY_IP_ADAPTERS.has(adapterKey);
}

export interface SiteScopedRow {
  organization_id: string;
  site_id: string | null;
}

/**
 * Pick the one NAS among rows that share a NAS-Identifier. `rows` must already be ordered oldest
 * first and filtered to live rows. Returns null when the rows span more than one (org, site).
 */
export function pickSharedIdentifierNas<T extends SiteScopedRow>(rows: readonly T[]): T | null {
  const first = rows[0];
  if (first === undefined) return null;
  const sameScope = rows.every(
    (r) => r.organization_id === first.organization_id && r.site_id === first.site_id,
  );
  return sameScope ? first : null;
}
