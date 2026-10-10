/**
 * SSRF-safe outbound HTTPS client for vendor controller APIs (Cycle D, D-044; plan OQ-17;
 * SECURITY_ARCHITECTURE.md "Outbound vendor-API calls").
 *
 * Every request, without exception:
 *  1. builds the URL from the stored, already-validated controller `base_url` plus a fixed,
 *     code-defined path (no `..`, no query / fragment in the path, same origin as the base);
 *     `https:` only, no userinfo, no `localhost` names;
 *  2. resolves the host ITSELF and re-checks EVERY resolved address against the per-controller
 *     address policy (`cloud` = public unicast only; `on_premises` / `embedded` = public or
 *     RFC 1918 / CGNAT-WireGuard / ULA; loopback, link-local / cloud metadata, `::/96`,
 *     multicast and reserved ranges are always refused), then connects to the checked address
 *     (DNS pinning: no second lookup an attacker could rebind);
 *  3. verifies TLS: system roots by default, or a pinned per-controller CA (PEM, chain + host
 *     name checked), or a pinned SHA-256 leaf fingerprint for on-prem self-signed controllers.
 *     There is NO insecure mode. In fingerprint mode the TLS socket is established and checked
 *     BEFORE any request byte (and so any credential) is written;
 *  4. never follows redirects: any 3xx is an error (`redirect_refused`);
 *  5. bounds time (one deadline covering DNS, connect, TLS and the full response) and size
 *     (Content-Length checked first, then the streamed byte count);
 *  6. takes a token from the per-controller rate limiter before any I/O.
 *
 * Errors are {@link VendorApiError}s with fixed messages: nothing of the request (headers,
 * body, query) or of the response is copied into them, so callers may log them unchanged.
 */
import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage } from 'node:http';
import { BlockList, isIP } from 'node:net';
import { checkServerIdentity, connect as tlsConnect, type TLSSocket } from 'node:tls';
import { X509Certificate, timingSafeEqual } from 'node:crypto';
import {
  bareHost,
  isLocalhostName,
  isPrivateNetworkAddress,
  isPublicWebhookAddress,
} from '@ecloud/shared';
import { VendorApiError } from './errors.js';
import { TokenBucketLimiter, type RateLimiter } from './rate-limit.js';

export type ControllerKind = 'cloud' | 'on_premises' | 'embedded';

/** How the controller's TLS certificate is trusted. There is deliberately no "insecure" mode. */
export type TlsTrust =
  | { readonly mode: 'system' }
  | { readonly mode: 'ca'; readonly caPem: string }
  | { readonly mode: 'fingerprint'; readonly sha256: string };

export interface VendorTarget {
  /** Rate-limit key (controller id). */
  readonly controllerId: string;
  /** Stored, normalised `https://` base URL (vendor_api_credentials.base_url). */
  readonly baseUrl: string;
  readonly kind: ControllerKind;
  readonly tls: TlsTrust;
}

export interface VendorRequest {
  readonly method: 'GET' | 'POST';
  /** Absolute path below the base URL's path, e.g. `/v1/sites`. Ids must be pre-encoded. */
  readonly path: string;
  readonly query?: Readonly<Record<string, string>>;
  readonly headers?: Readonly<Record<string, string>>;
  readonly json?: unknown;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
}

export interface VendorResponse {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: Buffer;
}

export type Resolver = (host: string) => Promise<readonly { address: string; family: number }[]>;
export type AddressCheck = (address: string, kind: ControllerKind) => boolean;

export const OUTBOUND_LIMITS = Object.freeze({
  defaultTimeoutMs: 10_000,
  maxTimeoutMs: 30_000,
  defaultMaxResponseBytes: 1024 * 1024,
  maxResponseBytes: 8 * 1024 * 1024,
  maxRequestBytes: 64 * 1024,
});

