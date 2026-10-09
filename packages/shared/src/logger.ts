import { pino, type DestinationStream, type Logger, type LoggerOptions } from 'pino';

export type { Logger } from 'pino';

export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const SENSITIVE_KEYS = [
  'password',
  'secret',
  'token',
  'authorization',
  'cookie',
  // P10-A review (SECURITY_ARCHITECTURE.md §6.11): further credential-bearing key names in use.
  'pepper',
  'mfa_token',
  'recovery_code',
  'api_key',
  'apiKey',
  'private_key',
  'privateKey',
  'preshared_key',
  'presharedKey',
] as const;

/** RADIUS attribute names (hyphenated: bracket notation in redaction paths). */
const SENSITIVE_ATTRIBUTES = ['User-Password', 'CHAP-Password'] as const;

/**
 * pino redaction paths: every sensitive key at depth 0..3 plus the usual request header shapes.
 * Values are replaced with `[REDACTED]`; the key itself stays visible so logs remain debuggable.
 */
export const LOG_REDACT_PATHS: readonly string[] = [
  ...SENSITIVE_KEYS.flatMap((key) => [key, `*.${key}`, `*.*.${key}`, `*.*.*.${key}`]),
  ...SENSITIVE_ATTRIBUTES.flatMap((attr) => [
    `["${attr}"]`,
    `*["${attr}"]`,
    `*.*["${attr}"]`,
    `*.*.*["${attr}"]`,
  ]),
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  'headers.authorization',
  'headers.cookie',
];

export interface CreateLoggerOptions {
  /** Process/service name, e.g. `api`, `worker`, `portal`. */
  name: string;
  level?: LogLevel;
  /** Static bindings added to every line (never put secrets here). */
  base?: Record<string, unknown>;
  /** Override the output stream (tests pass an in-memory sink). Defaults to stdout. */
  destination?: DestinationStream;
}

/**
 * Creates the standard ECLOUD pino logger: JSON lines, ISO timestamps, level labels and
 * mandatory redaction of credentials. Request-id binding is added per request by the apps.
 */
export function createLogger(options: CreateLoggerOptions): Logger {
  const loggerOptions: LoggerOptions = {
    name: options.name,
    level: options.level ?? 'info',
    base: { ...(options.base ?? {}), pid: process.pid },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => ({ level: label }),
    },
    redact: {
      paths: [...LOG_REDACT_PATHS],
      censor: '[REDACTED]',
    },
  };
  return options.destination === undefined
    ? pino(loggerOptions)
    : pino(loggerOptions, options.destination);
}
