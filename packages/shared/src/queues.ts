/**
 * BullMQ queue names and key prefix shared by the worker (which owns the queues) and the API
 * (`GET /api/v1/platform/health` reports their depths). apps/worker/src/queues.ts asserts it
 * stays in sync with this list.
 */
export const WORKER_QUEUE_PREFIX = 'ecloud';

export const WORKER_QUEUE_NAMES = Object.freeze([
  'accounting.drain',
  'policy.enforce',
  'sessions.reap',
  'partitions.ensure',
  'retention.prune',
  'outbox.publish',
  'webhooks.deliver',
  'coa.disconnect',
  'coa.change',
] as const);

/** Dead-letter queues (exhausted jobs kept for inspection). */
export const WORKER_DEAD_LETTER_QUEUES = Object.freeze(['dead.coa', 'dead.webhooks'] as const);
