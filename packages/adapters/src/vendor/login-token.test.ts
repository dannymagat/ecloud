import { describe, expect, it } from 'vitest';
import {
  LOGIN_TOKEN_DEFAULT_TTL_S,
  LOGIN_TOKEN_MAX_TTL_S,
  LoginTokenKey,
  checkLoginToken,
  consumeLoginToken,
  issueLoginToken,
  loginTokenUsedKey,
  type LoginTokenBinding,
  type SingleUseStore,
} from './login-token.js';

const KEY = new LoginTokenKey('test-only-key-material-0123456789');
const NOW = new Date('2026-10-10T12:00:00Z');

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const BINDING: LoginTokenBinding = {
  organizationId: ORG_A,
  siteId: '33333333-3333-4333-8333-333333333333',
  nasId: '44444444-4444-4444-8444-444444444444',
  clientMac: 'AA-BB-CC-DD-EE-01',
  flowId: '55555555-5555-4555-8555-555555555555',
};

/** In-memory SET NX EX. */
class MemoryStore implements SingleUseStore {
  readonly claims = new Map<string, number>();
  claim(key: string, ttlSeconds: number): Promise<boolean> {
    if (this.claims.has(key)) return Promise.resolve(false);
    this.claims.set(key, ttlSeconds);
    return Promise.resolve(true);
  }
}

const at = (seconds: number) => new Date(NOW.getTime() + seconds * 1000);

function tamperPayload(token: string, mutate: (p: Record<string, unknown>) => void): string {
  const [prefix, encoded, sig] = token.split('.') as [string, string, string];
  const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Record<
    string,
    unknown
  >;
  mutate(payload);
  return `${prefix}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${sig}`;
}

describe('login token: issue + accept', () => {
  it('round-trips once with the default TTL and a canonical MAC binding', async () => {
    const issued = issueLoginToken(KEY, BINDING, { now: NOW });
    expect(issued.token.startsWith('lt1.')).toBe(true);
    expect(issued.expiresAt.getTime()).toBe(NOW.getTime() + LOGIN_TOKEN_DEFAULT_TTL_S * 1000);
    const store = new MemoryStore();
    // any MAC spelling of the same address matches
    const result = await consumeLoginToken(
      KEY,
      issued.token,
      { ...BINDING, clientMac: 'aa:bb:cc:dd:ee:01' },
      store,
      at(10),
    );
    expect(result).toEqual({ ok: true, tokenId: issued.tokenId, expiresAt: issued.expiresAt });
    // marker outlives the token (remaining 110 s + grace)
    expect(store.claims.get(loginTokenUsedKey(issued.tokenId))).toBe(110 + 60);
  });

  it('two tokens for the same binding have different ids', () => {
    const a = issueLoginToken(KEY, BINDING, { now: NOW });
    const b = issueLoginToken(KEY, BINDING, { now: NOW });
    expect(a.tokenId).not.toBe(b.tokenId);
    expect(a.token).not.toBe(b.token);
  });

  it('refuses to issue for malformed bindings or TTLs', () => {
    expect(() => issueLoginToken(KEY, { ...BINDING, clientMac: 'nope' }, { now: NOW })).toThrow();
    expect(() => issueLoginToken(KEY, { ...BINDING, nasId: 'x' }, { now: NOW })).toThrow();
    expect(() => issueLoginToken(KEY, BINDING, { now: NOW, ttlS: 0 })).toThrow();
    expect(() =>
      issueLoginToken(KEY, BINDING, { now: NOW, ttlS: LOGIN_TOKEN_MAX_TTL_S + 1 }),
    ).toThrow();
    expect(() => new LoginTokenKey('short')).toThrow();
  });
});

describe('login token: replay', () => {
  it('a second presentation is replayed, even with a different MAC spelling', async () => {
    const { token } = issueLoginToken(KEY, BINDING, { now: NOW });
    const store = new MemoryStore();
    expect((await consumeLoginToken(KEY, token, BINDING, store, at(1))).ok).toBe(true);
    expect(await consumeLoginToken(KEY, token, BINDING, store, at(2))).toEqual({
      ok: false,
      reason: 'replayed',
    });
    expect(
      await consumeLoginToken(KEY, token, { ...BINDING, clientMac: 'aabbccddee01' }, store, at(3)),
    ).toEqual({ ok: false, reason: 'replayed' });
  });

  it('a rejected presentation does not burn the token', async () => {
    const { token } = issueLoginToken(KEY, BINDING, { now: NOW });
    const store = new MemoryStore();
    const wrong = await consumeLoginToken(
      KEY,
      token,
      { ...BINDING, organizationId: ORG_B },
      store,
      at(1),
    );
    expect(wrong).toEqual({ ok: false, reason: 'binding_mismatch' });
    expect(store.claims.size).toBe(0);
    expect((await consumeLoginToken(KEY, token, BINDING, store, at(2))).ok).toBe(true);
  });

  it('a store failure propagates (fail closed, never accepted)', async () => {
    const { token } = issueLoginToken(KEY, BINDING, { now: NOW });
    const broken: SingleUseStore = { claim: () => Promise.reject(new Error('redis down')) };
    await expect(consumeLoginToken(KEY, token, BINDING, broken, at(1))).rejects.toThrow(
      'redis down',
    );
  });
});

