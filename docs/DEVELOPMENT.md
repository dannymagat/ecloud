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
| `ecloud_app` | `DATABASE_URL` | FORCE RLS on all 32 tenant-scoped tables; rows visible only inside `withTenant(db, orgId, fn)` which does `SET LOCAL app.current_org`; outside a tenant transaction every tenant table returns 0 rows |
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
rejected when `NODE_ENV=production`): `ADMIN_MFA_MODE` (`off` default | `required`, D-046: `off` = password-only sign-in and one-click NAS secret reveal; the API test suites pin `required`), `MFA_ENCRYPTION_KEY`, `DATA_ENCRYPTION_KEY` (NAS secrets),
`VOUCHER_PEPPER`, `SESSION_IDLE_SECONDS`, `SESSION_COOKIE_SECURE`, `TRUST_PROXY_HOPS`,
`API_BIND_HOST`, `INTERNAL_BIND_HOST`, `KV_DRIVER` (`redis`|`memory`), `IMPERSONATION_ROLE_TEMPLATE`,
`AAA_INTERIM_INTERVAL_S`, `AAA_SESSION_TIMEOUT_CAP_S` (Q44, default 1800 s, 0 = off, else ≥ 300; P7-A),
`ENFORCEMENT_MAX_SESSIONS` (sessions re-resolved per policy change, default 2000; the rest are recorded unevaluated),
`ECLOUD_COA_ENABLED` (read only to choose the enforcement strategy; default false, D-006),
`SHUTDOWN_GRACE_MS`, `RATE_LIMIT_DISABLED` (tests only).

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
| `policy.enforce` | every 30 s | quota re-evaluation of active policy-bound sessions; breach → `quota.exceeded` + `session_enforcement` pending `next_reauth` (+ Disconnect only when allowed, below); then schedule end and late concurrency (P7-A) and pending rows of ended sessions → `applied` |
| `sessions.reap` | every 60 s | no accounting for > 2 × `WORKER_INTERIM_INTERVAL_S` + `WORKER_REAP_GRACE_S` → `stopped` / `lost_interim`; `authorized` sessions (D-036) without accounting for > `WORKER_AUTHORIZATION_TTL_S` → `expired` / `authorization_expired` |
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
| `WORKER_AUTHORIZATION_TTL_S` | `300` | D-036: unpromoted authorization expiry (30–86400) |
| `WORKER_DRAIN_BATCH` | `500` | raw rows per drain tick |
| `WORKER_COUNTER_WRAP_MAX_BPS` | `1000000000` | P7-A 32-bit wrap correction, rule W4: plausibility ceiling per counter direction (bit/s); an operator assumption, not a device fact |
| `MERAKI_CLOUD_RADIUS_ENABLED` | `false` | Cycle E (D-044): Cisco Meraki cloud-sourced RADIUS. Read identically by the API, the worker and the FreeRADIUS renderer. While false no Meraki listener is rendered, AAA refuses Meraki NAS, the portal refuses Meraki flows and no Meraki Disconnect is sent. Build/test only (D-043: no public RADIUS) |
| `MERAKI_RADIUS_SOURCE_CIDRS` | (empty) | Meraki Cloud source ranges (public IPv4 /16–/32, comma list) from Dashboard *Help > Firewall info*; empty = nothing rendered. REQUIRES_CLARIFICATION |
| `MERAKI_RADIUS_PORT_RANGE` | (unset) | `min-max` UDP range for the per-NAS listener pairs (even auth port, acct = auth + 1, ≤ 4096 pairs, not overlapping 1812/1813). REQUIRES_CLARIFICATION |
| `RADIUS_ADVERTISED_ADDRESS` | (unset) | Cycle F: the RADIUS address (IP or host name) the setup-guide gallery tells access points to use; unset = the guides keep `<ECLOUD_RADIUS_ADDRESS>` and warn. vps-local: `ECLOUD_LAN_IP` |
| `RADIUS_ADVERTISED_AUTH_PORT` / `RADIUS_ADVERTISED_ACCT_PORT` | `1812` / `1813` | Cycle F: RADIUS ports shown in the setup guides |
| `MERAKI_MAX_NAS_PER_ORG` | `50` | API: live Meraki NAS per organization (each opens a public listener pair) |
| `MERAKI_ALLOW_RELAXED_MSGAUTH` | `false` | API + renderer: allow a Meraki NAS without Message-Authenticator (BlastRADIUS) |
| `RADIUS_SCHEMA_WAIT_S` / `RADIUS_SCHEMA_CHECK` | `60` / `1` | FreeRADIUS entrypoint: wait for / skip the migration-032 schema check (skip only without a database) |
| `MERAKI_RADIUS_FILE` | `/var/lib/ecloud/radius-meraki/ecloud-meraki.conf` | renderer only: Meraki listener file, mounted over FreeRADIUS `meraki.d/` |

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

