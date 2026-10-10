/**
 * View types for API rows. The OpenAPI document types most list rows as open objects, so the
 * screens narrow them to the columns they render (names = database columns returned by the
 * API, DATABASE_DESIGN.md). Every field is treated as possibly absent at runtime.
 */
export type Row = Record<string, unknown> & { id: string };

export interface Page<T> {
  data: T[];
  next_cursor: string | null;
}

export type ScopeType = 'platform' | 'organization' | 'site';

export interface Binding {
  id: string;
  scope_type: ScopeType;
  organization_id: string | null;
  site_id: string | null;
  expires_at: string | null;
  role_id: string;
  role_key: string;
  role_name: string;
}

export interface ScopedPermissions {
  scope_type: ScopeType;
  organization_id: string | null;
  site_id: string | null;
  permissions: string[];
}

export interface Impersonation {
  organization_id: string;
  reason: string;
  expires_at: string;
}

export interface AdminMe {
  kind: 'admin';
  administrator: {
    id: string;
    email: string;
    display_name: string;
    status: string;
    last_login_at: string | null;
  };
  mfa: {
    /** ADMIN_MFA_MODE (D-046); absent = treated as `required`. */
    mode?: 'off' | 'required';
    enrolled: boolean;
    required: boolean;
    pending: boolean;
  };
  bindings: Binding[];
  permissions_by_scope: ScopedPermissions[];
  impersonation: Impersonation | null;
}

export interface ApiKeyMe {
  kind: 'api_key';
  api_key: { id: string; organization_id: string };
  permissions_by_scope: ScopedPermissions[];
}

export type Me = AdminMe | ApiKeyMe;

export interface LoginResult {
  mfa_required: boolean;
  mfa_token?: string;
  administrator?: { id: string; email: string };
  mfa_enrolment_required?: boolean;
}
