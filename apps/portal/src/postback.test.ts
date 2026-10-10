/**
 * Cycle C: portal side of the external-portal post-back engine — `/pb/<profile>[/<nasid>]/`
 * entry, login token carried in the forms, auto-submitting hand-off form (no-JS fallback
 * button), CSP form-action limited to the validated login origin, foreign hand-off refused.
 */
import { createLogger, loadConfig } from '@ecloud/shared';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import type {
  FlowView,
  IdentifyInput,
  IdentifyOutcome,
  PortalApi,
  RedirectOutcome,
} from './api-client.js';
import { loadPortalConfig } from './config.js';
import { createServer, isPostbackHandoff, signFlowToken } from './index.js';

const logger = createLogger({ name: 'portal-pb-test', level: 'silent' });
const FLOW_ID = '01900000-0000-7000-8000-0000000000c1';
const NOW = new Date('2026-10-10T06:00:00Z');
const EXPIRES = new Date(NOW.getTime() + 15 * 60 * 1000);
const ORIGIN = 'http://10.77.0.2:880';
const LOGIN = `${ORIGIN}/cgi-bin/hotspot_login.cgi?ga_srvr=10.77.0.2&ga_Qv=ab%01`;
const TOKEN = 'lt1.eyJ0ZXN0IjoxfQ.c2ln';

function view(over: Partial<FlowView> = {}): FlowView {
  return {
    id: FLOW_ID,
    state: 'ARRIVED',
    expiresAt: EXPIRES,
    methods: ['password', 'click_through'],
    portal: { id: 'p', name: 'Guest', siteName: 'Site A' },
    theme: null,
    terms: null,
    nasOrigin: null,
    continueUrl: null,
    notice: null,
    postback: { loginOrigin: ORIGIN, loginToken: TOKEN },
    ...over,
  };
}

class FakeApi implements PortalApi {
  pb: RedirectOutcome = { kind: 'flow', flowId: FLOW_ID, expiresAt: EXPIRES };
  flowView: FlowView = view();
  identifyOutcome: IdentifyOutcome = {
    result: 'ok',
    handoffUrl: LOGIN,
    handoffMethod: 'POST-form',
    fields: { ga_user: 'pc-0123456789abcdef', ga_pass: 'Abc"<x>' },
  };
  readonly pbCalls: { profile: string; nasid: string | null; rawQuery: string }[] = [];
  readonly identifies: IdentifyInput[] = [];
  redirect(): Promise<RedirectOutcome> {
    return Promise.resolve({ kind: 'error' });
  }
  postbackRedirect(input: { profile: string; nasid: string | null; rawQuery: string }) {
    this.pbCalls.push(input);
    return Promise.resolve(this.pb);
  }
  flow() {
    return Promise.resolve(this.flowView);
  }
  identify(_id: string, input: IdentifyInput) {
    this.identifies.push(input);
    return Promise.resolve(this.identifyOutcome);
  }
  status() {
    return Promise.resolve(null);
  }
  logout() {
    return Promise.resolve(null);
  }
  asset() {
    return Promise.resolve('unavailable' as const);
  }
}

function setup() {
  const vars = { NODE_ENV: 'test' };
  const base = loadConfig(vars);
  const config = loadPortalConfig(vars, { ...base, ports: { ...base.ports, portal: 0 } });
  const api = new FakeApi();
  const app = createServer({ config, logger, api, now: () => NOW });
  return { api, app, token: signFlowToken(config.stateSecret, FLOW_ID, EXPIRES) };
}

async function clickThrough(app: ReturnType<typeof createServer>, token: string) {
  const page = await request(app).get(`/f/${token}/terms`);
  expect(page.status).toBe(200);
  expect(page.text).toContain(`name="lt" value="${TOKEN}"`);
  expect(page.headers['content-security-policy']).toContain(`form-action 'self' ${ORIGIN};`);
  const cookie = (page.headers['set-cookie'] as unknown as string[])[0]?.split(';')[0] ?? '';
  const csrf = /name="csrf" value="([^"]+)"/.exec(page.text)?.[1] ?? '';
  return request(app)
    .post(`/f/${token}/click`)
    .set('Cookie', cookie)
    .type('form')
    .send({ csrf, lt: TOKEN, accept_terms: 'yes' });
}

