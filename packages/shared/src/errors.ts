/**
 * RFC 9457 "Problem Details for HTTP APIs" representation of an error.
 * `type` is a URI identifying the problem type; ECLOUD uses `urn:ecloud:problem:<slug>`.
 */
export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  /** Extension members (e.g. `errors`, `requestId`). */
  [extension: string]: unknown;
}

export interface ValidationIssue {
  /** JSON pointer-ish path, e.g. `body.download_rate_kbps`. */
  path: string;
  message: string;
}

export interface AppErrorOptions {
  /** Human readable explanation specific to this occurrence. Safe to show to API clients. */
  detail?: string;
  /** Extension members merged into the problem document. Must not contain secrets. */
  extensions?: Record<string, unknown>;
  cause?: unknown;
}

export const PROBLEM_TYPE_PREFIX = 'urn:ecloud:problem:';

export function problemType(slug: string): string {
  return `${PROBLEM_TYPE_PREFIX}${slug}`;
}

/**
 * Base class for errors that map to an HTTP problem+json response.
 * Subclasses fix `status`, `type` and `title`; callers supply `detail` and extensions.
 */
export class AppError extends Error {
  readonly status: number;
  readonly type: string;
  readonly title: string;
  readonly detail: string | undefined;
  readonly extensions: Readonly<Record<string, unknown>>;

  constructor(status: number, slug: string, title: string, options: AppErrorOptions = {}) {
    super(
      options.detail ?? title,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = new.target.name;
    this.status = status;
    this.type = problemType(slug);
    this.title = title;
    this.detail = options.detail;
    this.extensions = Object.freeze({ ...(options.extensions ?? {}) });
  }

  /** Builds the RFC 9457 document. `instance` is normally the request path. */
  toProblem(instance?: string): ProblemDetails {
    const problem: ProblemDetails = {
      ...this.extensions,
      type: this.type,
      title: this.title,
      status: this.status,
    };
    if (this.detail !== undefined) problem.detail = this.detail;
    if (instance !== undefined) problem.instance = instance;
    return problem;
  }
}

export class ValidationError extends AppError {
  readonly issues: readonly ValidationIssue[];

  constructor(
    issues: readonly ValidationIssue[],
    options: Omit<AppErrorOptions, 'extensions'> = {},
  ) {
    super(400, 'validation', 'Validation Failed', {
      ...options,
      detail: options.detail ?? 'One or more request fields are invalid.',
      extensions: { errors: issues.map((issue) => ({ ...issue })) },
    });
    this.issues = issues;
  }
}

export class UnauthorizedError extends AppError {
  constructor(options: AppErrorOptions = {}) {
    super(401, 'unauthorized', 'Unauthorized', {
      ...options,
      detail: options.detail ?? 'Authentication is required.',
    });
  }
}

export class ForbiddenError extends AppError {
  constructor(options: AppErrorOptions = {}) {
    super(403, 'forbidden', 'Forbidden', {
      ...options,
      detail: options.detail ?? 'You do not have permission to perform this action.',
    });
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string, id?: string, options: AppErrorOptions = {}) {
    super(404, 'not-found', 'Not Found', {
      ...options,
      detail:
        options.detail ??
        (id === undefined ? `${resource} not found.` : `${resource} ${id} not found.`),
      extensions: { resource, ...(id === undefined ? {} : { id }), ...(options.extensions ?? {}) },
    });
  }
}

export class ConflictError extends AppError {
  constructor(options: AppErrorOptions = {}) {
    super(409, 'conflict', 'Conflict', {
      ...options,
      detail: options.detail ?? 'The request conflicts with the current state of the resource.',
    });
  }
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}

/**
 * Converts any thrown value to a problem document. Unknown errors become a generic 500 whose
 * `detail` never echoes the original message (it may contain connection strings or tokens).
 */
export function toProblem(error: unknown, instance?: string): ProblemDetails {
  if (isAppError(error)) return error.toProblem(instance);
  const problem: ProblemDetails = {
    type: problemType('internal'),
    title: 'Internal Server Error',
    status: 500,
    detail: 'An unexpected error occurred.',
  };
  if (instance !== undefined) problem.instance = instance;
  return problem;
}
