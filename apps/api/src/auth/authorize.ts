/**
 * Authorization evaluation (MULTITENANCY.md §4.4). Pure functions over the principal's grants:
 * deny by default, additive grants, strict scope nesting platform ⊃ organization ⊃ site,
 * platform-only keys need a platform binding, impersonation pins the target organization.
 * Role names never appear here: only permission keys and binding scopes.
 */
import { getPermission, isKnownPermission, type PermissionKey } from '@ecloud/shared';
import type { Grant, Principal } from '../context.js';

export interface AuthzTarget {
  /** Absent for platform routes. */
  readonly organizationId?: string | null;
  /** Absent for organization-level objects. */
  readonly siteId?: string | null;
  /**
   * Pre-check for routes whose site is only known after loading the row: allow when the
   * permission is granted at the organization or at ANY site of the organization. The handler
   * must then re-check with the concrete `siteId`.
   */
  readonly anySite?: boolean;
}

/** Throws at definition time for keys that are not in the catalogue (fail at boot, not at runtime). */
export function assertPermissionKey(permission: string): PermissionKey {
  if (!isKnownPermission(permission)) {
    throw new Error(`unknown permission key in route definition: ${permission}`);
  }
  return permission;
}

function grantCovers(grant: Grant, target: AuthzTarget): boolean {
  if (grant.scopeType === 'platform') return true;
  if (target.organizationId === undefined || target.organizationId === null) return false;
  if (grant.organizationId !== target.organizationId) return false;
  if (grant.scopeType === 'organization') return true;
  // site binding
  if (target.siteId !== undefined && target.siteId !== null) return grant.siteId === target.siteId;
  return target.anySite === true;
}

/**
 * `true` when `principal` may perform `permission` on `target`. Impersonation (step 7): the
 * grants of an impersonating session were already replaced by the impersonation role at
 * organization scope (see auth/principal.ts), so only the target pinning is checked here.
 */
export function evaluate(
  principal: Principal | null,
  permission: string,
  target: AuthzTarget,
): boolean {
  if (principal === null) return false;
  const definition = getPermission(permission);
  if (definition === undefined) return false;
  if (principal.kind === 'admin' && principal.impersonation !== null) {
    if (target.organizationId !== principal.impersonation.organizationId) return false;
    if (definition.platformOnly) return false;
  }
  const applicable = principal.grants.filter((grant) => grantCovers(grant, target));
  if (!applicable.some((grant) => grant.permissions.has(permission))) return false;
  if (definition.platformOnly) {
    return applicable.some(
      (grant) => grant.scopeType === 'platform' && grant.permissions.has(permission),
    );
  }
  return true;
}

/**
 * Sites of `organizationId` on which `permission` is granted: `'all'` when an organization or
 * platform binding grants it, else the list of site ids (possibly empty). Used by list
 * endpoints to filter rather than deny (§4.4 "Listing endpoints apply the same bindings").
 */
export function permittedSites(
  principal: Principal | null,
  permission: string,
  organizationId: string,
): 'all' | string[] {
  if (principal === null) return [];
  if (
    principal.kind === 'admin' &&
    principal.impersonation !== null &&
    principal.impersonation.organizationId !== organizationId
  ) {
    return [];
  }
  if (evaluate(principal, permission, { organizationId })) return 'all';
  const sites = new Set<string>();
  for (const grant of principal.grants) {
    if (
      grant.scopeType === 'site' &&
      grant.organizationId === organizationId &&
      grant.siteId !== null &&
      grant.permissions.has(permission)
    ) {
      sites.add(grant.siteId);
    }
  }
  return [...sites];
}

/** Effective permission keys per binding scope, for `/auth/me`. */
export function permissionsByScope(principal: Principal): {
  scope_type: Grant['scopeType'];
  organization_id: string | null;
  site_id: string | null;
  permissions: string[];
}[] {
  const merged = new Map<string, { grant: Grant; permissions: Set<string> }>();
  for (const grant of principal.grants) {
    const key = `${grant.scopeType}|${grant.organizationId ?? ''}|${grant.siteId ?? ''}`;
    const entry = merged.get(key) ?? { grant, permissions: new Set<string>() };
    for (const permission of grant.permissions) entry.permissions.add(permission);
    merged.set(key, entry);
  }
  return [...merged.values()].map(({ grant, permissions }) => ({
    scope_type: grant.scopeType,
    organization_id: grant.organizationId,
    site_id: grant.siteId,
    permissions: [...permissions].sort(),
  }));
}

/** True when `holder` has every permission of `required` within the target scope (no escalation). */
export function holdsAll(
  principal: Principal | null,
  required: Iterable<string>,
  target: AuthzTarget,
): boolean {
  for (const permission of required) {
    if (!evaluate(principal, permission, target)) return false;
  }
  return true;
}
