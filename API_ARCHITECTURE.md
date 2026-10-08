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
| `portal` | Server-rendered captive-portal pages on `portal.ecloud.ezelink.ai`; UAM adapters (`uspot-uam`, `coovachilli-uam`); talks only to `api` via `/internal/portal/*` | Anonymous, high-volume, walled-garden hostname; a portal flood must not starve admins (A7/A1 requirement); smaller attack surface (no DB credentials in the portal container) |
| `freeradius` | RADIUS front-end; `rlm_rest` → `/internal/aaa/*` (A3 decides rlm_sql vs rlm_rest split) | Vendor software |
| `postgres`, `redis` | State; queues, rate limits, admin session index | Shared state so `api`/`portal`/`worker` stay stateless |

```mermaid
flowchart LR
  subgraph PUB["Public (Caddy :443, native on VPS)"]
    ADMIN["ecloud.ezelink.ai\nadmin SPA (static)"]
    APIH["api.ecloud.ezelink.ai"]
    PORTH["portal.ecloud.ezelink.ai"]
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
| Base paths | Admin/public: `https://api.ecloud.ezelink.ai/api/v1/…` (also same-origin `/api/v1` through the admin host per `DEPLOYMENT_ARCHITECTURE.md §3.1`). Internal: `http://api:<INTERNAL_PORT>/internal/…` (never through Caddy). Portal public: `https://portal.ecloud.ezelink.ai/…` |
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

**Portal public (`portal.ecloud.ezelink.ai`, served by `portal` process; CSRF + rate limits below)**

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
| Session carrier | **Opaque session id in cookie** `__Host-ecloud_sid` (HttpOnly, Secure, SameSite=Lax, Path=/) when API is same-origin via admin host; if the SPA calls `api.ecloud…` cross-subdomain, use `Domain=.ecloud.ezelink.ai` + SameSite=Lax + `Origin` check + CSRF header (`X-CSRF-Token` = value from `GET /auth/csrf`). Server-side row `admin_sessions` (`token_hash` = SHA-256 of id) mirrored in Redis for O(1) lookup; idle 30 min, absolute 12 h (A7 §5), revocable instantly | Precedent: JWT in `localStorage` (`server.ts` L299, `public/js/app.js`) — rejected (XSS-readable, no server revocation). The precedent already mints HttpOnly SameSite=Lax cookies for tickets (`server.ts` L889, L4274) and has `SessionService.ts` dual-writing `sessions` rows — ECLOUD makes that authoritative. A7 prefers cookie; A8 reviewing |
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

Reports, accounting endpoints, webhooks, WireGuard peers, identity providers (captive portals,
portal themes/assets: implemented in P6-B, see below), users export, `users/{id}/reset-password` and `effective-policy`
(covered by PATCH `password` with `user:password:reset` and by `policies/simulate`),
`policies/{id}/preview`, voucher print and code reveal (hash-only default: there is nothing to
reveal), session disconnect/reauthorize (worker CoA path), `/platform/settings`,
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
