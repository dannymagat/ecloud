/**
 * Webhook HTTP transport with SSRF protection (SECURITY_ARCHITECTURE.md, API_ARCHITECTURE.md §5).
 *
 * Webhook URLs are tenant input; the worker runs next to PostgreSQL, Redis, FreeRADIUS and the
 * internal API. Delivery therefore:
 *  - accepts `https:` only, without userinfo;
 *  - resolves the host itself and refuses if ANY resolved address is not public unicast
 *    (loopback, RFC 1918, link-local / cloud metadata, CGNAT incl. the WireGuard overlay,
 *    ULA, multicast, reserved, IPv4-mapped forms of those);
 *  - connects to the validated address (DNS pinning: no second lookup an attacker could
 *    rebind), with SNI / Host still the original name so TLS verification is unchanged;
 *  - never follows redirects (a 3xx is a failed delivery).
 */
import { lookup as dnsLookup } from 'node:dns/promises';
import { request } from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import type { FetchLike } from './outbox.js';

export class WebhookTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebhookTargetError';
  }
}

const BLOCKED = new BlockList();
for (const [net, bits] of [
  ['0.0.0.0', 8], // "this" network
  ['10.0.0.0', 8], // RFC 1918
  ['100.64.0.0', 10], // CGNAT; also the WireGuard overlay 100.100.0.0/16 (D-032)
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, cloud metadata 169.254.169.254
  ['172.16.0.0', 12], // RFC 1918 (Docker bridges)
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // TEST-NET-1
  ['192.88.99.0', 24], // 6to4 relay anycast (deprecated)
  ['192.168.0.0', 16], // RFC 1918
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved + broadcast
] as const) {
  BLOCKED.addSubnet(net, bits, 'ipv4');
}
for (const [net, bits] of [
  ['::', 128], // unspecified
  ['::1', 128], // loopback
  ['64:ff9b:1::', 48], // local-use NAT64
  ['100::', 64], // discard-only
  ['2001::', 23], // IETF protocol assignments (incl. Teredo, ORCHID)
  ['2001:db8::', 32], // documentation
  ['2002::', 16], // 6to4 (embeds arbitrary IPv4)
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['fec0::', 10], // site-local (deprecated)
  ['ff00::', 8], // multicast
] as const) {
  BLOCKED.addSubnet(net, bits, 'ipv6');
}

/** IPv4 embedded in `::ffff:a.b.c.d` / `::a.b.c.d` / `64:ff9b::a.b.c.d`, else null. */
function embeddedIpv4(address: string): string | null {
  const lower = address.toLowerCase();
  const dotted = /^(?:::ffff:|::|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (dotted?.[1] !== undefined) return dotted[1];
  const hex = /^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (hex?.[1] !== undefined && hex[2] !== undefined) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    return `${String(hi >> 8)}.${String(hi & 0xff)}.${String(lo >> 8)}.${String(lo & 0xff)}`;
  }
  return null;
}

/** True only for public unicast addresses a tenant webhook may reach. */
export function isPublicWebhookAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !BLOCKED.check(address, 'ipv4');
  if (family === 6) {
    const v4 = embeddedIpv4(address);
    if (v4 !== null) return isPublicWebhookAddress(v4);
    return !BLOCKED.check(address, 'ipv6');
  }
  return false;
}

/** Parses and checks the static shape of a webhook URL. */
export function webhookTarget(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new WebhookTargetError('webhook URL is not a valid URL');
  }
  if (url.protocol !== 'https:') throw new WebhookTargetError('webhook URL must use https');
  if (url.username !== '' || url.password !== '') {
    throw new WebhookTargetError('webhook URL must not carry credentials');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === '' || host.toLowerCase() === 'localhost' || host.endsWith('.localhost')) {
    throw new WebhookTargetError('webhook host is not allowed');
  }
  if (isIP(host) !== 0 && !isPublicWebhookAddress(host)) {
    throw new WebhookTargetError('webhook address is not a public address');
  }
  return url;
}

export type Resolver = (host: string) => Promise<{ address: string; family: number }[]>;

const defaultResolver: Resolver = (host) => dnsLookup(host, { all: true, verbatim: true });

/** Resolves the URL's host and returns the address to connect to (all must be public). */
export async function webhookAddress(
  url: URL,
  resolve: Resolver = defaultResolver,
): Promise<{ address: string; family: 4 | 6 }> {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const literal = isIP(host);
  if (literal !== 0) return { address: host, family: literal as 4 | 6 };
  let addresses: { address: string; family: number }[];
  try {
    addresses = await resolve(host);
  } catch {
    throw new WebhookTargetError('webhook host does not resolve');
  }
  if (addresses.length === 0) throw new WebhookTargetError('webhook host does not resolve');
  // Every answer must be public: otherwise a mixed answer set could still steer the socket.
  if (addresses.some((a) => !isPublicWebhookAddress(a.address))) {
    throw new WebhookTargetError('webhook host resolves to a non-public address');
  }
  const first = addresses[0] as { address: string; family: number };
  return { address: first.address, family: first.family === 6 ? 6 : 4 };
}

/** `FetchLike` that applies all of the above. Response bodies are discarded. */
export function createSafeWebhookFetch(resolve: Resolver = defaultResolver): FetchLike {
  return async (rawUrl, init) => {
    const url = webhookTarget(rawUrl);
    const pinned = await webhookAddress(url, resolve);
    const lookup: LookupFunction = (_hostname, options, callback) => {
      if (options.all === true) {
        callback(null, [{ address: pinned.address, family: pinned.family }]);
      } else {
        callback(null, pinned.address, pinned.family);
      }
    };
    return new Promise<{ status: number }>((resolvePromise, reject) => {
      const req = request(
        url,
        {
          method: init.method,
          headers: { ...init.headers, 'content-length': String(Buffer.byteLength(init.body)) },
          lookup,
          signal: init.signal,
        },
        (res) => {
          res.resume(); // drain and drop: the body is never read or stored
          res.on('end', () => {
            resolvePromise({ status: res.statusCode ?? 0 });
          });
          res.on('error', reject);
        },
      );
      req.on('error', reject);
      req.end(init.body);
    });
  };
}
