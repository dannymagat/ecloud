/**
 * Typed fetch client over the generated OpenAPI `paths` (src/api/schema.d.ts).
 *  - same-origin `/api/v1`, cookie session (`credentials: 'same-origin'`, D-029);
 *  - every request carries `X-Requested-With` (CSRF guard, SECURITY_ARCHITECTURE.md §6.4);
 *  - every POST carries an `Idempotency-Key` (required by some routes, harmless elsewhere);
 *  - non-2xx responses throw `ApiError` holding the RFC 9457 problem;
 *  - a 401 outside the login endpoints notifies `onSessionExpired` listeners.
 */
import type { paths } from './schema';
import { ApiError, toProblem } from './problem';

export type HttpMethod = 'get' | 'post' | 'patch' | 'delete';

/** API paths that define `method`. */
export type PathFor<M extends HttpMethod> = {
  [P in keyof paths]: paths[P] extends Record<M, infer O>
    ? [O] extends [never]
      ? never
      : P
    : never;
}[keyof paths];

type Op<P extends keyof paths, M extends HttpMethod> =
  paths[P] extends Record<M, infer O> ? O : never;

type PathParams<O> = O extends { parameters: { path: infer X } } ? X : never;
type QueryParams<O> = O extends { parameters: { query?: infer Q } } ? NonNullable<Q> : never;
type Body<O> = O extends { requestBody?: infer RB }
  ? [NonNullable<RB>] extends [never]
    ? never
    : NonNullable<RB> extends { content: { 'application/json': infer B } }
      ? B
      : never
  : never;
type JsonOf<X> = X extends { content: { 'application/json': infer J } } ? J : undefined;
export type SuccessOf<O> = O extends { responses: infer R }
  ? JsonOf<R[Extract<keyof R, 200 | 201 | 204>]>
  : never;

export type CallOptions<O> = ([PathParams<O>] extends [never]
  ? { params?: undefined }
  : { params: PathParams<O> }) &
  ([QueryParams<O>] extends [never] ? { query?: undefined } : { query?: Partial<QueryParams<O>> }) &
  ([Body<O>] extends [never] ? { body?: undefined } : { body: Body<O> }) & {
    idempotencyKey?: string;
    signal?: AbortSignal;
  };

export type RequestBody<P extends keyof paths, M extends HttpMethod> = Body<Op<P, M>>;
export type ResponseOf<P extends keyof paths, M extends HttpMethod> = SuccessOf<Op<P, M>>;

type Listener = () => void;
const sessionExpiredListeners = new Set<Listener>();

export function onSessionExpired(listener: Listener): () => void {
  sessionExpiredListeners.add(listener);
  return () => {
    sessionExpiredListeners.delete(listener);
  };
}

const AUTH_PATHS = /^\/api\/v1\/auth\/(login|mfa\/verify|me|accept-invitation)$/;

export function buildUrl(
  template: string,
  params: Record<string, string> | undefined,
  query: Record<string, unknown> | undefined,
): string {
  const path = template.replace(/\{([A-Za-z0-9_]+)\}/g, (_m, name: string) => {
    const value = params?.[name];
    if (value === undefined) throw new Error(`missing path parameter ${name} for ${template}`);
    return encodeURIComponent(value);
  });
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null || value === '') continue;
    search.set(
      key,
      typeof value === 'object' ? JSON.stringify(value) : `${value as string | number | boolean}`,
    );
  }
  const qs = search.toString();
  return qs ? `${path}?${qs}` : path;
}

export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

