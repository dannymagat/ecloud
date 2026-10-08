import { AppError, type AppErrorOptions } from '@ecloud/shared';

/**
 * Storage errors map to RFC 9457 problems through `AppError`. Messages name keys and
 * operations only — never endpoints, credentials or filesystem paths outside the key.
 */

/** The key, prefix, organization id, purpose or object id is malformed or escapes its tenant. */
export class InvalidStorageKeyError extends AppError {
  constructor(detail: string, options: Omit<AppErrorOptions, 'detail'> = {}) {
    super(400, 'storage-invalid-key', 'Invalid Storage Key', { ...options, detail });
  }
}

/** The declared content type is not allowed for the purpose, or the bytes do not match it. */
export class ContentTypeNotAllowedError extends AppError {
  constructor(detail: string, options: Omit<AppErrorOptions, 'detail'> = {}) {
    super(415, 'unsupported-media-type', 'Unsupported Media Type', { ...options, detail });
  }
}

/** The object exceeds the size limit of its purpose (or the caller's tighter limit). */
export class ObjectTooLargeError extends AppError {
  readonly maxBytes: number;

  constructor(maxBytes: number, options: Omit<AppErrorOptions, 'detail'> = {}) {
    super(413, 'payload-too-large', 'Payload Too Large', {
      ...options,
      detail: `object exceeds the limit of ${maxBytes} bytes`,
      extensions: { ...(options.extensions ?? {}), max_bytes: maxBytes },
    });
    this.maxBytes = maxBytes;
  }
}

/** No object exists under the key. */
export class ObjectNotFoundError extends AppError {
  constructor(key: string, options: Omit<AppErrorOptions, 'detail'> = {}) {
    super(404, 'not-found', 'Not Found', { ...options, detail: `object ${key} not found` });
  }
}

/** The active driver cannot perform this operation (e.g. signed URLs on the local driver). */
export class StorageOperationUnsupportedError extends AppError {
  constructor(operation: string, driver: string, options: Omit<AppErrorOptions, 'detail'> = {}) {
    super(501, 'storage-unsupported', 'Storage Operation Unsupported', {
      ...options,
      detail: `${operation} is not supported by the ${driver} storage driver`,
    });
  }
}

/** The backend failed (I/O error, S3 error, unreachable endpoint). The cause is kept, not shown. */
export class StorageBackendError extends AppError {
  constructor(operation: string, options: Omit<AppErrorOptions, 'detail'> = {}) {
    super(503, 'storage-unavailable', 'Storage Unavailable', {
      ...options,
      detail: `storage ${operation} failed`,
    });
  }
}