describe('login token: expiry', () => {
  it('is valid until exp and refused from exp on', () => {
    const { token } = issueLoginToken(KEY, BINDING, { now: NOW, ttlS: 30 });
    expect(checkLoginToken(KEY, token, BINDING, at(29)).ok).toBe(true);
    expect(checkLoginToken(KEY, token, BINDING, at(30))).toEqual({ ok: false, reason: 'expired' });
    expect(checkLoginToken(KEY, token, BINDING, at(3600))).toEqual({
      ok: false,
      reason: 'expired',
    });
  });

  it('a token from the future (beyond the clock skew) is not yet valid', () => {
    const { token } = issueLoginToken(KEY, BINDING, { now: at(60) });
    expect(checkLoginToken(KEY, token, BINDING, NOW)).toEqual({
      ok: false,
      reason: 'not_yet_valid',
    });
    expect(checkLoginToken(KEY, token, BINDING, at(56)).ok).toBe(true);
  });
});

describe('login token: cross-tenant and binding', () => {
  const { token } = issueLoginToken(KEY, BINDING, { now: NOW });
  it.each([
    ['organization', { organizationId: ORG_B }],
    ['site', { siteId: '66666666-6666-4666-8666-666666666666' }],
    ['NAS', { nasId: '77777777-7777-4777-8777-777777777777' }],
    ['client MAC', { clientMac: 'aa:bb:cc:dd:ee:02' }],
    ['flow', { flowId: '88888888-8888-4888-8888-888888888888' }],
  ])('another %s is a binding mismatch', (_label, change) => {
    expect(checkLoginToken(KEY, token, { ...BINDING, ...change }, at(1))).toEqual({
      ok: false,
      reason: 'binding_mismatch',
    });
  });

  it('a token signed with another key (other deployment / tenant secret) is refused', () => {
    const other = new LoginTokenKey('another-deployment-key-material-xyz');
    const foreign = issueLoginToken(other, BINDING, { now: NOW });
    expect(checkLoginToken(KEY, foreign.token, BINDING, at(1))).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });
});

describe('login token: tampering', () => {
  const { token } = issueLoginToken(KEY, BINDING, { now: NOW });

  it.each([
    ['org rewritten to tenant B', (p: Record<string, unknown>) => (p.o = ORG_B)],
    ['expiry extended', (p: Record<string, unknown>) => (p.exp = (p.exp as number) + 3600)],
    ['token id swapped', (p: Record<string, unknown>) => (p.j = 'A'.repeat(22))],
    ['MAC rewritten', (p: Record<string, unknown>) => (p.m = 'aa:bb:cc:dd:ee:02')],
  ])('%s → bad_signature', (_label, mutate) => {
    expect(checkLoginToken(KEY, tamperPayload(token, mutate), BINDING, at(1))).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('flipped signature bytes → bad_signature', () => {
    const [prefix, encoded, sig] = token.split('.') as [string, string, string];
    const flipped = sig.startsWith('A') ? `B${sig.slice(1)}` : `A${sig.slice(1)}`;
    expect(checkLoginToken(KEY, `${prefix}.${encoded}.${flipped}`, BINDING, at(1))).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
    expect(
      checkLoginToken(KEY, `${prefix}.${encoded}.${sig.slice(0, 10)}`, BINDING, at(1)),
    ).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it.each([
    ['empty', ''],
    ['not a string', 42],
    ['two parts', 'lt1.abc'],
    ['four parts', `${token}.x`],
    ['wrong prefix', token.replace(/^lt1/, 'lt2')],
    ['non base64url payload', 'lt1.a+b.c'],
    ['oversized', `lt1.${'a'.repeat(2000)}.b`],
  ])('%s → malformed', (_label, value) => {
    expect(checkLoginToken(KEY, value, BINDING, at(1))).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });

  it('a validly signed payload with extra fields or a too-long lifetime is malformed', () => {
    const forge = (payload: Record<string, unknown>) => {
      const body = `lt1.${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
      return `${body}.${KEY.mac(body).toString('base64url')}`;
    };
    const base = {
      o: BINDING.organizationId,
      s: BINDING.siteId,
      n: BINDING.nasId,
      m: 'aa:bb:cc:dd:ee:01',
      f: BINDING.flowId,
      j: 'A'.repeat(22),
      iat: NOW.getTime() / 1000,
      exp: NOW.getTime() / 1000 + 60,
    };
    expect(checkLoginToken(KEY, forge(base), BINDING, at(1)).ok).toBe(true);
    expect(checkLoginToken(KEY, forge({ ...base, admin: true }), BINDING, at(1)).ok).toBe(false);
    expect(
      checkLoginToken(
        KEY,
        forge({ ...base, exp: base.iat + LOGIN_TOKEN_MAX_TTL_S + 1 }),
        BINDING,
        at(1),
      ),
    ).toEqual({ ok: false, reason: 'malformed' });
  });
});
