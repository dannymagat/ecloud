# ECLOUD — Development Guide

Phase 3 foundation, **LOCAL development only** (DECISIONS.md D-031: nothing here is deployed
to the VPS without a separate, explicit owner approval).

## Prerequisites

| Tool            | Version                      | Notes                                                   |
| --------------- | ---------------------------- | ------------------------------------------------------- |
| Node.js         | 22 LTS (`.nvmrc`)            | `nvm use` picks it up                                   |
| npm             | 10.x (bundled with Node 22)  | npm workspaces; pnpm/yarn are not used                  |
| Docker Desktop  | any recent, with Compose v2  | Optional: only for the dev stack and integration tests  |

## Install

```bash
nvm use
npm install          # installs every workspace (packages/*, apps/*)
npm run build        # tsc -b: builds all packages in dependency order into dist/
```

`npm run build` must run once before `npm run lint` / `npm run typecheck`, because workspaces
resolve each other's types from `dist/`. Unit tests do not need a build: Vitest aliases
`@ecloud/*` to the TypeScript sources (see `vitest.config.ts`).

## Environment

```bash
cp .env.example .env   # edit as needed; .env is gitignored
```

Every variable is declared and validated in `packages/shared/src/config.ts` (`loadConfig()`).
Development defaults exist for all variables; they are **rejected** when `NODE_ENV=production`.
Never print a config object directly — use `redactConfig()`.

## Dev stack (PostgreSQL 16 + Redis 7)

```bash
npm run dev:stack         # docker compose up -d --wait (ports 127.0.0.1:5432 / :6379)
npm run dev:stack:down    # stop
npm run dev:stack:reset   # stop and drop the postgres volume
```

`infra/compose/docker-compose.dev.yml` is **DEV ONLY**. On first start it runs
`infra/compose/postgres-init/01_roles.sql`, creating:

- `ecloud_app` — `NOSUPERUSER NOBYPASSRLS`, used by api/portal under Row-Level Security;
- `ecloud_platform` — `BYPASSRLS`, used by the worker and migrations;
- database `ecloud_test` for integration tests.

Passwords come from `.env` (`ECLOUD_APP_PASSWORD`, `ECLOUD_PLATFORM_PASSWORD`,
`POSTGRES_PASSWORD`) and default to `ecloud_dev_password`.

## Database (`@ecloud/db`)

All schema change is plain, forward-only SQL in `packages/db/migrations/NNN_name.sql`, applied by
the `ecloud-db` runner (`packages/db/src/cli.ts`; design in `packages/db/README.md`). The runner
connects with `DATABASE_URL_PLATFORM` (BYPASSRLS owner role) — never with the app role.

```bash
npm run build                                       # produces packages/db/dist/cli.js
node packages/db/dist/cli.js status                 # read-only; exit 0 clean, 2 pending/drift
npm run db:migrate                                  # = node packages/db/dist/cli.js migrate
node packages/db/dist/cli.js migrate --dry-run
node packages/db/dist/cli.js seed                   # permission catalogue + 6 role templates
node packages/db/dist/cli.js ensure-partitions      # monthly partitions, 2 months ahead
printf '%s' "$ADMIN_PASSWORD" | node packages/db/dist/cli.js create-platform-admin \
  --email you@example.com --password-stdin --display-name "You"
```

Rules of the runner: one transaction per file; applied files are checksummed and any edit is a
hard error (fix forward with a new file); `-- ecloud:no-transaction` in the header runs a file
statement-by-statement for `CREATE INDEX CONCURRENTLY`; an advisory lock serialises concurrent
runners. `baseline` records files as applied without executing them (adopting an existing DB).

Order on every deploy and after every pull: `migrate` → `seed` → start apps. `seed` is
idempotent and regenerates `permissions` / template `roles` from `@ecloud/shared`
(`PERMISSION_CATALOGUE`, 98 keys; `ROLE_TEMPLATES`) so the catalogue has one source of truth.

### Dev database prerequisites

`infra/compose/postgres-init/01_roles.sql` creates `ecloud_app` and `ecloud_platform` and the
`ecloud_test` database (owned by `ecloud_platform`). Two things the init script does not do yet
and that migrations cannot do (the migration role has neither `CREATEROLE` nor `CREATE` on the
`ecloud` database):

```sql
-- as the postgres superuser of the dev stack (docker exec -it ecloud-dev-postgres psql -U ecloud):
GRANT CREATE ON DATABASE ecloud TO ecloud_platform;      -- needed for CREATE SCHEMA radius
CREATE ROLE ecloud_radius NOLOGIN NOBYPASSRLS;           -- optional: FreeRADIUS rlm_sql role (M6)
```

