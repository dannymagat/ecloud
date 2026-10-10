import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { VendorApiError } from './errors.js';
import {
  OUTBOUND_LIMITS,
  VendorHttpClient,
  buildVendorUrl,
  controllerAddressAllowed,
  isCertificatePem,
  normalizeFingerprint,
  type VendorTarget,
} from './http.js';
import { TokenBucketLimiter } from './rate-limit.js';
import {
  allowLoopback,
  json,
  loopbackResolver,
  startMockController,
  testPki,
  type MockController,
} from '@ecloud/testing';

/** A key-shaped PEM (built at runtime so no key marker is committed); never a real key. */
const FAKE_KEY_PEM = ['-----BEGIN', 'PRIVATE KEY-----\nAAAA\n-----END', 'PRIVATE KEY-----\n'].join(
  ' ',
);

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'resolved';
  } catch (error) {
    if (error instanceof VendorApiError) return error.code;
    throw error;
  }
}

describe('static guards', () => {
  it('builds same-origin URLs below the base path only', () => {
    expect(
      buildVendorUrl('https://c.example:8443/proxy/network/integration/', '/v1/sites').href,
    ).toBe('https://c.example:8443/proxy/network/integration/v1/sites');
    for (const bad of [
      'v1',
      '/../x',
      '/a/../b',
      '/a/./b',
      '/a?x=1',
      '/a#f',
      '/a%2f..',
      '/a\\b',
      '/%2e%2e/x',
    ]) {
      expect(() => buildVendorUrl('https://c.example', bad), bad).toThrow(VendorApiError);
    }
    for (const base of [
      'http://c.example',
      'https://u:p@c.example',
      'https://localhost',
      'https://x.localhost.',
      'https://c.example/?q=1',
      'nonsense',
    ]) {
      expect(() => buildVendorUrl(base, '/v1'), base).toThrow(VendorApiError);
    }
  });

  it('applies the per-kind address policy (OQ-17)', () => {
    expect(controllerAddressAllowed('203.0.114.1', 'cloud')).toBe(true);
    expect(controllerAddressAllowed('10.1.2.3', 'cloud')).toBe(false);
    expect(controllerAddressAllowed('10.1.2.3', 'on_premises')).toBe(true);
    expect(controllerAddressAllowed('100.100.0.5', 'embedded')).toBe(true);
    for (const ip of [
      '127.0.0.1',
      '169.254.169.254',
      '::1',
      '::ffff:127.0.0.1',
      '::7f00:1',
      'fe80::1',
      '224.0.0.1',
      '0.0.0.0',
    ]) {
      expect(controllerAddressAllowed(ip, 'on_premises'), ip).toBe(false);
      expect(controllerAddressAllowed(ip, 'cloud'), ip).toBe(false);
    }
  });

  it('normalises fingerprints and accepts certificate PEM only', () => {
    const fp = 'ab'.repeat(32);
    expect(normalizeFingerprint(fp)).toBe(Array(32).fill('AB').join(':'));
    expect(normalizeFingerprint(`sha256:${Array(32).fill('ab').join(':')}`)).toBe(
      Array(32).fill('AB').join(':'),
    );
    expect(normalizeFingerprint('abcd')).toBeNull();
    expect(isCertificatePem(testPki().caPem)).toBe(true);
    expect(isCertificatePem(FAKE_KEY_PEM)).toBe(false);
  });
});

