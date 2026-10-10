import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  openVendorCredential,
  testVendorConnection,
  tlsTrustOf,
  validateVendorApiSettings,
  type StoredVendorCredential,
} from './credentials.js';
import { VendorApiError } from './errors.js';
import {
  DEFAULT_DENY_CIDRS,
  VendorHttpClient,
  isCertificatePem,
  parseDenyCidrs,
  type VendorTarget,
} from './http.js';
import { runCli } from './cli.js';
import { buildMistGrant, phpUrlencode } from './mist.js';
import { OmadaHotspotClient } from './omada.js';
import { parseMistRedirect, parseOmadaRedirect, parseUnifiRedirect } from './redirects.js';
import { RUCKUS_NBI_STATUS, ruckusNbiLogin } from './ruckus.js';
import {
  SealedSecretError,
  deriveVendorApiKey,
  isDerivedVendorApiKey,
  openSealedSecret,
  sealSecret,
} from './sealed.js';
import {
  allowLoopback,
  json,
  loopbackResolver,
  startMockController,
  testPki,
  type MockController,
} from '@ecloud/testing';
import { UnifiNetworkClient } from './unifi.js';

const DEK = 'ecloud_test_data_encryption_key_0123456789';
const http = () =>
  new VendorHttpClient({
    resolve: loopbackResolver,
    addressAllowed: allowLoopback,
    allowedPorts: [mock.port],
  });

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'resolved';
  } catch (error) {
    if (error instanceof VendorApiError) return error.code;
    throw error;
  }
}

let mock: MockController;
let target: VendorTarget;
beforeAll(async () => {
  mock = await startMockController();
  target = {
    controllerId: 'c1',
    baseUrl: `https://controller.test:${String(mock.port)}/proxy/network/integration`,
    kind: 'on_premises',
    tls: { mode: 'ca', caPem: testPki().caPem },
  };
});
afterAll(() => mock.close());

describe('UniFi Network API client (mocked controller)', () => {
  const SITE = '88f7af54-98f8-306a-a1c7-c9349722b1f6';

  it('finds the client by MAC and authorises it with the documented action body', async () => {
    mock.handler = (req, res) => {
      if (req.headers['x-api-key'] !== 'test-api-key') return json(res, 401, {});
      if (req.method === 'GET') {
        return json(res, 200, {
          offset: 0,
          limit: 25,
          count: 1,
          totalCount: 1,
          data: [
            {
              id: 'client-1',
              macAddress: 'AA:BB:CC:00:11:22',
              type: 'WIRELESS',
              access: { type: 'GUEST' },
            },
          ],
        });
      }
      return json(res, 200, {});
    };
    const c = new UnifiNetworkClient(http(), target, 'test-api-key', SITE);
    const found = await c.findClientByMac('aa:bb:cc:00:11:22');
    expect(found).toEqual({ id: 'client-1', macAddress: 'aa:bb:cc:00:11:22', accessType: 'GUEST' });
    const get = mock.requests.at(-1);
    expect(decodeURIComponent(get?.url ?? '')).toBe(
      `/proxy/network/integration/v1/sites/${SITE}/clients?filter=macAddress.eq('aa:bb:cc:00:11:22')`,
    );
    await c.authorizeGuest('client-1', {
      timeLimitMinutes: 60,
      dataUsageLimitMBytes: 500,
      rxRateLimitKbps: 4000,
    });
    const post = mock.requests.at(-1);
    expect(post?.url).toBe(`/proxy/network/integration/v1/sites/${SITE}/clients/client-1/actions`);
    expect(JSON.parse(post?.body ?? '')).toEqual({
      action: 'AUTHORIZE_GUEST_ACCESS',
      timeLimitMinutes: 60,
      dataUsageLimitMBytes: 500,
      rxRateLimitKbps: 4000,
    });
  });

  it('maps a refused API key to auth_failed and an unknown MAC to null', async () => {
    const bad = new UnifiNetworkClient(http(), target, 'wrong', SITE);
    expect(await codeOf(bad.findClientByMac('aa:bb:cc:00:11:22'))).toBe('auth_failed');
    mock.handler = (_req, res) => json(res, 200, { data: [] });
    const c = new UnifiNetworkClient(http(), target, 'k', SITE);
    expect(await c.findClientByMac('aa:bb:cc:00:11:22')).toBeNull();
    mock.handler = (_req, res) => json(res, 200, { nope: true });
    expect(await codeOf(c.findClientByMac('aa:bb:cc:00:11:22'))).toBe('invalid_response');
    expect(() => new UnifiNetworkClient(http(), target, 'k', '../x')).toThrow(VendorApiError);
    expect(await codeOf(c.authorizeGuest('client-1', { timeLimitMinutes: 0 }))).toBe(
      'invalid_target',
    );
  });

  it('pages through the device inventory', async () => {
    mock.handler = (req, res) => {
      const offset = Number(new URL(req.url, 'https://x').searchParams.get('offset'));
      const data =
        offset === 0
          ? Array.from({ length: 200 }, (_, i) => ({
              macAddress: `02:00:00:00:${String(Math.floor(i / 100)).padStart(2, '0')}:${String(i % 100).padStart(2, '0')}`,
            }))
          : [{ macAddress: '02:00:00:00:99:99' }];
      json(res, 200, { data, totalCount: 201 });
    };
    const macs = await new UnifiNetworkClient(http(), target, 'k', SITE).listDeviceMacs();
    expect(macs).toHaveLength(201);
    expect(macs.at(-1)).toBe('02:00:00:00:99:99');
  });
});

