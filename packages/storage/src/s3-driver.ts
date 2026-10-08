import { Readable } from 'node:stream';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { ObjectNotFoundError, StorageBackendError } from './errors.js';
import { parseObjectKey, parseTenantPrefix, type ObjectKey } from './keys.js';
import {
  resolveListLimit,
  resolveSignedUrlTtl,
  type ListObjectsOptions,
  type ObjectBody,
  type ObjectMetadata,
  type ObjectStorage,
  type ObjectSummary,
  type PutObjectOptions,
  type SignedUrlOptions,
  type StoredObject,
} from './types.js';
import { prepareUpload } from './upload.js';

export interface S3StorageOptions {
  /** S3-compatible endpoint URL (operator configuration, never user input). Omit for AWS. */
  endpoint?: string | undefined;
  /** Region; defaults to `us-east-1` (most S3-compatible services ignore it). */
  region?: string | undefined;
  bucket: string;
  /**
   * Static credentials from env / secret injection (S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY).
   * When omitted the AWS SDK default provider chain is used (env, web identity, instance role).
   */
  credentials?: { accessKeyId: string; secretAccessKey: string } | undefined;
  /** Path-style addressing (`endpoint/bucket/key`), required by most self-hosted S3 stores. */
  forcePathStyle?: boolean | undefined;
  /** Request timeout in milliseconds (default 10 000). */
  requestTimeoutMs?: number | undefined;
}

const SHA256_METADATA = 'sha256';

const errorName = (error: unknown): string | undefined =>
  typeof error === 'object' && error !== null ? (error as { name?: string }).name : undefined;

/**
 * Object-level "not found" only. Matching on HTTP 404 alone would also catch `NoSuchBucket`
 * (a misconfiguration or a deleted bucket), which must surface as a backend failure (503), not
 * as a missing object. `NotFound` is what the SDK reports for a body-less HEAD 404.
 */
const isObjectNotFound = (error: unknown): boolean => {
  const name = errorName(error);
  return name === 'NoSuchKey' || name === 'NotFound';
};

/**
 * S3-compatible driver (AWS SDK v3). Works against any S3 API (AWS, Wasabi, Backblaze B2,
 * Cloudflare R2, MinIO in tests). Objects carry `Content-Type` and an `x-amz-meta-sha256`.
 *
 * Checksum calculation is set to `WHEN_REQUIRED` because several S3-compatible services reject
 * the SDK's default CRC32 trailing checksums.
 */
export class S3ObjectStorage implements ObjectStorage {
  readonly driver = 's3' as const;
  readonly capabilities = { signedReadUrls: true } as const;

  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(options: S3StorageOptions) {
    if (options.bucket.trim() === '') throw new RangeError('S3 bucket name is required');
    this.bucket = options.bucket;
    const config: S3ClientConfig = {
      region: options.region ?? 'us-east-1',
      forcePathStyle: options.forcePathStyle ?? false,
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
      maxAttempts: 3,
      requestHandler: {
        requestTimeout: options.requestTimeoutMs ?? 10_000,
        connectionTimeout: options.requestTimeoutMs ?? 10_000,
      },
    };
    if (options.endpoint !== undefined) config.endpoint = options.endpoint;
    if (options.credentials !== undefined) config.credentials = options.credentials;
    this.client = new S3Client(config);
  }

