import { describe, expect, it } from 'vitest';
import { createLogger } from './logger.js';

function capture(): { lines: string[]; log: ReturnType<typeof createLogger> } {
  const lines: string[] = [];
  const log = createLogger({
    name: 'redaction-test',
    level: 'info',
    destination: { write: (chunk: string) => lines.push(chunk) },
  });
  return { lines, log };
}

describe('logger redaction (P10-A additions)', () => {
  it('redacts peppers, MFA material, API / private / preshared keys at any depth up to 3', () => {
    const { lines, log } = capture();
    log.info(
      {
        pepper: 'fake-pepper-value',
        body: { mfa_token: 'fake-mfa-token', recovery_code: 'FAKE-RECOVERY' },
        peer: { config: { privateKey: 'fake-wg-private', presharedKey: 'fake-psk' } },
        api_key: 'eck_fake',
      },
      'x',
    );
    const out = lines.join('');
    for (const value of [
      'fake-pepper-value',
      'fake-mfa-token',
      'FAKE-RECOVERY',
      'fake-wg-private',
      'fake-psk',
      'eck_fake',
    ]) {
      expect(out).not.toContain(value);
    }
    expect(out).toContain('"pepper":"[REDACTED]"');
  });

  it('redacts hyphenated RADIUS password attributes', () => {
    const { lines, log } = capture();
    log.info(
      {
        'User-Password': 'fake-pap',
        radius: { 'CHAP-Password': 'fake-chap', 'User-Name': 'visible-user' },
      },
      'x',
    );
    const out = lines.join('');
    expect(out).not.toContain('fake-pap');
    expect(out).not.toContain('fake-chap');
    expect(out).toContain('visible-user');
  });
});
