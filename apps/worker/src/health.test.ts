import { afterEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { createHealthServer, listen } from './health.js';

let server: Server | undefined;
afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

async function start(checks: Record<string, () => Promise<boolean>>): Promise<number> {
  server = createHealthServer({
    host: '127.0.0.1',
    port: 0,
    checks,
    queues: ['q1'],
    timeoutMs: 200,
  });
  return listen(server, 0, '127.0.0.1');
}

describe('/healthz', () => {
  it('200 when every check passes', async () => {
    const port = await start({ redis: () => Promise.resolve(true) });
    const res = await fetch(`http://127.0.0.1:${String(port)}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok', checks: { redis: 'ok' }, queues: ['q1'] });
  });
  it('503 when a check fails, throws or hangs; 404 elsewhere', async () => {
    const port = await start({
      a: () => Promise.resolve(false),
      b: () => Promise.reject(new Error('x')),
      c: () => new Promise<boolean>(() => undefined),
    });
    const res = await fetch(`http://127.0.0.1:${String(port)}/healthz`);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({
      status: 'degraded',
      checks: { a: 'fail', b: 'fail', c: 'fail' },
    });
    expect((await fetch(`http://127.0.0.1:${String(port)}/other`)).status).toBe(404);
  });
});