  async put(rawKey: string, body: ObjectBody, options: PutObjectOptions): Promise<ObjectMetadata> {
    const upload = await prepareUpload(rawKey, body, options);
    await this.guard('put', () =>
      this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: upload.key,
          Body: upload.bytes,
          ContentType: upload.contentType,
          ContentLength: upload.bytes.byteLength,
          Metadata: { [SHA256_METADATA]: upload.sha256 },
        }),
      ),
    );
    return {
      key: upload.key,
      size: upload.bytes.byteLength,
      contentType: upload.contentType,
      sha256: upload.sha256,
      lastModified: new Date(),
    };
  }

  async get(rawKey: string): Promise<StoredObject> {
    const { key } = parseObjectKey(rawKey);
    const output = await this.guard(
      'get',
      () => this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key })),
      key,
    );
    if (!(output.Body instanceof Readable)) {
      throw new StorageBackendError('get', { cause: new Error('response body is not a stream') });
    }
    return {
      key,
      size: output.ContentLength ?? 0,
      contentType: output.ContentType ?? 'application/octet-stream',
      sha256: output.Metadata?.[SHA256_METADATA],
      lastModified: output.LastModified ?? new Date(0),
      body: output.Body,
    };
  }

  async head(rawKey: string): Promise<ObjectMetadata | null> {
    const { key } = parseObjectKey(rawKey);
    try {
      const output = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return {
        key,
        size: output.ContentLength ?? 0,
        contentType: output.ContentType ?? 'application/octet-stream',
        sha256: output.Metadata?.[SHA256_METADATA],
        lastModified: output.LastModified ?? new Date(0),
      };
    } catch (error) {
      if (!isObjectNotFound(error)) throw new StorageBackendError('head', { cause: error });
    }
    // A HEAD 404 has no body, so `NotFound` cannot tell a missing object from a missing bucket.
    // Confirm the bucket before answering "no such object".
    await this.guard('head', () =>
      this.client.send(new HeadBucketCommand({ Bucket: this.bucket })),
    );
    return null;
  }

  async delete(rawKey: string): Promise<void> {
    const { key } = parseObjectKey(rawKey);
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
    } catch (error) {
      if (isObjectNotFound(error)) return;
      throw new StorageBackendError('delete', { cause: error });
    }
  }

  async list(rawPrefix: string, options?: ListObjectsOptions): Promise<ObjectSummary[]> {
    const { prefix } = parseTenantPrefix(rawPrefix);
    const limit = resolveListLimit(options);
    const results: ObjectSummary[] = [];
    let continuationToken: string | undefined;
    do {
      const page = await this.guard('list', () =>
        this.client.send(
          new ListObjectsV2Command({
            Bucket: this.bucket,
            Prefix: prefix,
            MaxKeys: Math.min(1000, limit - results.length),
            ContinuationToken: continuationToken,
          }),
        ),
      );
      for (const item of page.Contents ?? []) {
        if (item.Key === undefined) continue;
        // Skip anything in the bucket that is not a valid ECLOUD key under this prefix.
        let key: ObjectKey;
        try {
          key = parseObjectKey(item.Key).key;
        } catch {
          continue;
        }
        if (!key.startsWith(prefix)) continue;
        results.push({ key, size: item.Size ?? 0, lastModified: item.LastModified ?? new Date(0) });
      }
      continuationToken = page.IsTruncated === true ? page.NextContinuationToken : undefined;
    } while (continuationToken !== undefined && results.length < limit);
    results.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    return results.slice(0, limit);
  }

  /**
   * Presigned GET that pins the response headers to the stored metadata: `Content-Type` from the
   * upload-validated type and `Content-Disposition: inline; filename="<id>"` (the id charset
   * needs no escaping). Throws `ObjectNotFoundError` when the object does not exist.
   */
  async getSignedReadUrl(rawKey: string, options?: SignedUrlOptions): Promise<string> {
    const { key, id } = parseObjectKey(rawKey);
    const expiresIn = resolveSignedUrlTtl(options);
    const meta = await this.head(key);
    if (meta === null) throw new ObjectNotFoundError(key);
    return this.guard('getSignedReadUrl', () =>
      getSignedUrl(
        this.client,
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: key,
          ResponseContentType: meta.contentType,
          ResponseContentDisposition: `inline; filename="${id}"`,
        }),
        { expiresIn },
      ),
    );
  }

  async checkHealth(): Promise<void> {
    await this.guard('health check', () =>
      this.client.send(new HeadBucketCommand({ Bucket: this.bucket })),
    );
  }

  close(): Promise<void> {
    this.client.destroy();
    return Promise.resolve();
  }

  /** Maps SDK failures to storage errors without leaking endpoint or credential details. */
  private async guard<T>(
    operation: string,
    fn: () => Promise<T>,
    notFoundKey?: string,
  ): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (notFoundKey !== undefined && isObjectNotFound(error))
        throw new ObjectNotFoundError(notFoundKey);
      throw new StorageBackendError(operation, { cause: error });
    }
  }
}
