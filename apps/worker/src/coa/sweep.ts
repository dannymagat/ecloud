/**
 * Pending `session_actions` → dispatcher queue (P8-A). The API (which has no BullMQ connection)
 * commits a `pending` row for an admin Disconnect / Reauthorize in the same transaction as its
 * audit row; this sweep — run on the 2 s outbox tick, the same "committed intent → queue"
 * hand-off as the outbox — enqueues it on `coa.disconnect` / `coa.change` with the deterministic
 * job id `coa-<id>`, so re-enqueueing a row that is already queued (or that the quota job
 * enqueued itself) is a no-op. The dispatcher re-reads the row and ignores terminal ones.
 */
import type { Db, SessionActionType } from '@ecloud/db';

/** Rows older than this are left alone (a stuck row is visible in the admin views, not retried). */
export const SWEEP_MAX_AGE_MS = 24 * 3600 * 1000;
export const SWEEP_BATCH = 100;

export interface SweepDeps {
  db: Db;
  enqueue: (action: SessionActionType, sessionActionId: string) => Promise<void>;
  now?: () => Date;
  batch?: number;
}

export async function sweepPendingSessionActions(deps: SweepDeps): Promise<{ enqueued: number }> {
  const now = (deps.now ?? (() => new Date()))();
  const rows = await deps.db
    .selectFrom('session_actions')
    .select(['id', 'action'])
    .where('status', '=', 'pending')
    .where('created_at', '>=', new Date(now.getTime() - SWEEP_MAX_AGE_MS))
    .orderBy('created_at')
    .limit(deps.batch ?? SWEEP_BATCH)
    .execute();
  for (const row of rows) await deps.enqueue(row.action, row.id);
  return { enqueued: rows.length };
}