## Admin app (`@ecloud/admin`)

Single-build React SPA (Vite + React 19 + TypeScript strict + Tailwind 3 + TanStack Query +
React Router; ADMIN_UI_ARCHITECTURE.md §1). It calls the same-origin `/api/v1` with the
HttpOnly session cookie (D-029); every request sends `X-Requested-With`, every POST an
`Idempotency-Key`. Fonts (Inter, `@fontsource-variable`) and icons (`lucide-react`) are bundled;
nothing loads from a CDN.

```bash
# terminal 1: API (PUBLIC_ADMIN_ORIGIN must equal the Vite origin for the CSRF Origin check)
PUBLIC_ADMIN_ORIGIN=http://localhost:5173 npm run dev -w @ecloud/api
# terminal 2: Vite dev server on http://localhost:5173, proxies /api and /healthz to API_PORT
npm run dev:admin                       # = npm run dev -w @ecloud/admin
# (ADMIN_DEV_API_TARGET=http://host:port overrides the proxy target)

npm run build -w @ecloud/admin          # tsc --noEmit + vite build -> apps/admin/dist (static)
npm test -- --project admin             # Vitest + Testing Library (jsdom)
```

A first platform administrator: `printf '%s\n' "$PW" | node packages/db/dist/cli.js
create-platform-admin --email you@example.com --password-stdin` (never put the password in a
file). Platform-bound accounts must enrol TOTP at first sign-in (the app shows the QR code,
rendered locally with `qrcode`, then the recovery codes once).

**Typed client.** `apps/admin/src/api/schema.d.ts` (openapi-typescript) and
`src/api/openapi.json` are generated and committed:

```bash
npm run build                                   # the generator reads apps/api/dist
npm run generate:api -w @ecloud/admin           # or: ... -- --url http://127.0.0.1:3000/api/v1/openapi.json
```

Regenerate after every API change; `tsc` then flags screens whose paths or bodies no longer
match. List rows are open objects in the API schema, so screens narrow them in `src/api/types.ts`.

**Rules the UI enforces.** Navigation and actions are permission-driven (`can(me, 'nas:create',
{ organizationId })`, mirroring apps/api `evaluate`); no role names are consulted. Adapter field
statuses render through `StatusBadge`, which shows "Verified" only for the exact value
`VERIFIED_SUPPORTED` (D-028). Session Disconnect stays disabled (with the reason as tooltip)
unless the NAS adapter's disconnect status is `VERIFIED_SUPPORTED`, the operator holds
`session:disconnect` and the API exposes a disconnect endpoint. Secrets (NAS secret, API key,
invitation token, recovery codes, voucher codes) are shown once by `SecretOnce` /
`VoucherCodes` and dropped from memory on acknowledgement. Impersonation shows a persistent
banner with reason, countdown and Stop (D-027).

**Production.** Caddy serves `apps/admin/dist` for `ezecloud.ezelink.ai` with an SPA fallback
(`try_files {path} /index.html`) and reverse-proxies `/api/*` to the API (same origin). Source
maps are emitted but not referenced (`sourcemap: 'hidden'`); do not publish `*.map`.

## Container images (M9, LOCAL only)

One multi-target Dockerfile builds every app image; the build context is the repository root
(filtered by the root `.dockerignore`: `node_modules`, `dist`, `coverage`, `.env*`, `.git`,
`*.md`/`docs`, `*.test.ts(x)`, `test-support`, the root `test/` fixtures and the `tests/`
suites are excluded — except `tests/package.json`, which is kept on purpose because `npm ci`
needs every workspace manifest listed in the root lockfile).

