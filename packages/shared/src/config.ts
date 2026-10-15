import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { LOG_LEVELS } from './logger.js';

export type NodeEnv = 'development' | 'test' | 'production';
export type StorageDriver = 'local' | 's3';

/** Dev-only defaults. Rejected in production by `loadConfig` (D-033). */
export const DEV_DEFAULTS = Object.freeze({
  DATABASE_URL: 'postgres://ecloud_app:ecloud_dev_password@127.0.0.1:5432/ecloud',
  DATABASE_URL_PLATFORM: 'postgres://ecloud_platform:ecloud_dev_password@127.0.0.1:5432/ecloud',
  REDIS_URL: 'redis://127.0.0.1:6379',
  INTERNAL_API_TOKEN: 'ecloud_dev_internal_token_change_me',
});

const port = () => z.coerce.number().int().min(1).max(65535);
const optionalString = () =>
  z
    .string()
    .trim()
    .transform((value) => (value === '' ? undefined : value))
    .optional();
const boolString = () =>
  z
    .enum(['true', 'false', '1', '0'])
    .transform((value) => value === 'true' || value === '1')
    .optional();
const connectionUrl = (protocols: readonly string[]) =>
  z
    .string()
    .trim()
    .min(1)
    .refine((value) => protocols.some((p) => value.startsWith(`${p}://`)), {
      message: `expected a URL starting with ${protocols.map((p) => `${p}://`).join(' or ')}`,
    });

/**
 * Raw environment schema. Variable names are fixed by the Phase 3 brief; values are strings
 * from `process.env` and are coerced here. Keep this the single place where env is read.
 */
export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),

  API_PORT: port().default(3000),
  INTERNAL_PORT: port().default(3001),
  PORTAL_PORT: port().default(3002),

  DATABASE_URL: connectionUrl(['postgres', 'postgresql']).default(DEV_DEFAULTS.DATABASE_URL),
  DATABASE_URL_PLATFORM: connectionUrl(['postgres', 'postgresql']).default(
    DEV_DEFAULTS.DATABASE_URL_PLATFORM,
  ),
  REDIS_URL: connectionUrl(['redis', 'rediss']).default(DEV_DEFAULTS.REDIS_URL),

  SESSION_COOKIE_NAME: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_-]+$/, 'cookie name may contain only letters, digits, _ and -')
    .default('ecloud_sid'),
  SESSION_TTL_SECONDS: z.coerce.number().int().min(60).max(2_592_000).default(43_200),

  /**
   * HERMES_AAA_AUDIT.md F-003: this value is embedded in the FreeRADIUS configuration as
   * `$ENV{INTERNAL_API_TOKEN}` (raddb/policy.d/ecloud), which FreeRADIUS expands at
   * config-parse time. A token containing `%`, `"`, `\` or `$` could therefore alter the
   * parsed configuration -- `$ENV{OTHER_SECRET}` would expand another secret into an HTTP
   * header. docker-entrypoint.sh rejects those characters, but only when the entrypoint is
   * in the execution path; this restricts the alphabet by construction instead, for every
   * caller. scripts/secrets/lib.sh already generates base64url tokens, so no generated
   * secret is affected.
   */
  INTERNAL_API_TOKEN: z
    .string()
    .min(1)
    .regex(
      /^[A-Za-z0-9_-]+$/,
      'INTERNAL_API_TOKEN may contain only letters, digits, _ and - (it is embedded in the FreeRADIUS configuration)',
    )
    .default(DEV_DEFAULTS.INTERNAL_API_TOKEN),

  ARGON2_MEMORY_KIB: z.coerce.number().int().min(8_192).max(4_194_304).default(19_456),

  PUBLIC_ADMIN_ORIGIN: z.url().default('http://localhost:5173'),
  PUBLIC_API_ORIGIN: z.url().default('http://localhost:3000'),
  PUBLIC_PORTAL_ORIGIN: z.url().default('http://localhost:3002'),

  /**
   * Outbound mail, used by captive-portal email OTP
   * (docs/PORTAL_LOGIN_METHODS_DESIGN.md §4.1). Optional: with SMTP_HOST unset, nothing can send
   * and the OTP method refuses rather than failing silently at the guest.
   */
  SMTP_HOST: optionalString(),
  SMTP_PORT: port().default(587),
  SMTP_USER: optionalString(),
  SMTP_PASSWORD: optionalString(),
  /** Envelope sender; must be an address the relay will accept. */
  SMTP_FROM: optionalString(),
  /** STARTTLS on 587 by default; `true` for implicit TLS on 465. */
  SMTP_IMPLICIT_TLS: boolString(),
  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  STORAGE_LOCAL_PATH: z.string().trim().min(1).default('./var/storage'),
  /** Explicit opt-in for the local driver in production (D-026: non-critical assets only). */
  STORAGE_LOCAL_ALLOW_PRODUCTION: boolString(),
  S3_ENDPOINT: optionalString(),
  S3_REGION: optionalString(),
  S3_BUCKET: optionalString(),
  S3_ACCESS_KEY_ID: optionalString(),
  S3_SECRET_ACCESS_KEY: optionalString(),
  S3_FORCE_PATH_STYLE: boolString(),

  RADIUS_BIND_IP: optionalString(),
  RADIUS_PUBLIC_BIND_IP: optionalString(),
  RADIUS_COA_PORT: port().default(3799),
  RADIUS_SQL_USER: optionalString(),
  RADIUS_SQL_PASSWORD_FILE: optionalString(),
  RADIUS_DICTIONARY_DIR: optionalString(),
});

