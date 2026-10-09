/**
 * Worker composition root: Redis, platform DB, BullMQ queues + workers + job schedulers,
 * /healthz and graceful shutdown. All writes go through `withPlatform(…, 'worker:<job>')`.
 */
import { createDb, type Db } from '@ecloud/db';
import { MetricsRegistry, registerProcessMetrics, redactUrl, type Logger } from '@ecloud/shared';
import { Queue, Worker, type Job, type Processor } from 'bullmq';
import { Redis } from 'ioredis';
import { sql } from 'kysely';
import { drainOnce } from './accounting/drain.js';
import { dispatchSessionAction } from './coa/dispatcher.js';
import { sweepPendingSessionActions } from './coa/sweep.js';
import type { RadclientRunner } from './coa/radclient.js';
import type { WorkerConfig } from './config.js';
import { createHealthServer, listen } from './health.js';
import { createSecretResolver, type SecretResolver } from './infra/secrets.js';
import { RedisWorkerState, type WorkerState } from './infra/state.js';
import { deliverWebhook, publishOutbox, type FetchLike, type WebhookJob } from './jobs/outbox.js';
import { ensurePartitions } from './jobs/partitions.js';
import { enforceRuntimeLimits, resolveClosedEnforcement } from './jobs/enforcement.js';
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
  /** Interval of the missing-scheduler check (default 60 s). */
  schedulerCheckMs?: number;
}

export interface RunningWorker {
  healthPort: number;
  queues: readonly QueueName[];
  /** Prometheus text exposition (also served at GET /metrics on the health listener). */
  renderMetrics(): Promise<string>;
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
    options.db ??
    createDb(config.app.database.platformUrl, {
      applicationName: 'ecloud-worker',
      onIdleError: (error) =>
        logger.warn({ err: error.message }, 'postgres idle connection lost; pool will reconnect'),
    });
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

