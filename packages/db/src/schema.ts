/**
 * Kysely `Database` interface for every table created by packages/db/migrations.
 * Column types mirror the SQL exactly; keep this file in step with the migrations.
 *
 * Driver conventions (see client.ts `configureTypeParsers`):
 *  - bigint (int8) is parsed to `number` (exact below 2^53 ≈ 9 PB of octets);
 *  - `date` is returned as 'YYYY-MM-DD' text (no timezone surprises);
 *  - inet / cidr / macaddr are text on both sides;
 *  - jsonb: pass objects directly; wrap ARRAYS with JSON.stringify (pg would send a PG array).
 */
import type { ColumnType, Generated, Insertable, Selectable, Updateable } from 'kysely';

export type Uuid = string;
export type Inet = string;
export type Cidr = string;
export type Macaddr = string;
export type BigintColumn = number;
export type Timestamp = ColumnType<Date, Date | string, Date | string>;
export type GeneratedTimestamp = ColumnType<Date, Date | string | undefined, Date | string>;
export type NullableTimestamp = ColumnType<
  Date | null,
  Date | string | null | undefined,
  Date | string | null
>;
export type DateOnly = ColumnType<string, Date | string, Date | string>;
export type Jsonb<T = unknown> = ColumnType<T, T | string, T | string>;
export type GeneratedJsonb<T = unknown> = ColumnType<T, T | string | undefined, T | string>;
export type NullableJsonb<T = unknown> = ColumnType<
  T | null,
  T | string | null | undefined,
  T | string | null
>;
export type Point = ColumnType<
  { x: number; y: number } | null,
  string | null | undefined,
  string | null
>;

export type OrganizationStatus = 'active' | 'suspended' | 'archived';
export type AdministratorStatus = 'invited' | 'active' | 'disabled';
export type ScopeType = 'platform' | 'organization' | 'site';
export type UserStatus = 'active' | 'suspended' | 'expired' | 'disabled';
export type UserOrigin = 'admin' | 'portal_signup' | 'voucher' | 'idp';
export type AuthMethod = 'password' | 'mac' | 'voucher' | 'idp';
export type IdentityProviderType =
  'local' | 'oidc' | 'google' | 'facebook' | 'saml' | 'sms_otp' | 'radius_proxy';
export type PolicyScopeType = 'user' | 'group' | 'site' | 'temporary';
export type PolicyStatus = 'draft' | 'active' | 'retired';
export type PolicyTargetType = 'user' | 'user_group' | 'site' | 'client_device' | 'voucher_batch';
export type TranslationTrigger = 'authorize' | 'coa' | 'preview' | 'config_push';
export type VoucherStatus = 'unused' | 'active' | 'exhausted' | 'expired' | 'revoked';
export type PortalType = 'uspot' | 'coovachilli' | 'external';
export type SessionStatus = 'authorized' | 'active' | 'stopped' | 'stale' | 'expired';
export type AccountingStatusType =
  'start' | 'interim' | 'stop' | 'accounting_on' | 'accounting_off';
export type AuthResult = 'accept' | 'reject' | 'challenge' | 'error';
export type SessionActionType = 'disconnect' | 'coa_update';
export type SessionActionStatus = 'pending' | 'sent' | 'ack' | 'nak' | 'timeout' | 'unsupported';
export type UsageSubjectType = 'user' | 'client_device' | 'voucher';
export type UsagePeriodType = 'daily' | 'monthly' | 'total';
export type AuditActorType = 'administrator' | 'api_key' | 'subscriber' | 'system';
export type DeviceMode = 'bridge' | 'routed' | 'unknown';
export type MgmtStatus = 'unknown' | 'online' | 'offline';
export type EnabledStatus = 'active' | 'disabled';
export type AdapterVerificationStatus =
  'verified_code' | 'verified_docs' | 'proposed' | 'unknown' | 'requires_device_test';
export type WebhookDeliveryStatus = 'success' | 'failed' | 'timeout';
export type PortalLoginResult = 'accept' | 'reject' | 'error';
export type RadiusAcctStatusType =
  'Start' | 'Interim-Update' | 'Stop' | 'Accounting-On' | 'Accounting-Off';

