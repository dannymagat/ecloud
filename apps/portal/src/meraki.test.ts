/**
 * Cycle E (D-044): Meraki splash at the public portal — entry route, login token in the form,
 * POST hand-off page (CSP form-action limited to the allow-listed Meraki origin, one nonce'd
 * auto-submit script), refusal of a non-allow-listed hand-off, and the static success page.
 */
import { createLogger, loadConfig } from '@ecloud/shared';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
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
import { createServer, isMerakiHandoff, signFlowToken } from './index.js';
import { renderPage, DEFAULT_THEME } from './pages.js';

const logger = createLogger({ name: 'portal-meraki-test', level: 'silent' });
const FLOW_ID = '01900000-0000-7000-8000-0000000000f2';
const NOW = new Date('2026-10-10T06:00:00Z');
const EXPIRES = new Date(NOW.getTime() + 15 * 60 * 1000);
const ORIGIN = 'https://n143.network-auth.com';
const LOGIN_URL = `${ORIGIN}/splash/login?mauth=MMabc`;

function portalConfig(): PortalConfig {
  const vars = { NODE_ENV: 'test' };
  const base = loadConfig(vars);
  return loadPortalConfig(vars, { ...base, ports: { ...base.ports, portal: 0 } });
}

function merakiView(over: Partial<FlowView> = {}): FlowView {
  return {
    id: FLOW_ID,
    state: 'ARRIVED',
    expiresAt: EXPIRES,
    methods: ['password', 'click_through'],
    portal: { id: 'p', name: 'Meraki Wi-Fi', siteName: 'Lobby' },
    theme: null,
    terms: null,
    nasOrigin: null,
    continueUrl: 'http://example.com/',
    notice: null,
    meraki: { mode: 'sign-on', handoffOrigin: ORIGIN, loginToken: 'lt1.payload.mac' },
    ...over,
  };
}

class FakeApi implements PortalApi {
  redirectOutcome: RedirectOutcome = { kind: 'flow', flowId: FLOW_ID, expiresAt: EXPIRES };
  flowView: FlowView | null | 'unavailable' = merakiView();
  identifyOutcome: IdentifyOutcome = {
    result: 'ok',
    handoffUrl: LOGIN_URL,
    handoffMethod: 'POST-form',
    handoffFields: {
      username: 'pc-0123456789abcdef',
      password: 'single-use',
      success_url: 'https://portal.example/meraki-done',
    },
  };
  readonly redirects: unknown[] = [];
  readonly identifies: IdentifyInput[] = [];
  redirect(input: unknown) {
    this.redirects.push(input);
    return Promise.resolve(this.redirectOutcome);
  }
  flow() {
    return Promise.resolve(this.flowView);
  }
  identify(_id: string, input: IdentifyInput) {
    this.identifies.push(input);
    return Promise.resolve(this.identifyOutcome);
  }
  status(): Promise<StatusView | null | 'unavailable'> {
    return Promise.resolve(null);
  }
  logout() {
    return Promise.resolve(null);
  }
  asset(): Promise<AssetResponse | 'unavailable'> {
    return Promise.resolve('unavailable');
  }
}

function setup() {
  const api = new FakeApi();
  const config = portalConfig();
  const app = createServer({ config, logger, api, now: () => NOW });
  const token = signFlowToken(config.stateSecret, FLOW_ID, EXPIRES);
  return { api, app, token };
}

async function clickThrough(app: ReturnType<typeof createServer>, token: string) {
  const page = await request(app).get(`/f/${token}/terms`);
  expect(page.status).toBe(200);
  const cookie = (page.headers['set-cookie'] as unknown as string[])[0]?.split(';')[0] ?? '';
  const csrf = /name="csrf" value="([^"]+)"/.exec(page.text)?.[1] ?? '';
  const loginToken = /name="login_token" value="([^"]+)"/.exec(page.text)?.[1] ?? '';
  return { page, cookie, csrf, loginToken };
}

