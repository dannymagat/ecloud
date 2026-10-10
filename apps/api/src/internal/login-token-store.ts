/**
 * API-side consumer of the post-back login token (`@ecloud/adapters` vendor/login-token.ts,
 * Cycle A review L6). The single-use marker lives in the API's KV store (Redis
 * `SET key 1 NX EX ttl`); the key is derived from DATA_ENCRYPTION_KEY with the token's own HKDF
 * purpose. A store failure is a 503 (`ServiceUnavailableError`), never an acceptance. The F3
 * post-back engine (Cycle C) issues tokens with `issuePortalLoginToken` and consumes them here.
 */
import {
  LoginTokenKey,
  consumeLoginToken,
  issueLoginToken,
  type IssuedLoginToken,
  type LoginTokenBinding,
  type LoginTokenResult,
  type SingleUseStore,
} from '@ecloud/adapters';
import type { AppDeps } from '../context.js';
import { ServiceUnavailableError } from '../http/errors.js';
import type { KvStore } from '../kv.js';

/** `SET NX EX` on the API KV store. */
export function kvSingleUseStore(kv: KvStore): SingleUseStore {
  return { claim: (key, ttlSeconds) => kv.set(key, '1', ttlSeconds, true) };
}

const keys = new Map<string, LoginTokenKey>();

function tokenKey(deps: AppDeps): LoginTokenKey {
  const material = deps.config.dataEncryptionKey;
  let key = keys.get(material);
  if (key === undefined) {
    key = new LoginTokenKey(material);
    keys.clear();
    keys.set(material, key);
  }
  return key;
}

export function issuePortalLoginToken(
  deps: AppDeps,
  binding: LoginTokenBinding,
  now: Date,
  ttlS?: number,
): IssuedLoginToken {
  return issueLoginToken(tokenKey(deps), binding, ttlS === undefined ? { now } : { now, ttlS });
}

/** Accepts a token once across all API replicas; store errors -> 503 (fail closed). */
export async function consumePortalLoginToken(
  deps: AppDeps,
  token: unknown,
  binding: LoginTokenBinding,
  now: Date,
): Promise<LoginTokenResult> {
  try {
    return await consumeLoginToken(tokenKey(deps), token, binding, kvSingleUseStore(deps.kv), now);
  } catch {
    throw new ServiceUnavailableError('Login token store unavailable.');
  }
}