export type RawEnv = z.infer<typeof envSchema>;

export interface S3StorageConfig {
  endpoint: string | undefined;
  region: string | undefined;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
}

export interface AppConfig {
  nodeEnv: NodeEnv;
  isProduction: boolean;
  logLevel: RawEnv['LOG_LEVEL'];
  ports: { api: number; internal: number; portal: number };
  database: {
    /** RLS-enforced `ecloud_app` connection (api, portal). */
    url: string;
    /** BYPASSRLS `ecloud_platform` connection (worker, migrations). */
    platformUrl: string;
  };
  redis: { url: string };
  session: { cookieName: string; ttlSeconds: number };
  internalApiToken: string;
  argon2: { memoryKib: number; timeCost: 2; parallelism: 1 };
  origins: { admin: string; api: string; portal: string };
  storage:
    | { driver: 'local'; localPath: string }
    | { driver: 's3'; localPath: string; s3: S3StorageConfig };
  /** Outbound mail; null when SMTP_HOST is unset, which disables email OTP. */
  mail:
    | { host: string; port: number; user: string | undefined; password: string | undefined; from: string; implicitTls: boolean }
    | null;
  radius: {
    bindIp: string | undefined;
    publicBindIp: string | undefined;
    coaPort: number;
    sqlUser: string | undefined;
    sqlPasswordFile: string | undefined;
    dictionaryDir: string | undefined;
  };
}

