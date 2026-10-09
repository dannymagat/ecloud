/**
 * One-shot render of the FreeRADIUS client allow-list (F-P10-07). Used by
 * `radius-clients-cli.ts`; split out so the flow is unit-tested with an injected loader.
 *
 * Configuration (environment; `<NAME>_FILE` variants resolved by `resolveSecretFiles`):
 *   DATABASE_URL_PLATFORM   platform (BYPASSRLS) connection, required
 *   DATA_ENCRYPTION_KEY     key that sealed nas_clients.secret_ref (same as the api), required
 *   RADIUS_CLIENTS_FILE     target file, default /var/lib/ecloud/radius-clients/ecloud-nas.conf
 *
 * Exit codes: 0 rendered (or unchanged), 1 render / database failure (previous file kept),
 * 2 configuration or usage error, 3 rendered WITH skipped rows (file written with the valid
 * NAS; the `skipped` list names the others by id and rule). Output: one JSON summary line on stdout; errors on stderr.
 * Neither ever contains a secret or a connection string.
 */
import { ConfigError, resolveSecretFiles } from '@ecloud/shared';
import { basename, isAbsolute } from 'node:path';
import { z } from 'zod';
import { API_DEV_DEFAULTS } from '../config.js';
import { RadiusClientsRenderError, relaxedClientCount, renderClientsConf } from './render.js';
import type { NasClientEntry, SkippedNas } from './render.js';
import { writeClientsFileAtomic } from './write.js';

export const DEFAULT_RADIUS_CLIENTS_FILE = '/var/lib/ecloud/radius-clients/ecloud-nas.conf';

/** FreeRADIUS `$INCLUDE dir/` ignores dot-files and names outside this alphabet. */
const INCLUDED_NAME_RE = /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/;

const envSchema = z.object({
  NODE_ENV: z.string().optional(),
  DATABASE_URL_PLATFORM: z.string().trim().min(1, 'is required'),
  DATA_ENCRYPTION_KEY: z.string().min(16, 'must be at least 16 characters'),
  RADIUS_CLIENTS_FILE: z.string().trim().min(1).default(DEFAULT_RADIUS_CLIENTS_FILE),
});

export interface RenderSettings {
  databaseUrlPlatform: string;
  dataEncryptionKey: string;
  outFile: string;
}

export function loadRenderSettings(
  env: Record<string, string | undefined>,
  outOverride?: string,
): RenderSettings {
  const parsed = envSchema.safeParse(resolveSecretFiles(env));
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    );
  }
  const raw = parsed.data;
  const problems: string[] = [];
  if (raw.NODE_ENV === 'production') {
    if (raw.DATA_ENCRYPTION_KEY === API_DEV_DEFAULTS.DATA_ENCRYPTION_KEY) {
      problems.push('DATA_ENCRYPTION_KEY: dev default is not allowed when NODE_ENV=production');
    } else if (raw.DATA_ENCRYPTION_KEY.length < 32) {
      problems.push('DATA_ENCRYPTION_KEY: must be at least 32 characters when NODE_ENV=production');
    }
  }
  const outFile = outOverride ?? raw.RADIUS_CLIENTS_FILE;
  if (!isAbsolute(outFile)) problems.push('RADIUS_CLIENTS_FILE: must be an absolute path');
  if (!INCLUDED_NAME_RE.test(basename(outFile))) {
    problems.push(
      'RADIUS_CLIENTS_FILE: file name must match [A-Za-z0-9_-][A-Za-z0-9_.-]* (FreeRADIUS skips other names)',
    );
  }
  if (problems.length > 0) throw new ConfigError(problems);
  return {
    databaseUrlPlatform: raw.DATABASE_URL_PLATFORM,
    dataEncryptionKey: raw.DATA_ENCRYPTION_KEY,
    outFile,
  };
}

export interface RenderSummary {
  event: 'radius_clients_rendered';
  clients: number;
  /** Clients rendered with require_message_authenticator = no. */
  relaxedMessageAuthenticator: number;
  changed: boolean;
  checkOnly: boolean;
  file: string;
  /** Rows left out (id + rule, never a secret). Non-empty => CLI exit code 3. */
  skipped: { count: number; nas: SkippedNas[] };
}

export const EXIT_SKIPPED = 3;

export interface RenderDeps {
  /** Returns the resolved NAS entries (DB read + secret opening) and rows already skipped. */
  loadEntries: (
    settings: RenderSettings,
  ) => Promise<{ entries: NasClientEntry[]; skipped: SkippedNas[] }>;
  writeFile?: typeof writeClientsFileAtomic;
}

export async function renderRadiusClients(
  settings: RenderSettings,
  deps: RenderDeps,
  options: { checkOnly?: boolean } = {},
): Promise<RenderSummary> {
  const loaded = await deps.loadEntries(settings);
  // throws when no valid client remains: nothing is written, the previous file stays
  const { content, rendered, skipped } = renderClientsConf(loaded.entries, loaded.skipped);
  const checkOnly = options.checkOnly === true;
  const { changed } = checkOnly
    ? { changed: false }
    : await (deps.writeFile ?? writeClientsFileAtomic)(settings.outFile, content);
  return {
    event: 'radius_clients_rendered',
    clients: rendered.length,
    relaxedMessageAuthenticator: relaxedClientCount(rendered),
    changed,
    checkOnly,
    file: settings.outFile,
    skipped: { count: skipped.length, nas: skipped },
  };
}

/** Error text safe for logs: render errors name NAS ids and rules only; others name the class. */
export function describeRenderError(error: unknown): string {
  if (error instanceof RadiusClientsRenderError || error instanceof ConfigError) {
    return error.message;
  }
  const err = error as { name?: unknown; code?: unknown };
  const name = typeof err.name === 'string' ? err.name : 'Error';
  const code = typeof err.code === 'string' ? ` (${err.code})` : '';
  return `${name}${code}`;
}
