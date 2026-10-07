import { describe, expect, it } from 'vitest';
import {
  WebhookTargetError,
  createSafeWebhookFetch,
  isPublicWebhookAddress,
  webhookAddress,
  webhookTarget,
  type Resolver,
} from './webhook-transport.js';

const resolverOf =
  (...addresses: string[]): Resolver =>
  () =>
    Promise.resolve(
      addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })),
    );

describe('isPublicWebhookAddress', () => {
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.19.0.1',
    '192.168.1.1',
    '169.254.169.254',
    '100.100.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '255.255.255.255',
    '::1',
    '::',
    'fe80::1',
    'fd00::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::ffff:169.254.169.254',
    '64:ff9b::a9fe:a9fe',
    '2002:7f00:1::',
    'not-an-ip',
  ])('refuses %s', (address) => {
    expect(isPublicWebhookAddress(address)).toBe(false);
  });

  it.each(['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '::ffff:8.8.8.8'])(
    'allows public %s',
    (address) => {
      expect(isPublicWebhookAddress(address)).toBe(true);
    },
  );
});

describe('webhookTarget', () => {
  it('accepts a public https URL', () => {
    expect(webhookTarget('https://hooks.example.com/x?y=1').hostname).toBe('hooks.example.com');
  });

  it.each([
    ['http://hooks.example.com/', /https/],
    ['ftp://hooks.example.com/', /https/],
    ['https://user:pw@hooks.example.com/', /credentials/],
    ['https://localhost/', /not allowed/],
    ['https://api.localhost/', /not allowed/],
    ['https://127.0.0.1/', /public/],
    ['https://[::1]/', /public/],
    ['https://169.254.169.254/latest/meta-data', /public/],
    ['not a url', /valid URL/],
  ])('refuses %s', (url, message) => {
    expect(() => webhookTarget(url)).toThrow(message);
  });
});

describe('webhookAddress (DNS pinning)', () => {
  it('returns the first address when every answer is public', async () => {
    await expect(
      webhookAddress(new URL('https://hooks.example.com/'), resolverOf('8.8.8.8', '1.1.1.1')),
    ).resolves.toEqual({ address: '8.8.8.8', family: 4 });
  });

  it('refuses a name that resolves to a private address (DNS rebinding to internal)', async () => {
    await expect(
      webhookAddress(new URL('https://rebind.example.com/'), resolverOf('10.0.0.5')),
    ).rejects.toBeInstanceOf(WebhookTargetError);
  });

  it('refuses a mixed answer set', async () => {
    await expect(
      webhookAddress(new URL('https://mixed.example.com/'), resolverOf('8.8.8.8', '127.0.0.1')),
    ).rejects.toThrow(/non-public/);
  });

  it('refuses a name that does not resolve', async () => {
    await expect(
      webhookAddress(new URL('https://nx.example.com/'), () =>
        Promise.reject(new Error('ENOTFOUND')),
      ),
    ).rejects.toThrow(/does not resolve/);
  });
});

describe('createSafeWebhookFetch', () => {
  it('rejects before any connection when the target is internal', async () => {
    let resolved = false;
    const fetch = createSafeWebhookFetch(() => {
      resolved = true;
      return Promise.resolve([{ address: '127.0.0.1', family: 4 }]);
    });
    await expect(
      fetch('https://internal.example.com/hook', {
        method: 'POST',
        headers: {},
        body: '{}',
        signal: AbortSignal.timeout(1000),
      }),
    ).rejects.toBeInstanceOf(WebhookTargetError);
    expect(resolved).toBe(true);
  });

  it('rejects plain http without resolving', async () => {
    let resolved = false;
    const fetch = createSafeWebhookFetch(() => {
      resolved = true;
      return Promise.resolve([{ address: '8.8.8.8', family: 4 }]);
    });
    await expect(
      fetch('http://hooks.example.com/', {
        method: 'POST',
        headers: {},
        body: '{}',
        signal: AbortSignal.timeout(1000),
      }),
    ).rejects.toThrow(/https/);
    expect(resolved).toBe(false);
  });
});