/** Low-level request used by `api` and by calls to endpoints not yet in the generated schema. */
export async function request<T>(
  method: HttpMethod,
  url: string,
  init: {
    body?: unknown;
    idempotencyKey?: string;
    signal?: AbortSignal;
    pathTemplate?: string;
  } = {},
): Promise<T> {
  const headers: Record<string, string> = {
    Accept: 'application/json, application/problem+json',
    'X-Requested-With': 'XMLHttpRequest',
  };
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';
  if (method === 'post') headers['Idempotency-Key'] = init.idempotencyKey ?? newIdempotencyKey();
  let res: Response;
  try {
    res = await fetch(url, {
      method: method.toUpperCase(),
      headers,
      credentials: 'same-origin',
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: init.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiError({
      type: 'about:blank',
      title: 'Network error',
      status: 0,
      detail: 'The ECLOUD API could not be reached. Check your connection and try again.',
    });
  }
  const text = res.status === 204 ? '' : await res.text();
  let parsed: unknown = undefined;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
  }
  if (!res.ok) {
    const problem = toProblem(res.status, parsed, res.statusText || `HTTP ${res.status}`);
    const template = init.pathTemplate ?? url.split('?')[0] ?? url;
    if (res.status === 401 && !AUTH_PATHS.test(template)) {
      for (const listener of sessionExpiredListeners) listener();
    }
    throw new ApiError(problem);
  }
  return parsed as T;
}

/** Typed call: `api('get', '/api/v1/orgs/{orgId}/sites', { params: { orgId } })`. */
export function api<M extends HttpMethod, P extends PathFor<M>>(
  method: M,
  path: P,
  options: CallOptions<Op<P, M>>,
): Promise<SuccessOf<Op<P, M>>> {
  const opts = options as {
    params?: Record<string, string>;
    query?: Record<string, unknown>;
    body?: unknown;
    idempotencyKey?: string;
    signal?: AbortSignal;
  };
  return request(method, buildUrl(path, opts.params, opts.query), {
    body: opts.body,
    idempotencyKey: opts.idempotencyKey,
    signal: opts.signal,
    pathTemplate: path,
  });
}

/**
 * Binary upload (branding assets): the file is the raw request body with its own image type;
 * same CSRF / idempotency headers as `request`. Non-2xx responses throw `ApiError`.
 */
export async function uploadFile<T>(
  url: string,
  file: Blob,
  init: { idempotencyKey?: string; pathTemplate?: string } = {},
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        Accept: 'application/json, application/problem+json',
        'X-Requested-With': 'XMLHttpRequest',
        'Content-Type': file.type || 'application/octet-stream',
        'Idempotency-Key': init.idempotencyKey ?? newIdempotencyKey(),
      },
      credentials: 'same-origin',
      body: file,
    });
  } catch {
    throw new ApiError({
      type: 'about:blank',
      title: 'Network error',
      status: 0,
      detail: 'The ECLOUD API could not be reached. Check your connection and try again.',
    });
  }
  const text = await res.text();
  let parsed: unknown = undefined;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    parsed = undefined;
  }
  if (!res.ok) {
    if (res.status === 401) for (const listener of sessionExpiredListeners) listener();
    throw new ApiError(toProblem(res.status, parsed, res.statusText || `HTTP ${res.status}`));
  }
  return parsed as T;
}

/**
 * File download (CSV exports): same CSRF / idempotency headers as `request`; the response body
 * is returned as a Blob with the server's file name (Content-Disposition) when present.
 * Non-2xx responses throw `ApiError` holding the problem document.
 */
export async function downloadFile(
  method: 'get' | 'post',
  url: string,
  init: { body?: unknown; idempotencyKey?: string; signal?: AbortSignal } = {},
): Promise<{ blob: Blob; filename: string | null }> {
  const headers: Record<string, string> = {
    Accept: 'text/csv, application/problem+json',
    'X-Requested-With': 'XMLHttpRequest',
  };
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';
  if (method === 'post') headers['Idempotency-Key'] = init.idempotencyKey ?? newIdempotencyKey();
  let res: Response;
  try {
    res = await fetch(url, {
      method: method.toUpperCase(),
      headers,
      credentials: 'same-origin',
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: init.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiError({
      type: 'about:blank',
      title: 'Network error',
      status: 0,
      detail: 'The ECLOUD API could not be reached. Check your connection and try again.',
    });
  }
  if (!res.ok) {
    const text = await res.text();
    let parsed: unknown = undefined;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = undefined;
    }
    if (res.status === 401) for (const listener of sessionExpiredListeners) listener();
    throw new ApiError(toProblem(res.status, parsed, res.statusText || `HTTP ${res.status}`));
  }
  const disposition = res.headers.get('Content-Disposition') ?? '';
  const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition);
  return { blob: await res.blob(), filename: safeFilename(match?.[1]) };
}

/** Decode a Content-Disposition filename defensively: malformed escapes fall back to the caller's
 * default name; path separators and control characters are stripped; length is capped. */
export function safeFilename(raw: string | undefined): string | null {
  if (!raw) return null;
  let name: string;
  try {
    name = decodeURIComponent(raw);
  } catch {
    return null;
  }
  // Path separators and C0/DEL control characters become '_' (no-control-regex: intended here).
  // eslint-disable-next-line no-control-regex
  const unsafe = /[\\/\u0000-\u001f\u007f]/g;
  name = name.replace(unsafe, '_').trim().slice(0, 200);
  return name === '' ? null : name;
}

/** Saves a Blob through a temporary object URL (browser only). */
export function saveBlob(blob: Blob, filename: string): void {
  const href = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = href;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 0);
}
