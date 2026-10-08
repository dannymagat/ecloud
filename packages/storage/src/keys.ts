import { InvalidStorageKeyError } from './errors.js';
import { isStoragePurpose, type StoragePurpose } from './purposes.js';

/**
 * Tenant-scoped object keys: `org/{organizationId}/{purpose}/{id}`.
 *
 * - `organizationId` is a canonical lower-case UUID (one key per org, no case aliases);
 * - `purpose` is a registered `StoragePurpose`;
 * - `id` is 1-128 characters of `[a-z0-9._-]` (lower-case), starting with a letter or digit and
 *   containing no `..` — so it can never be a path segment like `.`/`..` and never holds `/`.
 *
 * Every driver entry point re-validates keys with `parseObjectKey`, so a key built by string
 * concatenation elsewhere is rejected rather than trusted.
 */

declare const objectKeyBrand: unique symbol;
declare const prefixBrand: unique symbol;

/** A validated object key. Obtain one from `buildObjectKey` or `parseObjectKey`. */
export type ObjectKey = string & { readonly [objectKeyBrand]: true };
/** A validated listing prefix: `org/{organizationId}/` or `org/{organizationId}/{purpose}/`. */
export type TenantPrefix = string & { readonly [prefixBrand]: true };

export interface ObjectKeyParts {
  organizationId: string;
  purpose: StoragePurpose;
  id: string;
}

const ROOT_SEGMENT = 'org';
const ORG_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
// Lower-case only: on case-insensitive filesystems (macOS, Windows) `A.png` and `a.png` would
// alias one file in the local driver while being distinct keys in S3.
const OBJECT_ID_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/;
/** Longest possible key; S3 allows 1024 bytes. */
export const MAX_KEY_LENGTH = 512;

function rejectUnsafeCharacters(value: string, what: string): void {
  if (value.includes('\0')) throw new InvalidStorageKeyError(`${what} contains a null byte`);
  if (value.includes('\\')) throw new InvalidStorageKeyError(`${what} contains a backslash`);
  if (value.startsWith('/')) throw new InvalidStorageKeyError(`${what} is an absolute path`);
  if (/^[A-Za-z]:/.test(value)) throw new InvalidStorageKeyError(`${what} is an absolute path`);
  // eslint-disable-next-line no-control-regex -- control characters are exactly what we reject
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new InvalidStorageKeyError(`${what} contains control characters`);
  }
}

export function assertOrganizationId(organizationId: string): void {
  if (typeof organizationId !== 'string' || !ORG_ID_RE.test(organizationId)) {
    throw new InvalidStorageKeyError('organization id must be a lower-case UUID');
  }
}

export function assertStoragePurpose(purpose: string): asserts purpose is StoragePurpose {
  if (!isStoragePurpose(purpose)) {
    throw new InvalidStorageKeyError('unknown storage purpose');
  }
}

export function assertObjectId(id: string): void {
  if (typeof id !== 'string') throw new InvalidStorageKeyError('object id must be a string');
  rejectUnsafeCharacters(id, 'object id');
  if (!OBJECT_ID_RE.test(id) || id.includes('..')) {
    throw new InvalidStorageKeyError(
      'object id must be 1-128 characters of [a-z0-9._-] (lower-case), start with a letter or digit, and not contain ".."',
    );
  }
}

/** Builds `org/{organizationId}/{purpose}/{id}` after validating every part. */
export function buildObjectKey(parts: ObjectKeyParts): ObjectKey {
  assertOrganizationId(parts.organizationId);
  assertStoragePurpose(parts.purpose);
  assertObjectId(parts.id);
  return `${ROOT_SEGMENT}/${parts.organizationId}/${parts.purpose}/${parts.id}` as ObjectKey;
}

/** Validates a raw key string and splits it. Throws `InvalidStorageKeyError`. */
export function parseObjectKey(key: string): ObjectKeyParts & { key: ObjectKey } {
  if (typeof key !== 'string' || key.length === 0) {
    throw new InvalidStorageKeyError('key must be a non-empty string');
  }
  if (key.length > MAX_KEY_LENGTH) throw new InvalidStorageKeyError('key is too long');
  rejectUnsafeCharacters(key, 'key');
  const segments = key.split('/');
  if (segments.length !== 4 || segments[0] !== ROOT_SEGMENT) {
    throw new InvalidStorageKeyError('key must have the form org/{organizationId}/{purpose}/{id}');
  }
  const [, organizationId = '', purpose = '', id = ''] = segments;
  assertOrganizationId(organizationId);
  assertStoragePurpose(purpose);
  assertObjectId(id);
  return { key: key as ObjectKey, organizationId, purpose, id };
}

/** `org/{organizationId}/` or, with a purpose, `org/{organizationId}/{purpose}/`. */
export function tenantPrefix(organizationId: string, purpose?: StoragePurpose): TenantPrefix {
  assertOrganizationId(organizationId);
  if (purpose === undefined) return `${ROOT_SEGMENT}/${organizationId}/` as TenantPrefix;
  assertStoragePurpose(purpose);
  return `${ROOT_SEGMENT}/${organizationId}/${purpose}/` as TenantPrefix;
}

/** Validates a raw listing prefix (must be exactly a tenant or tenant+purpose prefix). */
export function parseTenantPrefix(prefix: string): {
  prefix: TenantPrefix;
  organizationId: string;
  purpose: StoragePurpose | undefined;
} {
  if (typeof prefix !== 'string') throw new InvalidStorageKeyError('prefix must be a string');
  rejectUnsafeCharacters(prefix, 'prefix');
  const segments = prefix.split('/');
  // A valid prefix always ends with '/', so the last split element is ''.
  if (segments[0] !== ROOT_SEGMENT || segments.at(-1) !== '' || ![3, 4].includes(segments.length)) {
    throw new InvalidStorageKeyError(
      'prefix must be org/{organizationId}/ or org/{organizationId}/{purpose}/',
    );
  }
  const organizationId = segments[1] ?? '';
  assertOrganizationId(organizationId);
  let purpose: StoragePurpose | undefined;
  if (segments.length === 4) {
    const candidate = segments[2] ?? '';
    assertStoragePurpose(candidate);
    purpose = candidate;
  }
  return { prefix: prefix as TenantPrefix, organizationId, purpose };
}

/** Throws unless `key` is a valid key belonging to `organizationId`. */
export function assertKeyInTenant(key: string, organizationId: string): ObjectKey {
  assertOrganizationId(organizationId);
  const parsed = parseObjectKey(key);
  if (parsed.organizationId !== organizationId) {
    throw new InvalidStorageKeyError('key is outside the tenant prefix');
  }
  return parsed.key;
}
