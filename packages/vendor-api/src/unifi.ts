/**
 * UniFi Network Application (≥ 9.1.105) Network API client (Cycle D, research §3.6 F5).
 *
 * DOCUMENTED (vendor):
 *  - help.ui.com 31228198640023 "External Hotspot API for Authorization Clients" (read via the
 *    research extract, research §0/§7; direct fetch is Cloudflare-blocked):
 *    `GET  /v1/sites/{siteId}/clients?filter=macAddress.eq('<mac>')`,
 *    `POST /v1/sites/{siteId}/clients/{clientId}/actions` with `action = AUTHORIZE_GUEST_ACCESS`
 *    and optional `timeLimitMinutes`, `dataUsageLimitMBytes`, `rxRateLimitKbps`,
 *    `txRateLimitKbps`; API key generated in Network > Control Plane > Integrations.
 *  - developer.ui.com (read 2026-10-10): requests carry the key in the `X-API-KEY` header.
 *
 * NOT documented / REQUIRES_DEVICE_TEST (never assumed silently):
 *  - the URL prefix in front of `/v1` (typically the console's Network integration path): it is
 *    part of the operator-entered `base_url`, never guessed here;
 *  - rx/tx direction of the two rate fields (research §6 item 7). ECLOUD maps rx = client
 *    download, tx = client upload as a labelled ASSUMPTION (policy-engine api-limits.ts);
 *  - the `/v1/sites/{siteId}/devices` inventory list (used only by the AP verification job);
 *  - the client object's `access` shape (used only as an extra refusal, never to accept).
 *
 * UniFi has NO RADIUS accounting in this mode: nothing here reports usage.
 */
import { VendorApiError } from './errors.js';
import { assertOk, jsonBody, type VendorHttpClient, type VendorTarget } from './http.js';

export interface UnifiGuestLimits {
  readonly timeLimitMinutes?: number;
  readonly dataUsageLimitMBytes?: number;
  readonly rxRateLimitKbps?: number;
  readonly txRateLimitKbps?: number;
}

export interface UnifiClient {
  readonly id: string;
  readonly macAddress: string;
  /** `access.type` when the controller reports one (shape REQUIRES_DEVICE_TEST). */
  readonly accessType: string | null;
}

const SITE_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

function listData(body: unknown): unknown[] {
  if (typeof body !== 'object' || body === null) throw new VendorApiError('invalid_response');
  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data)) throw new VendorApiError('invalid_response');
  return data;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 && v.length <= 256 ? v : null;
}

export class UnifiNetworkClient {
  constructor(
    private readonly http: VendorHttpClient,
    private readonly target: VendorTarget,
    private readonly apiKey: string,
    private readonly siteId: string,
  ) {
    if (!SITE_ID_RE.test(siteId)) throw new VendorApiError('invalid_target');
  }

  private headers(): Record<string, string> {
    return { 'x-api-key': this.apiKey };
  }

  private sitePath(suffix: string): string {
    return `/v1/sites/${encodeURIComponent(this.siteId)}${suffix}`;
  }

  /** Connection test: lists one client of the configured site (proves URL, TLS, key, site). */
  async testConnection(): Promise<void> {
    const res = await this.http.request(this.target, {
      method: 'GET',
      path: this.sitePath('/clients'),
      query: { limit: '1' },
      headers: this.headers(),
    });
    assertOk(res);
    listData(jsonBody(res));
  }

  /** The site's client with this MAC, or null; more than one match is `invalid_response`. */
  async findClientByMac(mac: string): Promise<UnifiClient | null> {
    if (!/^[0-9a-f]{2}(?::[0-9a-f]{2}){5}$/.test(mac)) throw new VendorApiError('invalid_target');
    const res = await this.http.request(this.target, {
      method: 'GET',
      path: this.sitePath('/clients'),
      query: { filter: `macAddress.eq('${mac}')` },
      headers: this.headers(),
    });
    assertOk(res);
    const matches = listData(jsonBody(res)).filter(
      (c) =>
        typeof c === 'object' &&
        c !== null &&
        str((c as { macAddress?: unknown }).macAddress)?.toLowerCase() === mac,
    );
    if (matches.length === 0) return null;
    if (matches.length > 1) throw new VendorApiError('invalid_response');
    const c = matches[0] as { id?: unknown; macAddress?: unknown; access?: unknown };
    const id = str(c.id);
    if (id === null || !ID_RE.test(id)) throw new VendorApiError('invalid_response');
    const access =
      typeof c.access === 'object' && c.access !== null
        ? str((c.access as { type?: unknown }).type)
        : null;
    return { id, macAddress: mac, accessType: access };
  }

  /** `AUTHORIZE_GUEST_ACCESS` with only the limits the policy sets (integers ≥ 1). */
  async authorizeGuest(clientId: string, limits: UnifiGuestLimits): Promise<void> {
    if (!ID_RE.test(clientId)) throw new VendorApiError('invalid_target');
    const body: Record<string, unknown> = { action: 'AUTHORIZE_GUEST_ACCESS' };
    for (const [k, v] of Object.entries(limits)) {
      if (v === undefined) continue;
      if (!Number.isSafeInteger(v) || (v as number) < 1) throw new VendorApiError('invalid_target');
      body[k] = v;
    }
    const res = await this.http.request(this.target, {
      method: 'POST',
      path: this.sitePath(`/clients/${encodeURIComponent(clientId)}/actions`),
      headers: this.headers(),
      json: body,
    });
    assertOk(res);
  }

  /** Adopted device MACs of the site (inventory verification; paginated, bounded). */
  async listDeviceMacs(maxDevices = 5000): Promise<string[]> {
    const macs: string[] = [];
    const pageSize = 200;
    for (let offset = 0; offset < maxDevices; offset += pageSize) {
      const res = await this.http.request(this.target, {
        method: 'GET',
        path: this.sitePath('/devices'),
        query: { offset: String(offset), limit: String(pageSize) },
        headers: this.headers(),
        maxResponseBytes: 4 * 1024 * 1024,
      });
      assertOk(res);
      const body = jsonBody(res);
      const page = listData(body);
      for (const d of page) {
        const mac =
          typeof d === 'object' && d !== null
            ? str((d as { macAddress?: unknown }).macAddress)
            : null;
        if (mac !== null) macs.push(mac);
      }
      const total = (body as { totalCount?: unknown }).totalCount;
      if (page.length < pageSize || (typeof total === 'number' && offset + pageSize >= total))
        break;
    }
    return macs;
  }
}