  const enqueueSessionAction = async (
    action: 'disconnect' | 'coa_update',
    sessionActionId: string,
  ): Promise<void> => {
    const name = action === 'disconnect' ? QUEUES.coaDisconnect : QUEUES.coaChange;
    await queue(name).add(
      name,
      { sessionActionId },
      { ...COA_JOB_OPTIONS, jobId: coaJobId(sessionActionId) },
    );
  };
  const enqueueDisconnect = (sessionActionId: string): Promise<void> =>
    enqueueSessionAction('disconnect', sessionActionId);

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
      const drained = await drainOnce({
        db,
        state,
        logger,
        batchSize: config.drain.batchSize,
        wrapMaxBps: config.drain.wrapMaxBps,
      });
      const quota = await enforceQuotas(
        { db, state, logger, coaEnabled: config.coa.enabled, enqueueDisconnect },
        drained.touchedSessionIds,
      );
      if (drained.read > 0) logger.debug({ drained, quota }, 'accounting.drain tick');
      drainedRows.inc({ kind: 'processed' }, drained.processed);
      drainedRows.inc({ kind: 'duplicates' }, drained.duplicates);
      drainedRows.inc({ kind: 'unresolved' }, drained.unresolved);
      drainedRows.inc({ kind: 'skipped' }, drained.skipped);
      return { ...drained, touchedSessionIds: drained.touchedSessionIds.length, quota };
    }),
    [QUEUES.policyEnforce]: singleFlight(QUEUES.policyEnforce, async () => {
      const quota = await enforceQuotas({
        db,
        state,
        logger,
        coaEnabled: config.coa.enabled,
        enqueueDisconnect,
      });
      // P7-A: schedule end + late concurrency (staged items 7–8), then close resolved rows.
      const runtime = await enforceRuntimeLimits({ db, logger, coaEnabled: config.coa.enabled });
      const applied = await resolveClosedEnforcement(db);
      return { ...quota, runtime, enforcementApplied: applied };
    }),
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
    [QUEUES.outboxPublish]: singleFlight(QUEUES.outboxPublish, async () => {
      const published = await publishOutbox({
        db,
        enqueueWebhook: async (jobId, job) => {
          await queue(QUEUES.webhooksDeliver).add(QUEUES.webhooksDeliver, job, {
            ...WEBHOOK_JOB_OPTIONS,
            jobId,
          });
        },
      });
      // P8-A: admin Disconnect / Reauthorize rows committed by the API → dispatcher queues.
      const sessionActions = await sweepPendingSessionActions({
        db,
        enqueue: enqueueSessionAction,
      });
      return { ...published, sessionActions };
    }),
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

  // Phase 10 metrics: job outcomes/latency, drained rows, queue depths (computed per scrape).
  const metrics = new MetricsRegistry();
  const stopProcessMetrics = registerProcessMetrics(metrics, 'ecloud_worker');
  const jobsTotal = metrics.counter({
    name: 'ecloud_worker_jobs_total',
    help: 'Finished BullMQ jobs by queue and result (completed|failed).',
    labelNames: ['queue', 'result'],
  });
  const jobDuration = metrics.histogram({
    name: 'ecloud_worker_job_duration_seconds',
    help: 'BullMQ job processing time by queue.',
    labelNames: ['queue'],
  });
  const drainedRows = metrics.counter({
    name: 'ecloud_worker_accounting_drained_rows_total',
    help: 'radacct_raw rows handled by accounting.drain by kind.',
    labelNames: ['kind'],
  });
  const schedulerRegistrations = metrics.counter({
    name: 'ecloud_worker_scheduler_registrations_total',
    help: 'Times the repeatable job schedulers were (re-)registered (startup and Redis reconnects).',
  });
  const depthStates = ['waiting', 'active', 'delayed', 'failed', 'prioritized'] as const;
  metrics.gauge({
    name: 'ecloud_worker_queue_depth',
    help: 'BullMQ job counts per queue and state at scrape time (dead-letter queues included).',
    labelNames: ['queue', 'state'],
    collect: async () => {
      const all = [...new Set([...Object.values(QUEUES), ...Object.values(DEAD_LETTER)])];
      const counts = await Promise.all(
        all.map(async (name) => [name, await queue(name).getJobCounts(...depthStates)] as const),
      );
      return counts.flatMap(([name, c]) =>
        depthStates.map((state) => ({ labels: { queue: name, state }, value: c[state] ?? 0 })),
      );
    },
  });

  const workers: Worker[] = [];
  const names = Object.values(QUEUES);
  for (const name of names) {
    const worker = new Worker(name, processors[name], {
      ...connection,
      concurrency: WORKER_CONCURRENCY[name],
    });
    worker.on('completed', (job) => {
      jobsTotal.inc({ queue: name, result: 'completed' });
      if (job.processedOn !== undefined && job.finishedOn !== undefined) {
        jobDuration.observe({ queue: name }, (job.finishedOn - job.processedOn) / 1_000);
      }
    });
    worker.on('failed', (job, err) => {
      if (job === undefined) return;
      jobsTotal.inc({ queue: name, result: 'failed' });
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

  // `all`: (re)define every scheduler (start-up: the definitions may have changed).
  // `missing`: only add schedulers that are gone, so a flapping Redis never re-upserts an existing
  // one (which could keep pushing its next run back).
  const registerSchedulers = async (mode: 'all' | 'missing'): Promise<number> => {
    let registered = 0;
    for (const s of SCHEDULES) {
      const id = `${s.queue}.schedule`;
      if (mode === 'missing' && (await queue(s.queue).getJobScheduler(id)) !== undefined) continue;
      await queue(s.queue).upsertJobScheduler(id, s.schedule, {
        name: s.queue,
        data: {},
        opts: SCHEDULED_JOB_OPTIONS,
      });
      registered += 1;
    }
    if (registered > 0) schedulerRegistrations.inc();
    return registered;
  };
  // P10-B review M3: one attempt at a time (re-entry guard), retried with backoff, so a reconnect
  // that fails mid-upsert does not leave drain/reap unscheduled until the next reconnect.
  let restoring: Promise<void> | undefined;
  let stopped = false;
  const restoreSchedulers = (reason: string): Promise<void> => {
    restoring ??= (async () => {
      for (let attempt = 1; attempt <= 5 && !stopped; attempt += 1) {
        try {
          const n = await registerSchedulers('missing');
          if (n > 0) logger.warn({ reason, registered: n }, 'job schedulers re-registered');
          return;
        } catch (e: unknown) {
          logger.error({ err: e, reason, attempt }, 'job scheduler re-registration failed');
          await new Promise((r) => setTimeout(r, 500 * 2 ** (attempt - 1)).unref());
        }
      }
    })().finally(() => {
      restoring = undefined;
    });
    return restoring;
  };
  let schedulerCheck: NodeJS.Timeout | undefined;
  const onRedisReady = (): void => void restoreSchedulers('redis reconnected');
  if (options.schedulers !== false) {
    await registerSchedulers('all');
    // P10-B failure drill: the pilot Redis has no persistence, so a Redis restart loses the
    // scheduler definitions and nothing would drain/reap until the worker restarted. Every
    // reconnect ('ready' after the initial connect) restores missing ones, and a periodic check
    // covers data loss without a reconnect (e.g. FLUSHDB) and a reconnect whose retries failed.
    redis.on('ready', onRedisReady);
    schedulerCheck = setInterval(
      () => void restoreSchedulers('periodic check'),
      options.schedulerCheckMs ?? 60_000,
    );
    schedulerCheck.unref();
  }

  const health = createHealthServer({
    host: config.health.host,
    port: config.health.port,
    queues: names,
    metrics: () => metrics.render(),
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
      stopped = true;
      if (schedulerCheck !== undefined) clearInterval(schedulerCheck);
      redis.off('ready', onRedisReady);
      await restoring?.catch(() => undefined);
      await Promise.allSettled(workers.map((w) => w.close()));
      await Promise.allSettled([...queues.values()].map((q) => q.close()));
      await new Promise<void>((resolve) => health.close(() => resolve()));
      stopProcessMetrics();
      await redis.quit().catch(() => undefined);
      if (options.db === undefined) await db.destroy();
      logger.info('worker stopped');
    })();
    return stopping;
  };

  return { healthPort, queues: names, renderMetrics: () => metrics.render(), stop };
}