describe('Omada hotspot operator API client (mocked controller, 6.2.10 form)', () => {
  const creds = { operator: 'hotspot-op', password: 'test-pass', omadacId: 'abcdef0123456789' };

  it('logs in, then posts extPortal/auth with Csrf-Token + session cookie', async () => {
    mock.handler = (req, res) => {
      if (req.url.endsWith('/hotspot/login')) {
        const body = JSON.parse(req.body) as { name: string; password: string };
        if (body.password !== 'test-pass') return json(res, 200, { errorCode: -30109, msg: 'x' });
        return json(
          res,
          200,
          { errorCode: 0, result: { token: 'csrf0123456789abcdef' } },
          {
            'set-cookie': ['TPOMADA_SESSIONID=sess123; Path=/; HttpOnly'],
          },
        );
      }
      if (
        req.headers['csrf-token'] !== 'csrf0123456789abcdef' ||
        req.headers.cookie !== 'TPOMADA_SESSIONID=sess123'
      ) {
        return json(res, 200, { errorCode: -1 });
      }
      return json(res, 200, { errorCode: 0 });
    };
    const c = new OmadaHotspotClient(
      http(),
      { ...target, baseUrl: `https://controller.test:${String(mock.port)}` },
      creds,
    );
    await c.authorizeClient({
      clientMac: 'AA-BB-CC-00-11-22',
      clientIp: '192.168.0.10',
      apMac: '02-00-00-00-00-01',
      ssidName: 'Guest',
      radioId: '1',
      timeMs: 3_600_000,
      totalTrafficLimitBytes: 1_000_000,
      downloadRateLimitKbps: 2000,
    });
    const auth = mock.requests.at(-1);
    expect(auth?.url).toBe('/abcdef0123456789/api/v2/hotspot/extPortal/auth');
    expect(JSON.parse(auth?.body ?? '')).toEqual({
      clientMac: 'AA-BB-CC-00-11-22',
      clientIp: '192.168.0.10',
      apMac: '02-00-00-00-00-01',
      ssidName: 'Guest',
      radioId: '1',
      time: 3_600_000,
      authType: 4,
      originUrl: '',
      totalTrafficLimitBytes: 1_000_000,
      downloadRateLimitKbps: 2000,
    });
    const bad = new OmadaHotspotClient(
      http(),
      { ...target, baseUrl: `https://controller.test:${String(mock.port)}` },
      { ...creds, password: 'wrong' },
    );
    expect(await codeOf(bad.testConnection())).toBe('auth_failed');
  });

  it('maps a non-zero errorCode on auth to vendor_rejected and refuses ambiguous bodies', async () => {
    mock.handler = (req, res) =>
      req.url.endsWith('/login')
        ? json(
            res,
            200,
            { errorCode: 0, result: { token: 'csrf0123456789abcdef' } },
            { 'set-cookie': 'TPEAP_SESSIONID=old' },
          )
        : json(res, 200, { errorCode: -41501 });
    const c = new OmadaHotspotClient(
      http(),
      { ...target, baseUrl: `https://controller.test:${String(mock.port)}` },
      creds,
    );
    expect(
      await codeOf(
        c.authorizeClient({
          clientMac: 'a',
          apMac: 'b',
          ssidName: 's',
          radioId: '0',
          timeMs: 60_000,
        }),
      ),
    ).toBe('vendor_rejected');
    expect(await codeOf(c.authorizeClient({ clientMac: 'a', timeMs: 60_000 }))).toBe(
      'invalid_target',
    );
    expect(() => new OmadaHotspotClient(http(), target, { ...creds, omadacId: '../x' })).toThrow(
      VendorApiError,
    );
  });
});

