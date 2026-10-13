/**
 * RadSec (RFC 6614) NAS identity, shared by the API (`resolveNas`) and the worker (accounting
 * drainer) so the two never disagree about which certificate identifies which NAS (migration 034).
 *
 * FreeRADIUS verifies the client certificate chain against the EZECLOUD RadSec CA before any
 * request reaches EZECLOUD. What remains for EZECLOUD to decide is whether THIS certificate is
 * the one currently enrolled for the NAS its CN names:
 *
 *   - CN = nas_clients.id (the NAS identity; the TLS source address is a NAT address);
 *   - the NAS row must be enrolled (`radsec_enabled`) with a recorded certificate serial;
 *   - the presented serial must equal that serial. Issuing a new certificate for a NAS therefore
 *     retires the previous one at once, which is the revocation mechanism: no CRL is published.
 *
 * Pure functions; no I/O.
 */

/**
 * Shortname of the single catch-all client of the RadSec listener's own client list
 * (sites-available/ecloud-radsec). The FreeRADIUS policy sets the certificate attributes only for
 * this client, and a request from it without a usable certificate identity is refused.
 */
export const RADSEC_CLIENT_SHORTNAME = 'ecloud-radsec';

/** RFC 5280 §4.1.2.2: a serial number is at most 20 octets. */
const MAX_SERIAL_HEX = 40;

/**
 * Canonical form of a certificate serial number: lowercase hex, no separators, no leading zeros
 * ("0" for zero). Accepts FreeRADIUS `TLS-Client-Cert-Serial` (lowercase hex) and OpenSSL
 * `x509 -serial` output (`serial=0A1B...`, uppercase), with optional `0x` and `:` separators.
 * Returns null for anything that is not a hex serial of at most 20 octets.
 */
export function canonicalCertSerial(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  let s = value.trim().toLowerCase();
  if (s.startsWith('serial=')) s = s.slice('serial='.length);
  if (s.startsWith('0x')) s = s.slice(2);
  s = s.replace(/:/g, '');
  if (s === '' || s.length > MAX_SERIAL_HEX || !/^[0-9a-f]+$/.test(s)) return null;
  const trimmed = s.replace(/^0+/, '');
  return trimmed === '' ? '0' : trimmed;
}

export interface RadsecEnrolment {
  radsec_enabled: boolean;
  radsec_cert_serial: string | null;
}

/**
 * True only when the NAS is enrolled for RadSec and the presented certificate is the one
 * enrolled for it. A NAS enrolled without a recorded serial is refused: enrolment is incomplete
 * until the issued certificate is recorded.
 */
export function radsecCertificateAccepted(
  nas: RadsecEnrolment,
  presentedSerial: string | null | undefined,
): boolean {
  if (!nas.radsec_enabled) return false;
  const enrolled = canonicalCertSerial(nas.radsec_cert_serial);
  const presented = canonicalCertSerial(presentedSerial);
  return enrolled !== null && presented !== null && enrolled === presented;
}
