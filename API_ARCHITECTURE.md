# ECLOUD — API & Backend Architecture (Phase 2, A5)

Status: design only. Nothing here was deployed or changed on any host. Labels: **VERIFIED FROM EXISTING CODE** (local path), **VERIFIED FROM OFFICIAL DOCUMENTATION** (URL), **PROPOSED** (our choice), **UNKNOWN**, **REQUIRES DEVICE TEST**. Everything not labelled otherwise in §1–§8 is **PROPOSED**. Internal AAA endpoint names are aligned with A3 (`AAA_ARCHITECTURE.md`) and A5b (`POLICY_ENGINE.md`), both being written in parallel — names marked PROPOSED until those documents land.

Inputs: `MULTITENANCY.md` (permission catalogue §4.2, algorithm §4.4, impersonation §4.5, API keys §4.6), `DATABASE_DESIGN.md` (tables §3, RLS §8, migrations §9), `NETWORK_INTEGRATION.md` (§7 adapters, §8 Option C→A), `CAPTIVE_PORTAL_ARCHITECTURE.md` (§7 portal design), `WIREGUARD_ARCHITECTURE.md` (§8 peer provisioning), `DEPLOYMENT_ARCHITECTURE.md` (§2 services, §3 subdomains, §4 env), A7 frontend notes (`tmp/p2/a7_frontend.md` §3 data needs).

---

## 1. Service decomposition for the pilot — modular monolith (PROPOSED)

One codebase, one container image, three processes (`api`, `worker`, `portal`) plus `freeradius`, `postgres`, `redis`. Matches `DEPLOYMENT_ARCHITECTURE.md §2.1` (api `127.0.0.1:3000`, portal `127.0.0.1:3001`, worker = same image/different command).

| Process | Responsibilities | Why its own process |
|---|---|---|
| `api` | REST `/api/v1`, admin authN/authZ, RBAC evaluation, policy engine (resolve intent → adapters), AAA internal endpoints for FreeRADIUS, portal internal endpoints, adapter registry, outbox writer | Latency-critical (`/internal/aaa/authorize` < 100 ms); must never block on batch work |
| `worker` | BullMQ consumers: accounting ingestion & counter roll-ups, CoA/Disconnect dispatcher (`radclient`), schedulers (quota resets, expiries, voucher cleanup, reconciliation, partition creation, backups), webhook delivery, WireGuard peer reconcile (via host helper), CSV import/export jobs | Spawns processes, long transactions, retries — isolated from request path; horizontally scalable later |
| `portal` | Server-rendered captive-portal pages on `portal.ezecloud.ezelink.ai`; UAM adapters (`uspot-uam`, `coovachilli-uam`); talks only to `api` via `/internal/portal/*` | Anonymous, high-volume, walled-garden hostname; a portal flood must not starve admins (A7/A1 requirement); smaller attack surface (no DB credentials in the portal container) |
| `freeradius` | RADIUS front-end; `rlm_rest` → `/internal/aaa/*` (A3 decides rlm_sql vs rlm_rest split) | Vendor software |
| `postgres`, `redis` | State; queues, rate limits, admin session index | Shared state so `api`/`portal`/`worker` stay stateless |

```mermaid
flowchart LR
  subgraph PUB["Public (Caddy :443, native on VPS)"]
    ADMIN["ezecloud.ezelink.ai\nadmin SPA (static)"]
    APIH["api.ezecloud.ezelink.ai"]
    PORTH["portal.ezecloud.ezelink.ai"]
  end
  subgraph DOCKER["Docker network ecloud_internal 172.28.0.0/16 (no public ports)"]
    API["api :3000\nREST + RBAC + policy engine + adapters"]
    PORTAL["portal :3001\nSSR pages + UAM adapters"]
    WORKER["worker\nBullMQ consumers + schedulers"]
    FR["freeradius 3.2.x\nrlm_rest"]
    PG[("postgres 16\nRLS")]
    RD[("redis 7")]
  end
  subgraph TUN["WireGuard hub wg0 100.100.0.1 (host-native) / public UDP fallback"]
    NAS["Site NAS / EZEAP\nRADIUS 1812/1813 → hub\nDAS 3799 ← hub"]
    EZC["EZE controller\nucentral gateway :15002\nREST + API keys"]
  end
  ADMIN -->|XHR, cookie| APIH --> API
  PORTH --> PORTAL
  PORTAL -->|/internal/portal/* shared secret| API
  FR -->|/internal/aaa/* shared secret| API
  API --> PG & RD
  WORKER --> PG & RD
  WORKER -->|radclient CoA/Disconnect| NAS
  NAS -->|RADIUS| FR
  API -->|/internal/adapters/openwifi → controller REST (Option A, PROPOSED)| EZC
  EZC -.->|device state webhooks (PROPOSED)| API
```

Trust boundaries: (1) public → Caddy only; (2) `ecloud_internal` — `/internal/*` routes are bound to a second listener (`INTERNAL_PORT`, not published) and require a shared secret header (`X-Internal-Token`, compared constant-time) — mTLS can replace it later without changing routes; (3) tunnel/public UDP — RADIUS secrets per NAS, CoA from the hub address only (`NETWORK_INTEGRATION.md §4` notes `dynamic-authorization.host` is an IP literal, VERIFIED in schema).

**Why not microservices now.** 2 vCPU / 3.7 GiB host; one team; one DB with RLS as the isolation primitive; the expensive boundaries (policy engine ↔ adapters ↔ AAA) need the same transaction. Module boundaries are enforced in code (`packages/*`, §8) so the split is mechanical later: `worker` is already a separate deployable; `portal` already talks only HTTP to `api`; AAA endpoints can be lifted into an `aaa` service by moving `packages/policy-engine` + `/internal/aaa` routes (FreeRADIUS config changes only its URL). Scaling path per `DEPLOYMENT_ARCHITECTURE.md §7`: N stateless `api`/`portal` replicas, managed PostgreSQL + PgBouncer, managed Redis, a second hub.

---

## 2. Runtime, framework, libraries (PROPOSED, precedent-driven)

Precedent (VERIFIED FROM EXISTING CODE, `/Users/danny/Project/ezecontroller`): `Dockerfile` `FROM node:22-bookworm-slim`, `tini`, non-root; `package.json` `express ^4.18.2`, `pg ^8`, `ioredis ^5`, `bullmq ^5.79`, `winston`, `helmet ^8`, `cors`, `compression`, `ajv ^6`, `jsonwebtoken`, `express-session` (dependency present), `node-cron`; `src/server.ts` is an 11 934-line single file with inline routes; `src/services/queueService.ts` (BullMQ, `attempts: 3`, exponential backoff 2 s), `src/services/rateLimitService.ts` (Redis INCR/EXPIRE, fails open), `src/services/loggerService.ts` (winston JSON in prod), `src/lib/migrate.ts` (plain SQL runner), `src/middleware/context-scope.ts` (tenant context validation after auth), `src/lib/permissions.ts` (`can()`, `requirePermission()`), `src/services/auth/{passwordService,totpService,SessionService,tokenService}.ts`. No `SIGTERM` handler exists anywhere in `src/` (grep, VERIFIED absence).

| Concern | Decision | Reasoning |
|---|---|---|
| Runtime | **Node 22 LTS, TypeScript (strict, ESM)** | Precedent image; team fluency; FreeRADIUS/portal work is I/O-bound |
| HTTP framework | **Express 5** (Fastify considered) | Keep precedent (middleware idioms `requirePermission`, context-scope pattern, helmet/cors). Express 5 adds async error propagation (unhandled rejections in handlers → error middleware). Fastify would give ~2× raw throughput and built-in JSON-schema validation, but the authorize path is DB-bound not framework-bound; NestJS rejected (DI/decorators add a learning curve with no gain for a 3-process app). Revisit Fastify only if `api` is split into an `aaa` service |
| Validation | **zod** schemas → **OpenAPI 3.1** generated (`zod-openapi`) → served at `GET /api/v1/openapi.json` + Swagger UI in non-prod. One schema = types + validation + docs | Precedent ajv v6 is pre-draft-2019 and used only for uCentral config (`ap_config_engine.ts` L22-24) and shadow checks (`server.ts` L559-587). Keep **ajv 8** only inside `packages/adapters/openwifi` to validate emitted fragments against `ucentral.full.json` (precedent reuse) |
| DB access | **`pg` + Kysely** (typed SQL builder, no migration authority) | Aligns with A6: plain-SQL forward-only migrations with the ported `migrate.ts` runner (`DATABASE_DESIGN.md §9`). Kysely types are generated from the live schema (`kysely-codegen`) so SQL stays visible; RLS requires every query inside `withTenant(orgId, tx => …)` which issues `SET LOCAL app.current_org` (`DATABASE_DESIGN.md §8`) — a helper, not an ORM concern. Drizzle acceptable alternative; Prisma rejected (RLS/partitions) |
| Logging | **pino** (JSON, redaction of `authorization`, `x-api-key`, `password`, `secret*`), `X-Request-Id` accepted or generated (precedent `server.ts` L955), propagated to audit rows (`audit_logs.request_id`) and BullMQ job data | winston precedent works, but pino is cheaper on a 2-vCPU box and has first-class redaction |
| Config | `env` via a single validated `config.ts` (zod). Variable **names only**: `NODE_ENV`, `PORT`, `INTERNAL_PORT`, `ECLOUD_BASE_URL`, `ECLOUD_API_URL`, `ECLOUD_PORTAL_URL`, `DATABASE_URL`, `DATABASE_URL_OWNER` (migrations), `REDIS_URL`, `SESSION_SECRET_FILE`, `ENCRYPTION_KEY_FILE`, `INTERNAL_TOKEN_FILE`, `VOUCHER_PEPPER_FILE`, `RADIUS_COA_PORT`, `RADIUS_DICTIONARY_DIR`, `WG_INTERFACE`, `WG_HUB_ENDPOINT`, `WG_OVERLAY_CIDR`, `WG_HUB_PUBLIC_KEY`, `OBJECT_STORAGE_ENDPOINT`, `OBJECT_STORAGE_BUCKET`, `OBJECT_STORAGE_KEY_ID`, `OBJECT_STORAGE_SECRET_FILE`, `EZE_CONTROLLER_URL`, `EZE_CONTROLLER_API_KEY_FILE`, `CORS_ORIGINS`, `TRUST_PROXY`, `LOG_LEVEL`, `LOG_FORMAT`, `RATE_LIMIT_DISABLED` (tests only). `*_FILE` preferred (Compose secrets, `DEPLOYMENT_ARCHITECTURE.md §4.1`) |
| Health | `GET /healthz` (liveness: process up), `GET /readyz` (readiness: `SELECT 1`, Redis `PING`, migrations at head; 503 + JSON detail otherwise). Unauthenticated, loopback/Caddy only, no tenant data | Compose healthchecks reference `/healthz` (A1) |
| Shutdown | `SIGTERM` → stop accepting (`server.close()`), drain in-flight ≤ 10 s, close BullMQ workers (`worker.close()` waits for active jobs), end `pg` pool, exit 0; Compose `stop_grace_period: 20s` | Precedent has none; required for zero-downtime redeploys |
| Process hygiene | `tini` as PID 1 (precedent), `--max-old-space-size` per `DEPLOYMENT_ARCHITECTURE.md §2.2`, `unhandledRejection` → log + exit 1 (restart policy) | |

---

## 3. API surface

### 3.1 Conventions

| Topic | Rule |
|---|---|
| Base paths | Admin/public: `https://api.ezecloud.ezelink.ai/api/v1/…` (also same-origin `/api/v1` through the admin host per `DEPLOYMENT_ARCHITECTURE.md §3.1`). Internal: `http://api:<INTERNAL_PORT>/internal/…` (never through Caddy). Portal public: `https://portal.ezecloud.ezelink.ai/…` |
| Tenant scoping | Organization resources live under `/api/v1/orgs/{orgId}/…`; platform resources under `/api/v1/platform/…`. The path `orgId` is the **target** for `authorize()` (`MULTITENANCY.md §4.4`); the request runs inside `withTenant(orgId)` so RLS is the second lock. `siteId` is a filter/body field validated against the same org (G9 FK re-check). `/api/v1/me` is scope-less |
| IDs | UUID v7 strings; append-only rows never exposed by id (A6) |
| Pagination | Cursor-based: `?limit=50&cursor=<opaque>` → `{ data: [...], next_cursor, total?: n }` (`total` only when `?include_total=true`, capped count). Sorting `?sort=-started_at,username` (allow-list per resource). Filtering `?filter[status]=active&filter[site_id]=…`; time ranges `?from=&to=` (RFC 3339, UTC) |
| Mutations | `POST` create, `PATCH` partial update (JSON merge semantics), `DELETE`. Non-idempotent `POST`s (voucher batch, disconnect, CoA, import, invite, key create) **require** `Idempotency-Key` (UUID, 24 h, stored in Redis with response hash; replay returns the stored response, mismatch → 422). Optimistic concurrency with `If-Match: "<updated_at or version>"` on `PATCH` for policies/portals/roles |
| Errors | RFC 9457 `application/problem+json`: `{ type, title, status, detail, instance, request_id, errors?: [{ path, code, message }] }`. `type` is a stable URN `urn:ecloud:error:<code>` (e.g. `validation_failed`, `permission_denied`, `tenant_mismatch`, `idempotency_conflict`, `coa_unsupported`, `rate_limited`). 404 for cross-tenant objects (never 403, no existence leak) |
| Rate limits | Redis token buckets (precedent `rateLimitService` pattern, but **fail closed for auth endpoints**, fail open elsewhere): login 10/5 min per IP+email; admin API 600/min per principal, writes 120/min; API keys 300/min default (per-key override); export endpoints 10/h; `429` + `Retry-After` |
| Content | JSON only; `multipart/form-data` for CSV import and branding assets (≤ 5 MB, type-sniffed); request body limit 1 MB default (precedent used 50 MB — rejected) |
| Audit | Every mutating call writes one `audit_logs` row (actor, impersonator, org, action = permission key, target, before/after diff, ip, ua, request_id) in the same transaction (A6 §3.5) |

### 3.2 Endpoint catalogue (path | method | permission | notes)

Permissions are keys from `MULTITENANCY.md §4.2` exactly. `—` = authenticated only. `P` = platform-only. Prefix `/api/v1` omitted; `{o}` = `/orgs/{orgId}`.

**Auth & self**

| Path | Method | Permission | Notes |
|---|---|---|---|
| `/auth/login` | POST | public | email+password → `mfa_required` or session cookie set |
| `/auth/mfa/totp` | POST | pending session | TOTP or recovery code |
| `/auth/logout` | POST | — | revokes `admin_sessions` row |
| `/auth/accept-invitation` | POST | public (token) | creates/links global administrator |
| `/me` | GET | — | `{ administrator, bindings[], permissions_by_scope, impersonation? }` (A7 §2) |
| `/me/mfa` | POST/DELETE | — | enrol (QR secret shown once) / disable |
| `/me/sessions` | GET/DELETE | — | list / revoke own sessions |

**Platform** (all `P`)

| Path | Method | Permission | Notes |
|---|---|---|---|
| `/platform/organizations` | GET/POST | `tenant:list` / `organization:create` | create seeds `org_admin` invitation |
| `/platform/organizations/{id}` | GET/PATCH/DELETE | `organization:read` / `organization:update` / `organization:delete` | `PATCH {status:'suspended'}` requires `organization:suspend` |
| `/platform/organizations/{id}/impersonate` | POST | `tenant:impersonate` | body `{reason}`; sets `impersonating_organization_id`, TTL ≤ 60 min; audit `tenant:impersonate` |
| `/platform/impersonation` | DELETE | — | end early; audit `tenant:impersonate:end` |
| `/platform/administrators` | GET/POST | `administrator:read` / `administrator:invite` | platform-scope bindings |
| `/platform/administrators/{id}` | GET/PATCH | `administrator:read` / `administrator:update` (`administrator:disable` for status) | disabling revokes the target's sessions |
| `/platform/administrators/{id}/mfa/reset` | POST | `administrator:mfa_reset` | D-038: body `{reason}`; deletes MFA credentials, revokes sessions, forces re-enrolment; refused while impersonating / on oneself |
| `/platform/settings` | GET/PATCH | `platform:health:read` / `platform:settings:update` | defaults, password policy, retention |
| `/platform/role-templates` | GET/PATCH | `role:read` / `platform:role_template:manage` | bumps `template_version` |
| `/platform/adapters` | GET | `platform:health:read` | `adapter_types` with capability flags + `verification_status` (A7 "capability matrix") |
| `/platform/adapters/{key}` | PATCH | `platform:adapter:manage` | flip flags only after device test evidence (`evidence_url` required) |
| `/platform/health` | GET | `platform:health:read` | queue depths, FreeRADIUS Status-Server result, WG handshakes, partition horizon |
| `/platform/audit-log` | GET | `audit_log:read` (platform binding) | cross-tenant, grouped by `organization_id` |

**Organization — structure & access**

