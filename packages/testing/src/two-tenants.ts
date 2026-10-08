import { randomBytes, randomInt } from 'node:crypto';
import { TENANT_SCOPED_TABLES } from '@ecloud/db';
import { newId } from '@ecloud/shared';
import type { PgQueryable } from './probes.js';

/** One row of a tenant-scoped table identified by a single column. */
export interface TenantRowRef {
  table: string;
  /** Column that identifies the seeded row (`id` for most tables). */
  column: string;
  value: string | number;
}

/**
 * A fully populated tenant: exactly one row in EVERY table of `TENANT_SCOPED_TABLES`
 * (plus the organization, a platform administrator for its role binding and a custom role).
 */
export interface TenantGraph {
  organizationId: string;
  slug: string;
  siteId: string;
  roleId: string;
  administratorId: string;
  userId: string;
  username: string;
  policyId: string;
  voucherBatchId: string;
  voucherId: string;
  voucherCodeHash: string;
  nasClientId: string;
  nasIp: string;
  /** Hotspot controller (migration 019); the NAS references it through `controller_id`. */
  controllerId: string;
  captivePortalId: string;
  sessionId: string;
  acctUniqueId: string;
  webhookId: string;
  /** Seeded row per tenant-scoped table (keys are exactly `TENANT_SCOPED_TABLES`). */
  rows: Readonly<Record<string, TenantRowRef>>;
}

export interface TwoTenants {
  a: TenantGraph;
  b: TenantGraph;
  /** Unique token of this fixture set (part of every slug/name), handy for log output. */
  runId: string;
}

export interface WithTwoTenantsOptions {
  /** Prefix for slugs and names (default `iso`). Lowercase letters, digits and `-` only. */
  label?: string;
  /** Username created in BOTH tenants (T-06). Default: `shared-<runId>`. */
  sharedUsername?: string;
}

/** The order in which `seedTenantGraph` fills tenant tables (dependencies first). */
export const TENANT_GRAPH_TABLES: readonly string[] = Object.freeze([
  'sites',
  'roles',
  'role_permissions',
  'role_bindings',
  'api_keys',
  'invitations',
  'network_devices',
  'wireguard_peers',
  'controllers',
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
]);

/**
 * Tenant-scoped tables the graph does not seed. A new entry in `TENANT_SCOPED_TABLES` shows up
 * here until a row builder is added, and the isolation suite fails on it (coverage guard).
 */
export function tenantTablesMissingFromGraph(
  tables: readonly string[] = TENANT_SCOPED_TABLES,
): string[] {
  return tables.filter((t) => !TENANT_GRAPH_TABLES.includes(t));
}

function hex(bytes: number): string {
  return randomBytes(bytes).toString('hex');
}

function alnum(length: number): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  let out = '';
  for (let i = 0; i < length; i += 1) out += alphabet[randomInt(alphabet.length)];
  return out;
}

/** Random address inside a private /8 so fixtures never touch real hosts. */
function randomIp(firstOctet: number): string {
  return `${String(firstOctet)}.${String(randomInt(256))}.${String(randomInt(256))}.${String(1 + randomInt(254))}`;
}

function randomMac(): string {
  // locally administered unicast (02:...)
  const bytes = randomBytes(5);
  return ['02', ...[...bytes].map((b) => b.toString(16).padStart(2, '0'))].join(':');
}

async function insertReturning<T extends string | number>(
  db: PgQueryable,
  text: string,
  values: unknown[],
  column = 'id',
): Promise<T> {
  const result = await db.query(text, values);
  const row = result.rows[0] as Record<string, unknown> | undefined;
  const value = row?.[column];
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new Error(`seed insert returned no ${column}: ${text.slice(0, 60)}`);
  }
  return value as T;
}

/**
 * Inserts one organization with one row in every tenant-scoped table. MUST run on the platform
 * (BYPASSRLS) connection. Every unique value is random, so graphs never collide with each
 * other or with rows left by earlier runs on the shared test database.
 */
