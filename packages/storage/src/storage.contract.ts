// Shared behavioural contract for every ObjectStorage driver. Imported by the driver test files
// (local always; s3 only when ECLOUD_TEST_S3_ENDPOINT is set). Not part of the build output.
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ContentTypeNotAllowedError,
  InvalidStorageKeyError,
  ObjectNotFoundError,
  ObjectTooLargeError,
  StorageOperationUnsupportedError,
} from './errors.js';
import { buildObjectKey, tenantPrefix } from './keys.js';
import { STORAGE_PURPOSES } from './purposes.js';
import { forTenant } from './tenant.js';
import type { ObjectStorage } from './types.js';

export const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('fake png payload for tests'),
]);
export const JPEG_BYTES = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  Buffer.from('fake jpeg payload'),
]);
export const WEBP_BYTES = Buffer.concat([
  Buffer.from('RIFF'),
  Buffer.from([0x10, 0, 0, 0]),
  Buffer.from('WEBPVP8 fake webp payload'),
]);

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks);
}

const TRAVERSAL_KEYS = [
  '../etc/passwd',
  '/etc/passwd',
  'org/../../etc/passwd',
  'org/00000000-0000-4000-8000-000000000000/branding/..',
  'org/00000000-0000-4000-8000-000000000000/branding/a\0b',
  'org/00000000-0000-4000-8000-000000000000/branding/sub/file',
  'org/00000000-0000-4000-8000-000000000000/unknown/file',
];

/**
 * Registers the contract suite. `create` returns a fresh driver; `cleanup` runs after the suite.
 */
