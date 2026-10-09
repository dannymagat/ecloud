/**
 * Portal Prometheus metrics (Phase 10). The portal's own listener is public (behind Caddy), so
 * `/metrics` is served on a SEPARATE listener (`PORTAL_METRICS_PORT`, bound to
 * `PORTAL_METRICS_HOST`, default 127.0.0.1) and never on the public app. Labels carry route
 * templates and closed outcome enums only — never tokens, usernames, MACs or IPs.
 */
import {
  MetricsRegistry,
  PROMETHEUS_CONTENT_TYPE,
  registerProcessMetrics,
  type Counter,
  type Histogram,
} from '@ecloud/shared';
import type { Request, RequestHandler, Response } from 'express';
import { createServer, type Server } from 'node:http';

export interface PortalMetrics {
  readonly registry: MetricsRegistry;
  readonly httpRequests: Counter;
  readonly httpDuration: Histogram;
  /** Login/hand-off attempts by method and backend outcome (`ok`, `rejected`, `unavailable`, …). */
  readonly logins: Counter;
  readonly stop: () => void;
}

export function createPortalMetrics(): PortalMetrics {
  const registry = new MetricsRegistry();
  const stop = registerProcessMetrics(registry, 'ecloud_portal');
  return {
    registry,
    stop,
    httpRequests: registry.counter({
      name: 'ecloud_portal_http_requests_total',
      help: 'Portal HTTP requests by method, route template and status code.',
      labelNames: ['method', 'route', 'status'],
    }),
    httpDuration: registry.histogram({
      name: 'ecloud_portal_http_request_duration_seconds',
      help: 'Portal HTTP request latency by route template.',
      labelNames: ['route'],
    }),
    logins: registry.counter({
      name: 'ecloud_portal_logins_total',
      help: 'Portal login attempts by method and outcome.',
      labelNames: ['method', 'result'],
    }),
  };
}

function routeTemplate(req: Request): string {
  const route: unknown = (req as unknown as { route?: unknown }).route;
  if (typeof route !== 'object' || route === null) return 'unmatched';
  const raw: unknown = (route as { path?: unknown }).path;
  const path: unknown = Array.isArray(raw) ? (raw as unknown[])[0] : raw;
  return typeof path === 'string' ? path : 'unmatched';
}

export function portalHttpMetrics(metrics: PortalMetrics): RequestHandler {
  return (req: Request, res: Response, next) => {
    const start = process.hrtime.bigint();
    res.once('finish', () => {
      const route = routeTemplate(req);
      metrics.httpRequests.inc({ method: req.method, route, status: String(res.statusCode) });
      metrics.httpDuration.observe({ route }, Number(process.hrtime.bigint() - start) / 1e9);
    });
    next();
  };
}

/** A minimal listener that only answers `GET /metrics` (everything else 404). */
export function createMetricsServer(metrics: PortalMetrics): Server {
  return createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    if (req.method !== 'GET' || path !== '/metrics') {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found\n');
      return;
    }
    metrics.registry
      .render()
      .then((body) => {
        res.writeHead(200, {
          'content-type': PROMETHEUS_CONTENT_TYPE,
          'cache-control': 'no-store',
        });
        res.end(body);
      })
      .catch(() => {
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end('metrics failed\n');
      });
  });
}
