/**
 * Cycle E (D-044): Meraki splash redirect parsing, Meraki-hosted URL allow-list, hand-off form,
 * click-through grant URL, context validation and setup guide. Parameter names and URL shapes are
 * the documented ones (Meraki Developer Hub sign-on / click-through tables; Meraki docs).
 */
import { describe, expect, it } from 'vitest';
import { getVendorAdapter } from './first-party.js';
import {
  buildMerakiGrantUrl,
  buildMerakiSignOnHandoff,
  merakiHostedUrl,
  merakiOrigin,
  merakiSetupGuide,
  parseMerakiRedirect,
} from './meraki.js';
import type { NasLookup, RegisteredNas } from './types.js';

const LOGIN =
  'https://n143.network-auth.com/splash/login?mauth=MMabc-_123&continue_url=http%3A%2F%2Fexample.com%2F';
const GRANT = 'https://n143.network-auth.com/splash/grant';

function signOnQuery(overrides: Record<string, string> = {}): string {
  const q = new URLSearchParams({
    login_url: LOGIN,
    continue_url: 'http://example.com/',
    ap_mac: '88:15:44:60:1c:1a',
    ap_name: 'lobby',
    ap_tags: 'floor1',
    client_mac: 'f4:5c:89:9b:17:67',
    client_ip: '10.0.0.13',
    ...overrides,
  });
  return q.toString();
}

const NAS: RegisteredNas = {
  id: '01900000-0000-7000-8000-0000000000e1',
  organizationId: '01900000-0000-7000-8000-0000000000a1',
  siteId: '01900000-0000-7000-8000-0000000000b1',
  identifier: 'meraki-lobby',
  adapterKey: 'meraki-splash',
  controllerId: null,
  deploymentMode: 'native',
  uamServerUrl: null,
  uamSecret: null,
};

function lookup(nas: RegisteredNas | null, replayed = false): NasLookup & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    findNas: (q) => {
      calls.push(q);
      return Promise.resolve(nas);
    },
    expectedOrganizationId: null,
    isReplay: (k) => {
      calls.push(k);
      return Promise.resolve(replayed);
    },
    now: () => new Date('2026-10-10T12:00:00Z'),
  };
}

describe('Meraki-hosted URL allow-list (open redirect / SSRF guard)', () => {
  it('accepts only https://n<digits>.network-auth.com and keeps the URL byte-for-byte', () => {
    expect(merakiHostedUrl(LOGIN)).toBe(LOGIN);
    expect(merakiHostedUrl(GRANT)).toBe(GRANT);
    expect(merakiOrigin(LOGIN)).toBe('https://n143.network-auth.com');
  });

  it.each([
    ['http scheme', 'http://n143.network-auth.com/splash/login'],
    ['other host', 'https://evil.example/splash/login'],
    ['suffix trick', 'https://n143.network-auth.com.evil.example/x'],
    ['prefix trick', 'https://evil-n143.network-auth.com/x'],
    ['bare domain', 'https://network-auth.com/x'],
    ['subdomain', 'https://a.n143.network-auth.com/x'],
    ['userinfo', 'https://user@n143.network-auth.com/x'],
    ['explicit port', 'https://n143.network-auth.com:8443/x'],
    ['backslash', 'https://n143.network-auth.com\\@evil.example/'],
    ['fragment', 'https://n143.network-auth.com/x#y'],
    ['whitespace', 'https://n143.network-auth.com/x y'],
    ['javascript', 'javascript:alert(1)'],
    ['dashboard host', 'https://n143.meraki.com/splash/login'],
    ['uppercase host', 'https://N143.NETWORK-AUTH.COM/x'],
    ['empty', ''],
  ])('refuses %s', (_label, url) => {
    expect(merakiHostedUrl(url)).toBeNull();
  });
});

