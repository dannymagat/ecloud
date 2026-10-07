import { DATA_TABLES } from '@ecloud/db';

export {
  ALL_TABLES,
  DATA_TABLES,
  PARTITIONED_TABLES,
  PLATFORM_TABLES,
  RADIUS_TABLES,
  SEED_TABLES,
  TENANT_SCOPED_TABLES,
} from '@ecloud/db';

/** Minimal query surface shared by `pg.Pool`, `pg.Client` and Kysely-backed wrappers. */
export interface Queryable {
  query(sql: string): Promise<unknown>;
}

/**
 * Tables referenced by a seeded catalogue table (`roles.organization_id -> organizations`).
 * `TRUNCATE ... CASCADE` would truncate the referencing table wholesale and wipe the role
 * templates, so these are emptied with `DELETE` instead: `ON DELETE CASCADE` then removes only
 * the tenant rows and the platform templates (`organization_id IS NULL`) survive.
 */
export const DELETE_INSTEAD_OF_TRUNCATE: readonly string[] = Object.freeze(['organizations']);

const IDENTIFIER_RE = /^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)?$/;

/** Quotes `schema.table` / `table` identifiers after validating them (no user input here). */
export function quoteTableName(name: string): string {
  if (!IDENTIFIER_RE.test(name)) throw new Error(`Invalid table name: ${JSON.stringify(name)}`);
  return name
    .split('.')
    .map((part) => `"${part}"`)
    .join('.');
}

export function truncateStatement(tables: readonly string[]): string {
  if (tables.length === 0) throw new Error('truncateAll requires at least one table');
  return `TRUNCATE TABLE ${tables.map(quoteTableName).join(', ')} RESTART IDENTITY CASCADE`;
}

/** The statements `truncateAll` runs for `tables`, in order. */
export function truncateStatements(tables: readonly string[]): string[] {
  if (tables.length === 0) throw new Error('truncateAll requires at least one table');
  const toTruncate = tables.filter((t) => !DELETE_INSTEAD_OF_TRUNCATE.includes(t));
  const toDelete = tables.filter((t) => DELETE_INSTEAD_OF_TRUNCATE.includes(t));
  const statements: string[] = [];
  if (toTruncate.length > 0) statements.push(truncateStatement(toTruncate));
  for (const table of toDelete) statements.push(`DELETE FROM ${quoteTableName(table)}`);
  return statements;
}

/**
 * Empties the given tables (`TRUNCATE ... RESTART IDENTITY CASCADE`, plus `DELETE` for
 * {@link DELETE_INSTEAD_OF_TRUNCATE}). Defaults to `DATA_TABLES` from @ecloud/db: every
 * application table except the seeded catalogues (`permissions`, `adapter_types`, template
 * `roles` / `role_permissions`), which survive. Must run on the platform (BYPASSRLS, owner)
 * connection.
 */
export async function truncateAll(
  db: Queryable,
  tables: readonly string[] = DATA_TABLES,
): Promise<void> {
  for (const statement of truncateStatements(tables)) await db.query(statement);
}
