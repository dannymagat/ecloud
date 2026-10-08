/**
 * Signed short-lived portal state (SECURITY_ARCHITECTURE.md §5, API_ARCHITECTURE portal CSRF
 * note). The flow id travels in the URL as an HMAC-signed token `<flowId>.<exp>.<sig>` so the
 * mini-browser (CNA) does not depend on cookies to carry state (ADMIN_UI_ARCHITECTURE.md §4); a
 * random per-browser cookie nonce only backs the double-submit CSRF token
 * `HMAC(flowId | nonce)` that every POST must echo. All comparisons are constant time.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NONCE_RE = /^[A-Za-z0-9_-]{22}$/;

/** Cookie lifetime = flow lifetime (15 min). */
export const COOKIE_MAX_AGE_S = 15 * 60;

function mac(secret: string, ...parts: string[]): string {
  return createHmac('sha256', secret).update(parts.join('|'), 'utf8').digest('base64url');
}

function equal(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

/** `<flowId>.<exp seconds>.<sig>`, valid until `expiresAt`. */
export function signFlowToken(secret: string, flowId: string, expiresAt: Date): string {
  const exp = String(Math.floor(expiresAt.getTime() / 1000));
  return `${flowId}.${exp}.${mac(secret, 'flow', flowId, exp)}`;
}

/** The flow id of a valid, unexpired token, else null. */
export function verifyFlowToken(secret: string, token: string, now: Date): string | null {
  const [flowId, exp, sig, extra] = token.split('.');
  if (extra !== undefined || flowId === undefined || exp === undefined || sig === undefined) {
    return null;
  }
  if (!UUID_RE.test(flowId) || !/^\d{1,12}$/.test(exp)) return null;
  if (!equal(sig, mac(secret, 'flow', flowId, exp))) return null;
  if (Number(exp) * 1000 <= now.getTime()) return null;
  return flowId;
}

export function newNonce(): string {
  return randomBytes(16).toString('base64url');
}

export function isNonce(value: string | undefined): value is string {
  return value !== undefined && NONCE_RE.test(value);
}

export function csrfToken(secret: string, flowId: string, nonce: string): string {
  return mac(secret, 'csrf', flowId, nonce);
}

export function verifyCsrf(
  secret: string,
  flowId: string,
  nonce: string | undefined,
  presented: unknown,
): boolean {
  if (!isNonce(nonce) || typeof presented !== 'string') return false;
  return equal(presented, csrfToken(secret, flowId, nonce));
}

/** `__Host-pf` needs HTTPS (Secure, Path=/, no Domain); plain HTTP dev uses `pf`. */
export function cookieName(secure: boolean): string {
  return secure ? '__Host-pf' : 'pf';
}

export function serializeCookie(name: string, value: string, secure: boolean): string {
  return [
    `${name}=${value}`,
    'Path=/',
    `Max-Age=${String(COOKIE_MAX_AGE_S)}`,
    'HttpOnly',
    'SameSite=Lax',
    ...(secure ? ['Secure'] : []),
  ].join('; ');
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (header === undefined) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}
