import { createLogger, loadConfig } from '@ecloud/shared';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import type { FlowView, IdentifyOutcome, PortalApi, RedirectOutcome } from './api-client.js';
import { loadPortalConfig } from './config.js';
import { createServer, isMistGrantUrl, signFlowToken } from './index.js';

const logger = createLogger({ name: 'portal-cycle-d', level: 'silent' });
const FLOW_ID = '01900000-0000-7000-8000-0000000000f4';
const NOW = new Date('2026-10-10T06:00:00Z');
const EXPIRES = new Date(NOW.getTime() + 15 * 60 * 1000);

const view: FlowView = {
  id: FLOW_ID,
  state: 'ARRIVED',
  expiresAt: EXPIRES,
  methods: ['click_through'],
  portal: { id: 'p', name: 'Guest', siteName: 'Site A' },
  theme: null,
  terms: null,
  nasOrigin: null,
  continueUrl: 'https://example.com/',
  notice: null,
};

class VendorFakeApi implements PortalApi {
  vendorCalls: { adapter: string; path: string; rawQuery: string }[] = [];
  vendorOutcome: RedirectOutcome = { kind: 'flow', flowId: FLOW_ID, expiresAt: EXPIRES };
  identifyOutcome: IdentifyOutcome = {
    result: 'vendor_authorized',
    continueUrl: 'https://example.com/',
    continueHost: 'example.com',
    trusted: true,
    landingUrl: null,
  };
  redirect() {
    return Promise.resolve<RedirectOutcome>({ kind: 'error' });
  }
  vendorRedirect(input: { adapter: 'unifi' | 'omada' | 'mist'; path: string; rawQuery: string }) {
    this.vendorCalls.push(input);
    return Promise.resolve(this.vendorOutcome);
  }
  flow() {
    return Promise.resolve(view);
  }
  identify() {
    return Promise.resolve(this.identifyOutcome);
  }
  status() {
    return Promise.resolve(null);
  }
  logout() {
    return Promise.resolve(null);
  }
  asset() {
    return Promise.resolve<'unavailable'>('unavailable');
  }
}

function setup() {
  const vars = { NODE_ENV: 'test' };
  const base = loadConfig(vars);
  const config = loadPortalConfig(vars, { ...base, ports: { ...base.ports, portal: 0 } });
  const api = new VendorFakeApi();
  const app = createServer({ config, logger, api, now: () => NOW });
  return { api, app, token: signFlowToken(config.stateSecret, FLOW_ID, EXPIRES) };
}

async function clickThrough(app: ReturnType<typeof createServer>, token: string) {
  const page = await request(app).get(`/f/${token}/terms`);
  const cookie = (page.headers['set-cookie'] as unknown as string[])[0]?.split(';')[0] ?? '';
  const csrf = /name="csrf" value="([^"]+)"/.exec(page.text)?.[1] ?? '';
  return request(app)
    .post(`/f/${token}/click`)
    .set('Cookie', cookie)
    .type('form')
    .send({ csrf, accept_terms: 'yes' });
}

describe('Cycle D portal entry points', () => {
  it('forwards UniFi / Omada / Mist redirects to the vendor endpoint and starts a flow', async () => {
    const { api, app, token } = setup();
    const unifi = await request(app).get(
      '/guest/s/default/?ap=02:00:00:00:00:01&id=02:00:00:00:00:02&url=http%3A%2F%2Fx',
    );
    expect(unifi.status).toBe(303);
    expect(unifi.headers.location).toBe(`/f/${token}`);
    await request(app).get('/ext/omada?clientMac=AA-BB-CC-00-11-22');
    await request(app).get('/ext/mist?wlan_id=x');
    expect(api.vendorCalls).toEqual([
      {
        adapter: 'unifi',
        path: '/guest/s/default/',
        rawQuery: 'ap=02:00:00:00:00:01&id=02:00:00:00:00:02&url=http%3A%2F%2Fx',
        clientIp: expect.any(String) as string,
      },
      {
        adapter: 'omada',
        path: '/ext/omada',
        rawQuery: 'clientMac=AA-BB-CC-00-11-22',
        clientIp: expect.any(String) as string,
      },
      {
        adapter: 'mist',
        path: '/ext/mist',
        rawQuery: 'wlan_id=x',
        clientIp: expect.any(String) as string,
      },
    ]);
    api.vendorOutcome = { kind: 'error' };
    expect((await request(app).get('/ext/mist?x=1')).status).toBe(400);
  });

  it('an API-authorised client gets the success page (no NAS hand-off)', async () => {
    const { app, token } = setup();
    const res = await clickThrough(app, token);
    expect(res.status).toBe(200);
    expect(res.text).toContain('https://example.com/');
  });

  it('F6: an unlisted destination is never the primary button and its host is shown', async () => {
    const { api, app, token } = setup();
    api.identifyOutcome = {
      result: 'vendor_authorized',
      continueUrl: 'https://login-bank.example.net/steal',
      continueHost: 'login-bank.example.net',
      trusted: false,
      landingUrl: 'https://hotel.example.com/welcome',
    };
    const res = await clickThrough(app, token);
    expect(res.status).toBe(200);
    expect(res.text).toContain('class="button" href="https://hotel.example.com/welcome"');
    expect(res.text).not.toContain('class="button" href="https://login-bank.example.net');
    expect(res.text).toContain('login-bank.example.net');
    expect(res.text).toContain('rel="noreferrer nofollow"');
    api.identifyOutcome = { ...api.identifyOutcome, landingUrl: null };
    const bare = await clickThrough(app, token);
    expect(bare.text).not.toContain('class="button"');
    expect(bare.text).toContain('login-bank.example.net');
  });

  it('a Mist grant is followed only to the Mist authorize endpoint', async () => {
    const { api, app, token } = setup();
    api.identifyOutcome = {
      result: 'vendor_grant',
      grantUrl: 'https://portal.mist.com/authorize?signature=a&expires=1&token=b',
    };
    const ok = await clickThrough(app, token);
    expect(ok.status).toBe(302);
    expect(ok.headers.location).toContain('https://portal.mist.com/authorize?');
    api.identifyOutcome = { result: 'vendor_grant', grantUrl: 'https://evil.example/authorize' };
    expect((await clickThrough(app, token)).status).toBe(502);
    expect(isMistGrantUrl('https://portal.eu.mist.com/authorize?x')).toBe(true);
    for (const bad of [
      'http://portal.mist.com/authorize',
      'https://portal.mist.com.evil.io/authorize',
      'https://portal.mist.com:8443/authorize',
      'https://portal.mist.com/other',
    ]) {
      expect(isMistGrantUrl(bad), bad).toBe(false);
    }
    api.identifyOutcome = { result: 'vendor_unavailable' };
    expect((await clickThrough(app, token)).status).toBe(502);
  });
});
