/**
 * Bootstrap of the first Platform Super Admin (DATABASE_DESIGN.md §9 "Not in migrations").
 * Invoked by `ecloud-db create-platform-admin --email ... --password-stdin`; the password is
 * read from stdin, hashed with argon2id (m=19456 KiB, t=2, p=1 per the Phase 3 brief) and
 * never printed or logged. No default credentials exist anywhere in the repository.
 */
import argon2 from 'argon2';
import { newId } from '@ecloud/shared';
import { withMigrationLock, type MigrationExecutor } from './migrate.js';

export const ARGON2_DEFAULTS = Object.freeze({ memoryKib: 19_456, timeCost: 2, parallelism: 1 });
export const MIN_PASSWORD_LENGTH = 12;
export const PLATFORM_SUPER_ADMIN_TEMPLATE = 'platform_super_admin';

export interface Argon2Options {
  memoryKib?: number;
}

export async function hashPassword(password: string, options: Argon2Options = {}): Promise<string> {
  return argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: options.memoryKib ?? ARGON2_DEFAULTS.memoryKib,
    timeCost: ARGON2_DEFAULTS.timeCost,
    parallelism: ARGON2_DEFAULTS.parallelism,
  });
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  return argon2.verify(hash, password);
}

export interface CreatePlatformAdminInput {
  email: string;
  password: string;
  displayName?: string;
  argon2MemoryKib?: number;
}

export interface CreatePlatformAdminResult {
  administratorId: string;
  roleBindingId: string;
  email: string;
}

export function normalizeEmail(email: string, command = 'create-platform-admin'): string {
  const normalized = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    throw new Error(`${command}: --email is not a valid email address`);
  }
  return normalized;
}

export function validatePassword(password: string, command = 'create-platform-admin'): void {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(
      `${command}: password must be at least ${String(MIN_PASSWORD_LENGTH)} characters`,
    );
  }
}

/**
 * Creates an active administrator and binds it to the `platform_super_admin` template with
 * `scope_type = 'platform'`. Requires `seed` to have run. Fails if the email already exists
 * (use the API to reset a password; this command never overwrites an account).
 */
