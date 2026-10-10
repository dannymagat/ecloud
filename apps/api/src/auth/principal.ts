/**
 * Principal resolution: admin session cookie or API key → administrator / key + effective
 * grants. Authentication runs before any tenant is known, so it reads `admin_sessions`,
 * `role_bindings` and `api_keys` through `withPlatform(dbPlatform, {reason:'authn', audit:false})`
 * (packages/db README: bindings are tenant-scoped and invisible to `ecloud_app`).
 */
import { withPlatform, type DbExecutor } from '@ecloud/db';
import { isUuid, type PermissionScope } from '@ecloud/shared';
import { BlockList, isIP } from 'node:net';
import type { AppDeps, Grant, Principal } from '../context.js';
import { safeEqual, sha256Hex } from '../crypto.js';

export const AUTHN_ACCESS = Object.freeze({ reason: 'authn', audit: false });

const LAST_SEEN_RESOLUTION_MS = 60_000;

interface GrantRow {
  binding_id: string;
  role_id: string;
  scope_type: PermissionScope;
  organization_id: string | null;
  site_id: string | null;
  permission_key: string;
}

function foldGrants(rows: readonly GrantRow[]): Grant[] {
  const byBinding = new Map<string, Grant & { permissions: Set<string> }>();
  for (const row of rows) {
    let grant = byBinding.get(row.binding_id);
    if (grant === undefined) {
      grant = {
        bindingId: row.binding_id,
        roleId: row.role_id,
        scopeType: row.scope_type,
        organizationId: row.organization_id,
        siteId: row.site_id,
        permissions: new Set<string>(),
      };
      byBinding.set(row.binding_id, grant);
    }
    grant.permissions.add(row.permission_key);
  }
  return [...byBinding.values()];
}

/** Bindings of an administrator, skipping expired ones and bindings into inactive tenants. */
export async function loadAdminGrants(
  trx: DbExecutor,
  administratorId: string,
  now: Date,
): Promise<Grant[]> {
  const rows = await trx
    .selectFrom('role_bindings as rb')
    .innerJoin('role_permissions as rp', 'rp.role_id', 'rb.role_id')
    .leftJoin('organizations as o', 'o.id', 'rb.organization_id')
    .select([
      'rb.id as binding_id',
      'rb.role_id',
      'rb.scope_type',
      'rb.organization_id',
      'rb.site_id',
      'rp.permission_key',
    ])
    .where('rb.administrator_id', '=', administratorId)
    .where((eb) => eb.or([eb('rb.expires_at', 'is', null), eb('rb.expires_at', '>', now)]))
    .where((eb) =>
      eb.or([
        eb('rb.organization_id', 'is', null),
        eb.and([eb('o.status', '=', 'active'), eb('o.deleted_at', 'is', null)]),
      ]),
    )
    .execute();
  return foldGrants(rows);
}

/** True when the administrator holds any unexpired platform-scope binding. */
export async function hasPlatformBinding(
  trx: DbExecutor,
  administratorId: string,
  now: Date,
): Promise<boolean> {
  const row = await trx
    .selectFrom('role_bindings')
    .select('id')
    .where('administrator_id', '=', administratorId)
    .where('scope_type', '=', 'platform')
    .where((eb) => eb.or([eb('expires_at', 'is', null), eb('expires_at', '>', now)]))
    .executeTakeFirst();
  return row !== undefined;
}

/** Permissions of the platform role template used for impersonation (MULTITENANCY §4.4 step 7). */
export async function loadTemplatePermissions(
  trx: DbExecutor,
  templateKey: string,
): Promise<Set<string>> {
  const rows = await trx
    .selectFrom('roles as r')
    .innerJoin('role_permissions as rp', 'rp.role_id', 'r.id')
    .select(['rp.permission_key', 'r.id'])
    .where('r.key', '=', templateKey)
    .where('r.organization_id', 'is', null)
    .where('r.is_template', '=', true)
    .execute();
  return new Set(rows.map((r) => r.permission_key));
}

export interface SessionLookup {
  principal: Principal;
  tokenHash: string;
}

