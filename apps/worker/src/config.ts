/**
 * Worker-only settings. The shared `loadConfig()` (packages/shared/src/config.ts) does not
 * define these yet; they are read here with zod and listed in the Phase 3 report so they can
 * be moved into the shared schema.
 */
import { ConfigError, loadConfig, resolveSecretFiles, type AppConfig } from '@ecloud/shared';
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
  /** D-036: an `authorized` session without accounting for this long becomes `expired`. */
  WORKER_AUTHORIZATION_TTL_S: z.coerce.number().int().min(30).max(86_400).default(300),
  WORKER_DRAIN_BATCH: positiveInt(500, 10_000),
  /**
   * P7-A wrap correction rule W4: plausibility ceiling per counter direction (bit/s) for a 32-bit
   * octet counter wrap. Operator assumption, not a device fact. Default 1 Gbit/s.
   */
  WORKER_COUNTER_WRAP_MAX_BPS: z.coerce
    .number()
    .int()
    .min(1)
    .max(100_000_000_000)
    .default(1_000_000_000),
  /**
   * Cycle D: the controller AP inventory job makes OUTBOUND calls to tenant controllers; off
   * unless explicitly enabled (it also needs DATA_ENCRYPTION_KEY to open the sealed credential).
   */
  WORKER_CONTROLLER_INVENTORY_ENABLED: boolFlag(false),
  /**
   * Cycle D review F4: the PRE-DERIVED vendor-API key (`vapi1.…`, HKDF of the master data key with
   * purpose `ecloud:vendor-api:secret:v1`; `node packages/vendor-api/dist/cli.js derive-key
   * vendor-api`). The worker never receives DATA_ENCRYPTION_KEY.
   */
  VENDOR_API_SECRET_KEY: z.string().min(1).optional(),
  /** Platform deny-list for outbound vendor-API calls (CIDRs, comma separated). */
  VENDOR_API_DENY_CIDRS: z.string().optional(),
});

export interface WorkerConfig {
  app: AppConfig;
  health: { port: number; host: string };
  coa: { enabled: boolean; radclientPath: string; timeoutS: number; retries: number };
  retention: { apply: boolean };
  sessions: { interimIntervalS: number; reapGraceS: number; authorizationTtlS: number };
  drain: { batchSize: number; wrapMaxBps: number };
  /** Cycle D controller-API inventory (outbound; off by default). */
  vendorApi: {
    inventoryEnabled: boolean;
    /** Derived purpose key (review F4), validated by the job before use. */
    secretKey: string | null;
    /** True when the master DATA_ENCRYPTION_KEY[_FILE] was given to the worker (refused). */
    masterKeyPresent: boolean;
    denyCidrs: string | null;
  };
}

export function loadWorkerConfig(
  env: Record<string, string | undefined> = process.env,
): WorkerConfig {
  const app = loadConfig(env);
  const parsed = workerEnvSchema.safeParse(resolveSecretFiles(env));
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
      authorizationTtlS: raw.WORKER_AUTHORIZATION_TTL_S,
    },
    drain: { batchSize: raw.WORKER_DRAIN_BATCH, wrapMaxBps: raw.WORKER_COUNTER_WRAP_MAX_BPS },
    vendorApi: {
      inventoryEnabled: raw.WORKER_CONTROLLER_INVENTORY_ENABLED,
      secretKey: raw.VENDOR_API_SECRET_KEY ?? null,
      masterKeyPresent:
        (env.DATA_ENCRYPTION_KEY ?? '') !== '' || (env.DATA_ENCRYPTION_KEY_FILE ?? '') !== '',
      denyCidrs: raw.VENDOR_API_DENY_CIDRS ?? null,
    },
  };
}
