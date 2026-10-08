/**
 * Worker composition root: Redis, platform DB, BullMQ queues + workers + job schedulers,
 * /healthz and graceful shutdown. All writes go through `withPlatform(…, 'worker:<job>')`.
 */
import { createDb, type Db } from '@ecloud/db';
import { redactUrl, type Logger } from '@ecloud/shared';
import { Queue, Worker, type Job, type Processor } from 'bullmq';
import { Redis } from 'ioredis';
import { sql } from 'kysely';
import { drainOnce } from './accounting/drain.js';
import { dispatchSessionAction } from './coa/dispatcher.js';
import type { RadclientRunner } from './coa/radclient.js';
import type { WorkerConfig } from './config.js';
import { createHealthServer, listen } from './health.js';
import { createSecretResolver, type SecretResolver } from './infra/secrets.js';
import { RedisWorkerState, type WorkerState } from './infra/state.js';
import { deliverWebhook, publishOutbox, type FetchLike, type WebhookJob } from './jobs/outbox.js';
import { ensurePartitions } from './jobs/partitions.js';
import { enforceQuotas } from './jobs/quota.js';
import { expireAuthorizations, reapSessions } from './jobs/reap.js';
import { pruneRetention } from './jobs/retention.js';
import {
  COA_JOB_OPTIONS,
  DEAD_LETTER,
  QUEUES,
  QUEUE_PREFIX,
  SCHEDULED_JOB_OPTIONS,
  SCHEDULES,
  WEBHOOK_JOB_OPTIONS,
  WORKER_CONCURRENCY,
  coaJobId,
  type QueueName,
} from './queues.js';

export interface StartOptions {
  config: WorkerConfig;
  logger: Logger;
  /** Test seams. */
  db?: Db;
  resolveSecret?: SecretResolver;
  radclientRunner?: RadclientRunner;
  fetch?: FetchLike;
  /** Skip registering repeatable schedulers (tests drive processors directly). */
  schedulers?: boolean;
}

export interface RunningWorker {
  healthPort: number;
  queues: readonly QueueName[];
  stop(): Promise<void>;
}

