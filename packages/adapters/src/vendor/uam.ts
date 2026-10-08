/**
 * ChilliSpot-style UAM helpers shared by the uspot and CoovaChilli vendor adapters. Parameter
 * lists: CAPTIVE_PORTAL_ARCHITECTURE.md §3.2 (uspot T/U), §4 (CoovaChilli); signature: §7.3;
 * password encoding: §3.3 / §7.4; hostile `userurl`: SECURITY_ARCHITECTURE.md §5.3.
 * Pure: no network, no I/O.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import type { ParsedRedirect } from './types.js';

const MD_SUFFIX = '&md=';
const MD_VALUE = /^[0-9a-fA-F]{32}$/;

export interface UamQuery {
  /** First value of each parameter, decoded for display / lookup. */
  readonly params: Readonly<Record<string, string>>;
  /** Parameter names that occurred more than once (tampering indicator). */
  readonly duplicates: readonly string[];
  /** `md` value when present as the LAST parameter. */
  readonly md: string | null;
  /** Query substring covered by `md` (everything before `&md=`). */
  readonly signedQuery: string;
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, ' '));
  } catch {
    // uspot T sends `userurl` un-encoded (CP §3.2): keep the raw bytes as the display copy.
    return value;
  }
}

/**
 * Splits a raw UAM query. `md` is taken first, as the last parameter (SECURITY §5.3); then a
 * `userurl` that is the final remaining parameter keeps everything after `userurl=` (uspot T
 * leaves it un-encoded, so it may contain `&` and `=`). Everything else splits on `&`.
 */
export function splitUamQuery(rawQuery: string): UamQuery {
  let rest = rawQuery;
  let md: string | null = null;
  const mdAt = rawQuery.lastIndexOf(MD_SUFFIX);
  if (mdAt >= 0 && MD_VALUE.test(rawQuery.slice(mdAt + MD_SUFFIX.length))) {
    md = rawQuery.slice(mdAt + MD_SUFFIX.length);
    rest = rawQuery.slice(0, mdAt);
  }
  const signedQuery = rest;
  let userurl: string | null = null;
  const uAt = rest.startsWith('userurl=') ? 0 : rest.indexOf('&userurl=');
  if (uAt >= 0) {
    userurl = rest.slice(uAt + (uAt === 0 ? 'userurl='.length : '&userurl='.length));
    rest = rest.slice(0, uAt);
  }
  const params: Record<string, string> = {};
  const duplicates = new Set<string>();
  const add = (name: string, value: string): void => {
    if (Object.prototype.hasOwnProperty.call(params, name)) duplicates.add(name);
    else params[name] = value;
  };
  for (const part of rest.split('&')) {
    if (part === '') continue;
    const eq = part.indexOf('=');
    const name = decode(eq < 0 ? part : part.slice(0, eq));
    add(name, eq < 0 ? '' : decode(part.slice(eq + 1)));
  }
  if (userurl !== null) add('userurl', decode(userurl));
  if (md === null && Object.prototype.hasOwnProperty.call(params, 'md')) duplicates.add('md');
  return { params, duplicates: [...duplicates], md, signedQuery };
}

/** Maps the device `res` value onto the contract's result vocabulary. */
export function uamResult(res: string | undefined): ParsedRedirect['result'] {
  switch (res) {
    case undefined:
      return null;
    case 'notyet':
    case 'already':
    case 'success':
    case 'failed':
    case 'logoff':
      return res;
    case 'reject':
      return 'failed';
    default:
      return 'other';
  }
}

/**
 * UAM `md` (CP §7.3): MD5 over the URL the device built — `uam-server + '?' + query` up to
 * (excluding) `&md=` — concatenated with the UAM secret; hex, uppercase as CoovaChilli emits it.
 */
export function computeUamSignature(signedUrl: string, uamSecret: string): string {
  return createHash('md5')
    .update(signedUrl + uamSecret, 'utf8')
    .digest('hex')
    .toUpperCase();
}

