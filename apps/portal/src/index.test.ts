import { createLogger, loadConfig } from '@ecloud/shared';
import { EventEmitter } from 'node:events';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import type {
  AssetResponse,
  FlowView,
  IdentifyInput,
  IdentifyOutcome,
  PortalApi,
  RedirectOutcome,
  StatusView,
} from './api-client.js';
import { loadPortalConfig, type PortalConfig } from './config.js';
import { t } from './i18n.js';
import { PACKAGE_NAME, createServer, main, signFlowToken } from './index.js';
import { PORTAL_CSS_PATH } from './styles.js';

const logger = createLogger({ name: 'portal-test', level: 'silent' });
const FLOW_ID = '01900000-0000-7000-8000-0000000000f1';
const NOW = new Date('2026-10-08T06:00:00Z');
const EXPIRES = new Date(NOW.getTime() + 15 * 60 * 1000);

function portalConfig(env: Record<string, string> = {}): PortalConfig {
  const vars = { NODE_ENV: 'test', ...env };
  const base = loadConfig(vars);
  // The schema forbids port 0; patched after parsing for ephemeral listeners.
  return loadPortalConfig(vars, { ...base, ports: { ...base.ports, portal: 0 } });
}

function view(over: Partial<FlowView> = {}): FlowView {
  return {
    id: FLOW_ID,
    state: 'ARRIVED',
    expiresAt: EXPIRES,
    methods: ['password', 'voucher', 'click_through'],
    portal: { id: 'p', name: 'Lobby Wi-Fi', siteName: 'Site A' },
    theme: null,
    terms: { version: '3', text: 'Be nice.' },
    nasOrigin: 'http://10.1.2.3:3990',
    continueUrl: 'https://example.com/',
    notice: null,
    ...over,
  };
}

class FakeApi implements PortalApi {
  redirectOutcome: RedirectOutcome = { kind: 'flow', flowId: FLOW_ID, expiresAt: EXPIRES };
  flowView: FlowView | null | 'unavailable' = view();
  identifyOutcome: IdentifyOutcome = {
    result: 'ok',
    handoffUrl: 'http://10.1.2.3:3990/logon?username=pc-0123456789abcdef&password=00',
  };
  statusView: StatusView | null | 'unavailable' = { flowState: 'AUTHORIZED', session: null };
  logoutUrl: { url: string } | null | 'unavailable' = { url: 'http://10.1.2.3:3990/logoff' };
  assetResponse: AssetResponse | 'unavailable' = {
    status: 200,
    headers: { 'content-type': 'image/png', etag: '"abc"' },
    body: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
  };
  readonly redirects: { flavour: string; rawQuery: string; clientIp: string | null }[] = [];
  readonly identifies: IdentifyInput[] = [];

  redirect(input: { flavour: 'uspot' | 'chilli'; rawQuery: string; clientIp: string | null }) {
    this.redirects.push(input);
    return Promise.resolve(this.redirectOutcome);
  }
  flow() {
    return Promise.resolve(this.flowView);
  }
  identify(_flowId: string, input: IdentifyInput) {
    this.identifies.push(input);
    return Promise.resolve(this.identifyOutcome);
  }
  status() {
    return Promise.resolve(this.statusView);
  }
  logout() {
    return Promise.resolve(this.logoutUrl);
  }
  asset() {
    return Promise.resolve(this.assetResponse);
  }
}

function setup(env: Record<string, string> = {}) {
  const api = new FakeApi();
  const config = portalConfig(env);
  const app = createServer({ config, logger, api, now: () => NOW });
  const token = signFlowToken(config.stateSecret, FLOW_ID, EXPIRES);
  return { api, app, config, token };
}

/** Loads a form page and returns its CSRF token + the cookie the portal set. */
async function formSession(app: ReturnType<typeof createServer>, path: string) {
  const res = await request(app).get(path);
  expect(res.status).toBe(200);
  const cookie = (res.headers['set-cookie'] as unknown as string[])[0]?.split(';')[0] ?? '';
  const csrf = /name="csrf" value="([^"]+)"/.exec(res.text)?.[1] ?? '';
  return { cookie, csrf, res };
}

