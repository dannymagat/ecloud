/**
 * Resolves `*_secret_ref` columns (nas_clients.secret_ref, webhooks.signing_secret_ref) to the
 * secret value at the moment of use. The encrypted `secret_blobs` store of
 * SECURITY_ARCHITECTURE.md §4 does not exist yet, so Phase 3 supports two reference schemes:
 *
 *   env:<VAR_NAME>      value of an environment variable (injected by the deployment)
 *   file:<absolute>     contents of a file such as /run/secrets/<name> (trailing newline trimmed)
 *
 * Any other reference resolves to `undefined` and the caller records a failure. Secret values
 * are never logged or persisted by the worker.
 */
import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

export type SecretResolver = (ref: string) => Promise<string | undefined>;

const ENV_NAME_RE = /^[A-Z_][A-Z0-9_]*$/;

export function createSecretResolver(
  env: Record<string, string | undefined> = process.env,
): SecretResolver {
  return async (ref) => {
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
    return undefined;
  };
}
