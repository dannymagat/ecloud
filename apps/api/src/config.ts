/**
 * API-local configuration extension. `@ecloud/shared` `loadConfig()` owns the common variables;
 * the API needs a few more (key material for MFA / NAS secrets / voucher pepper, cookie and
 * listener knobs). They are validated here with the same rules: dev-only defaults that are
 * rejected when NODE_ENV=production, and error messages that name variables, never values.
 */
import { parseDenyCidrs } from '@ecloud/vendor-api';
import { ConfigError, loadConfig, resolveSecretFiles, type AppConfig } from '@ecloud/shared';
import { z } from 'zod';

/** Dev-only key material (obviously fake, rejected in production — D-033). */
export const API_DEV_DEFAULTS = Object.freeze({
  MFA_ENCRYPTION_KEY: 'ecloud_dev_mfa_encryption_key_change_me',
  DATA_ENCRYPTION_KEY: 'ecloud_dev_data_encryption_key_change_me',
  VOUCHER_PEPPER: 'ecloud_dev_voucher_pepper_change_me',
});

const boolEnv = (fallback: boolean) =>
  z
    .enum(['true', 'false', '1', '0'])
    .optional()
    .transform((v) => (v === undefined ? fallback : v === 'true' || v === '1'));

export const apiEnvSchema = z.object({
  MFA_ENCRYPTION_KEY: z.string().min(16).default(API_DEV_DEFAULTS.MFA_ENCRYPTION_KEY),
  DATA_ENCRYPTION_KEY: z.string().min(16).default(API_DEV_DEFAULTS.DATA_ENCRYPTION_KEY),
  VOUCHER_PEPPER: z.string().min(16).default(API_DEV_DEFAULTS.VOUCHER_PEPPER),
  /**
   * P10-A rotation window (docs/SECRETS_MANAGEMENT.md R1): the internal listener also accepts
   * this previous token while FreeRADIUS / the portal are switched to the new INTERNAL_API_TOKEN.
   * Unset it once every caller uses the new token.
   */
  INTERNAL_API_TOKEN_PREVIOUS: z
    .string()
    .trim()
    .transform((v) => (v === '' ? undefined : v))
    .optional(),
  /**
   * Cycle D review F2: extra networks outbound vendor-API calls may never reach (CIDRs, comma
   * separated). Unset = @ecloud/vendor-api DEFAULT_DENY_CIDRS (compose bridge 172.28.0.0/16,
   * docker0 172.17.0.0/16, WireGuard overlay 100.100.0.0/16); setting it REPLACES that default.
   */
  VENDOR_API_DENY_CIDRS: z
    .string()
    .optional()
    .refine(
      (v) => {
        if (v === undefined) return true;
        try {
          parseDenyCidrs(v);
          return true;
        } catch {
          return false;
        }
      },
      { message: 'comma-separated CIDR list' },
    ),
  /** Idle timeout of admin sessions (SECURITY_ARCHITECTURE.md §6.3: 30 min). */
  SESSION_IDLE_SECONDS: z.coerce.number().int().min(60).max(86_400).default(1_800),
  /** `Secure` cookie attribute; defaults to true in production. */
  SESSION_COOKIE_SECURE: z.enum(['true', 'false', '1', '0']).optional(),
  /** Express `trust proxy` (hop count). 0 = do not trust X-Forwarded-For. */
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(0),
  /** Bind address of the internal listener (compose: 0.0.0.0 on the private network only). */
  INTERNAL_BIND_HOST: z.string().trim().min(1).default('127.0.0.1'),
  API_BIND_HOST: z.string().trim().min(1).default('0.0.0.0'),
  /** Use the in-process memory store instead of Redis (tests / single-process dev only). */
  KV_DRIVER: z.enum(['redis', 'memory']).default('redis'),
  /** Role template whose permissions an impersonating support admin receives (MULTITENANCY §4.4 step 7). */
  IMPERSONATION_ROLE_TEMPLATE: z
    .string()
    .regex(/^[a-z][a-z0-9_]{1,63}$/)
    .default('org_admin'),
  /** Acct-Interim-Interval sent to NASes whose adapter can carry it (null = not sent). */
  AAA_INTERIM_INTERVAL_S: z.coerce.number().int().min(60).max(86_400).optional(),
  /**
   * Q44: Session-Timeout cap while no lab-validated CoA can push a policy change into a live
   * session (P7-A). 0 disables the cap.
   */
  AAA_SESSION_TIMEOUT_CAP_S: z.coerce
    .number()
    .int()
    .min(0)
    .max(86_400)
    .refine((v) => v === 0 || v >= 300, {
      message: 'must be 0 (disabled) or >= 300 s (Q45 re-auth cadence floor)',
    })
    .default(1_800),
  /** P7-A: open sessions re-resolved per policy change; the rest are recorded unevaluated. */
  ENFORCEMENT_MAX_SESSIONS: z.coerce.number().int().min(1).max(100_000).default(2_000),
  /** Same variable as the worker (D-006, default off): the API only reads it to choose strategies. */
  ECLOUD_COA_ENABLED: boolEnv(false),
  SHUTDOWN_GRACE_MS: z.coerce.number().int().min(0).max(120_000).default(10_000),
  RATE_LIMIT_DISABLED: boolEnv(false),
});

