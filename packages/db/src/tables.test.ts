import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_MIGRATIONS_DIR } from './migrate.js';
import {
  ALL_TABLES,
  APPEND_ONLY_TABLES,
  DATA_TABLES,
  PARTITIONED_TABLES,
  PLATFORM_TABLES,
  RADIUS_TABLES,
  SEED_TABLES,
  TENANT_SCOPED_TABLES,
} from './tables.js';

function allMigrationSql(): string {
  return readdirSync(DEFAULT_MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .map((f) => readFileSync(join(DEFAULT_MIGRATIONS_DIR, f), 'utf8'))
    .join('\n');
}

describe('table catalogue', () => {
  const sql = allMigrationSql();

  it('lists every CREATE TABLE in public exactly once (partitions excluded)', () => {
    const created = [...sql.matchAll(/^CREATE TABLE (?!radius\.)([a-z_]+) \(/gm)].map((m) => m[1]);
    expect([...created].sort()).toEqual([...ALL_TABLES].sort());
    expect(new Set(ALL_TABLES).size).toBe(ALL_TABLES.length);
    expect(ALL_TABLES).toHaveLength(47); // + 019: 4 registry-mirror tables, controllers; + 021: portal_assets, portal_terms_versions; + 023: session_enforcement, accounting_anomalies; + 026: usage_hourly
  });

  it('lists every radius table', () => {
    const created = [...sql.matchAll(/^CREATE TABLE (radius\.[a-z_]+) \(/gm)].map((m) => m[1]);
    expect([...created].sort()).toEqual([...RADIUS_TABLES].sort());
  });

  it('partitions the tables the design marks append-only and only those', () => {
    const partitioned = sql
      .split(/^CREATE TABLE /m)
      .slice(1)
      .filter((chunk) => /^\) PARTITION BY RANGE/m.test(chunk))
      .map((chunk) => chunk.split(' ')[0]);
    expect([...partitioned].sort()).toEqual([...PARTITIONED_TABLES].sort());
    expect(APPEND_ONLY_TABLES).toBe(PARTITIONED_TABLES);
    for (const t of PARTITIONED_TABLES) {
      expect(sql).toContain(`SELECT ensure_month_partitions('${t}'::regclass, 2);`);
      expect(sql).toContain(`CREATE TABLE ${t}_default PARTITION OF ${t} DEFAULT;`);
    }
  });

  it('RLS list matches the migration and complements the platform list', () => {
    for (const t of TENANT_SCOPED_TABLES) {
      expect(sql, t).toMatch(new RegExp(`'${t}'|ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`));
    }
    const tenant = new Set<string>(TENANT_SCOPED_TABLES);
    expect(PLATFORM_TABLES.every((t) => !tenant.has(t))).toBe(true);
    expect(PLATFORM_TABLES.length + TENANT_SCOPED_TABLES.length).toBe(ALL_TABLES.length);
    expect([...PLATFORM_TABLES].sort()).toEqual(
      [
        'organizations',
        'administrators',
        'admin_sessions',
        'mfa_credentials',
        'permissions',
        'adapter_types',
        'vendors',
        'hardware_models',
        'firmware_versions',
        'compatibility_entries',
      ].sort(),
    );
  });

  it('DATA_TABLES excludes exactly the seeded catalogues', () => {
    expect(DATA_TABLES.length + SEED_TABLES.length).toBe(ALL_TABLES.length);
    for (const t of SEED_TABLES) expect(DATA_TABLES).not.toContain(t);
  });
});
