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
/** Row-bound envelope (task 10, docs/AAA_SECRET_SEALING_V2_PROPOSAL.md). */
const ENVELOPE_VERSION_V2 = 'v2';

/**
 * What a v2 ciphertext is bound to. Every field is immutable for the row's lifetime, deliberately:
 * binding anything mutable means a legitimate edit silently makes the secret unopenable, and
 * `nas_clients.nas_ip` has already changed twice on this estate.
 *
 * `secretVersion` is the anti-rollback element. AAD over identity alone does not stop an old
 * ciphertext being written back into the same row, because the identity has not changed — the
 * monotonic version is what makes the replay fail.
 */
export interface SealBinding {
  readonly organizationId: string;
  readonly rowId: string;
  /** `'nas_clients.secret_ref'` or `'captive_portals.uam_secret_ref'`. */
  readonly column: string;
  readonly secretVersion: number;
}

function aad(purpose: string, b: SealBinding): Buffer {
  return Buffer.from(
    [ENVELOPE_VERSION_V2, purpose, b.organizationId, b.rowId, b.column, String(b.secretVersion)].join(
      '|',
    ),
    'utf8',
  );
}

export class Envelope {
  private readonly key: Buffer;

  private readonly purpose: string;

  constructor(keyMaterial: string, purpose: string) {
    this.purpose = purpose;
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

  /**
   * `v2.<iv>.<ciphertext>.<tag>`, authenticated against the row it belongs to. The AAD is NOT
   * stored: it is recomputed from the row at read time, so a ciphertext moved to another row,
   * another tenant, another column or an older version fails the tag check.
   */
  encryptBound(plaintext: string, binding: SealBinding): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(aad(this.purpose, binding));
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [ENVELOPE_VERSION_V2, iv, ciphertext, tag]
      .map((part) => (typeof part === 'string' ? part : part.toString('base64url')))
      .join('.');
  }

