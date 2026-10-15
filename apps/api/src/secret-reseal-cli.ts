#!/usr/bin/env node
/**
 * CLI for the v1 → v2 secret re-seal (task 10). Owner-authorised 2026-10-15; run by the
 * deployment operator, not from a working tree.
 *
 * THE PLAINTEXT NEVER CHANGES. Each v1 ciphertext is opened and written back sealed to its own
 * row, at the SAME `secret_version`. No secret is rotated, no NAS or controller configuration
 * becomes stale, and no reload is signalled — see the module header for why each of those is
 * deliberate.
 *
 * Environment:
 *
 *   DATABASE_URL_PLATFORM      platform (BYPASSRLS) connection
 *   DATA_ENCRYPTION_KEY        the key that seals both columns
 *
 * Usage:
 *
 *   secret-reseal --dry-run                 count only; reads nothing else, writes nothing
 *   secret-reseal --dump <path>             re-seal, writing the rollback dump to <path> first
 *   secret-reseal --restore <path>          put the dumped refs back
 *
 * `--dump` is REQUIRED for a real run. A re-seal with no rollback is not a procedure, and making
 * the operator name the file is the cheapest way to ensure one exists and they know where.
 *
 * The dump holds sealed ciphertexts, not plaintext, but it is still the material that makes the
 * old state recoverable: it is written 0600, and the file must be moved somewhere durable before
 * the container is replaced.
 *
 * Exit codes: 0 done, 1 database or crypto failure (the transaction rolled back, so every row is
 * unchanged), 2 configuration or argument error. One JSON summary line on stdout; errors on
 * stderr. NEITHER EVER CONTAINS A SECRET, a ciphertext or a connection string.
 */
import { createDb } from '@ecloud/db';
import { resolveSecretFiles } from '@ecloud/shared';
import { readFileSync, writeFileSync } from 'node:fs';
import {
  applyReseal,
  planReseal,
  restoreReseal,
  type ResealDump,
} from './reseal/secrets.js';

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value.trim() === '') throw new Error(`${name} is required`);
  return value;
}

function parseArgs(argv: readonly string[]): {
  mode: 'dry-run' | 'apply' | 'restore';
  path: string | null;
} {
  const dryRun = argv.includes('--dry-run');
  const dumpAt = argv.indexOf('--dump');
  const restoreAt = argv.indexOf('--restore');
  const dump = dumpAt === -1 ? null : (argv[dumpAt + 1] ?? null);
  const restore = restoreAt === -1 ? null : (argv[restoreAt + 1] ?? null);

  if (restore !== null) {
    if (dryRun || dump !== null) throw new Error('--restore cannot be combined with other modes');
    return { mode: 'restore', path: restore };
  }
  if (dryRun) {
    if (dump !== null) throw new Error('--dry-run writes nothing, so --dump is meaningless');
    return { mode: 'dry-run', path: null };
  }
  if (dump === null || dump.startsWith('--')) {
    // Refusing rather than defaulting a path: a dump the operator did not choose is one they
    // will not find when they need it.
    throw new Error('a real run requires --dump <path> (the rollback); or pass --dry-run');
  }
  return { mode: 'apply', path: dump };
}

async function main(): Promise<number> {
  const env = resolveSecretFiles(process.env);

  let databaseUrl: string;
  let dataEncryptionKey: string;
  let args: { mode: 'dry-run' | 'apply' | 'restore'; path: string | null };
  try {
    args = parseArgs(process.argv.slice(2));
    databaseUrl = required(env, 'DATABASE_URL_PLATFORM');
    dataEncryptionKey = required(env, 'DATA_ENCRYPTION_KEY');
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    return 2;
  }

  const db = createDb(databaseUrl);
  try {
    if (args.mode === 'dry-run') {
      const { counts } = await db.transaction().execute((trx) => planReseal(trx));
      process.stdout.write(
        `${JSON.stringify({ event: 'reseal_dry_run', would_reseal: counts.nas_v1 + counts.portal_v1, counts })}\n`,
      );
      return 0;
    }

    if (args.mode === 'restore') {
      const dump = JSON.parse(readFileSync(args.path as string, 'utf8')) as ResealDump;
      const result = await db.transaction().execute((trx) => restoreReseal(trx, dump));
      process.stdout.write(
        `${JSON.stringify({ event: 'reseal_restored', dump_taken_at: dump.taken_at, ...result })}\n`,
      );
      return 0;
    }

    // One transaction for the dump AND the writes. A rotation landing between them would
    // otherwise be silently reverted by a later restore; here it makes this run fail instead.
    const result = await db.transaction().execute(async (trx) => {
      const applied = await applyReseal(trx, dataEncryptionKey);
      writeFileSync(args.path as string, `${JSON.stringify(applied.dump, null, 2)}\n`, {
        mode: 0o600,
      });
      return applied;
    });
    process.stdout.write(
      `${JSON.stringify({
        event: 'reseal_done',
        dump_path: args.path,
        nas_updated: result.nas_updated,
        portals_updated: result.portals_updated,
        counts: result.counts,
      })}\n`,
    );
    return 0;
  } catch (error) {
    process.stderr.write(`reseal failed, nothing written: ${(error as Error).message}\n`);
    return 1;
  } finally {
    await db.destroy();
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    process.stderr.write(`reseal crashed: ${String(error)}\n`);
    process.exitCode = 1;
  });
