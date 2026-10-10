/**
 * Inbound external-portal redirect parsing for the backend-API / signed-grant vendors
 * (Cycle D; docs/VENDOR_INTEGRATION_RESEARCH.md §3.6–§3.8). Pure: no I/O, no trust.
 *
 * Only DOCUMENTED parameter names are read. All three redirects are UNSIGNED (no vendor
 * signature is documented for any of them), so every value is a claim: the caller resolves the
 * NAS from a VERIFIED AP MAC (`nas_access_points.verified_at`, fail-closed `findNasByIdentity`)
 * and the controller itself re-checks the client (UniFi: the client must exist on the site).
 *
 * Duplicate parameters, over-long values and malformed MACs are refused (`null`), never
 * guessed. Raw vendor MAC spellings are kept next to the canonical form because the vendor API
 * expects the value it sent (format REQUIRES_DEVICE_TEST).
 */
import { canonicalUnicastMac } from '@ecloud/shared';

export const VENDOR_API_ADAPTER_KEYS = [
  'unifi-external-portal',
  'omada-api',
  'mist-guest-portal',
] as const;
export type VendorApiAdapterKey = (typeof VENDOR_API_ADAPTER_KEYS)[number];

export function isVendorApiAdapterKey(value: unknown): value is VendorApiAdapterKey {
  return (
    typeof value === 'string' && (VENDOR_API_ADAPTER_KEYS as readonly string[]).includes(value)
  );
}

export interface VendorRedirect {
  readonly adapterKey: VendorApiAdapterKey;
  /** Canonical `aa:bb:cc:dd:ee:ff`. */
  readonly clientMac: string;
  /** Canonical, or null (Omada gateway / wired form). */
  readonly apMac: string | null;
  readonly ssid: string | null;
  readonly clientIp: string | null;
  /** Original URL / landing page as sent (validated later with `safeUserUrl`). */
  readonly continueUrl: string | null;
  /** Documented fields only, decoded, as received (no secrets exist in these redirects). */
  readonly fields: Readonly<Record<string, string>>;
}

const MAX_VALUE = 2048;

/** Decoded params; null on duplicates / over-long values. */
function params(rawQuery: string, allowed: readonly string[]): Record<string, string> | null {
  if (rawQuery.length > 8192) return null;
  const out: Record<string, string> = {};
  for (const [key, value] of new URLSearchParams(rawQuery)) {
    if (!allowed.includes(key)) continue; // undocumented names are ignored, never trusted
    if (key in out || value.length > MAX_VALUE) return null;
    out[key] = value;
  }
  return out;
}

