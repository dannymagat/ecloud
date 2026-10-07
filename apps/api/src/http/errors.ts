/**
 * API problem types on top of `@ecloud/shared` errors and the RFC 9457 error handler.
 */
import {
  AppError,
  ConflictError,
  NotFoundError,
  ValidationError,
  toProblem,
  type AppErrorOptions,
  type ProblemDetails,
} from '@ecloud/shared';
import type { ErrorRequestHandler, RequestHandler } from 'express';
import type { Logger } from '@ecloud/shared';
import { ZodError } from 'zod';

export const PROBLEM_CONTENT_TYPE = 'application/problem+json';

export class TooManyRequestsError extends AppError {
  readonly retryAfterSeconds: number;
  constructor(retryAfterSeconds: number, options: AppErrorOptions = {}) {
    super(429, 'rate-limited', 'Too Many Requests', {
      ...options,
      detail: options.detail ?? 'Too many requests; retry later.',
    });
    this.retryAfterSeconds = Math.max(1, Math.ceil(retryAfterSeconds));
  }
}

export class PreconditionFailedError extends AppError {
  constructor(options: AppErrorOptions = {}) {
    super(412, 'precondition-failed', 'Precondition Failed', {
      ...options,
      detail: options.detail ?? 'If-Match does not match the current version of the resource.',
    });
  }
}

export class IdempotencyConflictError extends AppError {
  constructor(detail: string) {
    super(422, 'idempotency-conflict', 'Idempotency Conflict', { detail });
  }
}

export class IdempotencyRequiredError extends AppError {
  constructor() {
    super(428, 'idempotency-key-required', 'Idempotency-Key Required', {
      detail: 'This operation requires an Idempotency-Key header (UUID).',
    });
  }
}

export class CsrfError extends AppError {
  constructor(detail: string) {
    super(403, 'csrf', 'Cross-Site Request Rejected', { detail });
  }
}

/** D-027: the action is not allowed while a support administrator impersonates a tenant. */
export class ImpersonationForbiddenError extends AppError {
  constructor(action: string) {
    super(403, 'impersonation-forbidden', 'Forbidden While Impersonating', {
      detail: `${action} is not allowed while impersonating an organization.`,
      extensions: { action },
    });
  }
}

export class ServiceUnavailableError extends AppError {
  constructor(detail = 'A backing service is unavailable.') {
    super(503, 'unavailable', 'Service Unavailable', { detail });
  }
}

export class PayloadTooLargeError extends AppError {
  constructor() {
    super(413, 'payload-too-large', 'Payload Too Large', {
      detail: 'The request body exceeds the allowed size.',
    });
  }
}

export class UnprocessableError extends AppError {
  constructor(detail: string, extensions?: Record<string, unknown>) {
    super(422, 'unprocessable', 'Unprocessable Entity', {
      detail,
      ...(extensions ? { extensions } : {}),
    });
  }
}

export function zodToValidationError(error: ZodError, prefix: string): ValidationError {
  return new ValidationError(
    error.issues.map((issue) => ({
      path: [prefix, ...issue.path.map(String)].filter((p) => p !== '').join('.'),
      message: issue.message,
    })),
  );
}

interface PgLikeError {
  code?: unknown;
  constraint?: unknown;
}

function isPgError(error: unknown): error is Error & PgLikeError {
  return (
    error instanceof Error &&
    typeof (error as PgLikeError).code === 'string' &&
    /^[0-9A-Z]{5}$/.test((error as PgLikeError).code as string)
  );
}

/**
 * Maps database errors that callers can cause to client problems. Constraint names are safe
 * to expose (schema names, no data); messages are not (they may echo values).
 */
export function mapDatabaseError(error: unknown): AppError | undefined {
  if (!isPgError(error)) return undefined;
  const constraint = typeof error.constraint === 'string' ? error.constraint : undefined;
  switch (error.code) {
    case '23505':
      return new ConflictError({
        detail: 'A resource with the same unique attributes already exists.',
        ...(constraint ? { extensions: { constraint } } : {}),
      });
    case '23503':
      return new UnprocessableError('A referenced resource does not exist or is still in use.', {
        ...(constraint ? { constraint } : {}),
      });
    case '23514':
    case '22P02':
    case '22007':
    case '22008':
    case '22003':
      return new ValidationError([
        { path: constraint ?? 'body', message: 'value violates a database constraint' },
      ]);
    case '42501':
      // RLS WITH CHECK violation: the row does not belong to the current tenant.
      return new NotFoundError('resource');
    default:
      return undefined;
  }
}

interface BodyParserError {
  type?: unknown;
  status?: unknown;
}

function mapBodyParserError(error: unknown): AppError | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const { type } = error as BodyParserError;
  if (type === 'entity.too.large') return new PayloadTooLargeError();
  if (type === 'entity.parse.failed') {
    return new ValidationError([{ path: 'body', message: 'malformed JSON' }]);
  }
  if (type === 'encoding.unsupported' || type === 'charset.unsupported') {
    return new ValidationError([{ path: 'body', message: 'unsupported encoding' }]);
  }
  return undefined;
}

const CONNECTION_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EHOSTUNREACH',
]);

/** Database / network outages are 503 (retryable), never a generic 500. */
export function isBackendUnavailable(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string') {
    if (CONNECTION_CODES.has(code)) return true;
    if (/^(08|57P|53)/.test(code)) return true; // connection exception, admin shutdown, resources
  }
  if (error instanceof AggregateError) return error.errors.some(isBackendUnavailable);
  return /Connection terminated|timeout exceeded when trying to connect/i.test(error.message);
}

export function normalizeError(error: unknown): unknown {
  if (error instanceof AppError) return error;
  if (error instanceof ZodError) return zodToValidationError(error, '');
  if (isBackendUnavailable(error)) return new ServiceUnavailableError();
  return mapBodyParserError(error) ?? mapDatabaseError(error) ?? error;
}

export function sendProblem(
  res: Parameters<RequestHandler>[1],
  problem: ProblemDetails,
  headers: Record<string, string> = {},
): void {
  for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
  res.status(problem.status).type(PROBLEM_CONTENT_TYPE).send(JSON.stringify(problem));
}

export function notFoundHandler(): RequestHandler {
  return (req, res) => {
    const problem = new NotFoundError('route', undefined, {
      detail: `No route for ${req.method} ${req.path}.`,
    }).toProblem(req.path);
    problem.request_id = req.ctx?.requestId;
    sendProblem(res, problem);
  };
}

export function problemHandler(logger: Logger): ErrorRequestHandler {
  return (error: unknown, req, res, next) => {
    if (res.headersSent) {
      next(error);
      return;
    }
    const normalized = normalizeError(error);
    const problem = toProblem(normalized, req.path);
    problem.request_id = req.ctx?.requestId;
    const log = req.log ?? logger;
    if (problem.status >= 500) {
      log.error({ err: error }, 'request failed');
    } else {
      log.debug({ problemType: problem.type, status: problem.status }, 'request rejected');
    }
    const headers: Record<string, string> = {};
    if (normalized instanceof TooManyRequestsError) {
      headers['Retry-After'] = String(normalized.retryAfterSeconds);
    }
    sendProblem(res, problem, headers);
  };
}
