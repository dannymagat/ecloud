import { describe, expect, it } from 'vitest';
import { canonicalCertSerial, radsecCertificateAccepted } from './radsec.js';

describe('RadSec certificate identity (migration 034)', () => {
  it('canonicalises FreeRADIUS and OpenSSL spellings of the same serial', () => {
    const forms = ['0a1bff', '0A1BFF', 'serial=0A1BFF', '0x0a1bff', '0a:1b:ff', ' a1bff '];
    for (const f of forms) expect(canonicalCertSerial(f)).toBe('a1bff');
    expect(canonicalCertSerial('00')).toBe('0');
  });

  it('refuses anything that is not a hex serial of at most 20 octets', () => {
    for (const bad of [null, undefined, '', 'serial=', '0x', 'xyz', '12 34', '1'.repeat(41)]) {
      expect(canonicalCertSerial(bad)).toBeNull();
    }
    expect(canonicalCertSerial('f'.repeat(40))).toBe('f'.repeat(40));
  });

  it('accepts only the certificate currently enrolled for an enrolled NAS', () => {
    const nas = { radsec_enabled: true, radsec_cert_serial: '0A1BFF' };
    expect(radsecCertificateAccepted(nas, '0a1bff')).toBe(true);
    // A previous (rotated) certificate, a missing serial, or garbage is refused.
    expect(radsecCertificateAccepted(nas, '0a1bfe')).toBe(false);
    expect(radsecCertificateAccepted(nas, undefined)).toBe(false);
    expect(radsecCertificateAccepted(nas, '')).toBe(false);
  });

  it('refuses a NAS that is not enrolled, or enrolled without a recorded serial', () => {
    expect(radsecCertificateAccepted({ radsec_enabled: false, radsec_cert_serial: 'ab' }, 'ab')).toBe(
      false,
    );
    expect(radsecCertificateAccepted({ radsec_enabled: true, radsec_cert_serial: null }, 'ab')).toBe(
      false,
    );
  });
});
