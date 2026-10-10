/**
 * Express 5 applications: the public listener (`/api/v1`, health, OpenAPI) and the internal
 * listener (`/internal/*`, X-Internal-Token, never exposed through Caddy).
 */
import { sql } from 'kysely';
import express, { type Express, type RequestHandler } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { newId } from '@ecloud/shared';
import { authenticate, csrfProtection } from './auth/middleware.js';
import type { AppDeps, RequestContext } from './context.js';
import { clientIp } from './http/common.js';
import { notFoundHandler, problemHandler } from './http/errors.js';
import { mountRoute, type AnyRouteSpec } from './http/route.js';
import { createApiMetrics, httpMetrics, metricsHandler } from './metrics.js';
import { authorizeHandler, internalTokenGuard, postAuthHandler } from './internal/aaa.js';
import { portalInternalRouter } from './internal/portal.js';
import { vendorPortalInternalRouter } from './vendor-api/portal.js';
import { OPENAPI_PATH, buildOpenApiDocument } from './openapi.js';
import { internalAssetHandler, portalAdminRoutes } from './portal-admin/routes.js';
import { accessRoutes } from './routes/access.js';
import { administratorRoutes } from './routes/administrators.js';
import { authRoutes } from './routes/auth.js';
import { accessPointPlatformRoutes, accessPointRoutes } from './routes/access-points.js';
import { controllerRoutes } from './routes/controllers.js';
import { merakiPlatformRoutes, merakiRoutes } from './routes/meraki.js';
import { setupGuideRoutes } from './routes/setup-guides.js';
import { enforcementRoutes } from './routes/enforcement.js';
import { importRoutes } from './routes/imports.js';
import { meRoutes } from './routes/me.js';
import { openwifiConfigRoutes } from './routes/openwifi-config.js';
import { platformOpsRoutes } from './routes/platform-ops.js';
import { platformRoutes } from './routes/platform.js';
import { policyRoutes } from './routes/policies.js';
import { registryRoutes } from './routes/registry.js';
import { resourceRoutes } from './routes/resources.js';
import { runtimeRoutes } from './routes/runtime.js';
import { sessionRoutes } from './routes/sessions.js';
import { accountingRoutes } from './routes/accounting.js';
import { usageRoutes } from './routes/usage.js';
import { retentionRoutes } from './routes/retention.js';
import { voucherRoutes } from './routes/vouchers.js';
import { dashboardRoutes } from './routes/dashboard.js';
import { reportRoutes } from './routes/reports.js';

export const API_VERSION = '0.1.0';
export const PUBLIC_BODY_LIMIT = '1mb';
export const INTERNAL_BODY_LIMIT = '64kb';

const REQUEST_ID_RE = /^[A-Za-z0-9._-]{8,128}$/;

export function allRoutes(deps: AppDeps): AnyRouteSpec[] {
  return [
    ...authRoutes(deps),
    ...meRoutes(deps),
    ...platformRoutes(deps),
    ...platformOpsRoutes(deps),
    ...administratorRoutes(deps),
    ...accessRoutes(deps),
    ...policyRoutes(deps),
    ...openwifiConfigRoutes(deps),
    ...importRoutes(deps),
    ...resourceRoutes(deps),
    ...accessPointRoutes(deps),
    ...accessPointPlatformRoutes(deps),
    ...controllerRoutes(deps),
    ...registryRoutes(deps),
    ...voucherRoutes(deps),
    ...runtimeRoutes(deps),
    ...sessionRoutes(deps),
    ...usageRoutes(deps),
    ...accountingRoutes(deps),
    ...retentionRoutes(deps),
    ...enforcementRoutes(deps),
    ...portalAdminRoutes(deps),
    ...dashboardRoutes(deps),
    ...reportRoutes(deps),
    ...merakiRoutes(deps),
    ...merakiPlatformRoutes(deps),
    ...setupGuideRoutes(deps),
  ];
}

function requestContext(): RequestHandler {
  return (req, res, next) => {
    const incoming = req.get('X-Request-Id');
    const requestId = incoming !== undefined && REQUEST_ID_RE.test(incoming) ? incoming : newId();
    res.setHeader('X-Request-Id', requestId);
    const ctx: RequestContext = {
      requestId,
      ip: clientIp(req),
      userAgent: req.get('User-Agent') ?? null,
      principal: null,
      authMethod: null,
      decisions: new Map(),
      audited: false,
    };
    req.ctx = ctx;
    next();
  };
}

