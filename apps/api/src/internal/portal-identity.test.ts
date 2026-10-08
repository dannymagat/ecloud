import { describe, expect, it, vi } from 'vitest';
import { checkSubscriberPassword, dummyPasswordHash } from './portal-identity.js';

const DUMMY = '$argon2id$v=19$m=8192,t=2,p=1$dummy$dummy';

function opts(result = true) {
  const verify = vi.fn((_hash: string, _password: string) => Promise.resolve(result));
  return { verify, dummyHash: () => Promise.resolve(DUMMY) };
}

describe('portal subscriber password check (no "no hash computed" shortcut)', () => {
  it('unknown user: runs the verifier once against the dummy hash, then rejects', async () => {
    const o = opts(true);
    expect(await checkSubscriberPassword(undefined, 'pw', o)).toBe(false);
    expect(o.verify).toHaveBeenCalledTimes(1);
    expect(o.verify).toHaveBeenCalledWith(DUMMY, 'pw');
  });

  it('user without a password hash: verifier runs against the dummy hash', async () => {
    const o = opts(true);
    const user = { password_hash: null, auth_methods: ['password'] };
    expect(await checkSubscriberPassword(user, 'pw', o)).toBe(false);
    expect(o.verify).toHaveBeenCalledWith(DUMMY, 'pw');
  });

  it('known user: verifier runs against the real hash; the password method must be enabled', async () => {
    const ok = opts(true);
    const user = { password_hash: '$argon2id$real', auth_methods: ['password'] };
    expect(await checkSubscriberPassword(user, 'pw', ok)).toBe(true);
    expect(ok.verify).toHaveBeenCalledWith('$argon2id$real', 'pw');
    const disabled = opts(true);
    expect(
      await checkSubscriberPassword({ ...user, auth_methods: ['voucher'] }, 'pw', disabled),
    ).toBe(false);
    expect(disabled.verify).toHaveBeenCalledTimes(1);
    const wrong = opts(false);
    expect(await checkSubscriberPassword(user, 'nope', wrong)).toBe(false);
  });

  it('a verifier error counts as a mismatch', async () => {
    const verify = vi.fn(() => Promise.reject(new Error('bad hash')));
    const user = { password_hash: 'garbage', auth_methods: ['password'] };
    expect(
      await checkSubscriberPassword(user, 'pw', {
        verify,
        dummyHash: () => Promise.resolve(DUMMY),
      }),
    ).toBe(false);
  });

  it('dummy hash: Argon2id with the configured memory cost, computed once per parameter set', async () => {
    const a = await dummyPasswordHash(8192);
    expect(a).toMatch(/^\$argon2id\$v=19\$/);
    const params = new Set(a.split('$')[3]?.split(','));
    expect(params).toEqual(new Set(['m=8192', 't=2', 'p=1']));
    expect(await dummyPasswordHash(8192)).toBe(a);
  });
});
