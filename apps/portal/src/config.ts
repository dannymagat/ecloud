/**
 * Portal-local configuration on top of `@ecloud/shared` `loadConfig()`. Same rules as the API:
 * dev-only defaults are obviously fake and refused when NODE_ENV=production (D-033); errors name
 * variables, never values. The portal holds no DB credentials and no UAM/RADIUS secret
 * (API_ARCHITECTURE.md §1): only the internal API token and its own state-signing key.
 */
import { ConfigError, loadConfig, type AppConfig } from '@ecloud/shared';
import { z } from 'zod';

export const PORTAL_DEV_DEFAULTS = Object.freeze({
  PORTAL_STATE_SECRET: 'ecloud_dev_portal_state_secret_change_me',
});

export const portalEnvSchema = z.object({
  /** HMAC key for flow tokens and CSRF tokens (signed short-lived portal state). */
  PORTAL_STATE_SECRET: z.string().min(16).default(PORTAL_DEV_DEFAULTS.PORTAL_STATE_SECRET),
  /** Base URL of the api internal listener (`/internal/portal/*`); never through Caddy. */
  PORTAL_INTERNAL_API_URL: z.url().optional(),
  PORTAL_API_TIMEOUT_MS: z.coerce.number().int().min(100).max(30_000).default(5_000),
  /** `Secure` cookie + HSTS; defaults to true in production. */
  PORTAL_COOKIE_SECURE: z.enum(['true', 'false', '1', '0']).optional(),
  /** Express `trust proxy` hop count (Caddy in front = 1). */
  PORTAL_TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(0),
});

export interface PortalConfig {
  base: AppConfig;
  stateSecret: string;
  internalApiUrl: string;
  apiTimeoutMs: number;
  secureCookies: boolean;
  trustProxyHops: number;
}

export function loadPortalConfig(
  env: Record<string, string | undefined> = process.env,
  base: AppConfig = loadConfig(env),
): PortalConfig {
  const parsed = portalEnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    );
  }
  const raw = parsed.data;
  if (base.isProduction) {
    const problems: string[] = [];
    if (raw.PORTAL_STATE_SECRET === PORTAL_DEV_DEFAULTS.PORTAL_STATE_SECRET) {
      problems.push('PORTAL_STATE_SECRET: dev default is not allowed when NODE_ENV=production');
    } else if (raw.PORTAL_STATE_SECRET.length < 32) {
      problems.push('PORTAL_STATE_SECRET: must be at least 32 characters when NODE_ENV=production');
    }
    if (raw.PORTAL_COOKIE_SECURE === 'false' || raw.PORTAL_COOKIE_SECURE === '0') {
      problems.push('PORTAL_COOKIE_SECURE: must not be false when NODE_ENV=production');
    }
    if (problems.length > 0) throw new ConfigError(problems);
  }
  const secureCookies =
    raw.PORTAL_COOKIE_SECURE === undefined
      ? base.isProduction
      : raw.PORTAL_COOKIE_SECURE === 'true' || raw.PORTAL_COOKIE_SECURE === '1';
  return {
    base,
    stateSecret: raw.PORTAL_STATE_SECRET,
    internalApiUrl: (
      raw.PORTAL_INTERNAL_API_URL ?? `http://127.0.0.1:${String(base.ports.internal)}`
    ).replace(/\/+$/, ''),
    apiTimeoutMs: raw.PORTAL_API_TIMEOUT_MS,
    secureCookies,
    trustProxyHops: raw.PORTAL_TRUST_PROXY_HOPS,
  };
}
