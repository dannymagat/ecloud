import { describe, expect, it } from 'vitest';
import { splitStatements } from './sql.js';

describe('splitStatements', () => {
  it('splits on semicolons and drops empty/comment-only fragments', () => {
    const sql = `-- header
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_a ON a (x);

-- trailing comment only
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_b ON b (y);
`;
    expect(splitStatements(sql)).toEqual([
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_a ON a (x)',
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_b ON b (y)',
    ]);
  });

  it('keeps semicolons inside strings, identifiers, comments and dollar-quoted bodies', () => {
    const sql = `INSERT INTO t (a, "we;ird") VALUES ('x;y', E'a\\';b');
/* block ; comment */ SELECT 1; -- line ; comment
CREATE FUNCTION f() RETURNS void LANGUAGE plpgsql AS $body$
BEGIN
  PERFORM 1; PERFORM 2;
END
$body$;
DO $$ BEGIN RAISE NOTICE 'x;'; END $$`;
    const parts = splitStatements(sql);
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe(`INSERT INTO t (a, "we;ird") VALUES ('x;y', E'a\\';b')`);
    expect(parts[1]).toBe('/* block ; comment */ SELECT 1');
    expect(parts[2]).toContain('PERFORM 1; PERFORM 2;');
    expect(parts[3]).toBe(`DO $$ BEGIN RAISE NOTICE 'x;'; END $$`);
  });

  it('handles doubled single quotes', () => {
    expect(splitStatements(`SELECT 'it''s; fine'; SELECT 2`)).toEqual([
      `SELECT 'it''s; fine'`,
      'SELECT 2',
    ]);
  });
});