describe('@ecloud/portal server', () => {
  it('exports its package name', () => {
    expect(PACKAGE_NAME).toBe('@ecloud/portal');
  });

  it('GET /healthz returns status ok', async () => {
    const res = await request(createServer({ config: portalConfig(), logger })).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('UAM entry forwards the raw query byte-for-byte and redirects to a signed flow URL', async () => {
    const { api, app, token } = setup();
    const raw = 'res=notyet&uamip=10.1.2.3&uamport=3990&userurl=http://a.example/x?y=1&z=2&md=ABC';
    const res = await request(app).get(`/uam/uspot/?${raw}`);
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe(`/f/${token}`);
    expect(api.redirects[0]).toMatchObject({ flavour: 'uspot', rawQuery: raw });
    const setCookie = (res.headers['set-cookie'] as unknown as string[])[0] ?? '';
    expect(setCookie).toMatch(
      /^pf=[A-Za-z0-9_-]{22}; Path=\/; Max-Age=900; HttpOnly; SameSite=Lax$/,
    );
    const chilli = await request(app).get('/uam/chilli?res=notyet');
    expect(chilli.status).toBe(303);
    expect(api.redirects[1]?.flavour).toBe('chilli');
  });

  it('every redirect validation failure renders the same generic error page (no oracle)', async () => {
    const { api, app } = setup();
    api.redirectOutcome = { kind: 'error' };
    const a = await request(app).get('/uam/uspot/?nasid=unknown');
    const b = await request(app).get('/uam/chilli/?nasid=other&md=00');
    expect(a.status).toBe(400);
    expect(b.status).toBe(400);
    const strip = (html: string) => html.replace(/nonce="[^"]+"/, '');
    expect(strip(a.text)).toBe(strip(b.text)); // byte-identical apart from the CSP nonce
    expect(a.text).toContain(t('error.generic'));
    expect(a.text).not.toMatch(/signature|unknown|tenant|replay/i);
  });

  it('landing lists only the enabled methods and shows the expired-session notice', async () => {
    const { api, app, token } = setup();
    api.flowView = view({ methods: ['voucher'], notice: 'session_expired' });
    const res = await request(app).get(`/f/${token}`);
    expect(res.status).toBe(200);
    expect(res.text).toContain(`href="/f/${token}/voucher"`);
    expect(res.text).not.toContain('/login"');
    expect(res.text).toContain('Your session has expired');
    expect(res.text).toContain('<html lang="en" dir="ltr">');
    expect((await request(app).get(`/f/${token}/login`)).status).toBe(404);
  });

  it('security headers: strict CSP with the NAS as the only extra form-action, nosniff, no-store', async () => {
    const { app, token } = setup();
    const res = await request(app).get(`/f/${token}/login`);
    const csp = String(res.headers['content-security-policy']);
    expect(csp).toMatch(
      /^default-src 'none'; style-src 'self' 'nonce-[A-Za-z0-9+/=]+'; img-src 'self' data:; form-action 'self' http:\/\/10\.1\.2\.3:3990; frame-ancestors 'none'; base-uri 'none'$/,
    );
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['strict-transport-security']).toBeUndefined();
    expect(res.text).not.toMatch(/<script|https?:\/\/(?!10\.1\.2\.3)[^"]*\.(js|css|woff)/);
    const nonce = /'nonce-([^']+)'/.exec(csp)?.[1];
    expect(res.text).toContain(`<style nonce="${String(nonce)}">`);

    const secure = setup({ PORTAL_COOKIE_SECURE: 'true' });
    const sres = await request(secure.app).get(`/f/${secure.token}/login`);
    expect(sres.headers['strict-transport-security']).toBe('max-age=31536000');
    expect(String((sres.headers['set-cookie'] as unknown as string[])[0])).toMatch(
      /^__Host-pf=.*; Secure$/,
    );
  });

  it('pages stay under the 50 KB budget and reference no third-party asset', async () => {
    const { app, token } = setup();
    for (const path of ['', '/login', '/voucher', '/terms', '/status']) {
      const res = await request(app).get(`/f/${token}${path}`);
      expect(res.status).toBe(200);
      expect(Buffer.byteLength(res.text)).toBeLessThan(50 * 1024);
      expect(res.text).not.toMatch(/(src|href)="https?:\/\//);
    }
    const css = await request(app).get(PORTAL_CSS_PATH);
    expect(css.status).toBe(200);
    expect(css.headers['content-type']).toMatch(/^text\/css/);
    expect(css.text).toContain('margin-inline');
    expect(css.text).not.toMatch(
      /margin-left|margin-right|padding-left|padding-right|text-align:left/,
    );
  });

  it('login POST with a valid CSRF token hands off with a 302 to the NAS logon URL', async () => {
    const { api, app, token } = setup();
    const { cookie, csrf } = await formSession(app, `/f/${token}/login`);
    const res = await request(app)
      .post(`/f/${token}/login`)
      .set('Cookie', cookie)
      .type('form')
      .send({ csrf, username: 'alice', password: 'secret-pw' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/^http:\/\/10\.1\.2\.3:3990\/logon\?username=pc-/);
    expect(api.identifies[0]).toMatchObject({ method: 'password', username: 'alice' });
  });

  it('POST without the cookie or with a forged CSRF token is refused (403) and never reaches the API', async () => {
    const { api, app, token } = setup();
    const { cookie, csrf } = await formSession(app, `/f/${token}/voucher`);
    const noCookie = await request(app)
      .post(`/f/${token}/voucher`)
      .type('form')
      .send({ csrf, code: 'ABCD2345' });
    expect(noCookie.status).toBe(403);
    const forged = await request(app)
      .post(`/f/${token}/voucher`)
      .set('Cookie', cookie)
      .type('form')
      .send({ csrf: 'x'.repeat(43), code: 'ABCD2345' });
    expect(forged.status).toBe(403);
    expect(api.identifies).toHaveLength(0);
  });

  it('rejections are generic (422), lockouts are 429, and the password is never echoed', async () => {
    const { api, app, token } = setup();
    const { cookie, csrf } = await formSession(app, `/f/${token}/login`);
    api.identifyOutcome = { result: 'rejected' };
    const bad = await request(app)
      .post(`/f/${token}/login`)
      .set('Cookie', cookie)
      .type('form')
      .send({ csrf, username: '<b>x</b>', password: 'hunter2-secret' });
    expect(bad.status).toBe(422);
    expect(bad.text).toContain(t('form.rejected'));
    expect(bad.text).toContain('value="&lt;b&gt;x&lt;/b&gt;"');
    expect(bad.text).not.toContain('hunter2-secret');
    api.identifyOutcome = { result: 'rate_limited', retryAfter: 600 };
    const locked = await request(app)
      .post(`/f/${token}/login`)
      .set('Cookie', cookie)
      .type('form')
      .send({ csrf, username: 'x', password: 'y' });
    expect(locked.status).toBe(429);
    expect(locked.text).toContain('10 minute(s)');
  });

  it('click-through requires the terms checkbox and shows the versioned terms', async () => {
    const { api, app, token } = setup();
    const { cookie, csrf, res } = await formSession(app, `/f/${token}/terms`);
    expect(res.text).toContain('Be nice.');
    expect(res.text).toContain('Version 3');
    const missing = await request(app)
      .post(`/f/${token}/click`)
      .set('Cookie', cookie)
      .type('form')
      .send({ csrf });
    expect(missing.status).toBe(422);
    const ok = await request(app)
      .post(`/f/${token}/click`)
      .set('Cookie', cookie)
      .type('form')
      .send({ csrf, accept_terms: 'yes' });
    expect(ok.status).toBe(302);
    expect(api.identifies).toEqual([
      {
        method: 'click_through',
        accept_terms: true,
        client_ip: expect.stringMatching(/127\.0\.0\.1/) as string,
      },
    ]);
  });

  it('a hand-off URL that is not http://<ipv4>:<port>/logon is never followed (open-redirect guard)', async () => {
    const { api, app, token } = setup();
    const { cookie, csrf } = await formSession(app, `/f/${token}/login`);
    api.identifyOutcome = { result: 'ok', handoffUrl: 'https://evil.example/logon?x=1' };
    const res = await request(app)
      .post(`/f/${token}/login`)
      .set('Cookie', cookie)
      .type('form')
      .send({ csrf, username: 'a', password: 'b' });
    expect(res.status).toBe(502);
    expect(res.headers.location).toBeUndefined();
  });

  it.each([
    ['another NAS address', 'http://10.9.9.9:3990/logon?username=pc-0123456789abcdef'],
    ['another port', 'http://10.1.2.3:80/logon?username=pc-0123456789abcdef'],
    ['the logoff path', 'http://10.1.2.3:3990/logoff'],
    ['a path prefix trick', 'http://10.1.2.3:3990/logonx?username=pc-0123456789abcdef'],
    ['a userinfo trick', 'http://10.1.2.3:3990@evil.example/logon'],
  ])('a hand-off to %s is not followed (must be this flow nasOrigin + /logon)', async (_n, url) => {
    const { api, app, token } = setup();
    const { cookie, csrf } = await formSession(app, `/f/${token}/login`);
    api.identifyOutcome = { result: 'ok', handoffUrl: url };
    const res = await request(app)
      .post(`/f/${token}/login`)
      .set('Cookie', cookie)
      .type('form')
      .send({ csrf, username: 'a', password: 'b' });
    expect(res.status).toBe(502);
    expect(res.headers.location).toBeUndefined();
  });

  it('logout only follows this flow nasOrigin + /logoff', async () => {
    const { api, app, token } = setup();
    const { cookie, csrf } = await formSession(app, `/f/${token}/status`);
    api.logoutUrl = { url: 'http://10.9.9.9:3990/logoff' };
    const other = await request(app)
      .post(`/f/${token}/logout`)
      .set('Cookie', cookie)
      .type('form')
      .send({ csrf });
    expect(other.headers.location).toBeUndefined();
    api.logoutUrl = { url: 'http://10.1.2.3:3990/logon' };
    const wrongPath = await request(app)
      .post(`/f/${token}/logout`)
      .set('Cookie', cookie)
      .type('form')
      .send({ csrf });
    expect(wrongPath.headers.location).toBeUndefined();
  });

  it('tampered or expired flow tokens render the expired page', async () => {
    const { app, config, token } = setup();
    const tampered = token.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'));
    expect((await request(app).get(`/f/${tampered}`)).status).toBe(410);
    const old = signFlowToken(config.stateSecret, FLOW_ID, new Date(NOW.getTime() - 1000));
    const res = await request(app).get(`/f/${old}`);
    expect(res.status).toBe(410);
    expect(res.text).toContain(t('expired.flow'));
    const otherKey = signFlowToken('another-secret-0123456789', FLOW_ID, EXPIRES);
    expect((await request(app).get(`/f/${otherKey}`)).status).toBe(410);
  });

  it('res=success renders the success page with a safe continue link; failed offers a retry', async () => {
    const { api, app, token } = setup();
    api.redirectOutcome = { kind: 'success', flowId: FLOW_ID };
    const ok = await request(app).get('/uam/uspot/?res=success');
    expect(ok.status).toBe(200);
    expect(ok.text).toContain('href="https://example.com/"');
    expect(ok.text).toContain(`href="/f/${token}/status"`);
    api.redirectOutcome = { kind: 'failed', flowId: FLOW_ID };
    const failed = await request(app).get('/uam/uspot/?res=failed');
    expect(failed.text).toContain(t('error.failed'));
    expect(failed.text).toContain(`href="/f/${token}"`);
    api.redirectOutcome = { kind: 'logoff' };
    expect((await request(app).get('/uam/chilli/?res=logoff')).text).toContain(t('logout.text'));
  });

  it('status page shows usage and logout POSTs to the NAS logoff URL', async () => {
    const { api, app, token } = setup();
    api.statusView = {
      flowState: 'AUTHORIZED',
      session: {
        status: 'active',
        startedAt: new Date('2026-10-08T05:00:00Z'),
        inputOctets: 1024n * 1024n,
        outputOctets: 0n,
        sessionTimeS: 3600,
      },
    };
    const { cookie, csrf, res } = await formSession(app, `/f/${token}/status`);
    expect(res.text).toContain('1.0 MB');
    expect(res.text).toContain('1 h 0 min');
    const out = await request(app)
      .post(`/f/${token}/logout`)
      .set('Cookie', cookie)
      .type('form')
      .send({ csrf });
    expect(out.status).toBe(302);
    expect(out.headers.location).toBe('http://10.1.2.3:3990/logoff');
  });

  it('backend failures fail closed with the unavailable page (503)', async () => {
    const { api, app, token } = setup();
    api.redirectOutcome = { kind: 'unavailable' };
    expect((await request(app).get('/uam/uspot/?res=notyet')).status).toBe(503);
    api.flowView = 'unavailable';
    const res = await request(app).get(`/f/${token}`);
    expect(res.status).toBe(503);
    expect(res.text).toContain(t('error.unavailable'));
  });

  it('theme tokens: validated colours become CSS variables; hostile strings are escaped', async () => {
    const { api, app, token } = setup();
    api.flowView = view({
      theme: {
        colors: { brand: '#112233', text: 'red;}</style><script>x()</script>' },
        strings: { en: { welcome_title: '<img src=x onerror=1>', footer_text: '"quoted"' } },
        logoAssetId: '01900000-0000-7000-8000-0000000000aa',
      },
    });
    const res = await request(app).get(`/f/${token}`);
    expect(res.text).toContain('--p-brand:#112233');
    expect(res.text).not.toContain('<script');
    expect(res.text).not.toContain('<img src=x');
    expect(res.text).toContain('&lt;img src=x onerror=1&gt;');
    expect(res.text).toContain('&quot;quoted&quot;');
    expect(res.text).toContain('src="/a/01900000-0000-7000-8000-0000000000aa"');
  });

  it('/a/{assetId}: upstream Cache-Control, ETag and 304 are forwarded, not hard-coded', async () => {
    const { api, app } = setup();
    const id = '01900000-0000-7000-8000-0000000000aa';
    api.assetResponse = {
      status: 200,
      headers: {
        'content-type': 'image/webp',
        etag: '"e1"',
        'cache-control': 'public, max-age=86400',
      },
      body: Buffer.from('RIFF'),
    };
    const ok = await request(app).get(`/a/${id}`);
    expect(ok.status).toBe(200);
    expect(ok.headers['cache-control']).toBe('public, max-age=86400');
    expect(ok.headers.etag).toBe('"e1"');
    api.assetResponse = {
      status: 304,
      headers: { etag: '"e1"', 'cache-control': 'public, max-age=86400' },
      body: Buffer.alloc(0),
    };
    const notModified = await request(app).get(`/a/${id}`).set('If-None-Match', '"e1"');
    expect(notModified.status).toBe(304);
    expect(notModified.headers['cache-control']).toBe('public, max-age=86400');
    api.assetResponse = {
      status: 200,
      headers: { 'content-type': 'image/png' },
      body: Buffer.from('x'),
    };
    expect((await request(app).get(`/a/${id}`)).headers['cache-control']).toBe('no-cache');
  });

  it('/a/{assetId}: only image types pass, nosniff, 304 forwarded', async () => {
    const { api, app } = setup();
    const id = '01900000-0000-7000-8000-0000000000aa';
    const ok = await request(app).get(`/a/${id}`);
    expect(ok.status).toBe(200);
    expect(ok.headers['content-type']).toBe('image/png');
    expect(ok.headers['x-content-type-options']).toBe('nosniff');
    expect((await request(app).get('/a/not-a-uuid')).status).toBe(404);
    api.assetResponse = {
      status: 200,
      headers: { 'content-type': 'text/html' },
      body: Buffer.from('<script>'),
    };
    expect((await request(app).get(`/a/${id}`)).status).toBe(404);
    api.assetResponse = { status: 304, headers: { etag: '"abc"' }, body: Buffer.alloc(0) };
    expect((await request(app).get(`/a/${id}`).set('If-None-Match', '"abc"')).status).toBe(304);
  });

  it('serves /healthz from main() and shutdown() closes the listener', async () => {
    const running = await main({ config: portalConfig(), logger, handleSignals: false });
    const port = (running.server.address() as AddressInfo).port;
    const res = await fetch(`http://127.0.0.1:${String(port)}/healthz`);
    expect(res.status).toBe(200);
    await running.shutdown();
    expect(running.server.listening).toBe(false);
    await running.shutdown();
  });

  it.each(['SIGTERM', 'SIGINT'] as const)('%s drains the server and exits 0', async (signal) => {
    const signals = new EventEmitter();
    const exit = vi.fn();
    const running = await main({
      config: portalConfig(),
      logger,
      signalSource: signals,
      exit,
    });
    expect(running.server.listening).toBe(true);
    signals.emit(signal);
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expect(running.server.listening).toBe(false);
  });
});
