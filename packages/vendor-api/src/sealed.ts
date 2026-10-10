/**
 * Opens `vendor_api_credentials.secret_ref` in-process (Cycle A sealed store, migration 028).
 *
 * Format and key derivation are byte-compatible with `apps/api/src/crypto.ts`
 * (`sealSecretRef(new Envelope(DATA_ENCRYPTION_KEY, 'ecloud:vendor-api:secret:v1'), …)`):
 * `enc:v1.<iv>.<ciphertext>.<tag>` (base64url), AES-256-GCM, key = HKDF-SHA-256(key material,
 * salt = empty, info = purpose, 32 bytes). Duplicated here (not imported from the API app) so
 * the worker can open the same secret without depending on `@ecloud/api`; a cross-check test in
 * apps/api proves both implementations agree.
 *
 * The opened value lives only in the calling process's memory for the duration of one
 * operation: it is never logged, returned by an API, written to Redis, or put in a job payload.
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

/** HKDF purpose label (Cycle A). A label, not a secret. */
export const VENDOR_API_SECRET_PURPOSE = 'ecloud:vendor-api:secret:v1'; // check-no-secrets: allow

const PREFIX = 'enc:';
const VERSION = 'v1';

function deriveKey(keyMaterial: string, purpose: string): Buffer {
  return Buffer.from(
    hkdfSync('sha256', Buffer.from(keyMaterial, 'utf8'), Buffer.alloc(0), purpose, 32),
  );
}

export class SealedSecretError extends Error {
  constructor() {
    super('sealed secret cannot be opened');
    this.name = 'SealedSecretError';
  }
}

/**
 * Pre-derived purpose key (review F4): `vapi1.<base64url(32 bytes)>` =
 * HKDF-SHA-256(DATA_ENCRYPTION_KEY, salt = empty, info = 'ecloud:vendor-api:secret:v1').
 * The worker receives ONLY this value (`VENDOR_API_SECRET_KEY`), never the master key: it can
 * open vendor-API secrets and nothing else (NAS / UAM secrets use other purposes).
 */
export const DERIVED_KEY_PREFIX = 'vapi1.';
export const DERIVED_KEY_RE = /^vapi1\.[A-Za-z0-9_-]{43}$/;

export function isDerivedVendorApiKey(value: string): boolean {
  return DERIVED_KEY_RE.test(value);
}

/** Derives the worker's vendor-API key from the master data key (deploy-time tooling). */
export function deriveVendorApiKey(masterKeyMaterial: string): string {
  return `${DERIVED_KEY_PREFIX}${deriveKey(masterKeyMaterial, VENDOR_API_SECRET_PURPOSE).toString('base64url')}`;
}

/** Key material for opening: the master data key (API) or the pre-derived key (worker). */
export type VendorSecretKey =
  | { readonly kind: 'master'; readonly value: string }
  | { readonly kind: 'derived'; readonly value: string };

function keyBytes(key: VendorSecretKey, purpose: string): Buffer {
  if (key.kind === 'master') return deriveKey(key.value, purpose);
  if (purpose !== VENDOR_API_SECRET_PURPOSE || !isDerivedVendorApiKey(key.value)) {
    throw new SealedSecretError();
  }
  return Buffer.from(key.value.slice(DERIVED_KEY_PREFIX.length), 'base64url');
}

/** Opens an `enc:v1.…` reference; throws {@link SealedSecretError} (no detail) otherwise. */
export function openSealedSecret(
  keyMaterial: string | VendorSecretKey,
  ref: string,
  purpose: string = VENDOR_API_SECRET_PURPOSE,
): string {
  const key: VendorSecretKey =
    typeof keyMaterial === 'string' ? { kind: 'master', value: keyMaterial } : keyMaterial;
  if (!ref.startsWith(PREFIX)) throw new SealedSecretError();
  const [version, iv, ciphertext, tag] = ref.slice(PREFIX.length).split('.');
  if (version !== VERSION || !iv || ciphertext === undefined || !tag) {
    throw new SealedSecretError();
  }
  try {
    const decipher = createDecipheriv(
      'aes-256-gcm',
      keyBytes(key, purpose),
      Buffer.from(iv, 'base64url'),
    );
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertext, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw new SealedSecretError();
  }
}

/** Seals a value in the same format (tests and tooling; the API seals with its own Envelope). */
export function sealSecret(
  keyMaterial: string,
  plaintext: string,
  purpose: string = VENDOR_API_SECRET_PURPOSE,
): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(keyMaterial, purpose), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return `${PREFIX}${[VERSION, iv.toString('base64url'), ciphertext.toString('base64url'), cipher.getAuthTag().toString('base64url')].join('.')}`;
}
