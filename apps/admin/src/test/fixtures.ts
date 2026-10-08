import type { AdminMe, ScopedPermissions } from '../api/types';

export const ORG_A = '01900000-0000-7000-8000-00000000000a';
export const ORG_B = '01900000-0000-7000-8000-00000000000b';

export function adminMe(scopes: ScopedPermissions[], overrides: Partial<AdminMe> = {}): AdminMe {
  return {
    kind: 'admin',
    administrator: {
      id: '01900000-0000-7000-8000-0000000000ad',
      email: 'operator@example.test',
      display_name: 'Operator',
      status: 'active',
      last_login_at: null,
    },
    mfa: { enrolled: true, required: false, pending: false },
    bindings: [],
    permissions_by_scope: scopes,
    impersonation: null,
    ...overrides,
  };
}

export const orgScope = (organizationId: string, permissions: string[]): ScopedPermissions => ({
  scope_type: 'organization',
  organization_id: organizationId,
  site_id: null,
  permissions,
});

export const platformScope = (permissions: string[]): ScopedPermissions => ({
  scope_type: 'platform',
  organization_id: null,
  site_id: null,
  permissions,
});