| Image (local tag)     | Target   | Base (pinned tag)                           | Port (EXPOSE) | Health probe                         |
| --------------------- | -------- | ------------------------------------------- | ------------- | ------------------------------------ |
| `ecloud-api:local`    | `api`    | `node:22.23.3-bookworm-slim`                | 3000          | `GET /healthz` on `API_PORT`         |
| `ecloud-worker:local` | `worker` | `node:22.23.3-bookworm-slim` + `radclient`  | 3003          | `GET /healthz` on `WORKER_HEALTH_PORT` |
| `ecloud-portal:local` | `portal` | `node:22.23.3-bookworm-slim`                | 3002          | `GET /healthz` on `PORTAL_PORT`      |
| `ecloud-admin:local`  | `admin`  | `nginxinc/nginx-unprivileged:1.28.2-alpine` | 8080          | `GET /healthz` (served by nginx)     |

Files: `infra/docker/Dockerfile` (all targets), `infra/docker/assemble.sh` (collects `dist/` +
`packages/db/migrations` for the runtime stage), `infra/docker/prune-runtime.sh` (drops unbuilt
workspace manifests, dangling `@ecloud/*` links and third-party `*.map` files from the runtime
tree), `infra/docker/admin-nginx.conf` (LOCAL ONLY: SPA fallback, CSP and security headers,
dotfiles denied, `/api/` proxied to the `api` service). The api internal listener (`INTERNAL_PORT` 3001) is not
`EXPOSE`d; Compose publishes it to `127.0.0.1` only (see below).

What the Node images do: `npm ci -w <workspace> --include-workspace-root` against the root
lockfile → `tsc -b apps/<app>/tsconfig.build.json` → a separate `npm ci -w <workspace>
--omit=dev` tree for runtime (no dev dependencies, no npm/corepack in the final image) → user
`node` (uid 1000), `tini` as PID 1, application files owned by root (not writable by the
process). Writable paths needed at run time: `/tmp` and, for the api, `STORAGE_LOCAL_PATH`
(`/var/lib/ecloud/storage`, owned by `node`). The images default to `NODE_ENV=production`, so a
container started without real configuration **refuses to start** (dev defaults are rejected).
A production run must also choose storage explicitly (D-026, `packages/shared` config): either
`STORAGE_LOCAL_ALLOW_PRODUCTION=true` with `STORAGE_DRIVER=local` (pilot, non-critical assets
only) or `STORAGE_DRIVER=s3` with an `https://` `S3_ENDPOINT`. The images deliberately do not
set that opt-in; the dev Compose services (`NODE_ENV=development`) are unaffected.
The admin image deletes Vite's hidden `*.map` files and is for local testing only — production
serves the static build from native Caddy (D-030).

### Build

```bash
REF=$(git rev-parse --short HEAD)
for t in api worker portal admin; do
  docker build -f infra/docker/Dockerfile --target "$t" --build-arg VCS_REF="$REF" -t "ecloud-${t}:local" .
done
docker image ls 'ecloud-*'
```

(zsh: keep the braces in `ecloud-${t}:local` — `$t:l` is a zsh modifier.) On Apple Silicon add
`--platform linux/amd64` to each `docker build` so the images match the amd64 target host
(otherwise you get arm64 images; QEMU emulation makes the build slower). `VCS_REF` only fills
the `org.opencontainers.image.revision` label; never pass secrets as build args.

### Run with the dev stack (Compose profile `app`)

The four services live in `infra/compose/docker-compose.dev.yml` under `profiles: ["app"]`
(plus a one-shot `migrate` service under profile `migrate`), so `npm run dev:stack` is
unchanged. They reach `postgres`/`redis` by service name with the dev-only credentials from
`.env` (defaults `ecloud_dev_password`), run with `NODE_ENV=development`, `read_only: true`,
`tmpfs: /tmp`, `cap_drop: [ALL]`, `no-new-privileges` and the memory/cpu/pids limits of
DEPLOYMENT_ARCHITECTURE.md §2.2.

