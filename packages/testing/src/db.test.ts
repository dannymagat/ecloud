import { describe, expect, it } from 'vitest';
import {
  DATA_TABLES,
  SEED_TABLES,
  quoteTableName,
  truncateAll,
  truncateStatement,
  truncateStatements,
} from './db.js';

describe('truncateAll', () => {
  it('issues one TRUNCATE over the quoted table list', async () => {
    const executed: string[] = [];
    await truncateAll({ query: (sql) => Promise.resolve(executed.push(sql)) }, [
      'sessions',
      'radius.accounting_raw',
    ]);
    expect(executed).toEqual([
      'TRUNCATE TABLE "sessions", "radius"."accounting_raw" RESTART IDENTITY CASCADE',
    ]);
  });

  it('empties organizations with DELETE so role templates survive the cascade', async () => {
    const executed: string[] = [];
    await truncateAll({ query: (sql) => Promise.resolve(executed.push(sql)) }, [
      'organizations',
      'sites',
      'users',
    ]);
    expect(executed).toEqual([
      'TRUNCATE TABLE "sites", "users" RESTART IDENTITY CASCADE',
      'DELETE FROM "organizations"',
    ]);
  });

  it('defaults to DATA_TABLES (seeded catalogues excluded)', async () => {
    const executed: string[] = [];
    await truncateAll({ query: (sql) => Promise.resolve(executed.push(sql)) });
    expect(executed).toHaveLength(2);
    for (const seeded of SEED_TABLES) expect(executed[0]).not.toContain(`"${seeded}"`);
    expect(executed[0]).toContain('"sessions"');
    expect(DATA_TABLES).toContain('organizations');
  });

  it('rejects empty lists and unsafe identifiers', () => {
    expect(() => truncateStatement([])).toThrow(/at least one table/);
    expect(() => truncateStatements([])).toThrow(/at least one table/);
    expect(() => quoteTableName('sessions; DROP TABLE x')).toThrow(/Invalid table name/);
    expect(() => quoteTableName('Sessions')).toThrow(/Invalid table name/);
  });
});