describe('parseMerakiRedirect', () => {
  it('parses a documented sign-on redirect', () => {
    const r = parseMerakiRedirect(signOnQuery());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.redirect).toEqual({
      mode: 'sign-on',
      loginUrl: LOGIN,
      continueUrl: 'http://example.com/',
      apMac: '88:15:44:60:1c:1a',
      apName: 'lobby',
      clientMac: 'f4:5c:89:9b:17:67',
      clientIp: '10.0.0.13',
      hadError: false,
    });
  });

  it('parses a documented click-through redirect', () => {
    const q = new URLSearchParams({
      base_grant_url: GRANT,
      user_continue_url: 'http://example.com/',
      node_id: '1301936',
      node_mac: '00:18:0a:13:dd:b0',
      gateway_id: '1301936',
      client_ip: '10.162.50.40',
      client_mac: '60:e3:ac:f7:48:08',
    }).toString();
    const r = parseMerakiRedirect(q);
    expect(r.ok && r.redirect.mode).toBe('click-through');
    expect(r.ok && r.redirect.apMac).toBe('00:18:0a:13:dd:b0');
  });

  it('ignores undocumented parameters (an ECLOUD-internal name cannot be injected)', () => {
    const r = parseMerakiRedirect(`${signOnQuery()}&ecloud_nasid=other&ecloud_success_url=x`);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.params.ecloud_nasid).toBeUndefined();
      expect(r.params.ecloud_success_url).toBeUndefined();
    }
  });

  it('flags a Meraki error return without echoing its text', () => {
    const r = parseMerakiRedirect(signOnQuery({ error_message: '<script>x</script>' }));
    expect(r.ok && r.redirect.mode === 'sign-on' && r.redirect.hadError).toBe(true);
  });

  it.each([
    ['duplicate parameter', `${signOnQuery()}&client_mac=aa:bb:cc:dd:ee:01`],
    [
      'both login_url and base_grant_url',
      `${signOnQuery()}&base_grant_url=${encodeURIComponent(GRANT)}`,
    ],
    ['neither', 'client_mac=f4:5c:89:9b:17:67'],
    ['foreign login_url host', signOnQuery({ login_url: 'https://evil.example/splash/login' })],
    ['http login_url', signOnQuery({ login_url: 'http://n143.network-auth.com/splash/login' })],
    ['missing client_mac', signOnQuery({ client_mac: '' })],
    ['multicast client_mac', signOnQuery({ client_mac: '01:00:5e:00:00:01' })],
    [
      'grant URL with a query',
      `base_grant_url=${encodeURIComponent(`${GRANT}?x=1`)}&client_mac=f4:5c:89:9b:17:67`,
    ],
  ])('refuses %s', (_label, query) => {
    expect(parseMerakiRedirect(query).ok).toBe(false);
  });

  it('drops an unsafe continue_url instead of failing', () => {
    const r = parseMerakiRedirect(signOnQuery({ continue_url: 'javascript:alert(1)' }));
    expect(r.ok && r.redirect.continueUrl).toBeNull();
  });
});

describe('hand-off form and grant URL', () => {
  it('POSTs exactly username / password / success_url to the allow-listed login_url', () => {
    const h = buildMerakiSignOnHandoff({
      loginUrl: LOGIN,
      username: 'pc-0123456789abcdef',
      password: 'single-use-pw',
      successUrl: 'https://portal.example/meraki-done',
    });
    expect(h).toEqual({
      strategy: 'browser-form',
      browser: {
        method: 'POST-form',
        url: LOGIN,
        fields: {
          username: 'pc-0123456789abcdef',
          password: 'single-use-pw',
          success_url: 'https://portal.example/meraki-done',
        },
      },
      state: 'pending',
    });
  });

  it('refuses a foreign login_url and a non-http(s) success_url', () => {
    const base = { username: 'u', password: 'p', successUrl: null };
    expect(
      'unsupported' in buildMerakiSignOnHandoff({ ...base, loginUrl: 'https://evil.example/x' }),
    ).toBe(true);
    expect(
      'unsupported' in
        buildMerakiSignOnHandoff({ ...base, loginUrl: LOGIN, successUrl: 'javascript:alert(1)' }),
    ).toBe(true);
  });

  it('builds the documented grant URL with continue_url and an optional duration', () => {
    expect(buildMerakiGrantUrl({ baseGrantUrl: GRANT, continueUrl: 'http://example.com/' })).toBe(
      `${GRANT}?continue_url=http%3A%2F%2Fexample.com%2F`,
    );
    expect(buildMerakiGrantUrl({ baseGrantUrl: GRANT, continueUrl: null, durationS: 3600 })).toBe(
      `${GRANT}?duration=3600`,
    );
    expect(
      buildMerakiGrantUrl({ baseGrantUrl: GRANT, continueUrl: null, durationS: 2_592_001 }),
    ).toBeNull();
    expect(
      buildMerakiGrantUrl({ baseGrantUrl: 'https://evil.example/g', continueUrl: null }),
    ).toBeNull();
  });
});

