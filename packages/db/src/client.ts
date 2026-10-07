import { Kysely, PostgresDialect, type Transaction } from 'kysely';
import pg from 'pg';
import type { Database } from './schema.js';

export type Db = Kysely<Database>;
export type DbTransaction = Transaction<Database>;
/** Either a pooled Kysely instance or a transaction handle: what query code should accept. */
export type DbExecutor = Db | DbTransaction;

export interface PoolOptions {
  /** Max connections in the pool (default 10; api/worker processes stay well under PG's limit). */
  max?: number;
  idleTimeoutMillis?: number;
  connectionTimeoutMillis?: number;
  /** Shown in pg_stat_activity (default `ecloud`). */
  applicationName?: string;
  /** Server-side `statement_timeout` for every connection (default 30 000 ms; 0 disables). */
  statementTimeoutMillis?: number;
}

const INT8_OID = 20;
const DATE_OID = 1082;
let parsersConfigured = false;

/**
 * Driver-wide type parsers (idempotent): int8 -> number, date -> 'YYYY-MM-DD' string.
 * Octet counters exceed 2^53 only beyond ~9 PB, so `number` is exact for ECLOUD's values.
 */
export function configureTypeParsers(): void {
  if (parsersConfigured) return;
  parsersConfigured = true;
  pg.types.setTypeParser(INT8_OID, (value: string) => Number(value));
  pg.types.setTypeParser(DATE_OID, (value: string) => value);
}

export function createPool(url: string, options: PoolOptions = {}): pg.Pool {
  configureTypeParsers();
  const statementTimeout = options.statementTimeoutMillis ?? 30_000;
  return new pg.Pool({
    connectionString: url,
    max: options.max ?? 10,
    idleTimeoutMillis: options.idleTimeoutMillis ?? 30_000,
    connectionTimeoutMillis: options.connectionTimeoutMillis ?? 5_000,
    application_name: options.applicationName ?? 'ecloud',
    ...(statementTimeout > 0 ? { statement_timeout: statementTimeout } : {}),
  });
}

/**
 * Creates a typed Kysely instance. Pass the RLS-enforced `DATABASE_URL` for api/portal and
 * `DATABASE_URL_PLATFORM` for the worker; tenant scoping is applied per transaction by
 * `withTenant()` / `withPlatform()` (tenancy.ts), never by the pool.
 */
export function createDb(urlOrPool: string | pg.Pool, options: PoolOptions = {}): Db {
  const pool = typeof urlOrPool === 'string' ? createPool(urlOrPool, options) : urlOrPool;
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}