// ---------------------------------------------------------------------------------------------
// 3.1 Tenancy & administration
// ---------------------------------------------------------------------------------------------

export interface OrganizationsTable {
  id: Generated<Uuid>;
  slug: string;
  name: string;
  status: Generated<OrganizationStatus>;
  settings: GeneratedJsonb<Record<string, unknown>>;
  max_sites: number | null;
  max_devices: number | null;
  max_users: number | null;
  max_concurrent_sessions: number | null;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
  deleted_at: NullableTimestamp;
}

export interface SitesTable {
  id: Generated<Uuid>;
  organization_id: Uuid;
  slug: string;
  name: string;
  timezone: Generated<string>;
  address: string | null;
  geo: Point;
  status: Generated<OrganizationStatus>;
  settings: GeneratedJsonb<Record<string, unknown>>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
  deleted_at: NullableTimestamp;
}

export interface AdministratorsTable {
  id: Generated<Uuid>;
  email: string;
  display_name: Generated<string>;
  password_hash: string | null;
  status: Generated<AdministratorStatus>;
  mfa_enforced: Generated<boolean>;
  /** Migration 018 (D-038): set by an MFA reset, cleared by the next confirmed enrolment. */
  mfa_reenrol_required: Generated<boolean>;
  last_login_at: NullableTimestamp;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
  deleted_at: NullableTimestamp;
}

export interface AdminSessionsTable {
  id: Generated<Uuid>;
  administrator_id: Uuid;
  token_hash: string;
  ip: Inet | null;
  user_agent: string | null;
  impersonating_organization_id: Uuid | null;
  impersonation_reason: string | null;
  expires_at: Timestamp;
  last_seen_at: NullableTimestamp;
  revoked_at: NullableTimestamp;
  mfa_verified_at: NullableTimestamp;
  created_at: GeneratedTimestamp;
}

