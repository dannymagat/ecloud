/**
 * TOTP (RFC 6238, 30 s, ±1 step — SECURITY_ARCHITECTURE.md §6.2) via otplib. The secret is
 * stored AES-256-GCM sealed under MFA_ENCRYPTION_KEY (`mfa_credentials.secret_enc`); recovery
 * codes are stored as SHA-256 hashes and shown once.
 */
import { generateSecret, generateURI, verify } from 'otplib';
import { Envelope, randomVoucherCode, sha256Hex } from '../crypto.js';

export const TOTP_ISSUER = 'ECLOUD';
export const RECOVERY_CODE_COUNT = 10;

export class MfaCodec {
  private readonly envelope: Envelope;

  constructor(keyMaterial: string) {
    this.envelope = new Envelope(keyMaterial, 'ecloud:mfa:totp:v1');
  }

  newSecret(): string {
    return generateSecret();
  }

  seal(secret: string): string {
    return this.envelope.encrypt(secret);
  }

  open(sealed: string): string {
    return this.envelope.decrypt(sealed);
  }

  uri(secret: string, label: string): string {
    return generateURI({ issuer: TOTP_ISSUER, label, secret });
  }

  /** Verifies a 6-digit code with a ±30 s window. */
  async check(secret: string, code: string): Promise<boolean> {
    if (!/^[0-9]{6}$/.test(code)) return false;
    try {
      const result = await verify({ secret, token: code, epochTolerance: 30 });
      return result.valid;
    } catch {
      return false;
    }
  }
}

export function newRecoveryCodes(): { codes: string[]; hashes: string[] } {
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, () => {
    const raw = randomVoucherCode(10);
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
  return { codes, hashes: codes.map((c) => sha256Hex(normalizeRecoveryCode(c))) };
}

export function normalizeRecoveryCode(code: string): string {
  return code.replace(/[\s-]/g, '').toUpperCase();
}