describe('Meraki splash at the portal (Cycle E)', () => {
  it('entry forwards the raw query and the NAS path segment, then 303 to the flow', async () => {
    const { api, app, token } = setup();
    const raw = `login_url=${encodeURIComponent(LOGIN_URL)}&client_mac=f4:5c:89:9b:17:67`;
    const res = await request(app).get(`/meraki/meraki-lobby/?${raw}`);
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe(`/f/${token}`);
    expect(api.redirects[0]).toMatchObject({
      flavour: 'meraki',
      rawQuery: raw,
      nasid: 'meraki-lobby',
    });
  });

  it('entry: refusal and malformed NAS segment show one generic error', async () => {
    const { api, app } = setup();
    api.redirectOutcome = { kind: 'error' };
    expect((await request(app).get('/meraki/meraki-lobby/?x=1')).status).toBe(400);
    expect((await request(app).get('/meraki/a%20b/')).status).toBe(400);
  });

  it('forms carry the login token; the POST hand-off page targets only the Meraki origin', async () => {
    const { api, app, token } = setup();
    const s = await clickThrough(app, token);
    expect(s.loginToken).toBe('lt1.payload.mac');
    const res = await request(app)
      .post(`/f/${token}/click`)
      .set('Cookie', s.cookie)
      .type('form')
      .send({ csrf: s.csrf, login_token: s.loginToken, accept_terms: 'yes' });
    expect(res.status).toBe(200);
    expect(api.identifies[0]).toMatchObject({
      method: 'click_through',
      login_token: 'lt1.payload.mac',
    });
    const csp = String(res.headers['content-security-policy']);
    expect(csp).toContain(`form-action 'self' ${ORIGIN};`);
    expect(csp).toMatch(/script-src 'nonce-[^']+'/);
    expect(res.text).toContain(
      `<form id="pb" method="post" action="${LOGIN_URL.replace(/&/g, '&amp;')}">`,
    );
    expect(res.text).toContain('name="username" value="pc-0123456789abcdef"');
    expect(res.text).toContain('name="success_url"');
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('refuses a hand-off URL outside the allow-listed origin (open redirect guard)', async () => {
    const { api, app, token } = setup();
    api.identifyOutcome = {
      result: 'ok',
      handoffUrl: 'https://evil.example/splash/login',
      handoffMethod: 'POST-form',
      handoffFields: {},
    };
    const s = await clickThrough(app, token);
    const res = await request(app)
      .post(`/f/${token}/click`)
      .set('Cookie', s.cookie)
      .type('form')
      .send({ csrf: s.csrf, login_token: s.loginToken, accept_terms: 'yes' });
    expect(res.status).toBe(502);
    expect(res.text).not.toContain('evil.example');
  });

  it('a refused login token re-renders the form (403) instead of handing off', async () => {
    const { api, app, token } = setup();
    api.identifyOutcome = { result: 'login_token_invalid' };
    const s = await clickThrough(app, token);
    const res = await request(app)
      .post(`/f/${token}/click`)
      .set('Cookie', s.cookie)
      .type('form')
      .send({ csrf: s.csrf, login_token: 'stale', accept_terms: 'yes' });
    expect(res.status).toBe(403);
    expect(res.text).toContain('name="login_token"');
  });

  it('click-through grant: 302 to the allow-listed grant URL only', async () => {
    const { api, app, token } = setup();
    api.flowView = merakiView({
      meraki: { mode: 'click-through', handoffOrigin: ORIGIN, loginToken: 't' },
      methods: ['click_through'],
    });
    api.identifyOutcome = {
      result: 'ok',
      handoffUrl: `${ORIGIN}/splash/grant?continue_url=http%3A%2F%2Fexample.com%2F`,
      handoffMethod: 'GET-302',
      handoffFields: {},
    };
    const s = await clickThrough(app, token);
    const res = await request(app)
      .post(`/f/${token}/click`)
      .set('Cookie', s.cookie)
      .type('form')
      .send({ csrf: s.csrf, login_token: s.loginToken, accept_terms: 'yes' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(
      `${ORIGIN}/splash/grant?continue_url=http%3A%2F%2Fexample.com%2F`,
    );
  });

  it('isMerakiHandoff: documented origin shape only', () => {
    expect(isMerakiHandoff(LOGIN_URL, ORIGIN)).toBe(true);
    expect(isMerakiHandoff(`${ORIGIN}.evil.example/x`, ORIGIN)).toBe(false);
    expect(isMerakiHandoff(LOGIN_URL, 'https://evil.example')).toBe(false);
    expect(isMerakiHandoff(LOGIN_URL, null)).toBe(false);
    expect(isMerakiHandoff(`${ORIGIN}/x y`, ORIGIN)).toBe(false);
  });

  it('GET /meraki-done shows the connected page; hand-off markup escapes every value', async () => {
    const { app } = setup();
    const done = await request(app).get('/meraki-done');
    expect(done.status).toBe(200);
    expect(done.text).toContain('You are connected');
    const html = renderPage(
      DEFAULT_THEME,
      null,
      {
        page: 'handoff',
        action: `${ORIGIN}/x?a=1&b="2"`,
        fields: [['x"y', '<z>']],
        autoSubmit: true,
        scriptNonce: 'n0nce',
      },
      { mode: 'link', nonce: 'n0nce' },
    );
    expect(html).toContain('action="https://n143.network-auth.com/x?a=1&amp;b=&quot;2&quot;"');
    expect(html).toContain('name="x&quot;y" value="&lt;z&gt;"');
    expect(html).toContain('<script nonce="n0nce">');
  });
});
