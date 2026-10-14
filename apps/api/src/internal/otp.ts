/**
 * Captive-portal one-time codes (migration 035, docs/PORTAL_LOGIN_METHODS_DESIGN.md §4.1).
 *
 * A guest types an address, receives a code, types it back. The verified address is then the
 * subject, and the rest of the portal flow is unchanged: the identity broker mints the single-use
 * `pc-<hex>` credential and the NAS hand-off happens exactly as it does for a password login.
 *
 * SECURITY, and most of this file is it:
 *  - the code is never stored. The row holds HMAC-SHA-256(code, OTP_PEPPER), and the pepper lives
 *    outside the database, so a dump alone cannot complete a login. Six digits is only 10^6, so a
 *    bare hash would be reversible in seconds.
 *  - comparison is timing-safe. A code is a secret of the same kind as a password.
 *  - a code dies on the first success (single use), on expiry, and after `max_attempts` wrong
 *    guesses. Without the attempt cap, six digits falls to a few hundred thousand tries.
 *  - requesting a code SENDS MAIL, so the request path is rate-limited per identifier and per
 *    site before anything is generated. Without that, this endpoint is a free mail relay for
 *    whoever finds it, and the bill lands on the tenant.
 *  - the answers to "unknown address" and "known address" are identical, and verification never
 *    says whether the identifier existed — both would otherwise enumerate a tenant's guests.
 */
import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import type { DbTransaction } from '@ecloud/db';

/** Six digits: what a guest will retype from a phone without complaining. */
const CODE_DIGITS = 6;
export const OTP_TTL_S = 600;
export const OTP_MAX_ATTEMPTS = 5;

/** Requests per identifier and per site inside the TTL window, before any mail is sent. */
export const OTP_REQUESTS_PER_IDENTIFIER = 3;
export const OTP_REQUESTS_PER_SITE = 60;

export type OtpChannel = 'email' | 'sms';

export interface OtpIssue {
  /** The clear code, for the message only. Never stored, never logged, never returned to a route. */
  readonly code: string;
  readonly expiresAt: Date;
}

/**
 * A fresh code. `randomInt` is the CSPRNG: `Math.random()` would make codes predictable from one
 * another, which matters when an attacker can request one for an address they control.
 */
export function generateCode(): string {
  return String(randomInt(0, 10 ** CODE_DIGITS)).padStart(CODE_DIGITS, '0');
}

export function hashCode(code: string, pepper: string): string {
  return createHmac('sha256', pepper).update(code).digest('hex');
}

/**
 * Email addresses are normalised to lower case so that one guest cannot hold several identities
 * (and several rate-limit buckets) by varying capitalisation. The local part is case-sensitive in
 * the RFC, but no mail system in practice treats it that way, and the alternative is worse.
 */
export function normalizeIdentifier(channel: OtpChannel, raw: string): string | null {
  const value = raw.trim();
  if (channel === 'email') {
    const lowered = value.toLowerCase();
    // Deliberately permissive: one @, something either side, no whitespace, length-bounded by the
    // column. Address validation beyond this rejects real addresses, and the code itself is the
    // real proof — an address that does not exist simply never receives one.
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(lowered) && lowered.length <= 320 ? lowered : null;
  }
  // E.164: a leading + and 8..15 digits. Not used until the SMS provider lands (design §4.4).
  const compact = value.replace(/[\s()-]/g, '');
  return /^\+[1-9]\d{7,14}$/.test(compact) ? compact : null;
}

export interface IssueInput {
  readonly organizationId: string;
  readonly siteId: string | null;
  readonly identityProviderId: string;
  readonly captivePortalId: string | null;
  readonly channel: OtpChannel;
  readonly identifier: string;
  readonly requestedIp: string | null;
  readonly pepper: string;
  readonly now: Date;
}

/** Writes the code row and returns the clear code for the message. */
export async function issueCode(trx: DbTransaction, input: IssueInput): Promise<OtpIssue> {
  const code = generateCode();
  const expiresAt = new Date(input.now.getTime() + OTP_TTL_S * 1000);
  await trx
    .insertInto('otp_codes')
    .values({
      organization_id: input.organizationId,
      site_id: input.siteId,
      identity_provider_id: input.identityProviderId,
      captive_portal_id: input.captivePortalId,
      channel: input.channel,
      identifier: input.identifier,
      code_hash: hashCode(code, input.pepper),
      max_attempts: OTP_MAX_ATTEMPTS,
      expires_at: expiresAt,
      requested_ip: input.requestedIp,
    })
    .execute();
  return { code, expiresAt };
}

export type VerifyOutcome =
  | { readonly ok: true }
  /** One reason for every failure: the caller must not tell the guest which it was. */
  | { readonly ok: false; readonly reason: 'no_code' | 'expired' | 'exhausted' | 'mismatch' };

export interface VerifyInput {
  readonly identityProviderId: string;
  readonly identifier: string;
  readonly code: string;
  readonly pepper: string;
  readonly now: Date;
}

/**
 * Consumes the newest live code for this identifier.
 *
 * The row is taken `forUpdate` so two submissions of the same code cannot both win: without it,
 * a guest who double-taps — or an attacker who races — could consume one code twice, and
 * single-use would hold only in the happy path.
 */
export async function verifyCode(trx: DbTransaction, input: VerifyInput): Promise<VerifyOutcome> {
  const row = await trx
    .selectFrom('otp_codes')
    .select(['id', 'code_hash', 'attempts', 'max_attempts', 'expires_at'])
    .where('identity_provider_id', '=', input.identityProviderId)
    .where('identifier', '=', input.identifier)
    .where('consumed_at', 'is', null)
    .orderBy('created_at', 'desc')
    .limit(1)
    .forUpdate()
    .executeTakeFirst();

  if (row === undefined) return { ok: false, reason: 'no_code' };
  if (row.expires_at.getTime() <= input.now.getTime()) return { ok: false, reason: 'expired' };
  if (row.attempts >= row.max_attempts) return { ok: false, reason: 'exhausted' };

  const expected = Buffer.from(row.code_hash, 'hex');
  const actual = Buffer.from(hashCode(input.code, input.pepper), 'hex');
  const matches = expected.length === actual.length && timingSafeEqual(expected, actual);

  if (!matches) {
    // Count the attempt on the row itself, so the cap survives a restart and cannot be reset by
    // changing source address — unlike a counter held only in the rate limiter.
    await trx
      .updateTable('otp_codes')
      .set({ attempts: row.attempts + 1 })
      .where('id', '=', row.id)
      .execute();
    return { ok: false, reason: 'mismatch' };
  }

  await trx
    .updateTable('otp_codes')
    .set({ consumed_at: input.now })
    .where('id', '=', row.id)
    .where('consumed_at', 'is', null)
    .execute();
  return { ok: true };
}

/** The message. Deliberately plain text: HTML mail buys nothing here and filters like it less. */
export function codeMessage(code: string, portalName: string): { subject: string; text: string } {
  return {
    subject: `${portalName}: your Wi-Fi sign-in code`,
    text:
      `Your sign-in code is ${code}\n\n` +
      `It expires in ${String(Math.round(OTP_TTL_S / 60))} minutes and can be used once.\n` +
      `If you did not ask to connect to ${portalName}, ignore this message.\n`,
  };
}
