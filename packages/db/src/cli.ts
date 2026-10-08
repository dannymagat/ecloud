#!/usr/bin/env node
/**
 * ecloud-db — database CLI (`npm run db:migrate -- <command>` or `node packages/db/dist/cli.js`).
 *
 *   migrate [--dry-run]                       apply pending migrations (one transaction each)
 *   status [--json]                           show applied / pending / changed; exit 2 if not clean
 *   baseline                                  record every file as applied without running it
 *   seed                                      upsert permission catalogue + role templates (@ecloud/shared)
 *                                             and the compatibility-registry mirror (@ecloud/adapters)
 *   registry-check [--json]                   compare the registry mirror with @ecloud/adapters; exit 2 on drift
 *   ensure-partitions [--months-ahead N]      create monthly partitions (default 2 months ahead)
 *   create-platform-admin --email E --password-stdin [--display-name N]
 *
 * Global flags: --url <postgres url> (default: DATABASE_URL_PLATFORM from the environment),
 *               --dir <migrations dir>.
 * Connects as the BYPASSRLS platform role; never prints connection secrets.
 */
import { parseArgs } from 'node:util';
import { ConfigError, loadConfig, redactUrl } from '@ecloud/shared';
import pg from 'pg';
import { createPlatformAdmin } from './admin.js';
import {
  MigrationError,
  baselineMigrations,
  discoverMigrations,
  migrationStatus,
  pgExecutor,
  runMigrations,
  type MigrationExecutor,
} from './migrate.js';
import { DEFAULT_MONTHS_AHEAD, ensureMonthPartitions } from './partitions.js';
import { seedRegistry, verifyRegistryMirror } from './registry-seed.js';
import { seedCatalogue } from './seed.js';

const COMMANDS = [
  'migrate',
  'status',
  'baseline',
  'seed',
  'registry-check',
  'ensure-partitions',
  'create-platform-admin',
] as const;
type Command = (typeof COMMANDS)[number];

const USAGE = `usage: ecloud-db <command> [options]

commands:
  migrate [--dry-run]                      apply pending migrations
  status [--json]                          report migration state (exit 2 when not clean)
  baseline                                 record all files as applied without executing them
  seed                                     upsert permission catalogue, role templates and the
                                           compatibility-registry mirror (hash-checked)
  registry-check [--json]                  compare the registry mirror with the code (exit 2 on drift)
  ensure-partitions [--months-ahead N]     create monthly partitions ahead of time (default ${String(DEFAULT_MONTHS_AHEAD)})
  create-platform-admin --email E --password-stdin [--display-name N]

options:
  --url <postgres url>   platform (BYPASSRLS) connection; default DATABASE_URL_PLATFORM
  --dir <path>           migrations directory; default packages/db/migrations
`;

function out(line: string): void {
  process.stdout.write(`${line}\n`);
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on('data', (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', reject);
  });
}

function resolveUrl(flag: string | undefined, env: NodeJS.ProcessEnv): string {
  if (flag !== undefined && flag.trim() !== '') return flag;
  const fromEnv = env['DATABASE_URL_PLATFORM'];
  if (fromEnv !== undefined && fromEnv.trim() !== '') return fromEnv;
  return loadConfig(env).database.platformUrl;
}

async function withClient<T>(url: string, fn: (exec: MigrationExecutor) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url, application_name: 'ecloud-db-cli' });
  await client.connect();
  try {
    return await fn(pgExecutor(client));
  } finally {
    await client.end();
  }
}