describe('Mist signed grant', () => {
  it('reproduces the vendor worked example (juniper.net Read-Me, /authorize-test)', () => {
    const grant = buildMistGrant({
      secret: 'test-secret',
      wlanId: 'be22bba7-8e22-e1cf-5185-b880816fe2cf',
      apMac: '5c5b35001234',
      clientMac: 'd58f6bb4c9d8',
      authorizeMinutes: 480,
      expires: 1768587994,
      forward: 'http://www.mist.com/',
      endpoint: '/authorize-test',
    });
    expect(grant.payload).toBe(
      'expires=1768587994&token=YmUyMmJiYTctOGUyMi1lMWNmLTUxODUtYjg4MDgxNmZlMmNmLzVjNWIzNTAwMTIzNC9kNThmNmJiNGM5ZDgvNDgwLzAvMC8w&forward=http%3A%2F%2Fwww.mist.com%2F', // public vendor doc example, check-no-secrets: allow
    );
    expect(grant.signature).toBe('J7VJlf2Zlcs%2BOxhVxCf8hL0XYC0%3D');
    expect(grant.url.startsWith('https://portal.mist.com/authorize-test?signature=J7VJ')).toBe(
      true,
    );
  });

  it('refuses foreign hosts and malformed inputs; php urlencode semantics', () => {
    const base = {
      secret: 's',
      wlanId: 'be22bba7-8e22-e1cf-5185-b880816fe2cf',
      apMac: '5c5b35001234',
      clientMac: 'd58f6bb4c9d8',
      authorizeMinutes: 1,
      expires: 1,
    };
    expect(() => buildMistGrant({ ...base, host: 'evil.example' })).toThrow(VendorApiError);
    expect(() => buildMistGrant({ ...base, host: 'portal.mist.com.evil.example' })).toThrow(
      VendorApiError,
    );
    expect(buildMistGrant({ ...base, host: 'portal.eu.mist.com' }).url).toContain(
      'https://portal.eu.mist.com/authorize?',
    );
    expect(() => buildMistGrant({ ...base, apMac: '5c:5b:35:00:12:34' })).toThrow(VendorApiError);
    expect(() => buildMistGrant({ ...base, authorizeMinutes: 0 })).toThrow(VendorApiError);
    expect(phpUrlencode("a b~!*'()")).toBe('a+b%7E%21%2A%27%28%29');
  });
});