export async function createPlatformAdmin(
  exec: MigrationExecutor,
  input: CreatePlatformAdminInput,
): Promise<CreatePlatformAdminResult> {
  const email = normalizeEmail(input.email);
  validatePassword(input.password);
  const passwordHash = await hashPassword(input.password, { memoryKib: input.argon2MemoryKib });

  return withMigrationLock(exec, async () => {
    await exec.query('BEGIN');
    try {
      const role = (
        await exec.query<{ id: string }>(
          'SELECT id FROM roles WHERE key = $1 AND organization_id IS NULL AND is_template',
          [PLATFORM_SUPER_ADMIN_TEMPLATE],
        )
      ).rows[0];
      if (role === undefined) {
        throw new Error(
          `role template ${PLATFORM_SUPER_ADMIN_TEMPLATE} not found: run \`ecloud-db seed\` first`,
        );
      }
      const existing = await exec.query(
        'SELECT 1 FROM administrators WHERE lower(email) = $1 AND deleted_at IS NULL',
        [email],
      );
      if (existing.rows.length > 0) {
        throw new Error(`an administrator with email ${email} already exists`);
      }

      const administratorId = newId();
      const roleBindingId = newId();
      await exec.query(
        `INSERT INTO administrators (id, email, display_name, password_hash, status)
         VALUES ($1, $2, $3, $4, 'active')`,
        [administratorId, email, input.displayName ?? email, passwordHash],
      );
      await exec.query(
        `INSERT INTO role_bindings (id, administrator_id, role_id, scope_type, organization_id, site_id, granted_by)
         VALUES ($1, $2, $3, 'platform', NULL, NULL, $2)`,
        [roleBindingId, administratorId, role.id],
      );
      await exec.query(
        `INSERT INTO audit_logs (organization_id, actor_type, actor_id, action, target_type, target_id, after)
         VALUES (NULL, 'system', NULL, 'platform:bootstrap', 'administrator', $1, $2::jsonb)`,
        [
          administratorId,
          JSON.stringify({
            email,
            template: PLATFORM_SUPER_ADMIN_TEMPLATE,
            via: 'ecloud-db create-platform-admin',
          }),
        ],
      );
      await exec.query('COMMIT');
      return { administratorId, roleBindingId, email };
    } catch (error) {
      await exec.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
  });
}

export interface ResetPlatformAdminPasswordInput {
  email: string;
  password: string;
  displayName?: string;
  argon2MemoryKib?: number;
}

export interface ResetPlatformAdminPasswordResult {
  administratorId: string;
  email: string;
  sessionsRevoked: number;
  displayNameSet: boolean;
}

/**
 * Sets a NEW password on an existing administrator and revokes every live session it has
 * (D-059). The recovery path for a lockout, so that one never needs hand-written SQL against a
 * production database — which is how `admin@ezecloud.local` had to be disabled on 2026-10-15.
 *
 * THE PASSWORD IS NEVER RETURNED, LOGGED OR AUDITED. It arrives on stdin, is hashed with
 * argon2id, and the only things this function reports are the email and the administrator id.
 *
 * REVOKING THE SESSIONS IS PART OF THE RESET, not a courtesy. A password reset means the old
 * credential is suspect; leaving its sessions alive would mean whoever prompted the reset keeps
 * their access until the session expires. `admin_sessions` is also where impersonation lives
 * (`impersonating_organization_id`), so revoking an administrator's sessions ends any
 * impersonation it was holding — there is no separate tenant-side session to chase, because
 * `impersonator_id` is a column on `audit_logs`, not on a session.
 *
 * It refuses an unknown or soft-deleted administrator rather than creating one: a typo in
 * `--email` must not silently mint an account, and a deleted administrator should be restored
 * deliberately, not revived by a password reset.
 */
export async function resetPlatformAdminPassword(
  exec: MigrationExecutor,
  input: ResetPlatformAdminPasswordInput,
): Promise<ResetPlatformAdminPasswordResult> {
  const email = normalizeEmail(input.email, 'reset-platform-admin-password');
  validatePassword(input.password, 'reset-platform-admin-password');
  const passwordHash = await hashPassword(input.password, { memoryKib: input.argon2MemoryKib });

  return withMigrationLock(exec, async () => {
    await exec.query('BEGIN');
    try {
      const existing = (
        await exec.query<{ id: string; display_name: string }>(
          `SELECT id, display_name FROM administrators
           WHERE lower(email) = $1 AND deleted_at IS NULL`,
          [email],
        )
      ).rows[0];
      if (existing === undefined) {
        throw new Error(`reset-platform-admin-password: no live administrator with email ${email}`);
      }

      const displayNameSet = input.displayName !== undefined && input.displayName.trim() !== '';
      await exec.query(
        `UPDATE administrators
            SET password_hash = $2,
                display_name = COALESCE($3, display_name),
                updated_at = now()
          WHERE id = $1`,
        [existing.id, passwordHash, displayNameSet ? (input.displayName as string).trim() : null],
      );

      // RETURNING rather than a row count: the executor interface exposes only `rows`, and
      // counting what came back is the honest number to put in the audit entry.
      const revoked = await exec.query<{ id: string }>(
        `UPDATE admin_sessions SET revoked_at = now()
          WHERE administrator_id = $1 AND revoked_at IS NULL
        RETURNING id`,
        [existing.id],
      );
      const sessionsRevoked = revoked.rows.length;

      await exec.query(
        `INSERT INTO audit_logs (organization_id, actor_type, actor_id, action, target_type, target_id, after)
         VALUES (NULL, 'system', NULL, 'platform:password_reset', 'administrator', $1, $2::jsonb)`,
        [
          existing.id,
          // Deliberately no password material of any kind, not even its length.
          JSON.stringify({
            email,
            sessions_revoked: sessionsRevoked,
            display_name_set: displayNameSet,
            via: 'ecloud-db reset-platform-admin-password',
          }),
        ],
      );
      await exec.query('COMMIT');
      return { administratorId: existing.id, email, sessionsRevoked, displayNameSet };
    } catch (error) {
      await exec.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
  });
}

export interface SetPlatformAdminResult {
  administratorId: string;
  email: string;
  displayName: string;
}

/**
 * Sets an administrator's display name, without touching the password. Separate from the reset
 * because renaming someone should not require knowing or changing their credential.
 */
export async function setPlatformAdmin(
  exec: MigrationExecutor,
  input: { email: string; displayName: string },
): Promise<SetPlatformAdminResult> {
  const email = normalizeEmail(input.email, 'set-platform-admin');
  const displayName = input.displayName.trim();
  if (displayName === '') throw new Error('set-platform-admin: --display-name must not be empty');

  return withMigrationLock(exec, async () => {
    await exec.query('BEGIN');
    try {
      const existing = (
        await exec.query<{ id: string; display_name: string }>(
          `SELECT id, display_name FROM administrators
           WHERE lower(email) = $1 AND deleted_at IS NULL`,
          [email],
        )
      ).rows[0];
      if (existing === undefined) {
        throw new Error(`set-platform-admin: no live administrator with email ${email}`);
      }
      await exec.query(
        'UPDATE administrators SET display_name = $2, updated_at = now() WHERE id = $1',
        [existing.id, displayName],
      );
      await exec.query(
        `INSERT INTO audit_logs (organization_id, actor_type, actor_id, action, target_type, target_id, before, after)
         VALUES (NULL, 'system', NULL, 'platform:display_name_set', 'administrator', $1, $2::jsonb, $3::jsonb)`,
        [
          existing.id,
          JSON.stringify({ display_name: existing.display_name }),
          JSON.stringify({ display_name: displayName, via: 'ecloud-db set-platform-admin' }),
        ],
      );
      await exec.query('COMMIT');
      return { administratorId: existing.id, email, displayName };
    } catch (error) {
      await exec.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
  });
}
