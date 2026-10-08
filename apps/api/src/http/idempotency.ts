/**
 * `Idempotency-Key` for POST (API_ARCHITECTURE.md §3.1): the first response is stored for 24 h
 * keyed by principal + route + key with a fingerprint of the request body; a replay returns the
 * stored response, a different body under the same key is 422, a concurrent duplicate is 409.
 * Fields marked secret (API key plaintext, voucher codes, NAS secrets) are removed before the
 * response is stored: they are shown exactly once and a replay says so.
 */
import { ConflictError, isUuid } from '@ecloud/shared';
import type { Request } from 'express';
import type { AppDeps } from '../context.js';
import { createHash } from 'node:crypto';
import { sha256Hex } from '../crypto.js';
import { canonicalJson } from '@ecloud/policy-engine';
import {
  IdempotencyConflictError,
  IdempotencyRequiredError,
  ServiceUnavailableError,
} from './errors.js';
import type { AnyRouteSpec, HandlerResult } from './route.js';

export const IDEMPOTENCY_TTL_SECONDS = 24 * 3600;
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
  // Binary bodies (branding uploads) are fingerprinted by their bytes, JSON bodies canonically.
  const fingerprint = Buffer.isBuffer(req.body)
    ? `bin:${createHash('sha256').update(req.body).digest('hex')}`
    : sha256Hex(canonicalJson(req.body ?? null));

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
