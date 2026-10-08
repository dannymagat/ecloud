/**
 * Audit trail (API_ARCHITECTURE.md §3.1 "Audit", MULTITENANCY.md §4.5, SECURITY §6.7): one
 * `audit_logs` row per mutation, written in the SAME transaction as the change, attributed to
 * the actor and — while impersonating — to the impersonator. Secret material never enters
 * `before`/`after`.
 */
import type { DbExecutor } from '@ecloud/db';
import { isUuid } from '@ecloud/shared';
import type { RequestContext } from './context.js';

const SECRET_KEYS = new Set([
  'password',
  'password_hash',
  'key_hash',
  'token_hash',
  'secret_ref',
  'uam_secret_ref',
  'credential_secret_ref',
  'credential',
  'secret_enc',
  'code_hash',
  'code_enc',
  'recovery_codes_hash',
  'secret',
  'api_key',
  'codes',
]);

/** Deep-copies a row for the audit log with secret-bearing keys removed. */
export function auditSnapshot(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(auditSnapshot);
  if (typeof value === 'bigint') return value.toString();
  if (typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEYS.has(key)) continue;
    out[key] = auditSnapshot(inner);
  }
  return out;
}

export interface AuditEntry {
  organizationId: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  before?: unknown;
  after?: unknown;
}

export async function writeAudit(
  trx: DbExecutor,
  ctx: RequestContext,
  entry: AuditEntry,
): Promise<void> {
  const principal = ctx.principal;
  let actorType: 'administrator' | 'api_key' | 'system' = 'system';
  let actorId: string | null = null;
  let impersonatorId: string | null = null;
  if (principal?.kind === 'admin') {
    actorType = 'administrator';
    actorId = principal.administratorId;
    if (principal.impersonation !== null) impersonatorId = principal.administratorId;
  } else if (principal?.kind === 'api_key') {
    actorType = 'api_key';
    actorId = principal.apiKeyId;
  }
  const before = entry.before === undefined ? null : auditSnapshot(entry.before);
  const after = entry.after === undefined ? null : auditSnapshot(entry.after);
  await trx
    .insertInto('audit_logs')
    .values({
      organization_id: entry.organizationId,
      actor_type: actorType,
      actor_id: actorId,
      impersonator_id: impersonatorId,
      action: entry.action,
      target_type: entry.targetType ?? null,
      target_id: entry.targetId !== undefined && isUuid(entry.targetId) ? entry.targetId : null,
      before: before === null ? null : JSON.stringify(before),
      after: after === null ? null : JSON.stringify(after),
      ip: ctx.ip,
      request_id: ctx.requestId,
      user_agent: ctx.userAgent?.slice(0, 512) ?? null,
    })
    .execute();
  ctx.audited = true;
}
