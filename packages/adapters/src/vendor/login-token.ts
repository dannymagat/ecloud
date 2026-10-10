/**
 * ECLOUD-issued post-back login token (Cycle A, D-044; docs/VENDOR_INTEGRATION_RESEARCH.md §3
 * "contract gaps": `isReplay` key requires `challenge`).
 *
 * UAM redirects carry a NAS challenge that makes every hand-off single-use. Post-back vendors
 * (F3 Cisco/Aruba/Fortinet/Ruckus/Cambium/Omada, F4 Meraki, F7 Mist) send no challenge and an
 * unsigned redirect. ECLOUD therefore issues its own anti-forgery token when it accepts the
 * redirect and requires it back exactly once before it hands out a broker credential:
 *
 *   token = "lt1." + base64url(JSON payload) + "." + base64url(HMAC-SHA256(key, "lt1." + payload))
 *   payload = { o: org, s: site, n: nas, m: client MAC, f: flow id, j: token id, iat, exp }
 *
 *  - key: HKDF-SHA256(server secret, info = {@link LOGIN_TOKEN_PURPOSE}); a dedicated derived
 *    key, so the token MAC can never be confused with an Envelope key or a portal state MAC.
 *  - bound to {organization, site, NAS, client MAC, flow}; every field must match the
 *    server-side expectation (a token of tenant A is useless for tenant B: `binding_mismatch`).
 *  - short TTL (default {@link LOGIN_TOKEN_DEFAULT_TTL_S}, at most {@link LOGIN_TOKEN_MAX_TTL_S}).
 *  - single use: the token id is claimed in an injected store (Redis `SET NX EX` in the API)
 *    only after signature, binding and expiry checks pass; a second presentation is `replayed`.
 *  - constant-time MAC comparison; malformed input never throws, it fails closed.
 *
 * Pure apart from the injected store; no network, no logging. The token is not a secret
 * credential (it authorises nothing by itself) but it is never logged by callers either.
 */
import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { canonicalMacStrict } from '@ecloud/shared';

/** HKDF info label of the login-token key (not a secret). */
export const LOGIN_TOKEN_PURPOSE = 'ecloud:portal:login-token:v1'; // check-no-secrets: allow
export const LOGIN_TOKEN_PREFIX = 'lt1';
export const LOGIN_TOKEN_DEFAULT_TTL_S = 120;
export const LOGIN_TOKEN_MAX_TTL_S = 300;
/** Accepted clock skew between issuer and verifier (multi-replica API). */
export const LOGIN_TOKEN_CLOCK_SKEW_S = 5;
/** The single-use marker outlives the token so a late replay is still recognised. */
export const LOGIN_TOKEN_USED_GRACE_S = 60;

const MAX_TOKEN_LENGTH = 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TOKEN_ID_RE = /^[A-Za-z0-9_-]{22}$/;
const B64URL_RE = /^[A-Za-z0-9_-]+$/;

export interface LoginTokenBinding {
  readonly organizationId: string;
  readonly siteId: string;
  readonly nasId: string;
  /** Any MAC spelling; compared in canonical `aa:bb:cc:dd:ee:ff` form. */
  readonly clientMac: string;
  readonly flowId: string;
}

/** Single-use marker store (Redis `SET key 1 NX EX ttl` in production). */
export interface SingleUseStore {
  /** True when `key` was not present and is now claimed; false when it already existed. */
  claim(key: string, ttlSeconds: number): Promise<boolean>;
}

export type LoginTokenFailure =
  'malformed' | 'bad_signature' | 'binding_mismatch' | 'expired' | 'not_yet_valid' | 'replayed';

export type LoginTokenResult =
  | { readonly ok: true; readonly tokenId: string; readonly expiresAt: Date }
  | { readonly ok: false; readonly reason: LoginTokenFailure };

export interface IssuedLoginToken {
  readonly token: string;
  readonly tokenId: string;
  readonly expiresAt: Date;
}

interface Payload {
  readonly o: string;
  readonly s: string;
  readonly n: string;
  readonly m: string;
  readonly f: string;
  readonly j: string;
  readonly iat: number;
  readonly exp: number;
}

const PAYLOAD_KEYS = ['o', 's', 'n', 'm', 'f', 'j', 'iat', 'exp'] as const;

/** Opaque derived key (keeps raw key material out of call sites). */
export class LoginTokenKey {
  readonly #key: Buffer;

  constructor(keyMaterial: string) {
    if (typeof keyMaterial !== 'string' || keyMaterial.length < 16) {
      throw new Error('login token key material must be at least 16 characters');
    }
    this.#key = Buffer.from(
      hkdfSync(
        'sha256',
        Buffer.from(keyMaterial, 'utf8'),
        Buffer.alloc(0),
        LOGIN_TOKEN_PURPOSE,
        32,
      ),
    );
  }

  mac(data: string): Buffer {
    return createHmac('sha256', this.#key).update(data, 'utf8').digest();
  }
}

function canonicalBinding(binding: LoginTokenBinding): LoginTokenBinding | null {
  const mac = canonicalMacStrict(binding.clientMac);
  const ids = [binding.organizationId, binding.siteId, binding.nasId, binding.flowId];
  if (mac === null || !ids.every((id) => typeof id === 'string' && UUID_RE.test(id))) return null;
  return { ...binding, clientMac: mac };
}

