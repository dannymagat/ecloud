/**
 * Errors of the outbound vendor-API client. Every message is a fixed text chosen by the code:
 * no URL query, header, body, credential or vendor-supplied text is ever copied into an error,
 * so an error can be logged or audited as-is (SECURITY_ARCHITECTURE.md §5.10).
 */

export const VENDOR_API_ERROR_CODES = [
  'invalid_target',
  'port_not_allowed',
  'blocked_address',
  'dns_failure',
  'connection_failed',
  'tls_error',
  'tls_pin_mismatch',
  'timeout',
  'response_too_large',
  'redirect_refused',
  'rate_limited',
  'auth_failed',
  'http_error',
  'invalid_response',
  'vendor_rejected',
  'client_not_found',
  'not_implemented',
] as const;

export type VendorApiErrorCode = (typeof VENDOR_API_ERROR_CODES)[number];

const MESSAGES: Readonly<Record<VendorApiErrorCode, string>> = Object.freeze({
  invalid_target: 'controller URL or request path is not allowed',
  port_not_allowed: 'controller port is not on the outbound allow-list',
  blocked_address: 'controller address is not allowed by the outbound policy',
  dns_failure: 'controller host does not resolve',
  connection_failed: 'connection to the controller failed',
  tls_error: 'controller TLS certificate verification failed',
  tls_pin_mismatch: 'controller TLS certificate does not match the pinned fingerprint',
  timeout: 'controller request timed out',
  response_too_large: 'controller response exceeds the size limit',
  redirect_refused: 'controller answered with a redirect (redirects are never followed)',
  rate_limited: 'outbound rate limit for this controller reached',
  auth_failed: 'controller refused the API credential',
  http_error: 'controller answered with an unexpected HTTP status',
  invalid_response: 'controller response is not in the documented shape',
  vendor_rejected: 'controller rejected the request',
  client_not_found: 'client is not known to the controller on this site',
  not_implemented: 'this vendor API mode is not implemented (REQUIRES_CLARIFICATION)',
});

export class VendorApiError extends Error {
  readonly code: VendorApiErrorCode;
  /** HTTP status when the controller answered (never the body). */
  readonly status: number | null;

  constructor(code: VendorApiErrorCode, status: number | null = null) {
    super(MESSAGES[code]);
    this.name = 'VendorApiError';
    this.code = code;
    this.status = status;
  }
}

export function isVendorApiError(error: unknown): error is VendorApiError {
  return error instanceof VendorApiError;
}