export function describeObjectStorageContract(
  name: string,
  create: () => Promise<ObjectStorage> | ObjectStorage,
): void {
  describe(`ObjectStorage contract: ${name}`, () => {
    let storage: ObjectStorage;
    let ready = false;
    const orgA = randomUUID();
    const orgB = randomUUID();
    const keyA = (id: string) => buildObjectKey({ organizationId: orgA, purpose: 'branding', id });

    beforeAll(async () => {
      storage = await create();
      ready = true;
    });

    afterAll(async () => {
      if (!ready) return;
      for (const org of [orgA, orgB]) {
        for (const item of await storage.list(tenantPrefix(org))) await storage.delete(item.key);
      }
      await storage.close();
    });

    it('passes its health check', async () => {
      await expect(storage.checkHealth()).resolves.toBeUndefined();
    });

    it('round-trips content, content type, size and sha256', async () => {
      const key = keyA('logo.png');
      const put = await storage.put(key, PNG_BYTES, { contentType: 'image/png' });
      expect(put).toMatchObject({ key, size: PNG_BYTES.byteLength, contentType: 'image/png' });
      expect(put.sha256).toMatch(/^[0-9a-f]{64}$/);

      const head = await storage.head(key);
      expect(head).toMatchObject({
        key,
        size: PNG_BYTES.byteLength,
        contentType: 'image/png',
        sha256: put.sha256,
      });
      expect(head?.lastModified).toBeInstanceOf(Date);

      const object = await storage.get(key);
      expect(object.contentType).toBe('image/png');
      expect(object.size).toBe(PNG_BYTES.byteLength);
      expect(object.sha256).toBe(put.sha256);
      expect(await readAll(object.body)).toEqual(PNG_BYTES);
    });

    it('normalises the content type and accepts jpeg and webp', async () => {
      const jpeg = await storage.put(keyA('photo.jpg'), JPEG_BYTES, {
        contentType: 'Image/JPEG; charset=binary',
      });
      expect(jpeg.contentType).toBe('image/jpeg');
      const webp = await storage.put(keyA('bg.webp'), WEBP_BYTES, { contentType: 'image/webp' });
      expect((await storage.head(webp.key))?.contentType).toBe('image/webp');
    });

    it('accepts a stream body', async () => {
      const key = keyA('streamed.png');
      await storage.put(key, Readable.from([PNG_BYTES.subarray(0, 5), PNG_BYTES.subarray(5)]), {
        contentType: 'image/png',
      });
      expect(await readAll((await storage.get(key)).body)).toEqual(PNG_BYTES);
    });

    it('replaces an existing object', async () => {
      const key = keyA('replace.png');
      await storage.put(key, PNG_BYTES, { contentType: 'image/png' });
      await storage.put(key, JPEG_BYTES, { contentType: 'image/jpeg' });
      const object = await storage.get(key);
      expect(object.contentType).toBe('image/jpeg');
      expect(await readAll(object.body)).toEqual(JPEG_BYTES);
    });

    it('reports missing objects: head -> null, get -> ObjectNotFoundError', async () => {
      const key = keyA('missing.png');
      await expect(storage.head(key)).resolves.toBeNull();
      await expect(storage.get(key)).rejects.toBeInstanceOf(ObjectNotFoundError);
    });

    it('deletes idempotently', async () => {
      const key = keyA('delete-me.png');
      await storage.put(key, PNG_BYTES, { contentType: 'image/png' });
      await storage.delete(key);
      await expect(storage.head(key)).resolves.toBeNull();
      await expect(storage.delete(key)).resolves.toBeUndefined();
    });

    it('lists by tenant prefix without crossing tenants, honouring the limit', async () => {
      const keyB = buildObjectKey({ organizationId: orgB, purpose: 'branding', id: 'b.png' });
      await storage.put(keyB, PNG_BYTES, { contentType: 'image/png' });
      await storage.put(keyA('list-1.png'), PNG_BYTES, { contentType: 'image/png' });

      const listA = await storage.list(tenantPrefix(orgA));
      expect(listA.length).toBeGreaterThan(0);
      expect(listA.every((item) => item.key.startsWith(`org/${orgA}/`))).toBe(true);
      expect(listA.map((item) => item.key)).toContain(keyA('list-1.png'));
      expect(listA.map((item) => item.key)).not.toContain(keyB);
      expect([...listA.map((i) => i.key)].sort()).toEqual(listA.map((i) => i.key));
      expect(listA.find((i) => i.key === keyA('list-1.png'))?.size).toBe(PNG_BYTES.byteLength);

      const byPurpose = await storage.list(tenantPrefix(orgA, 'branding'), { limit: 2 });
      expect(byPurpose).toHaveLength(2);

      expect((await storage.list(tenantPrefix(orgB))).map((i) => i.key)).toEqual([keyB]);
    });

    it('rejects content types outside the purpose allow-list (svg, html)', async () => {
      const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>');
      await expect(
        storage.put(keyA('x.svg'), svg, { contentType: 'image/svg+xml' }),
      ).rejects.toBeInstanceOf(ContentTypeNotAllowedError);
      await expect(
        storage.put(keyA('x.html'), svg, { contentType: 'text/html' }),
      ).rejects.toBeInstanceOf(ContentTypeNotAllowedError);
      await expect(storage.head(keyA('x.svg'))).resolves.toBeNull();
    });

    it('rejects bytes that do not match the declared type', async () => {
      const html = Buffer.from('<html><script>alert(1)</script></html>');
      await expect(
        storage.put(keyA('spoof.png'), html, { contentType: 'image/png' }),
      ).rejects.toBeInstanceOf(ContentTypeNotAllowedError);
      await expect(storage.head(keyA('spoof.png'))).resolves.toBeNull();
    });

    it('enforces the purpose size limit and a tighter caller limit (buffer and stream)', async () => {
      const max = STORAGE_PURPOSES.branding.maxBytes;
      const big = Buffer.concat([PNG_BYTES, Buffer.alloc(max)]);
      await expect(
        storage.put(keyA('big.png'), big, { contentType: 'image/png' }),
      ).rejects.toBeInstanceOf(ObjectTooLargeError);
      await expect(
        storage.put(keyA('big.png'), Readable.from([PNG_BYTES, Buffer.alloc(max)]), {
          contentType: 'image/png',
        }),
      ).rejects.toBeInstanceOf(ObjectTooLargeError);
      await expect(
        storage.put(keyA('big.png'), PNG_BYTES, { contentType: 'image/png', maxBytes: 8 }),
      ).rejects.toBeInstanceOf(ObjectTooLargeError);
      await expect(storage.head(keyA('big.png'))).resolves.toBeNull();
    });

    it('rejects traversal and malformed keys on every operation', async () => {
      for (const bad of TRAVERSAL_KEYS) {
        await expect(storage.put(bad, PNG_BYTES, { contentType: 'image/png' })).rejects.toThrow(
          InvalidStorageKeyError,
        );
        await expect(storage.get(bad)).rejects.toThrow(InvalidStorageKeyError);
        await expect(storage.head(bad)).rejects.toThrow(InvalidStorageKeyError);
        await expect(storage.delete(bad)).rejects.toThrow(InvalidStorageKeyError);
        await expect(storage.getSignedReadUrl(bad)).rejects.toThrow(InvalidStorageKeyError);
      }
      await expect(storage.list('org/')).rejects.toThrow(InvalidStorageKeyError);
      await expect(storage.list('')).rejects.toThrow(InvalidStorageKeyError);
      await expect(storage.list(`org/${orgA}/../`)).rejects.toThrow(InvalidStorageKeyError);
    });

    it('signed read URLs work or are explicitly unsupported', async () => {
      const key = keyA('signed.png');
      await storage.put(key, PNG_BYTES, { contentType: 'image/png' });
      if (storage.capabilities.signedReadUrls) {
        const url = await storage.getSignedReadUrl(key, { expiresInSeconds: 60 });
        expect(url).toContain('X-Amz-Expires=60');
        const response = await fetch(url);
        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toBe('image/png');
        expect(response.headers.get('content-disposition')).toBe('inline; filename="signed.png"');
        expect(Buffer.from(await response.arrayBuffer())).toEqual(PNG_BYTES);
        await expect(storage.getSignedReadUrl(key, { expiresInSeconds: 7200 })).rejects.toThrow(
          RangeError,
        );
      } else {
        await expect(storage.getSignedReadUrl(key)).rejects.toBeInstanceOf(
          StorageOperationUnsupportedError,
        );
      }
    });

    it('forTenant() confines callers to their organization', async () => {
      const tenantA = forTenant(storage, orgA);
      const tenantB = forTenant(storage, orgB);
      await tenantA.put('branding', 'scoped.png', PNG_BYTES, { contentType: 'image/png' });
      await expect(tenantB.head('branding', 'scoped.png')).resolves.toBeNull();
      expect((await tenantB.list()).map((i) => i.key)).not.toContain(keyA('scoped.png'));
      expect(() => tenantB.assertOwnKey(keyA('scoped.png'))).toThrow(InvalidStorageKeyError);
      expect(() => tenantA.assertOwnKey(keyA('scoped.png'))).not.toThrow();
      await expect(
        tenantA.put('branding', '../escape.png', PNG_BYTES, { contentType: 'image/png' }),
      ).rejects.toThrow(InvalidStorageKeyError);
    });
  });
}
