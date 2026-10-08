import { randomUUID } from 'node:crypto';
import {
  chmod,
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { StorageBackendError, StorageOperationUnsupportedError } from './errors.js';
import { buildObjectKey } from './keys.js';
import { LocalObjectStorage } from './local-driver.js';
import { describeObjectStorageContract, JPEG_BYTES, PNG_BYTES } from './storage.contract.js';

const roots: string[] = [];

async function readAllStream(stream: AsyncIterable<unknown>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks);
}
async function newRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ecloud-storage-'));
  roots.push(root);
  return root;
}

afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

describeObjectStorageContract(
  'local',
  async () => new LocalObjectStorage({ rootPath: await newRoot() }),
);

describe('LocalObjectStorage specifics', () => {
  let root: string;
  let storage: LocalObjectStorage;
  const org = randomUUID();
  const key = (id: string) => buildObjectKey({ organizationId: org, purpose: 'branding', id });

  beforeAll(async () => {
    root = join(await newRoot(), 'nested', 'storage');
    storage = new LocalObjectStorage({ rootPath: root });
  });

  /** The single content version file of `id` (objects/<key>/<version>). */
  async function versionPath(id: string): Promise<string> {
    const dir = join(root, 'objects', 'org', org, 'branding', id);
    const entries = await readdir(dir);
    expect(entries).toHaveLength(1);
    return join(dir, entries[0] ?? '');
  }

  it('creates the root lazily and writes 0700 directories and 0600 files', async () => {
    await storage.put(key('perm.png'), PNG_BYTES, { contentType: 'image/png' });
    const objectDir = join(root, 'objects', 'org', org, 'branding');
    expect((await stat(objectDir)).mode & 0o777).toBe(0o700);
    expect((await stat(join(root, 'objects'))).mode & 0o777).toBe(0o700);
    const content = await versionPath('perm.png');
    expect((await stat(content)).mode & 0o777).toBe(0o600);
    expect(
      (await stat(join(root, 'meta', 'org', org, 'branding', 'perm.png.json'))).mode & 0o777,
    ).toBe(0o600);
    expect(await readFile(content)).toEqual(PNG_BYTES);
  });

  it('keeps one content version per object after overwrites', async () => {
    await storage.put(key('versions.png'), PNG_BYTES, { contentType: 'image/png' });
    await storage.put(key('versions.png'), JPEG_BYTES, { contentType: 'image/jpeg' });
    expect(await readFile(await versionPath('versions.png'))).toEqual(JPEG_BYTES);
  });

  it('keeps old content and metadata paired when the metadata commit fails', async () => {
    const first = await storage.put(key('commit.png'), PNG_BYTES, { contentType: 'image/png' });
    const metaDir = join(root, 'meta', 'org', org, 'branding');
    await chmod(metaDir, 0o500); // metadata rename fails with EACCES
    try {
      await expect(
        storage.put(key('commit.png'), JPEG_BYTES, { contentType: 'image/jpeg' }),
      ).rejects.toBeInstanceOf(StorageBackendError);
    } finally {
      await chmod(metaDir, 0o700);
    }
    const object = await storage.get(key('commit.png'));
    const bytes = await readAllStream(object.body);
    expect(bytes).toEqual(PNG_BYTES);
    expect(object).toMatchObject({
      contentType: 'image/png',
      size: PNG_BYTES.byteLength,
      sha256: first.sha256,
    });
    // The orphaned new version was removed; only the committed one remains.
    expect(await readFile(await versionPath('commit.png'))).toEqual(PNG_BYTES);
    expect((await readdir(join(root, 'tmp'))).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it('sweeps stale temp files on checkHealth and at first use, keeping fresh ones', async () => {
    const tmpDir = join(root, 'tmp');
    const old = join(tmpDir, 'crashed-write.tmp');
    const fresh = join(tmpDir, 'in-flight.tmp');
    const other = join(tmpDir, 'not-ours.dat');
    for (const path of [old, fresh, other]) await writeFile(path, 'x', { mode: 0o600 });
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await utimes(old, twoHoursAgo, twoHoursAgo);
    await utimes(other, twoHoursAgo, twoHoursAgo);

    await storage.checkHealth();
    expect((await readdir(tmpDir)).sort()).toEqual(['in-flight.tmp', 'not-ours.dat']);

    // A new driver instance sweeps at first use (driver init), before any checkHealth.
    await utimes(fresh, twoHoursAgo, twoHoursAgo);
    const restarted = new LocalObjectStorage({ rootPath: root });
    await restarted.head(key('perm.png'));
    expect(await readdir(tmpDir)).toEqual(['not-ours.dat']);
    await rm(other);
  });

  it('leaves no temp files behind after successful and rejected writes', async () => {
    await storage.put(key('tmp-check.png'), PNG_BYTES, { contentType: 'image/png' });
    await expect(
      storage.put(key('tmp-bad.png'), Buffer.from('nope'), { contentType: 'image/png' }),
    ).rejects.toThrow();
    expect(await readdir(join(root, 'tmp'))).toEqual([]);
    expect((await readdir(join(root, 'objects', 'org', org, 'branding'))).sort()).not.toContain(
      'tmp-bad.png',
    );
  });

  it('refuses to follow a symlinked directory planted inside the tree', async () => {
    const outside = await newRoot();
    await writeFile(join(outside, 'victim.png'), PNG_BYTES);
    const evilOrg = randomUUID();
    await mkdir(join(root, 'objects', 'org'), { recursive: true });
    await mkdir(join(root, 'meta', 'org', evilOrg), { recursive: true });
    await symlink(outside, join(root, 'objects', 'org', evilOrg));
    const evilKey = buildObjectKey({ organizationId: evilOrg, purpose: 'branding', id: 'x.png' });

    await expect(
      storage.put(evilKey, PNG_BYTES, { contentType: 'image/png' }),
    ).rejects.toBeInstanceOf(StorageBackendError);
    await expect(storage.get(evilKey)).rejects.toBeInstanceOf(StorageBackendError);
    expect(await readdir(outside)).toEqual(['victim.png']);
  });

  it('refuses to read through a symlinked object file', async () => {
    const outside = await newRoot();
    const secretPath = join(outside, 'secret.png');
    await writeFile(secretPath, PNG_BYTES);
    await storage.put(key('link.png'), PNG_BYTES, { contentType: 'image/png' });
    const objectPath = await versionPath('link.png');
    await rm(objectPath);
    await symlink(secretPath, objectPath);

    await expect(storage.get(key('link.png'))).rejects.toBeInstanceOf(StorageBackendError);
    await expect(storage.head(key('link.png'))).rejects.toBeInstanceOf(StorageBackendError);
    // Overwriting writes a new version and prunes the link itself; the outside file is untouched.
    await storage.put(key('link.png'), PNG_BYTES, { contentType: 'image/png' });
    expect((await stat(secretPath)).isFile()).toBe(true);
    await storage.delete(key('link.png'));
    expect(await readFile(secretPath)).toEqual(PNG_BYTES);
  });

  it('hides content that has no metadata record (interrupted write)', async () => {
    const dir = join(root, 'objects', 'org', org, 'branding', 'orphan.png');
    await mkdir(dir, { mode: 0o700 });
    await writeFile(join(dir, randomUUID()), PNG_BYTES, { mode: 0o600 });
    await expect(storage.head(key('orphan.png'))).resolves.toBeNull();
    expect((await storage.list(`org/${org}/`)).map((i) => i.key)).not.toContain(key('orphan.png'));
  });

  it('declares signed URLs unsupported', async () => {
    expect(storage.capabilities.signedReadUrls).toBe(false);
    await expect(storage.getSignedReadUrl(key('perm.png'))).rejects.toBeInstanceOf(
      StorageOperationUnsupportedError,
    );
  });

  it('fails the health check when the root cannot be created', async () => {
    const parent = await newRoot();
    await writeFile(join(parent, 'file'), 'not a directory');
    const broken = new LocalObjectStorage({ rootPath: join(parent, 'file', 'storage') });
    await expect(broken.checkHealth()).rejects.toBeInstanceOf(StorageBackendError);
  });
});
