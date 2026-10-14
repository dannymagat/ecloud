/**
 * OTP code generation, hashing and identifier normalisation (migration 035).
 *
 * The database-backed half (issue/verify, attempt caps, single use) is covered by the
 * integration suite; this file pins the pure logic that decides whether a code is guessable,
 * whether a hash leaks it, and whether one guest can hold several rate-limit buckets.
 */
import { describe, expect, it } from 'vitest';
import { codeMessage, generateCode, hashCode, normalizeIdentifier, OTP_TTL_S } from './otp.js';

describe('generateCode', () => {
  it('is always six digits, including when the value is small', () => {
    for (let i = 0; i < 200; i += 1) {
      expect(generateCode()).toMatch(/^\d{6}$/);
    }
  });

  it('spans the whole range rather than a predictable slice', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i += 1) seen.add(generateCode());
    // 500 draws from 10^6 collide rarely; a generator stuck in a narrow band would show up here.
    expect(seen.size).toBeGreaterThan(480);
  });
});

describe('hashCode', () => {
  it('is deterministic for the same code and pepper', () => {
    expect(hashCode('123456', 'pepper-one')).toBe(hashCode('123456', 'pepper-one'));
  });

  it('differs with the pepper, so a database dump alone cannot reverse a six-digit code', () => {
    expect(hashCode('123456', 'pepper-one')).not.toBe(hashCode('123456', 'pepper-two'));
  });

  it('never contains the code', () => {
    expect(hashCode('123456', 'pepper-one')).not.toContain('123456');
  });
});

describe('normalizeIdentifier(email)', () => {
  it('lower-cases, so one address cannot become several identities and several rate buckets', () => {
    expect(normalizeIdentifier('email', '  Guest@Example.COM ')).toBe('guest@example.com');
  });

  it.each([
    ['no at sign', 'guest.example.com'],
    ['two at signs', 'a@b@example.com'],
    ['no dot in the domain', 'guest@example'],
    ['whitespace inside', 'gu est@example.com'],
    ['empty', ''],
    ['at sign only', '@'],
  ])('rejects %s', (_label, value) => {
    expect(normalizeIdentifier('email', value)).toBeNull();
  });

  it('rejects an address longer than the column allows', () => {
    expect(normalizeIdentifier('email', `${'a'.repeat(320)}@example.com`)).toBeNull();
  });
});

describe('normalizeIdentifier(sms)', () => {
  it('strips formatting and keeps E.164', () => {
    expect(normalizeIdentifier('sms', '+44 (20) 7946-0958')).toBe('+442079460958');
  });

  it.each([
    ['no plus', '442079460958'],
    ['leading zero after the plus', '+0442079460958'],
    ['too short', '+4420794'],
    ['letters', '+44207946095a'],
  ])('rejects %s', (_label, value) => {
    expect(normalizeIdentifier('sms', value)).toBeNull();
  });
});

describe('codeMessage', () => {
  it('carries the code, the portal name and the expiry, and no link to click', () => {
    const message = codeMessage('123456', 'EZELINK');
    expect(message.subject).toContain('EZELINK');
    expect(message.text).toContain('123456');
    expect(message.text).toContain(String(Math.round(OTP_TTL_S / 60)));
    // A code mail with a login link is a phishing template; the guest types the code instead.
    expect(message.text).not.toMatch(/https?:\/\//);
  });
});
