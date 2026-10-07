# @ecloud/db

PostgreSQL 16 schema for ECLOUD: forward-only SQL migrations, the runner CLI, Kysely types and
the tenant-scoping helpers. Implements `DATABASE_DESIGN.md` (Phase 2) and the RLS rules of
`MULTITENANCY.md`. Deviations from the design are listed in `DATABASE_DESIGN.md`
"Implementation notes (Phase 3)".

## Layout

| Path | Purpose |
| --- | --- |
| `migrations/NNN_name.sql` | plain SQL, forward-only; one transaction per file |
| `src/migrate.ts` | runner (discover, status, baseline, run) — port of ezecontroller `src/lib/migrate.ts` |
| `src/cli.ts` | `ecloud-db migrate \| status \| baseline \| seed \| ensure-partitions \| create-platform-admin` |
| `src/schema.ts` | Kysely `Database` interface for every table (public + `radius`) |
| `src/client.ts` | `createPool()` / `createDb()` (pg type parsers, pool defaults) |
| `src/tenancy.ts` | `withTenant()`, `withSite()`, `withPlatform()` |
| `src/seed.ts` | permission catalogue + role templates from `@ecloud/shared` |
| `src/partitions.ts` | monthly partition maintenance |
| `src/admin.ts` | first Platform Super Admin (argon2id) |
| `src/tables.ts` | canonical table lists (`ALL_TABLES`, `TENANT_SCOPED_TABLES`, …) |

## Commands

```bash
npm run build                                   # dist/cli.js
node packages/db/dist/cli.js status             # read-only; exit 2 when not clean
node packages/db/dist/cli.js migrate [--dry-run]
node packages/db/dist/cli.js seed               # idempotent; run after every migrate
node packages/db/dist/cli.js ensure-partitions [--months-ahead 2]
echo -n "$PASSWORD" | node packages/db/dist/cli.js create-platform-admin --email you@example.com --password-stdin
# --url overrides DATABASE_URL_PLATFORM; --dir overrides the migrations directory
```

The CLI connects with `DATABASE_URL_PLATFORM` (BYPASSRLS owner role). It never prints
credentials (`redactUrl`). Deploy sequence: `migrate` → `seed` → start the apps.

## Migration runner

- Files match `^(\d{3,})_([A-Za-z0-9._-]+)\.sql$`; versions must be unique and sort numerically.
- `schema_migrations(name PK, version, checksum, applied_at, applied_by, duration_ms, baselined)`.
- Each file runs in **one transaction** and is recorded in the same transaction; the first
  failure stops the run (nothing after it is attempted).
- Checksums (sha256, LF-normalised) of applied files are verified before every run. Drift or an
  orphan (recorded but no file) is an error and is **never auto-repaired** — fix forward.
- `-- ecloud:no-transaction` in the file header runs the file statement-by-statement outside a
  transaction (for `CREATE INDEX CONCURRENTLY`); it is recorded only after every statement
  succeeded, so such files must be idempotent (`IF NOT EXISTS`). A file containing
  `CONCURRENTLY`/`VACUUM` without the directive is refused.
- A session advisory lock (`pg_advisory_lock(8120371001)`) serialises concurrent runners,
  `seed` and `create-platform-admin`.
- `status` never writes (not even the tracking table); `baseline` records files without running.
- Every file starts with `SET LOCAL lock_timeout = '5s'` (zero-downtime rule, design §9).
- No extensions are required (`gen_random_uuid()` is core; `citext` replaced by `lower()` indexes).

## Row-Level Security design

Three database roles, created out-of-band (dev stack: `infra/compose/postgres-init/01_roles.sql`;
production: deployment step). Migrations never create roles or set passwords.

| Role | Attributes | Used by | Sees |
| --- | --- | --- | --- |
| `ecloud_platform` | owner of all objects, `BYPASSRLS` | migrations, worker, platform admin paths | everything |
| `ecloud_app` | `NOBYPASSRLS`, DML on `public` | api, portal | one tenant per transaction |
| `ecloud_radius` | `NOLOGIN` by default; `INSERT` on `radius.radacct_raw` / `radius.radpostauth_raw`, `SELECT` on `radius.nas_v` | FreeRADIUS `rlm_sql` | nothing in `public` |

Every tenant-scoped table (`TENANT_SCOPED_TABLES`, 31 tables) has:

```sql
ALTER TABLE t ENABLE ROW LEVEL SECURITY;
ALTER TABLE t FORCE ROW LEVEL SECURITY;              -- applies to the owner too (owner bypasses only via BYPASSRLS)
CREATE POLICY tenant_isolation ON t
  USING (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid);
```

- Unset GUC ⇒ predicate is NULL ⇒ **no rows** (fail closed; MULTITENANCY.md T-10). The same
  expression acts as `WITH CHECK`, so inserting or re-parenting a row into another tenant fails
  with SQLSTATE 42501.
- `roles`: tenants read platform templates (`organization_id IS NULL`) plus their own rows, but
  may write only their own (`WITH CHECK organization_id = current org`). `role_permissions`
  follows its role through an `EXISTS` policy.
- Partitions do not inherit policies when addressed directly, so `enable_tenant_rls(regclass)`
  protects the parent and every partition, and `ensure_month_partitions()` re-applies it for new
  partitions. Rows with `organization_id IS NULL` (unresolved tenant in `accounting_records`,
  `auth_events`, platform `audit_logs`) are visible only through the platform role.
- Platform access is a **separate connection** (`DATABASE_URL_PLATFORM`), not a GUC: the design's
  `app.platform_access = 'on'` escape hatch was dropped because a GUC the app role can set is not a
  security boundary. `withPlatform()` refuses to run on a non-BYPASSRLS connection.