export async function main(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      url: { type: 'string' },
      dir: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      'months-ahead': { type: 'string' },
      email: { type: 'string' },
      'password-stdin': { type: 'boolean', default: false },
      'display-name': { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  const command = positionals[0];
  if (values.help || command === undefined || !(COMMANDS as readonly string[]).includes(command)) {
    process.stderr.write(USAGE);
    return command === undefined || values.help ? 0 : 1;
  }

  const url = resolveUrl(values.url, env);
  const files = discoverMigrations(values.dir);
  out(`ecloud-db ${command} -> ${redactUrl(url)} (${String(files.length)} migration files)`);

  switch (command as Command) {
    case 'status': {
      const status = await withClient(url, (exec) => migrationStatus(exec, files));
      if (values.json) {
        out(JSON.stringify(status, null, 2));
      } else {
        for (const m of status.migrations) {
          const when = m.appliedAt === undefined ? '' : ` (${new Date(m.appliedAt).toISOString()})`;
          out(`  ${m.state.padEnd(9)} ${m.file}${when}`);
        }
        for (const orphan of status.orphans)
          out(`  orphan    ${orphan} (recorded in DB, no file on disk)`);
        out(
          status.clean
            ? 'status: clean'
            : `status: ${String(status.pending)} pending, ${String(status.orphans.length)} orphans, ${String(status.migrations.filter((m) => m.state === 'changed').length)} changed`,
        );
      }
      return status.clean ? 0 : 2;
    }
    case 'migrate': {
      const results = await withClient(url, (exec) =>
        runMigrations(exec, files, {
          dryRun: values['dry-run'],
          onApplied: (r) =>
            out(
              `  applied   ${r.file} (${String(r.durationMs)} ms${r.noTransaction ? ', no-transaction' : ''})`,
            ),
        }),
      );
      const applied = results.filter((r) => r.state === 'applied').length;
      out(
        values['dry-run']
          ? `dry-run: ${String(applied)} would be applied`
          : `migrate: ${String(applied)} applied, ${String(results.length - applied)} already applied`,
      );
      return 0;
    }
    case 'baseline': {
      const recorded = await withClient(url, (exec) =>
        baselineMigrations(exec, files, 'ecloud-db baseline'),
      );
      for (const file of recorded) out(`  baselined ${file}`);
      out(`baseline: ${String(recorded.length)} recorded`);
      return 0;
    }
    case 'seed': {
      const result = await withClient(url, (exec) => seedCatalogue(exec));
      out(
        `  permissions: ${String(result.permissions.total)} in catalogue, ${String(result.permissions.inserted)} inserted, ${String(result.permissions.updated)} updated`,
      );
      if (result.permissions.orphans.length > 0) {
        out(
          `  WARNING: ${String(result.permissions.orphans.length)} permission keys exist in the database but not in the catalogue: ${result.permissions.orphans.join(', ')}`,
        );
      }
      for (const t of result.templates) {
        out(
          `  template ${t.key.padEnd(22)} ${String(t.permissionCount).padStart(3)} permissions (+${String(t.added)} -${String(t.removed)}) v${String(t.templateVersion)}${t.created ? ' created' : ''}`,
        );
      }
      const registry = await withClient(url, (exec) => seedRegistry(exec));
      out(
        `  registry: ${String(registry.vendors.total)} vendors (+${String(registry.vendors.inserted)} ~${String(registry.vendors.updated)}), ${String(registry.hardwareModels.total)} hardware models (+${String(registry.hardwareModels.inserted)}), ${String(registry.firmwareVersions.total)} firmware versions (+${String(registry.firmwareVersions.inserted)}), ${String(registry.entries.total)} compatibility entries (+${String(registry.entries.inserted)} ~${String(registry.entries.updated)} -${String(registry.entries.removed.length)})`,
      );
      out(`  registry hash: ${registry.registryHash} (mirror verified)`);
      if (registry.check.orphans.length > 0) {
        out(
          `  WARNING: ${String(registry.check.orphans.length)} registry-mirror rows are no longer in the registry: ${registry.check.orphans.join(', ')}`,
        );
      }
      out('seed: done');
      return 0;
    }
    case 'registry-check': {
      const check = await withClient(url, (exec) => verifyRegistryMirror(exec));
      if (values.json) {
        out(JSON.stringify(check, null, 2));
      } else {
        for (const m of check.mismatches) out(`  mismatch  ${m}`);
        for (const o of check.orphans) out(`  orphan    ${o}`);
        out(
          check.ok
            ? `registry-check: ok (${check.registryHash})`
            : `registry-check: ${String(check.mismatches.length)} mismatches (registry ${check.registryHash}, database ${check.mirrorHash})`,
        );
      }
      return check.ok ? 0 : 2;
    }
    case 'ensure-partitions': {
      const monthsAhead =
        values['months-ahead'] === undefined
          ? DEFAULT_MONTHS_AHEAD
          : Number(values['months-ahead']);
      const results = await withClient(url, (exec) => ensureMonthPartitions(exec, monthsAhead));
      for (const r of results) {
        out(
          `  ${r.table.padEnd(24)} ${r.created.length === 0 ? 'up to date' : `created ${r.created.join(', ')}`}`,
        );
      }
      out('ensure-partitions: done');
      return 0;
    }
    case 'create-platform-admin': {
      if (values.email === undefined) throw new Error('create-platform-admin requires --email');
      if (!values['password-stdin']) {
        throw new Error(
          'create-platform-admin requires --password-stdin (the password is read from stdin, never from arguments)',
        );
      }
      const password = (await readStdin()).replace(/\r?\n$/, '');
      const memoryKib = loadConfig(env).argon2.memoryKib;
      const result = await withClient(url, (exec) =>
        createPlatformAdmin(exec, {
          email: values.email as string,
          password,
          displayName: values['display-name'],
          argon2MemoryKib: memoryKib,
        }),
      );
      out(
        `create-platform-admin: created ${result.email} (administrator ${result.administratorId}) with the platform_super_admin template`,
      );
      return 0;
    }
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    if (error instanceof ConfigError) {
      console.error(error.message);
    } else if (error instanceof MigrationError) {
      for (const r of error.results) console.error(`  ${r.state.padEnd(9)} ${r.file}`);
      console.error(`ecloud-db: ${error.message}`);
    } else {
      console.error(`ecloud-db: ${error instanceof Error ? error.message : String(error)}`);
    }
    process.exitCode = 1;
  },
);
