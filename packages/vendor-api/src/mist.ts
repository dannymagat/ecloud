/**
 * Juniper Mist guest portal "Forward to external portal" signed grant URL (Cycle D, research
 * §3.8 F7). Source: juniper.net "guest-access-external-portal" (read 2026-10-10), sample
 * `authme.php` and its Read-Me:
 *
 *   token     = urlencode(base64("<wlan_id>/<ap_mac>/<client_mac>/<authorize_min>/0/0/0"))
 *   payload   = "expires=<epoch s>&token=<token>[&forward=<urlencode(url)>]"
 *   signature = urlencode(base64(hmac_sha1(<guest WLAN API secret>, payload)))
 *   URL       = http(s)://portal.mist.com/authorize?signature=<signature>&<payload>
 *
 * The vendor's worked example (secret `test-secret`, expires 1768587994, forward
 * `http://www.mist.com/`) is reproduced in mist.test.ts. The trailing `0/0/0` token fields are
 * undocumented and always `0` (never assumed to be quota / rate, research §6 item 9). Mist also
 * documents a JWT (HS256) alternative; it is not implemented (one mechanism is enough).
 *
 * No outbound call: ECLOUD builds the URL server-side (the WLAN API secret never leaves the
 * process) and the guest's browser follows it with a 302. The URL expires quickly (`expires`),
 * which is the anti-forgery mechanism toward Mist. The inbound Mist redirect is NOT signed.
 */
import { createHmac } from 'node:crypto';
import { VendorApiError } from './errors.js';

/**
 * Mist portal hosts. `portal.mist.com` is the documented global host; regional cloud hosts
 * (`portal.<region>.mist.com`) are accepted by shape only: their list is REQUIRES_CLARIFICATION.
 */
export const MIST_DEFAULT_PORTAL_HOST = 'portal.mist.com';
const MIST_HOST_RE = /^portal\.(?:[a-z0-9-]{1,32}\.)?mist\.com$/;

/** Upper bound for `expires - now`: the grant URL is used immediately by the browser. */
export const MIST_GRANT_MAX_TTL_S = 300;
export const MIST_GRANT_DEFAULT_TTL_S = 120;

export function isMistPortalHost(host: string): boolean {
  return MIST_HOST_RE.test(host);
}

/** PHP `urlencode` (RFC 1738 style: space → `+`, `~` encoded) as used by the Mist sample. */
export function phpUrlencode(value: string): string {
  return encodeURIComponent(value)
    .replace(/[!'()*~]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%20/g, '+');
}

export interface MistGrantInput {
  readonly secret: string;
  readonly wlanId: string;
  /** 12 lower-case hex digits, as Mist sends them. */
  readonly apMac: string;
  readonly clientMac: string;
  readonly authorizeMinutes: number;
  /** Epoch seconds. */
  readonly expires: number;
  readonly forward?: string | null;
  readonly host?: string;
  /** `/authorize` (default) or `/authorize-test` (vendor test endpoint). */
  readonly endpoint?: '/authorize' | '/authorize-test';
}

export interface MistGrant {
  readonly url: string;
  /** The signed payload (no secret); exposed for tests. */
  readonly payload: string;
  readonly signature: string;
}

export function buildMistGrant(input: MistGrantInput): MistGrant {
  const host = input.host ?? MIST_DEFAULT_PORTAL_HOST;
  if (!isMistPortalHost(host)) throw new VendorApiError('invalid_target');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(input.wlanId)) {
    throw new VendorApiError('invalid_target');
  }
  if (!/^[0-9a-f]{12}$/.test(input.apMac) || !/^[0-9a-f]{12}$/.test(input.clientMac)) {
    throw new VendorApiError('invalid_target');
  }
  if (
    !Number.isSafeInteger(input.authorizeMinutes) ||
    input.authorizeMinutes < 1 ||
    input.authorizeMinutes > 525_600
  ) {
    throw new VendorApiError('invalid_target');
  }
  if (!Number.isSafeInteger(input.expires) || input.expires < 1) {
    throw new VendorApiError('invalid_target');
  }
  if (input.secret.length === 0) throw new VendorApiError('auth_failed');
  const context = `${input.wlanId}/${input.apMac}/${input.clientMac}/${String(input.authorizeMinutes)}/0/0/0`;
  const token = phpUrlencode(Buffer.from(context, 'utf8').toString('base64'));
  let payload = `expires=${String(input.expires)}&token=${token}`;
  if (input.forward !== undefined && input.forward !== null && input.forward !== '') {
    payload += `&forward=${phpUrlencode(input.forward)}`;
  }
  const signature = phpUrlencode(
    createHmac('sha1', input.secret).update(payload, 'utf8').digest('base64'),
  );
  const url = `https://${host}${input.endpoint ?? '/authorize'}?signature=${signature}&${payload}`;
  return { url, payload, signature };
}
