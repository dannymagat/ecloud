import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createSecretResolver } from './secrets.js';
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
