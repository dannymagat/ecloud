/**
 * `outbox.publish` (every 2 s) and `webhooks.deliver` (API_ARCHITECTURE.md §5).
 *
 * The publisher claims unpublished rows with FOR UPDATE SKIP LOCKED, fans each event out to
 * the tenant's enabled webhooks subscribed to it (or to `*`) as one delivery job per
 * (event, webhook) with a deterministic job id, and sets `published_at` in the same
 * transaction. Delivery POSTs the envelope with `X-ECLOUD-Signature: t=<unix>,v1=<hex>`
 * (HMAC-SHA-256 over `<t>.<body>`), 5 s timeout, one `webhook_deliveries` row per attempt,
 * auto-disable after 50 consecutive failures.
 */
import { createHmac } from 'node:crypto';
import { withPlatform, type Db, type WebhookDeliveryStatus } from '@ecloud/db';
import { sql } from 'kysely';
import type { OutboxPayload } from '../events.js';
import type { SecretResolver } from '../infra/secrets.js';

export const OUTBOX_REASON = 'worker:outbox.publish';
export const WEBHOOK_REASON = 'worker:webhooks.deliver';
export const OUTBOX_BATCH = 100;
export const WEBHOOK_TIMEOUT_MS = 5_000;
export const WEBHOOK_AUTO_DISABLE_FAILURES = 50;
export const SIGNATURE_HEADER = 'X-ECLOUD-Signature';

export interface EventEnvelope {
  event: string;
  id: string;
  occurred_at: string;
  organization_id: string | null;
  site_id?: string;
  data: Record<string, unknown>;
}

export interface WebhookJob {
  outboxId: number;
  webhookId: string;
  organizationId: string;
  envelope: EventEnvelope;
}

export function buildEnvelope(row: {
  id: number;
  event: string;
  organization_id: string | null;
  payload: unknown;
  created_at: Date;
}): EventEnvelope {
  const payload = (row.payload ?? {}) as Partial<OutboxPayload> & Record<string, unknown>;
  const data =
    payload.data !== undefined && typeof payload.data === 'object' && payload.data !== null
      ? payload.data
      : payload;
  const envelope: EventEnvelope = {
    event: row.event,
    id: `evt_${String(row.id)}`,
    occurred_at: row.created_at.toISOString(),
    organization_id: row.organization_id,
    data: data,
  };
  if (typeof payload.site_id === 'string') envelope.site_id = payload.site_id;
  return envelope;
}

export function webhookJobId(outboxId: number, webhookId: string): string {
  return `wh-${String(outboxId)}-${webhookId}`;
}

export interface PublishDeps {
  db: Db;
  enqueueWebhook: (jobId: string, job: WebhookJob) => Promise<void>;
  batchSize?: number;
}

export interface PublishResult {
  published: number;
  deliveriesQueued: number;
}

export async function publishOutbox(deps: PublishDeps): Promise<PublishResult> {
  return withPlatform(deps.db, { reason: OUTBOX_REASON, audit: false }, async (trx) => {
    const rows = await trx
      .selectFrom('outbox')
      .select(['id', 'event', 'organization_id', 'payload', 'created_at'])
      .where('published_at', 'is', null)
      .orderBy('id')
      .limit(deps.batchSize ?? OUTBOX_BATCH)
      .forUpdate()
      .skipLocked()
      .execute();
    if (rows.length === 0) return { published: 0, deliveriesQueued: 0 };
    let deliveriesQueued = 0;
    const orgIds = [
      ...new Set(rows.map((r) => r.organization_id).filter((o): o is string => o !== null)),
    ];
    const hooks =
      orgIds.length === 0
        ? []
        : await trx
            .selectFrom('webhooks')
            .select(['id', 'organization_id', 'events'])
            .where('organization_id', 'in', orgIds)
            .where('enabled', '=', true)
            .execute();
    for (const row of rows) {
      if (row.organization_id === null) continue;
      const envelope = buildEnvelope(row);
      for (const hook of hooks) {
        if (hook.organization_id !== row.organization_id) continue;
        if (!hook.events.includes(row.event) && !hook.events.includes('*')) continue;
        await deps.enqueueWebhook(webhookJobId(row.id, hook.id), {
          outboxId: row.id,
          webhookId: hook.id,
          organizationId: row.organization_id,
          envelope,
        });
        deliveriesQueued += 1;
      }
    }
    await trx
      .updateTable('outbox')
      .set({ published_at: sql<Date>`now()` })
      .where(
        'id',
        'in',
        rows.map((r) => r.id),
      )
      .execute();
    return { published: rows.length, deliveriesQueued };
  });
}

