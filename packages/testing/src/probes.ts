import { sql, type QueryExecutorProvider } from 'kysely';
import { expect } from 'vitest';

/** `pg.Pool`, `pg.Client` and `pg.PoolClient` all satisfy this. */
export interface PgQueryable {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }>;
}

/** A Kysely instance or transaction handle (any database type). */
export type KyselyExecutor = QueryExecutorProvider;

/**
 * Outcome of one SQL statement that is allowed to fail. Isolation and security tests assert on
 * the SQLSTATE instead of letting the error escape, e.g. `42501` for an RLS `WITH CHECK`
 * violation or a missing privilege.
 */
export interface SqlProbeResult<R = Record<string, unknown>> {
  ok: boolean;
  rows: R[];
  /** Rows returned or affected (`0` when the statement failed). */
  rowCount: number;
  /** SQLSTATE of the error (`undefined` when `ok`). */
  code: string | undefined;
  /** Error message (`undefined` when `ok`). */
  message: string | undefined;
}

function isPgQueryable(value: unknown): value is PgQueryable {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { query?: unknown }).query === 'function' &&
    typeof (value as { getExecutor?: unknown }).getExecutor !== 'function'
  );
}

/** Turns `$1`-style SQL text into a Kysely raw builder with bound (never inlined) parameters. */
function toKyselyQuery(text: string, values: readonly unknown[]) {
  const parts = text.split(/\$(\d+)/);
  const strings: string[] = [];
  const params: unknown[] = [];
  for (let i = 0; i < parts.length; i += 1) {
    if (i % 2 === 0) {
      strings.push(parts[i] ?? '');
    } else {
      const index = Number(parts[i]) - 1;
      if (index < 0 || index >= values.length) {
        throw new Error(`sqlProbe: placeholder $${String(index + 1)} has no value`);
      }
      params.push(values[index]);
    }
  }
  const template = Object.assign([...strings], { raw: [...strings] }) as TemplateStringsArray;
  return sql<Record<string, unknown>>(template, ...params);
}

/**
 * Runs one statement on a pg connection or a Kysely executor and reports the result or the
 * SQLSTATE instead of throwing. On a Kysely transaction the failed statement aborts the
 * transaction, so probe at most one failing statement per transaction (or end it after).
 */
export async function sqlProbe<R = Record<string, unknown>>(
  db: PgQueryable | KyselyExecutor,
  text: string,
  values: readonly unknown[] = [],
): Promise<SqlProbeResult<R>> {
  try {
    if (isPgQueryable(db)) {
      const result = await db.query(text, [...values]);
      return {
        ok: true,
        rows: result.rows as R[],
        rowCount: result.rowCount ?? result.rows.length,
        code: undefined,
        message: undefined,
      };
    }
    const result = await toKyselyQuery(text, values).execute(db);
    const affected = result.numAffectedRows;
    return {
      ok: true,
      rows: result.rows as R[],
      rowCount: affected !== undefined ? Number(affected) : result.rows.length,
      code: undefined,
      message: undefined,
    };
  } catch (error) {
    const err = error as { code?: unknown; message?: unknown };
    return {
      ok: false,
      rows: [],
      rowCount: 0,
      code: typeof err.code === 'string' ? err.code : undefined,
      message: typeof err.message === 'string' ? err.message : String(error),
    };
  }
}

/**
 * Asserts that a probe (or a plain row array) succeeded and returned / affected no rows.
 * A failed probe is NOT "no rows": a permission error must be asserted explicitly.
 */
export function expectNoRows(
  result: SqlProbeResult<unknown> | readonly unknown[],
  context = 'query',
): void {
  if (Array.isArray(result)) {
    expect(result, `${context}: expected no rows`).toHaveLength(0);
    return;
  }
  const probe = result as SqlProbeResult<unknown>;
  expect(
    probe.ok,
    `${context}: expected success, got ${probe.code ?? '?'} ${probe.message ?? ''}`,
  ).toBe(true);
  expect(probe.rows, `${context}: expected no rows`).toHaveLength(0);
  expect(probe.rowCount, `${context}: expected no affected rows`).toBe(0);
}

/** SQLSTATE `insufficient_privilege`: RLS WITH CHECK failures, missing grants, append-only triggers. */
export const SQLSTATE_INSUFFICIENT_PRIVILEGE = '42501';

/** Asserts a probe failed with `42501`, optionally matching the message. */
export function expectDenied(
  result: SqlProbeResult<unknown>,
  messagePattern?: RegExp,
  context = 'statement',
): void {
  expect(result.ok, `${context}: expected a denial but the statement succeeded`).toBe(false);
  expect(result.code, `${context}: ${result.message ?? ''}`).toBe(SQLSTATE_INSUFFICIENT_PRIVILEGE);
  if (messagePattern !== undefined) expect(result.message ?? '').toMatch(messagePattern);
}
