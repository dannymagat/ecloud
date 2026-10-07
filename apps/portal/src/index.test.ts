import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { PACKAGE_NAME, createServer } from './index.js';

describe('@ecloud/portal', () => {
  it('exports its package name', () => {
    expect(PACKAGE_NAME).toBe('@ecloud/portal');
  });

  it('GET /healthz returns status ok', async () => {
    const res = await request(createServer()).get('/healthz');
    expect(res.status).toBe(200);
    const body: unknown = res.body;
    expect(body).toEqual({ status: 'ok' });
  });
});
