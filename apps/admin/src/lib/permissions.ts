/**
 * Client-side permission evaluation mirroring the API (apps/api/src/auth/authorize.ts):
 * deny by default, platform ⊃ organization ⊃ site, impersonation pins one organization.
 * It only decides what to SHOW; the API remains the authority. Role names are never consulted
 * (D-017 / D-021): components ask `can(me, 'nas:create', { organizationId })`.
 */
import type { Me, ScopedPermissions } from '../api/types';

export interface PermissionTarget {
  /** Omit for platform-level actions. */
  organizationId?: string | null;
  siteId?: string | null;
  /** Accept a grant on any site of the organization (list screens filter server-side). */
  anySite?: boolean;
}

function covers(scope: ScopedPermissions, target: PermissionTarget): boolean {
  if (scope.scope_type === 'platform') return true;
  if (!target.organizationId || scope.organization_id !== target.organizationId) return false;
  if (scope.scope_type === 'organization') return true;
  if (target.siteId) return scope.site_id === target.siteId;
  return target.anySite === true;
}

export function can(
  me: Me | null | undefined,
  permission: string,
  target: PermissionTarget = {},
): boolean {
  if (!me) return false;
  if (me.kind === 'admin' && me.impersonation) {
    if (target.organizationId !== me.impersonation.organization_id) return false;
  }
  return me.permissions_by_scope.some(
    (scope) => covers(scope, target) && scope.permissions.includes(permission),
  );
}

/** True when any listed permission is granted (used for nav groups). */
export function canAny(
  me: Me | null | undefined,
  permissions: readonly string[],
  target: PermissionTarget = {},
): boolean {
  return permissions.some((p) => can(me, p, target));
}

/** Platform-scope permission (requires a platform binding; never true while impersonating). */
export function canPlatform(me: Me | null | undefined, permission: string): boolean {
  if (!me || (me.kind === 'admin' && me.impersonation)) return false;
  return me.permissions_by_scope.some(
    (s) => s.scope_type === 'platform' && s.permissions.includes(permission),
  );
}

/** Organizations the principal can act in, from bindings and API-key scope. */
export function organizationIdsOf(me: Me | null | undefined): string[] {
  if (!me) return [];
  if (me.kind === 'admin' && me.impersonation) return [me.impersonation.organization_id];
  const ids = new Set<string>();
  for (const scope of me.permissions_by_scope) {
    if (scope.organization_id) ids.add(scope.organization_id);
  }
  if (me.kind === 'admin') {
    for (const b of me.bindings) if (b.organization_id) ids.add(b.organization_id);
  } else {
    ids.add(me.api_key.organization_id);
  }
  return [...ids];
}

export function hasPlatformBinding(me: Me | null | undefined): boolean {
  return !!me && me.permissions_by_scope.some((s) => s.scope_type === 'platform');
}