export interface ApiConfig {
  base: AppConfig;
  mfaEncryptionKey: string;
  dataEncryptionKey: string;
  voucherPepper: string;
  /** Previous internal token accepted during a rotation window (null = none). */
  internalApiTokenPrevious: string | null;
  session: {
    cookieName: string;
    ttlSeconds: number;
    idleSeconds: number;
    secureCookie: boolean;
  };
  trustProxyHops: number;
  internalBindHost: string;
  apiBindHost: string;
  kvDriver: 'redis' | 'memory';
  impersonationRoleTemplate: string;
  aaaInterimIntervalS: number | null;
  /** Q44 cap in seconds; 0 = disabled. */
  aaaSessionTimeoutCapS: number;
  /** ENFORCEMENT_MAX_SESSIONS: re-resolution cap of one policy change. */
  enforcementMaxSessions: number;
  /** ECLOUD_COA_ENABLED as seen by the API (strategy selection only; nothing is sent from the API). */
  coaEnabled: boolean;
  shutdownGraceMs: number;
  rateLimitDisabled: boolean;
  /** Cycle D review F2: VENDOR_API_DENY_CIDRS (undefined = vendor-api default list). */
  vendorApiDenyCidrs?: string;
}

export function loadApiConfig(
  env: Record<string, string | undefined> = process.env,
  base: AppConfig = loadConfig(env),
): ApiConfig {
  const parsed = apiEnvSchema.safeParse(resolveSecretFiles(env));
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    );
  }
  const raw = parsed.data;
  const problems: string[] = [];
  if (base.isProduction) {
    for (const key of Object.keys(API_DEV_DEFAULTS) as (keyof typeof API_DEV_DEFAULTS)[]) {
      if (raw[key] === API_DEV_DEFAULTS[key]) {
        problems.push(`${key}: dev default is not allowed when NODE_ENV=production`);
      } else if (raw[key].length < 32) {
        problems.push(`${key}: must be at least 32 characters when NODE_ENV=production`);
      }
    }
    if (raw.INTERNAL_API_TOKEN_PREVIOUS !== undefined) {
      if (raw.INTERNAL_API_TOKEN_PREVIOUS.length < 32) {
        problems.push(
          'INTERNAL_API_TOKEN_PREVIOUS: must be at least 32 characters when NODE_ENV=production',
        );
      }
      if (raw.INTERNAL_API_TOKEN_PREVIOUS === base.internalApiToken) {
        problems.push('INTERNAL_API_TOKEN_PREVIOUS: must differ from INTERNAL_API_TOKEN');
      }
    }
    if (raw.KV_DRIVER === 'memory') {
      problems.push('KV_DRIVER: memory is not allowed when NODE_ENV=production');
    }
    if (raw.RATE_LIMIT_DISABLED) {
      problems.push('RATE_LIMIT_DISABLED: not allowed when NODE_ENV=production');
    }
    // SECURITY_ARCHITECTURE.md §6.3: production admin cookie is `__Host-…; Secure` (the portal
    // already refuses PORTAL_COOKIE_SECURE=false in production; the API now matches it).
    if (raw.SESSION_COOKIE_SECURE === 'false' || raw.SESSION_COOKIE_SECURE === '0') {
      problems.push('SESSION_COOKIE_SECURE: must not be false when NODE_ENV=production');
    }
    if (!base.session.cookieName.startsWith('__Host-')) {
      problems.push('SESSION_COOKIE_NAME: must start with __Host- when NODE_ENV=production');
    }
  }
  if (problems.length > 0) throw new ConfigError(problems);

  const secureCookie =
    raw.SESSION_COOKIE_SECURE === undefined
      ? base.isProduction
      : raw.SESSION_COOKIE_SECURE === 'true' || raw.SESSION_COOKIE_SECURE === '1';

  return {
    base,
    mfaEncryptionKey: raw.MFA_ENCRYPTION_KEY,
    dataEncryptionKey: raw.DATA_ENCRYPTION_KEY,
    voucherPepper: raw.VOUCHER_PEPPER,
    internalApiTokenPrevious: raw.INTERNAL_API_TOKEN_PREVIOUS ?? null,
    session: {
      cookieName: base.session.cookieName,
      ttlSeconds: base.session.ttlSeconds,
      idleSeconds: raw.SESSION_IDLE_SECONDS,
      secureCookie,
    },
    trustProxyHops: raw.TRUST_PROXY_HOPS,
    internalBindHost: raw.INTERNAL_BIND_HOST,
    apiBindHost: raw.API_BIND_HOST,
    kvDriver: raw.KV_DRIVER,
    impersonationRoleTemplate: raw.IMPERSONATION_ROLE_TEMPLATE,
    aaaInterimIntervalS: raw.AAA_INTERIM_INTERVAL_S ?? null,
    aaaSessionTimeoutCapS: raw.AAA_SESSION_TIMEOUT_CAP_S,
    enforcementMaxSessions: raw.ENFORCEMENT_MAX_SESSIONS,
    coaEnabled: raw.ECLOUD_COA_ENABLED,
    shutdownGraceMs: raw.SHUTDOWN_GRACE_MS,
    rateLimitDisabled: raw.RATE_LIMIT_DISABLED,
    ...(raw.VENDOR_API_DENY_CIDRS !== undefined
      ? { vendorApiDenyCidrs: raw.VENDOR_API_DENY_CIDRS }
      : {}),
  };
}
