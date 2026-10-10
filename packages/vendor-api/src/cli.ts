#!/usr/bin/env node
/**
 * Deploy-time key derivation for secrets tooling (review F4; docs/SECRETS_MANAGEMENT.md):
 *
 *   DATA_ENCRYPTION_KEY_FILE=/path/data_encryption_key \
 *     node packages/vendor-api/dist/cli.js derive-key vendor-api > vendor_api_secret_key
 *
 * Reads the master key ONLY from `DATA_ENCRYPTION_KEY` or `DATA_ENCRYPTION_KEY_FILE` (never from
 * argv, so it never shows up in `ps`), prints `vapi1.<base64url>` (the worker's
 * `VENDOR_API_SECRET_KEY`) to stdout without a trailing newline, and nothing else.
 */
import { resolveSecretFiles } from '@ecloud/shared';
import { deriveVendorApiKey } from './sealed.js';

export function runCli(
  argv: readonly string[],
  env: Record<string, string | undefined>,
  out: (text: string) => void,
): number {
  if (argv[0] !== 'derive-key' || argv[1] !== 'vendor-api' || argv.length !== 2) {
    console.error(
      'usage: cli.js derive-key vendor-api  (master key from DATA_ENCRYPTION_KEY[_FILE])',
    );
    return 2;
  }
  let master: string | undefined;
  try {
    master = resolveSecretFiles(env).DATA_ENCRYPTION_KEY;
  } catch {
    console.error('DATA_ENCRYPTION_KEY_FILE cannot be read');
    return 1;
  }
  if (master === undefined || master.length < 16) {
    console.error('DATA_ENCRYPTION_KEY (or _FILE) is required (>= 16 characters)');
    return 1;
  }
  out(deriveVendorApiKey(master));
  return 0;
}

if (process.argv[1] !== undefined && /cli\.(js|ts)$/.test(process.argv[1])) {
  process.exitCode = runCli(process.argv.slice(2), process.env, (t) => process.stdout.write(t));
}