describe('redirect parsers (documented names only)', () => {
  it('UniFi: path site + ap/id/t/url/ssid', () => {
    const r = parseUnifiRedirect(
      '/guest/s/default/',
      'ap=02:00:00:00:00:01&id=AA:BB:CC:00:11:22&t=1700000000&url=http%3A%2F%2Fexample.com%2F&ssid=Guest',
    );
    expect(r).toMatchObject({
      adapterKey: 'unifi-external-portal',
      clientMac: 'aa:bb:cc:00:11:22',
      apMac: '02:00:00:00:00:01',
      ssid: 'Guest',
      continueUrl: 'http://example.com/',
    });
    expect(r?.fields.unifi_site).toBe('default');
    expect(
      parseUnifiRedirect('/guest/s/../', 'ap=02:00:00:00:00:01&id=aa:bb:cc:00:11:22'),
    ).toBeNull();
    expect(
      parseUnifiRedirect(
        '/guest/s/default/',
        'ap=02:00:00:00:00:01&id=aa:bb:cc:00:11:22&id=aa:bb:cc:00:11:23',
      ),
    ).toBeNull();
    expect(
      parseUnifiRedirect('/guest/s/default/', 'ap=01:00:5e:00:00:01&id=aa:bb:cc:00:11:22'),
    ).toBeNull(); // multicast AP
  });

  it('Omada: EAP and gateway forms; case variants are not read', () => {
    const eap = parseOmadaRedirect(
      'clientMac=AA-BB-CC-00-11-22&clientIp=192.168.0.10&apMac=02-00-00-00-00-01&ssidName=Guest&t=1700000000000&radioId=1&site=Default&redirectUrl=http%3A%2F%2Fexample.com',
    );
    expect(eap).toMatchObject({
      adapterKey: 'omada-api',
      clientMac: 'aa:bb:cc:00:11:22',
      apMac: '02:00:00:00:00:01',
      clientIp: '192.168.0.10',
    });
    expect(eap?.fields).toMatchObject({
      clientMac: 'AA-BB-CC-00-11-22',
      apMac: '02-00-00-00-00-01',
      radioId: '1',
      site: 'Default',
    });
    const gw = parseOmadaRedirect(
      'clientMac=AA-BB-CC-00-11-22&gatewayMac=02-00-00-00-00-09&vid=10&site=Default&t=1',
    );
    expect(gw).toMatchObject({ apMac: '02:00:00:00:00:09', ssid: null });
    // undocumented spelling `clientIP` is ignored, `GatewayMac` alone is not a gateway form
    expect(
      parseOmadaRedirect('clientMac=AA-BB-CC-00-11-22&GatewayMac=02-00-00-00-00-09&vid=10&site=D'),
    ).toBeNull();
    expect(
      parseOmadaRedirect(
        'clientMac=AA-BB-CC-00-11-22&clientIP=1.2.3.4&apMac=02-00-00-00-00-01&ssidName=G&radioId=0&site=D',
      )?.clientIp,
    ).toBeNull();
    expect(
      parseOmadaRedirect(
        'clientMac=AA-BB-CC-00-11-22&apMac=02-00-00-00-00-01&ssidName=G&radioId=0',
      ),
    ).toBeNull(); // no site
  });

  it('Mist: wlan_id/ap_mac/client_mac/url', () => {
    const r = parseMistRedirect(
      'wlan_id=be22bba7-8e22-e1cf-5185-b880816fe2cf&ap_mac=5c5b35001234&client_mac=d48f6bb4c9d8&url=http%3A%2F%2Fwww.mist.com&ap_name=AP1&site_name=HQ',
    );
    expect(r).toMatchObject({
      adapterKey: 'mist-guest-portal',
      clientMac: 'd4:8f:6b:b4:c9:d8',
      apMac: '5c:5b:35:00:12:34',
    });
    // the vendor sample client MAC d58f6bb4c9d8 has the group bit set: refused as non-unicast
    expect(
      parseMistRedirect(
        'wlan_id=be22bba7-8e22-e1cf-5185-b880816fe2cf&ap_mac=5c5b35001234&client_mac=d58f6bb4c9d8',
      ),
    ).toBeNull();
    expect(r?.fields).toMatchObject({
      wlan_id: 'be22bba7-8e22-e1cf-5185-b880816fe2cf',
      ap_mac: '5c5b35001234',
      client_mac: 'd48f6bb4c9d8',
    });
    expect(
      parseMistRedirect('wlan_id=nope&ap_mac=5c5b35001234&client_mac=d58f6bb4c9d8'),
    ).toBeNull();
  });
});

