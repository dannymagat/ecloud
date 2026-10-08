import { createHash } from 'node:crypto';
import { ObjectTooLargeError } from './errors.js';
import { parseObjectKey, type ObjectKey } from './keys.js';
import {
  assertContentMatchesType,
  assertContentTypeAllowed,
  effectiveMaxBytes,
} from './purposes.js';
import type { ObjectBody, PutObjectOptions } from './types.js';

/** A fully validated upload, ready to be written by a driver. */
export interface PreparedUpload {
  key: ObjectKey;
  contentType: string;
  bytes: Buffer;
  sha256: string;
}

/**
 * Reads `body` into memory (always a private copy), failing as soon as the running total exceeds
 * `maxBytes`; a stream is destroyed at that point (at most one extra chunk is read). Purpose limits are small
 * (branding: 5 MiB), so buffering is bounded; it also lets us sniff and hash before writing.
 */
export async function readBodyWithLimit(body: ObjectBody, maxBytes: number): Promise<Buffer> {
  if (body instanceof Uint8Array) {
    if (body.byteLength > maxBytes) throw new ObjectTooLargeError(maxBytes);
    // Copy: the caller could mutate its buffer between the sniff/hash and the write.
    return Buffer.from(body);
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of body as AsyncIterable<unknown>) {
    const buffer =
      typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk as Uint8Array);
    total += buffer.byteLength;
    if (total > maxBytes) {
      if ('destroy' in body && typeof body.destroy === 'function') body.destroy();
      throw new ObjectTooLargeError(maxBytes);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, total);
}

/** Validates key, content type, size and magic bytes; returns the bytes and their SHA-256. */
export async function prepareUpload(
  rawKey: string,
  body: ObjectBody,
  options: PutObjectOptions,
): Promise<PreparedUpload> {
  const { key, purpose } = parseObjectKey(rawKey);
  const contentType = assertContentTypeAllowed(purpose, options.contentType);
  const maxBytes = effectiveMaxBytes(purpose, options.maxBytes);
  const bytes = await readBodyWithLimit(body, maxBytes);
  assertContentMatchesType(contentType, bytes);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  return { key, contentType, bytes, sha256 };
}
