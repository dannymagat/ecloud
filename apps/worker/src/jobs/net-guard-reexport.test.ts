import * as shared from '@ecloud/shared';
import { describe, expect, it } from 'vitest';
import * as transport from './webhook-transport.js';

describe('webhook-transport re-exports the shared URL guard unchanged (L3)', () => {
  it('is the same code', () => {
    expect(transport.webhookTarget).toBe(shared.webhookTarget);
    expect(transport.isPublicWebhookAddress).toBe(shared.isPublicWebhookAddress);
    expect(transport.WebhookTargetError).toBe(shared.WebhookTargetError);
  });

  it('the delivery path refuses trailing-dot localhost and ::/96 targets before any I/O (review F1/F2)', async () => {
    const resolve = () => Promise.reject(new Error('must not resolve'));
    const fetch = transport.createSafeWebhookFetch(resolve);
    for (const url of [
      'https://localhost./hook',
      'https://[::127.0.0.1]/hook',
      'https://[::7f00:1]/',
    ]) {
      await expect(
        fetch(url, { method: 'POST', headers: {}, body: '{}', signal: AbortSignal.timeout(1000) }),
        url,
      ).rejects.toBeInstanceOf(transport.WebhookTargetError);
    }
    // a public name resolving into ::/96 is refused at resolution time as well
    const compat = transport.createSafeWebhookFetch(() =>
      Promise.resolve([{ address: '::7f00:1', family: 6 }]),
    );
    await expect(
      compat('https://hooks.example.com/', {
        method: 'POST',
        headers: {},
        body: '{}',
        signal: AbortSignal.timeout(1000),
      }),
    ).rejects.toThrow(/non-public/);
  });
});
