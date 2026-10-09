/**
 * Tiny `/healthz` endpoint for container/orchestrator probes (no secrets, no details) and the
 * Prometheus `/metrics` scrape target (Phase 10). Bound to 127.0.0.1 by default.
 */
import { PROMETHEUS_CONTENT_TYPE } from '@ecloud/shared';
import { createServer, type Server } from 'node:http';

export type HealthCheck = () => Promise<boolean>;

export interface HealthServerOptions {
  host: string;
  port: number;
  checks: Record<string, HealthCheck>;
  queues: readonly string[];
  timeoutMs?: number;
  /** Prometheus text exposition for `GET /metrics` (404 when absent). */
  metrics?: () => Promise<string>;
}

async function runCheck(check: HealthCheck, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      check().catch(() => false),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function createHealthServer(options: HealthServerOptions): Server {
  const timeoutMs = options.timeoutMs ?? 2_000;
  return createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    const metrics = options.metrics;
    if (req.method === 'GET' && path === '/metrics' && metrics !== undefined) {
      metrics()
        .then((body) => {
          res.writeHead(200, {
            'content-type': PROMETHEUS_CONTENT_TYPE,
            'cache-control': 'no-store',
          });
          res.end(body);
        })
        .catch(() => {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end('{"status":"metrics_failed"}');
        });
      return;
    }
    if (req.method !== 'GET' || path !== '/healthz') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"status":"not_found"}');
      return;
    }
    void (async () => {
      const entries = await Promise.all(
        Object.entries(options.checks).map(
          async ([name, check]) => [name, await runCheck(check, timeoutMs)] as const,
        ),
      );
      const checks = Object.fromEntries(entries.map(([n, ok]) => [n, ok ? 'ok' : 'fail']));
      const ok = entries.every(([, v]) => v);
      res.writeHead(ok ? 200 : 503, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
      });
      res.end(JSON.stringify({ status: ok ? 'ok' : 'degraded', checks, queues: options.queues }));
    })();
  });
}

export function listen(server: Server, port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      const address = server.address();
      resolve(typeof address === 'object' && address !== null ? address.port : port);
    });
  });
}
