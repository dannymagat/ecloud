import { VENDOR_API_ADAPTER_KEYS, openSealedSecret, sealSecret } from '@ecloud/vendor-api';
import { describe, expect, it } from 'vitest';
import { Envelope, openSecretRef, sealSecretRef } from './crypto.js';
import { NAS_ADAPTER_KEYS, nasAdapter } from './nas-adapter.js';
import { VENDOR_API_SECRET_PURPOSE } from './routes/controllers.js';
import { ADAPTER_API_KIND } from './vendor-api/store.js';

const KEY = 'ecloud_test_data_encryption_key_cycle_d';

describe('Cycle D sealed-store compatibility', () => {
  it('the API Envelope and @ecloud/vendor-api open each other’s vendor-API refs', () => {
    const envelope = new Envelope(KEY, VENDOR_API_SECRET_PURPOSE);
    expect(openSealedSecret(KEY, sealSecretRef(envelope, 'test-secret-a'))).toBe('test-secret-a');
    expect(openSecretRef(envelope, sealSecret(KEY, 'test-secret-b'))).toBe('test-secret-b');
    // another purpose (NAS secrets) cannot be opened as a vendor-API secret
    const nasEnvelope = new Envelope(KEY, 'ecloud:nas:secret:v1');
    expect(() => openSealedSecret(KEY, sealSecretRef(nasEnvelope, 'x'))).toThrow();
  });
});

describe('Cycle D adapter keys', () => {
  it('vendor-API NAS keys are never RADIUS engine adapters', () => {
    for (const key of VENDOR_API_ADAPTER_KEYS) {
      expect(NAS_ADAPTER_KEYS as readonly string[]).not.toContain(key);
      expect(nasAdapter(key)).toBeNull();
      expect(ADAPTER_API_KIND[key]).toBeDefined();
    }
  });
});
