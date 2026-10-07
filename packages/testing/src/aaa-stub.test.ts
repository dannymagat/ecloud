import { afterEach, describe, expect, it } from 'vitest';
import {
  AAA_AUTHORIZE_PATH,
  AAA_POST_AUTH_PATH,
  attributeValue,
  buildAcceptPolicy,
  buildRejectPolicy,
  policyValue,
  startAaaStub,
  type AaaStub,
} from './aaa-stub.js';

const TOKEN = 'unit-test-token';
let stub: AaaStub | undefined;

afterEach(async () => {
  await stub?.close();
  stub = undefined;
});

function post(path: string, body: unknown, token: string | null = TOKEN): Promise<Response> {
  if (stub === undefined) throw new Error('stub not started');
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token !== null) headers['x-internal-token'] = token;
  return fetch(`${stub.url}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
}

const REQUEST = { 'User-Name': { type: 'string', value: ['pc-unit'] } };

describe('policy builders', () => {
  it('always emits the object form with do_xlat=false', () => {
    const policy = buildAcceptPolicy({
      cleartextPassword: 'pw',
      reply: { 'Session-Timeout': 3600, 'Reply-Message': 'Welcome %{User-Name}' },
    });
    expect(policy['control:Auth-Type']).toEqual(policyValue('PAP'));
    expect(policy['control:Cleartext-Password']).toEqual({
      value: ['pw'],
      op: ':=',
      do_xlat: false,
    });
    expect(Object.values(policy).every((v) => v.do_xlat === false)).toBe(true);
    expect(policy['reply:Reply-Message']?.value).toEqual(['Welcome %{User-Name}']);
  });

  it('refuses PAP without a cleartext password and allows Auth-Type Accept', () => {
    expect(() => buildAcceptPolicy({ authType: 'PAP' })).toThrow(/cleartextPassword/);
    expect(buildAcceptPolicy({ authType: 'Accept' })).toEqual({
      'control:Auth-Type': policyValue('Accept'),
    });
    expect(buildRejectPolicy()).toBeUndefined();
    expect(buildRejectPolicy('quota exhausted')).toEqual({
      'reply:Reply-Message': policyValue('quota exhausted'),
    });
  });
});

describe('startAaaStub', () => {
  it('answers 500 by default and records the parsed contract body', async () => {
    stub = await startAaaStub({ token: TOKEN });
    const res = await post(AAA_AUTHORIZE_PATH, REQUEST);
    expect(res.status).toBe(500);
    expect(stub.requests).toHaveLength(1);
    expect(attributeValue(stub.requests[0]?.body, 'User-Name')).toBe('pc-unit');
  });

  it('accept -> 200 policy; reject -> 401 with Reply-Message; post-auth -> 204', async () => {
    stub = await startAaaStub({ token: TOKEN });
    const policy = buildAcceptPolicy({ cleartextPassword: 'pw' });
    stub.setMode({ kind: 'accept', policy });
    const accepted = await post(AAA_AUTHORIZE_PATH, REQUEST);
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual(policy);

    stub.setMode({ kind: 'reject', replyMessage: 'quota exhausted' });
    const rejected = await post(AAA_AUTHORIZE_PATH, REQUEST);
    expect(rejected.status).toBe(401);
    expect(await rejected.json()).toEqual(buildRejectPolicy('quota exhausted'));

    const postAuth = await post(AAA_POST_AUTH_PATH, REQUEST);
    expect(postAuth.status).toBe(204);
    expect(stub.requests.map((r) => r.status)).toEqual([200, 401, 204]);
  });

  it('answers 401 without a body when the internal token is wrong or missing', async () => {
    stub = await startAaaStub({
      token: TOKEN,
      mode: { kind: 'accept', policy: buildAcceptPolicy({ authType: 'Accept' }) },
    });
    const wrong = await post(AAA_AUTHORIZE_PATH, REQUEST, 'nope');
    expect(wrong.status).toBe(401);
    expect(await wrong.text()).toBe('');
    const missing = await post(AAA_AUTHORIZE_PATH, REQUEST, null);
    expect(missing.status).toBe(401);
  });

  it('404s unknown paths and waits for matching requests', async () => {
    stub = await startAaaStub();
    const res = await post('/internal/other', {});
    expect(res.status).toBe(404);
    const pending = stub.waitForRequest((r) => r.path === AAA_POST_AUTH_PATH, 1_000);
    await post(AAA_POST_AUTH_PATH, REQUEST);
    await expect(pending).resolves.toMatchObject({ status: 204 });
    stub.clearRequests();
    expect(stub.requests).toHaveLength(0);
    await expect(stub.waitForRequest(() => true, 50)).rejects.toThrow(/no matching request/);
  });
});