| Path | Method | Permission | Notes |
|---|---|---|---|
| `{o}` | GET/PATCH | `organization:read` / `organization:update` | `settings` jsonb; `organization:settings:update` for `settings` |
| `{o}/sites` | GET/POST | `site:read` / `site:create` | site has IANA `timezone` |
| `{o}/sites/{id}` | GET/PATCH/DELETE | `site:read` / `site:update` / `site:delete` | |
| `{o}/network-devices` | GET/POST | `network_device:read` / `network_device:create` | `?filter[site_id]`; serial unique |
| `{o}/network-devices/{id}` | GET/PATCH/DELETE | `network_device:*` | `reported_capabilities`, `mode` |
| `{o}/network-devices/{id}/config-push` | POST | `network_device:config:push` | Option A only (§6); returns `policy_translations` id; 501 `adapter_unsupported` under Option C |
| `{o}/nas` | GET/POST | `nas:read` / `nas:create` | secret generated server-side, returned **once**, stored via `secret_ref`; body requires `adapter_key` (engine adapter, D-035) |
| `{o}/nas/{id}` | GET/PATCH/DELETE | `nas:*` | `coa_supported` mirrors adapter flag unless overridden with evidence |
| `{o}/nas/{id}/rotate-secret` | POST | `nas:secret:rotate` | idempotency key; FreeRADIUS clients reload job |
| `{o}/wireguard-peers` | GET/POST | `wireguard_peer:read` / `wireguard_peer:create` | allocates `tunnel_ip`; returns one-time bundle (`WIREGUARD_ARCHITECTURE.md §8`) |
| `{o}/wireguard-peers/{id}` | GET/PATCH/DELETE | `wireguard_peer:*` | `DELETE` = revoke → reconcile job |
| `{o}/wireguard-peers/{id}/rotate-key` | POST | `wireguard_peer:key:rotate` | body `{public_key}` (site-generated) |
| `{o}/administrators` | GET/POST | `administrator:read` / `administrator:invite` | POST = invitation `{email, role_id, scope_type, site_id?}` |
| `{o}/administrators/{id}` | GET/PATCH | `administrator:read` / `administrator:update` | `PATCH {disabled:true}` → `administrator:disable` |
| `{o}/role-bindings` | GET/POST | `administrator:read` / `administrator:binding:create` | grant requires granter to hold every permission of the role in that scope |
| `{o}/role-bindings/{id}` | DELETE | `administrator:binding:delete` | |
| `{o}/roles` | GET/POST | `role:read` / `role:create` | POST copies a template (copy-on-write) |
| `{o}/roles/{id}` | GET/PATCH/DELETE | `role:*` | permission keys validated against `permissions` table; cannot include platform-only keys |
| `{o}/api-keys` | GET/POST | `api_key:read` / `api_key:create` | `{name, role_id, scope_type, site_id?, allowed_cidrs?, expires_at?}`; plaintext once |
| `{o}/api-keys/{id}` | DELETE | `api_key:revoke` | |
| `{o}/audit-log` | GET | `audit_log:read` | filters actor/action/target/time; includes impersonation rows |
| `{o}/audit-log/export` | POST | `audit_log:export` | async job → signed download URL |
| `{o}/webhooks` | GET/POST | `webhook:read` / `webhook:create` | `events[]` from §5 catalogue; signing secret once |
| `{o}/webhooks/{id}` | GET/PATCH/DELETE | `webhook:*` | `GET` includes last 20 `webhook_deliveries` |
| `{o}/webhooks/{id}/test` | POST | `webhook:update` | sends `ping` event |

**Organization — subscribers, policy, portal**

| Path | Method | Permission | Notes |
|---|---|---|---|
| `{o}/users` | GET/POST | `user:read` / `user:create` | `?filter[site_id]`, `?q=` username/email prefix |
| `{o}/users/{id}` | GET/PATCH/DELETE | `user:*` | `PATCH {status:'suspended'}` → `user:suspend` |
| `{o}/users/{id}/reset-password` | POST | `user:password:reset` | returns temp password once or sends via IdP |
| `{o}/users/{id}/effective-policy` | GET | `policy:preview` | `?site_id=&at=` → resolved intent + per-adapter enforceability (A7 "simulate") |
| `{o}/users/import` | POST | `user:create` | multipart CSV → job id; `?dry_run=true` |
| `{o}/users/export` | POST | `user:export` | async job |
| `{o}/user-groups` | GET/POST | `user_group:read` / `user_group:create` | |
| `{o}/user-groups/{id}` | GET/PATCH/DELETE | `user_group:*` | |
| `{o}/client-devices` | GET/POST | `client_device:read` / `client_device:create` | MAC normalised `aa:bb:cc:dd:ee:ff` |
| `{o}/client-devices/{id}` | GET/PATCH/DELETE | `client_device:*` | `PATCH {blocked:true}` → `client_device:block` (also triggers disconnect if active) |
| `{o}/policies` | GET/POST | `policy:read` / `policy:create` | intent fields only (`DATABASE_DESIGN.md §3.4`); `preview` returns unsupported fields per adapter |
| `{o}/policies/{id}` | GET/PATCH/DELETE | `policy:*` | `If-Match`; version bump → `policy.updated` event → re-evaluate active sessions (CoA where `coa_supported`) |
| `{o}/policies/{id}/preview` | POST | `policy:preview` | `{adapter_type_key, nas_id?}` → emitted attributes / fragment + `unsupported[]` |
| `{o}/policy-assignments` | GET/POST | `policy_assignment:read` / `policy_assignment:create` | exactly one target; `priority`, `effective_from/until`, `schedule_id` |
| `{o}/policy-assignments/{id}` | DELETE | `policy_assignment:delete` | |
| `{o}/schedules` | GET/POST/PATCH/DELETE (`/{id}`) | `policy:*` (schedules are policy sub-resources) | `timezone` + `rules[]` |
| `{o}/voucher-batches` | GET/POST | `voucher:read` / `voucher:create` | `{count ≤ 5000, code_format, policy_id, valid_from/until, duration_s, max_devices}`; generation async for > 500 |
| `{o}/voucher-batches/{id}` | GET | `voucher:read` | counts by status |
| `{o}/voucher-batches/{id}/vouchers` | GET | `voucher:read` | `code_hint` only |
| `{o}/voucher-batches/{id}/print` | GET | `voucher:reveal` | server-rendered A4 HTML/PDF with codes (decrypts `code_enc`); audited; `exported_at` set |
| `{o}/voucher-batches/{id}/export` | POST | `voucher:export` + `voucher:reveal` for codes | CSV job |
| `{o}/vouchers/{id}/revoke` | POST | `voucher:revoke` | disconnects active session |
| `{o}/captive-portals` | GET/POST | `captive_portal:read` / `captive_portal:create` | per site; `portal_type`, `auth_methods[]`, `identity_provider_ids[]`, `walled_garden[]` |
| `{o}/captive-portals/{id}` | GET/PATCH/DELETE | `captive_portal:*` | `PATCH {published:true}` publishes theme version |
| `{o}/captive-portals/{id}/preview` | GET | `captive_portal:read` | signed URL to portal process render with `?preview=<token>` |
| `{o}/portal-themes` | GET/POST/PATCH/DELETE (`/{id}`) | `portal_theme:*` | tokens + strings jsonb, versioned |
| `{o}/assets` | POST | `portal_theme:update` | multipart → object storage; returns `asset_id`, content hash (A7 §6) |
| `{o}/identity-providers` | GET/POST/PATCH/DELETE (`/{id}`) | `identity_provider:*` | `config` non-secret; `client_secret` write-only |

**Organization — runtime & reporting**

| Path | Method | Permission | Notes |
|---|---|---|---|
| `{o}/sessions` | GET | `session:read` | `?filter[status]=active`, by user/mac/nas/site; joins policy name, NAS `coa_supported` (drives UI button) |
| `{o}/sessions/{id}` | GET | `session:read` | includes `session_actions[]`, `policy_translations` for this session |
| `{o}/sessions/{id}/disconnect` | POST | `session:disconnect` | 202 → `session_actions` row `pending`; 409 `coa_unsupported` when NAS `coa_supported=false`; `unknown` allowed with warning |
| `{o}/sessions/{id}/reauthorize` | POST | `session:coa` | CoA-Request with re-resolved policy; REQUIRES DEVICE TEST on EZEAP (`NETWORK_INTEGRATION.md §11.5`) |
| `{o}/session-actions/{id}` | GET | `session:read` | poll status `sent/ack/nak/timeout` |
| `{o}/accounting/records` | GET | `accounting:read` | raw, time-bounded (≤ 31 days per query), BRIN-friendly order |
| `{o}/accounting/usage` | GET | `accounting:read` | `usage_counters` by subject/period |
| `{o}/accounting/export` | POST | `accounting:export` | CSV job |
| `{o}/reports/summary` | GET | `report:read` | dashboard KPIs (A7 §3): NAS online/total, active sessions, auth accept/reject 24 h, top sites by bytes, expiring vouchers |
| `{o}/reports/usage` | GET | `report:read` | aggregates by `user|site|group`, bucket `hour|day|month` in **site TZ** (`?tz=` override) |
| `{o}/reports/auth-events` | GET | `report:read` | `auth_events` by result/NAS/time |
| `{o}/reports/export` | POST | `report:export` | CSV/XLSX job |
| `{o}/jobs/{id}` | GET | — (owner or `*:read` on job type) | async job status/progress/result URL |
| `{o}/events/stream` | GET (SSE) | `session:read` | `session.started/stopped`, `device.offline` for dashboards (poll fallback 30 s) |

**Internal (docker network, `X-Internal-Token`, no tenant in path — tenant resolved from NAS)**

| Path | Method | Caller | Notes |
|---|---|---|---|
| `/internal/aaa/authorize` | POST | FreeRADIUS `rlm_rest` (A3) | in: `{user_name, password?/chap, nas_ip, nas_identifier, called_station_id, calling_station_id, acct_session_id, framed_ip, service_type}`; out: `{result: accept|reject|challenge, reply_attributes: [{name, value, op}], session_hint}`. Resolves tenant by `nas_clients.nas_ip`/`nas_identifier`, identity (`users`/`vouchers`/`client_devices`/portal credential), policy (A5b), adapter translation. PROPOSED name aligned with A3 |
| `/internal/aaa/accounting` | POST | FreeRADIUS | Start/Interim/Stop → `accounting_records` insert (fast path) + enqueue `accounting.ingest`; returns 200 immediately. Quota breach check is done by worker → CoA |
| `/internal/aaa/coa-result` | POST | worker (or FreeRADIUS `originate-coa` listener) | `{session_action_id, result: ack|nak|timeout, attributes?}` → updates `session_actions` |
| `/internal/aaa/clients` | GET | FreeRADIUS startup/reload (or `rlm_sql` reads table directly — A3) | rendered NAS list (`nas_ip`, secret via `secret_ref`, `require_message_authenticator`) |
| `/internal/portal/resolve-nas` | POST | portal | `{nasid?, called?, uamip, source_ip}` → `{nas_id, org_id, site_id, portal_config, theme, adapter, auth_methods, walled_garden}` (`CAPTIVE_PORTAL_ARCHITECTURE.md §7.3`) |
| `/internal/portal/flows` | POST | portal | start flow `{nas_id, mac, sessionid, userurl, challenge, md_ok}` → `flow_id`; rate-limit keys |
| `/internal/portal/flows/{id}/identify` | POST | portal | `{method: password|voucher|mac|idp, proof}` → identity broker → `{credential: {username, password}, logon_params}` (ttl 90 s, ≤ 16 bytes) or problem |
| `/internal/portal/flows/{id}/status` | GET | portal | session status (bytes, time left) from `sessions`/`usage_counters` |
| `/internal/portal/flows/{id}/result` | POST | portal | `res=success|reject|failed|logoff` callback recorded |
| `/internal/portal/idp/{idpId}/callback` | POST | portal | OIDC code exchange done by `api` (holds `client_secret_ref`); portal never sees IdP secrets |
| `/internal/adapters/openwifi/devices/{serial}/state` | POST | EZE controller → ECLOUD (webhook, Option A, PROPOSED) | `state.interfaces[].ssids[].associations[]` byte counters → telemetry adapter (`NETWORK_INTEGRATION.md §7.4`) |
| `/internal/adapters/openwifi/push` | POST | worker → controller client | queue entry; actual HTTP goes out to `EZE_CONTROLLER_URL` (§6) |

**Portal public (`portal.ezecloud.ezelink.ai`, served by `portal` process; CSRF + rate limits below)**

| Path | Method | Notes |
|---|---|---|
| `/uam/uspot/` and `/uam/chilli/` | GET | UAM entry; query `res, uamip, uamport, challenge, mac, ip, called, nasid, sessionid, userurl, md…` (VERIFIED, `CAPTIVE_PORTAL_ARCHITECTURE.md §3.2/§4`); no `?` in configured `uam-server` — hence path-based adapter selection. Sets flow cookie, renders landing/login |
| `/f/{flow}/login` | POST | username+password (PAP; CHAP response computed server-side when NAS challenge present) → 302 to NAS `logon` URL built by adapter |
| `/f/{flow}/voucher` | POST | voucher code |
| `/f/{flow}/click` | POST | click-to-continue with terms checkbox (if portal allows) |
| `/f/{flow}/idp/{idpId}` | GET | redirect to IdP; `state` = signed flow id |
| `/idp/callback` | GET | IdP returns; portal → `/internal/portal/idp/{id}/callback` → logon redirect |
| `/f/{flow}/status` | GET | remaining time/quota (+ JSON for progressive enhancement) |
| `/f/{flow}/logout` | POST | 302 to NAS `/logoff` |
| `/legal/{siteSlug}/terms`, `/legal/{siteSlug}/privacy` | GET | per-site legal text, `?lang=` |
| `/healthz` | GET | loopback only |

Portal CSRF/rate-limit design: flow cookie `__Host-pf` (HttpOnly, Secure, SameSite=Lax, 15 min) binds browser ↔ flow; every POST carries a per-flow CSRF token (double-submit, HMAC of flow id + secret) — mini-browsers (CNA) accept cookies but not `localStorage` (A7 §4). Rate limits in Redis: 5 login attempts / 10 min per `nasid+mac`, 10 voucher guesses / h per `nasid+mac`, 60 req/min per source IP, 300 flows / h per NAS; all failures constant-time, generic messages. Strict CSP `default-src 'self'`; HSTS; assets only from the portal host (walled-garden constraint).

---

## 4. Admin AuthN / AuthZ

| Aspect | Decision (PROPOSED) | Precedent / rationale |
|---|---|---|
| Session carrier | **Opaque session id in cookie** `__Host-ecloud_sid` (HttpOnly, Secure, SameSite=Lax, Path=/) when API is same-origin via admin host; if the SPA calls `api.ecloud…` cross-subdomain, use `Domain=.ezecloud.ezelink.ai` + SameSite=Lax + `Origin` check + CSRF header (`X-CSRF-Token` = value from `GET /auth/csrf`). Server-side row `admin_sessions` (`token_hash` = SHA-256 of id) mirrored in Redis for O(1) lookup; idle 30 min, absolute 12 h (A7 §5), revocable instantly | Precedent: JWT in `localStorage` (`server.ts` L299, `public/js/app.js`) — rejected (XSS-readable, no server revocation). The precedent already mints HttpOnly SameSite=Lax cookies for tickets (`server.ts` L889, L4274) and has `SessionService.ts` dual-writing `sessions` rows — ECLOUD makes that authoritative. A7 prefers cookie; A8 reviewing |
| Non-browser clients | API keys (below). No JWT issuance in v1; a signed short-lived JWT can be added later for the controller webhook if mTLS is unavailable | |
| Passwords | **Argon2id** (`argon2` package; m=64 MiB, t=3, p=1), `needsRehash()` on login | Precedent `passwordService.ts` is algorithm-agile with Argon2id preferred, scrypt default, bcrypt verify-only (VERIFIED) — port the shape, drop bcrypt |
| MFA | TOTP (RFC 6238), secret AES-256-GCM at rest under `ENCRYPTION_KEY_FILE`, 10 recovery codes (hashed); enforced for platform bindings; per-org `settings.mfa_required` | Precedent `totpService.ts` zero-dep implementation incl. encryption + recovery codes (VERIFIED) — reuse |
| Lockout | 10 failures / 5 min per IP+email → 15 min lock; `auth_events`-style `security_events` row | Precedent login limiter `max: 10, windowSec: 300` (`server.ts` L3744) |
| API keys | Format `eck_<base64url 32 bytes>`; store `key_prefix` (first 12 chars, indexed) + `key_hash` (SHA-256); shown once; header `Authorization: Bearer eck_…` or `X-API-Key`; one binding `role_id + scope_type + organization_id/site_id`, optional `allowed_cidrs`, `expires_at`, `last_used_at` (batched update), revoke via `revoked_at` | Precedent `_genApiKey`/`_authenticateApiKey` (`server.ts` L1704-1748, `migrations/001_auth_session_engine.sql` `api_keys`) — VERIFIED; changed: scope is a role binding, not a `write` flag (`MULTITENANCY.md §4.6`) |
| Permission middleware | `authenticate` (cookie or key) → `principal`; `tenantContext` (parses `{orgId}`/`siteId`, validates existence, rejects tampering 404) → `requirePermission('session:disconnect')` evaluates `MULTITENANCY.md §4.4` with per-request memo; then `withTenant(orgId)` wraps the handler's transaction (`SET LOCAL app.current_org`; `app.platform_access='on'` only for `/platform/*` with a platform binding and no impersonation) | Precedent `requirePermission` shape (`permissions.ts` L214) + `context-scope.ts` "reject tampering loudly" — both reused; `ROLE_GRANTS` constant replaced by DB rows |
| Deny by default | Unknown permission key → 500 at boot (catalogue check), 403 at runtime; listing endpoints apply bindings as filters | Precedent `can()` fails closed on unknown verb (VERIFIED) |
| Impersonation | `POST /platform/organizations/{id}/impersonate {reason}` → same session gets `impersonating_organization_id`, TTL ≤ 60 min; effective permissions = `org_admin` template, platform set off; every audit row carries `impersonator_id`; guardrails: cannot create API keys, rotate secrets, or change role bindings while impersonating (A7 §5, PROPOSED); tenant sees entries in own audit log | `MULTITENANCY.md §4.5` |
| Row filtering | Repository layer always adds `organization_id = $org` (fast failure) **and** RLS enforces it (`DATABASE_DESIGN.md §8`); tests T-09/T-10/T-11/T-14 from `MULTITENANCY.md §6` become integration tests | |