- Platform tables without RLS (`PLATFORM_TABLES`): `organizations`, `administrators`,
  `admin_sessions`, `mfa_credentials`, `permissions`, `adapter_types`. Authentication reads
  `administrators`/`admin_sessions` before any tenant is known; `role_bindings` and `api_keys`
  ARE tenant-scoped, so binding resolution for a principal across organizations must use
  `withPlatform(db, { reason: 'authn', audit: false }, …)` (platform bindings have
  `organization_id NULL` and are never visible to `ecloud_app`).

Application usage:

```ts
import { createDb, withTenant, withPlatform } from '@ecloud/db';

const db = createDb(config.database.url);              // ecloud_app
const dbPlatform = createDb(config.database.platformUrl);

await withTenant(db, organizationId, async (trx) => {
  // SET LOCAL app.current_org done; every query here is tenant-scoped
  return trx.selectFrom('users').selectAll().execute();
});

await withPlatform(dbPlatform, { reason: 'nightly reconciliation', actorType: 'system' }, async (trx) => {
  // audited (audit_logs action 'platform:access'); cross-tenant visibility
});
```

`set_config(name, value, true)` is the parameterised equivalent of `SET LOCAL`; the value never
survives the transaction, which keeps pooled connections and PgBouncer transaction mode safe.

### Append-only tables

`accounting_records`, `auth_events`, `audit_logs`, `portal_login_attempts`, `policy_translations`,
`webhook_deliveries` are monthly `RANGE` partitions with a `DEFAULT` partition for late rows:

1. `ecloud_app` has `INSERT, SELECT` only (UPDATE/DELETE/TRUNCATE revoked);
2. a `BEFORE UPDATE OR DELETE` trigger (`forbid_mutation()`) raises for every role, owner included;
3. retention = `DETACH PARTITION` + `DROP` by the platform role (D-025 defaults: raw accounting
   13 months, audit 24 months, others 90 days / 30 days).

`ensure_month_partitions(table regclass, months_ahead int)` creates
`<table>_yYYYYmMM` partitions (UTC bounds) for the current month and `months_ahead` months;
migrations create 2 months ahead, and `ecloud-db ensure-partitions` (cron / worker scheduler)
keeps that horizon. PG16 does not support identity columns on partitioned tables, so these use
explicit sequences (`<table>_id_seq`).

### `radius` schema

`radius.radacct_raw` is the insert-only staging table FreeRADIUS writes through `rlm_sql`
(AAA_ARCHITECTURE.md §5): official `radacct` column names + `acctstatustype`, `nasidentifier`,
`eventtimestamp`, `acctdelaytime`, `received_at`; unique key
`(acctuniqueid, acctstatustype, acctsessiontime, acctinputoctets, acctoutputoctets)` makes NAS
retransmits a no-op. A worker drains it by `radacctid` watermark into `accounting_records` /
`sessions` and deletes drained rows after 7 days. `radius.radpostauth_raw` has no password
column on purpose. `radius.nas` + view `radius.nas_v` carry the official `nas` shape for a future
`rlm_sql read_clients` setup; the pilot renders `clients.conf` instead and leaves them empty.

## Seeds

- `permissions` and the six role templates (`roles.is_template = true, organization_id NULL`,
  `role_permissions`) are generated **at runtime** by `ecloud-db seed` from
  `@ecloud/shared` (`PERMISSION_CATALOGUE`, 98 keys; `ROLE_TEMPLATES`). One source of truth,
  no generated file to drift: `seed` upserts keys, re-syncs every template's permission set,
  bumps `roles.template_version` when a template changed, and reports (never deletes) keys that
  exist in the database but not in the catalogue. Tenant roles copied from a template are not
  touched (copy-on-write).
- `adapter_types` (migration 011): the four keys of the design, `verification_status = 'unknown'`,
  capability flags `NULL` until evidence exists (D-028, D-034).
- The first Platform Super Admin is **not** a seed: `create-platform-admin --email … --password-stdin`
  (argon2id m=19456 KiB, t=2, p=1 via `ARGON2_MEMORY_KIB`; min 12 characters; refuses an existing
  email). No default credentials exist anywhere.

## Testing

- Unit: `npx vitest run --project db` (runner, splitter, seed, table catalogue; no database).
- Integration (`src/integration.test.ts`, `describeIntegration`): needs
  `ECLOUD_TEST_DATABASE_URL` (platform role on `ecloud_test`) and connects as `ecloud_app` via
  `getTestAppDatabaseUrl()` (`ECLOUD_TEST_APP_DATABASE_URL`, or the same URL with user
  `ecloud_app`). It resets the test database, runs the full chain, seeds, and asserts RLS,
  FORCE on owner, partition routing, uniqueness, grants and bootstrap.
- `@ecloud/testing` exports `migrateTestDatabase()` (once per process, advisory-locked across
  workers) and the table lists; `truncateAll()` defaults to `DATA_TABLES`.

## Database prerequisites not handled by migrations

- Roles `ecloud_platform` (owner, BYPASSRLS), `ecloud_app`, optionally `ecloud_radius`.
- The migration role needs `CREATE` on the database (for `CREATE SCHEMA radius`). The dev init
  script grants it only on `ecloud_test` (owner); on the `ecloud` database run once as superuser:
  `GRANT CREATE ON DATABASE ecloud TO ecloud_platform;`
- Grants to `ecloud_app`/`ecloud_radius` are applied only if the role exists at migration time;
  re-run migration 010's grant block manually when adding a role afterwards.