/** Constant-time, case-insensitive comparison of `md` (CP §7.3). */
export function verifyUamSignature(
  parsed: Pick<ParsedRedirect, 'rawQuery'>,
  uamServerUrl: string,
  uamSecret: string,
): boolean {
  // Derived from the raw query itself, never from a caller-supplied `signature` field.
  const { md, signedQuery } = splitUamQuery(parsed.rawQuery);
  if (md === null) return false;
  const expected = Buffer.from(computeUamSignature(`${uamServerUrl}?${signedQuery}`, uamSecret));
  const actual = Buffer.from(md.toUpperCase());
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/**
 * PAP password encoding for `/logon` (CP §3.3, §7.4; hotspotlogin.cgi): the password, NUL-padded
 * to 16 bytes, XORed with MD5(challenge bytes + UAM secret); lowercase hex. The broker keeps the
 * password ≤ 16 bytes so the same encoding works on uspot T, uspot U and CoovaChilli.
 */
export function encodeUamPapPassword(
  password: string,
  challengeHex: string,
  uamSecret: string,
): string {
  const pw = Buffer.from(password, 'utf8');
  if (pw.length === 0 || pw.length > 16) throw new Error('UAM PAP password must be 1–16 bytes');
  if (!/^(?:[0-9a-fA-F]{2})+$/.test(challengeHex)) throw new Error('challenge is not hex');
  const key = createHash('md5')
    .update(Buffer.concat([Buffer.from(challengeHex, 'hex'), Buffer.from(uamSecret, 'utf8')]))
    .digest();
  const padded = Buffer.alloc(16);
  pw.copy(padded);
  const out = Buffer.alloc(16);
  for (let i = 0; i < 16; i += 1) out[i] = (padded[i] ?? 0) ^ (key[i] ?? 0);
  return out.toString('hex');
}

function ipv4Octets(value: string): [number, number, number, number] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value);
  if (!m) return null;
  const o = [m[1], m[2], m[3], m[4]].map(Number);
  if (o.some((n) => n > 255)) return null;
  return [o[0] ?? 0, o[1] ?? 0, o[2] ?? 0, o[3] ?? 0];
}

/** RFC 1918 or RFC 6598 IPv4 (the address classes a UAM `uamip` may use, CP §7.3). */
export function isPrivateIpv4(value: string): boolean {
  const o = ipv4Octets(value);
  if (!o) return false;
  const [a, b] = o;
  return (
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

export function isUamPort(value: string | undefined): boolean {
  if (value === undefined || !/^\d{1,5}$/.test(value)) return false;
  const n = Number(value);
  return n >= 1 && n <= 65535;
}

const USERURL_MAX = 2048;

/**
 * SECURITY_ARCHITECTURE.md §5.3: accept only `http(s)://`, no credentials, ≤ 2 KB, host not the
 * `uamip` and not a private/loopback/link-local address; otherwise null (caller substitutes the
 * tenant landing page).
 */
export function safeUserUrl(raw: string | undefined, uamip: string | null): string | null {
  if (raw === undefined || raw.length === 0 || raw.length > USERURL_MAX) return null;
  // WHATWG URL treats `\` as `/` in http(s) URLs, so `http:\\evil.example` or `http://evil\@x`
  // would be silently normalised into a different URL than the one the client sent. A well-formed
  // return URL never contains a backslash, so refuse it outright (L4 SIM-07, SECURITY §5.3).
  if (raw.includes('\\')) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username !== '' || url.password !== '') return null;
  const host = url.hostname
    .replace(/^\[|\]$/g, '')
    .toLowerCase()
    .replace(/\.+$/, '');
  if (host === '' || host === 'localhost' || host.endsWith('.localhost')) return null;
  if (uamip !== null && host === uamip) return null;
  // IPv6 literals starting with `::` (unspecified, loopback, IPv4-compatible, IPv4-mapped such as
  // [::ffff:10.0.0.1], which WHATWG URL normalises to [::ffff:a00:1]) could smuggle a private host.
  if (host.startsWith('::')) return null;
  if (isPrivateIpv4(host)) return null;
  const o = ipv4Octets(host);
  if (o && (o[0] === 127 || o[0] === 0 || (o[0] === 169 && o[1] === 254))) return null;
  if (host.includes(':')) {
    // IPv6 literal: reject loopback, link-local, unique-local.
    if (host === '::1' || host.startsWith('fe80') || /^f[cd]/.test(host)) return null;
  }
  return url.toString();
}