```bash
C="docker compose --project-directory . -f infra/compose/docker-compose.dev.yml"
VCS_REF=$(git rev-parse --short HEAD) $C --profile app up -d --build --wait api worker portal admin
curl -s http://127.0.0.1:3000/healthz    # api (public listener)
curl -s http://127.0.0.1:3000/readyz     # api readiness (database + redis)
curl -s http://127.0.0.1:3001/healthz    # api internal listener (127.0.0.1 only)
curl -s http://127.0.0.1:3002/healthz    # portal
curl -s http://127.0.0.1:3003/healthz    # worker (database + redis checks, queue names)
curl -s http://127.0.0.1:8080/healthz    # admin static server
open http://localhost:8080/              # admin SPA; /api/ is proxied to the api container
docker exec ecloud-dev-api id            # uid=1000(node)
$C --profile migrate run --rm --no-deps migrate status   # migration status (read-only)
$C --profile migrate run --rm --no-deps migrate          # apply pending migrations
$C --profile app stop api worker portal admin            # stop only the app containers
$C --profile app rm -f api worker portal admin           # remove them (volumes untouched)
```

Naming the four services starts them plus their `depends_on` (postgres, redis) and leaves
`freeradius` untouched; a plain `$C --profile app up -d --wait` also reconciles every other
dev-stack service (it would recreate freeradius if its config drifted). `VCS_REF` only sets
the revision label (default `dev`). Host ports (all `127.0.0.1`): `APP_API_PORT` 3000, `APP_INTERNAL_PORT` 3001,
`APP_PORTAL_PORT` 3002, `APP_WORKER_HEALTH_PORT` 3003, `APP_ADMIN_PORT` 8080 — set them in
`.env` to run the containers next to host-run `npm run dev` processes. The admin origin passed
to the api container is `http://localhost:${APP_ADMIN_PORT}` (CSRF Origin check), so open the
SPA via `localhost`, not `127.0.0.1`. The dev freeradius container already targets
`host.docker.internal:3001`, i.e. the api container's internal listener when it is up.

### Standalone read-only smoke test

```bash
docker run --rm -d --name smoke-api --read-only --tmpfs /tmp --cap-drop ALL \
  --security-opt no-new-privileges:true -e NODE_ENV=development -e KV_DRIVER=memory \
  -p 127.0.0.1:13000:3000 ecloud-api:local
curl -s http://127.0.0.1:13000/healthz && docker stop smoke-api
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
apps/admin                admin SPA (Vite + React; static build served by Caddy)
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

## Storage (D-026)

Object storage goes through `@ecloud/storage` (`packages/storage/README.md`). Business code calls
`createStorage(loadConfig().storage)` and, per request, `forTenant(storage, orgId)`; drivers are
never imported directly. Keys are `org/{organizationId}/{purpose}/{id}`; uploads are checked
against the purpose's content-type allow-list, magic bytes and size limit (`branding`:
PNG/JPEG/WebP ≤ 5 MiB, SVG rejected).

- **Dev / pilot:** `STORAGE_DRIVER=local`, files under `STORAGE_LOCAL_PATH` (default
  `./var/storage`, gitignored via `var/`). Only non-critical assets (branding, dev files) may live
  there, and it must never be the only copy of anything that has to survive the VPS. The directory
  must be owned exclusively by the service user (0700). With `NODE_ENV=production` the local driver
  is refused unless `STORAGE_LOCAL_ALLOW_PRODUCTION=true` is set explicitly.
- **Production:** `STORAGE_DRIVER=s3` with an external S3-compatible bucket (`S3_ENDPOINT`, which
  must be `https://` in production, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`,
  `S3_SECRET_ACCESS_KEY` injected from secrets, `S3_FORCE_PATH_STYLE=true` for most non-AWS
  services). No MinIO on the VPS and none in the dev compose file.
- **Tests:** `npm test` runs the shared driver contract against the local driver only. The S3
  contract runs only when `ECLOUD_TEST_S3_ENDPOINT` (plus `ECLOUD_TEST_S3_ACCESS_KEY_ID`,
  `ECLOUD_TEST_S3_SECRET_ACCESS_KEY`, optional `ECLOUD_TEST_S3_BUCKET` default `ecloud-test`) is
  set; otherwise it is skipped. So far it has been run only against a throwaway RustFS container
  on 127.0.0.1 (2026-10-08); AWS S3, R2, B2 and Wasabi are untested. Use credentials generated for
  the run only and never write them to a file.
