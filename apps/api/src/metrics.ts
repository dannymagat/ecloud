/**
 * API Prometheus metrics (Phase 10): request rate and latency per listener and route template,
 * AAA authorize decisions and latency. Served on the INTERNAL listener only (`GET /metrics`,
 * never routed through Caddy); labels never carry usernames, MACs, IPs or raw paths.
 */
import {
  MetricsRegistry,
  PROMETHEUS_CONTENT_TYPE,
  registerProcessMetrics,
  type Counter,
  type Histogram,
} from '@ecloud/shared';
import type { Request, RequestHandler, Response } from 'express';

export interface ApiMetrics {
  readonly registry: MetricsRegistry;
  readonly httpRequests: Counter;
  readonly httpDuration: Histogram;
  readonly aaaDecisions: Counter;
  readonly aaaDuration: Histogram;
  /** Stops the event-loop lag sampler. */
  readonly stop: () => void;
}

export type AaaOutcome = 'accept' | 'reject' | 'unavailable';

const REASON_RE = /^[a-z0-9_]{1,48}$/;

export function createApiMetrics(): ApiMetrics {
  const registry = new MetricsRegistry();
  const stop = registerProcessMetrics(registry, 'ecloud_api');
  return {
    registry,
    stop,
    httpRequests: registry.counter({
      name: 'ecloud_api_http_requests_total',
      help: 'HTTP requests by listener, method, route template and status code.',
      labelNames: ['listener', 'method', 'route', 'status'],
    }),
    httpDuration: registry.histogram({
      name: 'ecloud_api_http_request_duration_seconds',
      help: 'HTTP request latency by listener and route template.',
      labelNames: ['listener', 'route'],
    }),
    aaaDecisions: registry.counter({
      name: 'ecloud_aaa_authorize_decisions_total',
      help: 'AAA authorize answers: accept (200), reject (401, by reason code) or unavailable (503, fail-closed).',
      labelNames: ['outcome', 'reason', 'retransmit'],
    }),
    aaaDuration: registry.histogram({
      name: 'ecloud_aaa_authorize_duration_seconds',
      help: 'AAA authorize handler latency by outcome.',
      labelNames: ['outcome'],
    }),
  };
}

/** Records one authorize answer; unknown or free-text reasons collapse to `other`. */
export function recordAaaDecision(
  metrics: ApiMetrics | undefined,
  outcome: AaaOutcome,
  seconds: number,
  reason: string | null,
  retransmit: boolean,
): void {
  if (metrics === undefined) return;
  const code = reason === null ? '' : REASON_RE.test(reason) ? reason : 'other';
  metrics.aaaDecisions.inc({
    outcome,
    reason: outcome === 'reject' ? code : '',
    retransmit: retransmit ? 'true' : 'false',
  });
  metrics.aaaDuration.observe({ outcome }, seconds);
}

/** Route template of a finished request (`unmatched` when no route handled it). */
export function routeTemplate(req: Request): string {
  const route: unknown = (req as unknown as { route?: unknown }).route;
  if (typeof route !== 'object' || route === null) return 'unmatched';
  const path: unknown = (route as { path?: unknown }).path;
  return typeof path === 'string' ? `${req.baseUrl}${path}` : 'unmatched';
}

export function httpMetrics(metrics: ApiMetrics, listener: string): RequestHandler {
  return (req: Request, res: Response, next) => {
    const start = process.hrtime.bigint();
    res.once('finish', () => {
      const route = routeTemplate(req);
      metrics.httpRequests.inc({
        listener,
        method: req.method,
        route,
        status: String(res.statusCode),
      });
      metrics.httpDuration.observe(
        { listener, route },
        Number(process.hrtime.bigint() - start) / 1e9,
      );
    });
    next();
  };
}

export function metricsHandler(metrics: ApiMetrics): RequestHandler {
  return async (_req, res) => {
    const body = await metrics.registry.render();
    res.setHeader('Cache-Control', 'no-store');
    res.type(PROMETHEUS_CONTENT_TYPE).send(body);
  };
}