/** Issues a token for `binding`, valid for `ttlS` seconds from `now`. */
export function issueLoginToken(
  key: LoginTokenKey,
  binding: LoginTokenBinding,
  options: { readonly now: Date; readonly ttlS?: number },
): IssuedLoginToken {
  const b = canonicalBinding(binding);
  if (b === null) throw new Error('login token binding needs UUID ids and a MAC address');
  const ttl = options.ttlS ?? LOGIN_TOKEN_DEFAULT_TTL_S;
  if (!Number.isInteger(ttl) || ttl < 1 || ttl > LOGIN_TOKEN_MAX_TTL_S) {
    throw new Error(`login token TTL must be 1..${String(LOGIN_TOKEN_MAX_TTL_S)} s`);
  }
  const iat = Math.floor(options.now.getTime() / 1000);
  const tokenId = randomBytes(16).toString('base64url');
  const payload: Payload = {
    o: b.organizationId,
    s: b.siteId,
    n: b.nasId,
    m: b.clientMac,
    f: b.flowId,
    j: tokenId,
    iat,
    exp: iat + ttl,
  };
  const body = `${LOGIN_TOKEN_PREFIX}.${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')}`;
  return {
    token: `${body}.${key.mac(body).toString('base64url')}`,
    tokenId,
    expiresAt: new Date(payload.exp * 1000),
  };
}

function parsePayload(encoded: string): Payload | null {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== PAYLOAD_KEYS.length || !PAYLOAD_KEYS.every((k) => keys.includes(k))) {
    return null;
  }
  const { o, s, n, m, f, j, iat, exp } = record;
  if (
    typeof o !== 'string' ||
    typeof s !== 'string' ||
    typeof n !== 'string' ||
    typeof m !== 'string' ||
    typeof f !== 'string' ||
    typeof j !== 'string' ||
    !TOKEN_ID_RE.test(j) ||
    !Number.isSafeInteger(iat) ||
    !Number.isSafeInteger(exp)
  ) {
    return null;
  }
  return { o, s, n, m, f, j, iat: iat as number, exp: exp as number };
}

/**
 * Signature, structure, binding and time checks (no single-use claim). Exposed for callers
 * that must check a token before deciding to consume it; use {@link consumeLoginToken} to
 * accept one.
 */
export function checkLoginToken(
  key: LoginTokenKey,
  token: unknown,
  expected: LoginTokenBinding,
  now: Date,
): LoginTokenResult {
  if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN_LENGTH) {
    return { ok: false, reason: 'malformed' };
  }
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed' };
  const [prefix, encoded, sig] = parts as [string, string, string];
  if (prefix !== LOGIN_TOKEN_PREFIX || !B64URL_RE.test(encoded) || !B64URL_RE.test(sig)) {
    return { ok: false, reason: 'malformed' };
  }
  const expectedMac = key.mac(`${prefix}.${encoded}`);
  const presentedMac = Buffer.from(sig, 'base64url');
  // Length check first (timingSafeEqual needs equal lengths); the length is public anyway.
  if (presentedMac.length !== expectedMac.length || !timingSafeEqual(presentedMac, expectedMac)) {
    return { ok: false, reason: 'bad_signature' };
  }
  const payload = parsePayload(encoded);
  if (payload === null) return { ok: false, reason: 'malformed' };
  const want = canonicalBinding(expected);
  if (
    want === null ||
    payload.o !== want.organizationId ||
    payload.s !== want.siteId ||
    payload.n !== want.nasId ||
    payload.m !== want.clientMac ||
    payload.f !== want.flowId
  ) {
    return { ok: false, reason: 'binding_mismatch' };
  }
  const nowS = now.getTime() / 1000;
  if (payload.exp - payload.iat > LOGIN_TOKEN_MAX_TTL_S || payload.exp <= payload.iat) {
    return { ok: false, reason: 'malformed' };
  }
  if (payload.iat > nowS + LOGIN_TOKEN_CLOCK_SKEW_S) return { ok: false, reason: 'not_yet_valid' };
  if (payload.exp <= nowS) return { ok: false, reason: 'expired' };
  return { ok: true, tokenId: payload.j, expiresAt: new Date(payload.exp * 1000) };
}

/** Store key of the single-use marker (namespaced; the token id is random, not secret). */
export function loginTokenUsedKey(tokenId: string): string {
  return `pf:lt-used:${tokenId}`;
}

/**
 * Accepts a token exactly once: {@link checkLoginToken}, then claims its id in `store`. A
 * second presentation (any replica) fails with `replayed`. A store error propagates (callers
 * answer 503; never fail open).
 */
export async function consumeLoginToken(
  key: LoginTokenKey,
  token: unknown,
  expected: LoginTokenBinding,
  store: SingleUseStore,
  now: Date,
): Promise<LoginTokenResult> {
  const checked = checkLoginToken(key, token, expected, now);
  if (!checked.ok) return checked;
  const remaining = Math.ceil((checked.expiresAt.getTime() - now.getTime()) / 1000);
  const claimed = await store.claim(
    loginTokenUsedKey(checked.tokenId),
    Math.max(1, remaining) + LOGIN_TOKEN_USED_GRACE_S,
  );
  return claimed ? checked : { ok: false, reason: 'replayed' };
}
