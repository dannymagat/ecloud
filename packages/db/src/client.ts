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
  /**
   * Called when an IDLE pooled client errors (server restart, `pg_terminate_backend`, network
   * drop). The pool discards that client and reconnects on the next query; the error is never
   * rethrown (default: ignored). Callers may pass a logger here.
   */
  onIdleError?: (error: Error) => void;
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
  const pool = new pg.Pool({
    connectionString: url,
    max: options.max ?? 10,
    idleTimeoutMillis: options.idleTimeoutMillis ?? 30_000,
    connectionTimeoutMillis: options.connectionTimeoutMillis ?? 5_000,
    application_name: options.applicationName ?? 'ecloud',
    ...(statementTimeout > 0 ? { statement_timeout: statementTimeout } : {}),
  });
  // P10-B failure drill: without a listener, an idle client's error (e.g. "terminating
  // connection due to administrator command" when PostgreSQL restarts) is an unhandled 'error'
  // event that crashes the whole api/worker process. node-postgres removes the broken client
  // itself; requests in flight fail and are answered fail-closed (503) by the callers.
  // Default: one stderr line (never silent); api/worker pass their structured logger instead.
  const onIdleError =
    options.onIdleError ??
    ((error: Error) => {
      process.stderr.write(
        `postgres idle connection lost (${error.message}); pool will reconnect\n`,
      );
    });
  pool.on('error', (error: Error) => {
    onIdleError(error);
  });
  return pool;
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