/** Production address policy (plan OQ-17), the same predicates as `normalizeControllerBaseUrl`. */
export const controllerAddressAllowed: AddressCheck = (address, kind) =>
  kind === 'cloud'
    ? isPublicWebhookAddress(address)
    : isPublicWebhookAddress(address) || isPrivateNetworkAddress(address);

/** IPv4 inside `::ffff:a.b.c.d` / `::ffff:xxxx:yyyy`, else null (deny-list on mapped forms). */
function mappedIpv4(address: string): string | null {
  const lower = address.toLowerCase();
  const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower)?.[1];
  if (dotted !== undefined) return dotted;
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (hex?.[1] === undefined || hex[2] === undefined) return null;
  const hi = parseInt(hex[1], 16);
  const lo = parseInt(hex[2], 16);
  return `${String(hi >> 8)}.${String(hi & 0xff)}.${String(lo >> 8)}.${String(lo & 0xff)}`;
}

const defaultResolver: Resolver = (host) => dnsLookup(host, { all: true, verbatim: true });

const FINGERPRINT_RE = /^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/;

/** `AB:CD:…` (32 octets, upper case) from any common spelling, or null. */
export function normalizeFingerprint(raw: string): string | null {
  const hex = raw
    .trim()
    .replace(/^sha256[:=/]?/i, '')
    .replace(/[:\s-]/g, '')
    .toUpperCase();
  if (!/^[0-9A-F]{64}$/.test(hex)) return null;
  const out = hex.match(/.{2}/g)?.join(':') ?? '';
  return FINGERPRINT_RE.test(out) ? out : null;
}

const PEM_CERT_RE =
  /^-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----\s*(?:-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----\s*)*$/;
const PEM_BLOCK_RE = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;

/**
 * True for one to eight PEM `CERTIFICATE` blocks (never a key) where EVERY block parses as an
 * X.509 certificate (review F8: the shape check alone accepted any base64).
 */
export function isCertificatePem(raw: string): boolean {
  if (raw.length > 16_384 || !PEM_CERT_RE.test(raw.trim() + '\n')) return false;
  const blocks = raw.match(PEM_BLOCK_RE) ?? [];
  if (blocks.length === 0 || blocks.length > 8) return false;
  try {
    for (const block of blocks) new X509Certificate(block);
    return true;
  } catch {
    return false;
  }
}

/**
 * Ports a controller URL may use (review F2): 443 and the documented controller HTTPS ports
 * (UniFi 8443 / 8843 / 8444, Omada 8043, research §3.6–§3.7 + vendor docs). Anything else is
 * refused before any I/O, so the client cannot be used as a port scanner.
 */
export const DEFAULT_ALLOWED_PORTS: readonly number[] = Object.freeze([
  443, 8443, 8043, 8843, 8444,
]);

/**
 * Platform deny-list applied on top of the per-kind policy (review F2; `VENDOR_API_DENY_CIDRS`):
 * the pilot Compose bridge (infra/vps/compose/compose.pilot.yaml `172.28.0.0/16`), the default
 * Docker bridge `172.17.0.0/16` and the WireGuard overlay `100.100.0.0/16` (D-032). Loopback,
 * link-local / metadata etc. are already refused by the base policy.
 */
export const DEFAULT_DENY_CIDRS: readonly string[] = Object.freeze([
  '172.28.0.0/16',
  '172.17.0.0/16',
  '100.100.0.0/16',
]);

/** Parses `a.b.c.d/n` / `x::/n` entries (comma / space separated allowed); throws RangeError. */
export function parseDenyCidrs(entries: readonly string[] | string): BlockList {
  const list = new BlockList();
  const items = (typeof entries === 'string' ? entries.split(/[\s,]+/) : entries).filter(
    (e) => e.trim() !== '',
  );
  for (const raw of items) {
    const [net, bits] = raw.trim().split('/');
    const family = isIP(net ?? '');
    const n = Number(bits);
    if (
      family === 0 ||
      bits === undefined ||
      !Number.isInteger(n) ||
      n < 0 ||
      n > (family === 4 ? 32 : 128)
    ) {
      throw new RangeError(`invalid CIDR in vendor-API deny-list: ${raw}`);
    }
    list.addSubnet(net as string, n, family === 4 ? 'ipv4' : 'ipv6');
  }
  return list;
}

