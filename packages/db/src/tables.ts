/**
 * Canonical table catalogue. Integration tests assert these lists against pg_catalog, so a new
 * table must be added here (and to the RLS migration) to land. Used by `truncateAll`
 * (@ecloud/testing), per-tenant export (DATABASE_DESIGN.md §10) and `ensure-partitions`.
 */

/** Every application table in `public`, excluding `schema_migrations` and partitions. */
export const ALL_TABLES = Object.freeze([
  'organizations',
  'sites',
  'administrators',
  'admin_sessions',
  'mfa_credentials',
  'permissions',
  'roles',
  'role_permissions',
  'role_bindings',
  'api_keys',
  'invitations',
  'adapter_types',
  'network_devices',
  'wireguard_peers',
  'nas_clients',
  'identity_providers',
  'user_groups',
  'users',
  'client_devices',
  'schedules',
  'policies',
  'voucher_batches',
  'vouchers',
  'policy_assignments',
  'policy_translations',
  'portal_themes',
  'captive_portals',
  'portal_login_attempts',
  'sessions',
  'accounting_records',
  'auth_events',
  'session_actions',
  'usage_counters',
  'audit_logs',
  'outbox',
  'webhooks',
  'webhook_deliveries',
] as const);

export type TableName = (typeof ALL_TABLES)[number];

/** Tables in the `radius` schema (FreeRADIUS surface). */
export const RADIUS_TABLES = Object.freeze([
  'radius.radacct_raw',
  'radius.radpostauth_raw',
  'radius.nas',
] as const);

/** Catalogue tables populated by migrations / `seed`; `truncateAll` must leave them alone. */
export const SEED_TABLES = Object.freeze([
  'permissions',
  'adapter_types',
  'roles',
  'role_permissions',
] as const satisfies readonly TableName[]);

/** Everything a test may truncate between cases (seeds survive). */
export const DATA_TABLES: readonly TableName[] = Object.freeze(
  ALL_TABLES.filter((t) => !(SEED_TABLES as readonly string[]).includes(t)),
);

/** Tables with ENABLE + FORCE ROW LEVEL SECURITY and a `tenant_isolation` policy. */
export const TENANT_SCOPED_TABLES = Object.freeze([
  'sites',
  'roles',
  'role_permissions',
  'role_bindings',
  'api_keys',
  'invitations',
  'network_devices',
  'nas_clients',
  'wireguard_peers',
  'identity_providers',
  'user_groups',
  'users',
  'client_devices',
  'schedules',
  'policies',
  'voucher_batches',
  'vouchers',
  'policy_assignments',
  'policy_translations',
  'portal_themes',
  'captive_portals',
  'portal_login_attempts',
  'sessions',
  'accounting_records',
  'auth_events',
  'session_actions',
  'usage_counters',
  'audit_logs',
  'outbox',
  'webhooks',
  'webhook_deliveries',
] as const satisfies readonly TableName[]);

/** Platform tables: no tenant key, no RLS; read by authentication before a tenant is known. */
export const PLATFORM_TABLES: readonly TableName[] = Object.freeze(
  ALL_TABLES.filter((t) => !(TENANT_SCOPED_TABLES as readonly string[]).includes(t)),
);

/** Monthly RANGE-partitioned append-only tables (INSERT/SELECT only; retention drops partitions). */
export const PARTITIONED_TABLES = Object.freeze([
  'policy_translations',
  'portal_login_attempts',
  'accounting_records',
  'auth_events',
  'audit_logs',
  'webhook_deliveries',
] as const satisfies readonly TableName[]);

export const APPEND_ONLY_TABLES = PARTITIONED_TABLES;
