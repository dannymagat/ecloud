/**
 * Ruckus WISPr NBI mode (research §3.9 F8): DOCUMENTED STUB, status REQUIRES_CLARIFICATION.
 *
 * What the research found (docs.cloud.ruckuswireless.com/ruckusone/wispr-api, Ruckus One):
 * a JSON POST to `https://<tenant>.wispr[.eu|.asia].ruckus.cloud:443/portalintf` (or the
 * `nbiIP` received in the redirect) with `Vendor`, `RequestPassword` (NBI password),
 * `RequestCategory = "UserOnlineControl"`, `RequestType = "Login"`, `UE-IP`, `UE-MAC`,
 * `UE-Username`, `UE-Password`; numeric response codes (101 / 201 / 301 …).
 *
 * Why it is not implemented in Cycle D:
 *  - the full response-code table, the SmartZone (non-Ruckus-One) NBI host / port / path and the
 *    encrypted `UE-IP` / `UE-MAC` handling are not documented in what was read (research §6
 *    item 8);
 *  - the NBI target host arrives in the guest's redirect (`nbiIP`); sending the NBI password
 *    to a redirect-supplied host is an SSRF / credential-exfiltration risk unless it is pinned
 *    to the registered controller URL, and that pinning rule needs the clarified host scheme;
 *  - the user/password it logs in with is a RADIUS credential, i.e. the F3 post-back + RADIUS
 *    path (Cycle C) already covers Ruckus without NBI.
 *
 * Calling it always throws `not_implemented`; nothing is sent.
 */
import { VendorApiError } from './errors.js';

export const RUCKUS_NBI_STATUS = 'REQUIRES_CLARIFICATION' as const;

export const RUCKUS_NBI_OPEN_QUESTIONS: readonly string[] = Object.freeze([
  'Complete NBI response-code table (only 101/201/301 seen) and error semantics',
  'SmartZone / vSZ NBI host, port (9080/9443 per third party) and path; Ruckus One regional hosts',
  'Handling of encrypted UE-IP / UE-MAC values and whether ECLOUD must decrypt them',
  'Binding rule for the redirect-supplied nbiIP to the registered controller base_url',
  'Which credential fields (Vendor, RequestPassword) are per controller vs per tenant',
]);

export function ruckusNbiLogin(): never {
  throw new VendorApiError('not_implemented');
}
