/** Queue names, retry/DLQ settings and scheduler cadence (API_ARCHITECTURE.md §5). */
import type { JobsOptions } from 'bullmq';

export const QUEUE_PREFIX = 'ecloud';

export const QUEUES = Object.freeze({
  accountingDrain: 'accounting.drain',
  policyEnforce: 'policy.enforce',
  sessionsReap: 'sessions.reap',
  partitionsEnsure: 'partitions.ensure',
  retentionPrune: 'retention.prune',
  outboxPublish: 'outbox.publish',
  webhooksDeliver: 'webhooks.deliver',
  coaDisconnect: 'coa.disconnect',
  coaChange: 'coa.change',
} as const);

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

/** Dead-letter queues: BullMQ queues that only hold exhausted jobs for inspection. */
export const DEAD_LETTER = Object.freeze({
  [QUEUES.coaDisconnect]: 'dead.coa',
  [QUEUES.coaChange]: 'dead.coa',
  [QUEUES.webhooksDeliver]: 'dead.webhooks',
} as Partial<Record<QueueName, string>>);

export type Schedule = { every: number } | { pattern: string; tz?: string };

/** Repeatable jobs: every 5 s drain, 30 s enforce, 60 s reap, 2 s outbox, daily partitions/retention. */
export const SCHEDULES: ReadonlyArray<{ queue: QueueName; schedule: Schedule; lockTtlMs: number }> =
  [
    { queue: QUEUES.accountingDrain, schedule: { every: 5_000 }, lockTtlMs: 120_000 },
    { queue: QUEUES.policyEnforce, schedule: { every: 30_000 }, lockTtlMs: 120_000 },
    { queue: QUEUES.sessionsReap, schedule: { every: 60_000 }, lockTtlMs: 120_000 },
    { queue: QUEUES.outboxPublish, schedule: { every: 2_000 }, lockTtlMs: 60_000 },
    {
      queue: QUEUES.partitionsEnsure,
      schedule: { pattern: '10 0 * * *', tz: 'UTC' },
      lockTtlMs: 600_000,
    },
    {
      queue: QUEUES.retentionPrune,
      schedule: { pattern: '30 3 * * *', tz: 'UTC' },
      lockTtlMs: 1_800_000,
    },
  ];

const KEEP = { removeOnComplete: { count: 100 }, removeOnFail: { count: 1000 } } as const;

export const SCHEDULED_JOB_OPTIONS: JobsOptions = { ...KEEP, attempts: 1 };

/** coa.dispatch: 3 attempts, fixed 5 s; final timeout recorded on session_actions + DLQ. */
export const COA_JOB_OPTIONS: JobsOptions = {
  ...KEEP,
  attempts: 3,
  backoff: { type: 'fixed', delay: 5_000 },
};

/** webhooks.deliver: 8 attempts, exponential from 10 s. */
export const WEBHOOK_JOB_OPTIONS: JobsOptions = {
  ...KEEP,
  attempts: 8,
  backoff: { type: 'exponential', delay: 10_000 },
};

export const WORKER_CONCURRENCY: Readonly<Record<QueueName, number>> = {
  [QUEUES.accountingDrain]: 1,
  [QUEUES.policyEnforce]: 1,
  [QUEUES.sessionsReap]: 1,
  [QUEUES.partitionsEnsure]: 1,
  [QUEUES.retentionPrune]: 1,
  [QUEUES.outboxPublish]: 1,
  [QUEUES.webhooksDeliver]: 8,
  [QUEUES.coaDisconnect]: 2,
  [QUEUES.coaChange]: 2,
};

export function coaJobId(sessionActionId: string): string {
  return `coa-${sessionActionId}`;
}
