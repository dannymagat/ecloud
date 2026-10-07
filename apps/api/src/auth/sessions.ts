/**
 * Opaque admin sessions (SECURITY_ARCHITECTURE.md §6.3): 32 random bytes in the cookie, SHA-256
 * in `admin_sessions.token_hash`, absolute TTL in `expires_at`, idle timeout from `last_seen_at`.
 */
import type { DbExecutor } from '@ecloud/db';
import { newId } from '@ecloud/shared';
import { randomToken, sha256Hex } from '../crypto.js';

export interface NewSession {
  id: string;
  token: string;
  expiresAt: Date;
}

export async function createAdminSession(
  trx: DbExecutor,
  input: {
    administratorId: string;
    ttlSeconds: number;
    now: Date;
    ip: string | null;
    userAgent: string | null;
    impersonatingOrganizationId?: string;
    impersonationReason?: string;
  },
): Promise<NewSession> {
  const token = randomToken(32);
  const id = newId();
  const expiresAt = new Date(input.now.getTime() + input.ttlSeconds * 1000);
  await trx
    .insertInto('admin_sessions')
    .values({
      id,
      administrator_id: input.administratorId,
      token_hash: sha256Hex(token),
      ip: input.ip,
      user_agent: input.userAgent?.slice(0, 512) ?? null,
      impersonating_organization_id: input.impersonatingOrganizationId ?? null,
      impersonation_reason: input.impersonationReason ?? null,
      expires_at: expiresAt,
      last_seen_at: input.now,
    })
    .execute();
  return { id, token, expiresAt };
}

export async function revokeSessionByToken(
  trx: DbExecutor,
  token: string,
  now: Date,
): Promise<void> {
  await trx
    .updateTable('admin_sessions')
    .set({ revoked_at: now })
    .where('token_hash', '=', sha256Hex(token))
    .where('revoked_at', 'is', null)
    .execute();
}