describe('portal post-back (Cycle C)', () => {
  it('forwards profile, path NAS id and the raw query, then 303 to the signed flow', async () => {
    const { api, app, token } = setup();
    const raw = 'ga_srvr=10.77.0.2&ga_Qv=ab%01%2B&ga_cmac=AA-BB-CC-00-11-22';
    const res = await request(app).get(`/pb/cambium-hotspot/site1-ap/?${raw}`);
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe(`/f/${token}`);
    expect(api.pbCalls).toHaveLength(1);
    expect(api.pbCalls[0]).toMatchObject({
      profile: 'cambium-hotspot',
      nasid: 'site1-ap',
      rawQuery: raw,
    });
    await request(app).get(`/pb/aruba-ecp?mac=x`).expect(303);
    expect(api.pbCalls[1]).toMatchObject({ profile: 'aruba-ecp', nasid: null });
  });

  it('refuses malformed paths and maps API refusals to one generic page', async () => {
    const { api, app } = setup();
    expect((await request(app).get('/pb/Bad_Profile/?a=1')).status).toBe(400);
    expect((await request(app).get('/pb/aruba-ecp/bad%20id/?a=1')).status).toBe(400);
    expect(api.pbCalls).toHaveLength(0);
    api.pb = { kind: 'error' };
    expect((await request(app).get('/pb/aruba-ecp/?a=1')).status).toBe(400);
    api.pb = { kind: 'unavailable' };
    expect((await request(app).get('/pb/aruba-ecp/?a=1')).status).toBe(503);
  });

  it('renders an auto-submitting hand-off form (nonce script + no-JS button), fields escaped', async () => {
    const { api, app, token } = setup();
    const res = await clickThrough(app, token);
    expect(res.status).toBe(200);
    expect(api.identifies[0]).toMatchObject({ method: 'click_through', login_token: TOKEN });
    const csp = String(res.headers['content-security-policy']);
    const nonce = /script-src 'nonce-([^']+)'/.exec(csp)?.[1];
    expect(nonce).toBeDefined();
    expect(csp).toContain(`form-action 'self' ${ORIGIN};`);
    expect(csp).toContain("default-src 'none'");
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.text).toContain(
      `<form id="pb" method="post" action="${LOGIN.replace(/&/g, '&amp;')}">`,
    );
    expect(res.text).toContain('name="ga_user" value="pc-0123456789abcdef"');
    expect(res.text).toContain('name="ga_pass" value="Abc&quot;&lt;x&gt;"');
    expect(res.text).toContain(`<script nonce="${String(nonce)}">`);
    expect(res.text).toMatch(/<button type="submit">Continue<\/button>/);
  });

  it('refuses a hand-off URL outside the validated login origin (open-redirect guard)', async () => {
    const { api, app, token } = setup();
    for (const url of [
      'http://evil.example.com/cgi-bin/hotspot_login.cgi',
      'http://10.77.0.2:881/cgi-bin/hotspot_login.cgi',
      'https://10.77.0.2:880/x',
      'http://user@10.77.0.2:880/x',
      'javascript:alert(1)',
    ]) {
      api.identifyOutcome = {
        result: 'ok',
        handoffUrl: url,
        handoffMethod: 'POST-form',
        fields: {},
      };
      const res = await clickThrough(app, token);
      expect(res.status, url).toBe(502);
      expect(res.text).not.toContain('id="pb"');
    }
    expect(isPostbackHandoff(LOGIN, ORIGIN)).toBe(true);
    expect(isPostbackHandoff(LOGIN, 'http://evil')).toBe(false);
    expect(isPostbackHandoff(LOGIN, null)).toBe(false);
  });

  it('a refused login token re-renders the form (fresh token from the flow view)', async () => {
    const { api, app, token } = setup();
    api.identifyOutcome = { result: 'login_token_invalid' };
    const res = await clickThrough(app, token);
    expect(res.status).toBe(403);
    expect(res.text).toContain('needs to be refreshed');
    expect(res.text).toContain(`name="lt" value="${TOKEN}"`);
  });

  it('UAM flows carry no login token field', async () => {
    const { api, app, token } = setup();
    api.flowView = view({ postback: null, nasOrigin: 'http://10.1.2.3:3990' });
    const page = await request(app).get(`/f/${token}/terms`);
    expect(page.text).not.toContain('name="lt"');
  });
});
