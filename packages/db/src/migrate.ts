/**
 * Forward-only SQL migration runner (DATABASE_DESIGN.md §9).
 *
 * Ported from ezecontroller `src/lib/migrate.ts` (VERIFIED FROM EXISTING CODE): filename
 * pattern `NNN_name.sql`, sha256 checksums of applied files, one transaction per file, stop at
 * the first failure, `status` never writes, `baseline` records without executing.
 *
 * Changes versus the precedent:
 *  - checksum drift is ALWAYS an error (no `--allow-drift`; fix forward with a new file);
 *  - `-- ecloud:no-transaction` header directive runs a file statement-by-statement outside a
 *    transaction (CREATE INDEX CONCURRENTLY); it is recorded as applied only after every
 *    statement succeeded, so such files must be idempotent (IF NOT EXISTS);
 *  - a session advisory lock prevents two runners from applying files concurrently;
 *  - the executor is an interface (one connection) so the runner is unit-testable without PG.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { splitStatements } from './sql.js';

export const MIGRATION_FILE_RE = /^(\d{3,})_([A-Za-z0-9._-]+)\.sql$/;
export const NO_TRANSACTION_DIRECTIVE = 'ecloud:no-transaction';
/** Arbitrary constant; every ECLOUD runner takes the same session-level advisory lock. */
export const MIGRATION_LOCK_KEY = 8_120_371_001;
export const DEFAULT_MIGRATIONS_DIR = fileURLToPath(new URL('../migrations/', import.meta.url));

export interface MigrationFile {
  /** Numeric prefix as written (`001`). */
  version: string;
  /** File name without `.sql` (`001_functions`); primary key in `schema_migrations`. */
  name: string;
  /** File name with extension. */
  file: string;
  sql: string;
  /** sha256 hex of the LF-normalised file content. */
  checksum: string;
  noTransaction: boolean;
}

export interface QueryResultLike<R> {
  rows: R[];
}

/** One connection. `pg.Client` is adapted with {@link pgExecutor}. */
export interface MigrationExecutor {
  query<R extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResultLike<R>>;
}

export interface AppliedMigration {
  name: string;
  version: string;
  checksum: string;
  applied_at: Date | string;
  applied_by: string;
  duration_ms: number;
  baselined: boolean;
}

export type MigrationState = 'pending' | 'applied' | 'baselined' | 'changed';

export interface MigrationStatusEntry {
  name: string;
  version: string;
  file: string;
  state: MigrationState;
  appliedAt?: Date | string;
}

export interface MigrationStatus {
  migrations: MigrationStatusEntry[];
  /** Recorded in the database but missing on disk. */
  orphans: string[];
  pending: number;
  clean: boolean;
}

export interface MigrationResult {
  name: string;
  file: string;
  state: 'applied' | 'skipped';
  durationMs: number;
  noTransaction: boolean;
}

export class MigrationError extends Error {
  readonly results: readonly MigrationResult[];
  constructor(message: string, results: readonly MigrationResult[], options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'MigrationError';
    this.results = results;
  }
}

/** Checksum drift or orphan: the database no longer matches the files. Never auto-repaired. */
export class MigrationDriftError extends MigrationError {
  constructor(message: string) {
    super(message, []);
    this.name = 'MigrationDriftError';
  }
}

export function checksumOf(sql: string): string {
  return createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex');
}

/**
 * Parses `-- ecloud:<directive>` lines in the file header (leading blank/comment lines).
 * Unknown directives are an error so a typo cannot silently change semantics.
 */
export function parseDirectives(sql: string): { noTransaction: boolean } {
  let noTransaction = false;
  for (const rawLine of sql.split('\n')) {
    const line = rawLine.trim();
    if (line === '') continue;
    if (!line.startsWith('--')) break;
    const match = /^--\s*ecloud:([a-z-]+)\s*$/.exec(line);
    if (match === null) continue;
    const directive = `ecloud:${match[1] ?? ''}`;
    if (directive === NO_TRANSACTION_DIRECTIVE) noTransaction = true;
    else throw new Error(`Unknown migration directive "-- ${directive}"`);
  }
  return { noTransaction };
}

/** Statements that cannot run inside a transaction block (precedent `refusesTransaction`). */
export function refusesTransaction(sql: string): string | null {
  const stripped = sql.replace(/--[^\n]*/g, '');
  if (/\bCONCURRENTLY\b/i.test(stripped)) {
    return 'CREATE/DROP INDEX CONCURRENTLY cannot run inside a transaction';
  }
  if (/^\s*VACUUM\b/im.test(stripped)) return 'VACUUM cannot run inside a transaction';
  return null;
}

