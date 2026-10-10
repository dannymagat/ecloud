import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MIGRATIONS_DIR,
  MIGRATION_LOCK_KEY,
  MigrationDriftError,
  MigrationError,
  baselineMigrations,
  checksumOf,
  discoverMigrations,
  loadMigrationFile,
  migrationStatus,
  parseDirectives,
  refusesTransaction,
  runMigrations,
  sortMigrations,
  type AppliedMigration,
  type MigrationExecutor,
  type MigrationFile,
} from './migrate.js';

/** In-memory executor: records every statement, serves `schema_migrations` from a map. */
class FakeExecutor implements MigrationExecutor {
  readonly statements: { text: string; values?: readonly unknown[] }[] = [];
  readonly applied = new Map<string, AppliedMigration>();
  tableExists: boolean;
  failOn?: RegExp;
  lockHeld = false;

  constructor(options: { tableExists?: boolean; applied?: AppliedMigration[] } = {}) {
    this.tableExists = options.tableExists ?? true;
    for (const row of options.applied ?? []) this.applied.set(row.name, row);
  }

  query<R extends Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: R[] }> {
    this.statements.push({ text, values });
    if (this.failOn?.test(text)) {
      return Promise.reject(new Error(`boom: ${text.slice(0, 30)}`));
    }
    if (text.includes('pg_advisory_lock')) {
      this.lockHeld = true;
      return Promise.resolve({ rows: [] });
    }
    if (text.includes('pg_advisory_unlock')) {
      this.lockHeld = false;
      return Promise.resolve({ rows: [] });
    }
    if (text.startsWith('CREATE TABLE IF NOT EXISTS schema_migrations')) {
      this.tableExists = true;
      return Promise.resolve({ rows: [] });
    }
    if (text.includes('FROM schema_migrations')) {
      if (!this.tableExists) {
        return Promise.reject(
          Object.assign(new Error('relation "schema_migrations" does not exist'), {
            code: '42P01',
          }),
        );
      }
      return Promise.resolve({ rows: [...this.applied.values()] as unknown as R[] });
    }
    if (text.startsWith('INSERT INTO schema_migrations')) {
      const [name, version, checksum, applied_by, duration_ms, baselined] = values as [
        string,
        string,
        string,
        string,
        number,
        boolean,
      ];
      this.applied.set(name, {
        name,
        version,
        checksum,
        applied_by,
        duration_ms,
        baselined,
        applied_at: new Date('2026-10-07T00:00:00Z'),
      });
    }
    return Promise.resolve({ rows: [] });
  }

  texts(): string[] {
    return this.statements.map((s) => s.text);
  }
}

function file(name: string, sql: string): MigrationFile {
  return loadMigrationFile(`${name}.sql`, sql);
}

const F1 = file('001_a', 'CREATE TABLE a (id int);');
const F2 = file('002_b', 'CREATE TABLE b (id int);');
const F3 = file(
  '003_c',
  '-- ecloud:no-transaction\nCREATE INDEX CONCURRENTLY idx ON a (id);\nCREATE INDEX CONCURRENTLY idx2 ON b (id);',
);

describe('checksumOf / parseDirectives', () => {
  it('normalises CRLF so checkouts on Windows do not drift', () => {
    expect(checksumOf('a\r\nb')).toBe(checksumOf('a\nb'));
    expect(checksumOf('a')).not.toBe(checksumOf('b'));
  });

  it('reads the no-transaction directive only from the header', () => {
    expect(parseDirectives('-- ecloud:no-transaction\nSELECT 1').noTransaction).toBe(true);
    expect(parseDirectives('\n  --   ecloud:no-transaction  \nSELECT 1').noTransaction).toBe(true);
    expect(parseDirectives('SELECT 1;\n-- ecloud:no-transaction').noTransaction).toBe(false);
    expect(parseDirectives('-- plain comment\nSELECT 1').noTransaction).toBe(false);
  });

  it('rejects unknown directives', () => {
    expect(() => parseDirectives('-- ecloud:requires-role\nSELECT 1')).toThrow(
      /Unknown migration directive/,
    );
  });
});