export async function startWorker(options: StartOptions): Promise<RunningWorker> {
  const { config, logger } = options;
  const redis = new Redis(config.app.redis.url, {
    maxRetriesPerRequest: null,
    lazyConnect: true,
  });
  await redis.connect();
  const db =
    options.db ?? createDb(config.app.database.platformUrl, { applicationName: 'ecloud-worker' });
  const state: WorkerState = new RedisWorkerState(redis);
  const resolveSecret = options.resolveSecret ?? createSecretResolver();
  const connection = { connection: redis, prefix: QUEUE_PREFIX };

  const queues = new Map<string, Queue>();
  const queue = (name: string): Queue => {
    let q = queues.get(name);
    if (q === undefined) {
      q = new Queue(name, connection);
      queues.set(name, q);
    }
    return q;
  };

  const enqueueDisconnect = async (sessionActionId: string): Promise<void> => {
    await queue(QUEUES.coaDisconnect).add(
      QUEUES.coaDisconnect,
      { sessionActionId },
      { ...COA_JOB_OPTIONS, jobId: coaJobId(sessionActionId) },
    );
  };

  const lockTtl = (name: QueueName): number =>
    SCHEDULES.find((s) => s.queue === name)?.lockTtlMs ?? 60_000;
  const singleFlight =
    <T>(name: QueueName, fn: () => Promise<T>): Processor =>
    async () => {
      const out = await state.withLock(name, lockTtl(name), fn);
      return out === undefined ? { skipped: 'locked' } : out;
    };

  const processors: Record<QueueName, Processor> = {
    [QUEUES.accountingDrain]: singleFlight(QUEUES.accountingDrain, async () => {
      const drained = await drainOnce({ db, state, logger, batchSize: config.drain.batchSize });
      const quota = await enforceQuotas(
        { db, state, logger, coaEnabled: config.coa.enabled, enqueueDisconnect },
        drained.touchedSessionIds,
      );
      if (drained.read > 0) logger.debug({ drained, quota }, 'accounting.drain tick');
      return { ...drained, touchedSessionIds: drained.touchedSessionIds.length, quota };
    }),
    [QUEUES.policyEnforce]: singleFlight(QUEUES.policyEnforce, () =>
      enforceQuotas({ db, state, logger, coaEnabled: config.coa.enabled, enqueueDisconnect }),
    ),
    [QUEUES.sessionsReap]: singleFlight(QUEUES.sessionsReap, async () => ({
      reaped: await reapSessions({
        db,
        interimIntervalS: config.sessions.interimIntervalS,
        graceS: config.sessions.reapGraceS,
      }),
      expiredAuthorizations: await expireAuthorizations({
        db,
        ttlS: config.sessions.authorizationTtlS,
      }),
    })),
    [QUEUES.partitionsEnsure]: singleFlight(QUEUES.partitionsEnsure, async () => {
      const created = await ensurePartitions(db);
      logger.info({ created }, 'partitions.ensure done');
      return created;
    }),
    [QUEUES.retentionPrune]: singleFlight(QUEUES.retentionPrune, async () => {
      const report = await pruneRetention({ db, state, apply: config.retention.apply });
      logger.info({ report }, report.applied ? 'retention applied' : 'retention dry-run plan');
      return report;
    }),
    [QUEUES.outboxPublish]: singleFlight(QUEUES.outboxPublish, () =>
      publishOutbox({
        db,
        enqueueWebhook: async (jobId, job) => {
          await queue(QUEUES.webhooksDeliver).add(QUEUES.webhooksDeliver, job, {
            ...WEBHOOK_JOB_OPTIONS,
            jobId,
          });
        },
      }),
    ),
    [QUEUES.webhooksDeliver]: (job: Job<WebhookJob>) =>
      deliverWebhook(
        { db, resolveSecret, ...(options.fetch ? { fetch: options.fetch } : {}) },
        job.data,
        job.attemptsMade + 1,
      ),
    [QUEUES.coaDisconnect]: coaProcessor(),
    [QUEUES.coaChange]: coaProcessor(),
  };

  function coaProcessor(): Processor {
    return (job: Job<{ sessionActionId: string }>) =>
      dispatchSessionAction(
        {
          db,
          logger,
          coaEnabled: config.coa.enabled,
          radclientPath: config.coa.radclientPath,
          timeoutS: config.coa.timeoutS,
          retries: config.coa.retries,
          defaultCoaPort: config.app.radius.coaPort,
          resolveSecret,
          ...(options.radclientRunner ? { runner: options.radclientRunner } : {}),
        },
        job.data.sessionActionId,
        { attempt: job.attemptsMade + 1, maxAttempts: job.opts.attempts ?? 1 },
      );
  }

  const workers: Worker[] = [];
  const names = Object.values(QUEUES);
  for (const name of names) {
    const worker = new Worker(name, processors[name], {
      ...connection,
      concurrency: WORKER_CONCURRENCY[name],
    });
    worker.on('failed', (job, err) => {
      if (job === undefined) return;
      const exhausted = job.attemptsMade >= (job.opts.attempts ?? 1);
      logger.warn(
        { queue: name, jobId: job.id, attempt: job.attemptsMade, exhausted, err: err.message },
        'job failed',
      );
      const dead = DEAD_LETTER[name];
      if (exhausted && dead !== undefined) {
        void queue(dead)
          .add(
            name,
            { queue: name, jobId: job.id, data: job.data as unknown, error: err.message },
            {
              removeOnComplete: false,
              removeOnFail: false,
            },
          )
          .catch((e: unknown) =>
            logger.error({ err: e, queue: dead }, 'dead-letter enqueue failed'),
          );
      }
    });
    worker.on('error', (err) => logger.error({ queue: name, err: err.message }, 'worker error'));
    workers.push(worker);
  }

  if (options.schedulers !== false) {
    for (const s of SCHEDULES) {
      await queue(s.queue).upsertJobScheduler(`${s.queue}.schedule`, s.schedule, {
        name: s.queue,
        data: {},
        opts: SCHEDULED_JOB_OPTIONS,
      });
    }
  }

  const health = createHealthServer({
    host: config.health.host,
    port: config.health.port,
    queues: names,
    checks: {
      redis: async () => (await redis.ping()) === 'PONG',
      database: async () => {
        await sql`SELECT 1`.execute(db);
        return true;
      },
    },
  });
  const healthPort = await listen(health, config.health.port, config.health.host);

  logger.info(
    {
      queues: names,
      schedulers: options.schedulers === false ? [] : SCHEDULES.map((s) => s.queue),
      redis: redactUrl(config.app.redis.url),
      health: `http://${config.health.host}:${String(healthPort)}/healthz`,
      coaEnabled: config.coa.enabled,
      retentionApply: config.retention.apply,
    },
    'worker started',
  );

  let stopping: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    stopping ??= (async () => {
      logger.info('worker stopping');
      await Promise.allSettled(workers.map((w) => w.close()));
      await Promise.allSettled([...queues.values()].map((q) => q.close()));
      await new Promise<void>((resolve) => health.close(() => resolve()));
      await redis.quit().catch(() => undefined);
      if (options.db === undefined) await db.destroy();
      logger.info('worker stopped');
    })();
    return stopping;
  };

  return { healthPort, queues: names, stop };
}
