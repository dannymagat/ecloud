/**
 * Cycle C: F3 external-portal post-back engine and profiles (parsing, login URL validation,
 * rejection cases, hand-off form rendering data, setup guides, NAS config validation).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { BrokerCredential, HotspotContext, NasLookup, RegisteredNas } from '../types.js';
import { getVendorAdapter, listVendorAdapters } from '../first-party.js';
import {
  BUILTIN_POSTBACK_PROFILES,
  GENERIC_POSTBACK_PROFILE_KEY,
  POSTBACK_ADAPTER_KEY,
  builtinPostbackProfile,
  checkLoginUrl,
  createPostbackVendorAdapter,
  parsePostbackNasConfig,
  parsePostbackPath,
  postbackAdapterForNas,
  postbackSetupGuide,
  postbackVendorNonce,
  profileForConfig,
  resolveLoginUrl,
  serializePostbackNasConfig,
  splitPostbackQuery,
  DEFAULT_POSTBACK_OPTIONS,
  type PostbackProfile,
} from './index.js';

const ORG = '11111111-1111-4111-8111-111111111111';
const SITE = '22222222-2222-4222-8222-222222222222';
const NAS = '33333333-3333-4333-8333-333333333333';
const NOW = new Date('2026-10-10T12:00:00Z');
const CLIENT = 'aa:bb:cc:00:11:22';
const AP = '00:04:56:aa:bb:cc';

function profile(key: string): PostbackProfile {
  const p = builtinPostbackProfile(key);
  if (p === null) throw new Error(key);
  return p;
}

function nas(config: Record<string, unknown>, over: Partial<RegisteredNas> = {}): RegisteredNas {
  return {
    id: NAS,
    organizationId: ORG,
    siteId: SITE,
    identifier: 'site1-ap',
    adapterKey: POSTBACK_ADAPTER_KEY,
    controllerId: null,
    deploymentMode: 'native',
    uamServerUrl: null,
    uamSecret: null,
    nasIp: '10.20.0.2',
    adapterConfig: config,
    ...over,
  };
}

interface LookupLog {
  findNas: unknown[];
  replay: unknown[];
}

function lookup(
  registered: RegisteredNas | null,
  opts: { replayed?: boolean; expected?: string | null; log?: LookupLog } = {},
): NasLookup {
  return {
    findNas: (q) => {
      opts.log?.findNas.push(q);
      return Promise.resolve(registered);
    },
    expectedOrganizationId: opts.expected === undefined ? null : opts.expected,
    isReplay: (k) => {
      opts.log?.replay.push(k);
      return Promise.resolve(opts.replayed === true);
    },
    now: () => NOW,
  };
}

const credential: BrokerCredential = {
  username: 'pc-0123456789abcdef',
  password: 'Abcdefghijklmnop',
  expiresAt: new Date(NOW.getTime() + 90_000),
  boundNasId: NAS,
  boundClientMac: CLIENT,
};

async function contextFor(
  key: string,
  url: string,
  config: Record<string, unknown> = { profile: key },
): Promise<HotspotContext> {
  const built = postbackAdapterForNas({ adapterConfig: config, nasIp: '10.20.0.2' });
  if (built === null) throw new Error('config');
  const parsed = built.adapter.parseRedirect({ url, method: 'GET' });
  if ('unsupported' in parsed) throw new Error(parsed.reason);
  const v = await built.adapter.validateContext(parsed, lookup(nas(config)));
  if (!v.ok) throw new Error(`${v.reason}: ${v.detail}`);
  return v.context;
}

// Sample redirects built from the documented parameter names (research §1, plan §7.3).
const CAMBIUM_Q =
  'ga_ssid=Guest&ga_ap_mac=00-04-56-AA-BB-CC&ga_nas_id=site1-ap&ga_srvr=10.20.0.2&ga_cmac=AA-BB-CC-00-11-22&ga_Qv=eUROAh8YBgIUOwkNBgo%2BGBo%01%1B&ga_orig_url=http%3A%2F%2Fexample.com%2F';
const ARUBA_Q =
  'cmd=login&mac=aa:bb:cc:00:11:22&essid=Guest&ip=10.30.0.15&apname=ap-1&apmac=00:04:56:aa:bb:cc&vcname=vc&switchip=10.20.0.2&url=http%3A%2F%2Fexample.com%2F';
const CISCO_Q =
  'switch_url=http%3A%2F%2F192.0.2.1%2Flogin.html&ap_mac=00:04:56:aa:bb:cc&client_mac=aa:bb:cc:00:11:22&ssid=Guest';
const FORTINET_Q =
  'post=http%3A%2F%2F10.20.0.1%3A1000%2Ffgtauth&magic=0a1b2c3d4e5f&usermac=aa:bb:cc:00:11:22&apmac=00:04:56:aa:bb:cc&apip=10.20.0.9&userip=10.30.0.15&ssid=Guest';
const RUCKUS_Q =
  'sip=10.20.0.2&mac=00:04:56:aa:bb:cc&client_mac=aa:bb:cc:00:11:22&uip=10.30.0.15&ssid=Guest&url=http%3A%2F%2Fexample.com%2F';
const OMADA_Q =
  'clientMac=AA-BB-CC-00-11-22&clientIp=10.30.0.15&apMac=00-04-56-AA-BB-CC&ssidName=Guest&radioId=1&scheme=https&originUrl=http%3A%2F%2Fexample.com%2F&target=10.20.0.5&targetPort=8843';
const HUAWEI_Q =
  'user-mac=aa:bb:cc:00:11:22&device-mac=00:04:56:aa:bb:cc&loginurl=https%3A%2F%2F10.20.0.7%2Flogin&redirect-url=http%3A%2F%2Fexample.com%2F';

describe('post-back profiles (data)', () => {
  it('ships the seven built-in profiles and the generic one, each with evidence', () => {
    expect(BUILTIN_POSTBACK_PROFILES.map((p) => p.key)).toEqual([
      'cambium-hotspot',
      'aruba-ecp',
      'cisco-webauth',
      'fortinet-ecp',
      'ruckus-wispr',
      'omada-external-portal',
      'huawei-portal',
    ]);
    for (const p of BUILTIN_POSTBACK_PROFILES) {
      expect(p.evidence.length, p.key).toBeGreaterThan(0);
      expect(p.params.clientMac.length, p.key).toBeGreaterThan(0);
      expect(Object.keys(p.loginTargets)).toContain(p.defaultLoginTarget);
      // No profile emits a vendor rate attribute as documented-and-modelled.
      for (const a of p.radius) expect(a.status).not.toBe('DOCUMENTED');
    }
  });

  it('the admin profile dropdown lists exactly these profile keys (drift)', () => {
    const editor = readFileSync(
      resolve(
        import.meta.dirname,
        '../../../../../apps/admin/src/features/org/PostbackProfileEditor.tsx',
      ),
      'utf8',
    );
    const keys = [...editor.matchAll(/key: '([a-z0-9-]+)',\s*label:/g)].map((m) => m[1]);
    expect(keys).toEqual([
      ...BUILTIN_POSTBACK_PROFILES.map((p) => p.key),
      GENERIC_POSTBACK_PROFILE_KEY,
    ]);
    for (const p of BUILTIN_POSTBACK_PROFILES)
      for (const t of Object.keys(p.loginTargets))
        if (Object.keys(p.loginTargets).length > 1) expect(editor).toContain(`value: '${t}'`);
  });

  it('the engine adapter is registered and nothing is VERIFIED', () => {
    const v = getVendorAdapter(POSTBACK_ADAPTER_KEY);
    expect(listVendorAdapters().map((a) => a.key)).toContain(POSTBACK_ADAPTER_KEY);
    expect(v.parseRedirect({ url: '/pb/x/?a=b', method: 'GET' })).toMatchObject({
      unsupported: true,
    });
    const caps = v.engine?.capabilities();
    expect(Object.values(caps?.fields ?? {}).map((f) => f.status)).not.toContain(
      'VERIFIED_SUPPORTED',
    );
    expect(caps?.fields.download_rate_kbps.status).toBe('UNSUPPORTED');
    expect(v.discoverCapabilities({}).cells.every((c) => c.status !== 'VERIFIED_SUPPORTED')).toBe(
      true,
    );
  });
});

describe('query and path parsing', () => {
  it('keeps raw values, decodes display copies and reports duplicates', () => {
    const q = splitPostbackQuery('a=1&b=%41%2B&a=2&c');
    expect(q.params).toEqual({ a: '1', b: 'A+', c: '' });
    expect(q.rawValues.b).toBe('%41%2B');
    expect(q.duplicates).toEqual(['a']);
    expect(splitPostbackQuery('x=%E0%A4%A').params.x).toBe('%E0%A4%A');
  });

  it('reads /pb/<profile>/<nasid>/ and refuses malformed paths', () => {
    expect(parsePostbackPath('/pb/cambium-hotspot/site1-ap/?a=b')).toEqual({
      profile: 'cambium-hotspot',
      pathNasId: 'site1-ap',
      rawQuery: 'a=b',
      ok: true,
    });
    expect(parsePostbackPath('/pb/aruba-ecp?a=b#frag')).toMatchObject({
      profile: 'aruba-ecp',
      pathNasId: null,
      rawQuery: 'a=b',
    });
    expect(parsePostbackPath('/pb/aruba-ecp/x/y/?a').ok).toBe(false);
    expect(parsePostbackPath('/pb/Bad Profile/?a').ok).toBe(false);
    expect(parsePostbackPath('/pb/aruba-ecp/<script>/?a').ok).toBe(false);
  });
});

describe('login URL validation (never an arbitrary site)', () => {
  const rules = {
    schemes: ['http', 'https'] as const,
    ports: [80, 443, 8443],
    path: /^\/[A-Za-z0-9._~/-]{0,128}$/,
    allowedHosts: new Set(['192.0.2.1', 'wlc.example.net']),
    interceptHosts: ['securelogin.arubanetworks.com'],
  };
  it.each([
    'http://10.0.0.1/login.html',
    'https://172.16.5.5:8443/login',
    'http://192.168.1.1/',
    'http://192.0.2.1/login.html',
    'https://wlc.example.net/login',
    'https://securelogin.arubanetworks.com/cgi-bin/login',
  ])('accepts %s', (url) => {
    expect(checkLoginUrl(url, rules)).not.toBeNull();
  });

  it.each([
    'http://evil.example.com/login',
    'http://100.64.0.1/x', // CGNAT is not a login-page class (review M2)
    'http://10.0.0.5:6379/anything', // undocumented port (review M1 probe)
    'http://10.0.0.5:22/',
    'https://8.8.8.8/login',
    'http://127.0.0.1/login',
    'http://169.254.169.254/latest/meta-data',
    'http://0.0.0.0/',
    'http://localhost/login',
    'http://[::1]/login',
    'http://[fd00::1]/login',
    'http://10.0.0.1@evil.example.com/',
    'http://user:pw@10.0.0.1/',
    'http:\\\\evil.example.com\\login',
    'javascript:alert(1)',
    'data:text/html,x',
    'ftp://10.0.0.1/',
    'http://10.0.0.1/login#x',
    'http://10.0.0.1/lo gin',
    'http://securelogin.arubanetworks.com.evil.example/',
    'http://224.0.0.1/',
    'http://0x7f000001/',
    `http://10.0.0.1/${'a'.repeat(600)}`,
  ])('refuses %s', (url) => {
    expect(checkLoginUrl(url, rules)).toBeNull();
  });

  it('refuses a vendor login host that is a public address unless registered / configured', () => {
    const cisco = profile('cisco-webauth');
    const pub = { switch_url: 'http://203.0.113.9/login.html' };
    expect(resolveLoginUrl(cisco, DEFAULT_POSTBACK_OPTIONS, pub)).toBeNull();
    expect(resolveLoginUrl(cisco, { ...DEFAULT_POSTBACK_OPTIONS, nasIp: '203.0.113.9' }, pub)).toBe(
      'http://203.0.113.9/login.html',
    );
    expect(
      resolveLoginUrl(cisco, { ...DEFAULT_POSTBACK_OPTIONS, loginHosts: ['203.0.113.9'] }, pub),
    ).toBe('http://203.0.113.9/login.html');
  });

  it('param-host targets accept a bare host only and fix scheme, port and path', () => {
    const cambium = profile('cambium-hotspot');
    const o = DEFAULT_POSTBACK_OPTIONS;
    expect(resolveLoginUrl(cambium, o, { ga_srvr: '10.20.0.2' })).toBe(
      'http://10.20.0.2:880/cgi-bin/hotspot_login.cgi',
    );
    expect(resolveLoginUrl(cambium, { ...o, https: true }, { ga_srvr: '10.20.0.2' })).toBe(
      'https://10.20.0.2:444/cgi-bin/hotspot_login.cgi',
    );
    for (const bad of [
      '10.20.0.2:8080',
      'http://10.20.0.2',
      '10.20.0.2/x',
      'evil.example.com',
      '8.8.8.8',
      '010.20.0.2',
      '127.0.0.1',
      '10.0.0.1@evil.example.com',
    ])
      expect(resolveLoginUrl(cambium, o, { ga_srvr: bad }), bad).toBeNull();
  });

  it('Fortinet: only the documented /fgtauth path; Omada: port and scheme from the redirect', () => {
    const f = profile('fortinet-ecp');
    expect(
      resolveLoginUrl(f, DEFAULT_POSTBACK_OPTIONS, { post: 'http://10.20.0.1:1000/fgtauth' }),
    ).toBe('http://10.20.0.1:1000/fgtauth');
    expect(
      resolveLoginUrl(f, DEFAULT_POSTBACK_OPTIONS, { post: 'http://10.20.0.1:1000/other' }),
    ).toBeNull();
    const o = profile('omada-external-portal');
    expect(
      resolveLoginUrl(o, DEFAULT_POSTBACK_OPTIONS, {
        target: '10.20.0.5',
        targetPort: '8088',
        scheme: 'http',
      }),
    ).toBe('http://10.20.0.5:8088/portal/radius/browserauth');
    expect(
      resolveLoginUrl(o, DEFAULT_POSTBACK_OPTIONS, { target: '10.20.0.5', targetPort: '99999' }),
    ).toBeNull();
    expect(
      resolveLoginUrl(o, DEFAULT_POSTBACK_OPTIONS, { target: '10.20.0.5', scheme: 'gopher' }),
    ).toBeNull();
  });

  it('Aruba: fixed securelogin by default, switchip when configured', () => {
    const a = profile('aruba-ecp');
    expect(resolveLoginUrl(a, DEFAULT_POSTBACK_OPTIONS, {})).toBe(
      'https://securelogin.arubanetworks.com/cgi-bin/login',
    );
    expect(
      resolveLoginUrl(
        a,
        { ...DEFAULT_POSTBACK_OPTIONS, loginTarget: 'switchip' },
        {
          switchip: '10.20.0.2',
        },
      ),
    ).toBe('https://10.20.0.2/cgi-bin/login');
    expect(
      resolveLoginUrl(
        a,
        { ...DEFAULT_POSTBACK_OPTIONS, loginTarget: 'switchip' },
        {
          switchip: 'evil.example.com',
        },
      ),
    ).toBeNull();
  });
});

describe('validateContext and hand-off per profile', () => {
  it('Cambium: nasid from ga_nas_id, raw query appended byte-for-byte, ga_user / ga_pass', async () => {
    const log: LookupLog = { findNas: [], replay: [] };
    const cfg = { profile: 'cambium-hotspot' };
    const built = postbackAdapterForNas({ adapterConfig: cfg, nasIp: '10.20.0.2' });
    const parsed = built?.adapter.parseRedirect({
      url: `/pb/cambium-hotspot/?${CAMBIUM_Q}`,
      method: 'GET',
    });
    if (!built || !parsed || 'unsupported' in parsed) throw new Error('parse');
    const v = await built.adapter.validateContext(parsed, lookup(nas(cfg), { log }));
    if (!v.ok) throw new Error(v.detail);
    expect(log.findNas).toEqual([{ nasid: 'site1-ap', called: null, apMac: AP }]);
    expect(log.replay).toEqual([
      {
        nasId: NAS,
        sessionId: null,
        challenge: 'eUROAh8YBgIUOwkNBgo%2BGBo%01%1B',
        clientMac: '',
        nonceKind: 'vendor-nonce',
      },
    ]);
    expect([v.context.clientMac, v.context.apMac, v.context.ssid]).toEqual([CLIENT, AP, 'Guest']);
    const h = built.adapter.authorizeSession(v.context, credential);
    if ('unsupported' in h) throw new Error(h.reason);
    expect(h.browser?.method).toBe('POST-form');
    expect(h.browser?.url).toBe(`http://10.20.0.2:880/cgi-bin/hotspot_login.cgi?${CAMBIUM_Q}`);
    expect(h.browser?.fields).toEqual({
      ga_user: credential.username,
      ga_pass: credential.password,
    });
    expect(postbackVendorNonce(profile('cambium-hotspot'), CAMBIUM_Q)).toBe(
      'eUROAh8YBgIUOwkNBgo%2BGBo%01%1B',
    );
  });

  it('Aruba: verified AP MAC identity, cmd=authenticate, user / password / url', async () => {
    const log: LookupLog = { findNas: [], replay: [] };
    const cfg = { profile: 'aruba-ecp' };
    const built = postbackAdapterForNas({ adapterConfig: cfg, nasIp: '10.20.0.2' });
    const parsed = built?.adapter.parseRedirect({
      url: `/pb/aruba-ecp/?${ARUBA_Q}`,
      method: 'GET',
    });
    if (!built || !parsed || 'unsupported' in parsed) throw new Error('parse');
    const v = await built.adapter.validateContext(parsed, lookup(nas(cfg), { log }));
    if (!v.ok) throw new Error(v.detail);
    expect(log.findNas).toEqual([{ nasid: null, called: null, apMac: AP }]);
    expect(log.replay).toEqual([]); // no vendor nonce: the ECLOUD login token covers replay
    const h = built.adapter.authorizeSession(v.context, credential);
    if ('unsupported' in h) throw new Error(h.reason);
    expect(h.browser).toEqual({
      method: 'POST-form',
      url: 'https://securelogin.arubanetworks.com/cgi-bin/login',
      fields: {
        cmd: 'authenticate',
        url: 'http://example.com/',
        user: credential.username,
        password: credential.password,
      },
    });
  });

  it('Cisco: switch_url target, buttonClicked=4 / err_flag=0', async () => {
    const cfg = { profile: 'cisco-webauth', login_hosts: ['192.0.2.1'] };
    const ctx = await contextFor('cisco-webauth', `/pb/cisco-webauth/site1-ap/?${CISCO_Q}`, cfg);
    const built = postbackAdapterForNas({ adapterConfig: cfg, nasIp: '10.20.0.2' });
    const h = built?.adapter.authorizeSession(ctx, credential);
    if (!h || 'unsupported' in h) throw new Error('handoff');
    expect(h.browser).toEqual({
      method: 'POST-form',
      url: 'http://192.0.2.1/login.html',
      fields: {
        buttonClicked: '4',
        err_flag: '0',
        username: credential.username,
        password: credential.password,
      },
    });
  });

  it('Fortinet: magic echoed, POST to /fgtauth, 125-character post-data limit', async () => {
    const ctx = await contextFor('fortinet-ecp', `/pb/fortinet-ecp/site1-ap/?${FORTINET_Q}`);
    const built = postbackAdapterForNas({
      adapterConfig: { profile: 'fortinet-ecp' },
      nasIp: '10.20.0.2',
    });
    const h = built?.adapter.authorizeSession(ctx, credential);
    if (!h || 'unsupported' in h) throw new Error('handoff');
    expect(h.browser?.url).toBe('http://10.20.0.1:1000/fgtauth');
    expect(h.browser?.fields).toEqual({
      magic: '0a1b2c3d4e5f',
      username: credential.username,
      password: credential.password,
    });
    const long = FORTINET_Q.replace('magic=0a1b2c3d4e5f', `magic=${'f'.repeat(120)}`);
    const ctx2 = await contextFor('fortinet-ecp', `/pb/fortinet-ecp/site1-ap/?${long}`);
    expect(built?.adapter.authorizeSession(ctx2, credential)).toMatchObject({ unsupported: true });
  });

  it('Ruckus: sip :9997/login, ip echoed from uip', async () => {
    const ctx = await contextFor('ruckus-wispr', `/pb/ruckus-wispr/site1-ap/?${RUCKUS_Q}`);
    const h = postbackAdapterForNas({
      adapterConfig: { profile: 'ruckus-wispr' },
      nasIp: null,
    })?.adapter.authorizeSession(ctx, credential);
    if (!h || 'unsupported' in h) throw new Error('handoff');
    expect(h.browser?.url).toBe('http://10.20.0.2:9997/login');
    expect(h.browser?.fields).toMatchObject({ ip: '10.30.0.15', username: credential.username });
  });

  it('Ruckus ZoneDirector redirect without a client MAC is refused', async () => {
    const built = postbackAdapterForNas({
      adapterConfig: { profile: 'ruckus-wispr' },
      nasIp: null,
    });
    const parsed = built?.adapter.parseRedirect({
      url: '/pb/ruckus-wispr/site1-ap/?sip=10.20.0.2&mac=00:04:56:aa:bb:cc&uip=10.30.0.15&lid=x&dn=y',
      method: 'GET',
    });
    if (!built || !parsed || 'unsupported' in parsed) throw new Error('parse');
    const v = await built.adapter.validateContext(parsed, lookup(nas({ profile: 'ruckus-wispr' })));
    expect(v).toMatchObject({ ok: false, reason: 'malformed' });
  });

  it('Omada: echoes the documented fields with authType=2 to browserauth', async () => {
    const ctx = await contextFor(
      'omada-external-portal',
      `/pb/omada-external-portal/site1-ap/?${OMADA_Q}`,
    );
    const h = postbackAdapterForNas({
      adapterConfig: { profile: 'omada-external-portal' },
      nasIp: null,
    })?.adapter.authorizeSession(ctx, credential);
    if (!h || 'unsupported' in h) throw new Error('handoff');
    expect(h.browser?.url).toBe('https://10.20.0.5:8843/portal/radius/browserauth');
    expect(h.browser?.fields).toEqual({
      authType: '2',
      clientMac: 'AA-BB-CC-00-11-22',
      clientIP: '10.30.0.15',
      apMac: '00-04-56-AA-BB-CC',
      ssidName: 'Guest',
      radioId: '1',
      originUrl: 'http://example.com/',
      username: credential.username,
      password: credential.password,
    });
  });

  it('Huawei eKit: loginurl target (HTTP-family only)', async () => {
    const ctx = await contextFor('huawei-portal', `/pb/huawei-portal/site1-ap/?${HUAWEI_Q}`);
    const h = postbackAdapterForNas({
      adapterConfig: { profile: 'huawei-portal' },
      nasIp: null,
    })?.adapter.authorizeSession(ctx, credential);
    if (!h || 'unsupported' in h) throw new Error('handoff');
    expect(h.browser?.url).toBe('https://10.20.0.7/login');
  });

  it('rejection cases fail closed', async () => {
    const cfg = { profile: 'cambium-hotspot' };
    const built = postbackAdapterForNas({ adapterConfig: cfg, nasIp: '10.20.0.2' });
    if (!built) throw new Error('cfg');
    const run = async (url: string, l: NasLookup) => {
      const parsed = built.adapter.parseRedirect({ url, method: 'GET' });
      if ('unsupported' in parsed) return { ok: false, reason: 'unsupported' };
      return built.adapter.validateContext(parsed, l);
    };
    const base = `/pb/cambium-hotspot/?${CAMBIUM_Q}`;
    // foreign login host
    expect(
      await run(base.replace('ga_srvr=10.20.0.2', 'ga_srvr=evil.example.com'), lookup(nas(cfg))),
    ).toMatchObject({ ok: false, reason: 'private_address_required' });
    // duplicate parameter (parameter pollution)
    expect(await run(`${base}&ga_cmac=AA-BB-CC-00-11-99`, lookup(nas(cfg)))).toMatchObject({
      ok: false,
      reason: 'malformed',
    });
    // replayed vendor nonce
    expect(await run(base, lookup(nas(cfg), { replayed: true }))).toMatchObject({
      ok: false,
      reason: 'replayed',
    });
    // unknown NAS (e.g. unverified AP MAC → findNas null)
    expect(await run(base, lookup(null))).toMatchObject({ ok: false, reason: 'unknown_nas' });
    // NAS of another adapter or profile
    expect(await run(base, lookup(nas(cfg, { adapterKey: 'coovachilli-uam' })))).toMatchObject({
      ok: false,
      reason: 'unknown_nas',
    });
    expect(await run(base, lookup(nas({ profile: 'aruba-ecp' })))).toMatchObject({
      ok: false,
      reason: 'unknown_nas',
    });
    // cross-tenant: the request is bound to another organization
    expect(
      await run(base, lookup(nas(cfg), { expected: '99999999-9999-4999-8999-999999999999' })),
    ).toMatchObject({ ok: false, reason: 'tenant_mismatch' });
    // path nasid and ga_nas_id disagree
    expect(await run(`/pb/cambium-hotspot/other-ap/?${CAMBIUM_Q}`, lookup(nas(cfg)))).toMatchObject(
      { ok: false, reason: 'malformed' },
    );
    // a portal path naming another profile
    expect(
      built.adapter.parseRedirect({ url: `/pb/aruba-ecp/?${CAMBIUM_Q}`, method: 'GET' }),
    ).toMatchObject({
      unsupported: true,
    });
    // client MAC missing / multicast
    expect(
      await run(
        base.replace('ga_cmac=AA-BB-CC-00-11-22', 'ga_cmac=01-00-5E-00-00-01'),
        lookup(nas(cfg)),
      ),
    ).toMatchObject({ ok: false, reason: 'malformed' });
    // no replay check supplied → fail closed
    const noReplay = { ...lookup(nas(cfg)), isReplay: undefined } as unknown as NasLookup;
    expect(await run(base, noReplay)).toMatchObject({ ok: false, reason: 'replayed' });
  });

  it('authorizeSession refuses credentials bound elsewhere or expired', async () => {
    const ctx = await contextFor('cambium-hotspot', `/pb/cambium-hotspot/?${CAMBIUM_Q}`);
    const a = createPostbackVendorAdapter(profile('cambium-hotspot'));
    expect(
      a.authorizeSession(ctx, { ...credential, boundClientMac: 'aa:bb:cc:00:11:99' }),
    ).toMatchObject({ unsupported: true });
    expect(a.authorizeSession(ctx, { ...credential, boundNasId: SITE })).toMatchObject({
      unsupported: true,
    });
    expect(a.authorizeSession(ctx, { ...credential, expiresAt: NOW })).toMatchObject({
      unsupported: true,
    });
  });
});

describe('generic ("any vendor") profile', () => {
  const generic = {
    profile: GENERIC_POSTBACK_PROFILE_KEY,
    generic: {
      params: {
        client_mac: 'client_mac',
        ap_mac: 'ap_mac',
        login_url: 'login_url',
        continue_url: 'redirect',
        vendor_token: 'token',
      },
      fields: { username: 'user', password: 'pass', vendor_token: 'token' },
      method: 'POST',
      constants: { action: 'login' },
      login_path: '/auth',
    },
  };

  it('validates and normalises the NAS config', () => {
    const r = parsePostbackNasConfig(generic);
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    expect(serializePostbackNasConfig(r.config)).toEqual({
      profile: 'postback-generic',
      generic: {
        params: generic.generic.params,
        fields: generic.generic.fields,
        method: 'POST',
        constants: { action: 'login' },
        login_path: '/auth',
      },
    });
    expect(profileForConfig(r.config)?.pathNasIdRequired).toBe(true);
  });

  it.each([
    [{ profile: 'nope' }, 'profile'],
    [{ profile: 'cambium-hotspot', extra: 1 }, 'adapter_config.extra'],
    [{ profile: 'cambium-hotspot', login_target: 'switchip' }, 'login_target'],
    [{ profile: 'cambium-hotspot', login_hosts: ['127.0.0.1'] }, 'login_hosts.0'],
    [{ profile: 'cambium-hotspot', login_hosts: ['169.254.169.254'] }, 'login_hosts.0'],
    [{ profile: 'cambium-hotspot', login_hosts: ['localhost'] }, 'login_hosts.0'],
    [{ profile: 'cambium-hotspot', login_hosts: Array(9).fill('10.0.0.1') }, 'login_hosts'],
    [{ profile: 'cambium-hotspot', generic: {} }, 'generic'],
    [{ profile: 'postback-generic' }, 'generic'],
    [
      { profile: 'postback-generic', generic: { params: { client_mac: 'a b', login_url: 'u' } } },
      'generic.params.client_mac',
    ],
    [
      { profile: 'postback-generic', generic: { params: { client_mac: 'm', login_url: '<x>' } } },
      'generic.params.login_url',
    ],
    [
      { profile: 'postback-generic', generic: { params: { client_mac: 'm' } } },
      'generic.params.login_url',
    ],
    [
      { profile: 'postback-generic', generic: { params: { client_mac: 'm', login_url: 'm' } } },
      'generic.params',
    ],
    [
      {
        profile: 'postback-generic',
        generic: { params: { client_mac: 'm', login_url: 'u' }, constants: { a: '<script>' } },
      },
      'generic.constants.a',
    ],
    [
      {
        profile: 'postback-generic',
        generic: { params: { client_mac: 'm', login_url: 'u' }, method: 'PUT' },
      },
      'generic.method',
    ],
    [
      {
        profile: 'postback-generic',
        generic: { params: { client_mac: 'm', login_url: 'u', x: 'y' } },
      },
      'generic.params.x',
    ],
  ])('rejects %j', (input, path) => {
    const r = parsePostbackNasConfig(input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.map((e) => e.path)).toContain(path);
  });

  it('needs the NAS identifier in the path and posts the configured fields', async () => {
    const q =
      'client_mac=aa:bb:cc:00:11:22&ap_mac=00:04:56:aa:bb:cc&login_url=http%3A%2F%2F10.20.0.3%2Fauth&redirect=http%3A%2F%2Fexample.com%2F&token=XYZ';
    const built = postbackAdapterForNas({ adapterConfig: generic, nasIp: null });
    if (!built) throw new Error('cfg');
    const noPath = built.adapter.parseRedirect({
      url: `/pb/postback-generic/?${q}`,
      method: 'GET',
    });
    if ('unsupported' in noPath) throw new Error('parse');
    expect(await built.adapter.validateContext(noPath, lookup(nas(generic)))).toMatchObject({
      ok: false,
      reason: 'malformed',
    });
    const ctx = await contextFor(
      'postback-generic',
      `/pb/postback-generic/site1-ap/?${q}`,
      generic,
    );
    const h = built.adapter.authorizeSession(ctx, credential);
    if ('unsupported' in h) throw new Error(h.reason);
    expect(h.browser).toEqual({
      method: 'POST-form',
      url: 'http://10.20.0.3/auth',
      fields: {
        action: 'login',
        token: 'XYZ',
        user: credential.username,
        pass: credential.password,
      },
    });
  });

  it('GET method profiles hand off as a 302 with the fields in the query', async () => {
    const cfg = {
      profile: GENERIC_POSTBACK_PROFILE_KEY,
      generic: {
        params: { client_mac: 'cm', login_url: 'lu' },
        method: 'GET',
        login_path: '/login',
      },
    };
    const q = 'cm=aa:bb:cc:00:11:22&lu=http%3A%2F%2F10.20.0.3%2Flogin';
    const ctx = await contextFor('postback-generic', `/pb/postback-generic/site1-ap/?${q}`, cfg);
    const h = postbackAdapterForNas({ adapterConfig: cfg, nasIp: null })?.adapter.authorizeSession(
      ctx,
      credential,
    );
    if (!h || 'unsupported' in h) throw new Error('handoff');
    expect(h.browser?.method).toBe('GET-302');
    expect(h.browser?.url).toBe(
      `http://10.20.0.3/login?username=${credential.username}&password=${credential.password}`,
    );
  });
});

describe('review fixes (M1, M2, L2, L3, L4)', () => {
  const opts = DEFAULT_POSTBACK_OPTIONS;

  it('M1: param-url targets accept only the documented ports; generic uses its login_port / path', () => {
    const cisco = profile('cisco-webauth');
    expect(
      resolveLoginUrl(cisco, opts, { switch_url: 'http://10.0.0.5:6379/anything' }),
    ).toBeNull();
    expect(
      resolveLoginUrl(cisco, opts, { switch_url: 'http://10.0.0.5:8080/login.html' }),
    ).toBeNull();
    expect(resolveLoginUrl(cisco, opts, { switch_url: 'https://10.0.0.5/login.html' })).toBe(
      'https://10.0.0.5/login.html',
    );
    const forti = profile('fortinet-ecp');
    expect(resolveLoginUrl(forti, opts, { post: 'http://10.0.0.5:1001/fgtauth' })).toBeNull();
    const omada = profile('omada-external-portal');
    expect(
      resolveLoginUrl(omada, opts, { target: '10.0.0.5', targetPort: '6379', scheme: 'http' }),
    ).toBeNull();
    expect(resolveLoginUrl(omada, opts, { target: '10.0.0.5', scheme: 'https' })).toBeNull();
    const cfg = parsePostbackNasConfig({
      profile: GENERIC_POSTBACK_PROFILE_KEY,
      generic: {
        params: { client_mac: 'm', login_url: 'u' },
        login_path: '/auth',
        login_port: 8080,
      },
    });
    if (!cfg.ok) throw new Error('cfg');
    const g = profileForConfig(cfg.config);
    if (g === null) throw new Error('profile');
    expect(resolveLoginUrl(g, opts, { u: 'http://10.0.0.5:8080/auth' })).toBe(
      'http://10.0.0.5:8080/auth',
    );
    expect(resolveLoginUrl(g, opts, { u: 'http://10.0.0.5:6379/auth' })).toBeNull();
    expect(resolveLoginUrl(g, opts, { u: 'http://10.0.0.5:8080/anything' })).toBeNull();
    expect(resolveLoginUrl(g, opts, { u: 'http://10.0.0.5/auth' })).toBeNull();
    expect(
      parsePostbackNasConfig({
        profile: GENERIC_POSTBACK_PROFILE_KEY,
        generic: { params: { client_mac: 'm', login_url: 'u' }, login_path: 'auth', login_port: 0 },
      }),
    ).toMatchObject({ ok: false });
  });

  it('M2: strict login hosts accept only the NAS IP, login hosts and intercept names', () => {
    const cambium = profile('cambium-hotspot');
    const strict = { ...opts, strictLoginHosts: true, nasIp: '10.20.0.2' };
    expect(resolveLoginUrl(cambium, strict, { ga_srvr: '10.20.0.2' })).not.toBeNull();
    expect(resolveLoginUrl(cambium, strict, { ga_srvr: '10.20.0.9' })).toBeNull();
    expect(resolveLoginUrl(cambium, opts, { ga_srvr: '10.20.0.9' })).not.toBeNull();
    // strict without any known host falls back to the private rule (nothing to be strict about)
    expect(
      resolveLoginUrl(cambium, { ...opts, strictLoginHosts: true }, { ga_srvr: '10.20.0.9' }),
    ).not.toBeNull();
    // CGNAT only as an explicit host
    expect(resolveLoginUrl(cambium, opts, { ga_srvr: '100.64.0.7' })).toBeNull();
    expect(
      resolveLoginUrl(cambium, { ...opts, loginHosts: ['100.64.0.7'] }, { ga_srvr: '100.64.0.7' }),
    ).not.toBeNull();
    // documented intercept names stay valid in strict mode
    expect(resolveLoginUrl(profile('aruba-ecp'), strict, {})).toBe(
      'https://securelogin.arubanetworks.com/cgi-bin/login',
    );
    const parsed = parsePostbackNasConfig({ profile: 'cambium-hotspot', strict_login_hosts: true });
    expect(parsed.ok && parsed.config.strict_login_hosts).toBe(true);
    expect(
      parsePostbackNasConfig({ profile: 'cambium-hotspot', strict_login_hosts: 'yes' }).ok,
    ).toBe(false);
  });

  it('L2: inherited names (constructor, toString, __proto__) are not parameters', () => {
    const q = splitPostbackQuery('constructor=x&__proto__=y&a=1');
    expect(q.params.a).toBe('1');
    expect(q.params.constructor).toBe('x');
    expect(Object.getPrototypeOf(q.params)).toBeNull();
    expect('toString' in splitPostbackQuery('a=1').params).toBe(false);
    // a profile whose names collide with Object.prototype members resolves nothing
    const cfg = parsePostbackNasConfig({
      profile: GENERIC_POSTBACK_PROFILE_KEY,
      generic: { params: { client_mac: 'toString', login_url: 'constructor' }, login_path: '/a' },
    });
    if (!cfg.ok) throw new Error('cfg');
    const g = profileForConfig(cfg.config);
    if (g === null) throw new Error('profile');
    expect(resolveLoginUrl(g, opts, splitPostbackQuery('x=1').params)).toBeNull();
    expect(resolveLoginUrl(g, opts, {})).toBeNull();
  });

  it('L3: the vendor-nonce replay key is NAS + exact nonce (no client MAC)', async () => {
    const log: LookupLog = { findNas: [], replay: [] };
    const cfg = { profile: 'fortinet-ecp' };
    const built = postbackAdapterForNas({ adapterConfig: cfg, nasIp: null });
    const parsed = built?.adapter.parseRedirect({
      url: `/pb/fortinet-ecp/site1-ap/?${FORTINET_Q.replace('0a1b2c3d4e5f', 'AbC%2B1')}`,
      method: 'GET',
    });
    if (!built || !parsed || 'unsupported' in parsed) throw new Error('parse');
    await built.adapter.validateContext(parsed, lookup(nas(cfg), { log }));
    expect(log.replay).toEqual([
      {
        nasId: NAS,
        sessionId: null,
        challenge: 'AbC%2B1',
        clientMac: '',
        nonceKind: 'vendor-nonce',
      },
    ]);
  });

  it('L4: GET profiles and http transport are flagged in the setup guide', () => {
    const cfg = parsePostbackNasConfig({
      profile: GENERIC_POSTBACK_PROFILE_KEY,
      generic: { params: { client_mac: 'm', login_url: 'u' }, method: 'GET', login_path: '/a' },
    });
    if (!cfg.ok) throw new Error('cfg');
    const g = profileForConfig(cfg.config);
    if (g === null) throw new Error('profile');
    const ids = postbackSetupGuide(g, { siteId: SITE, nasId: 'n1' }).map((x) => x.id);
    expect(ids).toEqual(expect.arrayContaining(['get-warning', 'transport', 'login-hosts']));
    expect(
      postbackSetupGuide(profile('cambium-hotspot'), { siteId: SITE, nasId: 'n1' }).map(
        (x) => x.id,
      ),
    ).not.toContain('get-warning');
  });
});

describe('setup guides', () => {
  it('every profile has filled ECLOUD values and placeholders only for secrets', () => {
    for (const p of [...BUILTIN_POSTBACK_PROFILES]) {
      const steps = postbackSetupGuide(p, { siteId: SITE, nasId: 'site1-ap' });
      expect(steps[0]?.value).toBe(`https://portal.ezecloud.ezelink.ai/pb/${p.key}/site1-ap/`);
      expect(steps.length).toBeGreaterThan(6);
      for (const s of steps) {
        expect(s.evidenceRefs.length).toBeGreaterThan(0);
        if (/secret/i.test(s.setting)) expect(s.value).toMatch(/<[A-Z_]+>/);
        expect(s.value).not.toMatch(/password|secret=/i);
      }
    }
    const bad = postbackSetupGuide(profile('aruba-ecp'), { siteId: SITE, nasId: 'has space' });
    expect(bad[0]?.value).toContain('<NAS_IDENTIFIER>');
  });
});
