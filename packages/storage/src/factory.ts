import type { AppConfig } from '@ecloud/shared';
import { LocalObjectStorage } from './local-driver.js';
import { S3ObjectStorage } from './s3-driver.js';
import type { ObjectStorage } from './types.js';

/** The storage section of `AppConfig` (STORAGE_DRIVER, STORAGE_LOCAL_PATH, S3_*). */
export type StorageConfig = AppConfig['storage'];

/**
 * Creates the configured `ObjectStorage` (D-026). This is the only place drivers are
 * instantiated; business code receives the interface.
 *
 * Credentials come from `loadConfig()` (environment / injected secrets). Empty static
 * credentials fall back to the AWS SDK default provider chain.
 */
export function createStorage(config: StorageConfig): ObjectStorage {
  switch (config.driver) {
    case 'local':
      return new LocalObjectStorage({ rootPath: config.localPath });
    case 's3': {
      const { s3 } = config;
      const hasStaticCredentials = s3.accessKeyId !== '' && s3.secretAccessKey !== '';
      return new S3ObjectStorage({
        endpoint: s3.endpoint,
        region: s3.region,
        bucket: s3.bucket,
        forcePathStyle: s3.forcePathStyle,
        credentials: hasStaticCredentials
          ? { accessKeyId: s3.accessKeyId, secretAccessKey: s3.secretAccessKey }
          : undefined,
      });
    }
    default: {
      const unknown: never = config;
      throw new RangeError(
        `unknown storage driver: ${String((unknown as { driver: unknown }).driver)}`,
      );
    }
  }
}