export async function seedTenantGraph(
  db: PgQueryable,
  options: { label?: string; username?: string } = {},
): Promise<TenantGraph> {
  const label = options.label ?? 'iso';
  const token = hex(4);
  const slug = `${label}-${token}`;
  const rows: Record<string, TenantRowRef> = {};
  const ref = (table: string, value: string | number, column = 'id'): void => {
    rows[table] = { table, column, value };
  };

  const organizationId = newId();
  await db.query('INSERT INTO organizations (id, slug, name) VALUES ($1, $2, $3)', [
    organizationId,
    slug,
    `Isolation ${slug}`,
  ]);

  const siteId = newId();
  await db.query(
    'INSERT INTO sites (id, organization_id, slug, name, timezone) VALUES ($1, $2, $3, $4, $5)',
    [siteId, organizationId, `site-${token}`, `Site ${slug}`, 'UTC'],
  );
  ref('sites', siteId);

  const roleId = newId();
  await db.query(
    'INSERT INTO roles (id, organization_id, key, name, is_template) VALUES ($1, $2, $3, $4, false)',
    [roleId, organizationId, `custom_${token}`, `Custom role ${slug}`],
  );
  ref('roles', roleId);

  const permission = await db.query('SELECT key FROM permissions ORDER BY key LIMIT 1');
  const permissionKey = (permission.rows[0] as { key?: string } | undefined)?.key;
  if (permissionKey === undefined) {
    throw new Error('permissions catalogue is empty: run the seed before seedTenantGraph');
  }
  await db.query('INSERT INTO role_permissions (role_id, permission_key) VALUES ($1, $2)', [
    roleId,
    permissionKey,
  ]);
  ref('role_permissions', roleId, 'role_id');

  const administratorId = newId();
  await db.query('INSERT INTO administrators (id, email, display_name) VALUES ($1, $2, $3)', [
    administratorId,
    `admin-${token}@example.test`,
    `Admin ${slug}`,
  ]);

  const roleBindingId = await insertReturning<string>(
    db,
    `INSERT INTO role_bindings (administrator_id, role_id, scope_type, organization_id)
     VALUES ($1, $2, 'organization', $3) RETURNING id`,
    [administratorId, roleId, organizationId],
  );
  ref('role_bindings', roleBindingId);

  const apiKeyId = await insertReturning<string>(
    db,
    `INSERT INTO api_keys (organization_id, name, key_prefix, key_hash, role_id, scope_type)
     VALUES ($1, $2, $3, $4, $5, 'organization') RETURNING id`,
    [organizationId, `key ${slug}`, `eck_${alnum(12)}`, hex(32), roleId],
  );
  ref('api_keys', apiKeyId);

  const invitationId = await insertReturning<string>(
    db,
    `INSERT INTO invitations (organization_id, email, role_id, scope_type, token_hash, expires_at)
     VALUES ($1, $2, $3, 'organization', $4, now() + interval '1 day') RETURNING id`,
    [organizationId, `invite-${token}@example.test`, roleId, hex(32)],
  );
  ref('invitations', invitationId);

  const networkDeviceId = await insertReturning<string>(
    db,
    `INSERT INTO network_devices (organization_id, site_id, serial, mac)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [organizationId, siteId, `SER-${token}-${hex(4)}`, randomMac()],
  );
  ref('network_devices', networkDeviceId);

  const tunnelIp = randomIp(10);
  const wireguardPeerId = await insertReturning<string>(
    db,
    `INSERT INTO wireguard_peers (organization_id, site_id, name, public_key, tunnel_ip, allowed_ips)
     VALUES ($1, $2, $3, $4, $5, ARRAY[$6]::cidr[]) RETURNING id`,
    // public_key is a random 32-byte value in WireGuard's base64 shape, not a real key.
    [
      organizationId,
      siteId,
      `peer ${slug}`,
      randomBytes(32).toString('base64'),
      tunnelIp,
      `${tunnelIp}/32`,
    ],
  );
  ref('wireguard_peers', wireguardPeerId);

  // Needs the registry mirror (`seedRegistry`) for the vendor FK. The credential column holds an
  // envelope-shaped placeholder, never a real sealed secret.
  const controllerId = await insertReturning<string>(
    db,
    `INSERT INTO controllers (organization_id, site_id, vendor_key, name, kind, base_url, credential_secret_ref)
     VALUES ($1, $2, 'ezelink', $3, 'on_premises', $4, $5) RETURNING id`,
    [
      organizationId,
      siteId,
      `controller ${slug}`,
      `https://controller-${token}.example.test`,
      `enc:v1.test.${token}.placeholder`,
    ],
  );
  ref('controllers', controllerId);

  const nasIp = randomIp(172);
  const nasClientId = await insertReturning<string>(
    db,
    `INSERT INTO nas_clients (organization_id, site_id, name, nas_ip, adapter_type_key, adapter_key, secret_ref,
                              deployment_mode, controller_id)
     VALUES ($1, $2, $3, $4, 'coovachilli-uam', 'coovachilli-uam', $5, 'gateway', $6) RETURNING id`,
    [organizationId, siteId, `NAS ${slug}`, nasIp, `secret://test/${slug}`, controllerId],
  );
  ref('nas_clients', nasClientId);

  const identityProviderId = await insertReturning<string>(
    db,
    `INSERT INTO identity_providers (organization_id, type, name) VALUES ($1, 'local', $2) RETURNING id`,
    [organizationId, `local ${slug}`],
  );
  ref('identity_providers', identityProviderId);

  const userGroupId = await insertReturning<string>(
    db,
    'INSERT INTO user_groups (organization_id, name) VALUES ($1, $2) RETURNING id',
    [organizationId, `group ${slug}`],
  );
  ref('user_groups', userGroupId);

  const username = options.username ?? `user-${token}`;
  const userId = await insertReturning<string>(
    db,
    'INSERT INTO users (organization_id, username, user_group_id) VALUES ($1, $2, $3) RETURNING id',
    [organizationId, username, userGroupId],
  );
  ref('users', userId);

  const clientDeviceId = await insertReturning<string>(
    db,
    'INSERT INTO client_devices (organization_id, user_id, mac) VALUES ($1, $2, $3) RETURNING id',
    [organizationId, userId, randomMac()],
  );
  ref('client_devices', clientDeviceId);

  const scheduleId = await insertReturning<string>(
    db,
    `INSERT INTO schedules (organization_id, name, timezone, rules) VALUES ($1, $2, 'UTC', '[]'::jsonb) RETURNING id`,
    [organizationId, `schedule ${slug}`],
  );
  ref('schedules', scheduleId);

  const policyId = await insertReturning<string>(
    db,
    `INSERT INTO policies (organization_id, name, scope_type, download_rate_kbps, upload_rate_kbps, schedule_id)
     VALUES ($1, $2, 'user', 20000, 5000, $3) RETURNING id`,
    [organizationId, `policy ${slug}`, scheduleId],
  );
  ref('policies', policyId);

  const voucherBatchId = await insertReturning<string>(
    db,
    `INSERT INTO voucher_batches (organization_id, site_id, name, policy_id, count)
     VALUES ($1, $2, $3, $4, 1) RETURNING id`,
    [organizationId, siteId, `batch ${slug}`, policyId],
  );
  ref('voucher_batches', voucherBatchId);

  const voucherCodeHash = hex(32);
  const voucherId = await insertReturning<string>(
    db,
    'INSERT INTO vouchers (organization_id, batch_id, code_hash) VALUES ($1, $2, $3) RETURNING id',
    [organizationId, voucherBatchId, voucherCodeHash],
  );
  ref('vouchers', voucherId);

  const assignmentId = await insertReturning<string>(
    db,
    `INSERT INTO policy_assignments (organization_id, policy_id, target_type, user_id)
     VALUES ($1, $2, 'user', $3) RETURNING id`,
    [organizationId, policyId, userId],
  );
  ref('policy_assignments', assignmentId);

  const translationId = await insertReturning<number>(
    db,
    `INSERT INTO policy_translations (organization_id, policy_id, policy_version, adapter_type_key, trigger)
     VALUES ($1, $2, 1, 'coovachilli-uam', 'preview') RETURNING id`,
    [organizationId, policyId],
  );
  ref('policy_translations', translationId);

  const themeId = await insertReturning<string>(
    db,
    'INSERT INTO portal_themes (organization_id, name) VALUES ($1, $2) RETURNING id',
    [organizationId, `theme ${slug}`],
  );
  ref('portal_themes', themeId);

  const captivePortalId = await insertReturning<string>(
    db,
    `INSERT INTO captive_portals (organization_id, site_id, name, public_slug, portal_type, network_ref, theme_id)
     VALUES ($1, $2, $3, $4, 'uspot', $5, $6) RETURNING id`,
    [organizationId, siteId, `portal ${slug}`, `p-${slug}`, `ssid-${token}`, themeId],
  );
  ref('captive_portals', captivePortalId);

  const attemptId = await insertReturning<number>(
    db,
    `INSERT INTO portal_login_attempts (organization_id, captive_portal_id, method, result, reason)
     VALUES ($1, $2, 'voucher', 'reject', 'fixture') RETURNING id`,
    [organizationId, captivePortalId],
  );
  ref('portal_login_attempts', attemptId);

  const acctUniqueId = `${slug}-${hex(8)}`;
  const sessionId = await insertReturning<string>(
    db,
    `INSERT INTO sessions (organization_id, site_id, nas_client_id, user_id, policy_id,
                           acct_session_id, acct_unique_id, started_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now()) RETURNING id`,
    [organizationId, siteId, nasClientId, userId, policyId, `as-${token}`, acctUniqueId],
  );
  ref('sessions', sessionId);

  const accountingId = await insertReturning<number>(
    db,
    `INSERT INTO accounting_records (organization_id, session_id, acct_unique_id, acct_session_id, status_type, nas_ip)
     VALUES ($1, $2, $3, $4, 'start', $5) RETURNING id`,
    [organizationId, sessionId, acctUniqueId, `as-${token}`, nasIp],
  );
  ref('accounting_records', accountingId);

  const authEventId = await insertReturning<number>(
    db,
    `INSERT INTO auth_events (organization_id, nas_client_id, username, nas_ip, result)
     VALUES ($1, $2, $3, $4, 'accept') RETURNING id`,
    [organizationId, nasClientId, username, nasIp],
  );
  ref('auth_events', authEventId);

  const actionId = await insertReturning<string>(
    db,
    `INSERT INTO session_actions (organization_id, session_id, action) VALUES ($1, $2, 'disconnect') RETURNING id`,
    [organizationId, sessionId],
  );
  ref('session_actions', actionId);

  await db.query(
    `INSERT INTO usage_counters (organization_id, subject_type, subject_id, period_type, period_start)
     VALUES ($1, 'user', $2, 'total', DATE '1970-01-01')`,
    [organizationId, userId],
  );
  ref('usage_counters', userId, 'subject_id');

  const auditId = await insertReturning<number>(
    db,
    `INSERT INTO audit_logs (organization_id, actor_type, action, target_type, target_id)
     VALUES ($1, 'system', 'test:seed', 'organization', $1) RETURNING id`,
    [organizationId],
  );
  ref('audit_logs', auditId);

  const outboxId = await insertReturning<number>(
    db,
    `INSERT INTO outbox (organization_id, event, payload) VALUES ($1, 'test.seeded', '{}'::jsonb) RETURNING id`,
    [organizationId],
  );
  ref('outbox', outboxId);

  const webhookId = await insertReturning<string>(
    db,
    `INSERT INTO webhooks (organization_id, name, url, events)
     VALUES ($1, $2, $3, ARRAY['session.started']) RETURNING id`,
    [organizationId, `hook ${slug}`, `https://hooks.example.test/${slug}`],
  );
  ref('webhooks', webhookId);

  const deliveryId = await insertReturning<number>(
    db,
    `INSERT INTO webhook_deliveries (organization_id, webhook_id, event, status)
     VALUES ($1, $2, 'session.started', 'success') RETURNING id`,
    [organizationId, webhookId],
  );
  ref('webhook_deliveries', deliveryId);

  return {
    organizationId,
    slug,
    siteId,
    roleId,
    administratorId,
    userId,
    username,
    policyId,
    voucherBatchId,
    voucherId,
    voucherCodeHash,
    nasClientId,
    nasIp,
    controllerId,
    captivePortalId,
    sessionId,
    acctUniqueId,
    webhookId,
    rows: Object.freeze(rows),
  };
}

/**
 * Seeds two independent tenants A and B (see {@link seedTenantGraph}) on the platform
 * connection. Both carry a user with the same username (T-06). Rows are left in place: the
 * shared test database is reset by the @ecloud/db schema suite at the start of every
 * `npm run test:integration`, and every value is unique per run.
 */
export async function withTwoTenants(
  platform: PgQueryable,
  options: WithTwoTenantsOptions = {},
): Promise<TwoTenants> {
  const runId = hex(3);
  const label = options.label ?? 'iso';
  const sharedUsername = options.sharedUsername ?? `shared-${runId}`;
  const a = await seedTenantGraph(platform, { label: `${label}-a`, username: sharedUsername });
  const b = await seedTenantGraph(platform, { label: `${label}-b`, username: sharedUsername });
  return { a, b, runId };
}