describe('VendorHttpClient against a local mock controller', () => {
  let mock: MockController;
  let selfSigned: MockController;
  const pki = testPki();

  beforeAll(async () => {
    mock = await startMockController();
    selfSigned = await startMockController({ cert: 'other' });
  });
  afterAll(async () => {
    await mock.close();
    await selfSigned.close();
  });

  const target = (
    port: number,
    tls: VendorTarget['tls'],
    host = 'controller.test',
  ): VendorTarget => ({
    controllerId: `ctrl-${String(port)}-${tls.mode}-${host}`,
    baseUrl: `https://${host}:${String(port)}/api`,
    kind: 'on_premises',
    tls,
  });
  const client = (limiter?: TokenBucketLimiter) =>
    new VendorHttpClient({
      resolve: loopbackResolver,
      addressAllowed: allowLoopback,
      allowedPorts: [mock.port, selfSigned.port],
      ...(limiter ? { rateLimiter: limiter } : {}),
    });

  it('succeeds with a pinned CA (chain + host name verified), pinned to the resolved address', async () => {
    mock.handler = (req, res) => json(res, 200, { path: req.url, host: req.headers.host });
    const res = await client().request(target(mock.port, { mode: 'ca', caPem: pki.caPem }), {
      method: 'POST',
      path: '/v1/x',
      json: { a: 1 },
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body.toString())).toEqual({
      path: '/api/v1/x',
      host: `controller.test:${String(mock.port)}`,
    });
    expect(mock.requests.at(-1)?.body).toBe('{"a":1}');
  });

  it('fails TLS against system roots for a private CA (no insecure fallback)', async () => {
    expect(
      await codeOf(
        client().request(target(mock.port, { mode: 'system' }), { method: 'GET', path: '/v1' }),
      ),
    ).toBe('tls_error');
  });

  it('fails TLS when the host name does not match the certificate', async () => {
    const n = mock.requests.length;
    expect(
      await codeOf(
        client().request(target(mock.port, { mode: 'ca', caPem: pki.caPem }, 'wrong.test'), {
          method: 'GET',
          path: '/v1',
        }),
      ),
    ).toBe('tls_error');
    expect(mock.requests.length).toBe(n);
  });

  it('fails TLS for a self-signed certificate not issued by the pinned CA', async () => {
    expect(
      await codeOf(
        client().request(target(selfSigned.port, { mode: 'ca', caPem: pki.caPem }), {
          method: 'GET',
          path: '/v1',
        }),
      ),
    ).toBe('tls_error');
  });

  it('accepts a self-signed controller by pinned fingerprint and refuses a mismatch before sending', async () => {
    selfSigned.handler = (_req, res) => json(res, 200, { ok: true });
    const ok = await client().request(
      target(selfSigned.port, { mode: 'fingerprint', sha256: pki.otherFingerprint }),
      {
        method: 'GET',
        path: '/v1',
      },
    );
    expect(ok.status).toBe(200);
    const n = selfSigned.requests.length;
    expect(
      await codeOf(
        client().request(
          target(selfSigned.port, { mode: 'fingerprint', sha256: pki.leafFingerprint }),
          {
            method: 'POST',
            path: '/v1',
            headers: { 'x-api-key': 'must-never-arrive' },
            json: {},
          },
        ),
      ),
    ).toBe('tls_pin_mismatch');
    expect(selfSigned.requests.length).toBe(n); // nothing (no credential) reached the server
  });

  it('never follows a redirect, including one to a private address', async () => {
    mock.handler = (_req, res) => {
      res.writeHead(302, { location: 'https://10.0.0.1/steal' }).end();
    };
    const n = mock.requests.length;
    expect(
      await codeOf(
        client().request(target(mock.port, { mode: 'ca', caPem: pki.caPem }), {
          method: 'GET',
          path: '/v1',
        }),
      ),
    ).toBe('redirect_refused');
    expect(mock.requests.length).toBe(n + 1);
  });

  it('refuses hosts resolving to loopback / metadata / mixed answers with the production policy', async () => {
    const prod = (answers: { address: string; family: number }[]) =>
      new VendorHttpClient({ resolve: () => Promise.resolve(answers), allowedPorts: [mock.port] });
    const t = target(mock.port, { mode: 'ca', caPem: pki.caPem });
    expect(
      await codeOf(
        prod([{ address: '127.0.0.1', family: 4 }]).request(t, { method: 'GET', path: '/v1' }),
      ),
    ).toBe('blocked_address');
    expect(
      await codeOf(
        prod([
          { address: '203.0.114.7', family: 4 },
          { address: '169.254.169.254', family: 4 },
        ]).request(t, { method: 'GET', path: '/v1' }),
      ),
    ).toBe('blocked_address');
    expect(await codeOf(prod([]).request(t, { method: 'GET', path: '/v1' }))).toBe('dns_failure');
    const literal: VendorTarget = { ...t, baseUrl: 'https://169.254.169.254/latest' };
    expect(
      await codeOf(new VendorHttpClient().request(literal, { method: 'GET', path: '/meta-data' })),
    ).toBe('blocked_address');
    const cloudPrivate: VendorTarget = { ...t, kind: 'cloud', baseUrl: 'https://10.0.0.5:8443' };
    expect(
      await codeOf(new VendorHttpClient().request(cloudPrivate, { method: 'GET', path: '/v1' })),
    ).toBe('blocked_address');
    expect(
      await codeOf(
        new VendorHttpClient({
          resolve: () => Promise.reject(new Error('NXDOMAIN')),
          allowedPorts: [mock.port],
        }).request(t, {
          method: 'GET',
          path: '/v1',
        }),
      ),
    ).toBe('dns_failure');
  });

  it('times out a slow controller', async () => {
    mock.handler = (_req, res) => {
      setTimeout(() => json(res, 200, {}), 2_000).unref();
    };
    const started = Date.now();
    expect(
      await codeOf(
        client().request(target(mock.port, { mode: 'ca', caPem: pki.caPem }), {
          method: 'GET',
          path: '/v1',
          timeoutMs: 200,
        }),
      ),
    ).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(1_500);
  });

  it('refuses oversized responses (declared and streamed)', async () => {
    const t = target(mock.port, { mode: 'ca', caPem: pki.caPem });
    mock.handler = (_req, res) => json(res, 200, { pad: 'x'.repeat(4096) });
    expect(
      await codeOf(client().request(t, { method: 'GET', path: '/v1', maxResponseBytes: 1024 })),
    ).toBe('response_too_large');
    mock.handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' }); // chunked, no length
      for (let i = 0; i < 8; i += 1) res.write('x'.repeat(512));
      res.end();
    };
    expect(
      await codeOf(client().request(t, { method: 'GET', path: '/v1', maxResponseBytes: 1024 })),
    ).toBe('response_too_large');
    expect(OUTBOUND_LIMITS.maxResponseBytes).toBeGreaterThan(
      OUTBOUND_LIMITS.defaultMaxResponseBytes,
    );
  });

  it('rate-limits per controller before any I/O', async () => {
    mock.handler = (_req, res) => json(res, 200, {});
    const limiter = new TokenBucketLimiter({ capacity: 1, refillPerSecond: 0.001 });
    const c = client(limiter);
    const t = target(mock.port, { mode: 'ca', caPem: pki.caPem });
    expect((await c.request(t, { method: 'GET', path: '/v1' })).status).toBe(200);
    const n = mock.requests.length;
    expect(await codeOf(c.request(t, { method: 'GET', path: '/v1' }))).toBe('rate_limited');
    expect(mock.requests.length).toBe(n);
    // another controller has its own bucket
    expect(
      (await c.request({ ...t, controllerId: 'other' }, { method: 'GET', path: '/v1' })).status,
    ).toBe(200);
  });

  it('error messages never carry request secrets', async () => {
    mock.handler = (_req, res) => json(res, 401, { error: 'bad key s3cr3t-value' });
    const t = target(mock.port, { mode: 'ca', caPem: pki.caPem });
    const res = await client().request(t, {
      method: 'GET',
      path: '/v1',
      headers: { 'x-api-key': 's3cr3t-value' },
    });
    expect(res.status).toBe(401);
    for (const code of ['timeout', 'auth_failed', 'tls_error', 'blocked_address'] as const) {
      expect(new VendorApiError(code).message).not.toMatch(/s3cr3t|key=|controller\.test/);
    }
  });
});
