import { loadConfig } from '@ecloud/shared';
import { describe, expect, it } from 'vitest';
import { createStorage } from './factory.js';

describe('createStorage', () => {
  it('creates the local driver by default from config', async () => {
    const storage = createStorage(
      loadConfig({ NODE_ENV: 'test', STORAGE_LOCAL_PATH: './var/test-storage' }).storage,
    );
    expect(storage.driver).toBe('local');
    expect(storage.capabilities.signedReadUrls).toBe(false);
    await storage.close();
  });

  it('creates the s3 driver from S3_* config without contacting the endpoint', async () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      STORAGE_DRIVER: 's3',
      S3_ENDPOINT: 'http://127.0.0.1:9',
      S3_BUCKET: 'unit-bucket',
      S3_ACCESS_KEY_ID: 'test-access-key',
      S3_SECRET_ACCESS_KEY: 'test-secret-key',
      S3_FORCE_PATH_STYLE: 'true',
    });
    const storage = createStorage(config.storage);
    expect(storage.driver).toBe('s3');
    expect(storage.capabilities.signedReadUrls).toBe(true);
    await storage.close();
  });
});
