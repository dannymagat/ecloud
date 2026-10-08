/**
 * Serialisation of `session_enforcement` writers (P7-A review fix 4). The API (policy-change
 * propagation) and the worker (runtime breaches) both maintain "at most one pending row per
 * session" (`uq_session_enforcement_pending`); each takes a transaction-scoped advisory lock per
 * session before reading / superseding / inserting, so concurrent writers queue instead of one
 * failing with 23505. Ids are locked in sorted order to avoid deadlocks.
 */
import { sql } from 'kysely';
import type { DbExecutor } from './client.js';

/** Advisory-lock namespace (first key) of session-enforcement writers. */
export const SESSION_ENFORCEMENT_LOCK_NS = 7_023;

export async function lockSessionEnforcement(
  trx: DbExecutor,
  sessionIds: readonly string[],
): Promise<void> {
  for (const id of [...new Set(sessionIds)].sort()) {
    await sql`SELECT pg_advisory_xact_lock(${SESSION_ENFORCEMENT_LOCK_NS}, hashtext(${id}))`.execute(
      trx,
    );
  }
}

/** Distinct triggers recorded on a pending row (`detail.triggers`, falling back to the column). */
export function triggersOf(trigger: string, detail: unknown): string[] {
  const list =
    typeof detail === 'object' &&
    detail !== null &&
    Array.isArray((detail as { triggers?: unknown }).triggers)
      ? (detail as { triggers: unknown[] }).triggers.filter(
          (t): t is string => typeof t === 'string',
        )
      : [];
  return [...new Set([trigger, ...list])];
}