/** C0 controls and DEL are never accepted in a displayed / forwarded value. */
function hasControlChar(v: string): boolean {
  for (let i = 0; i < v.length; i += 1) {
    const c = v.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
}

const text = (v: string | undefined, max = 256): string | null =>
  v === undefined || v === '' || v.length > max || hasControlChar(v) ? null : v;

const ipText = (v: string | undefined): string | null =>
  v !== undefined && /^[0-9a-fA-F:.]{2,45}$/.test(v) ? v : null;

/**
 * UniFi Network ≥ 9.1.105 external portal (help.ui.com article 31228198640023, research §3.6):
 * `GET <portal>/guest/s/<site>/?ap=<AP MAC>&id=<client MAC>&t=<…>&url=<original URL>&ssid=<SSID>`.
 * The meaning of `t` is not documented (REQUIRES_CLARIFICATION): it is kept, never interpreted.
 */
export function parseUnifiRedirect(path: string, rawQuery: string): VendorRedirect | null {
  const site = /^\/guest\/s\/([A-Za-z0-9_-]{1,64})\/?$/.exec(path)?.[1];
  if (site === undefined) return null;
  const p = params(rawQuery, ['ap', 'id', 't', 'url', 'ssid']);
  if (p === null) return null;
  const clientMac = canonicalUnicastMac(p.id);
  const apMac = canonicalUnicastMac(p.ap);
  if (clientMac === null || apMac === null) return null;
  const fields: Record<string, string> = { unifi_site: site, ap: p.ap ?? '', id: p.id ?? '' };
  if (p.t !== undefined) fields.t = p.t.slice(0, 64);
  return {
    adapterKey: 'unifi-external-portal',
    clientMac,
    apMac,
    ssid: text(p.ssid),
    clientIp: null,
    continueUrl: text(p.url, MAX_VALUE),
    fields,
  };
}

/**
 * Omada Controller ≥ 6.2.10 external portal without RADIUS (support.omadanetworks.com document
 * 132060, read 2026-10-10): EAP form `clientMac, clientIp, apMac, ssidName, t, radioId, site,
 * redirectUrl`; gateway form `clientMac, gatewayMac, vid, t, site, redirectUrl`.
 *
 * The research flagged inconsistent case in older Omada examples (`clientIP`, `GatewayMac`,
 * `originalUrl`, research §6 item 5). Those spellings are NOT accepted: only the documented
 * 6.2.10 names are read; the variants stay REQUIRES_DEVICE_TEST (lab capture decides).
 */
export const OMADA_REDIRECT_PARAMS = [
  'clientMac',
  'clientIp',
  'apMac',
  'gatewayMac',
  'vid',
  'ssidName',
  'radioId',
  'site',
  't',
  'redirectUrl',
] as const;

export function parseOmadaRedirect(rawQuery: string): VendorRedirect | null {
  const p = params(rawQuery, OMADA_REDIRECT_PARAMS);
  if (p === null) return null;
  const clientMac = canonicalUnicastMac(p.clientMac);
  if (clientMac === null) return null;
  const apMac = p.apMac === undefined ? null : canonicalUnicastMac(p.apMac);
  const gatewayMac = p.gatewayMac === undefined ? null : canonicalUnicastMac(p.gatewayMac);
  const eap = apMac !== null && p.ssidName !== undefined && /^\d{1,2}$/.test(p.radioId ?? '');
  const gateway = gatewayMac !== null && /^\d{1,4}$/.test(p.vid ?? '');
  if (eap === gateway) return null; // exactly one documented form
  const site = text(p.site, 128);
  if (site === null) return null;
  const fields: Record<string, string> = { clientMac: p.clientMac ?? '', site };
  if (eap) {
    fields.apMac = p.apMac ?? '';
    fields.ssidName = p.ssidName ?? '';
    fields.radioId = p.radioId ?? '';
  } else {
    fields.gatewayMac = p.gatewayMac ?? '';
    fields.vid = p.vid ?? '';
  }
  const clientIp = ipText(p.clientIp);
  if (clientIp !== null) fields.clientIp = clientIp;
  if (p.t !== undefined && /^\d{1,16}$/.test(p.t)) fields.t = p.t;
  return {
    adapterKey: 'omada-api',
    clientMac,
    // A gateway (wired) redirect names the gateway, which is registered like an AP MAC.
    apMac: eap ? apMac : gatewayMac,
    ssid: eap ? text(p.ssidName) : null,
    clientIp,
    continueUrl: text(p.redirectUrl, MAX_VALUE),
    fields,
  };
}

/**
 * Juniper Mist guest portal "Forward to external portal" (juniper.net guest-access-external-
 * portal, read 2026-10-10): Mist 302s with `wlan_id, ap_mac, client_mac, url, ap_name,
 * site_name`. Mist documents NO signature on this inbound redirect, so none is verified (the
 * outbound grant URL is the signed part, see mist.ts).
 */
export function parseMistRedirect(rawQuery: string): VendorRedirect | null {
  const p = params(rawQuery, ['wlan_id', 'ap_mac', 'client_mac', 'url', 'ap_name', 'site_name']);
  if (p === null) return null;
  const wlanId = p.wlan_id ?? '';
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(wlanId)) return null;
  const clientMac = canonicalUnicastMac(p.client_mac);
  const apMac = canonicalUnicastMac(p.ap_mac);
  if (clientMac === null || apMac === null) return null;
  const fields: Record<string, string> = {
    wlan_id: wlanId.toLowerCase(),
    ap_mac: apMac.replace(/:/g, ''),
    client_mac: clientMac.replace(/:/g, ''),
  };
  const apName = text(p.ap_name, 128);
  const siteName = text(p.site_name, 128);
  if (apName !== null) fields.ap_name = apName;
  if (siteName !== null) fields.site_name = siteName;
  return {
    adapterKey: 'mist-guest-portal',
    clientMac,
    apMac,
    ssid: null,
    clientIp: null,
    continueUrl: text(p.url, MAX_VALUE),
    fields,
  };
}