export function loadMigrationFile(file: string, sql: string): MigrationFile {
  const match = MIGRATION_FILE_RE.exec(file);
  if (match === null) throw new Error(`Invalid migration file name: ${file}`);
  const { noTransaction } = parseDirectives(sql);
  if (!noTransaction) {
    const blocker = refusesTransaction(sql);
    if (blocker !== null) {
      throw new Error(`${file}: ${blocker}; add the "-- ${NO_TRANSACTION_DIRECTIVE}" directive`);
    }
  }
  return {
    version: match[1] ?? '',
    name: file.slice(0, -'.sql'.length),
    file,
    sql,
    checksum: checksumOf(sql),
    noTransaction,
  };
}

/** Validates ordering: sorted by version, no duplicate version numbers. */
export function sortMigrations(files: readonly MigrationFile[]): MigrationFile[] {
  const sorted = [...files].sort((a, b) => {
    const diff = Number(a.version) - Number(b.version);
    return diff !== 0 ? diff : a.name.localeCompare(b.name);
  });
  for (let i = 1; i < sorted.length; i += 1) {
    const prev = sorted[i - 1] as MigrationFile;
    const cur = sorted[i] as MigrationFile;
    if (Number(prev.version) === Number(cur.version)) {
      throw new Error(`Duplicate migration version ${cur.version}: ${prev.file} and ${cur.file}`);
    }
  }
  return sorted;
}

export function discoverMigrations(dir: string = DEFAULT_MIGRATIONS_DIR): MigrationFile[] {
  const entries = readdirSync(dir).filter((f) => MIGRATION_FILE_RE.test(f));
  return sortMigrations(
    entries.map((file) => loadMigrationFile(file, readFileSync(join(dir, file), 'utf8'))),
  );
}

const CREATE_TABLE_SQL = `CREATE TABLE IF NOT EXISTS schema_migrations (
  name        text PRIMARY KEY,
  version     text NOT NULL,
  checksum    text NOT NULL,
  applied_at  timestamptz NOT NULL DEFAULT now(),
  applied_by  text NOT NULL DEFAULT current_user,
  duration_ms integer NOT NULL DEFAULT 0,
  baselined   boolean NOT NULL DEFAULT false
)`;

const SELECT_APPLIED_SQL =
  'SELECT name, version, checksum, applied_at, applied_by, duration_ms, baselined FROM schema_migrations ORDER BY version';

const INSERT_APPLIED_SQL = `INSERT INTO schema_migrations (name, version, checksum, applied_by, duration_ms, baselined)
VALUES ($1, $2, $3, $4, $5, $6)`;

export async function ensureMigrationsTable(exec: MigrationExecutor): Promise<void> {
  await exec.query(CREATE_TABLE_SQL);
}

/**
 * @param create false = never write (`status` must be safe against production). A missing
 *   table means "nothing applied yet"; only SQLSTATE 42P01 is swallowed.
 */
export async function fetchApplied(
  exec: MigrationExecutor,
  options: { create: boolean },
): Promise<Map<string, AppliedMigration>> {
  if (options.create) await ensureMigrationsTable(exec);
  let rows: AppliedMigration[] = [];
  try {
    rows = (await exec.query<AppliedMigration & Record<string, unknown>>(SELECT_APPLIED_SQL)).rows;
  } catch (error) {
    if (!isUndefinedTable(error)) throw error;
  }
  return new Map(rows.map((row) => [row.name, row]));
}

function isUndefinedTable(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === '42P01'
  );
}

export async function migrationStatus(
  exec: MigrationExecutor,
  files: readonly MigrationFile[],
): Promise<MigrationStatus> {
  const applied = await fetchApplied(exec, { create: false });
  const migrations = files.map((f): MigrationStatusEntry => {
    const row = applied.get(f.name);
    if (row === undefined)
      return { name: f.name, version: f.version, file: f.file, state: 'pending' };
    if (row.checksum !== f.checksum) {
      return {
        name: f.name,
        version: f.version,
        file: f.file,
        state: 'changed',
        appliedAt: row.applied_at,
      };
    }
    return {
      name: f.name,
      version: f.version,
      file: f.file,
      state: row.baselined ? 'baselined' : 'applied',
      appliedAt: row.applied_at,
    };
  });
  const orphans = [...applied.keys()].filter((name) => !files.some((f) => f.name === name));
  const pending = migrations.filter((m) => m.state === 'pending').length;
  const clean =
    pending === 0 && orphans.length === 0 && migrations.every((m) => m.state !== 'changed');
  return { migrations, orphans, pending, clean };
}

