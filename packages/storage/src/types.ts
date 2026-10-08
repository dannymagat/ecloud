import type { Readable } from 'node:stream';
import type { ObjectKey, TenantPrefix } from './keys.js';

export type StorageDriverName = 'local' | 's3';

/**
 * Upload body. Buffers are copied; streams are read chunk by chunk and destroyed as soon as the
 * running total exceeds the limit (so up to one chunk past the limit may be read). This is not an
 * HTTP body limit: request handlers must still cap the request size themselves.
 */
export type ObjectBody = Uint8Array | Readable | AsyncIterable<Uint8Array>;

export interface PutObjectOptions {
  /** Declared MIME type; must be allow-listed for the key's purpose and match the bytes. */
  contentType: string;
  /** Optional tighter limit than the purpose maximum (never looser). */
  maxBytes?: number;
}

export interface ObjectMetadata {
  key: ObjectKey;
  /** Size in bytes. */
  size: number;
  contentType: string;
  /** Hex SHA-256 of the content, computed on upload. `undefined` if the backend lost it. */
  sha256: string | undefined;
  lastModified: Date;
}

export interface ObjectSummary {
  key: ObjectKey;
  size: number;
  lastModified: Date;
}

export interface StoredObject extends ObjectMetadata {
  /** Content stream. The caller must consume or destroy it. */
  body: Readable;
}

export interface ListObjectsOptions {
  /** Maximum number of entries (1-1000, default 1000). */
  limit?: number;
}

export interface SignedUrlOptions {
  /** Lifetime in seconds (1-3600, default 300). */
  expiresInSeconds?: number;
}

export interface StorageCapabilities {
  /** `getSignedReadUrl` returns a usable expiring URL (otherwise it throws). */
  signedReadUrls: boolean;
}

/**
 * Object storage abstraction (D-026). Business code depends on this interface only and obtains
 * an implementation from `createStorage(config)`; drivers are never imported directly.
 *
 * All keys are validated (`parseObjectKey`/`parseTenantPrefix`) on every call; content type,
 * magic bytes and size are enforced by `put` against the key's purpose policy.
 */
export interface ObjectStorage {
  readonly driver: StorageDriverName;
  readonly capabilities: StorageCapabilities;
  /** Stores or replaces an object (consistency guarantees: see each driver and the README). */
  put(
    key: ObjectKey | string,
    body: ObjectBody,
    options: PutObjectOptions,
  ): Promise<ObjectMetadata>;
  /** Opens an object. Throws `ObjectNotFoundError`. */
  get(key: ObjectKey | string): Promise<StoredObject>;
  /** Metadata, or `null` when the object does not exist. */
  head(key: ObjectKey | string): Promise<ObjectMetadata | null>;
  /** Deletes an object. Idempotent: deleting a missing object succeeds. */
  delete(key: ObjectKey | string): Promise<void>;
  /** Lists objects under a tenant prefix, sorted by key. */
  list(prefix: TenantPrefix | string, options?: ListObjectsOptions): Promise<ObjectSummary[]>;
  /**
   * Expiring read URL for direct download. Throws `StorageOperationUnsupportedError` when
   * `capabilities.signedReadUrls` is false (local driver).
   */
  getSignedReadUrl(key: ObjectKey | string, options?: SignedUrlOptions): Promise<string>;
  /** Cheap reachability/permission probe for readiness checks. Throws `StorageBackendError`. */
  checkHealth(): Promise<void>;
  /** Releases client resources. */
  close(): Promise<void>;
}

export const DEFAULT_LIST_LIMIT = 1000;
export const DEFAULT_SIGNED_URL_TTL_SECONDS = 300;
export const MAX_SIGNED_URL_TTL_SECONDS = 3600;

export function resolveListLimit(options?: ListObjectsOptions): number {
  const limit = options?.limit ?? DEFAULT_LIST_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > DEFAULT_LIST_LIMIT) {
    throw new RangeError(`list limit must be an integer between 1 and ${DEFAULT_LIST_LIMIT}`);
  }
  return limit;
}

export function resolveSignedUrlTtl(options?: SignedUrlOptions): number {
  const ttl = options?.expiresInSeconds ?? DEFAULT_SIGNED_URL_TTL_SECONDS;
  if (!Number.isInteger(ttl) || ttl < 1 || ttl > MAX_SIGNED_URL_TTL_SECONDS) {
    throw new RangeError(
      `expiresInSeconds must be an integer between 1 and ${MAX_SIGNED_URL_TTL_SECONDS}`,
    );
  }
  return ttl;
}
