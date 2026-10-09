import { createDb } from '@ecloud/db';
import { createLogger, redactConfig, type Logger } from '@ecloud/shared';
import { createStorage } from '@ecloud/storage';
import type { Server } from 'node:http';
import { createApp } from './app.js';
import { loadApiConfig, type ApiConfig } from './config.js';
import type { AppDeps } from './context.js';
import { MemoryKv, RedisKv, type KvStore } from './kv.js';
import { createApiMetrics } from './metrics.js';

export const PACKAGE_NAME = '@ecloud/api';

export { createApp, allRoutes, API_VERSION } from './app.js';
export { loadApiConfig, type ApiConfig } from './config.js';
export type { AppDeps, Principal, Grant, RequestContext } from './context.js';
export { MemoryKv, RedisKv, type KvStore } from './kv.js';
export { buildOpenApiDocument, OPENAPI_PATH } from './openapi.js';
export { createApiMetrics, type ApiMetrics } from './metrics.js';
export { UAM_SECRET_PURPOSE, sealUamSecret } from './internal/portal.js';

export interface MainOptions {
  config?: ApiConfig;
  logger?: Logger;
  /** Install SIGTERM/SIGINT handlers (default true). */
  handleSignals?: boolean;
}

export interface RunningApi {
  publicServer: Server;
  internalServer: Server;
  deps: AppDeps;
  /** Stops accepting connections, drains in-flight requests, closes pools. */
  shutdown: () => Promise<void>;
}

function listen(
  app: ReturnType<typeof createApp>['publicApp'],
  port: number,
  host: string,
): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, host, (error?: Error) => {
      if (error) reject(error);
      else resolve(server);
    });
  });
}

function closeServer(server: Server, graceMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      server.closeAllConnections();
      resolve();
    }, graceMs);
    timer.unref();
    server.close(() => {
      clearTimeout(timer);
      resolve();
    });
    server.closeIdleConnections();
  });
}

/** Starts the public and internal listeners. */
export async function main(options: MainOptions = {}): Promise<RunningApi> {
  const config = options.config ?? loadApiConfig();
  const logger = options.logger ?? createLogger({ name: 'api', level: config.base.logLevel });
  const onIdleError = (error: Error) =>
    logger.warn({ err: error.message }, 'postgres idle connection lost; pool will reconnect');
  const kv: KvStore =
    config.kvDriver === 'memory' ? new MemoryKv() : RedisKv.connect(config.base.redis.url);
  const deps: AppDeps = {
    config,
    logger,
    db: createDb(config.base.database.url, { applicationName: 'ecloud-api', onIdleError }),
    dbPlatform: createDb(config.base.database.platformUrl, {
      applicationName: 'ecloud-api-platform',
      max: 5,
      onIdleError,
    }),
    kv,
    storage: createStorage(config.base.storage),
    metrics: createApiMetrics(),
  };
  const { publicApp, internalApp, routes } = createApp(deps);
  const publicServer = await listen(publicApp, config.base.ports.api, config.apiBindHost);
  const internalServer = await listen(
    internalApp,
    config.base.ports.internal,
    config.internalBindHost,
  );
  logger.info(
    {
      port: config.base.ports.api,
      internalPort: config.base.ports.internal,
      internalHost: config.internalBindHost,
      routes: routes.length,
      config: { ...redactConfig(config.base), kv: config.kvDriver },
    },
    'api listening',
  );
  if (config.internalApiTokenPrevious !== null) {
    // The rotation window has no built-in expiry: it lasts until the variable is removed.
    logger.warn(
      'INTERNAL_API_TOKEN_PREVIOUS is set: the previous internal token is still accepted; remove it once portal and freeradius use the new token (SECRETS_MANAGEMENT R1)',
    );
  }

  let stopping: Promise<void> | undefined;
  const shutdown = (): Promise<void> => {
    stopping ??= (async () => {
      logger.info('api shutting down: draining connections');
      await Promise.all([
        closeServer(publicServer, config.shutdownGraceMs),
        closeServer(internalServer, config.shutdownGraceMs),
      ]);
      await Promise.allSettled([
        deps.db.destroy(),
        deps.dbPlatform.destroy(),
        kv.close(),
        deps.storage?.close(),
      ]);
      deps.metrics?.stop();
      logger.info('api stopped');
    })();
    return stopping;
  };

  if (options.handleSignals !== false) {
    for (const signal of ['SIGTERM', 'SIGINT'] as const) {
      process.once(signal, () => {
        void shutdown().then(() => process.exit(0));
      });
    }
  }
  return { publicServer, internalServer, deps, shutdown };
}
