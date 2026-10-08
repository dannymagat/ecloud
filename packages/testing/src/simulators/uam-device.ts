/**
 * Simulated UAM NAS (MULTI_VENDOR_INTEGRATION_PLAN.md §8.3). Builds the redirect a uspot or
 * CoovaChilli device sends to the portal and decodes the `/logon` hand-off the way the device
 * would. Written independently of `@ecloud/adapters` (no import from it) so the simulator checks
 * ECLOUD's code against a second implementation of the documented formulas:
 *
 * - parameter lists and order: CAPTIVE_PORTAL_ARCHITECTURE.md §3.2 (uspot T/U), §4 (CoovaChilli,
 *   `redir.c bstring_buildurl`), PHASE2_VALIDATION.md V-070;
 * - `md` = uppercase hex MD5(uam-server + '?' + query-before-`&md=` + uamsecret), appended last
 *   (CP §3.2, §7.3; V-070 `redir_md_param`);
 * - PAP: hex(password XOR MD5(challenge bytes + uamsecret)); uspot T loops over 32-hex chunks,
 *   uspot U XORs MIN(len,16) bytes (CP §3.3); CHAP: MD5(0x00 + password + MD5(challenge bytes +
 *   uamsecret)) (CP §3.3; coova `doc/hotspotlogin.cgi` L74-120, V-071).
 *
 * This is NOT a capture of a real device: it proves ECLOUD code behaviour only, never hardware
 * compatibility (plan §4.1 `SIMULATOR_TESTED`).
 */
import { createHash } from 'node:crypto';

/** UAM flavours the simulator emits. `uspot-tip` = TIP fork on EZEAP (T), `uspot-upstream` = U. */
export type UamFlavour = 'uspot-tip' | 'uspot-upstream' | 'coovachilli';

/** Obvious test value; never a real secret (plan §8.3 AC3). */
export const SIM_UAM_SECRET = 'uam-test-secret-fake';

export interface UamRedirectInput {
  /** Configured `uam-server` / `uamserver` (no query string). */
  readonly uamServer: string;
  /** null = device has no UAM secret (no `md` appended). */
  readonly uamSecret: string | null;
  readonly res: string;
  readonly uamip: string;
  readonly uamport: string;
  /** 32 hex characters. */
  readonly challenge: string;
  /** `AA-BB-CC-DD-EE-FF` as both devices format it. */
  readonly mac: string;
  readonly ip: string;
  readonly called: string;
  readonly nasid: string;
  readonly ssid?: string;
  readonly sessionid: string;
  readonly userurl?: string;
}

export interface UamRedirect {
  /** Full URL the browser is redirected to. */
  readonly url: string;
  /** Query string exactly as the device built it (incl. `&md=`). */
  readonly query: string;
  /** Query covered by `md` (everything before `&md=`). */
  readonly signedQuery: string;
  readonly md: string | null;
}

/** Percent-encoding the simulator uses for encoded values (RFC 3986 unreserved kept). */
export function uamEncode(value: string): string {
  return encodeURIComponent(value);
}

/** Reference `md`: uppercase hex MD5(`<uamServer>?<signedQuery>` + secret). */
export function referenceUamMd(uamServer: string, signedQuery: string, secret: string): string {
  const h = createHash('md5');
  h.update(Buffer.from(uamServer, 'utf8'));
  h.update(Buffer.from('?', 'utf8'));
  h.update(Buffer.from(signedQuery, 'utf8'));
  h.update(Buffer.from(secret, 'utf8'));
  return h.digest('hex').toUpperCase();
}

/** Ordered parameters per flavour (CP §3.2 table order for uspot, `redir.c` order for coova). */
function orderedParams(input: UamRedirectInput, flavour: UamFlavour): [string, string][] {
  const p: [string, string][] = [
    ['res', input.res],
    ['uamip', input.uamip],
    ['uamport', input.uamport],
    ['challenge', input.challenge],
  ];
  if (flavour === 'coovachilli') {
    p.push(['called', input.called], ['mac', input.mac], ['ip', input.ip]);
    if (input.ssid !== undefined) p.push(['ssid', input.ssid]);
    p.push(['nasid', input.nasid], ['sessionid', input.sessionid]);
  } else {
    p.push(['mac', input.mac], ['ip', input.ip], ['called', input.called], ['nasid', input.nasid]);
    // `ssid` is emitted by T only (CP §3.2).
    if (flavour === 'uspot-tip' && input.ssid !== undefined) p.push(['ssid', input.ssid]);
    p.push(['sessionid', input.sessionid]);
  }
  return p;
}

