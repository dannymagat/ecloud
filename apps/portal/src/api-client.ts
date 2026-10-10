/**
 * The portal's only backend: the api internal listener (`/internal/portal/*`, X-Internal-Token;
 * API_ARCHITECTURE.md §1 "talks only to api"). Every transport or 5xx failure surfaces as
 * `unavailable` so pages fail closed (Q32) — the portal never authorizes anything on its own.
 */
export type RedirectOutcome =
  | { kind: 'flow'; flowId: string; expiresAt: Date }
  | { kind: 'success'; flowId: string }
  | { kind: 'already'; flowId: string | null }
  | { kind: 'failed'; flowId: string }
  | { kind: 'logoff' }
  | { kind: 'error' }
  | { kind: 'rate_limited'; retryAfter: number }
  | { kind: 'unavailable' };

export interface FlowView {
  id: string;
  state: string;
  expiresAt: Date;
  methods: ('password' | 'voucher' | 'click_through')[];
  portal: { id: string; name: string; siteName: string };
  theme: {
    colors: Record<string, unknown>;
    strings: Record<string, unknown>;
    logoAssetId: string | null;
  } | null;
  terms: { version: string; text: string } | null;
  /** `http://uamip:uamport` (private address, validated by the API). */
  nasOrigin: string | null;
  continueUrl: string | null;
  notice: 'session_expired' | null;
}

export type IdentifyInput =
  | { method: 'password'; username: string; password: string; client_ip?: string }
  | { method: 'voucher'; code: string; client_ip?: string }
  | { method: 'click_through'; accept_terms: true; client_ip?: string };

export type IdentifyOutcome =
  | {
      result: 'ok';
      handoffUrl: string;
      /** Cycle B (MikroTik): POST-form hand-off fields; absent = GET-302 hand-off. */
      handoffForm?: Readonly<Record<string, string>>;
    }
  | { result: 'rejected' }
  | { result: 'rate_limited'; retryAfter: number }
  | { result: 'flow_not_found' }
  | { result: 'flow_state' }
  | { result: 'method_not_allowed' }
  | { result: 'handoff_unavailable' }
  | { result: 'unavailable' };

export interface StatusView {
  flowState: string;
  session: {
    status: string;
    startedAt: Date;
    inputOctets: bigint;
    outputOctets: bigint;
    sessionTimeS: number;
  } | null;
}

export interface AssetResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

export interface PortalApi {
  redirect(input: {
    flavour: 'uspot' | 'chilli' | 'mikrotik';
    rawQuery: string;
    clientIp: string | null;
  }): Promise<RedirectOutcome>;
  flow(flowId: string): Promise<FlowView | null | 'unavailable'>;
  identify(flowId: string, input: IdentifyInput): Promise<IdentifyOutcome>;
  status(flowId: string): Promise<StatusView | null | 'unavailable'>;
  /** The NAS logoff URL (`{ url }`), null for an unknown flow. */
  logout(flowId: string): Promise<{ url: string } | null | 'unavailable'>;
  asset(assetId: string, ifNoneMatch: string | undefined): Promise<AssetResponse | 'unavailable'>;
}

type Json = Record<string, unknown>;

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** Octet counters arrive as decimal strings (bigint-safe); anything else counts as 0. */
function octets(value: unknown): bigint {
  return typeof value === 'string' && /^\d{1,20}$/.test(value) ? BigInt(value) : 0n;
}