  decryptBound(sealed: string, binding: SealBinding): string {
    const [version, iv, ciphertext, tag] = sealed.split('.');
    if (version !== ENVELOPE_VERSION_V2 || !iv || ciphertext === undefined || !tag) {
      throw new Error('unsupported envelope format');
    }
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64url'));
    decipher.setAAD(aad(this.purpose, binding));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertext, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
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

/** HKDF purpose label of the envelope that seals `nas_clients.secret_ref` (data key). */
export const NAS_SECRET_PURPOSE = 'ecloud:nas:secret:v2'; // was :v1 / check-no-secrets: allow

/**
 * The pre-split label, and the ONLY key that can open a v1 ref.
 *
 * The purpose is the HKDF `info` parameter, so it selects the derived key: a ciphertext sealed
 * under 'ecloud:nas:secret:v1' is not openable by an envelope built with ':v2', AAD or no AAD.
 * The first version of this transition missed that — it ran the v1 branch on the v2 envelope, so
 * every pre-existing NAS and UAM ref became unopenable the moment the new label deployed. Found
 * on vps-local by the Orchestrator running the renderer in --check mode at 11:40Z, which reported
 * `DATA_ENCRYPTION_KEY opens none of the 1 sealed NAS secrets (wrong key?)` with an unchanged key.
 *
 * BOTH secrets share this one label, and that is not a mistake here — it IS finding S-1. The NAS
 * secret and the portal UAM secret were sealed under the same string, which is why a ciphertext
 * from one column opened in the other. So both v1 branches derive from it, and the re-seal is what
 * finally separates them.
 */
export const LEGACY_SECRET_PURPOSE = 'ecloud:nas:secret:v1'; // check-no-secrets: allow (label)

/** The `secret_ref` column name as it appears in the v2 AAD. */
export const NAS_SECRET_COLUMN = 'nas_clients.secret_ref';

/** What a NAS secret is bound to. `nasId` is the row id, so it must exist before the seal. */
export interface NasSecretBinding {
  readonly organizationId: string;
  readonly nasId: string;
  readonly secretVersion: number;
}

/**
 * Seal / open `nas_clients.secret_ref`. These exist rather than each of the five call sites
 * building a `SealBinding` by hand, because the two fields a caller would get wrong are the two
 * that are invisible in a diff: `column` (a typo seals a ciphertext that can never be opened) and
 * `allowV1` (forgetting it rejects every row the re-seal has not reached yet). Both are fixed
 * here, once.
 */
export function sealNasSecret(
  dataEncryptionKey: string,
  secret: string,
  binding: NasSecretBinding,
): string {
  return sealBoundSecretRef(
    new Envelope(dataEncryptionKey, NAS_SECRET_PURPOSE),
    secret,
    nasBinding(binding),
  );
}

/**
 * These take the KEY, not a pre-derived `Envelope`, and that is the fix for the outage above
 * rather than a tidying. Opening a ref needs a choice between TWO derived keys that only the ref
 * itself can decide, so a caller handing in one envelope cannot be right for both cases — and the
 * caller who hands in the current one looks completely correct while failing on every legacy row.
 */
export function openNasSecret(
  dataEncryptionKey: string,
  ref: string,
  binding: NasSecretBinding,
): string {
  if (!ref.startsWith(SECRET_REF_PREFIX)) throw new Error('unsupported secret_ref scheme');
  const body = ref.slice(SECRET_REF_PREFIX.length);
  if (body.startsWith(`${ENVELOPE_VERSION}.`)) {
    // Transitional, until the re-seal reports zero v1 rows. A v1 ref carries no AAD, so the
    // binding is unused here: that is the cost of the window, not an oversight.
    //
    // TWO labels are tried, because today produced three states rather than two. Part one
    // (750b6b2, live 11:05Z-11:40Z) moved NAS_SECRET_PURPOSE to ':v2' but had NOT yet converted
    // the NAS seal sites, so a NAS created or rotated in that window holds a v1-FORMAT ref sealed
    // under the ':v2' LABEL. Legacy first because it is the overwhelming majority — every row
    // sealed before today — then current for anything written in that window. Both are a plain
    // GCM authentication check, so a wrong guess costs one failed decrypt and reveals nothing.
    const legacy = new Envelope(dataEncryptionKey, LEGACY_SECRET_PURPOSE);
    try {
      return legacy.decrypt(body);
    } catch {
      return new Envelope(dataEncryptionKey, NAS_SECRET_PURPOSE).decrypt(body);
    }
  }
  return new Envelope(dataEncryptionKey, NAS_SECRET_PURPOSE).decryptBound(body, nasBinding(binding));
}

function nasBinding(b: NasSecretBinding): SealBinding {
  return {
    organizationId: b.organizationId,
    rowId: b.nasId,
    column: NAS_SECRET_COLUMN,
    secretVersion: b.secretVersion,
  };
}

export function sealSecretRef(envelope: Envelope, secret: string): string {
  return `${SECRET_REF_PREFIX}${envelope.encrypt(secret)}`;
}

export function openSecretRef(envelope: Envelope, ref: string): string {
  if (!ref.startsWith(SECRET_REF_PREFIX)) throw new Error('unsupported secret_ref scheme');
  return envelope.decrypt(ref.slice(SECRET_REF_PREFIX.length));
}

/**
 * Seal a DATABASE COLUMN's secret. Separate from `sealSecretRef` rather than an optional
 * parameter on it: the binding has no safe default, and an optional one is a parameter a caller
 * can forget — the same shape as the query that omitted a column and produced the portal defect
 * of 2026-10-14. The unbound pair stays for the two short-lived KV purposes, which are keyed by a
 * flow or request id and cannot be transplanted between rows.
 */
export function sealBoundSecretRef(
  envelope: Envelope,
  secret: string,
  binding: SealBinding,
): string {
  return `${SECRET_REF_PREFIX}${envelope.encryptBound(secret, binding)}`;
}

/**
 * Open a database column's secret.
 *
 * `allowV1` is the transitional branch of the re-seal: while the data migration is in flight the
 * database holds both formats, and a v1 ref has no AAD to check. It is passed only by the
 * DB-column call sites and only until the tightening migration lands. Sealing is v2 from the
 * moment this code deploys, so the set of v1 refs can only shrink.
 */
export function openBoundSecretRef(envelope: Envelope, ref: string, binding: SealBinding): string {
  if (!ref.startsWith(SECRET_REF_PREFIX)) throw new Error('unsupported secret_ref scheme');
  const body = ref.slice(SECRET_REF_PREFIX.length);
  if (body.startsWith(`${ENVELOPE_VERSION}.`)) {
    // v2-only by design. The `allowV1` flag this replaced took a boolean when the real question
    // was WHICH KEY to derive, and an envelope built for v2 cannot answer it. The v1 fallback
    // lives in openNasSecret / openUamSecret, which hold the key and can derive either label.
    throw new Error('v1 secret_ref must be opened through the column helper, not openBoundSecretRef');
  }
  return envelope.decryptBound(body, binding);
}