/** Same-origin URL for `path` below the base; throws `invalid_target`. */
export function buildVendorUrl(
  baseUrl: string,
  path: string,
  query?: Readonly<Record<string, string>>,
): URL {
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    throw new VendorApiError('invalid_target');
  }
  if (base.protocol !== 'https:' || base.username !== '' || base.password !== '') {
    throw new VendorApiError('invalid_target');
  }
  if (base.search !== '' || base.hash !== '') throw new VendorApiError('invalid_target');
  if (!path.startsWith('/') || /[?#\\]/.test(path) || /(^|\/)\.\.?(\/|$)/.test(path)) {
    throw new VendorApiError('invalid_target');
  }
  if (/%2e|%2f|%5c/i.test(path)) throw new VendorApiError('invalid_target');
  const url = new URL(base.href);
  url.pathname = `${base.pathname.replace(/\/+$/, '')}${path}`;
  for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);
  if (url.origin !== base.origin) throw new VendorApiError('invalid_target');
  if (isLocalhostName(bareHost(url))) throw new VendorApiError('invalid_target');
  return url;
}

export interface VendorHttpClientOptions {
  readonly resolve?: Resolver;
  /**
   * Address policy. Production code never passes this (the default is
   * {@link controllerAddressAllowed}); tests use it to reach a loopback mock server.
   */
  readonly addressAllowed?: AddressCheck;
  readonly rateLimiter?: RateLimiter;
  /** Port allow-list (default {@link DEFAULT_ALLOWED_PORTS}; tests widen it for a mock). */
  readonly allowedPorts?: readonly number[];
  /** Extra denied networks (default {@link DEFAULT_DENY_CIDRS}); always applied. */
  readonly denyCidrs?: readonly string[] | string;
}

function tlsErrorCode(error: unknown): 'tls_error' | 'connection_failed' {
  const code = (error as { code?: unknown }).code;
  if (typeof code !== 'string') return 'connection_failed';
  return /CERT|SELF_SIGNED|UNABLE_TO_|ERR_TLS|ERR_SSL|HOSTNAME|ALTNAME|SIGNATURE|EPROTO/.test(code)
    ? 'tls_error'
    : 'connection_failed';
}

function fingerprintEquals(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
}

export class VendorHttpClient {
  private readonly resolve: Resolver;
  private readonly addressAllowed: AddressCheck;
  private readonly limiter: RateLimiter;
  private readonly allowedPorts: ReadonlySet<number>;
  private readonly deny: BlockList;

  constructor(options: VendorHttpClientOptions = {}) {
    this.resolve = options.resolve ?? defaultResolver;
    this.addressAllowed = options.addressAllowed ?? controllerAddressAllowed;
    this.limiter = options.rateLimiter ?? new TokenBucketLimiter();
    this.allowedPorts = new Set(options.allowedPorts ?? DEFAULT_ALLOWED_PORTS);
    this.deny = parseDenyCidrs(options.denyCidrs ?? DEFAULT_DENY_CIDRS);
  }

  /** Whether a base URL's port is on the allow-list (`''` = 443). */
  isPortAllowed(port: string | number): boolean {
    const n = port === '' ? 443 : Number(port);
    return Number.isInteger(n) && this.allowedPorts.has(n);
  }

  /** Base policy for the kind AND not on the platform deny-list. */
  private permitted(address: string, kind: ControllerKind): boolean {
    if (!this.addressAllowed(address, kind)) return false;
    const family = isIP(address);
    if (family === 0) return false;
    if (this.deny.check(address, family === 4 ? 'ipv4' : 'ipv6')) return false;
    const mapped = family === 6 ? mappedIpv4(address) : null;
    return mapped === null || !this.deny.check(mapped, 'ipv4');
  }

