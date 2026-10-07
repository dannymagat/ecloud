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

export function normalizeEmail(email: string): string {
  const normalized = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    throw new Error('create-platform-admin: --email is not a valid email address');
  }
  return normalized;
}

export function validatePassword(password: string): void {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(
      `create-platform-admin: password must be at least ${String(MIN_PASSWORD_LENGTH)} characters`,
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