```mermaid
sequenceDiagram
  participant UI as Admin SPA
  participant API as api
  participant R as Redis
  participant PG as Postgres (RLS)
  UI->>API: PATCH /api/v1/orgs/O/policies/P (cookie, X-CSRF-Token, If-Match)
  API->>R: GET session:sid → administrator, impersonation?
  API->>PG: bindings + role_permissions (cached 60 s per principal)
  API->>API: authorize(principal,'policy:update',{org:O}) → ALLOW
  API->>PG: BEGIN; SET LOCAL app.current_org='O'; UPDATE policies…; INSERT audit_logs; INSERT outbox(policy.updated); COMMIT
  API-->>UI: 200 policy (ETag)
```

---

## 5. Events, webhooks, async work

**Event catalogue** (`event` string, payload always `{event, id, occurred_at, organization_id, site_id?, data}`):

| Family | Events |
|---|---|
| `session.*` | `session.started`, `session.updated` (interim), `session.stopped`, `session.disconnect_requested`, `session.disconnect_result` |
| `quota.*` | `quota.threshold_reached` (80 %), `quota.exceeded`, `quota.reset` |
| `policy.*` | `policy.created`, `policy.updated`, `policy.deleted`, `policy.assignment_changed`, `policy.push_result` (Option A) |
| `device.*` | `device.online`, `device.offline`, `device.state_received`, `nas.secret_rotated`, `wireguard.peer_handshake_lost` |
| `voucher.*` | `voucher.batch_created`, `voucher.activated`, `voucher.exhausted`, `voucher.expired`, `voucher.revoked` |
| `user.*`, `auth.*` | `user.created`, `user.suspended`, `user.expired`, `auth.rejected_burst` (N rejects/min per NAS) |
| `admin.*` | `admin.impersonation_started/ended`, `admin.api_key_created/revoked` |

**Outbox pattern**: domain write + `outbox` row in the same transaction (A6: add table `outbox(id bigint, organization_id, event, payload jsonb, created_at, published_at NULL)`); a worker poller (`FOR UPDATE SKIP LOCKED`, 100 rows / 250 ms) publishes to BullMQ `events` and marks `published_at`. Consumers: webhook fan-out (matching `webhooks.events[]`), SSE broadcaster (Redis pub/sub), metrics. Webhook delivery: HMAC-SHA-256 signature header `X-ECLOUD-Signature: t=<ts>,v1=<hex>`, 5 s timeout, retries below, `webhook_deliveries` row per attempt, auto-disable after 50 consecutive failures.

**BullMQ queues** (precedent `queueService.ts` defaults `attempts: 3`, exponential 2 s — VERIFIED; kept as baseline):

| Queue | Producer → consumer | Concurrency | attempts / backoff | DLQ |
|---|---|---|---|---|
| `accounting.ingest` | `/internal/aaa/accounting` → counters upsert, session upsert, quota check | 4 | 5 / exp 1 s (idempotent on `acct_unique_id`+status) | `dead.accounting` |
| `coa.dispatch` | disconnect/reauthorize/quota-exceeded → `radclient` to NAS DAS over tunnel | 2 | 3 / fixed 5 s, then `timeout` | writes `session_actions.status` instead of DLQ |
| `events` | outbox → fan-out | 4 | 3 / exp 2 s | `dead.events` |
| `webhooks.deliver` | per webhook+event | 8 | 8 / exp 10 s cap 1 h | `dead.webhooks` (visible in UI) |
| `adapters.openwifi.push` | config-push (Option A) | 1 per device (group key) | 5 / exp 30 s | `dead.push` |
| `jobs.import`, `jobs.export`, `jobs.vouchers` | admin async jobs | 1 | 1 (user re-runs) | status `failed` on job row |
| `wireguard.reconcile` | peer create/rotate/revoke + every 5 min | 1 | 3 / exp 5 s | alert |
| `maintenance` | schedulers below | 1 | 2 | alert |

DLQ = BullMQ `failed` set of a dedicated queue with 30-day retention; `/platform/health` exposes depths. Job ids are deterministic where idempotency matters (`coa:<session_action_id>`, `acct:<acct_unique_id>:<status>:<event_ts>`).

**Scheduled jobs** (BullMQ repeatable jobs; the worker holds a Redis lock so a second worker replica does not double-run; precedent `node-cron` single-process pattern `server.ts` L3742 not reused):

| Job | Schedule | Work |
|---|---|---|
| `quota.daily_reset` | every 15 min | for each site whose local time crossed midnight since last run (site `timezone`), close `daily` counters; `monthly` on day 1 local; emit `quota.reset` |
| `expiry.sweep` | every 5 min | users past `valid_until`, vouchers past `expires_at`, policy assignments past `effective_until`, temporary policies → status change + disconnect where active |
| `voucher.cleanup` | daily 03:00 UTC | purge `unused` vouchers of batches past `valid_until` + 90 days (per-org retention) |
| `accounting.reconcile` | nightly 02:00 UTC | recompute last 2 days daily + current monthly/total from `accounting_records` (`DATABASE_DESIGN.md §5`); log discrepancies |
| `sessions.stale_close` | every 10 min | active sessions with no interim for 3× `acct_interval` → `stale`, emit `session.stopped(reason=stale)` |
| `partitions.ensure` | daily | create monthly partitions 2 months ahead; detach per retention |
| `backup.pg_dump` | nightly 01:00 UTC | `pg_dump -Fc` via backup sidecar trigger (A1 §5); verify size; upload to object storage |
| `devices.offline_detect` | every 2 min | `network_devices.last_seen_at` / `wireguard_peers.last_handshake_at` thresholds → `device.offline` |
| `apikeys.expire`, `sessions.purge` | hourly | housekeeping |

---

## 6. Integration with the existing EZE controller (Option C → Option A, PROPOSED)

Pilot (Option C, `NETWORK_INTEGRATION.md §8`): operators configure SSIDs in the EZE controller UI pointing `radius.*`, `captive.uam-*`, `dynamic-authorization` at ECLOUD; ECLOUD pushes nothing. ECLOUD exposes a **"NAS onboarding sheet"** (`GET {o}/nas/{id}/onboarding`) listing the values to type into the controller (RADIUS host/port, UAM server URL, nasid, DAE host/port; secrets shown once).

Option A contract sketch (what ECLOUD needs; controller side **PROPOSED pending owner Q4 in NETWORK_INTEGRATION.md**; nothing exists yet on the controller for these shapes):

| Need | Controller API (existing / proposed) | ECLOUD side |
|---|---|---|
| Device inventory per site | **Existing** REST under `/api/access-points/*` (VERIFIED `src/ap_routes.ts`, `src/ap_device_config_routes.ts`); mapping EZE site ↔ ECLOUD site stored in `network_devices` (`serial`) | `adapters.openwifi.inventory` job pulls serial/model/firmware/mode → `network_devices` |
| SSID/NAS config fragments | **Existing**: `PATCH /api/access-points/:serial/configuration/overrides`, `POST …/configuration/apply`, `GET …/configuration/{effective,diff,history}`, `POST …/rollback` (VERIFIED `ap_device_config_routes.ts` L244-632). **Proposed addition**: `PUT /api/access-points/:serial/policy-fragments/:fragmentId` carrying only `ssids[].rate-limit`, `ssids[].radius.{authentication,accounting,dynamic-authorization,nas-identifier}`, `captive.{uam-*, acct-*, idle-timeout, session-timeout, walled-garden-*}` — validated by the controller against `ucentral.full.json`, merged as an override layer, applied with its existing `ap_apply.ts` path | `openwifi-config` adapter emits the fragment (`NETWORK_INTEGRATION.md §7.3`); result stored in `policy_translations(trigger='config_push')` |
| Device state / telemetry | **Existing** data: `state.interfaces[].ssids[].associations[]` already parsed into `ap_clients` (VERIFIED `ucentral_gateway.ts` `collectAssociations`). **Proposed**: controller webhook `POST <ECLOUD>/internal/adapters/openwifi/devices/{serial}/state` on each `state` event (or ECLOUD polls a proposed `GET /api/access-points/:serial/clients`) | telemetry adapter correlates by MAC with `sessions`; secondary to RADIUS accounting |
| Auth between systems | **Reuse controller API keys**: `ezk_` keys, SHA-256 stored, `X-API-Key` or Bearer, `write` scope gates mutations, permission `device.config_push` for apply (VERIFIED `server.ts` L1704-1748, `lib/permissions.ts`). ECLOUD stores the key in `EZE_CONTROLLER_API_KEY_FILE`, one key per ECLOUD platform, scoped to the operator user the owner designates | Controller → ECLOUD webhook authenticates with an ECLOUD platform API key (`platform_support`-like template restricted to the webhook route) or mTLS over the tunnel |
| Failure semantics | Controller `apply` returns rejected keys / "Already applied" (VERIFIED `ap_apply.ts` L475-528) | map to `policy.push_result{status: applied|rejected|noop, rejected[]}`; retries per `adapters.openwifi.push` |

Everything in this section that touches real APs is **REQUIRES DEVICE TEST** (rate-limit semantics, DAE reachability, uspot attribute handling — `NETWORK_INTEGRATION.md §11`).

---

## 7. Non-functional requirements

| Topic | Target / rule (PROPOSED) |
|---|---|
| Latency | `/internal/aaa/authorize` p95 < 100 ms, p99 < 250 ms (budget: tenant+identity lookup 2 queries ≤ 20 ms, policy resolve ≤ 20 ms with per-org policy cache 30 s, adapter translate < 5 ms, audit/translation insert async). `/internal/aaa/accounting` p95 < 30 ms (insert + enqueue). Admin reads p95 < 300 ms; portal page render p95 < 200 ms |
| Throughput (pilot) | 50 auth/s sustained, 200 acct packets/s burst, 500 active sessions/site × 10 sites, 20 admin users; sized to `DEPLOYMENT_ARCHITECTURE.md §2.2` memory limits. FreeRADIUS `rlm_rest` connection pool ≤ 16 |
| Observability | `GET /metrics` (Prometheus text, internal listener only): http duration histograms by route, authorize results by NAS/org, queue depth/age, CoA ack/nak/timeout, pg pool stats, outbox lag. OpenTelemetry tracing optional (`OTEL_EXPORTER_OTLP_ENDPOINT` unset = off); request id in every log line and problem response |
| Audit | Every mutating call → `audit_logs` in-transaction (§3.1); read access to `voucher:reveal` and exports also audited; audit failures fail the request |
| Input limits | JSON 1 MB; CSV import 20 MB / 50 000 rows; assets 5 MB (png/svg/jpg/webp/pdf, sniffed, SVG sanitised); list `limit ≤ 200`; time ranges ≤ 31 days for raw accounting; prototype-pollution keys stripped (precedent `_stripProto`, `server.ts` L550) |
| File storage | Branding assets to S3-compatible object storage (MinIO on pilot, A7 §6); DB stores `assets(id, organization_id, sha256, mime, bytes, key)`; portal serves via `/a/{assetId}` with immutable cache headers; no local disk state in containers |
| i18n | Problem `title`/`detail` are English with `code`; clients translate by `type`/`errors[].code`; portal strings per-site overrides (A7). `Accept-Language` honoured only by the portal |
| Versioning | URL major version `/api/v1`; additive changes without bump; breaking changes → `/api/v2` with ≥ 6 months overlap; `Deprecation` + `Sunset` headers (RFC 8594) on deprecated routes; OpenAPI published per version; internal routes versioned by header `X-Internal-Version` |
| Multi-region readiness | `api`/`portal`/`worker` stateless; all state in Postgres/Redis; schedulers lock in Redis; UUID v7 ids; no local files; tenant resolution never depends on host identity — a second region needs only its own hub + DB replica promotion plan |
| Security headers | helmet defaults, CSP strict (SPA: `'self'` + hashed inline), CORS allow-list `CORS_ORIGINS`, `TRUST_PROXY=1` (Caddy), no `*` CORS (precedent `cors: origin '*'` for socket.io not reused) |

---

## 8. Repository layout and testing

```text
ecloud/
  apps/
    api/        # express app, routes/, middleware/, internal/, openapi
    portal/     # SSR templates (Eta), uam adapters client, csrf, i18n
    worker/     # bullmq processors, schedulers, radclient wrapper, wg helper client
  packages/
    db/         # migrations/*.sql (plain, forward-only), migrate runner (ported), kysely types, withTenant()
    policy-engine/   # intent model, resolution, schedules (A5b)
    adapters/   # openwifi-radius, openwifi-config (ajv vs ucentral.full.json), coovachilli-radius, uspot-uam, coovachilli-uam, generic-radius; capability matrix
    shared/     # config, logger, problem(), permissions catalogue types, events, crypto (argon2, totp, hmac)
  infra/
    compose/    # compose.yaml, compose.prod.yaml, .env.example, freeradius raddb layer, caddy fragments (not applied)
    ci/
  docs/         # this folder's design docs, ADRs
```

Tooling: pnpm workspaces, `tsc --build`, eslint + prettier, vitest; one Dockerfile with build targets `api|portal|worker` from the same image (precedent: multi-stage `node:22-bookworm-slim`, `npm ci --omit=dev`, `USER node`, `tini`).

| Layer | Scope | Tooling |
|---|---|---|
| Unit | policy resolution, adapters (intent → attributes/fragments, `unsupported[]`), permission algorithm, UAM param parsing/encoding (PAP XOR, CHAP), idempotency, problem mapping | vitest, table-driven fixtures from `CAPTIVE_PORTAL_ARCHITECTURE.md §3`, `NETWORK_INTEGRATION.md §7.2` |
| Contract | adapters validated against `ucentral.full.json` (ajv); OpenAPI schema ↔ zod round-trip; webhook payload schemas; `/internal/aaa/*` request/response fixtures shared with A3 | ajv, `openapi-diff` in CI to block breaking changes |
| Integration | real Postgres (RLS tests T-09…T-14), Redis, FreeRADIUS container with `rlm_rest` → api: `radclient` Access-Request/Accounting/Status-Server; CoA path with a FreeRADIUS `coa` virtual server as fake NAS DAS | testcontainers, `freeradius-utils` |
| E2E | admin flows via Playwright against compose stack; portal flow with a fake UAM NAS (small HTTP stub implementing `/logon`, `/logoff`, `res=` redirects) | Playwright |
| Device tests | §9 list; executed in Phase 3 lab only | manual runbook |

---

## 9. Evidence index · Open questions · Device tests

### Evidence index

| Source | Label | Used for |
|---|---|---|
| `/Users/danny/Project/ezecontroller/src/server.ts` (L484-686 middleware stack: helmet, cors, compression, `express.json 50mb`, `_stripProto`, rate limiter; L955 request id; L1704-1748 `_genApiKey`/`_authenticateApiKey`, `X-API-Key`/Bearer `ezk_`; L3744 login limiter; L889/L4274 HttpOnly SameSite cookies; L299 JWT verify; L3742 node-cron; L11891 `server.listen`; no SIGTERM handler) | VERIFIED FROM EXISTING CODE | §2, §4, §5 |
| `/Users/danny/Project/ezecontroller/src/lib/permissions.ts` (`PERMISSIONS`, `ROLE_GRANTS`, `can`, `requirePermission`) | VERIFIED FROM EXISTING CODE | §4 |
| `/Users/danny/Project/ezecontroller/src/middleware/context-scope.ts` | VERIFIED FROM EXISTING CODE | §4 tenant context middleware |
| `/Users/danny/Project/ezecontroller/src/services/{queueService,rateLimitService,loggerService,redisService}.ts`, `src/workers/{workerBase,index,*Worker}.ts`, `src/jobs/rollup_daily.ts` | VERIFIED FROM EXISTING CODE | §2, §5 |
| `/Users/danny/Project/ezecontroller/src/services/auth/{passwordService,totpService,SessionService,tokenService,GoogleSSO}.ts` | VERIFIED FROM EXISTING CODE | §4 |
| `/Users/danny/Project/ezecontroller/src/ap_device_config_routes.ts` L244-632; `src/ap_apply.ts` L475-528; `src/ucentral_gateway.ts` | VERIFIED FROM EXISTING CODE | §6 |
| `/Users/danny/Project/ezecontroller/src/ap_config_engine.ts` L12-24 (ajv + uCentral formats), `src/schemas/ucentral.full.json` | VERIFIED FROM EXISTING CODE | §2, §8 contract tests |
| `/Users/danny/Project/ezecontroller/migrations/001_auth_session_engine.sql` (`api_keys`, `security_events`, `mfa_credentials`), `src/lib/migrate.ts`, `Dockerfile`, `package.json` | VERIFIED FROM EXISTING CODE | §2, §4, §8 |
| `/Users/danny/Project/EZECLOUD/MULTITENANCY.md` §4.2–4.6, §6 | this phase (A6) | §3 permissions, §4 |
| `/Users/danny/Project/EZECLOUD/DATABASE_DESIGN.md` §3, §5, §8, §9 | this phase (A6) | §3 resources, §5 jobs, §2 DB layer |
| `/Users/danny/Project/EZECLOUD/NETWORK_INTEGRATION.md` §4, §7, §8, §11 | this phase (A2) | §1, §6 |
| `/Users/danny/Project/EZECLOUD/CAPTIVE_PORTAL_ARCHITECTURE.md` §3.2–3.3, §7 | this phase (A4) | §3 portal endpoints |
| `/Users/danny/Project/EZECLOUD/WIREGUARD_ARCHITECTURE.md` §8 | this phase (A1) | §3 peers, §5 reconcile |
| `/Users/danny/Project/EZECLOUD/DEPLOYMENT_ARCHITECTURE.md` §2–4, §7 | this phase (A1) | §1, §2 config |
| `/Users/danny/.claude/jobs/6ede8b14/tmp/p2/a7_frontend.md` §2–6 | this phase (A7) | §3 data needs, §4 cookie |
| RFC 9457 (problem+json), RFC 8594 (Sunset), RFC 6238 (TOTP), RFC 5176 (CoA) — https://www.rfc-editor.org/ | VERIFIED FROM OFFICIAL DOCUMENTATION | §3, §4, §7 |
| Framework/library choices, endpoint list, queue design, latency targets, Option A controller contract | PROPOSED | §1–§8 |