describe('loadMigrationFile / sortMigrations', () => {
  it('refuses CONCURRENTLY without the directive and accepts it with', () => {
    expect(() => file('004_d', 'CREATE INDEX CONCURRENTLY i ON a (id);')).toThrow(/no-transaction/);
    expect(F3.noTransaction).toBe(true);
    expect(refusesTransaction('-- CONCURRENTLY in a comment is fine\nSELECT 1')).toBeNull();
    expect(refusesTransaction('VACUUM a')).toMatch(/VACUUM/);
  });

  it('rejects bad names and orders numerically', () => {
    expect(() => loadMigrationFile('bad.sql', '')).toThrow(/Invalid migration file name/);
    const sorted = sortMigrations([F3, file('0010_z', 'SELECT 1'), F1, F2]);
    expect(sorted.map((f) => f.file)).toEqual([
      '001_a.sql',
      '002_b.sql',
      '003_c.sql',
      '0010_z.sql',
    ]);
    expect(F1.name).toBe('001_a');
    expect(F1.version).toBe('001');
  });

  it('rejects duplicate version numbers', () => {
    expect(() => sortMigrations([F1, file('001_other', 'SELECT 1')])).toThrow(
      /Duplicate migration version 001/,
    );
  });
});

describe('runMigrations', () => {
  it('applies pending files in order, one transaction each, under the advisory lock', async () => {
    const exec = new FakeExecutor({ tableExists: false });
    const results = await runMigrations(exec, [F2, F1], { actor: 'test' });
    expect(results.map((r) => [r.file, r.state])).toEqual([
      ['001_a.sql', 'applied'],
      ['002_b.sql', 'applied'],
    ]);
    const texts = exec.texts();
    expect(texts[0]).toContain('pg_advisory_lock');
    expect(exec.statements[0]?.values).toEqual([MIGRATION_LOCK_KEY]);
    expect(texts[1]).toMatch(/^CREATE TABLE IF NOT EXISTS schema_migrations/);
    const a = texts.indexOf(F1.sql);
    expect(texts[a - 1]).toBe('BEGIN');
    expect(texts[a + 1]).toMatch(/^INSERT INTO schema_migrations/);
    expect(texts[a + 2]).toBe('COMMIT');
    expect(texts.indexOf(F2.sql)).toBeGreaterThan(a);
    expect(texts.at(-1)).toContain('pg_advisory_unlock');
    expect(exec.lockHeld).toBe(false);
    expect(exec.applied.get('001_a')?.checksum).toBe(F1.checksum);
    expect(exec.applied.get('001_a')?.applied_by).toBe('test');
    expect(exec.applied.get('001_a')?.baselined).toBe(false);
  });

  it('skips applied files and verifies their checksum', async () => {
    const exec = new FakeExecutor();
    await runMigrations(exec, [F1]);
    exec.statements.length = 0;
    const results = await runMigrations(exec, [F1, F2]);
    expect(results.map((r) => r.state)).toEqual(['skipped', 'applied']);
    expect(exec.texts()).not.toContain(F1.sql);
    expect(exec.texts()).toContain(F2.sql);
  });

  it('fails closed on checksum drift and never re-stamps', async () => {
    const exec = new FakeExecutor();
    await runMigrations(exec, [F1]);
    const edited = file('001_a', 'CREATE TABLE a (id bigint);');
    exec.statements.length = 0;
    await expect(runMigrations(exec, [edited, F2])).rejects.toBeInstanceOf(MigrationDriftError);
    expect(exec.texts()).not.toContain(F2.sql);
    expect(exec.texts().some((t) => t.startsWith('UPDATE schema_migrations'))).toBe(false);
    expect(exec.applied.get('001_a')?.checksum).toBe(F1.checksum);
    expect(exec.lockHeld).toBe(false);
  });

  it('fails closed on orphans recorded in the database', async () => {
    const exec = new FakeExecutor();
    await runMigrations(exec, [F1, F2]);
    await expect(runMigrations(exec, [F1])).rejects.toThrow(/002_b/);
  });

  it('rolls back the failed file and stops', async () => {
    const exec = new FakeExecutor();
    exec.failOn = /CREATE TABLE b/;
    await expect(runMigrations(exec, [F1, F2])).rejects.toMatchObject({
      name: 'MigrationError',
      message: expect.stringContaining('002_b.sql') as string,
    });
    const texts = exec.texts();
    expect(texts[texts.indexOf(F2.sql) + 1]).toBe('ROLLBACK');
    expect(exec.applied.has('001_a')).toBe(true);
    expect(exec.applied.has('002_b')).toBe(false);
    expect(exec.lockHeld).toBe(false);
    try {
      await runMigrations(new FakeExecutor({ applied: [...exec.applied.values()] }), [F1, F2]);
    } catch (error) {
      expect(error).toBeInstanceOf(MigrationError);
    }
  });

  it('runs no-transaction files statement by statement and records them only at the end', async () => {
    const exec = new FakeExecutor();
    const results = await runMigrations(exec, [F1, F3]);
    expect(results[1]).toMatchObject({ file: '003_c.sql', state: 'applied', noTransaction: true });
    const texts = exec.texts();
    const i1 = texts.indexOf('CREATE INDEX CONCURRENTLY idx ON a (id)');
    const i2 = texts.indexOf('CREATE INDEX CONCURRENTLY idx2 ON b (id)');
    expect(i1).toBeGreaterThan(0);
    expect(i2).toBe(i1 + 1);
    expect(texts[i1 - 1]).not.toBe('BEGIN');
    expect(texts[i2 + 1]).toMatch(/^INSERT INTO schema_migrations/);
  });

  it('dry-run writes nothing, not even the tracking table', async () => {
    const exec = new FakeExecutor({ tableExists: false });
    const results = await runMigrations(exec, [F1], { dryRun: true });
    expect(results).toEqual([
      { name: '001_a', file: '001_a.sql', state: 'applied', durationMs: 0, noTransaction: false },
    ]);
    expect(exec.texts().some((t) => t.startsWith('CREATE TABLE IF NOT EXISTS'))).toBe(false);
    expect(exec.texts()).not.toContain(F1.sql);
    expect(exec.texts().some((t) => t.includes('pg_advisory_lock'))).toBe(false);
  });
});