describe('meraki-splash VendorAdapter', () => {
  const adapter = getVendorAdapter('meraki-splash');
  const parse = (q: string) => adapter.parseRedirect({ url: `/?${q}`, method: 'GET' });

  it('is the cisco-meraki browser-form adapter around the unchanged engine', () => {
    expect(adapter.vendorKey).toBe('cisco-meraki');
    expect(adapter.strategies).toEqual(['browser-form']);
    expect(adapter.engine?.key).toBe('meraki-splash');
    expect(adapter.engine?.describeDisconnect().target).toBe('meraki-cloud-das');
  });

  it('validates context: NAS from the ECLOUD path segment, login_url as vendor nonce', async () => {
    const parsed = parse(signOnQuery());
    if ('unsupported' in parsed) throw new Error(parsed.reason);
    const l = lookup(NAS);
    const v = await adapter.validateContext(
      { ...parsed, params: { ...parsed.params, ecloud_nasid: 'meraki-lobby' } },
      l,
    );
    expect(v.ok).toBe(true);
    expect(l.calls[0]).toEqual({ nasid: 'meraki-lobby', called: null, apMac: '88:15:44:60:1c:1a' });
    expect(l.calls[1]).toMatchObject({
      challenge: LOGIN,
      nonceKind: 'vendor-nonce',
      sessionId: null,
    });
    if (v.ok) {
      expect(v.context.organizationId).toBe(NAS.organizationId);
      expect(v.context.clientMac).toBe('f4:5c:89:9b:17:67');
    }
  });

  it('fails closed: no path segment, unknown / non-Meraki NAS, replayed login_url', async () => {
    const parsed = parse(signOnQuery());
    if ('unsupported' in parsed) throw new Error(parsed.reason);
    const withNas = { ...parsed, params: { ...parsed.params, ecloud_nasid: 'meraki-lobby' } };
    expect((await adapter.validateContext(parsed, lookup(NAS))).ok).toBe(false);
    expect((await adapter.validateContext(withNas, lookup(null))).ok).toBe(false);
    expect(
      (await adapter.validateContext(withNas, lookup({ ...NAS, adapterKey: 'coovachilli-uam' })))
        .ok,
    ).toBe(false);
    const replay = await adapter.validateContext(withNas, lookup(NAS, true));
    expect(replay.ok === false && replay.reason).toBe('replayed');
  });

  it('authorizeSession refuses an unbound credential and posts a bound one', async () => {
    const parsed = parse(signOnQuery());
    if ('unsupported' in parsed) throw new Error(parsed.reason);
    const v = await adapter.validateContext(
      { ...parsed, params: { ...parsed.params, ecloud_nasid: 'meraki-lobby' } },
      lookup(NAS),
    );
    if (!v.ok) throw new Error(v.detail);
    const cred = {
      username: 'pc-0123456789abcdef',
      password: 'pw',
      expiresAt: new Date('2026-10-10T12:01:30Z'),
      boundNasId: NAS.id,
      boundClientMac: 'f4:5c:89:9b:17:67',
    };
    expect('unsupported' in adapter.authorizeSession(v.context, { ...cred, boundNasId: 'x' })).toBe(
      true,
    );
    const h = adapter.authorizeSession(v.context, cred);
    expect('unsupported' in h ? null : h.browser?.url).toBe(LOGIN);
  });

  it('Disconnect carries Acct-Session-Id only; CoA change is unsupported (Meraki: Disconnect only)', () => {
    const session = {
      sessionId: 's1',
      userName: 'pc-0123456789abcdef',
      acctSessionId: 'ABC123',
      callingStationId: 'F4-5C-89-9B-17-67',
      nasIdentifier: 'meraki-lobby',
      nasIpAddress: null,
      framedIpAddress: null,
    };
    const d = adapter.revokeSession(session);
    expect('attributes' in d ? d.attributes : d).toEqual([
      { name: 'Acct-Session-Id', value: 'ABC123' },
    ]);
    expect(adapter.engine?.capabilities().coaChange.status).toBe('UNSUPPORTED');
  });

  it('the setup guide covers the Meraki Dashboard steps with placeholders only', () => {
    const steps = merakiSetupGuide();
    expect(steps.map((s) => s.id)).toEqual([
      'platform-flag',
      'splash-mode',
      'radius-auth',
      'radius-acct',
      'nas-identifier',
      'custom-splash-url',
      'after-splash',
      'walled-garden',
      'source-ranges',
      'disconnect',
      'message-authenticator',
    ]);
    for (const s of steps) {
      expect(s.evidenceRefs.length).toBeGreaterThan(0);
      expect(s.value).not.toMatch(/secret[^>]/i);
    }
    expect(steps.find((s) => s.id === 'radius-auth')?.value).toContain('<RADIUS_SECRET>');
    expect(adapter.buildSetupGuide({ siteId: NAS.siteId, nasId: NAS.id })).toEqual(steps);
  });
});
