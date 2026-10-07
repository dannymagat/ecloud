/**
 * Crypto primitives used by the API. Node's built-in `crypto` only.
 *  - opaque tokens: 32 random bytes, base64url; stored as SHA-256 hex (sessions, API keys,
 *    invitations, MFA challenges);
 *  - envelope: AES-256-GCM with a key derived (HKDF-SHA-256) from the configured key material
 *    and a purpose label, so the MFA key and the data key never encrypt each other's data;
 *  - voucher codes: HMAC-SHA-256 with the server pepper (DATABASE_DESIGN.md §3.6).
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from 'node:crypto';

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function hmacSha256Hex(key: string, value: string): string {
  return createHmac('sha256', key).update(value, 'utf8').digest('hex');
}

/** Constant-time string comparison (length leak only). */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) {
    // Compare against itself to keep timing independent of where the mismatch is.
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}

const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

export function randomAlnum(length: number): string {
  let out = '';
  for (let i = 0; i < length; i += 1) out += ALNUM[randomInt(ALNUM.length)];
  return out;
}

/** SECURITY_ARCHITECTURE.md §5.5: 32 symbols without 0/O/1/I. */
export const VOUCHER_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function randomVoucherCode(length: number): string {
  let out = '';
  for (let i = 0; i < length; i += 1) out += VOUCHER_ALPHABET[randomInt(VOUCHER_ALPHABET.length)];
  return out;
}

/** Codes are case-insensitive on entry; separators are ignored. */
export function normalizeVoucherCode(code: string): string {
  return code.replace(/[\s-]/g, '').toUpperCase();
}

const ENVELOPE_VERSION = 'v1';

export class Envelope {
  private readonly key: Buffer;

  constructor(keyMaterial: string, purpose: string) {
    this.key = Buffer.from(
      hkdfSync('sha256', Buffer.from(keyMaterial, 'utf8'), Buffer.alloc(0), purpose, 32),
    );
  }

  /** `v1.<iv>.<ciphertext>.<tag>` (base64url parts). */
  encrypt(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [ENVELOPE_VERSION, iv, ciphertext, tag]
      .map((part) => (typeof part === 'string' ? part : part.toString('base64url')))
      .join('.');
  }

  decrypt(sealed: string): string {
    const [version, iv, ciphertext, tag] = sealed.split('.');
    if (version !== ENVELOPE_VERSION || !iv || ciphertext === undefined || !tag) {
      throw new Error('unsupported envelope format');
    }
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertext, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  }
}

/**
 * `nas_clients.secret_ref` scheme (A5 decision for DATABASE_DESIGN.md §1 "Secrets"): the RADIUS
 * secret sealed with the data key, prefixed so a future secret-store reference (`vault:…`,
 * `file:…`) can coexist: `enc:v1.<iv>.<ct>.<tag>`.
 */
export const SECRET_REF_PREFIX = 'enc:';

export function sealSecretRef(envelope: Envelope, secret: string): string {
  return `${SECRET_REF_PREFIX}${envelope.encrypt(secret)}`;
}

export function openSecretRef(envelope: Envelope, ref: string): string {
  if (!ref.startsWith(SECRET_REF_PREFIX)) throw new Error('unsupported secret_ref scheme');
  return envelope.decrypt(ref.slice(SECRET_REF_PREFIX.length));
}