Migration 010 grants `ecloud_app` DML on `public` (INSERT/SELECT only on append-only tables) and
`ecloud_radius` INSERT on `radius.radacct_raw` / `radius.radpostauth_raw` + SELECT on
`radius.nas_v`, but only if the role exists when the migration runs. Passwords are never set by
migrations (D-033).

### Roles and Row-Level Security

| Role | Connection | Behaviour |
| --- | --- | --- |
| `ecloud_platform` | `DATABASE_URL_PLATFORM` | owner, BYPASSRLS: migrations, worker, `withPlatform()` (audited) |
| `ecloud_app` | `DATABASE_URL` | FORCE RLS on all 31 tenant-scoped tables; rows visible only inside `withTenant(db, orgId, fn)` which does `SET LOCAL app.current_org`; outside a tenant transaction every tenant table returns 0 rows |
| `ecloud_radius` | FreeRADIUS only | sees only the `radius` schema, insert-only |

Query code receives a `trx` from `withTenant()` / `withPlatform()` (`@ecloud/db`); never run
tenant queries on the bare pool.

### Partitions and retention

`accounting_records`, `auth_events`, `audit_logs`, `portal_login_attempts`, `policy_translations`
and `webhook_deliveries` are monthly RANGE partitions (`<table>_yYYYYmMM` + `<table>_default`),
INSERT/SELECT only (trigger + grants). Run `ecloud-db ensure-partitions` from cron / the worker
scheduler before the month rolls; retention is `DETACH PARTITION` + `DROP` by the platform role.

## API (`@ecloud/api`)

