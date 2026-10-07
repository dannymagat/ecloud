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

/** Throws 429 while the account is locked out. */
export async function assertNotLocked(deps: AppDeps, email: string): Promise<void> {
  if (deps.config.rateLimitDisabled) return;
  const lock = await guard(() => deps.kv.ttl(`lock:${accountKey(email)}`));
  if (lock > 0) throw new TooManyRequestsError(lock, { detail: 'Too many failed attempts.' });
}

export async function recordFailure(deps: AppDeps, email: string): Promise<void> {
  if (deps.config.rateLimitDisabled) return;
  const failures = await guard(() =>
    deps.kv.incr(`fail:${accountKey(email)}`, LOGIN_LIMITS.windowSeconds),
  );
  if (failures >= LOGIN_LIMITS.perAccountFailures) {
    await guard(() => deps.kv.set(`lock:${accountKey(email)}`, '1', LOGIN_LIMITS.lockoutSeconds));
    await guard(() => deps.kv.del(`fail:${accountKey(email)}`));
  }
}

export async function clearFailures(deps: AppDeps, email: string): Promise<void> {
  if (deps.config.rateLimitDisabled) return;
  await guard(() => deps.kv.del(`fail:${accountKey(email)}`));
}
