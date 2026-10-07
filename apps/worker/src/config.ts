/**
 * Worker-only settings. The shared `loadConfig()` (packages/shared/src/config.ts) does not
 * define these yet; they are read here with zod and listed in the Phase 3 report so they can
 * be moved into the shared schema.
 */
import { ConfigError, loadConfig, type AppConfig } from '@ecloud/shared';
import { z } from 'zod';

const boolFlag = (fallback: boolean) =>
  z
    .enum(['true', 'false', '1', '0', ''])
    .optional()
    .transform((value) =>
      value === undefined || value === '' ? fallback : value === 'true' || value === '1',
    );

const positiveInt = (fallback: number, max: number) =>
  z.coerce.number().int().min(1).max(max).default(fallback);

export const workerEnvSchema = z.object({
  WORKER_HEALTH_PORT: z.coerce.number().int().min(1).max(65535).default(3003),
  WORKER_HEALTH_HOST: z.string().trim().min(1).default('127.0.0.1'),
  /** D-006: CoA / Disconnect stay REQUIRES_DEVICE_TEST; the dispatcher is off unless set. */
  ECLOUD_COA_ENABLED: boolFlag(false),
  RADCLIENT_PATH: z.string().trim().min(1).default('radclient'),
  RADCLIENT_TIMEOUT_S: positiveInt(2, 30),
  RADCLIENT_RETRIES: z.coerce.number().int().min(0).max(10).default(3),
  /** D-025 retention runs as a dry-run plan unless this is true. */
  RETENTION_APPLY: boolFlag(false),
  /** Expected Acct-Interim-Interval (uCentral default 600 s overrides ECLOUD's 300, AAA §5.3). */
  WORKER_INTERIM_INTERVAL_S: positiveInt(600, 86_400),
  WORKER_REAP_GRACE_S: z.coerce.number().int().min(0).max(86_400).default(120),
  WORKER_DRAIN_BATCH: positiveInt(500, 10_000),
});

export interface WorkerConfig {
  app: AppConfig;
  health: { port: number; host: string };
  coa: { enabled: boolean; radclientPath: string; timeoutS: number; retries: number };
  retention: { apply: boolean };
  sessions: { interimIntervalS: number; reapGraceS: number };
  drain: { batchSize: number };
}

export function loadWorkerConfig(
  env: Record<string, string | undefined> = process.env,
): WorkerConfig {
  const app = loadConfig(env);
  const parsed = workerEnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    );
  }
  const raw = parsed.data;
  return {
    app,
    health: { port: raw.WORKER_HEALTH_PORT, host: raw.WORKER_HEALTH_HOST },
    coa: {
      enabled: raw.ECLOUD_COA_ENABLED,
      radclientPath: raw.RADCLIENT_PATH,
      timeoutS: raw.RADCLIENT_TIMEOUT_S,
      retries: raw.RADCLIENT_RETRIES,
    },
    retention: { apply: raw.RETENTION_APPLY },
    sessions: {
      interimIntervalS: raw.WORKER_INTERIM_INTERVAL_S,
      reapGraceS: raw.WORKER_REAP_GRACE_S,
    },
    drain: { batchSize: raw.WORKER_DRAIN_BATCH },
  };
}