Express 5 modular monolith with two listeners (details: `API_ARCHITECTURE.md` "Implementation
notes (Phase 3)"):

| Listener | Port (env) | Bind (env) | Serves |
| --- | --- | --- | --- |
| public | `API_PORT` (3000) | `API_BIND_HOST` (0.0.0.0) | `/api/v1/*`, `/healthz`, `/readyz`, `/api/v1/openapi.json` |
| internal | `INTERNAL_PORT` (3001) | `INTERNAL_BIND_HOST` (127.0.0.1) | `/internal/aaa/authorize`, `/internal/aaa/post-auth` (`X-Internal-Token`) |

```bash
npm run build
node packages/db/dist/cli.js migrate && node packages/db/dist/cli.js seed   # once per DB
# first Platform Super Admin — throw-away password typed/generated in the shell, never in a file
read -rs PW && printf '%s' "$PW" | node packages/db/dist/cli.js create-platform-admin --email you@example.com --password-stdin; unset PW
node apps/api/dist/main.js                 # or: npm run dev --workspace @ecloud/api (tsx watch)
curl -s localhost:3000/readyz              # {"status":"ok",...,"checks":{"database":"ok","redis":"ok"}}
# login from a shell must imitate the admin SPA (CSRF): Origin = PUBLIC_ADMIN_ORIGIN + X-Requested-With
curl -c /tmp/c -H 'Content-Type: application/json' -H 'Origin: http://localhost:5173' \
  -H 'X-Requested-With: XMLHttpRequest' -d '{"email":"you@example.com","password":"…"}' \
  localhost:3000/api/v1/auth/login
curl -b /tmp/c localhost:3000/api/v1/auth/me
```

API-only environment variables (validated in `apps/api/src/config.ts`; dev defaults are fake and
rejected when `NODE_ENV=production`): `MFA_ENCRYPTION_KEY`, `DATA_ENCRYPTION_KEY` (NAS secrets),
`VOUCHER_PEPPER`, `SESSION_IDLE_SECONDS`, `SESSION_COOKIE_SECURE`, `TRUST_PROXY_HOPS`,
`API_BIND_HOST`, `INTERNAL_BIND_HOST`, `KV_DRIVER` (`redis`|`memory`), `IMPERSONATION_ROLE_TEMPLATE`,
`AAA_INTERIM_INTERVAL_S`, `SHUTDOWN_GRACE_MS`, `RATE_LIMIT_DISABLED` (tests only).

Tests: `npx vitest run --project api` (unit: supertest with an in-memory KV and a database
handle on a closed port — exercises the 503 / fail-closed paths); with
`ECLOUD_TEST_DATABASE_URL` set, `src/integration.test.ts` runs against `ecloud_test` (RLS app role
+ platform role) and creates its own organizations instead of truncating.

## Worker (`@ecloud/worker`)

BullMQ workers + job schedulers on Redis (queue prefix `ecloud`), writing through the platform
connection (`DATABASE_URL_PLATFORM`, every write inside `withPlatform(…, 'worker:<job>')`).

```bash
npm run build                                   # or: npx tsc -b apps/worker/tsconfig.build.json
node apps/worker/dist/main.js                   # needs the dev stack; Ctrl-C / SIGTERM = graceful stop
curl -s http://127.0.0.1:3003/healthz           # {"status":"ok","checks":{"redis":"ok","database":"ok"},…}
npm run dev --workspace @ecloud/worker          # tsx watch
```

| Queue | Cadence | Work |
| --- | --- | --- |
| `accounting.drain` | every 5 s, single-flight Redis lock | `radius.radacct_raw` past the Redis cursor (`ecloud:worker:cursor:radacct_raw`) → `accounting_records`, `sessions`, `usage_counters` (daily/monthly in the site timezone + total), outbox `session.*`; then quota check of touched sessions |
| `policy.enforce` | every 30 s | quota re-evaluation of active policy-bound sessions; breach → `quota.exceeded` + Disconnect only when allowed (below) |
| `sessions.reap` | every 60 s | no accounting for > 2 × `WORKER_INTERIM_INTERVAL_S` + `WORKER_REAP_GRACE_S` → `stopped` / `lost_interim` |
| `outbox.publish` | every 2 s | outbox → `webhooks.deliver` jobs (HMAC `X-ECLOUD-Signature`, 8 attempts, DLQ `dead.webhooks`) |
| `partitions.ensure` | daily 00:10 UTC | monthly partitions 2 months ahead |
| `retention.prune` | daily 03:30 UTC | D-025: raw 7 d, accounting 13 mo, audit 24 mo — **dry-run** unless `RETENTION_APPLY=true` |
| `coa.disconnect`, `coa.change` | on demand (`coa-<session_action_id>`) | radclient Disconnect / CoA; 3 attempts fixed 5 s, DLQ `dead.coa` |

Worker-only environment (read by `apps/worker/src/config.ts`, not yet in the shared schema):

| Variable | Default | Meaning |
| --- | --- | --- |
| `WORKER_HEALTH_PORT` / `WORKER_HEALTH_HOST` | `3003` / `127.0.0.1` | `/healthz` listener |
| `ECLOUD_COA_ENABLED` | `false` | D-006: Disconnect/CoA are REQUIRES_DEVICE_TEST. While false nothing is sent; queued actions are recorded `unsupported` + `error = skipped_disabled`. Set `true` only in a device-test lab |
| `RADCLIENT_PATH`, `RADCLIENT_TIMEOUT_S`, `RADCLIENT_RETRIES` | `radclient`, `2`, `3` | the secret is passed with `-S <0600 temp file>`, never on argv |
| `RETENTION_APPLY` | `false` | drop old partitions / raw rows instead of logging the plan |
| `WORKER_INTERIM_INTERVAL_S`, `WORKER_REAP_GRACE_S` | `600`, `120` | reaper threshold |
| `WORKER_DRAIN_BATCH` | `500` | raw rows per drain tick |

NAS / webhook secrets are resolved at use time from `secret_ref` values `env:<VAR>` or
`file:/absolute/path`; other schemes (the future encrypted `secret_blobs`) resolve to nothing and
the action is recorded as `unsupported`.

The drain cursor lives in Redis. To replay accounting on a dev stack:
`docker exec ecloud-dev-redis redis-cli DEL ecloud:worker:cursor:radacct_raw` (re-processing is
idempotent: rows already normalised are skipped by `accounting_records.raw->>'radacctid'`).

Integration tests: `apps/worker/src/integration.test.ts` (needs `ECLOUD_TEST_DATABASE_URL`;
the Redis case also `ECLOUD_TEST_REDIS_URL`):

```bash
ECLOUD_TEST_REQUIRE_INTEGRATION=1 npx vitest run --project worker
```

## Tests

```bash
npm test                  # vitest run — all unit tests; integration suites skip cleanly
npm run test:watch
npm run test:coverage     # @vitest/coverage-v8 -> coverage/
npm run test:integration  # ECLOUD_TEST_REQUIRE_INTEGRATION=1: integration suites must run
```

Integration tests use `describeIntegration()` from `@ecloud/testing`:

```ts
import { describeIntegration } from '@ecloud/testing';

await describeIntegration('sessions repository', () => {
  /* it(...) blocks that need Postgres */
});
```

The suite runs only when `ECLOUD_TEST_DATABASE_URL` is set **and** the database host accepts
a TCP connection within 500 ms; otherwise it is registered as skipped with the reason in the
suite name. With `ECLOUD_TEST_REQUIRE_INTEGRATION=1` (CI integration job) an unreachable
database is a failure, never a silent skip.

```bash
export ECLOUD_TEST_DATABASE_URL=postgres://ecloud_platform:ecloud_dev_password@127.0.0.1:5432/ecloud_test
export ECLOUD_TEST_REDIS_URL=redis://127.0.0.1:6379/1
npm run test:integration
```

Suites that need the schema call `await migrateTestDatabase()` (from `@ecloud/testing`) in
`beforeAll`: it runs all migrations + `seed` once per process (advisory-locked across workers).
RLS assertions connect as `ecloud_app` through `getTestAppDatabaseUrl()` — by default the same
URL with the user replaced by `ecloud_app` (override with `ECLOUD_TEST_APP_DATABASE_URL`).
`truncateAll(pool)` defaults to `DATA_TABLES` (everything except the seeded catalogues).

## Lint, format, typecheck

```bash
npm run lint              # ESLint 9 flat config, typescript-eslint recommended-type-checked
npm run lint:fix
npm run format            # prettier --write .
npm run format:check      # CI runs this
npm run typecheck         # tsc -b + per-workspace `tsc --noEmit` (includes test files)
```

## Repository layout

```
package.json              npm workspaces root; scripts above
tsconfig.base.json        strict, ES2022, NodeNext ESM, composite project references
tsconfig.json             solution file: references every workspace's tsconfig.build.json
eslint.config.js          ESLint 9 flat config
vitest.config.ts          root Vitest config (projects + @ecloud/* source aliases)
vitest.workspace.ts       enumerates the workspaces as Vitest projects
apps/api                  Express 5 REST API (/api/v1) + internal listener
apps/worker               BullMQ workers and schedulers
apps/portal               captive portal server (skeleton in Phase 3)
packages/shared           config, errors (RFC 9457), ids (uuidv7), logger (pino), permission
                          catalogue + role templates, AdapterFieldStatus, tenancy types
packages/db               SQL migrations, runner CLI, Kysely types, RLS helpers
packages/policy-engine    policy intent model, validation, resolution, translation
packages/adapters         NasAdapter interface, capability declarations, reply emitters
packages/testing          describeIntegration(), truncateAll(), fixture factories
infra/compose             DEV ONLY docker-compose + postgres init SQL
infra/freeradius          (M6) rendered raddb templates
docs/                     this guide and further developer docs
.github/workflows/ci.yml  build, lint, format, unit tests; integration job with pg16 + redis7
```

Each workspace has:

- `package.json` — `@ecloud/<name>`, ESM, `exports` pointing at `dist/`;
- `tsconfig.json` — editor/lint/typecheck config (sources **and** tests, `noEmit`);
- `tsconfig.build.json` — composite build (sources only) with `references` to its dependencies;
- `src/index.ts` — barrel; tests live next to the code as `src/**/*.test.ts`.

Adding a workspace: create the folder with the three files above, add its
`tsconfig.build.json` to the root `tsconfig.json` `references`, run `npm install`.

## Conventions (summary — see the architecture docs for detail)

- TypeScript strict, ESM only, relative imports end in `.js`, `import type` for types.
- Ids are UUID v7 generated in the application (`newId()`); never DB-generated.
- Errors thrown across layers extend `AppError`; HTTP responses are `application/problem+json`.
- Permissions are `resource:action` strings from `PERMISSION_CATALOGUE`; authorization code
  never compares role names (D-017, D-021).
- Every adapter capability is one of `VERIFIED_SUPPORTED | REQUIRES_DEVICE_TEST | UNSUPPORTED |
  ECLOUD_SIDE_ONLY` with an `evidence` citation (D-028). No device capability is ever assumed.
- Time is stored in UTC; schedules use the site's IANA timezone.
- Logging via `createLogger()` only; `password`, `secret`, `token`, `authorization` and
  `cookie` fields are redacted automatically.
- No `git commit` / `git push` by specialist agents; the orchestrator owns commits.

## No secrets rule (D-033)

Nothing secret is ever committed: no RADIUS shared secrets, WireGuard keys, database or
OAuth passwords, API tokens or SSH keys. `.env.example` holds names and placeholders only;
`.env*` (except `.env.example`) is gitignored; the dev stack uses obviously fake defaults
(`ecloud_dev_password`). Production receives secrets through environment injection or
`*_FILE` secret references. If you need a new secret, add its **name** to
`packages/shared/src/config.ts` and `.env.example`, and mark it as a secret in `redactConfig()`.