/** Resolves an admin session token (cookie value). Returns null when invalid/expired/idle. */
export async function resolveSession(
  deps: AppDeps,
  token: string,
  now: Date,
): Promise<SessionLookup | null> {
  if (token.length < 20 || token.length > 128) return null;
  const tokenHash = sha256Hex(token);
  return withPlatform(deps.dbPlatform, AUTHN_ACCESS, async (trx) => {
    const row = await trx
      .selectFrom('admin_sessions as s')
      .innerJoin('administrators as a', 'a.id', 's.administrator_id')
      .select([
        's.id',
        's.administrator_id',
        's.expires_at',
        's.last_seen_at',
        's.created_at',
        's.impersonating_organization_id',
        's.impersonation_reason',
        's.mfa_verified_at',
        'a.email',
        'a.status',
        'a.deleted_at',
        'a.mfa_enforced',
        'a.mfa_reenrol_required',
      ])
      .where('s.token_hash', '=', tokenHash)
      .where('s.revoked_at', 'is', null)
      .executeTakeFirst();
    if (row === undefined) return null;
    if (row.status !== 'active' || row.deleted_at !== null) return null;
    if (row.expires_at.getTime() <= now.getTime()) return null;
    const lastSeen = row.last_seen_at ?? row.created_at;
    if (lastSeen.getTime() + deps.config.session.idleSeconds * 1000 <= now.getTime()) return null;
    if (now.getTime() - lastSeen.getTime() > LAST_SEEN_RESOLUTION_MS) {
      await trx
        .updateTable('admin_sessions')
        .set({ last_seen_at: now })
        .where('id', '=', row.id)
        .execute();
    }

    let grants: Grant[];
    let impersonation: Extract<Principal, { kind: 'admin' }>['impersonation'] = null;
    if (row.impersonating_organization_id !== null) {
      const org = await trx
        .selectFrom('organizations')
        .select(['id'])
        .where('id', '=', row.impersonating_organization_id)
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      if (org === undefined) return null;
      const permissions = await loadTemplatePermissions(trx, deps.config.impersonationRoleTemplate);
      grants = [
        {
          bindingId: `impersonation:${row.id}`,
          roleId: `template:${deps.config.impersonationRoleTemplate}`,
          scopeType: 'organization',
          organizationId: row.impersonating_organization_id,
          siteId: null,
          permissions,
        },
      ];
      impersonation = {
        organizationId: row.impersonating_organization_id,
        reason: row.impersonation_reason ?? '',
        expiresAt: row.expires_at,
      };
    } else {
      grants = await loadAdminGrants(trx, row.administrator_id, now);
    }
    // SECURITY_ARCHITECTURE.md §6.2: MFA is mandatory for platform bindings and for accounts
    // with mfa_enforced. Impersonation is only startable from a platform binding, so it always
    // requires it. Without a proved factor the session keeps no permissions at all.
    // D-038: after an MFA reset the administrator must enrol a new factor before any permission.
    // D-046: with ADMIN_MFA_MODE=off nothing is pending (enrolments are ignored, not deleted).
    const mfaRequired =
      deps.config.adminMfaMode === 'required' &&
      (row.mfa_enforced ||
        row.mfa_reenrol_required ||
        impersonation !== null ||
        (await hasPlatformBinding(trx, row.administrator_id, now)));
    const mfaPending = mfaRequired && row.mfa_verified_at === null;
    return {
      tokenHash,
      principal: {
        kind: 'admin',
        administratorId: row.administrator_id,
        email: row.email,
        sessionId: row.id,
        impersonation,
        grants: mfaPending ? [] : grants,
        mfaVerifiedAt: row.mfa_verified_at,
        mfaPending,
      },
    };
  });
}

/** API key format `eck_<id>_<secret>`; `key_prefix` = `eck_<id>` (schema CHECK `^eck_[A-Za-z0-9]{4,32}$`). */
export const API_KEY_RE = /^(eck_[A-Za-z0-9]{12})_([A-Za-z0-9_-]{32,64})$/;

function ipAllowed(ip: string | null, cidrs: readonly string[] | null): boolean {
  if (cidrs === null || cidrs.length === 0) return true;
  if (ip === null) return false;
  const family = isIP(ip);
  if (family === 0) return false;
  const list = new BlockList();
  for (const cidr of cidrs) {
    const [address, bits] = cidr.split('/');
    if (address === undefined) continue;
    const addrFamily = isIP(address) === 6 ? 'ipv6' : 'ipv4';
    list.addSubnet(address, Number(bits ?? (addrFamily === 'ipv6' ? 128 : 32)), addrFamily);
  }
  return list.check(ip, family === 6 ? 'ipv6' : 'ipv4');
}

/** Resolves a Bearer API key. Returns null for any failure (generic 401 upstream). */
export async function resolveApiKey(
  deps: AppDeps,
  presented: string,
  ip: string | null,
  now: Date,
): Promise<Principal | null> {
  const match = API_KEY_RE.exec(presented);
  if (match === null) return null;
  const prefix = match[1] as string;
  return withPlatform(deps.dbPlatform, AUTHN_ACCESS, async (trx) => {
    const key = await trx
      .selectFrom('api_keys as k')
      .leftJoin('organizations as o', 'o.id', 'k.organization_id')
      .select([
        'k.id',
        'k.key_hash',
        'k.role_id',
        'k.scope_type',
        'k.organization_id',
        'k.site_id',
        'k.allowed_cidrs',
        'k.expires_at',
        'k.revoked_at',
        'k.created_by',
        'k.last_used_at',
        'o.status as org_status',
        'o.deleted_at as org_deleted_at',
      ])
      .where('k.key_prefix', '=', prefix)
      .executeTakeFirst();
    if (key === undefined) {
      safeEqual(sha256Hex(presented), sha256Hex(prefix)); // keep timing similar
      return null;
    }
    if (!safeEqual(sha256Hex(presented), key.key_hash)) return null;
    if (key.revoked_at !== null) return null;
    if (key.expires_at !== null && key.expires_at.getTime() <= now.getTime()) return null;
    if (
      key.organization_id !== null &&
      (key.org_status !== 'active' || key.org_deleted_at !== null)
    ) {
      return null;
    }
    if (!ipAllowed(ip, key.allowed_cidrs)) return null;
    const permissions = await trx
      .selectFrom('role_permissions')
      .select('permission_key')
      .where('role_id', '=', key.role_id)
      .execute();
    if (
      key.last_used_at === null ||
      now.getTime() - key.last_used_at.getTime() > LAST_SEEN_RESOLUTION_MS
    ) {
      await trx
        .updateTable('api_keys')
        .set({ last_used_at: now })
        .where('id', '=', key.id)
        .execute();
    }
    return {
      kind: 'api_key',
      apiKeyId: key.id,
      createdBy: key.created_by,
      organizationId: key.organization_id,
      grants: [
        {
          bindingId: `api_key:${key.id}`,
          roleId: key.role_id,
          scopeType: key.scope_type,
          organizationId: key.organization_id,
          siteId: key.site_id,
          permissions: new Set(permissions.map((p) => p.permission_key)),
        },
      ],
    };
  });
}

export function isSessionTokenShape(value: string): boolean {
  return /^[A-Za-z0-9_-]{20,128}$/.test(value) && !isUuid(value);
}