describe('sealed store + credential wiring', () => {
  it('opens Envelope-format refs in-process and fails closed on tampering / wrong key', () => {
    const ref = sealSecret(DEK, 'api-key-value');
    expect(ref.startsWith('enc:v1.')).toBe(true);
    expect(openSealedSecret(DEK, ref)).toBe('api-key-value');
    expect(() => openSealedSecret(`${DEK}x`, ref)).toThrow(SealedSecretError);
    expect(() => openSealedSecret(DEK, `${ref.slice(0, -2)}AA`)).toThrow(SealedSecretError);
    expect(() => openSealedSecret(DEK, 'env:FOO')).toThrow(SealedSecretError);
    expect(new SealedSecretError().message).not.toContain('api-key');
  });

  it('validates per-adapter settings', () => {
    expect(validateVendorApiSettings('omada-controller', {})).toEqual({ ok: true, settings: {} });
    expect(validateVendorApiSettings('omada-controller', { omada_controller_id: '../x' }).ok).toBe(
      false,
    );
    expect(
      validateVendorApiSettings('omada-controller', { omada_controller_id: 'abc123' }),
    ).toEqual({ ok: true, settings: { omada_controller_id: 'abc123' } });
    expect(validateVendorApiSettings('mist', { mist_portal_host: 'evil.example' }).ok).toBe(false);
    expect(
      validateVendorApiSettings('mist', {
        mist_wlan_ids: ['BE22BBA7-8E22-E1CF-5185-B880816FE2CF'],
      }),
    ).toEqual({
      ok: true,
      settings: { mist_wlan_ids: ['be22bba7-8e22-e1cf-5185-b880816fe2cf'] },
    });
    expect(validateVendorApiSettings('unifi-network', { omada_controller_id: 'x' }).ok).toBe(false);
  });

  it('builds TLS trust from the row (fingerprint wins; never insecure)', () => {
    expect(tlsTrustOf({ tlsCaPem: null, tlsFingerprintSha256: null })).toEqual({ mode: 'system' });
    expect(tlsTrustOf({ tlsCaPem: testPki().caPem, tlsFingerprintSha256: null }).mode).toBe('ca');
    expect(tlsTrustOf({ tlsCaPem: null, tlsFingerprintSha256: 'ab'.repeat(32) }).mode).toBe(
      'fingerprint',
    );
    expect(() => tlsTrustOf({ tlsCaPem: 'junk', tlsFingerprintSha256: null })).toThrow(
      VendorApiError,
    );
  });

  it('test connection: UniFi contacts the mock, Mist signs locally, Ruckus is a stub', async () => {
    mock.handler = (req, res) =>
      req.headers['x-api-key'] === 'test-api-key'
        ? json(res, 200, { data: [] })
        : json(res, 401, {});
    const row: StoredVendorCredential = {
      controllerId: 'c-test',
      controllerKind: 'on_premises',
      apiKind: 'unifi-network',
      baseUrl: target.baseUrl,
      username: null,
      secretRef: sealSecret(DEK, 'test-api-key'),
      externalSiteId: 'site-1',
      settings: {},
      tlsCaPem: testPki().caPem,
      tlsFingerprintSha256: null,
    };
    const ok = await testVendorConnection(http(), openVendorCredential(DEK, row));
    expect(ok).toMatchObject({ ok: true, contacted: true });
    const bad = await testVendorConnection(
      http(),
      openVendorCredential(DEK, { ...row, secretRef: sealSecret(DEK, 'nope') }),
    );
    expect(bad).toMatchObject({ ok: false, code: 'auth_failed' });
    expect(JSON.stringify(bad)).not.toContain('nope');
    const tls = await testVendorConnection(
      http(),
      openVendorCredential(DEK, { ...row, tlsCaPem: null }),
    );
    expect(tls).toMatchObject({ ok: false, code: 'tls_error' });
    const mist = await testVendorConnection(
      http(),
      openVendorCredential(DEK, { ...row, apiKind: 'mist' }),
    );
    expect(mist).toMatchObject({ ok: true, contacted: false });
    const ruckus = await testVendorConnection(
      http(),
      openVendorCredential(DEK, { ...row, apiKind: 'ruckus-nbi' }),
    );
    expect(ruckus).toMatchObject({ ok: false, code: 'not_implemented' });
    expect(RUCKUS_NBI_STATUS).toBe('REQUIRES_CLARIFICATION');
    expect(() => ruckusNbiLogin()).toThrow(VendorApiError);
  });
});