export interface MfaCredentialsTable {
  id: Generated<Uuid>;
  administrator_id: Uuid;
  type: Generated<'totp'>;
  label: string | null;
  secret_enc: string;
  recovery_codes_hash: Generated<string[]>;
  verified_at: NullableTimestamp;
  last_used_at: NullableTimestamp;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface PermissionsTable {
  key: string;
  resource: string;
  action: string;
  description: Generated<string>;
  min_scope: ScopeType;
  is_platform_only: Generated<boolean>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface RolesTable {
  id: Generated<Uuid>;
  organization_id: Uuid | null;
  key: string;
  name: string;
  description: Generated<string>;
  is_template: Generated<boolean>;
  template_key: string | null;
  template_version: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface RolePermissionsTable {
  role_id: Uuid;
  permission_key: string;
  created_at: GeneratedTimestamp;
}

export interface RoleBindingsTable {
  id: Generated<Uuid>;
  administrator_id: Uuid;
  role_id: Uuid;
  scope_type: ScopeType;
  organization_id: Uuid | null;
  site_id: Uuid | null;
  granted_by: Uuid | null;
  expires_at: NullableTimestamp;
  created_at: GeneratedTimestamp;
}

export interface ApiKeysTable {
  id: Generated<Uuid>;
  organization_id: Uuid | null;
  created_by: Uuid | null;
  name: string;
  key_prefix: string;
  key_hash: string;
  role_id: Uuid;
  scope_type: ScopeType;
  site_id: Uuid | null;
  allowed_cidrs: Cidr[] | null;
  last_used_at: NullableTimestamp;
  expires_at: NullableTimestamp;
  revoked_at: NullableTimestamp;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface InvitationsTable {
  id: Generated<Uuid>;
  organization_id: Uuid;
  email: string;
  role_id: Uuid;
  scope_type: 'organization' | 'site';
  site_id: Uuid | null;
  token_hash: string;
  invited_by: Uuid | null;
  expires_at: Timestamp;
  accepted_at: NullableTimestamp;
  accepted_administrator_id: Uuid | null;
  created_at: GeneratedTimestamp;
}

// ---------------------------------------------------------------------------------------------
// 3.2 Network
// ---------------------------------------------------------------------------------------------

// Migration 019: compatibility-registry mirror (platform, seeded from @ecloud/adapters) and
// tenant controllers (MULTI_VENDOR_INTEGRATION_PLAN.md §8.2).

export type Lifecycle =
  'planned' | 'researched' | 'implemented' | 'lab-validated' | 'production-validated';
export type RoadmapPhase = 'pilot' | 'phase-a' | 'phase-b' | 'phase-c' | 'legacy-candidate';
export type DeploymentMode = 'native' | 'gateway';
export type EnforcementPoint = 'ap' | 'controller' | 'gateway' | 'UNKNOWN';
export type ConfigurationKind = 'ucentral' | 'coova-chilli-conf' | 'vendor-ui' | 'UNKNOWN';
export type ControllerKind = 'cloud' | 'on_premises' | 'embedded';

export interface VendorsTable {
  key: string;
  name: string;
  lifecycle: Lifecycle;
  roadmap_phase: RoadmapPhase;
  doc_links: GeneratedJsonb<unknown[]>;
  notes: string | null;
  registry_hash: string;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface HardwareModelsTable {
  id: Generated<Uuid>;
  vendor_key: string;
  model: string;
  notes: string | null;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface FirmwareVersionsTable {
  id: Generated<Uuid>;
  vendor_key: string;
  hardware_model_id: Uuid | null;
  version: string;
  controller_product: string | null;
  controller_version: string | null;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface CompatibilityEntriesTable {
  key: string;
  vendor_key: string;
  hardware_model_id: Uuid | null;
  firmware_version_id: Uuid | null;
  hardware_model: string;
  firmware: string;
  controller: NullableJsonb<{ product: string; version: string }>;
  lifecycle: Lifecycle;
  deployment_modes: ColumnType<DeploymentMode[], DeploymentMode[] | undefined, DeploymentMode[]>;
  enforcement_point: EnforcementPoint;
  adapter_key: string | null;
  source_version_matches_device: boolean | null;
  configuration_kind: ConfigurationKind;
  identity: GeneratedJsonb<unknown[]>;
  profile: Jsonb<Record<string, unknown>>;
  capabilities: Jsonb<Record<string, unknown>>;
  open_items: GeneratedJsonb<unknown[]>;
  registry_hash: string;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface ControllersTable {
  id: Generated<Uuid>;
  organization_id: Uuid;
  site_id: Uuid | null;
  vendor_key: string;
  name: string;
  kind: ControllerKind;
  /** https only; never fetched in M11 (plan OQ-17). */
  base_url: string;
  /** Envelope-sealed credential (`enc:v1.…`); never returned by the API. */
  credential_secret_ref: string | null;
  status: Generated<EnabledStatus>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
  deleted_at: NullableTimestamp;
}

export interface AdapterTypesTable {
  key: string;
  name: string;
  supports_coa: boolean | null;
  supports_rate_limit: boolean | null;
  supports_vlan: boolean | null;
  capabilities: NullableJsonb<Record<string, unknown>>;
  verification_status: Generated<AdapterVerificationStatus>;
  evidence_url: string | null;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface NetworkDevicesTable {
  id: Generated<Uuid>;
  organization_id: Uuid;
  site_id: Uuid;
  serial: string;
  mac: Macaddr | null;
  model: string | null;
  firmware: string | null;
  mode: Generated<DeviceMode>;
  adapter_type_key: string | null;
  mgmt_status: Generated<MgmtStatus>;
  last_seen_at: NullableTimestamp;
  reported_capabilities: NullableJsonb<Record<string, unknown>>;
  wireguard_peer_id: Uuid | null;
  /** Migration 019: registry references (free-text `model` / `firmware` are kept). */
  hardware_model_id: Uuid | null;
  firmware_version_id: Uuid | null;
  controller_id: Uuid | null;
  /** false for third-party APs behind a gateway that ECLOUD does not configure. */
  managed: Generated<boolean>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
  deleted_at: NullableTimestamp;
}

export interface WireguardPeersTable {
  id: Generated<Uuid>;
  organization_id: Uuid;
  site_id: Uuid;
  network_device_id: Uuid | null;
  name: string;
  public_key: string;
  tunnel_ip: Inet;
  allowed_ips: Cidr[];
  endpoint: string | null;
  preshared_key_ref: string | null;
  persistent_keepalive_s: number | null;
  last_handshake_at: NullableTimestamp;
  status: Generated<EnabledStatus>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface NasClientsTable {
  id: Generated<Uuid>;
  organization_id: Uuid;
  site_id: Uuid;
  network_device_id: Uuid | null;
  name: string;
  nas_identifier: string | null;
  nas_ip: Inet;
  adapter_type_key: string;
  /** Migration 015 (D-035): @ecloud/adapters key; NULL only for legacy rows without a mapping. */
  adapter_key: string | null;
  /** Migration 019: `native` (AP enforces) or `gateway` (CoovaChilli-style gateway). */
  deployment_mode: Generated<DeploymentMode>;
  /** Migration 019: optional vendor controller of the same organization. */
  controller_id: Uuid | null;
  secret_ref: string;
  coa_port: number | null;
  coa_supported: boolean | null;
  require_message_authenticator: Generated<boolean>;
  status: Generated<EnabledStatus>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
  deleted_at: NullableTimestamp;
}

// ---------------------------------------------------------------------------------------------
// 3.3 Subscribers, devices, identity
// ---------------------------------------------------------------------------------------------

export interface IdentityProvidersTable {
  id: Generated<Uuid>;
  organization_id: Uuid;
  type: IdentityProviderType;
  name: string;
  config: GeneratedJsonb<Record<string, unknown>>;
  client_secret_ref: string | null;
  enabled: Generated<boolean>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface UserGroupsTable {
  id: Generated<Uuid>;
  organization_id: Uuid;
  site_id: Uuid | null;
  name: string;
  description: Generated<string>;
  is_default: Generated<boolean>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface UsersTable {
  id: Generated<Uuid>;
  organization_id: Uuid;
  site_id: Uuid | null;
  username: string;
  password_hash: string | null;
  auth_methods: Generated<AuthMethod[]>;
  user_group_id: Uuid | null;
  identity_provider_id: Uuid | null;
  external_subject: string | null;
  display_name: string | null;
  email: string | null;
  phone: string | null;
  status: Generated<UserStatus>;
  valid_from: NullableTimestamp;
  valid_until: NullableTimestamp;
  max_devices: number | null;
  origin: Generated<UserOrigin>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
  deleted_at: NullableTimestamp;
}

export interface ClientDevicesTable {
  id: Generated<Uuid>;
  organization_id: Uuid;
  user_id: Uuid | null;
  mac: Macaddr;
  name: string | null;
  device_type: string | null;
  first_seen_at: NullableTimestamp;
  last_seen_at: NullableTimestamp;
  mac_auth_enabled: Generated<boolean>;
  blocked: Generated<boolean>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
  deleted_at: NullableTimestamp;
}

// ---------------------------------------------------------------------------------------------
// 3.4 Policy model
// ---------------------------------------------------------------------------------------------

export interface ScheduleRule {
  days: number[];
  start: string;
  end: string;
}

export interface SchedulesTable {
  id: Generated<Uuid>;
  organization_id: Uuid;
  name: string;
  timezone: string;
  rules: Jsonb<ScheduleRule[]>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface PoliciesTable {
  id: Generated<Uuid>;
  organization_id: Uuid;
  site_id: Uuid | null;
  name: string;
  description: Generated<string>;
  scope_type: PolicyScopeType;
  download_rate_kbps: number | null;
  upload_rate_kbps: number | null;
  burst_download_kbps: number | null;
  burst_upload_kbps: number | null;
  burst_duration_s: number | null;
  quota_daily_bytes: BigintColumn | null;
  quota_monthly_bytes: BigintColumn | null;
  quota_total_bytes: BigintColumn | null;
  session_timeout_s: number | null;
  idle_timeout_s: number | null;
  max_concurrent_sessions: number | null;
  max_devices: number | null;
  valid_from: NullableTimestamp;
  valid_until: NullableTimestamp;
  vlan_id: number | null;
  schedule_id: Uuid | null;
  priority: Generated<number>;
  is_default: Generated<boolean>;
  status: Generated<PolicyStatus>;
  version: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
  deleted_at: NullableTimestamp;
}

export interface PolicyAssignmentsTable {
  id: Generated<Uuid>;
  organization_id: Uuid;
  policy_id: Uuid;
  target_type: PolicyTargetType;
  user_id: Uuid | null;
  user_group_id: Uuid | null;
  site_id: Uuid | null;
  client_device_id: Uuid | null;
  voucher_batch_id: Uuid | null;
  effective_from: GeneratedTimestamp;
  effective_until: NullableTimestamp;
  priority: Generated<number>;
  created_by: Uuid | null;
  note: string | null;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface PolicyTranslationsTable {
  id: Generated<BigintColumn>;
  organization_id: Uuid;
  policy_id: Uuid | null;
  policy_version: number;
  adapter_type_key: string;
  adapter_version: string | null;
  nas_client_id: Uuid | null;
  session_id: Uuid | null;
  trigger: TranslationTrigger;
  input_snapshot: GeneratedJsonb<Record<string, unknown>>;
  emitted: GeneratedJsonb<unknown>;
  unsupported: GeneratedJsonb<unknown[]>;
  created_at: GeneratedTimestamp;
}

// ---------------------------------------------------------------------------------------------
// 3.6 Vouchers and captive portal
// ---------------------------------------------------------------------------------------------

export interface VoucherBatchesTable {
  id: Generated<Uuid>;
  organization_id: Uuid;
  site_id: Uuid | null;
  name: string;
  policy_id: Uuid | null;
  count: number;
  code_format: Generated<string>;
  valid_from: NullableTimestamp;
  valid_until: NullableTimestamp;
  duration_s: number | null;
  /** Migration 017 (D-037): NULL = no count limit (duration-only voucher); DEFAULT 1. */
  max_uses: ColumnType<number | null, number | null | undefined, number | null>;
  max_devices: Generated<number>;
  created_by: Uuid | null;
  exported_at: NullableTimestamp;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface VouchersTable {
  id: Generated<Uuid>;
  organization_id: Uuid;
  batch_id: Uuid;
  code_hash: string;
  code_hint: string | null;
  code_enc: string | null;
  status: Generated<VoucherStatus>;
  activated_at: NullableTimestamp;
  expires_at: NullableTimestamp;
  use_count: Generated<number>;
  bound_user_id: Uuid | null;
  revoked_by: Uuid | null;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
  deleted_at: NullableTimestamp;
}

export interface PortalThemesTable {
  id: Generated<Uuid>;
  organization_id: Uuid;
  name: string;
  /** Migration 022: uuid, FK (organization_id, logo_asset_ref) -> portal_assets. */
  logo_asset_ref: Uuid | null;
  colors: GeneratedJsonb<Record<string, unknown>>;
  strings: GeneratedJsonb<Record<string, unknown>>;
  custom_css: string | null;
  version: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface CaptivePortalsTable {
  id: Generated<Uuid>;
  organization_id: Uuid;
  site_id: Uuid;
  name: string;
  public_slug: string;
  portal_type: PortalType;
  network_ref: string;
  theme_id: Uuid | null;
  auth_methods: Generated<string[]>;
  identity_provider_ids: Generated<Uuid[]>;
  uam_secret_ref: string | null;
  redirect_url: string | null;
  terms_version: string | null;
  walled_garden: Generated<string[]>;
  adapter_config: GeneratedJsonb<Record<string, unknown>>;
  status: Generated<EnabledStatus>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

/** Migration 021: metadata of branding objects in @ecloud/storage (key = org/{org}/{purpose}/{id}). */
export interface PortalAssetsTable {
  id: Generated<Uuid>;
  organization_id: Uuid;
  purpose: Generated<'branding'>;
  storage_key: string;
  content_type: 'image/png' | 'image/jpeg' | 'image/webp';
  byte_size: number;
  sha256: string;
  original_filename: string | null;
  created_by: Uuid | null;
  created_at: GeneratedTimestamp;
}

/** Migration 021: immutable terms / click-through text versions per captive portal. */
export interface PortalTermsVersionsTable {
  id: Generated<Uuid>;
  organization_id: Uuid;
  captive_portal_id: Uuid;
  version: number;
  locale: Generated<string>;
  body: string;
  created_by: Uuid | null;
  created_at: GeneratedTimestamp;
}

export interface PortalLoginAttemptsTable {
  id: Generated<BigintColumn>;
  organization_id: Uuid;
  captive_portal_id: Uuid;
  method: string;
  username_or_code_prefix: string | null;
  mac: Macaddr | null;
  client_ip: Inet | null;
  result: PortalLoginResult;
  reason: string | null;
  created_at: GeneratedTimestamp;
}

// ---------------------------------------------------------------------------------------------
// 3.5 Sessions, accounting, audit
// ---------------------------------------------------------------------------------------------

export interface SessionsTable {
  id: Generated<Uuid>;
  organization_id: Uuid;
  site_id: Uuid;
  nas_client_id: Uuid;
  network_device_id: Uuid | null;
  user_id: Uuid | null;
  client_device_id: Uuid | null;
  voucher_id: Uuid | null;
  policy_id: Uuid | null;
  policy_version: number | null;
  acct_session_id: string;
  acct_unique_id: string;
  username_raw: string | null;
  mac: Macaddr | null;
  framed_ip: Inet | null;
  nas_port_id: string | null;
  called_station_id: string | null;
  calling_station_id: string | null;
  started_at: Timestamp;
  last_interim_at: NullableTimestamp;
  stopped_at: NullableTimestamp;
  input_octets: Generated<BigintColumn>;
  output_octets: Generated<BigintColumn>;
  session_time_s: Generated<BigintColumn>;
  status: Generated<SessionStatus>;
  terminate_cause: string | null;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface AccountingRecordsTable {
  id: Generated<BigintColumn>;
  organization_id: Uuid | null;
  session_id: Uuid | null;
  acct_unique_id: string;
  acct_session_id: string;
  status_type: AccountingStatusType;
  nas_ip: Inet;
  nas_identifier: string | null;
  username: string | null;
  calling_station_id: string | null;
  called_station_id: string | null;
  framed_ip: Inet | null;
  event_time: NullableTimestamp;
  received_at: GeneratedTimestamp;
  input_octets: BigintColumn | null;
  output_octets: BigintColumn | null;
  session_time_s: BigintColumn | null;
  terminate_cause: string | null;
  raw: NullableJsonb<Record<string, unknown>>;
}

export interface AuthEventsTable {
  id: Generated<BigintColumn>;
  organization_id: Uuid | null;
  nas_client_id: Uuid | null;
  username: string | null;
  calling_station_id: string | null;
  called_station_id: string | null;
  nas_ip: Inet | null;
  result: AuthResult;
  reason: string | null;
  auth_method: string | null;
  identity_provider_id: Uuid | null;
  policy_id: Uuid | null;
  reply_summary: NullableJsonb<Record<string, unknown>>;
  created_at: GeneratedTimestamp;
}

export interface SessionActionsTable {
  id: Generated<Uuid>;
  organization_id: Uuid;
  session_id: Uuid;
  action: SessionActionType;
  payload: GeneratedJsonb<Record<string, unknown>>;
  status: Generated<SessionActionStatus>;
  requested_by: Uuid | null;
  request_id: string | null;
  error: string | null;
  created_at: GeneratedTimestamp;
  completed_at: NullableTimestamp;
}

export interface UsageCountersTable {
  organization_id: Uuid;
  subject_type: UsageSubjectType;
  subject_id: Uuid;
  period_type: UsagePeriodType;
  period_start: DateOnly;
  bytes_in: Generated<BigintColumn>;
  bytes_out: Generated<BigintColumn>;
  session_count: Generated<number>;
  session_time_s: Generated<BigintColumn>;
  last_record_id: BigintColumn | null;
  reconciled_at: NullableTimestamp;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface AuditLogsTable {
  id: Generated<BigintColumn>;
  organization_id: Uuid | null;
  actor_type: AuditActorType;
  actor_id: Uuid | null;
  impersonator_id: Uuid | null;
  action: string;
  target_type: string | null;
  target_id: Uuid | null;
  before: NullableJsonb<unknown>;
  after: NullableJsonb<unknown>;
  ip: Inet | null;
  request_id: string | null;
  user_agent: string | null;
  created_at: GeneratedTimestamp;
}

export interface OutboxTable {
  id: Generated<BigintColumn>;
  organization_id: Uuid | null;
  event: string;
  payload: GeneratedJsonb<Record<string, unknown>>;
  request_id: string | null;
  created_at: GeneratedTimestamp;
  published_at: NullableTimestamp;
}

export interface WebhooksTable {
  id: Generated<Uuid>;
  organization_id: Uuid;
  name: string;
  url: string;
  events: string[];
  signing_secret_ref: string | null;
  enabled: Generated<boolean>;
  failure_count: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface WebhookDeliveriesTable {
  id: Generated<BigintColumn>;
  organization_id: Uuid;
  webhook_id: Uuid;
  event: string;
  payload: GeneratedJsonb<Record<string, unknown>>;
  status: WebhookDeliveryStatus;
  http_status: number | null;
  attempt: Generated<number>;
  error: string | null;
  created_at: GeneratedTimestamp;
}

// ---------------------------------------------------------------------------------------------
// radius schema (FreeRADIUS surface, DATABASE_DESIGN.md §4.2)
// ---------------------------------------------------------------------------------------------

export interface RadacctRawTable {
  radacctid: Generated<BigintColumn>;
  acctsessionid: string;
  acctuniqueid: string;
  username: string | null;
  realm: string | null;
  nasipaddress: Inet;
  nasidentifier: string | null;
  nasportid: string | null;
  nasporttype: string | null;
  acctstarttime: NullableTimestamp;
  acctupdatetime: NullableTimestamp;
  acctstoptime: NullableTimestamp;
  acctinterval: BigintColumn | null;
  acctsessiontime: BigintColumn | null;
  acctauthentic: string | null;
  connectinfo_start: string | null;
  connectinfo_stop: string | null;
  acctinputoctets: BigintColumn | null;
  acctoutputoctets: BigintColumn | null;
  calledstationid: string | null;
  callingstationid: string | null;
  acctterminatecause: string | null;
  servicetype: string | null;
  framedprotocol: string | null;
  framedipaddress: Inet | null;
  framedipv6address: Inet | null;
  framedipv6prefix: Inet | null;
  framedinterfaceid: string | null;
  delegatedipv6prefix: Inet | null;
  class: string | null;
  acctstatustype: RadiusAcctStatusType;
  eventtimestamp: NullableTimestamp;
  acctdelaytime: number | null;
  received_at: GeneratedTimestamp;
  /** UDP source FreeRADIUS authenticated (migration 014); the only trusted NAS identity. */
  packet_src_ip: Inet | null;
}

export interface RadpostauthRawTable {
  id: Generated<BigintColumn>;
  username: string | null;
  reply: string | null;
  calledstationid: string | null;
  callingstationid: string | null;
  nasipaddress: Inet | null;
  nasidentifier: string | null;
  class: string | null;
  authdate: GeneratedTimestamp;
}

export interface RadiusNasTable {
  id: Generated<number>;
  nas_client_id: Uuid;
  organization_id: Uuid;
  nasname: string;
  shortname: string;
  type: Generated<string>;
  ports: number | null;
  secret: string;
  server: string | null;
  community: string | null;
  description: string | null;
  require_message_authenticator: Generated<boolean>;
  rendered_at: GeneratedTimestamp;
}

export interface SchemaMigrationsTable {
  name: string;
  version: string;
  checksum: string;
  applied_at: GeneratedTimestamp;
  applied_by: Generated<string>;
  duration_ms: Generated<number>;
  baselined: Generated<boolean>;
}

export interface Database {
  organizations: OrganizationsTable;
  sites: SitesTable;
  administrators: AdministratorsTable;
  admin_sessions: AdminSessionsTable;
  mfa_credentials: MfaCredentialsTable;
  permissions: PermissionsTable;
  roles: RolesTable;
  role_permissions: RolePermissionsTable;
  role_bindings: RoleBindingsTable;
  api_keys: ApiKeysTable;
  invitations: InvitationsTable;
  adapter_types: AdapterTypesTable;
  network_devices: NetworkDevicesTable;
  wireguard_peers: WireguardPeersTable;
  nas_clients: NasClientsTable;
  vendors: VendorsTable;
  hardware_models: HardwareModelsTable;
  firmware_versions: FirmwareVersionsTable;
  compatibility_entries: CompatibilityEntriesTable;
  controllers: ControllersTable;
  identity_providers: IdentityProvidersTable;
  user_groups: UserGroupsTable;
  users: UsersTable;
  client_devices: ClientDevicesTable;
  schedules: SchedulesTable;
  policies: PoliciesTable;
  voucher_batches: VoucherBatchesTable;
  vouchers: VouchersTable;
  policy_assignments: PolicyAssignmentsTable;
  policy_translations: PolicyTranslationsTable;
  portal_themes: PortalThemesTable;
  captive_portals: CaptivePortalsTable;
  portal_login_attempts: PortalLoginAttemptsTable;
  portal_assets: PortalAssetsTable;
  portal_terms_versions: PortalTermsVersionsTable;
  sessions: SessionsTable;
  accounting_records: AccountingRecordsTable;
  auth_events: AuthEventsTable;
  session_actions: SessionActionsTable;
  usage_counters: UsageCountersTable;
  audit_logs: AuditLogsTable;
  outbox: OutboxTable;
  webhooks: WebhooksTable;
  webhook_deliveries: WebhookDeliveriesTable;
  'radius.radacct_raw': RadacctRawTable;
  'radius.radpostauth_raw': RadpostauthRawTable;
  'radius.nas': RadiusNasTable;
  schema_migrations: SchemaMigrationsTable;
}

export type Organization = Selectable<OrganizationsTable>;
export type NewOrganization = Insertable<OrganizationsTable>;
export type OrganizationUpdate = Updateable<OrganizationsTable>;
export type Site = Selectable<SitesTable>;
export type NewSite = Insertable<SitesTable>;
export type Administrator = Selectable<AdministratorsTable>;
export type NewAdministrator = Insertable<AdministratorsTable>;
export type AdminSession = Selectable<AdminSessionsTable>;
export type Role = Selectable<RolesTable>;
export type RoleBinding = Selectable<RoleBindingsTable>;
export type ApiKey = Selectable<ApiKeysTable>;
export type NasClient = Selectable<NasClientsTable>;
export type NewNasClient = Insertable<NasClientsTable>;
export type NetworkDevice = Selectable<NetworkDevicesTable>;
export type Vendor = Selectable<VendorsTable>;
export type CompatibilityEntry = Selectable<CompatibilityEntriesTable>;
export type Controller = Selectable<ControllersTable>;
export type User = Selectable<UsersTable>;
export type NewUser = Insertable<UsersTable>;
export type ClientDevice = Selectable<ClientDevicesTable>;
export type Policy = Selectable<PoliciesTable>;
export type NewPolicy = Insertable<PoliciesTable>;
export type PolicyAssignment = Selectable<PolicyAssignmentsTable>;
export type Voucher = Selectable<VouchersTable>;
export type VoucherBatch = Selectable<VoucherBatchesTable>;
export type CaptivePortal = Selectable<CaptivePortalsTable>;
export type Session = Selectable<SessionsTable>;
export type AccountingRecord = Selectable<AccountingRecordsTable>;
export type NewAccountingRecord = Insertable<AccountingRecordsTable>;
export type AuditLog = Selectable<AuditLogsTable>;
export type NewAuditLog = Insertable<AuditLogsTable>;
export type OutboxEvent = Selectable<OutboxTable>;
export type NewOutboxEvent = Insertable<OutboxTable>;
export type UsageCounter = Selectable<UsageCountersTable>;
