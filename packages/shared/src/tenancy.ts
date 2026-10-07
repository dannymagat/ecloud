/**
 * Tenant context under which a unit of work runs (MULTITENANCY.md §2, DATABASE_DESIGN.md §8).
 * - `platform`: BYPASSRLS connection (worker, migrations, platform administration).
 * - `organization`: RLS-scoped connection; `SET LOCAL app.current_org = organizationId`.
 *   `siteIds` optionally narrows a site-scoped binding to the sites it may touch.
 */
export type TenantContext =
  | { readonly kind: 'platform' }
  | {
      readonly kind: 'organization';
      readonly organizationId: string;
      readonly siteIds?: readonly string[];
    };

export const PLATFORM_TENANT: TenantContext = Object.freeze({ kind: 'platform' });

export function organizationTenant(
  organizationId: string,
  siteIds?: readonly string[],
): TenantContext {
  return siteIds === undefined
    ? { kind: 'organization', organizationId }
    : { kind: 'organization', organizationId, siteIds: [...siteIds] };
}

export type ActorKind = 'admin' | 'api_key' | 'internal' | 'portal';

/**
 * Who is performing an action. Authorization decisions use role bindings resolved from the
 * actor (MULTITENANCY.md §4.4); this type only identifies the principal.
 */
export type Actor =
  | {
      readonly kind: 'admin';
      readonly administratorId: string;
      readonly sessionId: string;
      /** Set while a Platform Support admin impersonates a tenant (MULTITENANCY.md §4.5). */
      readonly impersonatingOrganizationId?: string;
    }
  | {
      readonly kind: 'api_key';
      readonly apiKeyId: string;
      /** Administrator who created the key, for audit attribution. */
      readonly createdByAdministratorId?: string;
    }
  | {
      /** Trusted in-cluster caller on the internal listener (e.g. FreeRADIUS rlm_rest). */
      readonly kind: 'internal';
      readonly service: string;
    }
  | {
      /** Unauthenticated or portal-credential subscriber flow on the captive portal. */
      readonly kind: 'portal';
      readonly portalSessionId?: string;
      readonly clientMac?: string;
    };

export function isPlatformTenant(tenant: TenantContext): tenant is { kind: 'platform' } {
  return tenant.kind === 'platform';
}