export class HttpPortalApi implements PortalApi {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly timeoutMs: number,
  ) {}

  private async call(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<{ status: number; json: Json } | null> {
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          'X-Internal-Token': this.token,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: 'error',
      });
      if (res.status >= 500 || res.status === 401) {
        await res.body?.cancel();
        return null;
      }
      const json = (await res.json().catch(() => ({}))) as Json;
      return { status: res.status, json };
    } catch {
      return null;
    }
  }

  async redirect(input: {
    flavour: 'uspot' | 'chilli' | 'mikrotik';
    rawQuery: string;
    clientIp: string | null;
  }): Promise<RedirectOutcome> {
    const r = await this.call('POST', '/internal/portal/redirects', {
      flavour: input.flavour,
      raw_query: input.rawQuery,
      ...(input.clientIp === null ? {} : { client_ip: input.clientIp }),
    });
    if (r === null) return { kind: 'unavailable' };
    const j = r.json;
    const flowId = str(j.flow_id);
    switch (j.kind) {
      case 'flow': {
        const exp = str(j.expires_at);
        return flowId !== null && exp !== null
          ? { kind: 'flow', flowId, expiresAt: new Date(exp) }
          : { kind: 'error' };
      }
      case 'success':
        return flowId !== null ? { kind: 'success', flowId } : { kind: 'error' };
      case 'already':
        return { kind: 'already', flowId };
      case 'failed':
        return flowId !== null ? { kind: 'failed', flowId } : { kind: 'error' };
      case 'logoff':
        return { kind: 'logoff' };
      case 'rate_limited':
        return { kind: 'rate_limited', retryAfter: Number(j.retry_after) || 60 };
      default:
        return { kind: 'error' };
    }
  }

  async flow(flowId: string): Promise<FlowView | null | 'unavailable'> {
    const r = await this.call('GET', `/internal/portal/flows/${encodeURIComponent(flowId)}`);
    if (r === null) return 'unavailable';
    if (r.status !== 200) return null;
    const j = r.json;
    const portal = (j.portal ?? {}) as Json;
    const theme = j.theme as Json | null;
    const terms = j.terms as Json | null;
    const nas = j.nas as Json | null;
    const methods = Array.isArray(j.methods)
      ? (j.methods as unknown[]).filter(
          (m): m is 'password' | 'voucher' | 'click_through' =>
            m === 'password' || m === 'voucher' || m === 'click_through',
        )
      : [];
    return {
      id: String(j.id),
      state: String(j.state),
      expiresAt: new Date(String(j.expires_at)),
      methods,
      portal: {
        id: String(portal.id),
        name: str(portal.name) ?? '',
        siteName: str(portal.site_name) ?? '',
      },
      theme:
        theme === null || typeof theme !== 'object'
          ? null
          : {
              colors: (theme.colors ?? {}) as Record<string, unknown>,
              strings: (theme.strings ?? {}) as Record<string, unknown>,
              logoAssetId: str(theme.logo_asset_id),
            },
      terms:
        terms === null || typeof terms !== 'object'
          ? null
          : { version: String(terms.version), text: String(terms.text) },
      nasOrigin: nas === null || typeof nas !== 'object' ? null : str(nas.origin),
      continueUrl: str(j.continue_url),
      notice: j.notice === 'session_expired' ? 'session_expired' : null,
    };
  }

  async identify(flowId: string, input: IdentifyInput): Promise<IdentifyOutcome> {
    const r = await this.call(
      'POST',
      `/internal/portal/flows/${encodeURIComponent(flowId)}/identify`,
      input,
    );
    if (r === null) return { result: 'unavailable' };
    const j = r.json;
    switch (j.result) {
      case 'ok': {
        const handoff = j.handoff as Json | undefined;
        const url = str(handoff?.url);
        if (url === null) return { result: 'handoff_unavailable' };
        if (handoff?.method !== 'POST-form') return { result: 'ok', handoffUrl: url };
        const raw = handoff.fields;
        if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
          return { result: 'handoff_unavailable' };
        const form: Record<string, string> = {};
        for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
          if (typeof v !== 'string') return { result: 'handoff_unavailable' };
          form[k] = v;
        }
        return { result: 'ok', handoffUrl: url, handoffForm: form };
      }
      case 'rate_limited':
        return { result: 'rate_limited', retryAfter: Number(j.retry_after) || 60 };
      case 'rejected':
      case 'flow_not_found':
      case 'flow_state':
      case 'method_not_allowed':
      case 'handoff_unavailable':
        return { result: j.result };
      default:
        return r.status === 400 ? { result: 'rejected' } : { result: 'unavailable' };
    }
  }

  async status(flowId: string): Promise<StatusView | null | 'unavailable'> {
    const r = await this.call('GET', `/internal/portal/flows/${encodeURIComponent(flowId)}/status`);
    if (r === null) return 'unavailable';
    if (r.status !== 200) return null;
    const s = r.json.session as Json | null;
    return {
      flowState: String(r.json.flow_state),
      session:
        s === null || typeof s !== 'object'
          ? null
          : {
              status: String(s.status),
              startedAt: new Date(String(s.started_at)),
              inputOctets: octets(s.input_octets),
              outputOctets: octets(s.output_octets),
              sessionTimeS: Number(s.session_time_s) || 0,
            },
    };
  }

  async logout(flowId: string): Promise<{ url: string } | null | 'unavailable'> {
    const r = await this.call(
      'POST',
      `/internal/portal/flows/${encodeURIComponent(flowId)}/logout`,
      {},
    );
    if (r === null) return 'unavailable';
    const url = r.status === 200 ? str(r.json.url) : null;
    return url === null ? null : { url };
  }

  async asset(
    assetId: string,
    ifNoneMatch: string | undefined,
  ): Promise<AssetResponse | 'unavailable'> {
    try {
      const res = await fetch(
        `${this.baseUrl}/internal/portal-assets/${encodeURIComponent(assetId)}`,
        {
          headers: {
            'X-Internal-Token': this.token,
            ...(ifNoneMatch === undefined ? {} : { 'If-None-Match': ifNoneMatch }),
          },
          signal: AbortSignal.timeout(this.timeoutMs),
          redirect: 'error',
        },
      );
      if (res.status >= 500 || res.status === 401) {
        await res.body?.cancel();
        return 'unavailable';
      }
      const headers: Record<string, string> = {};
      for (const name of ['content-type', 'etag', 'cache-control']) {
        const value = res.headers.get(name);
        if (value !== null) headers[name] = value;
      }
      return { status: res.status, headers, body: Buffer.from(await res.arrayBuffer()) };
    } catch {
      return 'unavailable';
    }
  }
}