### Open questions for owner

1. Admin app and API on separate subdomains (`ecloud.` + `api.ecloud.`) or same-origin `/api` on `ecloud.`? Same-origin keeps the cookie `__Host-` prefixed and removes CSRF complexity (recommended).
2. Who owns and schedules the ezecontroller "policy fragment" API and state webhook (Option A)? Which controller user/API key would ECLOUD use?
3. Is Platform Support impersonation acceptable with the proposed guardrails (no key creation / secret rotation / binding changes while impersonating)?
4. Are third-party integrations (billing, PMS, CRM) expected in release 1? That decides whether API keys and webhooks are a pilot deliverable or Phase 4.
5. Object storage for assets/backups: MinIO on the VPS or an external bucket (ties to A1 Q18)?
6. Voucher `print` reveals codes — should it require MFA re-prompt (step-up) in addition to `voucher:reveal`?
7. Required SSE/live dashboards in pilot, or 30 s polling acceptable (saves a Redis pub/sub path)?
8. Permission naming in A7's table (`org.read`, `nas.write`, …) differs from the A6 catalogue (`organization:read`, `nas:update`) — confirm A6 catalogue is canonical; A7 to update.

### Items requiring a real device test

1. `/internal/aaa/authorize` reply attributes accepted end-to-end by EZEAP uspot and hostapd (WISPr/ChilliSpot bandwidth, `Session-Timeout`, `Idle-Timeout`, `ChilliSpot-Max-Total-Octets`) — drives which policy fields the API marks `supported` per adapter.
2. CoA/Disconnect dispatch from the worker (`radclient` from hub IP `100.100.0.1`) to `dynamic-authorization.port`: identification attributes, ack/nak/timeout behaviour that the `session_actions` state machine must model.
3. Accounting cadence and fields (`Acct-Interim-Interval`, octets, `Acct-Unique-Session-Id` presence) from hostapd and uspot — validates ingestion idempotency keys and stale-session thresholds.
4. Option A: controller `apply` of a fragment limited to `rate-limit`/`radius`/`captive` keys — confirm no session reset side effects beyond those documented (`NETWORK_INTEGRATION.md §5`) and the shape of rejected-key responses.
5. Portal flow on real EZEAP: `uam-server` path-based adapter URL (`/uam/uspot/`) accepted, `res=` callbacks received (`final-redirect-url: uam`), `md` verification with `uam-secret`, cookie persistence inside iOS/Android CNA.
6. Controller → ECLOUD state webhook volume (one `state` per AP per ~60 s) versus `api` capacity on the pilot host.

---

## Implementation notes (Phase 3)

Status: implemented in `apps/api` on 2026-10-07 (LOCAL ONLY; nothing deployed). APPROVED DESIGN is
not VERIFIED DEVICE CAPABILITY: everything device-facing below inherits the adapter declarations of
`packages/adapters` (D-028) and stays REQUIRES DEVICE TEST where they say so.

### Structure

| Path | Role |
|---|---|
| `src/app.ts` | `createApp(deps)` → `{ publicApp, internalApp, routes, openapi }`; request id (`X-Request-Id`, echoed when well-formed, else UUID v7), pino-http (method + path only — no bodies, no query strings), helmet (CSP `default-src 'none'`), JSON body limit 1 MB public / 64 kB internal, RFC 9457 404 + error handler, `/healthz`, `/readyz` (DB `SELECT 1` + Redis `PING`, 2 s timeout) |
| `src/index.ts` / `main.ts` | two listeners (`API_PORT`/`API_BIND_HOST`, `INTERNAL_PORT`/`INTERNAL_BIND_HOST` default `127.0.0.1`); SIGTERM/SIGINT drain (`SHUTDOWN_GRACE_MS`), then pools + Redis closed |
| `src/http/route.ts` | `defineRoute()` — one declaration per endpoint (zod params/query/body, permission, scope resolver, idempotency, responses). The same list mounts Express and generates OpenAPI, so an undocumented public route cannot exist; unknown permission keys throw at boot |
| `src/openapi.ts` | OpenAPI **3.1** via `zod-openapi`; served at `GET /api/v1/openapi.json` (61 paths / 100 operations after Phase 4 P4-backend). `app.test.ts` walks the Express router stack and fails if any mounted route is missing from the document |
| `src/auth/*` | principal resolution, `evaluate()` (MULTITENANCY §4.4), sessions, TOTP, CSRF, rate limits |
| `src/routes/*` | auth, platform, access (roles/bindings/API keys/admins/invitations), policies (+ assignments, simulate), generic tenant CRUD, vouchers, runtime (sessions, audit log) |
| `src/internal/*` | `/internal/aaa/authorize`, `/internal/aaa/post-auth` per `docs/contracts/aaa-authorize.md` |

### Decisions taken while implementing

- **Tenancy.** `/orgs/{orgId}/…` handlers run inside `withTenant(db, orgId)` on `DATABASE_URL`
  (`ecloud_app`, RLS); authentication and binding lookups use
  `withPlatform(dbPlatform, {reason:'authn', audit:false})`; platform routes use
  `withPlatform(reason)` which writes the `platform:access` audit row. Every FK supplied in a
  request is re-checked inside the tenant transaction (`assertRef`, G9) because PostgreSQL FK checks
  ignore RLS. Objects of another tenant (or of an unreadable site) answer **404**.