/** Runs `fn` while holding the runner's session advisory lock (blocks until acquired). */
export async function withMigrationLock<T>(
  exec: MigrationExecutor,
  fn: () => Promise<T>,
): Promise<T> {
  await exec.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
  try {
    return await fn();
  } finally {
    await exec.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);
  }
}

function verifyApplied(
  applied: ReadonlyMap<string, AppliedMigration>,
  files: readonly MigrationFile[],
): void {
  for (const f of files) {
    const row = applied.get(f.name);
    if (row !== undefined && row.checksum !== f.checksum) {
      throw new MigrationDriftError(
        `${f.file} was modified after it was applied (checksum ${row.checksum.slice(0, 12)}… != ${f.checksum.slice(0, 12)}…). ` +
          'Applied migrations are immutable: restore the file or add a new migration.',
      );
    }
  }
  const orphans = [...applied.keys()].filter((name) => !files.some((f) => f.name === name));
  if (orphans.length > 0) {
    throw new MigrationDriftError(
      `Database records migrations that do not exist on disk: ${orphans.join(', ')} (wrong branch or deleted file).`,
    );
  }
}

/** Records every file as applied WITHOUT running it (adopting an existing database). */
export async function baselineMigrations(
  exec: MigrationExecutor,
  files: readonly MigrationFile[],
  actor = 'baseline',
): Promise<string[]> {
  return withMigrationLock(exec, async () => {
    const applied = await fetchApplied(exec, { create: true });
    const recorded: string[] = [];
    for (const f of files) {
      if (applied.has(f.name)) continue;
      await exec.query(INSERT_APPLIED_SQL, [f.name, f.version, f.checksum, actor, 0, true]);
      recorded.push(f.file);
    }
    return recorded;
  });
}

export interface RunOptions {
  actor?: string;
  /** Report what would be applied; writes nothing (not even `schema_migrations`). */
  dryRun?: boolean;
  onApplied?: (result: MigrationResult) => void;
}

/**
 * Applies every pending migration in order. Verifies the checksum of every applied file first
 * and refuses to continue on drift or orphans. Stops at the first failure (nothing after a
 * failed file is attempted; the failed transactional file leaves nothing half-applied).
 */
export async function runMigrations(
  exec: MigrationExecutor,
  files: readonly MigrationFile[],
  options: RunOptions = {},
): Promise<MigrationResult[]> {
  const ordered = sortMigrations(files);
  const run = async (): Promise<MigrationResult[]> => {
    const applied = await fetchApplied(exec, { create: options.dryRun !== true });
    verifyApplied(applied, ordered);
    const results: MigrationResult[] = [];
    for (const f of ordered) {
      if (applied.has(f.name)) {
        results.push({
          name: f.name,
          file: f.file,
          state: 'skipped',
          durationMs: 0,
          noTransaction: f.noTransaction,
        });
        continue;
      }
      if (options.dryRun === true) {
        results.push({
          name: f.name,
          file: f.file,
          state: 'applied',
          durationMs: 0,
          noTransaction: f.noTransaction,
        });
        continue;
      }
      const started = Date.now();
      try {
        if (f.noTransaction) {
          for (const statement of splitStatements(f.sql)) await exec.query(statement);
          await exec.query(INSERT_APPLIED_SQL, [
            f.name,
            f.version,
            f.checksum,
            options.actor ?? 'migrate',
            Date.now() - started,
            false,
          ]);
        } else {
          await exec.query('BEGIN');
          try {
            await exec.query(f.sql);
            await exec.query(INSERT_APPLIED_SQL, [
              f.name,
              f.version,
              f.checksum,
              options.actor ?? 'migrate',
              Date.now() - started,
              false,
            ]);
            await exec.query('COMMIT');
          } catch (error) {
            await exec.query('ROLLBACK').catch(() => undefined);
            throw error;
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new MigrationError(`Migration ${f.file} failed: ${message}`, results, {
          cause: error,
        });
      }
      const result: MigrationResult = {
        name: f.name,
        file: f.file,
        state: 'applied',
        durationMs: Date.now() - started,
        noTransaction: f.noTransaction,
      };
      results.push(result);
      options.onApplied?.(result);
    }
    return results;
  };
  return options.dryRun === true ? run() : withMigrationLock(exec, run);
}

/** Minimal structural type for `pg.Client` / `pg.PoolClient` (avoids importing pg here). */
export interface PgQueryable {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
}

/** Adapts a `pg` client to {@link MigrationExecutor}. */
export function pgExecutor(client: PgQueryable): MigrationExecutor {
  return {
    async query<R extends Record<string, unknown>>(text: string, values?: readonly unknown[]) {
      const result = await client.query(text, values === undefined ? undefined : [...values]);
      return { rows: result.rows as R[] };
    },
  };
}
