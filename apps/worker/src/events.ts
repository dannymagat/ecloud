/**
 * Outbox writes (API_ARCHITECTURE.md §5 "Outbox pattern"): always in the same transaction as
 * the domain change. The publisher wraps `payload` into the public envelope
 * `{event, id, occurred_at, organization_id, site_id?, data}`.
 */
import type { DbExecutor } from '@ecloud/db';

export type WorkerEvent =
  | 'session.started'
  | 'session.updated'
  | 'session.stopped'
  | 'session.disconnect_requested'
  | 'session.disconnect_result'
  | 'session.coa_result'
  | 'quota.exceeded'
  | 'accounting.anomaly_detected'
  | 'session.enforcement_pending';

export interface OutboxPayload {
  site_id: string | null;
  data: Record<string, unknown>;
}

export async function emitEvent(
  trx: DbExecutor,
  event: WorkerEvent,
  organizationId: string | null,
  siteId: string | null,
  data: Record<string, unknown>,
): Promise<void> {
  const payload: OutboxPayload = { site_id: siteId, data };
  await trx
    .insertInto('outbox')
    .values({ organization_id: organizationId, event, payload: JSON.stringify(payload) })
    .execute();
}