describe('review fixes F2 / F4 / F8', () => {
  const t = (port: number | null, kind: VendorTarget['kind'] = 'on_premises'): VendorTarget => ({
    controllerId: `f2-${String(port)}-${kind}`,
    baseUrl: `https://controller.test${port === null ? '' : `:${String(port)}`}`,
    kind,
    tls: { mode: 'system' },
  });

  it('F2: refuses ports off the allow-list before any I/O', async () => {
    let resolved = 0;
    const c = new VendorHttpClient({
      resolve: () => {
        resolved += 1;
        return Promise.resolve([{ address: '203.0.114.9', family: 4 }]);
      },
    });
    for (const port of [22, 5432, 6379, 3001, 8080]) {
      expect(await codeOf(c.request(t(port), { method: 'GET', path: '/v1' }))).toBe(
        'port_not_allowed',
      );
    }
    expect(resolved).toBe(0);
    expect(c.isPortAllowed('')).toBe(true);
    for (const p of [443, 8443, 8043, 8843, 8444]) expect(c.isPortAllowed(p)).toBe(true);
    expect(c.isPortAllowed(22)).toBe(false);
  });

  it('F2: the platform deny-list (compose bridge, docker0, WireGuard overlay) is always applied', async () => {
    for (const address of [
      '172.28.0.5',
      '172.17.0.2',
      '100.100.0.1',
      '::ffff:172.28.0.5',
      '::ffff:ac11:2',
    ]) {
      const c = new VendorHttpClient({
        resolve: () => Promise.resolve([{ address, family: address.includes(':') ? 6 : 4 }]),
      });
      expect(await codeOf(c.request(t(null), { method: 'GET', path: '/v1' })), address).toBe(
        'blocked_address',
      );
    }
    const custom = new VendorHttpClient({
      resolve: () => Promise.resolve([{ address: '10.9.9.9', family: 4 }]),
      denyCidrs: '10.9.0.0/16, 100.100.0.0/16',
    });
    expect(await codeOf(custom.request(t(null), { method: 'GET', path: '/v1' }))).toBe(
      'blocked_address',
    );
    expect(() => parseDenyCidrs('10.0.0.0/33')).toThrow(RangeError);
    expect(() => parseDenyCidrs(['nonsense'])).toThrow(RangeError);
    expect(DEFAULT_DENY_CIDRS).toEqual(['172.28.0.0/16', '172.17.0.0/16', '100.100.0.0/16']);
  });

  it('F8: a PEM block must parse as an X.509 certificate', () => {
    expect(isCertificatePem(testPki().caPem + testPki().leafCertPem)).toBe(true);
    const fake = '-----BEGIN CERTIFICATE-----\nQUJDREVGR0g=\n-----END CERTIFICATE-----\n';
    expect(isCertificatePem(fake)).toBe(false);
    expect(isCertificatePem(testPki().caPem + fake)).toBe(false);
  });

  it('F4: the worker opens secrets with the derived purpose key only', () => {
    const ref = sealSecret(DEK, 'test-vendor-secret');
    const derived = deriveVendorApiKey(DEK);
    expect(isDerivedVendorApiKey(derived)).toBe(true);
    expect(isDerivedVendorApiKey(DEK)).toBe(false);
    expect(openSealedSecret({ kind: 'derived', value: derived }, ref)).toBe('test-vendor-secret');
    expect(() => openSealedSecret({ kind: 'derived', value: DEK }, ref)).toThrow(SealedSecretError);
    expect(() =>
      openSealedSecret({ kind: 'derived', value: deriveVendorApiKey(`${DEK}x`) }, ref),
    ).toThrow(SealedSecretError);
    // a derived key cannot open other purposes (NAS / UAM secrets)
    const nasRef = sealSecret(DEK, 'nas', 'ecloud:nas:secret:v1');
    expect(() =>
      openSealedSecret({ kind: 'derived', value: derived }, nasRef, 'ecloud:nas:secret:v1'),
    ).toThrow(SealedSecretError);
  });

  it('F4: the derive-key CLI reads the master key from env only and prints the derived key', () => {
    let out = '';
    expect(
      runCli(['derive-key', 'vendor-api'], { DATA_ENCRYPTION_KEY: DEK }, (s) => (out += s)),
    ).toBe(0);
    expect(out).toBe(deriveVendorApiKey(DEK));
    expect(
      runCli(['derive-key', 'vendor-api', DEK], { DATA_ENCRYPTION_KEY: DEK }, () => undefined),
    ).toBe(2);
    expect(runCli(['derive-key', 'vendor-api'], {}, () => undefined)).toBe(1);
  });
});
