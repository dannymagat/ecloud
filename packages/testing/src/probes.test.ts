import { describe, expect, it } from 'vitest';
import { expectDenied, expectNoRows, sqlProbe, type PgQueryable } from './probes.js';

function fake(result: { rows: unknown[]; rowCount: number | null } | Error): PgQueryable & {
  calls: { text: string; values: unknown[] | undefined }[];
} {
  const calls: { text: string; values: unknown[] | undefined }[] = [];
  return {
    calls,
    query(text, values) {
      calls.push({ text, values });
      return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
    },
  };
}

describe('sqlProbe (pg queryable)', () => {
  it('returns rows and row count and passes parameters through', async () => {
    const db = fake({ rows: [{ n: 1 }], rowCount: 1 });
    const probe = await sqlProbe(db, 'SELECT $1::int AS n', [1]);
    expect(probe).toMatchObject({ ok: true, rows: [{ n: 1 }], rowCount: 1, code: undefined });
    expect(db.calls[0]).toEqual({ text: 'SELECT $1::int AS n', values: [1] });
  });

  it('captures the SQLSTATE instead of throwing', async () => {
    const error = Object.assign(new Error('new row violates row-level security policy'), {
      code: '42501',
    });
    const probe = await sqlProbe(fake(error), 'INSERT ...');
    expect(probe).toMatchObject({ ok: false, rows: [], rowCount: 0, code: '42501' });
    expectDenied(probe, /row-level security/);
  });
});

describe('expectNoRows', () => {
  it('accepts empty successful probes and arrays', () => {
    expectNoRows({ ok: true, rows: [], rowCount: 0, code: undefined, message: undefined });
    expectNoRows([]);
  });

  it('rejects rows, affected rows and failures', () => {
    expect(() => expectNoRows([{}])).toThrow();
    expect(() =>
      expectNoRows({ ok: true, rows: [], rowCount: 2, code: undefined, message: undefined }),
    ).toThrow();
    expect(() =>
      expectNoRows({ ok: false, rows: [], rowCount: 0, code: '42501', message: 'denied' }),
    ).toThrow(/expected success/);
  });
});
