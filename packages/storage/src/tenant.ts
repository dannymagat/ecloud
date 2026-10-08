import { assertKeyInTenant, assertOrganizationId, buildObjectKey, tenantPrefix } from './keys.js';
import type { StoragePurpose } from './purposes.js';
import type {
  ListObjectsOptions,
  ObjectBody,
  ObjectMetadata,
  ObjectStorage,
  ObjectSummary,
  PutObjectOptions,
  SignedUrlOptions,
  StoredObject,
} from './types.js';

/**
 * `ObjectStorage` bound to one organization: callers name objects by `(purpose, id)` and can
 * never address another tenant's prefix. Preferred entry point for request handlers, which
 * pass the organization id from the authenticated tenant context.
 */
export interface TenantObjectStorage {
  readonly organizationId: string;
  put(
    purpose: StoragePurpose,
    id: string,
    body: ObjectBody,
    options: PutObjectOptions,
  ): Promise<ObjectMetadata>;
  get(purpose: StoragePurpose, id: string): Promise<StoredObject>;
  head(purpose: StoragePurpose, id: string): Promise<ObjectMetadata | null>;
  delete(purpose: StoragePurpose, id: string): Promise<void>;
  list(purpose?: StoragePurpose, options?: ListObjectsOptions): Promise<ObjectSummary[]>;
  getSignedReadUrl(
    purpose: StoragePurpose,
    id: string,
    options?: SignedUrlOptions,
  ): Promise<string>;
  /** Throws `InvalidStorageKeyError` unless a raw key (e.g. from a DB row) belongs to this tenant. */
  assertOwnKey(key: string): void;
}

export function forTenant(storage: ObjectStorage, organizationId: string): TenantObjectStorage {
  assertOrganizationId(organizationId);
  const key = (purpose: StoragePurpose, id: string) =>
    buildObjectKey({ organizationId, purpose, id });
  return {
    organizationId,
    // async so that key validation failures surface as rejected promises, like the drivers.
    put: async (purpose, id, body, options) => storage.put(key(purpose, id), body, options),
    get: async (purpose, id) => storage.get(key(purpose, id)),
    head: async (purpose, id) => storage.head(key(purpose, id)),
    delete: async (purpose, id) => storage.delete(key(purpose, id)),
    list: async (purpose, options) => storage.list(tenantPrefix(organizationId, purpose), options),
    getSignedReadUrl: async (purpose, id, options) =>
      storage.getSignedReadUrl(key(purpose, id), options),
    assertOwnKey: (raw) => {
      assertKeyInTenant(raw, organizationId);
    },
  };
}
