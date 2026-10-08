/**
 * RFC 9457 problem details as returned by the ECLOUD API (`application/problem+json`).
 * Validation problems carry `errors: [{ path, message }]` (packages/shared ValidationError).
 */
export interface ProblemFieldError {
  path: string;
  message: string;
  code?: string;
}

export interface Problem {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  request_id?: string;
  errors?: ProblemFieldError[];
  [extension: string]: unknown;
}

export class ApiError extends Error {
  readonly status: number;
  readonly problem: Problem;

  constructor(problem: Problem) {
    super(problem.detail ?? problem.title);
    this.name = 'ApiError';
    this.status = problem.status;
    this.problem = problem;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Normalises any error body into a Problem (non-JSON gateways, network failures, ...). */
export function toProblem(status: number, body: unknown, fallbackTitle: string): Problem {
  if (isRecord(body) && typeof body.title === 'string') {
    const errors = Array.isArray(body.errors)
      ? body.errors.filter(isRecord).map((e) => ({
          path: typeof e.path === 'string' ? e.path : '',
          message: typeof e.message === 'string' ? e.message : String(e.message),
          ...(typeof e.code === 'string' ? { code: e.code } : {}),
        }))
      : undefined;
    return {
      ...body,
      type: typeof body.type === 'string' ? body.type : 'about:blank',
      title: body.title,
      status: typeof body.status === 'number' ? body.status : status,
      ...(typeof body.detail === 'string' ? { detail: body.detail } : {}),
      ...(errors ? { errors } : {}),
    };
  }
  return { type: 'about:blank', title: fallbackTitle, status };
}

export function problemOf(error: unknown): Problem {
  if (error instanceof ApiError) return error.problem;
  return {
    type: 'about:blank',
    title: 'Request failed',
    status: 0,
    detail: error instanceof Error ? error.message : String(error),
  };
}

/** Field errors keyed by the first path segment (`body.download_rate_kbps` → `download_rate_kbps`). */
export function fieldErrors(problem: Problem | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of problem?.errors ?? []) {
    const key = e.path.replace(/^(body|query|params)\.?/, '').split('.')[0] ?? '';
    if (key && out[key] === undefined) out[key] = e.message;
  }
  return out;
}
