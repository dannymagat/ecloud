// S3 driver tests. The contract suite runs only against a real S3-compatible endpoint:
//   ECLOUD_TEST_S3_ENDPOINT=http://127.0.0.1:<port> ECLOUD_TEST_S3_ACCESS_KEY_ID=... \
//   ECLOUD_TEST_S3_SECRET_ACCESS_KEY=... [ECLOUD_TEST_S3_BUCKET=ecloud-test] npm test
// Without ECLOUD_TEST_S3_ENDPOINT it is skipped (no S3 service is part of the dev stack, D-026).
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ObjectNotFoundError, StorageBackendError } from './errors.js';
import { S3ObjectStorage } from './s3-driver.js';
import { describeObjectStorageContract } from './storage.contract.js';

const endpoint = process.env.ECLOUD_TEST_S3_ENDPOINT;
const bucket = process.env.ECLOUD_TEST_S3_BUCKET ?? 'ecloud-test';
const region = process.env.ECLOUD_TEST_S3_REGION ?? 'us-east-1';
const accessKeyId = process.env.ECLOUD_TEST_S3_ACCESS_KEY_ID;
const secretAccessKey = process.env.ECLOUD_TEST_S3_SECRET_ACCESS_KEY;
const credentials =
  accessKeyId !== undefined && secretAccessKey !== undefined
    ? { accessKeyId, secretAccessKey }
    : undefined;

async function ensureBucket(): Promise<void> {
  const client = new S3Client({ endpoint, region, forcePathStyle: true, credentials });
  try {
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
  } catch (error) {
    const name = (error as { name?: string }).name;
    if (name !== 'BucketAlreadyOwnedByYou' && name !== 'BucketAlreadyExists') throw error;
  } finally {
    client.destroy();
  }
}

if (endpoint === undefined || endpoint === '') {
  describe('ObjectStorage contract: s3', () => {
    it.skip('skipped: set ECLOUD_TEST_S3_ENDPOINT (and credentials) to run against a real S3-compatible endpoint', () => {});
  });
} else {
  describeObjectStorageContract('s3', async () => {
    await ensureBucket();
    return new S3ObjectStorage({ endpoint, region, bucket, credentials, forcePathStyle: true });
  });
}

describe('S3ObjectStorage specifics (no network)', () => {
  it('requires a bucket name', () => {
    expect(() => new S3ObjectStorage({ bucket: ' ' })).toThrow(RangeError);
  });

  const KEY = 'org/00000000-0000-4000-8000-000000000000/branding/a.png';
  const unitStorage = () =>
    new S3ObjectStorage({
      endpoint: 'http://127.0.0.1:9',
      bucket: 'unit-bucket',
      forcePathStyle: true,
      credentials: { accessKeyId: 'test-access-key', secretAccessKey: 'test-secret-key' },
    });
  const s3Error = (name: string, status: number) =>
    Object.assign(new Error(name), { name, $metadata: { httpStatusCode: status } });

  /** Stubs `S3Client.send`: `responder` gets the command and returns a value or throws. */
  function stubSend(responder: (command: unknown) => unknown) {
    return vi
      .spyOn(S3Client.prototype, 'send')
      .mockImplementation((command: unknown) => Promise.resolve().then(() => responder(command)));
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('maps NoSuchKey / NotFound to a missing object', async () => {
    const storage = unitStorage();
    stubSend((command) => {
      if (command instanceof GetObjectCommand) throw s3Error('NoSuchKey', 404);
      if (command instanceof HeadObjectCommand) throw s3Error('NotFound', 404);
      if (command instanceof HeadBucketCommand) return {};
      throw new Error('unexpected command');
    });
    await expect(storage.get(KEY)).rejects.toBeInstanceOf(ObjectNotFoundError);
    await expect(storage.head(KEY)).resolves.toBeNull();
    await storage.close();
  });

  it('maps NoSuchBucket and bucket-level 404s to StorageBackendError (503), not "not found"', async () => {
    const storage = unitStorage();
    stubSend((command) => {
      if (command instanceof GetObjectCommand) throw s3Error('NoSuchBucket', 404);
      if (command instanceof DeleteObjectCommand) throw s3Error('NoSuchBucket', 404);
      // HEAD 404s carry no body: object HEAD says NotFound, and the bucket probe fails too.
      if (command instanceof HeadObjectCommand) throw s3Error('NotFound', 404);
      if (command instanceof HeadBucketCommand) throw s3Error('NotFound', 404);
      throw new Error('unexpected command');
    });
    for (const call of [
      () => storage.get(KEY),
      () => storage.head(KEY),
      () => storage.delete(KEY),
    ]) {
      const error = await call().then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(StorageBackendError);
      expect((error as StorageBackendError).status).toBe(503);
    }
    await storage.close();
  });

  it('signs URLs that pin Content-Type and Content-Disposition from stored metadata', async () => {
    const storage = unitStorage();
    expect(storage.capabilities.signedReadUrls).toBe(true);
    stubSend((command) => {
      if (command instanceof HeadObjectCommand) {
        return { ContentType: 'image/png', ContentLength: 10, Metadata: {} };
      }
      throw new Error('unexpected command');
    });
    const url = new URL(await storage.getSignedReadUrl(KEY, { expiresInSeconds: 120 }));
    expect(url.pathname).toBe(`/unit-bucket/${KEY}`);
    expect(url.searchParams.get('X-Amz-Expires')).toBe('120');
    expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
    expect(url.searchParams.get('response-content-type')).toBe('image/png');
    expect(url.searchParams.get('response-content-disposition')).toBe('inline; filename="a.png"');
    await storage.close();
  });

  it('refuses to sign a URL for a missing object', async () => {
    const storage = unitStorage();
    stubSend((command) => {
      if (command instanceof HeadObjectCommand) throw s3Error('NotFound', 404);
      if (command instanceof HeadBucketCommand) return {};
      throw new Error('unexpected command');
    });
    await expect(storage.getSignedReadUrl(KEY)).rejects.toBeInstanceOf(ObjectNotFoundError);
    await storage.close();
  });

  it('maps an unreachable endpoint to StorageBackendError without leaking the endpoint', async () => {
    const storage = new S3ObjectStorage({
      endpoint: 'http://127.0.0.1:9',
      bucket: 'unit-bucket',
      forcePathStyle: true,
      credentials: { accessKeyId: 'test-access-key', secretAccessKey: 'test-secret-key' },
      requestTimeoutMs: 1_000,
    });
    const error = await storage.checkHealth().then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(StorageBackendError);
    expect((error as StorageBackendError).toProblem()).toEqual({
      type: 'urn:ecloud:problem:storage-unavailable',
      title: 'Storage Unavailable',
      status: 503,
      detail: 'storage health check failed',
    });
    await storage.close();
  });
});