export function signPayload(secret: string, timestamp: number, body: string): string {
  const v1 = createHmac('sha256', secret)
    .update(`${String(timestamp)}.${body}`)
    .digest('hex');
  return `t=${String(timestamp)},v1=${v1}`;
}

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<{ status: number }>;

export interface DeliverDeps {
  db: Db;
  resolveSecret: SecretResolver;
  fetch?: FetchLike;
  now?: () => Date;
}

export class WebhookDeliveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebhookDeliveryError';
  }
}

export type DeliveryOutcome =
  { status: 'success'; httpStatus: number } | { status: 'skipped'; reason: string };

/**
 * One delivery attempt. Throws `WebhookDeliveryError` on failure so the queue retries
 * (attempts 8, exponential 10 s); the attempt is recorded either way.
 */
export async function deliverWebhook(
  deps: DeliverDeps,
  job: WebhookJob,
  attempt: number,
): Promise<DeliveryOutcome> {
  const hook = await deps.db
    .selectFrom('webhooks')
    .select(['id', 'organization_id', 'url', 'enabled', 'signing_secret_ref', 'failure_count'])
    .where('id', '=', job.webhookId)
    .executeTakeFirst();
  if (hook === undefined) return { status: 'skipped', reason: 'webhook deleted' };
  if (!hook.enabled) return { status: 'skipped', reason: 'webhook disabled' };

  const body = JSON.stringify(job.envelope);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'user-agent': 'ecloud-webhooks/1',
    'x-ecloud-event': job.envelope.event,
    'x-ecloud-delivery': `${job.envelope.id}.${hook.id}`,
  };
  let error: string | null = null;
  if (hook.signing_secret_ref !== null) {
    const secret = await deps.resolveSecret(hook.signing_secret_ref);
    if (secret === undefined) error = 'signing secret reference could not be resolved';
    else {
      const ts = Math.floor((deps.now ?? (() => new Date()))().getTime() / 1000);
      headers[SIGNATURE_HEADER] = signPayload(secret, ts, body);
    }
  }

  let status: WebhookDeliveryStatus = 'failed';
  let httpStatus: number | null = null;
  if (error === null) {
    try {
      const response = await (deps.fetch ?? globalThis.fetch)(hook.url, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
      });
      httpStatus = response.status;
      if (response.status >= 200 && response.status < 300) status = 'success';
      else error = `HTTP ${String(response.status)}`;
    } catch (e) {
      const name = (e as { name?: string }).name;
      status = name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'failed';
      error = status === 'timeout' ? 'timeout' : (e as Error).message;
    }
  }

  await withPlatform(
    deps.db,
    { reason: WEBHOOK_REASON, audit: false, organizationId: hook.organization_id },
    async (trx) => {
      await trx
        .insertInto('webhook_deliveries')
        .values({
          organization_id: hook.organization_id,
          webhook_id: hook.id,
          event: job.envelope.event,
          payload: JSON.stringify(job.envelope),
          status,
          http_status: httpStatus,
          attempt,
          error,
        })
        .execute();
      if (status === 'success') {
        await trx
          .updateTable('webhooks')
          .set({ failure_count: 0 })
          .where('id', '=', hook.id)
          .execute();
      } else {
        await trx
          .updateTable('webhooks')
          .set({
            failure_count: sql<number>`failure_count + 1`,
            enabled: sql<boolean>`CASE WHEN failure_count + 1 >= ${WEBHOOK_AUTO_DISABLE_FAILURES} THEN false ELSE enabled END`,
          })
          .where('id', '=', hook.id)
          .execute();
      }
    },
  );
  if (status !== 'success') throw new WebhookDeliveryError(error ?? 'delivery failed');
  return { status: 'success', httpStatus: httpStatus ?? 0 };
}