describe('migrationStatus / baselineMigrations', () => {
  it('reports pending, applied, baselined, changed and orphans without writing', async () => {
    const exec = new FakeExecutor();
    await runMigrations(exec, [F1]);
    await baselineMigrations(exec, [F1, F2], 'who');
    expect(exec.applied.get('002_b')?.baselined).toBe(true);
    expect(exec.applied.get('002_b')?.applied_by).toBe('who');
    exec.statements.length = 0;
    const status = await migrationStatus(exec, [
      file('001_a', 'changed'),
      F3,
      file('004_d', 'SELECT 1'),
    ]);
    expect(status.migrations.map((m) => [m.file, m.state])).toEqual([
      ['001_a.sql', 'changed'],
      ['003_c.sql', 'pending'],
      ['004_d.sql', 'pending'],
    ]);
    expect(status.orphans).toEqual(['002_b']);
    expect(status.pending).toBe(2);
    expect(status.clean).toBe(false);
    expect(exec.texts().every((t) => t.startsWith('SELECT'))).toBe(true);

    const clean = await migrationStatus(exec, [F1, F2]);
    expect(clean.migrations.map((m) => m.state)).toEqual(['applied', 'baselined']);
    expect(clean.clean).toBe(true);
  });

  it('treats a missing table as nothing applied (and surfaces other errors)', async () => {
    const exec = new FakeExecutor({ tableExists: false });
    const status = await migrationStatus(exec, [F1]);
    expect(status.pending).toBe(1);
    expect(exec.tableExists).toBe(false);
    exec.failOn = /FROM schema_migrations/;
    await expect(migrationStatus(exec, [F1])).rejects.toThrow(/boom/);
  });
});

describe('repository migrations', () => {
  it('discovers the real files in order with unique versions and no stray directives', () => {
    const files = discoverMigrations(DEFAULT_MIGRATIONS_DIR);
    expect(files.length).toBeGreaterThanOrEqual(11);
    expect(files[0]?.file).toBe('001_functions.sql');
    expect(files.every((f) => !f.noTransaction)).toBe(true);
    // Strictly increasing, unique and (since the Cycle B + Cycle C merge) contiguous 001…N:
    // a parallel cycle branch that reserves a later number must close the gap before merging.
    const versions = files.map((f) => Number(f.version));
    expect(new Set(versions).size).toBe(versions.length);
    expect(versions.every((v, i) => i === 0 || v > (versions[i - 1] ?? 0))).toBe(true);
    expect(versions).toEqual(files.map((_, i) => i + 1));
    expect(versions).toEqual(expect.arrayContaining([29, 30]));
    expect(files.every((f) => /SET LOCAL lock_timeout/.test(f.sql))).toBe(true);
  });
});
