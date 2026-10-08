import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { ContentTypeNotAllowedError, ObjectTooLargeError } from './errors.js';
import {
  assertContentMatchesType,
  assertContentTypeAllowed,
  effectiveMaxBytes,
  isStoragePurpose,
  normalizeContentType,
  STORAGE_PURPOSES,
} from './purposes.js';
import { JPEG_BYTES, PNG_BYTES, WEBP_BYTES } from './storage.contract.js';
import { prepareUpload, readBodyWithLimit } from './upload.js';

describe('purpose policies', () => {
  it('branding allows png, jpeg and webp up to 5 MiB, and never svg', () => {
    expect(STORAGE_PURPOSES.branding.allowedContentTypes).toEqual([
      'image/png',
      'image/jpeg',
      'image/webp',
    ]);
    expect(STORAGE_PURPOSES.branding.maxBytes).toBe(5 * 1024 * 1024);
    expect(() => assertContentTypeAllowed('branding', 'image/svg+xml')).toThrow(
      ContentTypeNotAllowedError,
    );
  });

  it('recognises only registered purposes', () => {
    expect(isStoragePurpose('branding')).toBe(true);
    expect(isStoragePurpose('toString')).toBe(false);
    expect(isStoragePurpose('__proto__')).toBe(false);
  });

  it('normalises content types', () => {
    expect(normalizeContentType(' Image/PNG ; q=1')).toBe('image/png');
    expect(normalizeContentType('')).toBe('');
    expect(normalizeContentType('image')).toBe('');
    expect(normalizeContentType('image/png\r\nX-Evil: 1')).toBe('');
  });

  it.each(['', 'text/html', 'application/octet-stream', 'image/gif', 'image/svg+xml'])(
    'rejects declared type %j for branding',
    (type) => {
      expect(() => assertContentTypeAllowed('branding', type)).toThrow(ContentTypeNotAllowedError);
    },
  );

  it('sniffs magic bytes', () => {
    expect(() => assertContentMatchesType('image/png', PNG_BYTES)).not.toThrow();
    expect(() => assertContentMatchesType('image/jpeg', JPEG_BYTES)).not.toThrow();
    expect(() => assertContentMatchesType('image/webp', WEBP_BYTES)).not.toThrow();
    expect(() => assertContentMatchesType('image/png', JPEG_BYTES)).toThrow(
      ContentTypeNotAllowedError,
    );
    expect(() => assertContentMatchesType('image/webp', Buffer.from('RIFF0000AVI '))).toThrow(
      ContentTypeNotAllowedError,
    );
    expect(() => assertContentMatchesType('image/png', new Uint8Array())).toThrow(
      ContentTypeNotAllowedError,
    );
  });

  it('lets callers tighten but never loosen the size limit', () => {
    expect(effectiveMaxBytes('branding')).toBe(5 * 1024 * 1024);
    expect(effectiveMaxBytes('branding', 1024)).toBe(1024);
    expect(effectiveMaxBytes('branding', 50 * 1024 * 1024)).toBe(5 * 1024 * 1024);
    expect(() => effectiveMaxBytes('branding', -1)).toThrow(RangeError);
  });
});

describe('upload preparation', () => {
  it('reads streams up to the limit and fails past it', async () => {
    const chunks = () => Readable.from([Buffer.alloc(4), Buffer.alloc(4)]);
    await expect(readBodyWithLimit(chunks(), 8)).resolves.toHaveLength(8);
    await expect(readBodyWithLimit(chunks(), 7)).rejects.toBeInstanceOf(ObjectTooLargeError);
    await expect(readBodyWithLimit(Buffer.alloc(9), 8)).rejects.toBeInstanceOf(ObjectTooLargeError);
  });

  it('copies caller buffers so later mutation cannot change what was checked', async () => {
    const original = Buffer.from(PNG_BYTES);
    const read = await readBodyWithLimit(original, 1024);
    original.fill(0);
    expect(read).toEqual(PNG_BYTES);
  });

  it('returns normalised type, bytes and sha256', async () => {
    const prepared = await prepareUpload(
      'org/0190a6c1-7d2e-7c3b-9a10-2b3c4d5e6f70/branding/a.png',
      PNG_BYTES,
      { contentType: 'IMAGE/PNG' },
    );
    expect(prepared.contentType).toBe('image/png');
    expect(prepared.bytes).toEqual(PNG_BYTES);
    expect(prepared.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('reports the limit in the problem document', () => {
    expect(new ObjectTooLargeError(10).toProblem()).toMatchObject({ status: 413, max_bytes: 10 });
  });
});
