/**
 * Phase 10 (P10-B): worker `/metrics` and scheduler re-registration after a Redis reconnect,
 * against a real Redis (`ECLOUD_TEST_REDIS_URL`), using a DEDICATED logical database (index 14)
 * so no other suite's queues are touched. The database handle points at an unreachable port on
 * purpose: scheduled jobs fail harmlessly and never mutate the shared `ecloud_test` data.
 * Skips cleanly when `ECLOUD_TEST_REDIS_URL` is unset.
 */
import { createDb } from '@ecloud/db';
import { createLogger } from '@ecloud/shared';
import { getTestRedisUrl } from '@ecloud/testing';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startWorker, type RunningWorker } from './app.js';
import { loadWorkerConfig } from './config.js';
import { QUEUES, QUEUE_PREFIX, SCHEDULES } from './queues.js';

const REDIS_DB = 14;
const base = getTestRedisUrl();
const suite = base === undefined ? describe.skip : describe;
const title =
  base === undefined
    ? 'worker metrics + scheduler recovery [skipped: ECLOUD_TEST_REDIS_URL unset]'
    : 'worker metrics + scheduler recovery (real Redis, logical db 14)';

function redisUrl(): string {
  const url = new URL(base ?? 'redis://127.0.0.1:6379');
  url.pathname = `/${String(REDIS_DB)}`;
  return url.toString();
}

async function waitFor(fn: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn().catch(() => false)) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

suite(title, () => {
  let admin: Redis;
  let worker: RunningWorker | undefined;
  const deadDb = createDb('postgres://nobody:nothing@127.0.0.1:1/none', { max: 1 });

  beforeAll(async () => {
    admin = new Redis(redisUrl(), { maxRetriesPerRequest: 1 });
    await admin.flushdb();
    const env = {
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      REDIS_URL: redisUrl(),
      DATABASE_URL: 'postgres://nobody:nothing@127.0.0.1:1/none',
      DATABASE_URL_PLATFORM: 'postgres://nobody:nothing@127.0.0.1:1/none',
    };
    const loaded = loadWorkerConfig(env);
    worker = await startWorker({
      config: { ...loaded, health: { host: '127.0.0.1', port: 0 } },
      logger: createLogger({ name: 'worker-metrics-it', level: 'silent' }),
      db: deadDb,
      schedulerCheckMs: 500,
    });
  }, 30_000);

  afterAll(async () => {
    await worker?.stop();
    await deadDb.destroy().catch(() => undefined);
    if (admin !== undefined) {
      await admin.flushdb().catch(() => undefined);
      admin.disconnect();
    }
  });

  it('serves queue depths, job counters and the scheduler registration counter', async () => {
    const res = await fetch(`http://127.0.0.1:${String(worker?.healthPort)}/metrics`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toMatch(
      /^ecloud_worker_queue_depth\{queue="accounting\.drain",state="waiting"\} /m,
    );
    expect(text).toMatch(/^ecloud_worker_queue_depth\{queue="dead\.coa",state="failed"\} /m);
    expect(text).toMatch(/^ecloud_worker_scheduler_registrations_total 1$/m);
    expect(text).toContain('# TYPE ecloud_worker_jobs_total counter');
  });

  it('restores schedulers lost WITHOUT a reconnect via the periodic check, leaving present ones alone', async () => {
    const q = new Queue(QUEUES.accountingDrain, { connection: admin, prefix: QUEUE_PREFIX });
    try {
      const before = await q.getJobScheduler(`${QUEUES.accountingDrain}.schedule`);
      expect(before).toBeDefined();
      // Only this one scheduler disappears; the connection stays up (no 'ready' event).
      await q.removeJobScheduler(`${QUEUES.accountingDrain}.schedule`);
      const others = await Promise.all(
        SCHEDULES.filter((s) => s.queue !== QUEUES.accountingDrain).map(async (s) => {
          const sq = new Queue(s.queue, { connection: admin, prefix: QUEUE_PREFIX });
          try {
            return [s.queue, (await sq.getJobScheduler(`${s.queue}.schedule`))?.next] as const;
          } finally {
            await sq.close();
          }
        }),
      );
      const restored = await waitFor(
        async () => (await q.getJobScheduler(`${QUEUES.accountingDrain}.schedule`)) !== undefined,
        10_000,
      );
      expect(restored).toBe(true);
      // The untouched schedulers were not re-upserted (their next run did not move).
      for (const [name, next] of others) {
        const sq = new Queue(name, { connection: admin, prefix: QUEUE_PREFIX });
        try {
          expect((await sq.getJobScheduler(`${name}.schedule`))?.next).toBe(next);
        } finally {
          await sq.close();
        }
      }
    } finally {
      await q.close();
    }
  }, 20_000);

  it('re-registers the job schedulers after Redis loses them and the connection drops', async () => {
    const q = new Queue(QUEUES.accountingDrain, { connection: admin, prefix: QUEUE_PREFIX });
    try {
      expect(await q.getJobSchedulersCount()).toBe(1);
      // Simulate a non-persistent Redis restart: data gone + every worker connection dropped.
      const myId = String(await admin.client('ID'));
      await admin.flushdb();
      expect(await q.getJobSchedulersCount()).toBe(0);
      const clients = String(await admin.client('LIST'))
        .split('\n')
        .map((line) => ({ id: /\bid=(\d+)/.exec(line)?.[1], db: /\bdb=(\d+)/.exec(line)?.[1] }))
        .filter((c) => c.id !== undefined && c.db === String(REDIS_DB) && c.id !== myId);
      expect(clients.length).toBeGreaterThan(0);
      for (const c of clients) await admin.client('KILL', 'ID', c.id ?? '').catch(() => 0);

      const restored = await waitFor(async () => {
        const counts = await Promise.all(
          SCHEDULES.map(async (s) => {
            const sq = new Queue(s.queue, { connection: admin, prefix: QUEUE_PREFIX });
            try {
              return await sq.getJobSchedulersCount();
            } finally {
              await sq.close();
            }
          }),
        );
        return counts.every((n) => n === 1);
      }, 15_000);
      expect(restored).toBe(true);
      const text = await worker?.renderMetrics();
      expect(
        Number(/^ecloud_worker_scheduler_registrations_total (\d+)$/m.exec(text ?? '')?.[1]),
      ).toBeGreaterThanOrEqual(2);
    } finally {
      await q.close();
    }
  }, 30_000);
});
