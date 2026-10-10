/**
 * Fixed-window counters in the KV store. Authentication paths FAIL CLOSED when the store is
 * unavailable (API_ARCHITECTURE.md §3.1): a 503 is returned instead of skipping the limit.
 */
import type { AppDeps } from '../context.js';
import { ServiceUnavailableError, TooManyRequestsError } from '../http/errors.js';

export const LOGIN_LIMITS = Object.freeze({
  /** Attempts per client IP per window (any account). */
  perIp: 30,
  /** Failed attempts per account per window before the lockout starts (API_ARCHITECTURE §4). */
  perAccountFailures: 10,
  windowSeconds: 300,
  lockoutSeconds: 900,
  /** MFA code attempts per challenge / per session. */
  mfaAttempts: 5,
});

async function guard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch {
    throw new ServiceUnavailableError('Rate limiter unavailable; authentication is refused.');
  }
}

/** Counts one hit and throws 429 when `limit` is exceeded within the window. */
export async function hitLimit(
  deps: AppDeps,
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<void> {
  if (deps.config.rateLimitDisabled) return;
  const count = await guard(() => deps.kv.incr(`rl:${key}`, windowSeconds));
  if (count > limit) {
    const ttl = await guard(() => deps.kv.ttl(`rl:${key}`));
    throw new TooManyRequestsError(ttl || windowSeconds);
  }
}

export function accountKey(email: string): string {
  return `login:acct:${email}`;
}

/** Throws 429 while `key` is locked out (login account, secret reveal, …). */
export async function assertKeyNotLocked(deps: AppDeps, key: string): Promise<void> {
  if (deps.config.rateLimitDisabled) return;
  const lock = await guard(() => deps.kv.ttl(`lock:${key}`));
  if (lock > 0) throw new TooManyRequestsError(lock, { detail: 'Too many failed attempts.' });
}

/**
 * Counts one failure of `key` in the login window; at `threshold` failures the key is locked
 * for {@link LOGIN_LIMITS.lockoutSeconds} (the login lockout semantics).
 */
export async function recordKeyFailure(
  deps: AppDeps,
  key: string,
  threshold: number,
): Promise<void> {
  if (deps.config.rateLimitDisabled) return;
  const failures = await guard(() => deps.kv.incr(`fail:${key}`, LOGIN_LIMITS.windowSeconds));
  if (failures >= threshold) {
    await guard(() => deps.kv.set(`lock:${key}`, '1', LOGIN_LIMITS.lockoutSeconds));
    await guard(() => deps.kv.del(`fail:${key}`));
  }
}

export async function clearKeyFailures(deps: AppDeps, key: string): Promise<void> {
  if (deps.config.rateLimitDisabled) return;
  await guard(() => deps.kv.del(`fail:${key}`));
}

/** Throws 429 while the account is locked out. */
export async function assertNotLocked(deps: AppDeps, email: string): Promise<void> {
  await assertKeyNotLocked(deps, accountKey(email));
}

export async function recordFailure(deps: AppDeps, email: string): Promise<void> {
  await recordKeyFailure(deps, accountKey(email), LOGIN_LIMITS.perAccountFailures);
}

export async function clearFailures(deps: AppDeps, email: string): Promise<void> {
  await clearKeyFailures(deps, accountKey(email));
}

/**
 * D-045 NAS secret reveal (MFA step-up): reveal attempts per administrator per window, and
 * wrong MFA codes before the administrator's reveal is locked out (login lockout semantics:
 * {@link LOGIN_LIMITS.lockoutSeconds}). Fails closed like authentication.
 */
export const SECRET_REVEAL_LIMITS = Object.freeze({
  perAdministrator: 10,
  /** Per NAS (D-046: the reveal may need no MFA code, so the NAS is limited as well). */
  perNas: 20,
  windowSeconds: LOGIN_LIMITS.windowSeconds,
  mfaFailures: LOGIN_LIMITS.mfaAttempts,
});

/** API_ARCHITECTURE.md §3.1: export endpoints 10 per hour per principal. */
export const EXPORT_LIMIT = Object.freeze({ perHour: 10, windowSeconds: 3600 });

/**
 * Like `hitLimit` but FAIL OPEN when the store is unavailable (§3.1: only authentication fails
 * closed); a 429 is still raised when the store answers and the limit is exceeded.
 */
export async function hitLimitFailOpen(
  deps: AppDeps,
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<void> {
  if (deps.config.rateLimitDisabled) return;
  let count: number;
  try {
    count = await deps.kv.incr(`rl:${key}`, windowSeconds);
  } catch {
    return;
  }
  if (count > limit) {
    const ttl = await deps.kv.ttl(`rl:${key}`).catch(() => windowSeconds);
    throw new TooManyRequestsError(ttl || windowSeconds);
  }
}
