/**
 * Omada Controller hotspot-operator API (Cycle D, research §3.7 F6), documented form for
 * Omada Controller 6.2.10+ (support.omadanetworks.com document 132060, read 2026-10-10):
 *
 *  1. `POST https://CONTROLLER[:PORT]/CONTROLLER_ID/api/v2/hotspot/login`, JSON
 *     `{"name": <hotspot operator>, "password": <password>}` → `{"errorCode": 0, "result":
 *     {"token": <CSRF token>}}` plus a session cookie (`TPOMADA_SESSIONID`, v5.11+; earlier
 *     `TPEAP_SESSIONID`). The operator must be a Hotspot Operator, not a controller admin.
 *  2. `POST …/CONTROLLER_ID/api/v2/hotspot/extPortal/auth` with header `Csrf-Token` and the
 *     cookie; EAP body `clientMac, clientIp, apMac, ssidName, radioId, time, authType (4),
 *     originUrl, totalTrafficLimitBytes, downloadRateLimitKbps, uploadRateLimitKbps`; gateway
 *     body `clientMac, clientIp, gatewayMac, vid, time, authType, …limits`. Success =
 *     `{"errorCode": 0}`.
 *
 * Doc facts that are NOT settled and therefore REQUIRES_DEVICE_TEST:
 *  - `time` is "Authentication Expiration time, unit millisecond" in 6.2.10 but "microsecond"
 *    in the 5.0.15–6.2.0 document (13080), and the PHP template passes a duration ("the time
 *    allowed"). ECLOUD sends a DURATION in milliseconds (6.2.10 unit + template semantics);
 *  - JSON value types: the doc's JSON examples quote every value, its PHP template sends
 *    numbers for `time` / `authType`. ECLOUD sends the template's types (numbers);
 *  - the case variants seen in older Omada examples (`clientIP`, `GatewayMac`,
 *    `originalUrl`) are never sent; the 5.x body (with `site`, without limits) is not built.
 *
 * The vendor sample disables certificate verification ("Allow Self Signed Certs"); ECLOUD
 * never does: an on-prem self-signed controller is trusted by a pinned CA or fingerprint.
 */
import { VendorApiError } from './errors.js';
import { assertOk, jsonBody, type VendorHttpClient, type VendorTarget } from './http.js';

export interface OmadaCredentials {
  /** Hotspot operator name (vendor_api_credentials.username). */
  readonly operator: string;
  /** Hotspot operator password (sealed secret, opened in-process). */
  readonly password: string;
  /** CONTROLLER_ID path segment (settings.omada_controller_id). */
  readonly omadacId: string;
}

export interface OmadaAuthInput {
  /** Values exactly as the controller sent them in the redirect (format REQUIRES_DEVICE_TEST). */
  readonly clientMac: string;
  readonly clientIp?: string;
  readonly apMac?: string;
  readonly ssidName?: string;
  readonly radioId?: string;
  readonly gatewayMac?: string;
  readonly vid?: string;
  /** Authorisation duration in milliseconds (see header). */
  readonly timeMs: number;
  readonly originUrl?: string;
  readonly totalTrafficLimitBytes?: number;
  readonly downloadRateLimitKbps?: number;
  readonly uploadRateLimitKbps?: number;
}

const OMADAC_RE = /^[A-Za-z0-9]{1,64}$/;
const COOKIE_NAMES = ['TPOMADA_SESSIONID', 'TPEAP_SESSIONID'] as const;

interface Session {
  readonly csrfToken: string;
  readonly cookie: string;
}

function errorCodeOf(body: unknown): number | null {
  if (typeof body !== 'object' || body === null) return null;
  const code = (body as { errorCode?: unknown }).errorCode;
  return typeof code === 'number' && Number.isInteger(code) ? code : null;
}

export class OmadaHotspotClient {
  constructor(
    private readonly http: VendorHttpClient,
    private readonly target: VendorTarget,
    private readonly creds: OmadaCredentials,
  ) {
    if (!OMADAC_RE.test(creds.omadacId)) throw new VendorApiError('invalid_target');
  }

  private path(suffix: string): string {
    return `/${this.creds.omadacId}/api/v2/hotspot${suffix}`;
  }

  /** Operator login → CSRF token + session cookie (held in memory for one operation only). */
  async login(): Promise<Session> {
    const res = await this.http.request(this.target, {
      method: 'POST',
      path: this.path('/login'),
      json: { name: this.creds.operator, password: this.creds.password },
    });
    assertOk(res);
    const body = jsonBody(res);
    const code = errorCodeOf(body);
    if (code === null) throw new VendorApiError('invalid_response', res.status);
    if (code !== 0) throw new VendorApiError('auth_failed', res.status);
    const result = (body as { result?: unknown }).result;
    const token =
      typeof result === 'object' && result !== null ? (result as { token?: unknown }).token : null;
    if (typeof token !== 'string' || !/^[A-Za-z0-9._-]{8,256}$/.test(token)) {
      throw new VendorApiError('invalid_response', res.status);
    }
    const setCookie = res.headers['set-cookie'] ?? [];
    let cookie: string | null = null;
    for (const line of setCookie) {
      const pair = line.split(';')[0]?.trim() ?? '';
      const name = pair.split('=')[0] ?? '';
      if ((COOKIE_NAMES as readonly string[]).includes(name) && /^[\x21-\x7e]{1,512}$/.test(pair)) {
        cookie = pair;
        break;
      }
    }
    if (cookie === null) throw new VendorApiError('invalid_response', res.status);
    return { csrfToken: token, cookie };
  }

  async testConnection(): Promise<void> {
    await this.login();
  }

  /** Logs in, then authorises the client (one operation; nothing is cached across calls). */
  async authorizeClient(input: OmadaAuthInput): Promise<void> {
    const eap = input.apMac !== undefined;
    if (eap === (input.gatewayMac !== undefined)) throw new VendorApiError('invalid_target');
    if (!Number.isSafeInteger(input.timeMs) || input.timeMs < 1000) {
      throw new VendorApiError('invalid_target');
    }
    const body: Record<string, unknown> = { clientMac: input.clientMac };
    if (input.clientIp !== undefined) body.clientIp = input.clientIp;
    if (eap) {
      body.apMac = input.apMac;
      body.ssidName = input.ssidName ?? '';
      body.radioId = input.radioId ?? '';
    } else {
      body.gatewayMac = input.gatewayMac;
      body.vid = input.vid ?? '';
    }
    body.time = input.timeMs;
    body.authType = 4;
    if (eap) body.originUrl = input.originUrl ?? '';
    for (const key of [
      'totalTrafficLimitBytes',
      'downloadRateLimitKbps',
      'uploadRateLimitKbps',
    ] as const) {
      const v = input[key];
      if (v === undefined) continue;
      if (!Number.isSafeInteger(v) || v < 1) throw new VendorApiError('invalid_target');
      body[key] = v;
    }
    const session = await this.login();
    const res = await this.http.request(this.target, {
      method: 'POST',
      path: this.path('/extPortal/auth'),
      headers: { 'csrf-token': session.csrfToken, cookie: session.cookie },
      json: body,
    });
    assertOk(res);
    const code = errorCodeOf(jsonBody(res));
    if (code === null) throw new VendorApiError('invalid_response', res.status);
    if (code !== 0) throw new VendorApiError('vendor_rejected', res.status);
  }
}