  async request(target: VendorTarget, req: VendorRequest): Promise<VendorResponse> {
    const url = buildVendorUrl(target.baseUrl, req.path, req.query);
    if (!this.isPortAllowed(url.port)) throw new VendorApiError('port_not_allowed');
    const timeoutMs = Math.min(
      Math.max(1, req.timeoutMs ?? OUTBOUND_LIMITS.defaultTimeoutMs),
      OUTBOUND_LIMITS.maxTimeoutMs,
    );
    const maxBytes = Math.min(
      Math.max(1, req.maxResponseBytes ?? OUTBOUND_LIMITS.defaultMaxResponseBytes),
      OUTBOUND_LIMITS.maxResponseBytes,
    );
    const body = req.json === undefined ? null : Buffer.from(JSON.stringify(req.json), 'utf8');
    if (body !== null && body.length > OUTBOUND_LIMITS.maxRequestBytes) {
      throw new VendorApiError('invalid_target');
    }
    let trust: TlsTrust = target.tls;
    if (trust.mode === 'fingerprint') {
      const pin = normalizeFingerprint(trust.sha256);
      if (pin === null) throw new VendorApiError('invalid_target');
      trust = { mode: 'fingerprint', sha256: pin };
    } else if (trust.mode === 'ca' && !isCertificatePem(trust.caPem)) {
      throw new VendorApiError('invalid_target');
    }
    if (!this.limiter.take(target.controllerId)) throw new VendorApiError('rate_limited');

    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), timeoutMs);
    timer.unref();
    let socket: TLSSocket | null = null;
    try {
      const pinned = await this.pinAddress(url, target.kind, deadline.signal);
      socket = await this.connect(url, pinned, trust, deadline.signal);
      return await this.exchange(url, socket, req, body, maxBytes, deadline.signal);
    } finally {
      clearTimeout(timer);
      socket?.destroy();
    }
  }

  /** Resolves and checks every address (plan OQ-17); returns the one to connect to. */
  private async pinAddress(url: URL, kind: ControllerKind, signal: AbortSignal): Promise<string> {
    const host = bareHost(url);
    if (isIP(host) !== 0) {
      if (!this.permitted(host, kind)) throw new VendorApiError('blocked_address');
      return host;
    }
    let answers: readonly { address: string; family: number }[];
    try {
      answers = await Promise.race([
        this.resolve(host),
        new Promise<never>((_, reject) => {
          signal.addEventListener('abort', () => reject(new VendorApiError('timeout')), {
            once: true,
          });
        }),
      ]);
    } catch (error) {
      if (error instanceof VendorApiError) throw error;
      throw new VendorApiError('dns_failure');
    }
    if (answers.length === 0) throw new VendorApiError('dns_failure');
    // Every answer must pass: a mixed answer set could otherwise still steer the socket.
    if (answers.some((a) => !this.permitted(a.address, kind))) {
      throw new VendorApiError('blocked_address');
    }
    return (answers[0] as { address: string }).address;
  }

  private connect(
    url: URL,
    address: string,
    trust: TlsTrust,
    signal: AbortSignal,
  ): Promise<TLSSocket> {
    const hostname = bareHost(url);
    const port = url.port === '' ? 443 : Number(url.port);
    return new Promise<TLSSocket>((resolve, reject) => {
      if (signal.aborted) {
        reject(new VendorApiError('timeout'));
        return;
      }
      const socket = tlsConnect({
        host: address,
        port,
        ...(isIP(hostname) === 0 ? { servername: hostname } : {}),
        ...(trust.mode === 'ca' ? { ca: trust.caPem } : {}),
        // Fingerprint mode checks the leaf below, before anything is written; every other mode
        // verifies the chain (system roots or the pinned CA) AND the host name.
        rejectUnauthorized: trust.mode !== 'fingerprint',
        checkServerIdentity: (_servername, cert) =>
          trust.mode === 'fingerprint' ? undefined : checkServerIdentity(hostname, cert),
        minVersion: 'TLSv1.2',
        ALPNProtocols: ['http/1.1'],
      });
      const onAbort = (): void => {
        socket.destroy();
        reject(new VendorApiError('timeout'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      socket.once('error', (error) => {
        signal.removeEventListener('abort', onAbort);
        socket.destroy();
        reject(
          signal.aborted ? new VendorApiError('timeout') : new VendorApiError(tlsErrorCode(error)),
        );
      });
      socket.once('secureConnect', () => {
        signal.removeEventListener('abort', onAbort);
        if (trust.mode === 'fingerprint') {
          const seen = socket.getPeerCertificate().fingerprint256;
          if (typeof seen !== 'string' || !fingerprintEquals(seen.toUpperCase(), trust.sha256)) {
            socket.destroy();
            reject(new VendorApiError('tls_pin_mismatch'));
            return;
          }
        } else if (!socket.authorized) {
          socket.destroy();
          reject(new VendorApiError('tls_error'));
          return;
        }
        resolve(socket);
      });
    });
  }

  private exchange(
    url: URL,
    socket: TLSSocket,
    req: VendorRequest,
    body: Buffer | null,
    maxBytes: number,
    signal: AbortSignal,
  ): Promise<VendorResponse> {
    return new Promise<VendorResponse>((resolve, reject) => {
      let settled = false;
      const fail = (error: VendorApiError): void => {
        if (settled) return;
        settled = true;
        socket.destroy();
        reject(error);
      };
      const headers: Record<string, string> = {
        accept: 'application/json',
        'user-agent': 'ecloud-vendor-api/1',
        connection: 'close',
        ...req.headers,
        host: url.host,
      };
      if (body !== null) {
        headers['content-type'] = 'application/json';
        headers['content-length'] = String(body.length);
      }
      const outgoing = httpRequest(
        {
          method: req.method,
          path: `${url.pathname}${url.search}`,
          headers,
          setHost: false,
          createConnection: () => socket,
        },
        (res: IncomingMessage) => {
          const status = res.statusCode ?? 0;
          if (status >= 300 && status < 400) {
            fail(new VendorApiError('redirect_refused', status));
            return;
          }
          const declared = Number(res.headers['content-length']);
          if (Number.isFinite(declared) && declared > maxBytes) {
            fail(new VendorApiError('response_too_large', status));
            return;
          }
          const chunks: Buffer[] = [];
          let size = 0;
          res.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > maxBytes) {
              fail(new VendorApiError('response_too_large', status));
              return;
            }
            chunks.push(chunk);
          });
          res.on('end', () => {
            if (settled) return;
            settled = true;
            resolve({ status, headers: res.headers, body: Buffer.concat(chunks) });
          });
          res.on('error', () => fail(new VendorApiError('connection_failed', status)));
          res.on('aborted', () => fail(new VendorApiError('connection_failed', status)));
        },
      );
      const onAbort = (): void => {
        outgoing.destroy();
        fail(new VendorApiError('timeout'));
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
      outgoing.on('close', () => signal.removeEventListener('abort', onAbort));
      outgoing.on('error', () =>
        fail(
          signal.aborted ? new VendorApiError('timeout') : new VendorApiError('connection_failed'),
        ),
      );
      outgoing.end(body ?? undefined);
    });
  }
}

/** Parses a JSON body; `invalid_response` on anything else. */
export function jsonBody(res: VendorResponse): unknown {
  try {
    return JSON.parse(res.body.toString('utf8')) as unknown;
  } catch {
    throw new VendorApiError('invalid_response', res.status);
  }
}

/** Maps a non-2xx status to an error: 401/403 → `auth_failed`, other → `http_error`. */
export function assertOk(res: VendorResponse): void {
  if (res.status === 401 || res.status === 403) throw new VendorApiError('auth_failed', res.status);
  if (res.status < 200 || res.status >= 300) throw new VendorApiError('http_error', res.status);
}
