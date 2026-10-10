/**
 * `Idempotency-Key` for POST (API_ARCHITECTURE.md §3.1): the first response is stored for 24 h
 * keyed by principal + route + key with a fingerprint of the request body; a replay returns the
 * stored response, a different body under the same key is 422, a concurrent duplicate is 409.
 * Fields marked secret (API key plaintext, voucher codes, NAS secrets) are removed before the
 * response is stored: they are shown exactly once and a replay says so.
 *
 * The body fingerprint is a KEYED hash (HMAC-SHA256 with a key derived from DATA_ENCRYPTION_KEY,
 * purpose `ecloud:idempotency:fingerprint:v1`), never a plain hash: request bodies may carry
 * secrets (vendor API secrets, controller credentials, passwords) and an unsalted SHA-256 in
 * Redis would allow offline guessing of low-entropy values. Rolling this out invalidates stored
 * fingerprints of keys still inside their 24 h window (a replay then answers 422; clients retry
 * with a new key).
 */
import { ConflictError, isUuid } from '@ecloud/shared';
import type { Request } from 'express';
import type { AppDeps } from '../context.js';
import { createHmac, hkdfSync } from 'node:crypto';
import { canonicalJson } from '@ecloud/policy-engine';
import {
  IdempotencyConflictError,
  IdempotencyRequiredError,
  ServiceUnavailableError,
} from './errors.js';
import type { AnyRouteSpec, HandlerResult } from './route.js';

export const IDEMPOTENCY_TTL_SECONDS = 24 * 3600;

/** HKDF purpose of the fingerprint key (a label, not a secret). */
export const IDEMPOTENCY_FINGERPRINT_PURPOSE = 'ecloud:idempotency:fingerprint:v1'; // check-no-secrets: allow

const fingerprintKeys = new Map<string, Buffer>();

function fingerprintKey(dataEncryptionKey: string): Buffer {
  let key = fingerprintKeys.get(dataEncryptionKey);
  if (key === undefined) {
    key = Buffer.from(
      hkdfSync(
        'sha256',
        Buffer.from(dataEncryptionKey, 'utf8'),
        Buffer.alloc(0),
        IDEMPOTENCY_FINGERPRINT_PURPOSE,
        32,
      ),
    );
    fingerprintKeys.clear();
    fingerprintKeys.set(dataEncryptionKey, key);
  }
  return key;
}

/**
 * Keyed fingerprint of a request body: `hmac:` + HMAC-SHA256 over the canonical JSON (or the raw
 * bytes of a binary body). Equal bodies give equal fingerprints under one deployment key only.
 */
export function requestFingerprint(dataEncryptionKey: string, body: unknown): string {
  const mac = createHmac('sha256', fingerprintKey(dataEncryptionKey));
  if (Buffer.isBuffer(body)) mac.update('bin:').update(body);
  else mac.update('json:').update(canonicalJson(body ?? null), 'utf8');
  return `hmac:${mac.digest('hex')}`;
}
const LOCK_TTL_SECONDS = 60;

interface StoredResponse {
  fingerprint: string;
  status: number;
  body: unknown;
  redacted: string[];
}

function principalKey(req: Request): string {
  const p = req.ctx.principal;
  if (p === null) return `anon:${req.ctx.ip ?? 'unknown'}`;
  return p.kind === 'admin' ? `admin:${p.administratorId}` : `key:${p.apiKeyId}`;
}

function redact(body: unknown, fields: readonly string[]): { body: unknown; redacted: string[] } {
  if (fields.length === 0 || typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { body, redacted: [] };
  }
  const copy: Record<string, unknown> = { ...(body as Record<string, unknown>) };
  const redacted: string[] = [];
  for (const field of fields) {
    if (field in copy) {
      delete copy[field];
      redacted.push(field);
    }
  }
  return { body: copy, redacted };
}

export async function withIdempotency(
  deps: AppDeps,
  req: Request,
  spec: AnyRouteSpec,
  run: () => Promise<HandlerResult>,
): Promise<HandlerResult> {
  const header = req.get('Idempotency-Key');
  if (header === undefined || header.trim() === '') {
    if (spec.idempotency === 'required') throw new IdempotencyRequiredError();
    return run();
  }
  const key = header.trim();
  if (!isUuid(key)) {
    throw new IdempotencyConflictError('Idempotency-Key must be a UUID.');
  }
  const scope = `idem:${principalKey(req)}:${spec.method}:${req.path}:${key}`;
  // Binary bodies (branding uploads) are fingerprinted by their bytes, JSON bodies canonically;
  // always keyed (bodies may carry secrets).
  const fingerprint = requestFingerprint(deps.config.dataEncryptionKey, req.body);

  let existing: string | null;
  try {
    existing = await deps.kv.get(scope);
  } catch {
    throw new ServiceUnavailableError('Idempotency store unavailable.');
  }
  if (existing !== null) {
    const stored = JSON.parse(existing) as StoredResponse;
    if (stored.fingerprint !== fingerprint) {
      throw new IdempotencyConflictError(
        'Idempotency-Key was already used with a different request body.',
      );
    }
    const headers: Record<string, string> = { 'Idempotent-Replayed': 'true' };
    if (stored.redacted.length > 0) headers['Idempotent-Redacted'] = stored.redacted.join(',');
    return { status: stored.status, body: stored.body, headers };
  }

  const lockKey = `${scope}:lock`;
  const acquired = await deps.kv.set(lockKey, '1', LOCK_TTL_SECONDS, true);
  if (!acquired) {
    throw new ConflictError({ detail: 'A request with this Idempotency-Key is in progress.' });
  }
  try {
    const result = await run();
    if (result.status < 500) {
      const { body, redacted } = redact(result.body, spec.secretFields ?? []);
      const stored: StoredResponse = { fingerprint, status: result.status, body, redacted };
      await deps.kv.set(scope, JSON.stringify(stored), IDEMPOTENCY_TTL_SECONDS);
    }
    return result;
  } finally {
    await deps.kv.del(lockKey).catch(() => undefined);
  }
}