function httpLogger(deps: AppDeps, name: string): RequestHandler {
  return pinoHttp({
    logger: deps.logger.child({ listener: name }),
    genReqId: (req) => (req as express.Request).ctx.requestId,
    customProps: (req) => {
      const ctx = (req as express.Request).ctx as RequestContext | undefined;
      const p = ctx?.principal;
      return p
        ? {
            principal: p.kind === 'admin' ? p.administratorId : p.apiKeyId,
            ...(p.kind === 'admin' && p.impersonation
              ? { impersonating: p.impersonation.organizationId }
              : {}),
          }
        : {};
    },
    // Never log bodies (User-Password, credentials) or query strings with tokens.
    serializers: {
      req: (req: { method: string; url: string; id: unknown }) => ({
        id: req.id,
        method: req.method,
        path: req.url.split('?')[0],
      }),
      res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
    },
  });
}

async function readiness(deps: AppDeps): Promise<{ ok: boolean; checks: Record<string, string> }> {
  const checks: Record<string, string> = {};
  const timeout = <T>(p: Promise<T>) =>
    Promise.race([
      p,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 2_000)),
    ]);
  await Promise.all([
    timeout(sql`SELECT 1`.execute(deps.db))
      .then(() => (checks.database = 'ok'))
      .catch(() => (checks.database = 'unavailable')),
    timeout(deps.kv.ping())
      .then(() => (checks.redis = 'ok'))
      .catch(() => (checks.redis = 'unavailable')),
    ...(deps.storage === undefined
      ? []
      : [
          timeout(deps.storage.checkHealth())
            .then(() => (checks.storage = 'ok'))
            .catch(() => (checks.storage = 'unavailable')),
        ]),
  ]);
  return { ok: Object.values(checks).every((v) => v === 'ok'), checks };
}

function health(app: Express, deps: AppDeps): void {
  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok' });
  });
  app.get('/readyz', async (_req, res) => {
    const result = await readiness(deps);
    res.status(result.ok ? 200 : 503).json({ status: result.ok ? 'ok' : 'unavailable', ...result });
  });
}

export interface Apps {
  publicApp: Express;
  /** The deps the apps were built with (including the metrics registry). */
  deps: AppDeps;
  internalApp: Express;
  routes: AnyRouteSpec[];
  openapi: unknown;
}

export function createApp(appDeps: AppDeps): Apps {
  const metrics = appDeps.metrics ?? createApiMetrics();
  const deps: AppDeps = { ...appDeps, metrics };
  const routes = allRoutes(deps);
  const openapi = buildOpenApiDocument(routes, API_VERSION);

  const publicApp = express();
  publicApp.disable('x-powered-by');
  publicApp.set('trust proxy', deps.config.trustProxyHops);
  publicApp.use(requestContext());
  publicApp.use(httpLogger(deps, 'public'));
  publicApp.use(httpMetrics(metrics, 'public'));
  publicApp.use(
    helmet({
      contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
    }),
  );
  health(publicApp, deps);
  publicApp.get(OPENAPI_PATH, (_req, res) => {
    res.json(openapi);
  });
  publicApp.use(
    express.json({ limit: PUBLIC_BODY_LIMIT, type: ['application/json', 'application/*+json'] }),
  );
  publicApp.use(authenticate(deps));
  publicApp.use((req, res, next) => {
    const p = req.ctx.principal;
    if (p?.kind === 'admin' && p.impersonation !== null) {
      res.setHeader('X-ECLOUD-Impersonating', p.impersonation.organizationId);
    }
    next();
  });
  publicApp.use(csrfProtection(deps));
  const router = express.Router();
  for (const route of routes) mountRoute(router, deps, route);
  publicApp.use(router);
  publicApp.use(notFoundHandler());
  publicApp.use(problemHandler(deps.logger));

  const internalApp = express();
  internalApp.disable('x-powered-by');
  internalApp.use(requestContext());
  internalApp.use(httpLogger(deps, 'internal'));
  internalApp.use(httpMetrics(metrics, 'internal'));
  internalApp.get('/healthz', (_req, res) => {
    res.json({ status: 'ok' });
  });
  // Prometheus scrape target: internal listener only (loopback / compose network, never Caddy).
  internalApp.get('/metrics', metricsHandler(metrics));
  internalApp.use('/internal', internalTokenGuard(deps));
  internalApp.use(express.json({ limit: INTERNAL_BODY_LIMIT }));
  internalApp.post('/internal/aaa/authorize', authorizeHandler(deps));
  internalApp.post('/internal/aaa/post-auth', postAuthHandler(deps));
  internalApp.use('/internal/portal', portalInternalRouter(deps));
  // Cycle D: UniFi / Omada (API mode) / Mist redirects (no UAM signature, verified AP MAC only).
  internalApp.use('/internal/vendor-portal', vendorPortalInternalRouter(deps));
  // P6-B: branding bytes for the portal's public /a/{assetId} (the portal proxies this).
  internalApp.get('/internal/portal-assets/:assetId', internalAssetHandler(deps));
  internalApp.use(notFoundHandler());
  internalApp.use(problemHandler(deps.logger));

  return { publicApp, internalApp, routes, openapi, deps };
}
