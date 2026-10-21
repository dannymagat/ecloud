import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SecretFetchError, createSecretResolver } from './secrets.js';
import { MemoryWorkerState } from './state.js';

describe('MemoryWorkerState', () => {
  it('single-flight lock: a second holder is refused until release', async () => {
    const state = new MemoryWorkerState();
    let inner: unknown = 'unset';
    const outer = await state.withLock('job', 1000, async () => {
      inner = await state.withLock('job', 1000, () => Promise.resolve('second'));
      return 'first';
    });
    expect(outer).toBe('first');
    expect(inner).toBeUndefined();
    expect(await state.withLock('job', 1000, () => Promise.resolve('again'))).toBe('again');
  });
  it('markOnce, cursors and pending set', async () => {
    const state = new MemoryWorkerState();
    expect(await state.markOnce('k', 10)).toBe(true);
    expect(await state.markOnce('k', 10)).toBe(false);
    expect(await state.getCursor('c')).toBe(0);
    await state.setCursor('c', 9);
    expect(await state.getCursor('c')).toBe(9);
    await state.setPending('s', { reason: 'coa_disabled' });
    expect(await state.listPending()).toEqual({ s: { reason: 'coa_disabled' } });
    await state.clearPending('s');
    expect(await state.listPending()).toEqual({});
  });
});

describe('createSecretResolver', () => {
  it('resolves env: and absolute file: references only', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ecloud-secret-test-'));
    const file = join(dir, 's');
    writeFileSync(file, 'from-file\n', { mode: 0o600 });
    const resolve = createSecretResolver({ NAS_SECRET_X: 'from-env', EMPTY: '' });
    expect(await resolve('env:NAS_SECRET_X')).toBe('from-env');
    expect(await resolve('env:EMPTY')).toBeUndefined();
    expect(await resolve('env:bad-name')).toBeUndefined();
    expect(await resolve(`file:${file}`)).toBe('from-file');
    expect(await resolve('file:relative/path')).toBeUndefined();
    expect(await resolve(`file:${join(dir, 'missing')}`)).toBeUndefined();
    expect(await resolve('vault:secret/x')).toBeUndefined();
  });
});

describe('createSecretResolver: enc: references (D-056)', () => {
  const NAS_ID = '0199b0a4-0000-7000-8000-000000000009';
  const internal = { url: 'http://api:3001/', token: 'internal-test-token' }; // check-no-secrets: allow (test value)
  const fetchWith = (status: number, body?: unknown) => {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const fetch = (url: string, init?: RequestInit) => {
      calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
      return Promise.resolve(
        new Response(body === undefined ? null : JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
      );
    };
    return { fetch, calls };
  };

  it('fetches ONE secret by NAS id from the api with the internal token', async () => {
    const { fetch, calls } = fetchWith(200, { id: NAS_ID, secret: 'opened-value' });
    const resolve = createSecretResolver({}, { internal, fetch });
    await expect(resolve('enc:v2.anything', { nasId: NAS_ID })).resolves.toBe('opened-value');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`http://api:3001/internal/nas/${NAS_ID}/secret`);
    expect(calls[0]?.headers['X-Internal-Secret-Token']).toBe(internal.token);
    expect(calls[0]?.headers['X-Internal-Token']).toBeUndefined();
  });

  it('is unresolvable (undefined) without an internal api, without a NAS id, or on 404', async () => {
    const none = createSecretResolver(
      {},
      { internal: null, fetch: fetchWith(200, { secret: 'x' }).fetch },
    );
    await expect(none('enc:v2.x', { nasId: NAS_ID })).resolves.toBeUndefined();
    const noId = createSecretResolver(
      {},
      { internal, fetch: fetchWith(200, { secret: 'x' }).fetch },
    );
    await expect(noId('enc:v2.x')).resolves.toBeUndefined();
    await expect(noId('enc:v2.x', { nasId: 'not-a-uuid' })).resolves.toBeUndefined();
    const gone = createSecretResolver({}, { internal, fetch: fetchWith(404).fetch });
    await expect(gone('enc:v2.x', { nasId: NAS_ID })).resolves.toBeUndefined();
  });

  it('throws SecretFetchError when the api is unreachable or answers 5xx (transient, retried)', async () => {
    const down = createSecretResolver(
      {},
      {
        internal,
        fetch: () => Promise.reject(new Error('ECONNREFUSED')),
      },
    );
    await expect(down('enc:v2.x', { nasId: NAS_ID })).rejects.toBeInstanceOf(SecretFetchError);
    const refusing = createSecretResolver({}, { internal, fetch: fetchWith(503).fetch });
    await expect(refusing('enc:v2.x', { nasId: NAS_ID })).rejects.toBeInstanceOf(SecretFetchError);
  });

  it('still never resolves an unknown scheme', async () => {
    const resolve = createSecretResolver(
      {},
      { internal, fetch: fetchWith(200, { secret: 'x' }).fetch },
    );
    await expect(resolve('secret://test/x', { nasId: NAS_ID })).resolves.toBeUndefined();
  });
});
