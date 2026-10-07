import { createLogger } from '@ecloud/shared';
import { startWorker } from './app.js';
import { loadWorkerConfig } from './config.js';

const config = loadWorkerConfig();
const logger = createLogger({ name: 'worker', level: config.app.logLevel });

try {
  const running = await startWorker({ config, logger });
  const shutdown = (signal: NodeJS.Signals): void => {
    logger.info({ signal }, 'shutdown signal received');
    running
      .stop()
      .then(() => process.exit(0))
      .catch((err: unknown) => {
        logger.error({ err }, 'shutdown failed');
        process.exit(1);
      });
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
} catch (err) {
  logger.fatal({ err }, 'worker failed to start');
  process.exit(1);
}
