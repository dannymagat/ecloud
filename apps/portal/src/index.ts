import { createLogger, loadConfig, type AppConfig, type Logger } from '@ecloud/shared';
import express, { type Express } from 'express';
import type { EventEmitter } from 'node:events';
import type { Server } from 'node:http';

export const PACKAGE_NAME = '@ecloud/portal';

/** Default time in-flight requests get to finish on shutdown before connections are cut. */
export const DEFAULT_SHUTDOWN_GRACE_MS = 10_000;

/** Builds the captive portal Express 5 application (Phase 3: skeleton only). */
export function createServer(): Express {
  const app = express();
  app.disable('x-powered-by');
  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok' });
  });
  return app;
}

export interface MainOptions {
  config?: AppConfig;
  logger?: Logger;
  /** Install SIGTERM/SIGINT handlers (default true). */
  handleSignals?: boolean;
  shutdownGraceMs?: number;
  /** Where signals are received (default `process`; tests pass their own emitter). */
  signalSource?: Pick<EventEmitter, 'once'>;
  /** Called with 0 after a signal-triggered shutdown (default `process.exit`). */
  exit?: (code: number) => void;
}

export interface RunningPortal {
  server: Server;
  /** Stops accepting connections, drains in-flight requests (bounded by the grace period). */
  shutdown: () => Promise<void>;
}

/** Closes the listener; after `graceMs` any remaining connections are closed forcibly. */
export function closeServer(server: Server, graceMs: number): Promise<void> {
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

/** Starts the portal listener and resolves once it is accepting connections. */
export async function main(options: MainOptions = {}): Promise<RunningPortal> {
  const config = options.config ?? loadConfig();
  const logger = options.logger ?? createLogger({ name: 'portal', level: config.logLevel });
  const graceMs = options.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS;
  const app = createServer();
  const server = await new Promise<Server>((resolve, reject) => {
    const s = app.listen(config.ports.portal, (error?: Error) => {
      if (error) reject(error);
      else resolve(s);
    });
  });
  logger.info({ port: config.ports.portal }, 'portal listening');

  let stopping: Promise<void> | undefined;
  const shutdown = (): Promise<void> => {
    stopping ??= (async () => {
      logger.info('portal shutting down: draining connections');
      await closeServer(server, graceMs);
      logger.info('portal stopped');
    })();
    return stopping;
  };

  if (options.handleSignals !== false) {
    const source = options.signalSource ?? process;
    const exit = options.exit ?? ((code: number) => process.exit(code));
    for (const signal of ['SIGTERM', 'SIGINT'] as const) {
      source.once(signal, () => {
        void shutdown().then(() => exit(0));
      });
    }
  }
  return { server, shutdown };
}
