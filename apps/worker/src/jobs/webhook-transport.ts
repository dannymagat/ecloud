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
import { isIP, type LookupFunction } from 'node:net';
import { WebhookTargetError, isPublicWebhookAddress, webhookTarget } from '@ecloud/shared';
import type { FetchLike } from './outbox.js';

// The static guards live in @ecloud/shared (MULTI_VENDOR_INTEGRATION_PLAN.md §8.2, L3) so the API
// validates controller `base_url` values with the same code; re-exported here unchanged.
export { WebhookTargetError, isPublicWebhookAddress, webhookTarget };

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