/** Raised when the environment is invalid. The message names variables, never values. */
export class ConfigError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`Invalid environment configuration:\n  - ${problems.join('\n  - ')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

/**
 * Secret-bearing variables that may instead be supplied as `<NAME>_FILE=<path>` (Compose
 * `secrets:` -> `/run/secrets/<name>`, SECURITY_ARCHITECTURE.md §6.11 / §9): the value then never
 * appears in `docker inspect` or the process environment of the image. One list for every app so
 * api, worker and portal accept the same contract. `RADIUS_SQL_PASSWORD_FILE` is not in it: that
 * path is consumed by FreeRADIUS itself.
 */
export const SECRET_FILE_VARIABLES = Object.freeze([
  'DATABASE_URL',
  'DATABASE_URL_PLATFORM',
  'REDIS_URL',
  'INTERNAL_API_TOKEN',
  'INTERNAL_API_TOKEN_PREVIOUS',
  // D-061: the NAS-secret endpoint's own token (api + worker).
  'INTERNAL_SECRET_TOKEN',
  'S3_ACCESS_KEY_ID',
  'S3_SECRET_ACCESS_KEY',
  'MFA_ENCRYPTION_KEY',
  'DATA_ENCRYPTION_KEY',
  'VOUCHER_PEPPER',
  'PORTAL_STATE_SECRET',
  // Captive-portal email OTP (design §4.1): relay credential and the code pepper.
  'SMTP_PASSWORD',
  'OTP_PEPPER',
  // Cycle D review F4: the worker's derived vendor-API key (never the master data key)
  'VENDOR_API_SECRET_KEY',
] as const);

export type SecretFileReader = (path: string) => string;

const defaultSecretFileReader: SecretFileReader = (path) => readFileSync(path, 'utf8');

/**
 * Returns a copy of `env` where every `<NAME>_FILE` of `SECRET_FILE_VARIABLES` is replaced by
 * `<NAME>` = the file content (one trailing newline removed). Setting both forms, an unreadable
 * file or an empty file is a `ConfigError` that names the variable, never the value. The
 * returned object no longer contains the `_FILE` keys, so calling it twice is harmless.
 */
export function resolveSecretFiles(
  env: Record<string, string | undefined>,
  readFile: SecretFileReader = defaultSecretFileReader,
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = { ...env };
  const problems: string[] = [];
  for (const name of SECRET_FILE_VARIABLES) {
    const fileKey = `${name}_FILE`;
    const path = out[fileKey]?.trim();
    delete out[fileKey];
    if (path === undefined || path === '') continue;
    if (out[name] !== undefined && out[name] !== '') {
      problems.push(`${fileKey}: set either ${name} or ${fileKey}, not both`);
      continue;
    }
    let value: string;
    try {
      value = readFile(path).replace(/\r?\n$/, '');
    } catch {
      problems.push(`${fileKey}: the file cannot be read`);
      continue;
    }
    if (value.trim() === '') {
      problems.push(`${fileKey}: the file is empty`);
      continue;
    }
    out[name] = value;
  }
  if (problems.length > 0) throw new ConfigError(problems);
  return out;
}

/**
 * Loads and validates configuration from `env` (defaults to `process.env`). `<NAME>_FILE`
 * variables are resolved first (`resolveSecretFiles`).
 * Never logs: callers that want to print the effective config must use `redactConfig()`.
 */
export interface LoadConfigOptions {
  /**
   * `false` for a process that never reads `INTERNAL_API_TOKEN`, so it is neither required nor
   * length-checked in production and the process does not have to be given a credential it
   * cannot use.
   *
   * The worker is the case this exists for. It authenticates to the api's NAS-secret endpoint
   * with `INTERNAL_SECRET_TOKEN` (D-061) and has no reader for the shared token at all, yet the
   * shared loader refused to start without one — so it was mounting both credentials and could
   * only use one. Holding a credential it cannot read is pure blast radius: compromising the
   * worker yielded the token FreeRADIUS and the portal authenticate with.
   *
   * Defaults to required, so every existing caller is unchanged.
   */
  readonly requireInternalApiToken?: boolean;
}

export function loadConfig(
  env: Record<string, string | undefined> = process.env,
  options: LoadConfigOptions = {},
): AppConfig {
  const requireInternalApiToken = options.requireInternalApiToken !== false;
  const parsed = envSchema.safeParse(resolveSecretFiles(env));
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    );
  }
  const raw = parsed.data;
  const problems: string[] = [];
  const isProduction = raw.NODE_ENV === 'production';

  if (isProduction) {
    for (const key of Object.keys(DEV_DEFAULTS) as (keyof typeof DEV_DEFAULTS)[]) {
      // A process that declares no use of the shared token keeps the dev default harmlessly:
      // it never reads the value, so refusing it would only force a pointless mount.
      if (!requireInternalApiToken && key === 'INTERNAL_API_TOKEN') continue;
      if (raw[key] === DEV_DEFAULTS[key]) {
        problems.push(`${key}: dev default is not allowed when NODE_ENV=production`);
      }
    }
    if (requireInternalApiToken && raw.INTERNAL_API_TOKEN.length < 32) {
      problems.push('INTERNAL_API_TOKEN: must be at least 32 characters when NODE_ENV=production');
    }
  }

  if (isProduction) {
    if (raw.STORAGE_DRIVER === 'local' && raw.STORAGE_LOCAL_ALLOW_PRODUCTION !== true) {
      problems.push(
        'STORAGE_DRIVER: local is not allowed when NODE_ENV=production unless STORAGE_LOCAL_ALLOW_PRODUCTION=true (D-026: non-critical assets only)',
      );
    }
    if (
      raw.STORAGE_DRIVER === 's3' &&
      raw.S3_ENDPOINT !== undefined &&
      !raw.S3_ENDPOINT.toLowerCase().startsWith('https://')
    ) {
      problems.push('S3_ENDPOINT: must use https:// when NODE_ENV=production');
    }
  }

  // Mail is optional, but a half-configured relay is not: without a sender the first OTP would
  // fail at send time, i.e. in front of a guest, instead of at boot.
  if (raw.SMTP_HOST !== undefined && raw.SMTP_FROM === undefined) {
    problems.push('SMTP_FROM: required when SMTP_HOST is set');
  }

  let storage: AppConfig['storage'];
  if (raw.STORAGE_DRIVER === 's3') {
    const missing = (['S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'] as const).filter(
      (key) => raw[key] === undefined,
    );
    for (const key of missing) problems.push(`${key}: required when STORAGE_DRIVER=s3`);
    if (raw.S3_ENDPOINT === undefined && raw.S3_REGION === undefined) {
      problems.push('S3_ENDPOINT or S3_REGION: at least one is required when STORAGE_DRIVER=s3');
    }
    storage = {
      driver: 's3',
      localPath: raw.STORAGE_LOCAL_PATH,
      s3: {
        endpoint: raw.S3_ENDPOINT,
        region: raw.S3_REGION,
        bucket: raw.S3_BUCKET ?? '',
        accessKeyId: raw.S3_ACCESS_KEY_ID ?? '',
        secretAccessKey: raw.S3_SECRET_ACCESS_KEY ?? '',
        forcePathStyle: raw.S3_FORCE_PATH_STYLE ?? false,
      },
    };
  } else {
    storage = { driver: 'local', localPath: raw.STORAGE_LOCAL_PATH };
  }

  if (problems.length > 0) throw new ConfigError(problems);

  return {
    nodeEnv: raw.NODE_ENV,
    isProduction,
    logLevel: raw.LOG_LEVEL,
    ports: { api: raw.API_PORT, internal: raw.INTERNAL_PORT, portal: raw.PORTAL_PORT },
    database: { url: raw.DATABASE_URL, platformUrl: raw.DATABASE_URL_PLATFORM },
    redis: { url: raw.REDIS_URL },
    session: { cookieName: raw.SESSION_COOKIE_NAME, ttlSeconds: raw.SESSION_TTL_SECONDS },
    internalApiToken: raw.INTERNAL_API_TOKEN,
    argon2: { memoryKib: raw.ARGON2_MEMORY_KIB, timeCost: 2, parallelism: 1 },
    origins: {
      admin: raw.PUBLIC_ADMIN_ORIGIN,
      api: raw.PUBLIC_API_ORIGIN,
      portal: raw.PUBLIC_PORTAL_ORIGIN,
    },
    storage,
    mail:
      raw.SMTP_HOST === undefined
        ? null
        : {
            host: raw.SMTP_HOST,
            port: raw.SMTP_PORT,
            user: raw.SMTP_USER,
            password: raw.SMTP_PASSWORD,
            // Checked below: a relay without a sender is refused rather than defaulted.
            from: raw.SMTP_FROM ?? '',
            implicitTls: raw.SMTP_IMPLICIT_TLS ?? false,
          },
    radius: {
      bindIp: raw.RADIUS_BIND_IP,
      publicBindIp: raw.RADIUS_PUBLIC_BIND_IP,
      coaPort: raw.RADIUS_COA_PORT,
      sqlUser: raw.RADIUS_SQL_USER,
      sqlPasswordFile: raw.RADIUS_SQL_PASSWORD_FILE,
      dictionaryDir: raw.RADIUS_DICTIONARY_DIR,
    },
  };
}

const REDACTED = '[REDACTED]';

/** Strips credentials from a connection URL (`postgres://user:pw@host/db` -> `postgres://user:[REDACTED]@host/db`). */
export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    // Brackets would be percent-encoded inside a URL, so use a bare marker here.
    if (parsed.password !== '') parsed.password = 'REDACTED';
    return parsed.toString();
  } catch {
    return REDACTED;
  }
}

/** Copy of the config safe to log or print: all secrets replaced. */
export function redactConfig(config: AppConfig): AppConfig {
  return {
    ...config,
    database: {
      url: redactUrl(config.database.url),
      platformUrl: redactUrl(config.database.platformUrl),
    },
    redis: { url: redactUrl(config.redis.url) },
    internalApiToken: REDACTED,
    storage:
      config.storage.driver === 's3'
        ? {
            ...config.storage,
            s3: { ...config.storage.s3, accessKeyId: REDACTED, secretAccessKey: REDACTED },
          }
        : { ...config.storage },
  };
}