/**
 * Builds the redirect. uspot T appends `userurl` raw (not url-encoded, CP §3.2); uspot U and
 * CoovaChilli percent-encode it. `md` is appended last when the device has a UAM secret.
 */
export function buildUamRedirect(input: UamRedirectInput, flavour: UamFlavour): UamRedirect {
  const parts = orderedParams(input, flavour).map(([k, v]) => `${k}=${uamEncode(v)}`);
  if (input.userurl !== undefined) {
    parts.push(`userurl=${flavour === 'uspot-tip' ? input.userurl : uamEncode(input.userurl)}`);
  }
  const signedQuery = parts.join('&');
  const md =
    input.uamSecret === null ? null : referenceUamMd(input.uamServer, signedQuery, input.uamSecret);
  const query = md === null ? signedQuery : `${signedQuery}&md=${md}`;
  return { url: `${input.uamServer}?${query}`, query, signedQuery, md };
}

/** Re-signs an arbitrary (possibly tampered) signed query, as a device holding `secret` would. */
export function signUamQuery(uamServer: string, signedQuery: string, secret: string): string {
  return `${signedQuery}&md=${referenceUamMd(uamServer, signedQuery, secret)}`;
}

function papKey(challengeHex: string, secret: string): Buffer {
  return createHash('md5')
    .update(Buffer.from(challengeHex, 'hex'))
    .update(Buffer.from(secret, 'utf8'))
    .digest();
}

/** Reference PAP encoding (≤ 16 bytes, NUL padded): what a UAM page sends as `password`. */
export function referencePapEncode(password: string, challengeHex: string, secret: string): string {
  const key = papKey(challengeHex, secret);
  const pw = Buffer.alloc(16);
  Buffer.from(password, 'utf8').copy(pw);
  return Buffer.from(pw.map((b, i) => b ^ (key[i] ?? 0))).toString('hex');
}

/** Device-side PAP decode, uspot T (`handler-uam.uc`): every 32-hex chunk XORed with the key. */
export function deviceDecodePapTip(
  passwordHex: string,
  challengeHex: string,
  secret: string,
): string {
  const key = papKey(challengeHex, secret);
  const out: number[] = [];
  for (let off = 0; off < passwordHex.length; off += 32) {
    const chunk = Buffer.from(passwordHex.slice(off, off + 32), 'hex');
    chunk.forEach((b, i) => out.push(b ^ (key[i] ?? 0)));
  }
  return Buffer.from(out).toString('utf8').replace(/\0+$/, '');
}

/** Device-side PAP decode, uspot U / CoovaChilli: XOR of MIN(len,16) bytes (`uam.c uc_password`). */
export function deviceDecodePapUpstream(
  passwordHex: string,
  challengeHex: string,
  secret: string,
): string {
  const key = papKey(challengeHex, secret);
  const bytes = Buffer.from(passwordHex, 'hex');
  const n = Math.min(bytes.length, 16);
  const out = Buffer.alloc(n);
  for (let i = 0; i < n; i += 1) out[i] = (bytes[i] ?? 0) ^ (key[i] ?? 0);
  return out.toString('utf8').replace(/\0+$/, '');
}

/** Reference CHAP response: MD5(ident 0x00 + password + MD5(challenge bytes + secret)), hex. */
export function referenceChapResponse(
  password: string,
  challengeHex: string,
  secret: string,
): string {
  return createHash('md5')
    .update(Buffer.from([0]))
    .update(Buffer.from(password, 'utf8'))
    .update(papKey(challengeHex, secret))
    .digest('hex');
}

export interface DeviceLogon {
  readonly host: string;
  readonly port: string;
  readonly path: string;
  readonly username: string | null;
  readonly passwordHex: string | null;
  readonly response: string | null;
  /** Raw `userurl` value as it appears on the wire (still percent-encoded). */
  readonly userurlRaw: string | null;
}

/** Parses a hand-off URL the way the NAS `/logon` handler reads it. */
export function parseDeviceLogon(url: string): DeviceLogon {
  const u = new URL(url);
  const raw = u.search.startsWith('?') ? u.search.slice(1) : u.search;
  const rawParams = new Map<string, string>();
  for (const part of raw.split('&')) {
    const eq = part.indexOf('=');
    if (eq > 0) rawParams.set(part.slice(0, eq), part.slice(eq + 1));
  }
  return {
    host: u.hostname,
    port: u.port,
    path: u.pathname,
    username: u.searchParams.get('username'),
    passwordHex: u.searchParams.get('password'),
    response: u.searchParams.get('response'),
    userurlRaw: rawParams.get('userurl') ?? null,
  };
}
