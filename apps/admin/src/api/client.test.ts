import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockFetch } from '../test/utils';
import { api, buildUrl, onSessionExpired } from './client';
import { ApiError } from './problem';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('api client', () => {
  it('fills path parameters and drops empty query values', () => {
    expect(
      buildUrl(
        '/api/v1/orgs/{orgId}/nas/{id}',
        { orgId: 'o 1', id: 'n' },
        { limit: 5, cursor: undefined, q: '' },
      ),
    ).toBe('/api/v1/orgs/o%201/nas/n?limit=5');
    expect(() => buildUrl('/api/v1/orgs/{orgId}', {}, undefined)).toThrow(/orgId/);
  });

  it('sends X-Requested-With on every request and an Idempotency-Key on POST only', async () => {
    const calls = mockFetch([
      { method: 'GET', path: '/api/v1/orgs/o/sites', body: { data: [], next_cursor: null } },
      { method: 'POST', path: '/api/v1/orgs/o/sites', status: 201, body: { id: 's' } },
    ]);
    await api('get', '/api/v1/orgs/{orgId}/sites', { params: { orgId: 'o' } });
    await api('post', '/api/v1/orgs/{orgId}/sites', {
      params: { orgId: 'o' },
      body: { name: 'A', slug: 'a' },
      idempotencyKey: 'k',
    });
    expect(calls[0]?.headers['X-Requested-With']).toBe('XMLHttpRequest');
    expect(calls[0]?.headers['Idempotency-Key']).toBeUndefined();
    expect(calls[1]?.headers['X-Requested-With']).toBe('XMLHttpRequest');
    expect(calls[1]?.headers['Idempotency-Key']).toBe('k');
    expect(calls[1]?.headers['Content-Type']).toBe('application/json');
  });

  it('throws ApiError with the problem and signals session expiry on 401 outside auth', async () => {
    mockFetch([
      {
        method: 'GET',
        path: '/api/v1/orgs/o/sites',
        status: 401,
        body: { type: 't', title: 'Unauthorized', status: 401 },
      },
      {
        method: 'GET',
        path: '/api/v1/auth/me',
        status: 401,
        body: { type: 't', title: 'Unauthorized', status: 401 },
      },
    ]);
    const listener = vi.fn();
    const off = onSessionExpired(listener);
    await expect(
      api('get', '/api/v1/orgs/{orgId}/sites', { params: { orgId: 'o' } }),
    ).rejects.toBeInstanceOf(ApiError);
    expect(listener).toHaveBeenCalledTimes(1);
    await expect(api('get', '/api/v1/auth/me', {})).rejects.toMatchObject({ status: 401 });
    expect(listener).toHaveBeenCalledTimes(1);
    off();
  });

  it('turns a non-JSON gateway error into a plain problem', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response('<html>bad gateway</html>', { status: 502, statusText: 'Bad Gateway' }),
        ),
      ),
    );
    await expect(api('get', '/api/v1/auth/me', {})).rejects.toMatchObject({
      status: 502,
      problem: { title: 'Bad Gateway' },
    });
  });
});
