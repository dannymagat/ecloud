/**
 * Static URL / address guards for tenant-supplied endpoints (SECURITY_ARCHITECTURE.md, SSRF).
 *
 * Moved from `apps/worker/src/jobs/webhook-transport.ts` (MULTI_VENDOR_INTEGRATION_PLAN.md
 * §8.2, L3) so the worker's webhook delivery and the API's controller `base_url` validation use
 * the same code (L3 review fixes: trailing-dot `localhost.` and the `::/96` block are refused); the worker re-exports these names unchanged. DNS resolution and address pinning
 * stay in the worker (they perform I/O); this module only inspects strings.
 */
import { BlockList, isIP } from 'node:net';

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
  ['::', 96], // unspecified, loopback and deprecated IPv4-compatible ::a.b.c.d (RFC 4291 §2.5.5.1)
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

/**
 * Private networks a self-hosted controller may legitimately live on (RFC 1918, the CGNAT range
 * that carries the WireGuard overlay, IPv6 ULA). Loopback, link-local / cloud metadata,
 * multicast and reserved ranges are NOT in this list.
 */
const PRIVATE = new BlockList();
for (const [net, bits] of [
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
] as const) {
  PRIVATE.addSubnet(net, bits, 'ipv4');
}
PRIVATE.addSubnet('fc00::', 7, 'ipv6');

/** `::/96` (unspecified, loopback, IPv4-compatible): never public, never private. */
const BLOCKED_COMPAT = new BlockList();
BLOCKED_COMPAT.addSubnet('::', 96, 'ipv6');

/** Host without URL brackets and without trailing dots (`localhost.` is `localhost`). */
export function bareHost(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, '').replace(/\.+$/, '');
}

/** `localhost`, `*.localhost` (RFC 6761) or empty, after {@link bareHost} normalisation. */
export function isLocalhostName(host: string): boolean {
  const h = host.toLowerCase();
  return h === '' || h === 'localhost' || h.endsWith('.localhost');
}

/**
 * IPv4 embedded in `::ffff:a.b.c.d` / `64:ff9b::a.b.c.d` (dotted or hex), else null. The
 * deprecated IPv4-compatible form `::a.b.c.d` (`::/96`, e.g. `[::127.0.0.1]` which URL parsing
 * turns into `[::7f00:1]`) is NOT mapped: the whole `::/96` block is refused (BLOCKED above,
 * never private) whatever IPv4 address it carries.
 */
function embeddedIpv4(address: string): string | null {
  const lower = address.toLowerCase();
  const dotted = /^(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
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

/**
 * True for an RFC 1918 / CGNAT (WireGuard overlay) / IPv6 ULA address (IPv4-mapped forms
 * included). Never true for loopback, link-local, multicast or reserved addresses.
 */
export function isPrivateNetworkAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return PRIVATE.check(address, 'ipv4');
  if (family === 6) {
    if (BLOCKED_COMPAT.check(address, 'ipv6')) return false;
    const v4 = embeddedIpv4(address);
    if (v4 !== null) return isPrivateNetworkAddress(v4);
    return PRIVATE.check(address, 'ipv6');
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
  const host = bareHost(url);
  if (isLocalhostName(host)) {
    throw new WebhookTargetError('webhook host is not allowed');
  }
  if (isIP(host) !== 0 && !isPublicWebhookAddress(host)) {
    throw new WebhookTargetError('webhook address is not a public address');
  }
  return url;
}
