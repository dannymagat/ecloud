/**
 * Structured authentication-failure events (SECURITY_ARCHITECTURE.md §2.4 / §8). One JSON log
 * line per failed attempt, `event` immediately followed by `ip`, so the host fail2ban jail
 * `ecloud-admin` (infra/vps/fail2ban/filter.d/ecloud-admin.conf) can ban by client address.
 * The line never carries the e-mail address, password, code or token (PII / secrets).
 */
import type { Logger } from '@ecloud/shared';

export const AUTH_FAILURE_EVENTS = Object.freeze([
  'admin_login_failed',
  'admin_mfa_failed',
  'admin_invitation_failed',
] as const);

export type AuthFailureEvent = (typeof AUTH_FAILURE_EVENTS)[number];

export function logAuthFailure(
  logger: Logger,
  event: AuthFailureEvent,
  ip: string | null,
  requestId: string,
): void {
  logger.warn({ event, ip: ip ?? 'unknown', request_id: requestId }, `security: ${event}`);
}

/**
 * Portal / NAS-identity security events (Cycle A review M1). No organization, site or NAS id:
 * the event is logged on a pre-tenant path and must not reveal who registered what.
 */
export const PORTAL_SECURITY_EVENTS = Object.freeze(['ap_mac_claimed_elsewhere'] as const);

export type PortalSecurityEvent = (typeof PORTAL_SECURITY_EVENTS)[number];

export function logPortalSecurityEvent(
  logger: Logger,
  event: PortalSecurityEvent,
  detail: { readonly apMac: string | null; readonly requestId?: string },
): void {
  logger.warn({ event, ap_mac: detail.apMac, request_id: detail.requestId }, `security: ${event}`);
}
