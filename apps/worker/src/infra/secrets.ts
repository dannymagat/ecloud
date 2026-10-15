/**
 * Resolves `*_secret_ref` columns (nas_clients.secret_ref, webhooks.signing_secret_ref) to the
 * secret value at the moment of use. Three reference schemes:
 *
 *   env:<VAR_NAME>      value of an environment variable (injected by the deployment)
 *   file:<absolute>     contents of a file such as /run/secrets/<name> (trailing newline trimmed)
 *   enc:…               a sealed value the api owns (D-056): the worker never holds
 *                       DATA_ENCRYPTION_KEY, so it asks GET /internal/nas/:id/secret on the api's
 *                       internal listener, per use, with the endpoint's OWN token
 *                       (INTERNAL_SECRET_TOKEN, D-061; never the shared one). Needs the NAS id.
 *
 * `undefined` = the reference cannot be resolved by this worker (unknown scheme, missing value,
 * api says 404 or no internal api configured) and the caller records `unsupported`.
 * {@link SecretFetchError} = the api could not be reached or answered 5xx: transient, the caller
 * retries instead of calling the NAS unsupported. Secret values are never logged or persisted.
 */
import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

export interface SecretContext {
  /** nas_clients.id: required to resolve an `enc:` reference (the secret is bound to its row). */
  nasId?: string;
}

export type SecretResolver = (ref: string, ctx?: SecretContext) => Promise<string | undefined>;

export class SecretFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretFetchError';
  }
}

export interface InternalApi {
  /** Base URL of the api's internal listener, e.g. http://api:3001 (ECLOUD_INTERNAL_URL). */
  url: string;
  /** INTERNAL_SECRET_TOKEN (D-061): the NAS-secret endpoint's own credential, held by api + worker. */
  token: string;
}

/** The subset of fetch the resolver uses (matches the worker's FetchLike seam). */
export type SecretFetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface SecretResolverOptions {
  /** Null = `enc:` references stay unresolvable (the pre-D-056 behaviour). */
  internal?: InternalApi | null;
  fetch?: SecretFetch;
  timeoutMs?: number;
}

const ENV_NAME_RE = /^[A-Z_][A-Z0-9_]*$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function createSecretResolver(
  env: Record<string, string | undefined> = process.env,
  options: SecretResolverOptions = {},
): SecretResolver {
  const internal = options.internal ?? null;
  const doFetch: SecretFetch = options.fetch ?? ((url, init) => fetch(url, init));
  const timeoutMs = options.timeoutMs ?? 5_000;
  return async (ref, ctx) => {
    if (ref.startsWith('env:')) {
      const name = ref.slice(4);
      if (!ENV_NAME_RE.test(name)) return undefined;
      const value = env[name];
      return value === undefined || value === '' ? undefined : value;
    }
    if (ref.startsWith('file:')) {
      const path = ref.slice(5);
      if (!isAbsolute(path)) return undefined;
      try {
        const value = (await readFile(path, 'utf8')).replace(/\r?\n$/, '');
        return value === '' ? undefined : value;
      } catch {
        return undefined;
      }
    }
    if (ref.startsWith('enc:')) {
      const nasId = ctx?.nasId;
      if (internal === null || nasId === undefined || !UUID_RE.test(nasId)) return undefined;
      let res: Response;
      try {
        res = await doFetch(`${internal.url.replace(/\/$/, '')}/internal/nas/${nasId}/secret`, {
          method: 'GET',
          headers: { 'X-Internal-Secret-Token': internal.token, Accept: 'application/json' },
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        throw new SecretFetchError(
          `internal api unreachable: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (res.status === 404) return undefined;
      if (!res.ok) throw new SecretFetchError(`internal api answered ${String(res.status)}`);
      const body = (await res.json()) as { secret?: unknown };
      return typeof body.secret === 'string' && body.secret !== '' ? body.secret : undefined;
    }
    return undefined;
  };
}
