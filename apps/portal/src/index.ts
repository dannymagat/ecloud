import { createLogger, loadConfig, type AppConfig, type Logger } from '@ecloud/shared';
import express, { type Express } from 'express';
import type { Server } from 'node:http';

export const PACKAGE_NAME = '@ecloud/portal';

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
}

/** Starts the portal listener and resolves once it is accepting connections. */
export async function main(options: MainOptions = {}): Promise<Server> {
  const config = options.config ?? loadConfig();
  const logger = options.logger ?? createLogger({ name: 'portal', level: config.logLevel });
  const app = createServer();
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(config.ports.portal, () => resolve(s));
  });
  logger.info({ port: config.ports.portal }, 'portal listening');
  return server;
}
