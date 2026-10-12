/**
 * TLS on the internal listener.
 *
 * FreeRADIUS `rlm_rest` POSTs the whole RADIUS request to `/internal/aaa/authorize`, including
 * `User-Password` (infra/freeradius/raddb/mods-available/rest). If that leg is cleartext, any
 * packet capture on the segment between FreeRADIUS and the API reads subscriber passwords.
 * These tests prove the boot path actually serves TLS when the cert and key are configured,
 * and that a half-configured pair fails the boot instead of silently falling back to plaintext.
 */
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, readFileSync } from 'node:fs';
import { request } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadApiConfig } from './config.js';
import { main, type RunningApi } from './index.js';
import { TEST_INTERNAL_TOKEN, testConfig } from './test-support/deps.js';

/** A self-signed cert for 127.0.0.1, generated per run; openssl ships with the dev images. */
function selfSigned(): { certFile: string; keyFile: string } {
  const dir = mkdtempSync(join(tmpdir(), 'ecloud-internal-tls-'));
  const certFile = join(dir, 'cert.pem');
  const keyFile = join(dir, 'key.pem');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', keyFile, '-out', certFile,
    '-days', '1', '-subj', '/CN=127.0.0.1',
    '-addext', 'subjectAltName=IP:127.0.0.1',
  ], { stdio: ['ignore', 'ignore', 'ignore'] });
  return { certFile, keyFile };
}

/** A port the OS has just confirmed free. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

/** GET over TLS, trusting only `ca`. Resolves with the status code. */
function getStatus(port: number, path: string, ca: Buffer, token?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'GET',
        ca,
        ...(token === undefined ? {} : { headers: { 'X-Internal-Token': token } }),
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

let running: RunningApi | null = null;

afterEach(async () => {
  await running?.shutdown();
  running = null;
});

describe('internal listener TLS', () => {
  it('serves the internal app over TLS when a cert and key are configured', async () => {
    const { certFile, keyFile } = selfSigned();
    const internalPort = await freePort();
    const apiPort = await freePort();
    const config = testConfig({
      API_PORT: String(apiPort),
      INTERNAL_PORT: String(internalPort),
      INTERNAL_BIND_HOST: '127.0.0.1',
      INTERNAL_TLS_CERT_FILE: certFile,
      INTERNAL_TLS_KEY_FILE: keyFile,
    });
    expect(config.internalTls).toEqual({ certFile, keyFile });

    running = await main({ config, handleSignals: false });
    const ca = readFileSync(certFile);

    // 401 without the token, 404 with it: both answers prove the TLS handshake completed and
    // the internal app is behind it. Neither touches the database.
    await expect(getStatus(internalPort, '/internal/aaa/authorize', ca)).resolves.toBe(401);
    await expect(
      getStatus(internalPort, '/internal/no-such-route', ca, TEST_INTERNAL_TOKEN),
    ).resolves.toBe(404);
  });

  it('rejects a connection that does not trust the certificate', async () => {
    const { certFile, keyFile } = selfSigned();
    const internalPort = await freePort();
    const apiPort = await freePort();
    running = await main({
      config: testConfig({
        API_PORT: String(apiPort),
        INTERNAL_PORT: String(internalPort),
        INTERNAL_BIND_HOST: '127.0.0.1',
        INTERNAL_TLS_CERT_FILE: certFile,
        INTERNAL_TLS_KEY_FILE: keyFile,
      }),
      handleSignals: false,
    });
    // An unrelated CA: the client must refuse, which is what pinning in rlm_rest relies on.
    const otherCa = readFileSync(selfSigned().certFile);
    await expect(getStatus(internalPort, '/internal/aaa/authorize', otherCa)).rejects.toThrow(
      /self.signed|unable to verify|certificate/i,
    );
  });

  it('is off by default, so dev and loopback deployments are unchanged', () => {
    expect(testConfig().internalTls).toBeNull();
  });

  it('refuses a cert without its key, instead of falling back to plaintext', () => {
    const { certFile, keyFile } = selfSigned();
    const base = {
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      KV_DRIVER: 'memory',
      PUBLIC_ADMIN_ORIGIN: 'http://admin.test.local',
      INTERNAL_API_TOKEN: TEST_INTERNAL_TOKEN,
      DATABASE_URL: 'postgres://nobody:nothing@127.0.0.1:1/none',
      DATABASE_URL_PLATFORM: 'postgres://nobody:nothing@127.0.0.1:1/none',
    };
    expect(() => loadApiConfig({ ...base, INTERNAL_TLS_CERT_FILE: certFile })).toThrow(
      /must be set together/,
    );
    expect(() => loadApiConfig({ ...base, INTERNAL_TLS_KEY_FILE: keyFile })).toThrow(
      /must be set together/,
    );
  });
});
