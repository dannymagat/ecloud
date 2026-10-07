import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildEnvelope, signPayload, webhookJobId } from './outbox.js';

describe('outbox envelope', () => {
  it('wraps payload.data with id, occurred_at, organization and site', () => {
    const env = buildEnvelope({
      id: 42,
      event: 'session.started',
      organization_id: 'org-1',
      payload: { site_id: 'site-1', data: { session_id: 's-1' } },
      created_at: new Date('2026-01-01T00:00:00Z'),
    });
    expect(env).toEqual({
      event: 'session.started',
      id: 'evt_42',
      occurred_at: '2026-01-01T00:00:00.000Z',
      organization_id: 'org-1',
      site_id: 'site-1',
      data: { session_id: 's-1' },
    });
  });
  it('uses the whole payload as data for rows written without the worker shape', () => {
    const env = buildEnvelope({
      id: 1,
      event: 'policy.updated',
      organization_id: null,
      payload: { policy_id: 'p' },
      created_at: new Date(0),
    });
    expect(env.data).toEqual({ policy_id: 'p' });
    expect(env).not.toHaveProperty('site_id');
  });
  it('job ids are deterministic and colon-free', () => {
    expect(webhookJobId(7, 'abc')).toBe('wh-7-abc');
  });
});

describe('webhook signature', () => {
  it('is t=<ts>,v1=HMAC-SHA256(secret, "<ts>.<body>")', () => {
    const body = '{"a":1}';
    const expected = createHmac('sha256', 'placeholder').update(`1700000000.${body}`).digest('hex');
    expect(signPayload('placeholder', 1700000000, body)).toBe(`t=1700000000,v1=${expected}`);
  });
});