- **Authorization.** Grants = role bindings (or the API key's single binding) + `role_permissions`,
  loaded once per request; decisions memoised per request. Route pre-check uses `organization`,
  `platform` or `any-site` scope; handlers re-check the concrete `site_id` of the row
  (`requireOnSite`). List endpoints of site-scoped resources filter by permitted sites. No role
  names in authorization code; the only role key referenced is the impersonation template
  (`IMPERSONATION_ROLE_TEMPLATE`, default `org_admin`, MULTITENANCY §4.4 step 7) as configuration.
- **Escalation guard.** Role bindings, invitations and API keys may only grant a role whose every
  permission the caller holds in the target scope; roles with platform-only keys cannot be granted
  in a tenant; adding permissions to a custom role requires holding them.
- **Sessions.** 32 random bytes (base64url) in cookie `SESSION_COOKIE_NAME` (HttpOnly,
  SameSite=Lax, Path=/, `Secure` in production or with `SESSION_COOKIE_SECURE=true`), SHA-256 in
  `admin_sessions.token_hash`, absolute TTL `SESSION_TTL_SECONDS`, idle timeout
  `SESSION_IDLE_SECONDS` (default 1800) from `last_seen_at` (updated at most once a minute).
  The `__Host-` prefix needs HTTPS; production should set `SESSION_COOKIE_NAME=__Host-ecloud_sid`.
- **Login.** Argon2id via `@ecloud/db` (`ARGON2_MEMORY_KIB`), unknown emails verified against a
  dummy hash, one generic 401; per-IP limit 30 / 5 min, per-account 10 failures / 5 min → 15 min
  lockout (429 + `Retry-After`); limits FAIL CLOSED (503) when Redis is down. Success / failure
  are audited (`auth:login`, `auth:login:failed`).
- **MFA.** TOTP (otplib v13, ±30 s). Secret sealed AES-256-GCM with a key derived (HKDF) from
  `MFA_ENCRYPTION_KEY` into `mfa_credentials.secret_enc`; 10 recovery codes stored SHA-256, shown
  once, single use. With a verified credential, login returns `{mfa_required, mfa_token}` (Redis,
  5 min, 5 attempts) and `/auth/mfa/verify` creates the session. **Enforced** (SECURITY §6.2):
  `admin_sessions.mfa_verified_at` (migration 013) is set by `/auth/mfa/verify` and by
  `/auth/mfa/confirm` in the enrolling session; an impersonation session inherits it. A session of
  an administrator with `mfa_enforced` or any platform binding that has not proved a factor holds
  **no permissions** (only enrol/confirm, `/auth/me` → `mfa.pending: true`, logout). Login reports
  `mfa_enrolment_required` for both cases.
- **CSRF.** Unsafe methods on cookie sessions — and the cookie-issuing public POSTs (login, MFA
  verify, accept-invitation) — require `Origin` (or `Referer`) = `PUBLIC_ADMIN_ORIGIN` and a
  non-empty `X-Requested-With`. Bearer API keys are exempt.
- **API keys.** `eck_<12 alnum>_<43 base64url>`; `key_prefix = eck_<12>` (schema CHECK), `key_hash`
  = SHA-256 of the full key, constant-time compare, `allowed_cidrs` via `net.BlockList`,
  `expires_at` ≤ 1 year, `last_used_at` throttled; organization or site scope only from tenant
  routes (platform keys are not issued by the API in Phase 3).
- **Impersonation (D-027).** `POST /api/v1/platform/support/impersonate {organizationId, reason,
  ttlMinutes ≤ 60}` needs `tenant:impersonate` on a platform binding and an admin *session*. It
  creates a separate `admin_sessions` row with `impersonating_organization_id`,
  `impersonation_reason` and `expires_at = now + ttl`, swaps the session cookie and keeps the
  original token in `<cookie>_parent` (restored on `DELETE …/impersonate` or automatically when the
  impersonation expires). Effective permissions = the configured template at organization scope
  of the target only; platform keys off. Every response carries `X-ECLOUD-Impersonating: <orgId>`;
  every audit row carries `impersonator_id`; start/stop audited as `tenant:impersonate` /
  `tenant:impersonate:end`. Refused with problem type `urn:ecloud:problem:impersonation-forbidden`:
  API-key creation, NAS secret rotation, role-binding create/delete, invitations, nested
  impersonation.
- **Audit.** One `audit_logs` row per mutation in the same transaction (actor, impersonator,
  organization, action = permission key, target, before/after with secret columns stripped, ip,
  request id, user agent). The route wrapper logs `mutation not audited` if a 2xx mutation did not
  write one.
- **Idempotency.** `Idempotency-Key` (UUID) on POST; required for voucher batches, API keys,
  invitations and NAS secret rotation, optional elsewhere. Stored 24 h in Redis per principal +
  route + key with a body fingerprint; replay → stored response + `Idempotent-Replayed: true`;
  different body → 422 `idempotency-conflict`; concurrent duplicate → 409; missing when required →
  428. **Secrets shown once (API key, NAS secret, voucher codes, invitation token) are removed
  from the stored response** and named in `Idempotent-Redacted`.
- **Concurrency.** `ETag` = `"<updated_at ISO>"`; `If-Match` honoured on every PATCH (412).
- **Pagination.** Cursor = opaque base64url of the last id (`?limit≤200&cursor=`), ascending
  UUID v7 order; sessions and audit log newest first.
- **NAS secrets.** Generated server-side (32 random bytes, 43 chars), returned once; stored as
  `secret_ref = enc:v1.<iv>.<ciphertext>.<tag>` (AES-256-GCM under a key derived from
  `DATA_ENCRYPTION_KEY`). This is the A5 decision for DATABASE_DESIGN §1 "Secrets": the `enc:`
  prefix leaves room for `vault:`/`file:` references later. The clients.conf renderer must decrypt
  with the same key (not implemented here).
- **Vouchers.** Codes from the 32-symbol alphabet (no 0/O/1/I), length 8–16 (default 10),
  `code_hash = HMAC-SHA-256(VOUCHER_PEPPER, upper(code))`, `code_hint` = last 3 characters,
  `code_enc` NULL (A6 Q4 default hash-only: no re-print). Synchronous generation capped at 1000.
  **D-037** (migration 017): `duration_s` allows re-login until `expires_at` (first use +
  duration), `max_uses` allows that many logins, both apply when both are set. `max_uses` is
  nullable: the API default is `null` when `duration_s` is given and `1` otherwise; a batch with
  neither limit is a 400. `POST …/voucher-batches/{id}/export` (`voucher:export`, 10/h per
  principal, fail-open limiter) returns `text/csv` with metadata only (id, `code_hint`, status,
  use count, activation/expiry, batch limits) — plaintext codes exist only in the creation
  response; cells starting with `= + - @` are neutralised against CSV injection; audited.
- **Policies.** `validatePolicy` with the stored context (existing default, assignments, previous
  version); a change of an enforcement field bumps `version` (rule 11); response carries
  `warnings`. `GET /orgs/{orgId}/policies/simulate?user_id|client_device_id&site_id&at&adapter`
  runs `simulate()` over the loaded candidates (permission `policy:preview`).
- **Adapters.** `GET /platform/adapters` returns, per engine adapter, every policy field with its
  four-state status + evidence, Disconnect/CoA/MAC-auth flags, attribute statuses, plus the
  `adapter_types` rows (`engine_adapter` = the key itself after migration 015; `legacy: true` for
  a pre-015 key still referenced by an unmapped row).
- **NAS adapter (D-035).** `POST /orgs/{orgId}/nas` requires `adapter_key` ∈
  {`openwifi-hostapd-radius`, `openwifi-uspot-uam`, `uspot-upstream-uam`, `coovachilli-uam`}
  (`openwifi-config` is SSID configuration, not a RADIUS client); `adapter_type_key` is derived
  from it and is no longer accepted in the body. PATCH may change `adapter_key`.
- **Administrators.** `GET /platform/administrators` (+ `?status`, `?q` email prefix),
  `GET/PATCH /platform/administrators/{id}`, `GET/PATCH /orgs/{orgId}/administrators/{id}`
  (`src/routes/administrators.ts`). PATCH `{display_name?, status?: active|disabled,
  mfa_enforced? (platform only)}`; a status change needs `administrator:disable`, is refused on
  oneself and for `invited` accounts, and disabling revokes every session of the target. The
  caller must hold every permission of every target binding in its scope (escalation guard). The
  organization route only changes administrators whose bindings all belong to that organization
  (others → 403, "ask a platform administrator"); administrators without a binding there → 404.
  Refused while impersonating. All on the platform connection (audited `platform:access`), with
  `administrator:update` / `administrator:disable` audit rows (organization id on the tenant
  route).
- **MFA reset (D-038).** `POST /platform/administrators/{id}/mfa/reset {reason}` — permission
  `administrator:mfa_reset` (platform-only, minimum scope platform, held by
  `platform_super_admin` only; seeded by `ecloud-db seed`), admin *session* only, refused while
  impersonating and on oneself (422). In one transaction: deletes the target's
  `mfa_credentials`, sets `administrators.mfa_reenrol_required` (migration 018), revokes all of
  the target's `admin_sessions`, writes `administrator:mfa_reset` with the reason. While the
  flag is set every session of the target holds no permissions (same gate as `mfa_enforced`);
  login answers `mfa_enrolment_required: true`, `/auth/me` reports `mfa.reenrol_required`;
  `/auth/mfa/confirm` clears it. No self-service MFA disable exists.
- **Platform operations** (`src/routes/platform-ops.ts`). `GET /platform/role-templates`
  (`role:read`, read-only: templates are owned by the seed), `GET /platform/audit-log`
  (`audit_log:read` on a platform binding; filters `organization_id`, `platform_only`, `action`,
  `actor_id`, `target_id`, `from`, `to`; newest first), `GET /platform/health`
  (`platform:health:read`; always 200 with `status: ok|degraded`: DB + Redis probes (2 s),
  BullMQ depths per queue from Redis (`null` with the in-memory KV), latest migration, open
  session counts incl. oldest `authorized`, partition horizon per partitioned table, NAS rows
  without `adapter_key`; FreeRADIUS Status-Server and WireGuard handshakes are reported
  `not_checked` — they are host/infra probes, not API-process facts).
- **Self sessions.** `GET /me/sessions` (own live sessions, `current` flag, no token material),
  `DELETE /me/sessions/{id}` (own only, else 404; revoking the current one clears the cookie;
  audited `auth:session:revoke`).
- **Users import.** `POST /orgs/{orgId}/users/import` (`user:create`, `Idempotency-Key`
  required) with JSON `{csv, dry_run?}` (or `?dry_run=true`); ≤ 500 rows, header row with known
  columns only (`username` required, `password`, `display_name`, `email`, `phone`, `site_id`,
  `user_group_id`, `status`, `valid_from`, `valid_until`, `max_devices`, `auth_methods`
  `;`-separated). Every row is validated with the `POST /users` schema, duplicate usernames and
  references (`site_id`, `user_group_id`, re-checked in the tenant) fail the whole import with
  400 `errors[].path = body.csv.rows[<line>].<column>`; per-row site authorization. Existing
  usernames are skipped (idempotent re-run); one `user:create` audit row (`target_type =
  user_import`) per committed import; a dry run writes nothing. JSON instead of multipart keeps
  the 1 MB body limit and avoids a multipart dependency.

### AAA (`docs/contracts/aaa-authorize.md`)

- `X-Internal-Token` compared in constant time; mismatch → `401` with an empty body.
- NAS resolution: `nas_clients.nas_ip = ECLOUD-Packet-Src-IP-Address`, else
  `ECLOUD-Client-Shortname` when it is a NAS id. Both are server-side facts bound to the client's
  shared secret. NAS-Identifier / NAS-IP-Address are NAS-supplied and **never select a tenant**
  (SECURITY §3.2; the earlier "unique NAS-Identifier" fallback let any accepted client claim
  another tenant's NAS). When the record and the request both carry a NAS-Identifier they must
  match.
- Subjects: subscriber `users` (case-insensitive username, Argon2id, status, validity, site
  restriction), vouchers (User-Name = code, PAP password must equal the code, HMAC lookup,
  `FOR UPDATE`, batch site restriction), MAC authentication (`Service-Type = Call-Check` →
  `client_devices.mac_auth_enabled`). Blocked client devices are rejected. CHAP is rejected
  (ECLOUD stores only one-way hashes). Portal single-use credentials (`pc-<16 hex>`, identity
  broker, Phase 6 P6-A): kept in Redis for 90 s (SHA-256 of the password only), accepted only from
  the bound NAS (packet source) + Calling-Station-Id + Acct-Session-Id, consumed once (SET NX),
  identity re-checked; their decision is cached for 30 s (NAS retransmit horizon) so retransmits
  get the same Class (`apps/api/src/internal/portal-credential.ts`).
- Ordering (B-3, P10-B load test, docs/PERFORMANCE.md): the Argon2id verify never runs while a
  pg connection is held. Subscriber-password authorize = `resolveNas` (platform tx) → short tenant
  tx (RLS-scoped exactly as the decision: site/org state + `users` row by lower(username)),
  released → Argon2id verify outside any tx, through `internal/verify-gate.ts` (at most
  UV_THREADPOOL_SIZE concurrent verifies; a verify that cannot start within 5 s → `503`, the same
  fail-closed answer the old 5 s pool wait gave; never a credential reject) → decision tenant tx:
  site re-check, fresh `users` re-read; the credential must be unchanged since the verify (same
  row id, byte-identical hash, same `password`-method flag, `credentialUnchanged()`), otherwise
  reject `credential_changed` (also when no verify ran because the site was inactive at pre-read);
  status/site/validity are evaluated on the fresh row (a user disabled during the verify gets
  `user_disabled`; a deleted one falls to the voucher lookup → `bad_credentials`). Unknown
  usernames still cost no Argon2id on this path (unchanged; vouchers share it). The captive-portal
  identify (`internal/portal.ts`) uses the same order (pre-read portal + user → verify, dummy hash
  for unknown users as before → decision tx with `confirmSubscriberLogin`); lockout counters,
  `portal_login_attempts` rows and reasons are unchanged. Tests:
  `apps/api/src/aaa-password-verify.integration.test.ts` (pool of 1, TOCTOU, overload 503),
  B-3 cases in `portal.integration.test.ts`, `internal/verify-gate.test.ts`.
- Policy: `loadResolutionInput` (assignments by site/user/group/device/voucher batch, schedules,
  org default, usage counters for the site's local day/month, active sessions) →
  `resolveEffectivePolicy` → adapter `translate` + `buildReplyAttributes` (non-experimental only).
- Response: `control:Auth-Type = Accept` (ECLOUD verified the credential itself), reply attributes
  in object form with `"do_xlat": false`, `CoovaChilli-*` names rewritten to `ChilliSpot-*`,
  `reply:Class = ai:<32 hex of the session UUID>`; never `User-Password`, `Cleartext-Password` or
  any other control item. Rejects → `401` + `reply:Reply-Message` (generic text; the internal
  reason goes to logs/auth_events only). Any backend error → `503` (FreeRADIUS `fail` → reject).
- Adapter (D-035, `src/nas-adapter.ts`): the engine adapter is `nas_clients.adapter_key`; there
  is no alias map any more (`src/adapter-map.ts` and the worker's `adapter-keys.ts` were
  removed). A legacy row without `adapter_key` (pre-015 `openwifi_ucentral` / `generic_radius`)
  gets **no adapter**: the reply carries only Auth-Type and Class and
  `policy_translations.unsupported` records why. `policy_translations.adapter_type_key` records
  the engine key.
- Session row (D-036): inserted at authorize with `status = 'authorized'`, `acct_unique_id =
  <Class>` as placeholder until accounting arrives (the worker correlates by Class),
  `policy_id/version`, MAC, NAS, voucher/user/device; the worker drain promotes it to `active` on
  the first Accounting-Start (or Interim), and the `sessions.reap` job expires authorizations
  without accounting after `WORKER_AUTHORIZATION_TTL_S` (default 300 s) as `expired` /
  `authorization_expired` (a late Start revives it). Concurrency (`loadResolutionInput`) counts
  `authorized` + `active`. A `policy_translations` row (`trigger = 'authorize'`) records the
  snapshot, emitted attributes and unsupported fields. Vouchers are consumed in the same
  transaction (first use sets `activated_at` / `expires_at = now + duration_s`; a voucher whose
  `use_count` reaches `max_uses` becomes `exhausted`; an elapsed `expires_at` is rejected with
  `Voucher expired`, D-037).
- Retransmits: decision cached 10 s in Redis under SHA-256(src IP, Acct-Session-Id,
  Calling-Station-Id, User-Name, SHA-256(User-Password)); a retransmit gets the identical answer
  (same Class, no second voucher use, one session row); a different password does not hit the
  cache. The password is never logged, persisted or used as a cache key in clear.
- `post-auth` writes `auth_events` (`organization_id` NULL for unknown NAS, via the platform
  connection) and, on a final reject (e.g. local PAP mismatch), marks the provisional session
  `stopped` with `terminate_cause = 'auth-rejected'` (from `authorized` or `active`). It always
  answers 204. On a decision-cache
  miss the `ECLOUD-Reply-Class` session is used only when it belongs to the NAS that sent the
  packet; a Class replayed from another NAS attributes nothing and closes nothing.

### Implemented endpoints (public, `/api/v1`)

`auth/login`, `auth/mfa/verify`, `auth/mfa/enrol`, `auth/mfa/confirm`, `auth/logout`, `auth/me`,
`auth/accept-invitation`; `platform/organizations` (GET/POST), `platform/organizations/{id}`
(GET/PATCH/DELETE), `platform/adapters`, `platform/support/impersonate` (POST/DELETE);
`orgs/{orgId}` (GET/PATCH); under `orgs/{orgId}`: `sites`, `network-devices`, `nas`
(+ `nas/{id}/rotate-secret`), `users`, `user-groups`, `client-devices`, `schedules` (each
GET list/POST, GET/PATCH/DELETE by id), `policies` (CRUD + `policies/simulate`),
`policy-assignments` (GET/POST, DELETE by id), `roles` (GET/POST, GET/PATCH/DELETE by id),
`role-bindings` (GET/POST, DELETE by id), `api-keys` (GET/POST, DELETE by id), `administrators`
(GET), `invitations` (GET/POST), `voucher-batches` (GET/POST, GET by id, GET `/{id}/vouchers`),
`vouchers/{id}/revoke`, `sessions` (GET, GET by id), `audit-log` (GET). Internal:
`/internal/aaa/authorize`, `/internal/aaa/post-auth`.

Added in Phase 4 (P4 backend, 2026-10-07): `me/sessions` (GET), `me/sessions/{id}` (DELETE);
`platform/administrators` (GET), `platform/administrators/{id}` (GET/PATCH),
`platform/administrators/{id}/mfa/reset` (POST), `platform/role-templates` (GET),
`platform/audit-log` (GET), `platform/health` (GET); under `orgs/{orgId}`:
`administrators/{id}` (GET/PATCH), `users/import` (POST), `voucher-batches/{id}/export` (POST,
`text/csv`).

### Not implemented yet (deliberately)

`/reports/*` (P8-A ships `usage`, `usage/top`, `usage/export`, `accounting/records`,
`accounting/export` instead, see "P8-A" below), webhooks, WireGuard peers, identity providers (captive portals,
portal themes/assets: implemented in P6-B, see below), users export, `users/{id}/reset-password` and `effective-policy`
(covered by PATCH `password` with `user:password:reset` and by `policies/simulate`),
`policies/{id}/preview`, voucher print and code reveal (hash-only default: there is nothing to
reveal), `/platform/settings`,
`POST /platform/administrators` (platform invitations), `PATCH /platform/role-templates`
(templates are owned by `ecloud-db seed`; editing them in the DB would be reverted on the next
seed), self-service MFA disable (D-038: not provided), async import/export jobs (`/jobs`),
`/internal/aaa/accounting`, `/internal/aaa/clients`, `/internal/portal/idp/*` (Q64: no social
IdP in the pilot), SSE.

### Implementation notes (Phase 6 P6-A, captive portal)

- `/internal/portal/redirects` (UAM entry + `res=` callbacks), `/internal/portal/flows/{id}`
  (page data), `…/identify` (password | voucher | click_through → single-use credential →
  adapter `authorizeSession` hand-off URL), `…/status`, `…/logout`
  (`apps/api/src/internal/portal.ts`). `resolve-nas` is folded into `redirects` so a NAS is never
  resolved without verifying the signed redirect in the same step; every validation failure
  answers one generic `{kind:"error"}`. Flows (15 min), the replay store (24 h) and credentials
  (90 s) live in Redis; no migration was needed. UAM secrets: `captive_portals.uam_secret_ref`
  sealed with the data key, purpose `ecloud:nas:secret:v1` (`sealUamSecret`).
- Portal public routes are served by `apps/portal` (server-rendered, no script, CSP
  `default-src 'none'`, form-action limited to the flow's `http://uamip:uamport`).
- Abuse limits as implemented (`PORTAL_LIMITS`): per NAS + client MAC 5 password failures / 5 min
  → 15 min lock, 10 voucher failures / h → 1 h lock; per (site, lower(username)) 10 failures /
  15 min → 15 min lock regardless of MAC/IP; per site 100 voucher failures / h → 15 min voucher
  lock; 60 attempts / 10 min per client IP; 2 000 / 10 min per site; 60 redirects / min per IP;
  300 flows / h per NAS. Every lock is the same generic 429. Rejections share one generic body;
  an unknown username still runs one Argon2id verification against a dummy hash, but response
  timing is **not** claimed to be constant (the "constant-time" wording above is the design
  target, not a verified property). Behind Caddy, per-IP limits require
  `PORTAL_TRUST_PROXY_HOPS=1` (DEPLOYMENT_ARCHITECTURE.md VPS change list).
- The decision for a portal credential is cached 30 s (NAS retransmit horizon).

### Open questions raised by the implementation

1. ~~`adapter_types` keys vs the five engine adapters.~~ **Resolved by D-035** (migration 015,
   `nas_clients.adapter_key`; see "NAS adapter" and AAA "Adapter" above).
2. ~~`sessions.status` has no `authorized` state.~~ **Resolved by D-036** (migration 016,
   `authorized` → `active` on Accounting-Start, `expired` after the worker TTL; concurrency
   counts both open states).
3. ~~Voucher semantics of `max_uses` with `duration_s`.~~ **Resolved by D-037** (migration 017:
   both limits apply when both are set; `max_uses` NULL = no count limit).
4. ~~MFA enforcement for platform bindings is reported, not blocking.~~ Resolved in M8 per
   SECURITY_ARCHITECTURE §6.2: blocking (see "MFA" above). ~~MFA reset for a lost device.~~
   **Resolved by D-038** (`POST /platform/administrators/{id}/mfa/reset`, migration 018; see
   "MFA reset" above). Self-service MFA disable is deliberately not provided.
5. Legacy NAS rows that migration 015 could not map (`openwifi_ucentral`, `generic_radius`) stay
   without `adapter_key` until an operator sets it; `GET /platform/health` reports their count
   (`nas.without_adapter_key`). The lab AP EZE-AP1832 is TIP-fork uspot (DT-01), i.e.
   `openwifi-uspot-uam` — the operator chooses; nothing is guessed in SQL.

### Implementation notes (M10)

- **Object storage (D-026).** `@ecloud/storage` (`packages/storage`) provides the `ObjectStorage`
  interface, tenant-scoped keys `org/{organizationId}/{purpose}/{id}` (lower-case ids),
  per-purpose content-type allow-list + magic-byte check + size limit (`branding`: PNG/JPEG/WebP
  ≤ 5 MiB; SVG rejected), and two drivers behind `createStorage(config.storage)`: `local`
  (STORAGE_LOCAL_PATH, pilot/dev, non-critical assets only; refused in production unless
  `STORAGE_LOCAL_ALLOW_PRODUCTION=true`) and `s3` (S3-compatible endpoint from `S3_*`, `https://`
  required in production). Verified: the shared contract passes against the local driver in
  `npm test`, and against RustFS only (throwaway container, 2026-10-08); AWS S3/R2/B2/Wasabi are
  untested. This supersedes the "MinIO on pilot" wording under "File storage" above: no MinIO on
  the VPS. **Not wired into `apps/api`**: no implemented endpoint stores files yet (`{o}/assets` /
  portal themes are listed under "Not implemented yet"), so `/readyz` is unchanged. When the asset
  endpoint lands it must use `forTenant(storage, orgId)`, add `storage.checkHealth()` to
  readiness, cap the request body itself, and serve bytes with `Content-Type` from stored
  metadata plus `X-Content-Type-Options: nosniff` (see `packages/storage/README.md`).

### Implementation notes (P6-B, portal administration, 2026-10-08)

- **Endpoints** (`apps/api/src/portal-admin/routes.ts`, all under `/api/v1/orgs/{orgId}`, one audit
  row per mutation): `captive-portals` (CRUD, site-scoped; `auth_methods` ⊆ `password`, `voucher`,
  `click_through` — `idp`/`mac` refused, Q64; `uam_secret_ref` never returned, only
  `uam_secret_configured`; `social_login: "not_configured"`), `captive-portals/{id}/terms`
  (GET versions / POST `{texts: {locale: body}}` → new immutable version, sets
  `captive_portals.terms_version`), `portal-themes` (CRUD; colour tokens `#rrggbb` only, WCAG AA
  4.5:1 enforced → 422 `contrast_issues`; `strings` per locale; `logo_asset_id`; `custom_css` not
  accepted; `version` bumps on PATCH), `portal-assets` (POST raw image body — **deviation**: raw
  `image/png|jpeg|webp` body instead of multipart; GET list/meta, GET `/{id}/content`, DELETE → 409
  while a theme uses it), `portal-previews` (POST → 5-min ticket bound to principal + org; GET
  serves the page HTML under `default-src 'none'; style-src 'unsafe-inline'; img-src data:;
  frame-ancestors 'self'; sandbox`).
- **Permissions**: new `portal_asset:{read,create,delete}` (organization); templates list the
  portal keys explicitly; operator / read_only / platform_support are read-only
  (`captive_portal:read`, `portal_theme:read`, `portal_asset:read`); site_admin keeps
  `captive_portal:{read,update}`.
- **Storage**: `deps.storage = createStorage(config.base.storage)`; keys via `forTenant` →
  `org/{orgId}/branding/{assetId}`; migration 021 pins `portal_assets.storage_key` to exactly that
  prefix (CHECK); `/readyz` adds `storage`. The upload body is capped by `express.raw` (5 MiB)
  after the authorization pre-check.
- **Portal origin `/a/{assetId}`**: the portal proxies `GET /internal/portal-assets/{assetId}`
  (internal listener, `X-Internal-Token`): stored Content-Type, `nosniff`, sandbox CSP, `ETag` =
  SHA-256, `Cache-Control: public, max-age=86400` (one day, so a deleted logo stops being served
  by caches within a bounded time; review finding 4), 304 on `If-None-Match`. **Accepted risk
  (review finding 2):** any asset is fetchable by its random UUID without a tenant check —
  branding is shown before login and is public by design.
- **UAM secret** (`POST captive-portals/{id}/rotate-uam-secret`, `captive_portal:secret:rotate`,
  org_admin + platform_super_admin only, `Idempotency-Key` required): the server generates a
  32-char secret, seals it with `sealUamSecret` (P6-A, purpose `ecloud:nas:secret:v1`) into
  `uam_secret_ref`, returns it once (`secretFields`, `Cache-Control: no-store`); refused while
  impersonating (D-027); audited as `{uam_secret_configured, rotated}` only. `uam_secret_ref` is
  in the audit `SECRET_KEYS`, so no portal snapshot carries the envelope.
- **Preview contract**: `RenderPortalPreview` in `@ecloud/shared/portal-theme`; the API calls
  `renderPreview` exported by `@ecloud/portal` (P6-A templates, inline mode) with sample data and
  the logo inlined as a `data:` URI (≤ 1 MiB).
- **Migration 021** (`portal_assets`, `portal_terms_versions`, `uq_captive_portals_org_id`):
  additive, RLS forced; `ecloud_app` has no UPDATE on either table (terms are immutable).
- **Hotspot binding** (`captive-portals` POST/PATCH, `captive_portal:create|update`, audited via
  the `adapter_config` snapshot): `uam_server_url` → `adapter_config.uam_server_url` (same origin
  as `PUBLIC_PORTAL_ORIGIN` — never another host —, https unless the configured portal origin is
  itself http (local dev), no userinfo/query/fragment, path `/uam/uspot/` for `uspot` or
  `/uam/chilli/` for `coovachilli`; null = portal default) and `nas_client_id` →
  `adapter_config.nas_client_id` (a NAS of the same organization **and** the portal's site, G9;
  null = unpinned). Changing `portal_type` re-validates a stored URL.
- **Onboarding order**: (1) create the portal; (2) set the NAS pin and the UAM server URL;
  (3) `rotate-uam-secret` — mandatory, no secret is generated on create; (4) configure the NAS
  with the UAM server URL and the secret shown once. Until step 3 the portal has no secret and
  P6-A's flow fails closed.
- **Migration 022**: `portal_themes.logo_asset_ref` becomes `uuid` with a same-tenant composite FK
  `(organization_id, logo_asset_ref) → portal_assets` (ON DELETE RESTRICT); unresolvable values
  are cleared first. A delete racing a logo assignment now fails (API answers 409).

### Implementation notes (P7-A, enforcement orchestration, 2026-10-08)

Binding sources: POLICY_ENGINE.md §5.3 (policy edit → propagation), §5.1–5.2 (runtime loop),
AAA_ARCHITECTURE.md §6 / §14 W6–W7 (dispatcher, `enforcement pending`), DECISIONS.md D-006,
D-028 (V12: never device-enforced without LAB/PRODUCTION evidence), Q44 (30 min Session-Timeout
cap), Q45 (300 s drain floor), Q67 (fallback + amber flag).

#### Session-enforcement API contract (consumed by P7-B admin views)

All responses are tenant-scoped (`withTenant`, RLS) and site-filtered by the caller's bindings.
No new permission keys: the views use `session:read`, the impact preview uses `policy:preview`.

**Strategy enum** (`strategy`): `coa_change` | `disconnect_reauth` | `next_reauth` | `none`.
Chosen per session from the session NAS adapter's evidence
(`@ecloud/policy-engine` `chooseEnforcementStrategy`):
`coa_change` only when `coaChange.status = VERIFIED_SUPPORTED` **and** the registry presents the
cell device-enforced (LAB/PRODUCTION evidence with a DT reference) **and** the CoA dispatcher is
enabled; `disconnect_reauth` likewise for `disconnect`; otherwise `next_reauth` (the change applies
at the session's next Access-Request, bounded by the emitted Session-Timeout, which AAA caps at
`AAA_SESSION_TIMEOUT_CAP_S`, default 1800 s per Q44). `none` = no NAS adapter (state
`unsupported`). Today no adapter has lab evidence, so the result is always `next_reauth` or
`unsupported`.

**State enum** (`state`, each change also carries `state_meaning` in plain words):
`pending` (waiting: the session still runs with the policy it was authorized with) | `applied`
(**the session ended; the next login uses the current policy** — not a device confirmation;
`resolution = "session_closed"`) | `unsupported` (nothing can apply it: NAS without engine
adapter) | `superseded` (a newer policy change replaced it, or `resolution = "reverted"`: a
later change brought the session back to its authorized policy). At most one `pending` row per
session. A pending row is never superseded across triggers when it carries a runtime breach:
later triggers are merged into its `triggers` list.

**Trigger enum** (`trigger`): `policy_update` | `policy_delete` | `assignment_create` |
`assignment_delete` | `quota_breach` | `schedule_end` | `concurrency`.

1. `GET /api/v1/orgs/{orgId}/session-enforcement` — permission `session:read` (any-site).
   Query: `limit`, `cursor`, `site_id?`, `state?` (`pending|applied|unsupported|superseded`),
   `open_only?` (default `true`: sessions in `authorized|active`). Response page
   `{data: SessionEnforcementSummary[], next_cursor}` where
   ```
   SessionEnforcementSummary = {
     session_id, status, site_id, nas_client_id, adapter_key|null, username, mac|null,
     started_at, policy_id|null, policy_name|null, policy_version|null,
     pending_change: EnforcementChange|null,
     amber_fields: string[],          // set fields whose status is REQUIRES_DEVICE_TEST or ECLOUD_SIDE_ONLY
     unsupported_fields: string[],    // set fields whose status is UNSUPPORTED
     device_enforced_fields: string[] // V12; always [] until a DT lab-validates a cell
   }
   ```
2. `GET /api/v1/orgs/{orgId}/sessions/{id}/enforcement` — permission `session:read` (site check
   on the session's site). Response `SessionEnforcementView`:
   ```
   {
     session_id, status, site_id, nas_client_id, adapter_key|null, adapter_version|null,
     snapshot: { policy_id|null, policy_version|null, hash|null, authorized_at|null,
                 effective: { <POLICY_FIELDS>: value|null, schedule: {...}|null } } | null,
     attributes_sent: [{ name, value, field|null, fields: string[],  // first / all policy fields carried
                         status|null, evidence_level|null, device_enforced:false }],
     fields: [{ field, value, set, status, evidence, evidence_level|null, device_enforced,
                mechanism: 'radius'|'ecloud_side'|'none'|'not_set', attributes: string[],
                amber, detail? }],
     unenforceable: [{ field, status, reason, detail? }],   // as stored at authorize
     session_timeout: { value_s|null, sent: boolean, expected_reauth_by|null },
     strategy_evidence: {
       coa_change: { status, evidence_level|null, device_enforced },
       disconnect: { status, evidence_level|null, device_enforced },
       dispatcher_enabled: boolean,   // API view of ECLOUD_COA_ENABLED (false by default, D-006)
       strategy                       // what a change made now would use
     },
     pending_change: EnforcementChange|null,
     history: EnforcementChange[],    // newest first, max 20
     counter_anomalies: [{ id, counter, previous, observed, estimated_lost_bytes, applied,
                          reason, created_at }]
   }
   EnforcementChange = { id, change_id, trigger, triggers: string[], strategy, state,
                         state_meaning, resolution|null, unevaluated: boolean, reason,
                         policy_id|null, expected_apply_by|null, created_at, resolved_at|null }
   ```
   404 when the session does not exist in the organization; 403 outside the caller's sites.
3. `POST /api/v1/orgs/{orgId}/policies/{id}/impact-preview` — permission `policy:preview`. Body =
   the PATCH body of the policy (`PolicyUpdate`, all optional) **or** `{"delete": true}`; nothing is
   written. Response:
   ```
   { policy_id, evaluated_sessions, affected_sessions, unevaluated_sessions,
     by_strategy: { coa_change, disconnect_reauth, next_reauth, none },
     max_apply_latency_s|null,   // longest expected wait until re-auth (Session-Timeout cap)
     session_timeout_cap_s,      // AAA_SESSION_TIMEOUT_CAP_S (0 = disabled)
     sessions: [{ session_id, site_id, nas_client_id, adapter_key|null, strategy, state, reason,
                  expected_apply_by|null }],   // first 200
     truncated: boolean,
     message }                   // e.g. "3 sessions affected; strategy next_reauth; applies at next login, at most 30 min"
   ```
4. Mutations that propagate (same transaction as the change: rows in `session_enforcement`,
   outbox `policy.changed` + one `session.enforcement_pending` per session, audit
   `session_enforcement:propagate`): `PATCH policies/{id}` (only when the effective result of an
   open session changes), `DELETE policies/{id}`, `POST policy-assignments`,
   `DELETE policy-assignments/{id}`. `PATCH policies/{id}` and `POST policy-assignments` bodies
   gain `enforcement: { change_id|null, evaluated_sessions, affected_sessions, by_strategy,
   reverted_sessions, merged_sessions, unevaluated_sessions, truncated, skipped? }` (additive;
   a PATCH that changes only `name` / `description` skips propagation entirely:
   `skipped` set, `change_id` null, zero re-resolutions); the two DELETEs stay `204` (the summary is in the
   audit row and the `policy.changed` event). A change that brings a session back to the policy
   it was authorized with closes its pending policy-change row as `superseded`
   (`detail.resolution = "reverted"`, counted in `reverted_sessions`).
5. Worker-written rows (`quota_breach`, `schedule_end`, `concurrency`) appear in the same views;
   `counter_anomalies` lists the SIM-14 32-bit wrap anomalies of the session
   (AAA_ARCHITECTURE.md §14 "P7-A wrap correction").

Affected-session rule: candidate open sessions (`authorized|active`) are those a target of any
assignment of the policy could reach (user, user group, client device, voucher batch, site; every
open session when the policy is or was the organization default); each candidate is re-resolved
with the stored subject facts at `now` and is affected when the resolution hash differs from the
hash stored at authorize (`policy_translations.input_snapshot.hash`). Known false positive:
a session re-resolved outside its schedule window resolves differently even without a change.

Configuration: `AAA_SESSION_TIMEOUT_CAP_S` (API, default 1800, 0 = off) and `ECLOUD_COA_ENABLED`
(read by the API only to choose strategies; default false). Migration 023 (`session_enforcement`,
`accounting_anomalies`, `sessions.{input,output}_wrap_offset`) is additive. Limits: at most
`ENFORCEMENT_MAX_SESSIONS` (default 2000) open sessions are re-resolved per change; sessions in
scope beyond the cap are **never dropped**: they get a pending row as affected without
re-resolution (`detail.unevaluated = true`, counted in `unevaluated_sessions`, `truncated: true`).
`loadResolutionInput` is cached per (site, subject, device, groups, voucher batch) and rows /
outbox events are inserted in batches of 500; re-resolution still happens inside the mutation's
transaction, so a change touching many sessions makes that request slower.
`AAA_SESSION_TIMEOUT_CAP_S` accepts 0 (off) or 300–86400 (Q45 floor).

### Implementation notes (P8-A, sessions & accounting, 2026-10-08)

Binding sources: API_ARCHITECTURE.md §3.2 (runtime & reporting rows), DATABASE_DESIGN.md
(`sessions`, `accounting_records`, `usage_counters`, `accounting_anomalies`,
`session_enforcement`), AAA_ARCHITECTURE.md §6 / §14, POLICY_ENGINE.md §5, MULTITENANCY.md
(Q75: Read Only may not export), DECISIONS.md D-006, D-021, D-025, D-027, D-028 (V12), D-036,
Q65 (periods in site TZ), Q73 (polling, no SSE). Migrations **024** (`024_sessions_accounting_read.sql`)
and **025** (`025_sessions_username_index.sql`, review fix) are additive: `usage_counters.subject_type`
gains `site`, plus read indexes (see "Performance").

**Site and organization usage start at migration 024: there is no backfill.** The drainer
writes `site` counters only for accounting it processes after 024 is applied; usage from before
that exists only in the user / client-device / voucher counters, so site, organization and
top-N-site figures under-report any period that began before 024.

#### Sessions & accounting API contract (consumed by P8-B admin views)

All `/orgs/{orgId}/…` responses are tenant-scoped (`withTenant`, RLS) and site-filtered by the
caller's bindings (`permittedSites`); objects of other tenants / unreadable sites are 404. No new
permission keys. Every usage / session read carries the **freshness** fields (spec §6: accounting
arrives at the NAS interim interval, so usage always lags):
`measured_at` (server time of the read), `last_accounting_at` (newest accounting the figures
include, null when none), `freshness_s` (`measured_at − last_accounting_at`, seconds, null when
none) and `expected_lag_s` (`AAA_INTERIM_INTERVAL_S`, or 600 s when unset — the worker's
`WORKER_INTERIM_INTERVAL_S` default — plus 5 s drain cadence: the normal lag). For usage,
`last_accounting_at` is the newest `usage_counters.updated_at` of the rows shown (the time the
drainer applied the newest accounting delta). The
UI polls (Q73, 30 s suggested); there is no SSE.

1. `GET /api/v1/orgs/{orgId}/sessions` — `session:read` (any-site). Query: `limit` (1–200, 50),
   `cursor`, `status` (comma list of `authorized|active|stopped|stale|expired`), `open`
   (`true` = `authorized,active`), `site_id`, `nas_client_id`, `user_id`, `client_device_id`,
   `voucher_id`, `mac` (any common notation), `username` (exact), `from` / `to` (ISO date-time,
   bounds on `started_at`, `from` inclusive, `to` exclusive). Order `started_at DESC, id DESC`
   (keyset cursor). Response `{ data: SessionSummary[], next_cursor, measured_at }`:
   ```
   SessionSummary = { …all sessions columns (id, organization_id, site_id, nas_client_id, user_id,
     client_device_id, voucher_id, policy_id, policy_version, acct_session_id, acct_unique_id,
     username_raw, mac, framed_ip, called_station_id, calling_station_id, started_at,
     last_interim_at, stopped_at, input_octets, output_octets, session_time_s, status,
     terminate_cause, created_at, updated_at, …),
     nas_name, adapter_key|null, coa_supported|null, policy_name|null, site_name,
     bytes_total, last_accounting_at|null, freshness_s|null }
   ```
   `last_accounting_at` per session = `COALESCE(last_interim_at, stopped_at, started_at)` for
   sessions that have accounting (`active|stopped|stale`), null for `authorized|expired`.
2. `GET /api/v1/orgs/{orgId}/sessions/{id}` — `session:read` (site check). Response = the
   SessionSummary fields plus
   ```
   { session_actions: SessionAction[],          // oldest first (unchanged)
     nas: { id, name, nas_ip, adapter_key|null, coa_supported|null },
     freshness: { measured_at, last_accounting_at|null, freshness_s|null, expected_lag_s },
     timeline: AccountingRecord[],              // oldest first, max 500
     timeline_truncated: boolean,
     anomalies: [{ id, kind, counter, previous, observed, estimated_lost_bytes, applied, reason,
                   created_at }],                // newest first, max 100
     enforcement: [{ id, change_id, trigger, strategy, state, reason, policy_id|null,
                     expected_apply_by|null, created_at, resolved_at|null, detail }], // newest first, max 50
     operations: { disconnect: OperationAvailability, reauthorize: OperationAvailability } }
   AccountingRecord = { id, received_at, event_time|null, status_type, acct_session_id,
     acct_unique_id, nas_ip, nas_identifier|null, username|null, calling_station_id|null,
     called_station_id|null, framed_ip|null, input_octets|null, output_octets|null,
     session_time_s|null, terminate_cause|null, session_id|null, raw,
     delta_input_octets|null, delta_output_octets|null }  // deltas: timeline only, vs previous record, ≥ 0
   OperationAvailability = {
     operation: 'disconnect'|'reauthorize', permission: 'session:disconnect'|'session:coa',
     permitted: boolean,          // caller holds the permission on the session's site
     available: boolean,          // the API would accept POST now (ignores `permitted`)
     mode: 'validated'|'lab'|null,// lab = ECLOUD_COA_ENABLED without LAB/PRODUCTION evidence
     device_enforced: boolean,    // V12: true only with lab-validated registry evidence (never today)
     code: null|'coa_unsupported'|'no_adapter'|'nas_coa_disabled'|'dispatcher_disabled'|'session_not_open',
     reason: string,              // neutral wording for the disabled button (registry evidence)
     evidence: { status|null, evidence_level|null, device_enforced: boolean, declaration|null },
     dispatcher_enabled: boolean }
   ```
3. `POST /api/v1/orgs/{orgId}/sessions/{id}/disconnect` — `session:disconnect`;
   `POST /api/v1/orgs/{orgId}/sessions/{id}/reauthorize` — `session:coa` (CoA change carrying the
   **re-resolved** policy; API §3.2 row; the P8 task text names `session:disconnect` for both —
   the catalogue's dedicated `session:coa` key is used for reauthorize). Body `{ reason?: string
   (≤ 500) }`; `Idempotency-Key` optional. Gate (D-006 / D-028 V12, from the adapter declaration
   + registry evidence, `@ecloud/adapters dynamicAuthorizationEvidence`):
   session must be open (`authorized|active`) → else 409 `session_not_open`; NAS must have an
   engine adapter (`no_adapter`), the adapter must not declare the mechanism `UNSUPPORTED` /
   `ECLOUD_SIDE_ONLY` / target `none` (`coa_unsupported`), the NAS must not be `coa_supported =
   false` (`nas_coa_disabled`), and `ECLOUD_COA_ENABLED` must be true (`dispatcher_disabled`).
   **Today every request is refused with `dispatcher_disabled`** (default) — or, in lab mode, is
   accepted with `mode: 'lab'`, `device_enforced: false`. Refusal: **409**
   `application/problem+json`, `type …/session-operation-unavailable`, extensions
   `{ operation, code, reason, evidence, dispatcher_enabled }`; the refusal is audited
   (`session:disconnect_refused` / `session:reauthorize_refused`), at most **30 refused attempts
   per minute per principal** (beyond that 429 and no audit row, so refusals cannot flood the
   audit log). Acceptance: **202**
   `{ session_action: SessionAction, deduplicated: boolean, mode, device_enforced, message }`;
   a `session_actions` row `pending` (`disconnect` / `coa_update`, payload `{reason, mode,
   requested_via:'api', plan?}`) + outbox `session.disconnect_requested` /
   `session.coa_requested` + audit `session:disconnect` / `session:reauthorize`, one transaction.
   Idempotent: while an action of the same kind is `pending|sent` for the session, the same row
   is returned (`deduplicated: true`, 202, no new audit row other than the request's). The worker
   picks up pending rows (outbox tick, ≤ 2 s) and enqueues the existing `coa.disconnect` /
   `coa.change` dispatcher (deterministic job id `coa-<id>`). Reauthorize also returns 409
   `policy_rejects` when the re-resolved policy rejects the session (use disconnect).
   Not refused while impersonating (D-027 lists API keys, secrets, privileged bindings only); the
   audit row carries `impersonator_id`.
4. `GET /api/v1/orgs/{orgId}/session-actions/{id}` — `session:read` (site of the session).
   `SessionAction = { id, session_id, action: 'disconnect'|'coa_update', status:
   'pending'|'sent'|'ack'|'nak'|'timeout'|'unsupported', error|null, payload (plan omitted),
   requested_by|null, request_id|null, created_at, completed_at|null }`. Poll until terminal.
5. `GET /api/v1/orgs/{orgId}/usage` — `accounting:read`. Query `subject_type`
   (`user|client_device|voucher|site|organization`), `subject_id` (required except
   `organization`), `period` (`daily|monthly|total`, default `daily`), `from` / `to` (`YYYY-MM-DD`,
   inclusive period starts; defaults: daily = last 31 days, monthly = last 13 months; max 366
   daily / 60 monthly buckets). Site check: `site` → that site; `user` → the user's site when it
   has one, else organization-level; `client_device` / `voucher` (batch site) likewise;
   `organization` → organization-level grant. Response:
   ```
   UsageReport = { subject_type, subject_id|null, label|null, period, timezone,
     series: [{ period_start, period_end, bytes_in, bytes_out, bytes_total, session_count,
                session_time_s }],            // ascending, only buckets with data;
                                             // period_end = exclusive end label YYYY-MM-DD (null for total)
     total: { bytes_in, bytes_out, bytes_total, session_count, session_time_s },  // sum of series
     current: { period_start, period_end, …same counters } | null,  // current period (site TZ);
                                             // period_end = ISO instant of the local reset
     current_unavailable_reason: string | null, // set when current is null because sites span timezones
     label_basis: string,                     // how period_start labels are to be read (site-local dates)
     quota: QuotaPosition | null,             // user / client_device / voucher only
     measured_at, last_accounting_at|null, freshness_s|null, expected_lag_s }
   QuotaPosition = { policy_id, policy_name, policy_source: 'open_session'|'last_session',
     periods: [{ period: 'daily'|'monthly'|'total', limit_bytes, used_bytes, remaining_bytes,
                 exceeded: boolean, period_start, period_end|null }] }   // only periods with a limit
   ```
   Periods are site-local calendar days/months (Q65, `sites.timezone`): user / device / voucher
   counters are bucketed in the TZ of the site of the session that produced the bytes; `timezone`
   is the subject's site TZ (`user.site_id`, voucher batch site, else the site of its newest
   session, else `UTC`) and is used for `period_end` / the current period. `organization` sums the
   `site` rows by period label (each site in its own TZ; `timezone` = `mixed` when sites
   differ; then `current` is null with `current_unavailable_reason`, because each site counts
   its own local day / month and no single current bucket exists — only `total` is common). The quota position uses the policy bound to the subject's newest open session (else
   its newest session) — the same policy row the worker's quota job evaluates; `period_end`
   is the next local midnight / month start (null for `total`). `site` counters exist only from
   migration 024 on (drain writes them for new accounting; no backfill — older usage appears
   under users/devices/vouchers only).
6. `GET /api/v1/orgs/{orgId}/usage/top` — `accounting:read`. Query `subject_type`
   (`user|client_device|site`, default `user`), `period` (`daily|monthly|total`, default
   `monthly`), `period_start` (`YYYY-MM-DD`; default the current period in UTC; monthly is
   normalised to day 01; ignored for total), `limit` (1–100, 10). Users / devices need an
   organization-level grant (their counters carry no site); `site` is filtered to the caller's
   sites. Labels are **site-local dates** (Q65). An explicit `period_start` is matched as a label
   for every row. Without one (review fix 1): `site` uses **each site's own current local
   day / month** (an Auckland site past local midnight already reports tomorrow's label);
   `user` / `client_device` use the organization's single site timezone and answer **400
   (`period_start` required)** when the sites span several timezones. Response `{ subject_type,
   period, period_start|null (null when the per-site labels differ), label_basis, data: [{ rank,
   subject_id, label, period_start, bytes_in, bytes_out, bytes_total, session_count,
   session_time_s, last_accounting_at }], measured_at, last_accounting_at|null, freshness_s|null,
   expected_lag_s }`.
7. `GET /api/v1/orgs/{orgId}/accounting/records` — `accounting:read`. Query `from`, `to`
   (**required** ISO date-time, `to − from ≤ 31 days`, partition pruning on `received_at`),
   `limit` (1–200, 50), `cursor`, `session_id`, `site_id`, `username`, `acct_session_id`,
   `status_type` (`start|interim|stop|accounting_on|accounting_off`), `nas_ip`,
   `calling_station_id`. Order `received_at DESC, id DESC`. Records without a resolved session /
   tenant site are visible to organization-level grants only. Response `{ data:
   AccountingRecord[] (no delta fields), next_cursor, measured_at }`.
8. `POST /api/v1/orgs/{orgId}/accounting/export` — `accounting:export` (Read Only lacks it, Q75).
   Body = the filters of (7) without `limit`/`cursor` (`from`/`to` required, ≤ 31 days).
   **Streamed** `text/csv; charset=utf-8` (keyset batches of 1000 in short transactions, never one
   long cursor), `Content-Disposition: attachment`, formula-injection neutralised, ascending
   `received_at`. More than 100 000 matching rows → 422 (narrow the range). **Refused while
   impersonating** (403 `impersonation-forbidden`, D-027 default for bulk tenant data
   egress). Audited twice: `accounting:export` before streaming (filters, `rows_at_start`) and
   `accounting:export_completed` when the stream ends (`rows_emitted`, `outcome:
   finished|aborted` — aborted = client gone or a batch failed). Rate limit 10 exports / hour /
   principal (shared with other exports, 429), consumed only **after** every check that can
   refuse (impersonation, scope, window, row cap), so refused attempts cost nothing.
9. `POST /api/v1/orgs/{orgId}/usage/export` — `report:export` (Read Only lacks it). Body
   `{ subject_type: user|client_device|site, period: daily|monthly|total, from?, to? }` (same
   bounds as (5)). CSV `subject_type, subject_id, label, period, period_start, bytes_in,
   bytes_out, bytes_total, session_count, session_time_s, updated_at`; max 50 000 rows (422).
   Refused while impersonating; audited (`report:export`); same rate limit, consumed only after
   the scope / range / row-cap checks pass.
10. `GET /api/v1/platform/retention/plan` — `platform:health:read` (platform binding). Dry run
    only (nothing is deleted; the worker's `retention.prune` applies only with
    `RETENTION_APPLY=true`). Response `{ measured_at, policy: { raw_days: 7,
    accounting_months: 13, audit_months: 24 } (D-025 pilot defaults), cutoffs: { raw,
    accounting_records, audit_logs }, partitions: [{ table, partition, from|null, to|null,
    action: 'drop'|'keep', estimated_rows }], drop_partitions: string[],
    default_partition_rows_past_cutoff: { accounting_records, audit_logs },
    raw_rows_older_than_cutoff, checks: [{ name, ok, detail }] }`. Checks: partitions exist
    for the current and next month, no row older than the cutoff sits in a DEFAULT partition
    (it would never be dropped), every drop candidate matches the `<table>_yYYYYmMM` naming the
    job requires. The plan is computed by the same pure `planRetention` the worker runs
    (moved to `@ecloud/db`).

**Performance** (migration 024): `idx_sessions_org_site_started (organization_id, site_id,
started_at DESC)`, `idx_sessions_org_user_started`, `idx_sessions_org_device_started`,
`idx_sessions_org_mac_started` (partial on non-null), `idx_sessions_org_username_started
(organization_id, username_raw, started_at DESC)` (migration 025, partial on non-null), `idx_accounting_session_received
(session_id, received_at)` on the partitioned `accounting_records` (partial, non-null session),
`idx_usage_counters_org_subject_period (organization_id, subject_type, period_type,
period_start)`, `idx_session_actions_open (session_id, action) WHERE status IN
('pending','sent')`. The session detail loads the timeline, anomalies, enforcement rows and
actions with one bounded query each (no N+1); list queries are keyset-paged with `limit ≤ 200`.

### Implementation notes (P9-A, dashboard & reports, 2026-10-08)

Binding sources: IMPLEMENTATION_PLAN.md Phase 9, API_ARCHITECTURE.md "P8-A" (freshness fields,
site-local periods), DATABASE_DESIGN.md (`auth_events`, `sessions`, `usage_counters`,
`portal_login_attempts`, `accounting_anomalies`, `session_enforcement`, `audit_logs`),
ADMIN_UI_ARCHITECTURE.md (dashboard KPIs), MULTITENANCY.md G6 (aggregates run under
`app.current_org`; platform aggregates under `platform_access`, grouped by organization),
DECISIONS.md D-021, D-025, D-027, D-028; Q65 (site-local periods), Q73 (polling, no SSE), Q75
(Read Only may not export); ECLOUD_MULTI_VENDOR_HOTSPOT.md §8 (distinguish registered APs/NAS from
those whose online status is actually known). Migration **026** (`026_dashboard_reports.sql`,
next free number) is additive: the `usage_hourly` rollup, `portal_login_attempts.triggered_lockout`
and read indexes (see "Performance").

**Device state.** ECLOUD has no device-management telemetry (local-only phase: no controller, AP
or VPS integration). The dashboard therefore never reports a NAS or AP as online/offline. Per NAS
it reports only what ECLOUD itself observed: the newest RADIUS Access-Request (`auth_events`) and
the newest accounting record (`accounting_records`) from that NAS, and an **observed-activity**
status derived from them with explicit thresholds:

| `activity` | meaning (all relative to `measured_at`) |
|---|---|
| `active` | newest auth request or accounting record is at most `active_within_s` old (2 × the NAS interim interval: 1 200 s with the 600 s default) |
| `quiet`  | newest activity is older than `active_within_s` but at most `quiet_within_s` (86 400 s) old |
| `silent` | newest activity is older than `quiet_within_s` |
| `never`  | no auth request and no accounting record from this NAS is retained (D-025 retention) |

A NAS with no clients is legitimately `quiet`/`silent`; the status says nothing about device
reachability. `network_devices` are reported as `registered` with `online_status_known: 0`
(nothing in ECLOUD observes AP state; `network_devices.mgmt_status` is not written by any ECLOUD
component and is not used).

#### Dashboard & reports API contract (consumed by P9-B admin views)

All `/orgs/{orgId}/…` endpoints run under `withTenant` (RLS) and are filtered to the caller's
`report:read` sites (`permittedSites`); a `site_id` outside them is 404. Organization-level data
that has no site (RADIUS requests from a NAS without a resolved NAS row) is included only for
organization-level grants. No new permission keys: `report:read` (dashboard, series, reports),
`report:export` (CSV; Read Only lacks it, Q75), `platform:health:read` (platform summary). The UI
polls (Q73, 30 s suggested; stop on error). Shared shapes:
```
Counters  = { bytes_in, bytes_out, bytes_total, session_count, session_time_s }
Freshness = { measured_at, last_accounting_at|null, freshness_s|null, expected_lag_s }  // as P8-A
SiteRef   = { id, name, timezone }
```

1. `GET /api/v1/orgs/{orgId}/dashboard` — `report:read` (any-site). Query `site_id?` (uuid; the
   site dashboard), `window` (`1h|24h|7d`, default `24h`: the authentication / anomaly window).
   One bounded call (≈ 12 indexed queries, no N+1):
   ```
   OrgDashboard = {
     organization_id, site_id|null, sites: SiteRef[],     // sites the figures cover
     timezone: string,                                     // the single site TZ, or 'mixed'
     window: { key, from, to },                            // ISO instants
     sessions: { open, authorized, active,                 // open = authorized + active (now)
                 started_today, started_today_basis },     // since each site's local midnight
     usage: { today: Counters, month: Counters,            // site counters, each site's current
              label_basis, source: 'usage_counters (site rows, migration 024)', ...Freshness },
     auth: {
       radius: { total, accept, reject, challenge, error,
                 by_method: [{ method|null, total, accept, reject, challenge, error }] },
       portal: { total, accept, reject, error, lockouts,   // lockouts: attempts that activated a
                 by_method: [{ method, total, accept, reject, error, lockouts }] }, // lock (026+)
       top_reject_reasons: [{ source: 'radius'|'portal', reason, count }] },  // max 10, desc
     enforcement: { pending, overdue, oldest_pending_at|null },  // overdue: expected_apply_by < now
     anomalies: { count, estimated_lost_bytes },            // accounting_anomalies in the window
     nas_activity: NasActivityBlock,
     network_devices: { registered, online_status_known: 0, note },
     measured_at }
   NasActivityBlock = { thresholds: { active_within_s, quiet_within_s }, definition: string,
     counts: { registered, active, quiet, silent, never },  // over every NAS in scope
     data: NasActivity[], truncated: boolean }              // data ≤ 200 rows, by site, name
   NasActivity = { nas_client_id, name, site_id, site_name, nas_ip, adapter_type_key,
     admin_status: 'active'|'disabled', activity: 'active'|'quiet'|'silent'|'never',
     last_auth_request_at|null, last_accounting_at|null, last_activity_at|null, open_sessions }
   ```
   RADIUS outcomes come from `auth_events` (attributed to a site through the NAS row); portal
   outcomes from `portal_login_attempts` (site of the captive portal). `reason` is a reason
   **code**: a stored reason matching `^[a-z0-9_]{1,64}$` is shown as is, anything else (a
   free-text FreeRADIUS Module-Failure-Message, which can echo the User-Name / EAP identity) is
   shown as `module_message` (review fix); the same rule applies to the `auth_outcomes` report
   and its CSV.
2. `GET /api/v1/orgs/{orgId}/dashboard/series/auth` and
   `GET /api/v1/orgs/{orgId}/dashboard/series/usage` — `report:read`. Query `granularity`
   (`hour|day`, default `hour`), `site_id?`, `from`, `to`:
   - `hour`: ISO date-times; default the last 24 h; `to − from ≤ 31 days` (≤ 745 buckets). Buckets
     are the **site-local hours** (start = the instant the local hour began; 1 h each, so a DST
     fall-back hour appears twice and a spring-forward hour is absent — labels show it). When the
     sites in scope span several timezones, `site_id` is required (400).
   - `day`: `YYYY-MM-DD` labels, inclusive; default the last 31 local days; ≤ 397 buckets
     (13 months). With several timezones every site counts its own local days (`timezone:
     'mixed'`, as P8-A organization usage).
   Every bucket of the range is present (**zero-filled**), ascending.
   ```
   AuthSeries  = { metric: 'auth_outcomes', granularity, timezone, site_id|null, from, to,
     label_basis, buckets: [AuthBucket], totals: AuthCounts, measured_at }
   AuthBucket  = { bucket_start, bucket_end, label, ...AuthCounts }  // hour: ISO instants, label
                                                    // 'YYYY-MM-DD HH:00' local; day: date labels
   AuthCounts  = { radius_accept, radius_reject, radius_challenge, radius_error,
                   portal_accept, portal_reject, portal_error, portal_lockouts }
   UsageSeries = { metric: 'usage', granularity, timezone, site_id|null, from, to, label_basis,
     source: 'usage_hourly'|'usage_counters', data_since: string,
     buckets: [{ bucket_start, bucket_end, label, ...Counters }], totals: Counters, ...Freshness }
   ```
   Hourly usage reads the `usage_hourly` rollup (migration 026; the drainer adds every accounting
   delta to the site-local hour of its event time; **no backfill**: hours before 026 read 0);
   daily usage reads the `site` rows of `usage_counters` (from migration 024). `session_count` in
   a bucket = sessions whose first accounting fell into it.
3. `GET /api/v1/orgs/{orgId}/reports` — `report:read` (any-site). `{ data: ReportDefinition[] }`,
   `ReportDefinition = { key, title, description, params: [{ name, type, required, default|null,
   description }], columns: [{ key, label, type: 'string'|'number'|'date'|'datetime', unit|null }],
   export_permission: 'report:export' }`. Keys:
   - `usage_by_site` — params `period` (`daily|monthly`, default daily), `from`/`to` (labels;
     defaults 31 days / 13 months; ≤ 397 daily / 60 monthly buckets), `site_id?`. Rows `site_id,
     site_name, period_start, bytes_in, bytes_out, bytes_total, session_count, session_time_s`
     (site-local labels, rows with data only).
   - `auth_outcomes` — params `from`/`to` (labels, default last 31 days, ≤ 397 days), `site_id?`.
     Rows `period_start, site_id|null, site_name|null, source (radius|portal), method|null,
     result, reason|null, count` (site-local day of the event).
   - `session_summary` — params `from`/`to` (labels, default 31 days, ≤ 397 days), `site_id?`.
     Rows per site-local start day and site: `period_start, site_id, site_name,
     sessions_started, distinct_devices, distinct_users, still_open, bytes_in, bytes_out,
     bytes_total, session_time_s, avg_session_time_s` (bytes / time of the sessions that started
     that day, as currently known).
   - `nas_activity` — params `from`/`to` (labels, default last 7 days, ≤ 31 days), `site_id?`.
     Rows `nas_client_id, name, site_id, site_name, nas_ip, adapter_type_key, admin_status,
     activity, last_auth_request_at, last_accounting_at, last_activity_at, open_sessions,
     auth_accept, auth_reject, sessions_started` (counts within the window).
4. `GET /api/v1/orgs/{orgId}/reports/{key}` — `report:read`; query = the report's params. `{ report,
   title, params (resolved), timezone, label_basis, columns, rows: object[], row_count, measured_at,
   notes: string[], freshness: Freshness|null }`. More than 10 000 rows → 422 (narrow the range or
   export). Unknown key → 404.
5. `POST /api/v1/orgs/{orgId}/reports/{key}/export` — `report:export`; body = the report's params.
   `text/csv; charset=utf-8` attachment, header = `columns[].key`, formula-injection neutralised
   (shared `toCsv`). P8 export guard: **refused while impersonating** (403
   `impersonation-forbidden`), Read Only lacks `report:export` (403), at most 50 000 rows (422),
   10 exports / hour / principal shared with the P8 exports (429), the budget consumed only after
   every refusal check; audited `report:export` (`target_type: 'report'`, `after: { report,
   params, rows }`) in the same transaction.
6. `GET /api/v1/platform/dashboard` — `platform:health:read` (platform binding; runs under
   `withPlatform`, audited `platform:access`). Query `limit` (1–50, 25), `cursor`, `status`
   (`active|suspended|archived`), `organization_id?` (one organization's row). Counts only, no
   subscriber data:
   ```
   { measured_at, window: { from, to },                       // last 24 h
     thresholds: { active_within_s, quiet_within_s }, definition,
     unattributed: { radius_requests_24h },                   // auth_events without organization
     data: [{ organization_id, name, slug, status, sites, nas_registered,
              nas_activity: { active, quiet, silent, never }, network_devices_registered,
              open_sessions, sessions_started_24h, radius_accept_24h, radius_reject_24h,
              nas_activity_truncated, portal_attempts_24h, portal_lockouts_24h,
              enforcement_pending, anomalies_24h }],
     next_cursor|null }
   ```

**Lockouts.** The portal identify path now counts a failure against the Redis lock counters
*before* writing the `portal_login_attempts` row (inside the same tenant transaction), so the row
records `triggered_lockout` when that failure activated a per-device, per-account or site-wide
voucher lock. Attempts refused while a lock is active (429) are still not written (unchanged:
writing them would let a locked client amplify DB writes).

**Performance** (migration 026; EXPLAIN in `dashboard.integration.test.ts` with
`enable_seqscan = off`, plus a seeded, rolled-back EXPLAIN ANALYZE on `ecloud_test`: 50 NAS,
200 000 auth events, 100 000 accounting records, 9 600 hourly rows → NAS activity probe 9.0 ms,
24 h RADIUS outcomes 2.4 ms, 31-day hourly usage 0.6 ms). Every dashboard aggregate is a range on
an indexed time column (`idx_auth_events_org_time` / BRIN, `idx_portal_login_attempts_org_time`,
`idx_accounting_anomalies_org_created`, `usage_hourly` PK / `idx_usage_hourly_org_hour`, the
`usage_counters` PK), a partial-index count of open rows (`idx_sessions_open_org_site_nas`,
`idx_session_enforcement_org_state`), or a per-NAS newest-row probe
(`idx_auth_events_org_nas_time`, `idx_accounting_org_nas_received`: one backward index-only scan
per partition, LIMIT 1). Bounds: dashboard window ≤ 7 days; hourly series ≤ 31 days; daily ≤ 397
days; NAS rows examined per request ≤ 2 000 (`truncated` beyond, the dashboard returns ≤ 200
rows); report JSON ≤ 10 000 rows, CSV ≤ 50 000; platform page ≤ 50 organizations. Hourly usage
uses the `usage_hourly` rollup (raw `accounting_records` would need per-session window
functions); authentication outcomes are aggregated from the raw partitioned tables over the
bounded window (no rollup: index range + GROUP BY is sufficient at pilot volume; a worker-maintained
hourly auth rollup is the next step if 7-day windows grow slow).

**Not implemented (P9-A):** no SSE (Q73 polling); no per-AP state (no telemetry); unattributed
RADIUS requests (unknown NAS) appear only as a platform count; `usage_hourly` and `site` counters
are not backfilled.

**Review fixes (P9-A loop step 6).**
1. *Reject reasons* are reduced to codes at read time (dashboard top reasons, `auth_outcomes`
   JSON/CSV): `^[a-z0-9_]{1,64}$` or `module_message`. Decision: no write-time change in
   `internal/aaa.ts` — `auth_events.reason` keeps the raw module message for platform-side
   diagnostics (it never leaves the database through a tenant endpoint), and the read-side rule
   also covers rows written before the fix.
2. *Export budget*: `POST /reports/{key}/export` first checks the budget read-only
   (`assertExportBudgetAvailable`: 429 when 10 exports were already used this hour, nothing
   consumed) and only then runs the report query; the unit is still consumed after every refusal
   check (P8 semantics unchanged; the P8 exports are untouched).
3. *Retention*: `GET /platform/retention/plan` reports `usage_hourly_rows_older_than_cutoff`
   (same accounting cutoff as the worker's `retention.prune`, which deletes them only with
   `RETENTION_APPLY=true`).
4. *Deleted sites are excluded everywhere* — dashboard, series, reports and the platform summary
   count only live sites (an organization-level scope means "every live site"); the only
   site-less rows still counted for organization-level scopes are RADIUS requests without a NAS
   row. *NAS IP reuse*: `accounting_records` carry no NAS id, so a NAS's last accounting is
   matched by organization + NAS IP **and only from that NAS row's `created_at` on**; activity of
   an earlier (deleted) NAS with the same IP is never inherited. Auth activity is matched by NAS id.

### Implementation notes (multi-vendor Cycle A, 2026-10-10, D-044)

Endpoints added (all tenant-scoped, RLS, audited in the tenant transaction):

| Path | Method | Permission | Notes |
|---|---|---|---|
| `/api/v1/orgs/{orgId}/access-points` (+ `/{id}`) | GET, POST, PATCH, DELETE | `nas:read` / `nas:create` / `nas:update` / `nas:delete` | Access points behind a NAS (migration 028). Body `{nas_client_id, mac, name?, status?}`; `mac` any common spelling → `aa:bb:cc:dd:ee:ff`, unicast only; `site_id` always copied from the NAS. Live MACs are **globally** unique: a MAC registered by any organization answers the generic 409 (`uq_nas_access_points_mac`). Soft delete; deleting a NAS soft-deletes its APs. List filters `site_id`, `nas_client_id`, `status` |
| `/api/v1/orgs/{orgId}/controllers/{id}/api-credential` | GET | `controller:read` | Metadata only: `api_kind`, `base_url`, `username`, `external_org_id`, `external_site_id`, `has_secret`, `rotated_at`; 404 when none |
| same | POST | `controller:secret:rotate` | Set / rotate (whole record, `secret` required, `Idempotency-Key` required, refused while impersonating, D-027). `api_kind` must match the controller's registry vendor; `base_url` through `normalizeControllerBaseUrl` for the controller kind (SSRF guard); Omada needs `username`. Sealed with purpose `ecloud:vendor-api:secret:v1`; audit `controller:secret:rotate` with `{api_credential: set|rotated, api_kind, base_url_host, has_username}` only |
| same | DELETE | `controller:secret:rotate` | Removes the credential (audited, refused while impersonating). Deleting the controller removes it too; changing the controller's vendor (or its kind to one the stored URL does not satisfy) is a 409 while a credential exists |

Internal behaviour changes:

- `/internal/portal/redirects`: the NAS is resolved by `findNasByIdentity` (`internal/nas-lookup.ts`)
  from `nasid` **and** the AP MAC in `called`: exactly one active NAS, else the generic error; a
  registered AP of another NAS than `nasid` is a conflict; a disabled AP refuses the redirect. The
  UAM `md` check is unchanged. Replay keys now have namespaces (`nonceKind`); UAM keys are byte-identical
  to before.
- `/internal/aaa/authorize`: NAS adapter `generic-radius-8021x` (engine adapter, migration 028 CHECK).
  MAC authentication = `Service-Type = Call-Check` (all adapters, unchanged) or, on the generic
  adapter only, `User-Name` that is exactly the `Calling-Station-Id` MAC with no password or the same
  MAC; a Call-Check MAC user name of another station is `mac_mismatch`. EAP-TTLS inner requests
  (`ECLOUD-EAP-Inner`, set only by FreeRADIUS `ecloud-inner`) are accepted only for
  `generic-radius-8021x` / `openwifi-hostapd-radius` (`eap_adapter_not_allowed`), never as a portal
  credential (`eap_portal_credential`) and never as MAC auth; the inner `User-Name` is the session
  username.
- Not added: no outbound controller call, no post-back portal flow, no `HandoffSecrets` change (the
  login token and the vendor credential are consumed from Cycle C/D on).

Review fixes (same day): `POST /api/v1/platform/access-points/release` (`organization:update`,
platform scope; body `{mac, reason}`; soft-deletes the live registration of the MAC in whichever
organization holds it; audited there; refused while impersonating). Access points expose
`verified_at` / `verification_source` (read-only; set by `/internal/aaa/authorize` when the AP's
own NAS sends the MAC in `Called-Station-Id`). Site delete / organization archive soft-delete
the scope's access points, NAS clients and network devices. Idempotency fingerprints are keyed
HMACs. 409s of cross-tenant unique indexes omit `constraint`.

### Implementation notes (multi-vendor Cycle B, 2026-10-10, D-044)

MikroTik RouterOS Hotspot (`mikrotik-hotspot`) and the Teltonika RutOS profile on `coovachilli-uam`.
Migration **029**. No new public endpoint; changed contracts:

| Path | Change |
|---|---|
| `POST/PATCH /api/v1/orgs/{orgId}/nas` | `adapter_key` accepts `mikrotik-hotspot`. New boolean `device_test_attributes` (default false, migration 029): lab opt-in, the AAA layer also emits REQUIRES_DEVICE_TEST reply attributes (stored as `experimental` in `policy_translations.emitted`); nothing becomes VERIFIED. On create without `coa_port`, the adapter's documented DAS default is stored (MikroTik `/radius incoming` 1700; other adapters keep NULL). |
| `POST/PATCH /api/v1/orgs/{orgId}/captive-portals` | `portal_type` accepts `mikrotik` (`uam_server_url` path `/hotspot/mikrotik/`). |
| Portal public `GET /hotspot/mikrotik/` | Entry from the ECLOUD-generated RouterOS `login.html`; query names are the RouterOS servlet variables `mac`, `ip`, `identity`, `link-login-only`, `link-orig`, `chap-id`, `chap-challenge`, `error` (values from `$(name-esc)`). → 303 `/f/{token}`. |
| Portal `POST /f/{token}/login\|voucher\|click` | For MikroTik flows the hand-off is a script-free page with a form POSTing `username`, `password`, `dst`, `popup` to the flow's `link-login-only` (private IPv4 `http(s)://…/login` only); the router origin is added to that page's CSP `form-action`. `POST /f/{token}/logout` follows `<router>/logout`. |

Internal behaviour:

- `POST /internal/portal/redirects`: `flavour: "mikrotik"`. The NAS is resolved by `identity`
  (= RADIUS NAS-Identifier = router identity, registered as `nas_identifier`); no AP MAC (RouterOS
  has no such variable). `link-login-only` must be `http(s)://<RFC 1918/6598 IPv4>[:port][/<dir>]/login`.
  `chap-id` / `chap-challenge` are the documented octal-escaped bytes; both or neither. The CHAP
  challenge is the replay nonce (`nonceKind: vendor-nonce`); without CHAP an ECLOUD login token id is
  (`ecloud-login-token`). Every flow carries a login token (TTL 300 s) that `identify` consumes once
  before issuing the broker credential (second identify on the same redirect → 422
  `handoff_unavailable`; a failed router login comes back as a new redirect).
- `POST /internal/portal/flows/:id/identify`: `handoff` gains `fields` for `method: "POST-form"`. With
  CHAP the form password is `MD5(chap-id ‖ credential ‖ chap-challenge)` (lowercase hex); without
  CHAP the cleartext credential is sent only to an `https:` target, else 422.
- `POST /internal/aaa/authorize`: `CHAP-Password` is accepted only for a portal credential issued for a
  CHAP hand-off; all binding checks (NAS by packet source, NAS-Identifier, client MAC, single use)
  run as for PAP, then the answer is `control:Auth-Type = CHAP` + `control:Cleartext-Password`
  (contract rule 2) and FreeRADIUS `chap` verifies. The credential password is kept sealed
  (`ecloud:portal:chap-credential:v1`) in the 90 s credential record for this purpose only. Any
  other CHAP request stays `chap_unsupported`. `includeDeviceTestAttributes` /
  `includeExperimental` follow `nas_clients.device_test_attributes`.
- Worker Disconnect/CoA: port = `nas_clients.coa_port`, else the adapter's documented default
  (`disconnect.defaultPort`, MikroTik 1700), else the deployment default.

Cycle B review fixes (same day): `POST/PATCH /nas` gains `hotspot_address` (private unicast IPv4,
required for `mikrotik-hotspot`) and `hotspot_port`; the MikroTik `link-login-only` must be exactly
that host (and port when set), else the redirect is refused (fail closed when unset).
`device_test_attributes` needs the platform permission `platform:adapter:manage` (403 otherwise,
never while impersonating) and writes audit `nas:lab_mode_changed`. The AAA retransmit cache seals
the CHAP `Cleartext-Password` (`ecloud:aaa:retransmit-cleartext:v1`) and keys on
SHA-256(CHAP-Password) as well. Post-login `dst` keeps the UAM `userurl` rule (`safeUserUrl`), by
review decision F5.

### Implementation notes (multi-vendor Cycle C, 2026-10-10, D-044)

F3 external captive portal post-back engine (`external-portal-postback`, migration **030**;
docs/VENDOR_INTEGRATION_RESEARCH.md §3.4; MULTI_VENDOR_INTEGRATION_PLAN.md §15).

| Path | Method | Permission | Notes |
|---|---|---|---|
| `/api/v1/orgs/{orgId}/nas` (+ `/{id}`) | POST, PATCH | `nas:create` / `nas:update` | New body field `adapter_config` (object). Required and validated (`parsePostbackNasConfig`, strict allow-list, unknown keys refused) when `adapter_key = external-portal-postback`: `{profile, https?, login_target?, login_hosts?[≤ 8], generic?}`; stored normalised. Any other adapter takes none (`{}`; a non-empty object is a 422). Changing the adapter away from post-back clears it; changing it to post-back re-validates the stored config |
| `/api/v1/orgs/{orgId}/nas/{id}/setup-guide` | GET | `nas:read` | `{id, adapter_key, profile, steps[]}`: "how to configure this device" steps in ECLOUD wording, values filled from the NAS (portal URL `https://portal.ezecloud.ezelink.ai/pb/<profile>/<nas_identifier>/`), every secret a placeholder (`<RADIUS_SECRET>`). Empty for an unconfigured post-back NAS |

Portal public (portal process): `GET /pb/{profile}[/{nasid}]/` — vendor redirect entry. Profile
segment `^[a-z][a-z0-9-]{1,39}$`, NAS id segment `^[A-Za-z0-9._:-]{1,64}$`; the raw query is
forwarded byte-for-byte; the answer is a 303 to `/f/{token}` or one generic error page. The method
pages carry the single-use login token (hidden `lt`); a successful identify renders an
auto-submitting form (`script-src 'nonce-…'` on that page only, no-JS "Continue" button) whose
action must have exactly the login origin the API validated (`isPostbackHandoff`); CSP
`form-action 'self' <login origin>`; `Cache-Control: no-store`.

Internal (`X-Internal-Token`):

- `POST /internal/portal/postback/redirects` `{profile, nasid?, raw_query ≤ 4 KB, client_ip?}` →
  `{kind:"flow", flow_id, expires_at}` | `{kind:"error"}` | 429 / 503. NAS resolution by
  `findNasByIdentity` before any query value is trusted: NAS identifier (portal path or the
  profile's NAS-ID parameter, which must agree) or else a **verified** AP MAC; the NAS must use
  `external-portal-postback` with this profile; the site needs an active `captive_portals` row of
  type `external` (pinned by `adapter_config.nas_client_id` or the only one). The adapter refuses
  a login URL that is not the AP / controller (private RFC 1918 / 6598 IPv4, the registered NAS IP,
  an operator login host, or a documented intercept name such as `securelogin.arubanetworks.com`;
  loopback, link-local / metadata, IPv6, userinfo, backslash, foreign hosts and wrong ports /
  paths refused) and a replayed vendor nonce (`magic`, `ga_Qv`; `nonceKind = vendor-nonce`).
  Generic profile: the NAS id must be in the path. Same rate limits as UAM redirects.
- `GET /internal/portal/flows/{id}` for a post-back flow adds `postback: {login_origin,
  login_token}` (token: Cycle A `lt1.…`, TTL 300 s, bound to org / site / NAS / client MAC / flow,
  re-issued on every view); `nas` is null; `continue_url` from the profile's continue parameter
  through `safeUserUrl`.
- `POST /internal/portal/flows/{id}/identify` accepts `login_token`; for a post-back flow it is
  required and consumed exactly once (Redis `SET NX`) before the identity is checked — missing,
  forged, expired, foreign-flow or replayed → 403 `{result:"login_token_invalid"}`. A successful
  post-back hand-off answers `handoff: {method:"POST-form", url, fields}` (fields = profile
  constants, echoed vendor fields, the single-use `pc-…` credential); GET profiles answer
  `GET-302` as before. The credential's replay key is the vendor nonce or the consumed login token
  id, marked by AAA on Access-Accept.
- `/internal/aaa/authorize`: unchanged code path — the `pc-…` credential is checked against the
  packet-source NAS, the bound client MAC and single use. Engine adapter `external-portal-postback`
  declares Session-Timeout / Idle-Timeout / Acct-Interim-Interval / Class as REQUIRES_DEVICE_TEST
  (emitted only in lab mode, D-028) and no rate / quota / VLAN attribute.

Cycle C review fixes: NAS `adapter_config` gains `strict_login_hosts` (boolean) and, for
`postback-generic`, required `generic.login_path` + optional `generic.login_port`; login URLs are
limited to documented ports and RFC 1918 / registered / configured hosts. NAS create / patch answer
a generic 409 when a NAS identifier would collide across organizations for adapters that expose it
in public URLs (`external-portal-postback`, `mikrotik-hotspot`). Details:
MULTI_VENDOR_INTEGRATION_PLAN.md §15.1.
