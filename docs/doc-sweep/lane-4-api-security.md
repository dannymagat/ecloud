# Lane 4 — API architecture, security architecture, security review P10, phase-2 validation

- Lane: 4 (Orchestrator sub-agent). Repository `feature/universal-aaa` at `be95176` (after e47d931). Read-only on vps-local.
- Start 2026-10-15T17:47Z · verification done 17:59Z · report written 18:10Z (UTC).
- Chunk counts (Read tool, offset/limit): `API_ARCHITECTURE.md` 1540 lines → **4 chunks** (1–400, 401–800, 801–1200, 1201–1540); `PHASE2_VALIDATION.md` 440 lines → **3 chunks** (1–110, 111–220, 221–440; the first 220-line chunk exceeded the Read token cap and was split); `SECURITY_ARCHITECTURE.md` 631 lines → **2 chunks** (1–320, 321–631); `docs/SECURITY_REVIEW_P10.md` 245 lines → **1 chunk**. Every file read to its last line.
- Host checks (vps-local, read-only): `docker ps`, `docker inspect` (hardening flags, port bindings, env **names** only), `docker logs --since 2h` (api, worker), SQL `SELECT` on `schema_migrations`, `permissions`, `roles`, `nas_clients`, `captive_portals`, `administrators`, `audit_logs`, `platform_default_policy`, `sessions`, `session_actions`, `auth_events`. **No command was denied.** No secret value was read or printed.
- Host facts used below: all seven containers healthy; every image tag reads `0e8f735` in `docker ps`/`docker inspect` (api, worker, edge=admin, portal, freeradius), labels `org.opencontainers.image.revision` = `unknown` on api/worker/edge — the stated per-service revisions (api 1592364, worker 7afd5fe, admin d7795a7) could **not** be confirmed from the host and are taken from the brief; `schema_migrations` max = `048_secret_version_trigger_split` (48 rows) while the repo carries `049_portal_registration_devices.sql` → one migration pending; `permissions` = 112 rows, 6 role templates; one live NAS (`openwifi-uspot-uam`, `secret_ref` prefix `enc:v2.`, `secret_version` 1, **`require_message_authenticator = false`**, `coa_port` NULL); one captive portal; administrators `danny@ezelink.com` active / `admin@ezecloud.local` disabled (D-063); `audit_logs` 463 rows (1 impersonation, 0 reveals); `platform_default_policy` enabled 10000/10000 kbps, 86400 s (D-055); sessions 1 active / 9 stopped; `session_actions` 0; `auth_events` 20, 0 unknown-NAS; worker start line 16:42Z: `coaEnabled:false`, `retentionApply:false`, queues incl. `coa.disconnect`, `coa.change`, `webhooks.deliver`, `controllers.inventory`; api/worker env carry `INTERNAL_SECRET_TOKEN_FILE`, worker `ECLOUD_INTERNAL_URL`, api `INTERNAL_CLEARTEXT_ACK` (D-061 deployed); api, worker, portal, redis `ReadonlyRootfs=true`, `CapDrop=[ALL]`, `no-new-privileges`; freeradius published on `192.168.203.196:1812-1813/udp` only (D-042); edge publishes `0.0.0.0:443` and `:444` (D-043/D-047); postgres/redis publish nothing.

## Checklist

- [x] `API_ARCHITECTURE.md` — 75 claims, IMPLEMENTED 34, PARTIAL 12, MISSING 5, STALE-DOC 14, SUPERSEDED 8, OUT-OF-SCOPE 2, NEEDS-OWNER 0
- [x] `PHASE2_VALIDATION.md` — 42 claims, IMPLEMENTED 18, PARTIAL 10, MISSING 2, STALE-DOC 2, SUPERSEDED 7, OUT-OF-SCOPE 1, NEEDS-OWNER 2
- [x] `SECURITY_ARCHITECTURE.md` — 62 claims, IMPLEMENTED 29, PARTIAL 16, MISSING 4, STALE-DOC 5, SUPERSEDED 6, OUT-OF-SCOPE 0, NEEDS-OWNER 2
- [x] `docs/SECURITY_REVIEW_P10.md` — 37 claims, IMPLEMENTED 20, PARTIAL 2, MISSING 5, STALE-DOC 1, SUPERSEDED 7, OUT-OF-SCOPE 0, NEEDS-OWNER 2

Totals: 216 claims — IMPLEMENTED 101, PARTIAL 40, MISSING 16, STALE-DOC 22, SUPERSEDED 28, OUT-OF-SCOPE 3, NEEDS-OWNER 6. (Counts are computed from the table rows; a verdict such as `PARTIAL / OUT-OF-SCOPE (AP half)` is counted under its first word.)

## API_ARCHITECTURE.md

| claim | verdict | evidence | apply item? |
|---|---|---|---|
| **§1 Service decomposition** | | | |
| Three processes `api`/`worker`/`portal` + freeradius/postgres/redis from one codebase | IMPLEMENTED | `apps/api`, `apps/worker`, `apps/portal`; vps-local `docker ps`: ecloud-api/worker/portal/freeradius/postgres/redis (+edge) healthy | — |
| `/internal/*` on a second listener (`INTERNAL_PORT`), shared `X-Internal-Token` compared constant-time | IMPLEMENTED | `apps/api/src/app.ts:219-246` (internalApp), `apps/api/src/internal/aaa.ts:980-995` (`safeEqual`, 401 empty body) | — |
| Portal talks only to api over `/internal/portal/*`, no DB credentials in portal | IMPLEMENTED | `apps/portal/src/api-client.ts:2,191`; vps-local portal env has no `DATABASE_URL*` | — |
| Public edge is "Caddy :443 native on VPS"; Docker net `172.28.0.0/16`; WireGuard hub `100.100.0.1` in diagram | SUPERSEDED | D-041/D-043 (edge container on vps-local, no Caddy), D-042 (RADIUS on LAN, WireGuard deferred); host: freeradius bound `192.168.203.196`, edge `0.0.0.0:443/444` | Doc fix: replace §1 diagram/trust-boundary text with the vps-local topology (edge container, Cloudflare tunnel D-047, LAN RADIUS) |
| **§2 Runtime, libraries, config** | | | |
| Node 22 / TypeScript / Express; zod → OpenAPI 3.1 at `GET /api/v1/openapi.json` | IMPLEMENTED | `apps/api/src/app.ts:7,198-200`, `apps/api/src/openapi.ts` (`zod-openapi`, `3.1`) | — |
| Kysely + plain SQL migrations, `withTenant` / `SET LOCAL app.current_org` | IMPLEMENTED | `packages/db/src/tenancy.ts`, `packages/db/migrations/001…049`; `sql.raw` count in `apps/api/src` = 0 | — |
| pino with redaction of `authorization`, `x-api-key`, `password`, `secret*` | IMPLEMENTED | `packages/shared/src/logger-redaction.test.ts` (extended by F-P10-09) | — |
| Config variable names `ECLOUD_BASE_URL`, `ECLOUD_API_URL`, `SESSION_SECRET_FILE`, `ENCRYPTION_KEY_FILE`, `INTERNAL_TOKEN_FILE`, `TRUST_PROXY`, `CORS_ORIGINS`, `WG_*`, `OBJECT_STORAGE_*`, `EZE_CONTROLLER_*` | STALE-DOC | real names in `apps/api/src/config.ts`: `PUBLIC_ADMIN_ORIGIN`, `PUBLIC_API_ORIGIN`, `PUBLIC_PORTAL_ORIGIN`, `DATA_ENCRYPTION_KEY`, `INTERNAL_API_TOKEN`, `INTERNAL_SECRET_TOKEN`, `TRUST_PROXY_HOPS`, `S3_*`, `STORAGE_*`; no `WG_*`/`EZE_CONTROLLER_*`; `*_FILE` suffix convention (F-P10-03); host env names confirm | Doc fix: replace the §2 config row with the `config.ts` list (names only) |
| `GET /healthz`, `GET /readyz` (DB + Redis + storage) | IMPLEMENTED | `apps/api/src/app.ts:150-166` | — |
| SIGTERM drain, `SHUTDOWN_GRACE_MS` | IMPLEMENTED | `apps/api/src/config.ts` (`SHUTDOWN_GRACE_MS`), `apps/api/src/main.ts` | — |
| **§3.1 Conventions** | | | |
| Base paths `api.ezecloud.ezelink.ai`, `portal.ezecloud.ezelink.ai` | SUPERSEDED | D-047: `api.ezelink.ai`, `portal.ezelink.ai`, admin `ezecloud.ezelink.ai` | Doc fix: hostnames per D-047 |
| Cursor pagination, `limit ≤ 200`, RFC 9457 problem+json, 404 for cross-tenant | IMPLEMENTED | `apps/api/src/http/errors.ts`, `apps/api/src/http/route.ts`; `apps/api/src/app.test.ts` validation problems | — |
| `Idempotency-Key` required on voucher batch / API key / invitation / NAS rotate; replay + 422 conflict + 428 | IMPLEMENTED | `apps/api/src/http/idempotency.ts:125-126` (`Idempotent-Replayed`, `Idempotent-Redacted`), `errors.ts:41` | — |
| Rate limits: login 10/5 min per IP+email; admin API 600/min per principal, writes 120/min; API keys 300/min; exports 10/h | PARTIAL | login = per-IP 30/5 min + per-account 10 failures → 15 min lock (`apps/api/src/auth/rate-limit.ts:8-16`); exports 10/h (`EXPORT_LIMIT`); **no** per-principal / per-API-key request limit (F-P10-05; no match in `apps/api/src/auth/principal.ts`) | Build per-API-key and per-tenant request rate limit (Redis fixed window, fail open) + per-IP throttle on invalid keys (F-P10-05) |
| Every mutating call writes one `audit_logs` row in the same transaction | IMPLEMENTED | `apps/api/src/audit.ts`; `apps/api/src/http/route.ts:209` logs `mutation not audited` | — |
| **§3.2 Endpoint catalogue** | | | |
| Auth: `/auth/login`, `/auth/logout`, `/auth/accept-invitation`, `/me`, `/me/sessions` | IMPLEMENTED | route list: `/api/v1/auth/{login,logout,me,accept-invitation,mfa/*}`, `/api/v1/me/sessions[/:id]` (`apps/api/src/routes/auth.ts:100`, `me.ts:35,89`) | — |
| `/auth/mfa/totp`, `/me/mfa` POST/DELETE (self-service disable) | STALE-DOC | implemented as `/auth/mfa/{enrol,confirm,verify}`; self-service disable deliberately absent (D-038); MFA off by default (D-046) | Doc fix: §3.2 auth rows → actual paths; note D-046 |
| `/platform/organizations[/{id}]`, `/platform/administrators[/{id}]`, `…/mfa/reset`, `/platform/role-templates`, `/platform/adapters`, `/platform/health`, `/platform/audit-log` | IMPLEMENTED | route list (`apps/api/src/routes/platform.ts`, `administrators.ts:231`, `platform-ops.ts:49,93,142`); host `permissions` has `administrator:mfa_reset` | — |
| `/platform/organizations/{id}/impersonate` + `DELETE /platform/impersonation` | STALE-DOC | implemented as `POST/DELETE /api/v1/platform/support/impersonate` (`apps/api/src/routes/platform.ts`) | Doc fix |
| `/platform/settings` GET/PATCH (`platform:settings:update`) | MISSING | no route; permission seeded on host (`platform:settings:update`); `ADMIN_MFA_MODE` is env, not a setting | Decide: keep settings as env (document) or build `/platform/settings`; low priority |
| `PATCH /platform/adapters/{key}` flips capability flags with `evidence_url` | PARTIAL | only `GET /platform/adapters`; flags come from the code registry (`packages/adapters/src/registry/*`, 0 `LAB`/`PRODUCTION` evidence rows) and change by reviewed commit (D-028, D-065) | Doc fix: evidence registry replaces the PATCH route; no build |
| `POST /platform/administrators` (platform invitations) | MISSING | not in route list; doc lists it under "Not implemented yet" | Keep deferred (invitations exist per organization) |
| `{o}/sites`, `network-devices`, `nas`, `users`, `user-groups`, `client-devices`, `schedules`, `policies`, `policy-assignments`, `roles`, `role-bindings`, `api-keys`, `administrators`, `invitations`, `voucher-batches`, `vouchers/{id}/revoke`, `sessions`, `audit-log` | IMPLEMENTED | `apps/api/src/routes/crud.ts` (generic CRUD), `resources.ts`, `access.ts`, `policies.ts`, `vouchers.ts`, `sessions.ts`, `runtime.ts`; `app.test.ts:136-144` fails when a mounted route is missing from OpenAPI | — |
| `{o}/nas` secret generated server-side, returned once, `rotate-secret`; `adapter_key` required (D-035) | IMPLEMENTED | `/api/v1/orgs/:orgId/nas/:id/rotate-secret`, `apps/api/src/nas-adapter.ts`; host NAS row `adapter_key = openwifi-uspot-uam` | — |
| NAS secret reveal (D-045) | IMPLEMENTED | `/api/v1/orgs/:orgId/nas/:id/secret/reveal`; host `permissions` has `nas:secret:reveal`; 0 reveals audited so far | — |
| `{o}/network-devices/{id}/config-push` (Option A) | OUT-OF-SCOPE | D-058; `apps/api/src/routes/openwifi-config.ts:1-6` is export/preview only, "EZECONTROL is unchanged" | List only |
| `{o}/wireguard-peers[/{id}, rotate-key]` | SUPERSEDED | D-042 WireGuard deferred until remote sites exist; permission `wireguard_peer:create` seeded but no route | Doc fix: mark deferred |
| `{o}/webhooks[/{id}, test]` management endpoints | PARTIAL | no route; table `webhooks` (`packages/db/migrations/008_audit_outbox_webhooks.sql`), worker queue `webhooks.deliver` + SSRF-guarded transport (`apps/worker/src/jobs/webhook-transport.ts:7-45`) exist; permission `webhook:create` seeded | Build webhook CRUD + test endpoint, or document that webhooks are worker-only until a tenant asks (Q4 of §9: third-party integrations in release 1?) |
| `{o}/audit-log/export` | MISSING | no route; `audit_log:export` seeded on host | Build audit-log CSV export under the P8 export guard (S) |
| `{o}/users/{id}/reset-password`, `effective-policy`, `users/export`, `policies/{id}/preview` | STALE-DOC | doc itself: covered by PATCH `password`, `policies/simulate`, `impact-preview`; `users/export` still absent | Doc fix: strike the four rows; `users/export` stays deferred |
| `{o}/users/import` ≤ 500 rows JSON `{csv}` | IMPLEMENTED | `apps/api/src/routes/imports.ts` (`/api/v1/orgs/:orgId/users/import`) | — |
| Voucher `print` (reveals codes) | STALE-DOC | hash-only default (A6 Q4): nothing to reveal; `voucher:reveal` key exists unused | Doc fix |
| `{o}/captive-portals`, `portal-themes`, `assets`, `identity-providers` | PARTIAL | captive-portals/themes/portal-assets/previews/terms/versions/publish in `apps/api/src/portal-admin/routes.ts:450-1304`; `identity-providers` absent (Q64 no social IdP; e-mail OTP via SMTP D-060 instead, `apps/api/src/internal/otp.ts`) | Doc fix: identity providers deferred; OTP e-mail documented under D-060 |
| `{o}/sessions/{id}/disconnect`, `reauthorize`, `session-actions/{id}` | IMPLEMENTED | `apps/api/src/routes/sessions.ts:540-593` (`${op}` = disconnect/reauthorize, `session:disconnect`/`session:coa`) | — |
| `{o}/accounting/records`, `accounting/export`, `usage`, `usage/top`, `usage/export`, `reports/*`, `dashboard*` | IMPLEMENTED | `apps/api/src/routes/accounting.ts:145,212`, `usage.ts:368-513`, `reports.ts:618-672`, `dashboard.ts` | — |
| `{o}/events/stream` SSE | STALE-DOC | Q73 polling; doc "Not implemented" | Doc fix: strike |
| `{o}/jobs/{id}` async jobs | MISSING | exports are streamed synchronously; no job table/route | Keep deferred; no apply |
| Internal `/internal/aaa/authorize`, `post-auth` | IMPLEMENTED | `apps/api/src/app.ts:235-236`, `docs/contracts/aaa-authorize.md`, `tests/aaa-contract/freeradius-rest.test.ts` | — |
| Internal `/internal/aaa/accounting`, `coa-result`, `/internal/aaa/clients` | STALE-DOC | accounting via `rlm_sql` + worker drain (D-004); clients via rendered `ecloud-nas.conf` + `GET /internal/radius/client` dynamic lookup (`app.ts:238`); CoA result written by the worker directly | Doc fix |
| Internal `/internal/portal/*` flows, redirects, identify, status, logout; `resolve-nas` folded | IMPLEMENTED | `apps/api/src/internal/portal.ts:1082-1825`, `portal-postback.ts:121`, vendor-portal router | — |
| Internal `/internal/nas/:id/secret` with its own token (D-056/D-061) | IMPLEMENTED | `apps/api/src/app.ts:229-233`, `apps/api/src/internal/nas-secret.ts:81-124` (503 unset, 503 cleartext w/o ack, 404 no body, `no-store`); worker `apps/worker/src/config.ts:73,144-145`; host env `INTERNAL_SECRET_TOKEN_FILE` on api + worker; **not yet described in this document** | Doc fix: add the D-061 endpoint to §3.2 internal table |
| Portal public `/uam/uspot/`, `/uam/chilli/`, `/f/{flow}/login` / `voucher` / `click` / `idp`, `/idp/callback`, `/legal/*` | PARTIAL | portal serves `/f/:token`, `/f/:token/status`, `/f/:token/logout`, `/a/:assetId`, `/meraki-done`, `/healthz` (`apps/portal/src/index.ts`), plus UAM/hotspot/pb/meraki entries via routers; `/idp/*` and `/legal/*` absent (terms served inside the flow page) | Doc fix: portal route table from `apps/portal/src/index.ts` |
| Portal CSRF double-submit, rate limits 5/10 min per nasid+mac, CSP `default-src 'self'` | STALE-DOC | implemented stricter: CSP `default-src 'none'` + nonce (`apps/portal/src/index.ts:305-306`), `PORTAL_LIMITS` 5/5 min → 15 min lock etc. (`apps/api/src/internal/portal.ts`), signed state tokens | Doc fix: §3 portal paragraph → P6-A values |
| **§4 Admin AuthN/AuthZ** | | | |
| Opaque session cookie, SHA-256 `token_hash`, idle 30 min, absolute 12 h, `__Host-` in production | IMPLEMENTED | `apps/api/src/config.ts:119,289-295` (`SESSION_IDLE_SECONDS` 1800; production refuses non-`__Host-`/insecure); `apps/api/src/config-hardening.test.ts`; host `SESSION_COOKIE_NAME`, `SESSION_COOKIE_SECURE` set | — |
| Argon2id m=64 MiB t=3 p=1 | STALE-DOC | `packages/db/src/admin.ts:11` m=19456 KiB t=2 p=1 (OWASP minimum, SECURITY §6.1) | Doc fix |
| TOTP MFA enforced for platform bindings | SUPERSEDED | D-046 `ADMIN_MFA_MODE=off`; host api env has `ADMIN_MFA_MODE`; `apps/api/src/mfa-mode.integration.test.ts` | — |
| Lockout 10 failures / 5 min → 15 min | IMPLEMENTED | `apps/api/src/auth/rate-limit.ts:12-14` | — |
| API keys `eck_<12>_<43>`, SHA-256, `allowed_cidrs`, `expires_at ≤ 1 y` | IMPLEMENTED | `apps/api/src/routes/access.ts:566-632`, `apps/api/src/auth/principal.ts` | — |
| CSRF via `X-CSRF-Token` from `GET /auth/csrf` | STALE-DOC | implemented as `Origin`/`Referer` = `PUBLIC_ADMIN_ORIGIN` + `X-Requested-With` (`apps/api/src/auth/middleware.ts`, `app.ts:212`) | Doc fix (also SECURITY §6.4) |
| Deny-by-default `authorize()`, unknown key → boot failure, escalation guard | IMPLEMENTED | `apps/api/src/auth/authorize.ts`, `authorize.test.ts`; `defineRoute` throws on unknown permission (`http/route.ts`) | — |
| Impersonation guardrails: only API keys / secret rotation / bindings / invitations refused | SUPERSEDED | D-062 (commit 4ce1502): every write refused while impersonating, `apps/api/src/http/route.ts:89-161`; D-027 TTL ≤ 60 min kept | Doc fix: replace the guardrail list with "all writes refused" (D-062) |
| RLS + repository filter, tests T-09/T-10/T-11/T-14 | IMPLEMENTED | `tests/isolation/rls-matrix.test.ts`, `tenant-cases.test.ts`, `tests/security/db-security.test.ts` (S-05, S-06, S-10) | — |
| **§5 Events, webhooks, async work** | | | |
| Outbox table + worker poller → BullMQ `events`; webhook HMAC `X-ECLOUD-Signature`, SSRF guard, retries | PARTIAL | `apps/worker/src/jobs/outbox.ts`, `webhook-transport.ts` (DNS pinning, non-public refused, no redirects); no SSE consumer; no webhook registration API (above) | See webhooks item |
| Queues `accounting.ingest`, `coa.dispatch`, `events`, `webhooks.deliver`, `adapters.openwifi.push`, `jobs.*`, `wireguard.reconcile`, `maintenance` | STALE-DOC | host worker log queues: `accounting.drain`, `policy.enforce`, `sessions.reap`, `partitions.ensure`, `retention.prune`, `outbox.publish`, `webhooks.deliver`, `coa.disconnect`, `coa.change`, `controllers.inventory` | Doc fix: queue table from `apps/worker/src/queues.ts` |
| Scheduled jobs: quota reset, expiry sweep, voucher cleanup, nightly accounting reconcile, stale-session close, partitions, `backup.pg_dump`, offline detect, API-key expiry | PARTIAL | present: `sessions.reap` (stale/authorized expiry), `partitions.ensure`, `retention.prune`, `policy.enforce` (quota/schedule/concurrency breaches, `apps/worker/src/jobs/quota.ts`); absent: expiry sweep for users/vouchers/assignments as a job (handled at authorize time), voucher cleanup, nightly reconcile, offline detect (no telemetry), backup job (host `infra/vps-local/backup/backup.sh` instead), API-key expiry sweep (checked at use) | Build `accounting.reconcile` (nightly recompute vs `accounting_records`, log discrepancies) — SECURITY §4.6 depends on it (M); the rest: doc fix |
| **§6 EZE controller integration (Option C → A)** | | | |
| Pilot = Option C; NAS onboarding sheet `GET {o}/nas/{id}/onboarding` | STALE-DOC | implemented as `GET /api/v1/orgs/:orgId/nas/:id/setup-guide` (`apps/api/src/routes/meraki.ts:354`) + `/setup-guides[/:vendorKey]` + `nas/:id/adopt` (`access-points-page.ts:701`) | Doc fix |
| Option A policy-fragment API on ezecontroller, state webhook `/internal/adapters/openwifi/...` | OUT-OF-SCOPE | D-058; nothing on the controller; EZECLOUD side is the export route only | List only |
| **§7 Non-functional** | | | |
| `/internal/aaa/authorize` p95 < 100 ms; verify-gate ordering | IMPLEMENTED | `apps/api/src/internal/verify-gate.ts`, `aaa-password-verify.integration.test.ts`, `scripts/load/authorize.k6.js`, docs/PERFORMANCE.md (lane 1) | — |
| `GET /metrics` Prometheus on internal listener | IMPLEMENTED | `apps/api/src/app.ts:228`, `apps/api/src/metrics.ts`, `apps/worker/src/metrics.integration.test.ts` | — |
| Input limits: JSON 1 MB public / 64 kB internal; assets 5 MiB; list ≤ 200; 31-day raw window | IMPLEMENTED | `app.ts:201-202,234`; `portal-admin/routes.ts` `express.raw` 5 MiB; `accounting.ts` | — |
| File storage MinIO on pilot | SUPERSEDED | D-026 + M10 note: `@ecloud/storage` local/s3 drivers; host api env `STORAGE_DRIVER`, `STORAGE_LOCAL_PATH` | — |
| API versioning `Deprecation`/`Sunset` headers, `X-Internal-Version` | MISSING | no occurrence in `apps/api/src`; `/api/v1` only | No apply (v1 only) |
| helmet CSP strict, CORS allow-list `CORS_ORIGINS`, `TRUST_PROXY=1` | PARTIAL | helmet CSP `default-src 'none'` (`app.ts:193-195`), `trust proxy` = `TRUST_PROXY_HOPS`; no CORS middleware (same-origin SPA via edge, D-029) | Doc fix: CORS not used; note `TRUST_PROXY_HOPS` |
| **§8 Repository layout and testing** | | | |
| Layout `apps/{api,portal,worker}`, `packages/{db,policy-engine,adapters,shared}`, `infra/compose` | IMPLEMENTED | tree matches plus `apps/admin`, `packages/{storage,vendor-api,testing}`, `infra/{vps,vps-local,freeradius,...}` | Doc fix (minor): add the extra packages |
| Unit / contract / integration / e2e (Playwright) / device layers | PARTIAL | unit+contract+integration present (`tests/aaa-contract`, `tests/isolation`, `tests/security`, `tests/simulators`, 60+ `*.test.ts`); **no Playwright** in any `package.json`; `tests/e2e/*.test.ts` are HTTP-level; device harness `tests/device/` | Decide whether admin-SPA browser e2e is wanted before production (see PHASE2 §6.6) |
| **§9 Open questions / device tests** | | | |
| Q1 same-origin API, Q3 impersonation, Q5 object storage, Q8 permission naming | SUPERSEDED | D-029/D-047, D-027/D-062, D-026, D-021 | Doc fix: mark answered |
| Q4 third-party integrations (API keys, webhooks) in release 1? | PARTIAL | API keys built; webhooks half built; no owner ruling found in DECISIONS | Carry to NEEDS-OWNER list via the webhooks item |
| Device tests 1–6 | PARTIAL | #1 reply attributes: pilot AP1832 serves guests on the fleet policy (D-055) — honouring not recorded as a DT; #2 CoA deferred (D-065); #4/#6 OUT-OF-SCOPE (D-058); #5 portal flow proven on AP1832 (D-050 probe, uspot pilot) but not written to PHASE2 §5.4 | Record pilot evidence (see PHASE2 items) |
| **Implementation notes (Phase 3 → Cycle E)** | | | |
| `secret_ref = enc:v1…`; renderer "not implemented here" | STALE-DOC | D-054 re-seal: host NAS/portal refs are `enc:v2.` (row-bound AAD, `apps/api/src/crypto.ts:67-127`, migration 047/048); renderer `apps/api/src/radius-clients/*` live (F-P10-07) | Doc fix: NAS-secret bullet → v2 + renderer |
| `GET /api/v1/openapi.json` "61 paths / 100 operations" | STALE-DOC | route list now ~95 unique paths incl. Cycle A–E, portal-admin, enforcement, reports; test asserts coverage, not the count | Doc fix: drop the numbers |
| D-051 renderer carve-out `FLEET_DEFAULT_RADIUS_SECRET`, `isAcceptableSecret`, `fleetDefaultSecret` count | IMPLEMENTED | `apps/api/src/radius-clients/render.ts:75-169`, `internal/radius-client-lookup.ts:31,98`; not yet in this document | Doc fix: add D-050/D-051 to the AAA notes |
| D-057 fleet-default marking (`nas:secret:fleet_default`, `inherit:`) | SUPERSEDED | D-064 dropped; key absent from host `permissions` and from `packages/shared/src/permissions.ts` | — |
| Session enforcement (P7-A), `ECLOUD_COA_ENABLED` default false, `next_reauth` only | IMPLEMENTED | `apps/api/src/routes/enforcement.ts:301-399`, `apps/api/src/enforcement.ts`; host worker `coaEnabled:false`, `session_actions` 0 rows | — |
| Multi-vendor Cycle A–E endpoints (`access-points`, `controllers/{id}/api-credential`, `setup-guide`, `meraki/cloud-radius`, platform release endpoints) | IMPLEMENTED | route list: `access-points/overview`, `platform/access-points/{release,confirm-inventory}`, `controllers/:id/rotate-credential`, `meraki/cloud-radius`, `platform/meraki/nas-identifiers/release`; migrations 028–033 | Doc fix (minor): credential route is `rotate-credential`, not `api-credential` POST — verify naming in `apps/api/src/routes/controllers.ts` before editing |
| Migration 049 (`portal_registration_devices`) | PARTIAL | file present in repo, **not applied** on vps-local (`schema_migrations` max 048) | Apply migration 049 at the next deploy (A6 gate); confirm the api image that needs it |

## PHASE2_VALIDATION.md

| claim | verdict | evidence | apply item? |
|---|---|---|---|
| **Header / §1 method** | | | |
| No DT marked PASS without execution; CoA/Disconnect stay REQUIRES_DEVICE_TEST | IMPLEMENTED | `packages/adapters/src` registry: 0 `LAB`/`PRODUCTION` evidence rows; `chooseEnforcementStrategy` → `next_reauth`; D-065 | — |
| Headline: per-client rate verified only on uspot path; hostapd path unverified | IMPLEMENTED (as declared) | `packages/adapters/src/adapters/*` four-state statuses; `openwifi-config.ts:59` DT-02 reference | — |
| **§2 ledger (V-001…V-148)** | | | |
| V-001/V-029 `rate-limit` fragment via controller (openwifi-config adapter) | PARTIAL | `packages/adapters/src/openwifi/ucentral-fragment.ts` validates against vendored `ucentral.full.json`; export only, no push (D-058) | — |
| V-040 uspot variant unknown | SUPERSEDED | DT-01 PASS (§5.4): TIP fork; host NAS `adapter_key = openwifi-uspot-uam` | Doc fix: V-040 status → VERIFIED ON DEVICE |
| V-026/V-027 WireGuard on AP | SUPERSEDED | DT-01: no `wireguard`/`unetd` on EZEAP; D-042 WireGuard deferred | Doc fix |
| V-049 uspot sends Message-Authenticator | PARTIAL | D-050 probe 08:06Z "Message-Authenticator verified" after the radcli patch (firmware b07ce354); ledger still U→RDT; pilot NAS row still `require_message_authenticator = false` | Record in §5.4 and re-tighten the pilot NAS (see SECURITY item) |
| V-090/V-091 rlm_rest + rlm_sql insert-only | IMPLEMENTED | `infra/freeradius/raddb/sites-enabled/ecloud`, migration 009, `tests/security/db-security.test.ts` ("radacct_raw is INSERT-only") | — |
| V-095 BlastRADIUS per-client flag | IMPLEMENTED | renderer `require_message_authenticator` + `limit_proxy_state` (P10 §4.3) | — |
| V-096 RadSec listener | PARTIAL | migration `034_nas_radsec.sql`, `apps/api/src/radsec.integration.test.ts`, freeradius env `RADIUS_INTERNAL_CA_FILE`; device half untested | — |
| V-097/V-098 clients by source IP; dynamic clients alternative | IMPLEMENTED | rendered `ecloud-nas.conf` + `GET /internal/radius/client` (`app.ts:238`, `RADIUS_DYNAMIC_CLIENT_*` env on host) | — |
| V-110…V-116 WireGuard hub/peers | SUPERSEDED | D-042/D-043 | — |
| V-130…V-139 design elements (broker credential, adapters, resolution order, session states, RLS) | IMPLEMENTED | `internal/portal-credential.ts`, `packages/policy-engine`, D-022/D-036, migration 010 | — |
| V-142 hosts `ecloud.`/`api.ecloud.`/`portal.ezecloud…`, native Caddy, `/opt/ecloud` | SUPERSEDED | D-047 names; D-041 no Caddy; `/opt/ecloud` kept (D-060 env path) | Doc fix |
| V-143 TOTP mandatory for platform roles | SUPERSEDED | D-046 | — |
| V-144 catalogue ~60 keys | STALE-DOC | host `permissions` = 112 | Doc fix |
| **§3 conflicts C-01…C-13** | | | |
| C-01 colon keys canonical; boot/unit check of SPA keys | PARTIAL | D-021; `packages/shared/src/permissions.test.ts`, admin imports the shared catalogue; no `GET /platform/permissions` route | No build needed; doc fix |
| C-02 specificity order | IMPLEMENTED | D-022; `packages/policy-engine` tests | — |
| C-03 adapters emit `acct-port: 1813` | PARTIAL | fragment export sets RADIUS keys (`ucentral-fragment.ts`); explicit `acct-port` literal not found by grep — verify in the fragment template | Verify `acct-port: 1813` is emitted in `packages/adapters/src/openwifi/ucentral-fragment.ts`; add if absent (S) |
| C-07 sessions row at authorize | IMPLEMENTED | D-036, migration 016; host sessions 1 active / 9 stopped | — |
| C-08 same-origin `/api/v1` + `api.` host | IMPLEMENTED | D-029/D-047 | — |
| C-09 `das_accepts_ma_ets` per adapter | PARTIAL | worker packets carry `Event-Timestamp`/`Message-Authenticator` (`apps/worker/src/coa/*.ts`, 3 refs each); no per-adapter flag named `das_accepts_ma_ets` found | Confirm the adapter `disconnect` declaration carries the MA/ETS toggle (`packages/adapters/src/adapters/uspot-upstream-uam.ts`); add if missing (S) |
| C-10/C-11 per-NAS clients, rendered clients.conf | IMPLEMENTED | P10 §4.3 | — |
| C-13 SEC re-check against AAA/API | IMPLEMENTED | `docs/SECURITY_REVIEW_P10.md` §1 | — |
| **§4 blocking gaps / owner defaults** | | | |
| Owner defaults (naming, order, retention, storage, impersonation, scope) | SUPERSEDED | D-021…D-028 | — |
| **§5 device test plan** | | | |
| DT-01 PASS with fixture | IMPLEMENTED | `test/fixtures/device/EZE-AP1832/r32912-6639b15f62/DT-01_identification_2026-10-07.txt` | — |
| DT-03 attempt "NOT EXECUTED"; results table otherwise empty | STALE-DOC | pilot since 2026-10-14: AP1832 (`d82d9ba1a1aa`) authenticates through the portal + FreeRADIUS (D-050 probe, D-052 `sample` account, D-055 policy); `EZEControl/docs/uam/PILOT_OBSERVATIONS_2026-10-15.md` (lane 2) | Backfill §5.4 rows for DT-03 (attribute matrix incl. MA present) and DT-11 (UAM round trip) from the pilot evidence; EZECLOUD1 to write the evidence-registry entry only for what was measured |
| DT-04/05/06 bandwidth, timers, quota honouring on uspot | MISSING (evidence) | no §5.4 row; `platform_default_policy` 10/10 Mbps live but no iperf3 measurement recorded; adapters stay REQUIRES_DEVICE_TEST | Run DT-04/05/06 on AP1832 with iperf3 (owner at the AP); no code change |
| DT-07/DT-08 Disconnect/CoA | NEEDS-OWNER | D-065: deferred; worker `coaEnabled:false`; `session_actions` 0 | Owner: when can the D-065 Disconnect test on AP1832 run (dynamic-auth on profile 141, owner presses Disconnect)? |
| DT-15 CoovaChilli gateway | NEEDS-OWNER | no EZEGATE lab unit recorded; `coovachilli-uam` adapter built | Owner: is a lab EZEGATE (CoovaChilli 1.2.9) available for DT-15, re-pointable to the pilot FreeRADIUS? |
| DT-18…DT-20, DT-22 (WireGuard, dual-secret failover) | SUPERSEDED | D-042/D-043; DT-18 ruled out by DT-01 | Doc fix |
| DT-21 RadSec on device | PARTIAL | server half built (above); device test pending | — |
| DT-17 telemetry cadence, DT-13 bridge captive, DT-24 secret exposure on AP | OUT-OF-SCOPE | controller/AP inspection work (D-058 allows read-only test support only) | List only |
| **§6 automated test architecture** | | | |
| §6.1 unit: policy goldens, translation goldens, capability schema, RBAC, validators, portal state machine | IMPLEMENTED | `packages/policy-engine/src/*.test.ts`, `packages/adapters/src/{golden,capabilities,enforcement,registry}.test.ts`, `packages/shared/src/permissions.test.ts`, `apps/portal/src/*.test.ts` | — |
| §6.2 contract: rlm_rest fixtures, dictionaries, rlm_sql insert-only, UAM contracts, fake DAS, OpenAPI | IMPLEMENTED | `tests/aaa-contract/freeradius-rest.test.ts` (+ CI job `radius-contract`), `tests/security/db-security.test.ts`, `tests/simulators/{uam-redirect,handoff,accounting}.test.ts`, `apps/worker/src/coa/dispatcher.test.ts`, `apps/api/src/app.test.ts` | — |
| §6.3 integration with fake-nas/fake-das | IMPLEMENTED | `tests/simulators/*`, `apps/api/src/*.integration.test.ts`, CI job `integration` | — |
| §6.4 isolation T-01…T-15, S-04…S-10 | IMPLEMENTED | `tests/isolation/{rls-matrix,tenant-cases}.test.ts`, `tests/security/db-security.test.ts` (S-05, S-06, S-10); S-04/S-07/S-08/S-09 covered in `apps/api` integration suites | — |
| §6.5 security suite: endpoint×role matrix, sqlmap-style fuzz, testssl, CSP report endpoint | PARTIAL | authz unit tests + isolation; no generated endpoint×role matrix, no fuzz, no testssl stage | Add a generated route×role-template matrix test from the `defineRoute` list (M) |
| §6.6 Playwright e2e (portal + admin SPA) | MISSING | no `playwright` dependency; `tests/e2e/*.test.ts` HTTP-level only | Decide scope before production; otherwise doc fix |
| §6.7 k6 performance | IMPLEMENTED | `scripts/load/{authorize,portal}.k6.js`, `seed.ts`; docs/PERFORMANCE.md | — |
| §6.8 negative/recovery drills | IMPLEMENTED | `docs/FAILURE_DRILLS.md`, `scripts/drills/`, `infra/vps-local/backup/restore-drill.sh` (lane 1 verifies content) | — |
| §6.9 CI stages (10 stages incl. e2e, perf, deploy-staging, deploy-pilot) | PARTIAL | `.github/workflows/ci.yml` jobs: `secrets`, `supply-chain`, `check`, `integration`, `radius-contract`, `images`; no e2e/perf/deploy stages | Doc fix: list the six real jobs; deploy stays manual (D-031) |
| §9 "24 DTs resolve 48 ledger rows" | PARTIAL | only DT-01 executed; see items above | — |

## SECURITY_ARCHITECTURE.md

| claim | verdict | evidence | apply item? |
|---|---|---|---|
| **§1 threat model T1–T18** | | | |
| T1 controls (Argon2id, TOTP mandatory, `__Host-` cookie, lockout, fail2ban jail) | PARTIAL | Argon2id/cookie/lockout IMPLEMENTED (P10 T1); TOTP SUPERSEDED (D-046); fail2ban jail drafted for the Ubuntu VPS only — vps-local uses firewalld (D-042) and no fail2ban | Decide host-level brute-force control on vps-local (firewalld + app lockout only today) — owner-pending host item |
| T2 subscriber limits, voucher HMAC | IMPLEMENTED | `PORTAL_LIMITS` (`apps/api/src/internal/portal.ts`), `apps/api/src/crypto.ts` voucher HMAC | — |
| T3 portal HTTPS/HSTS, fixed hostname, `userurl` allow-list | IMPLEMENTED | `apps/portal/src/index.ts` HSTS when secure, `safeUserUrl`; D-047 `portal.ezelink.ai` | — |
| T4 tunnel-only RADIUS, cryptokey routing | SUPERSEDED | D-042: LAN listener `192.168.203.196:1812-1813` + firewalld from the AP subnet; host port binding confirms | Doc fix |
| T5 one secret per NAS, ≥ 32 chars, envelope encryption, rotation with dual window | PARTIAL | per-NAS 43-char random, sealed v2 (D-054); **no dual-secret window** (F-P10-06); fleet default 12-char carve-out (D-051) weakens "≥ 32 chars" for NAS on the default | Build the dual-secret rotation window in the renderer (two client blocks per address are impossible in FR3 → use `secret_previous` accepted by the dynamic-client lookup for N minutes) (M); doc fix for D-051 |
| T6 API abuse: per-key/per-tenant limits | PARTIAL | keys hashed/scoped/`allowed_cidrs`; no request rate limit per key (F-P10-05) | See API item (F-P10-05) |
| T7 injection: parameterised SQL, `radclient` via stdin | IMPLEMENTED | `sql.raw` = 0; `apps/worker/src/coa/radclient.ts:7-32` `execFile` + stdin | — |
| T8 escalation guards, impersonation limits | IMPLEMENTED | `apps/api/src/routes/access.ts`, `administrators.ts`; D-062 stricter | — |
| T9 RLS forced, tenant from NAS identity | IMPLEMENTED | migration 010; `tests/isolation`; `internal/nas-lookup.ts` | — |
| T10 session/cookie, CSP without inline | IMPLEMENTED | `config.ts:289-295`; helmet `default-src 'none'` | — |
| T11 replay: single-use credential, retransmit horizon | IMPLEMENTED | `internal/portal-credential.ts`, `portal.integration.test.ts` | — |
| T13 accounting append-only, INSERT-only role, nightly reconciliation | PARTIAL | append-only triggers + radius role (db-security tests); **no nightly reconciliation job** | Build `accounting.reconcile` (shared with API §5 item) |
| T14 DoS: body limits, rate limits, container limits | IMPLEMENTED | `app.ts` limits; host containers `pids`/memory limits per `infra/vps-local/compose` (`pids: 200`, memory 640M on api) | — |
| T15 no published ports for postgres/redis; api/portal loopback only | IMPLEMENTED | host inspect: postgres/redis `ports=map[]`, api/portal/worker `ports=map[]`; edge is the only published HTTP | — |
| T17 supply chain gates | IMPLEMENTED | `.github/workflows/ci.yml` `supply-chain` (lockfile gate, `npm audit signatures`, SBOM), `images` (Trivy 0.75.0 by digest) | — |
| T18 host operator: per-person accounts, no docker group, auditd | NEEDS-OWNER | D-024 deployment identity deferred; vps-local operated as `ezeadmin` with password sudo (D-041); auditd not verified (read-only session cannot) | Owner: keep single `ezeadmin` operator on vps-local for the pilot, or create the D-024 least-privilege deployment identity now? |
| **§2 trust boundaries / exposure / firewall** | | | |
| §2.2 port table (22/80/443/51820 public, RADIUS on `100.100.0.1`, Caddy admin 2019) | SUPERSEDED | D-041/D-043/D-047: vps-local, EZEOS ports untouched, edge 443/444, RADIUS on LAN IP, Cloudflare tunnel | Doc fix: replace §2.2 with the vps-local exposure table (`docs/VPS_LOCAL_CHANGE_LIST.md`, lane 1) |
| §2.3 nftables outline + `DOCKER-USER`; §2.5 sequencing (`apply-nftables.sh`) | SUPERSEDED | drafts exist (`infra/vps/nftables`, `infra/vps/scripts/apply-nftables.sh`, validated P10 §6.1) but target the cancelled Ubuntu VPS (D-043); vps-local uses firewalld | Doc fix: mark §2.3–2.5 as archived for the Ubuntu VPS; firewalld rules are the live control |
| §2.4 fail2ban jails incl. app events | PARTIAL | app events exist (`apps/api/src/security-events.ts`, portal `portal_auth_failed`), filters drafted in `infra/vps/fail2ban`; not deployed on vps-local | See T1 item |
| **§3 tenant isolation** | | | |
| §3.1 DB roles `ecloud_owner`/`ecloud_app`/`freeradius`, FORCE RLS, no BYPASSRLS; CI RLS coverage test | IMPLEMENTED | migration 010; `tests/security/db-security.test.ts` S-06 ("every table with an organization_id column … RLS enabled + forced"); roles `ecloud_app`/`ecloud_platform`/`ecloud_radius` | — |
| §3.1 `radius.nas_v` clear-secret view | STALE-DOC | not created; rendered clients + dynamic lookup instead (C-11) | Doc fix |
| §3.2 one /24 per tenant, no site-to-site forwarding | SUPERSEDED | D-042 | — |
| §3.3 NAS-Identifier must match record; `md` as hint; voucher constant-time; webhook HMAC + timestamp; impersonation forbids secret/admin mutations; FK re-check | IMPLEMENTED | `internal/aaa.ts` (NAS-Identifier match, SECURITY §3.2 note in API doc), `internal/portal.ts` (`md`), `webhook-transport.ts`, D-062, `assertRef` G9 | — |
| §3.4 S-01…S-10 tests | PARTIAL | S-05/S-06/S-10 in `tests/security/db-security.test.ts`; S-04/S-08/S-09 in api integration suites; S-01–S-03 lab-only (WireGuard, superseded); S-07 webhook replay: transport signs but no receiver test | Add S-07 receiver-side replay test to `apps/worker/src/jobs/webhook-transport.test.ts` (S) |
| §3.5 Meraki per-NAS listener model, flag default false | IMPLEMENTED (build-only) | `packages/shared/src/meraki-cloud-radius.ts` (`MERAKI_*` env), migration 032, `apps/api/src/radius-clients/meraki.test.ts`, `apps/worker/src/coa/meraki.test.ts`; D-044: live use needs public RADIUS → blocked by D-043 | — |
| **§4 AAA security** | | | |
| §4.1 generation 32–48 chars `[A-Za-z0-9]` | IMPLEMENTED | 32 random bytes base64url (43 chars) — alphabet includes `-_`, accepted by the renderer allow-list | — |
| §4.1 storage: `secret_blobs` table, per-record data key, `kid` for master-key rotation | PARTIAL | inline `enc:v2.<iv>.<ct>.<tag>` in `secret_ref` with row-bound AAD (`apps/api/src/crypto.ts:67-127`); **no key id / key ring** (F-P10-04 open); `apps/api/dist/secret-reseal-cli.js` exists for re-seal (D-054) | Build key-ring support: `v2.<kid>` or a `DATA_ENCRYPTION_KEY_PREVIOUS` opener + background re-wrap, keep v1/v2 readable (M, A8 gate) |
| §4.1 rotation dual-secret window via AP secondary RADIUS server | PARTIAL / OUT-OF-SCOPE (AP half) | no EZECLOUD dual window (F-P10-06); AP `secondary` server config is controller work (D-058) | See T5 item |
| §4.1 separate `coa_secret_ref` | MISSING | no `coa_secret_ref` column in migrations (grep 0); worker uses the NAS secret via D-061 | No apply until a NAS with a distinct DAS secret exists; doc fix |
| §4.2 `require_message_authenticator = yes` default; relaxed client gets `limit_proxy_state = yes`; alert when a client runs with `no` | PARTIAL | renderer IMPLEMENTED (P10 §4.3); **no alert**; pilot NAS `01a13011…` runs with `require_message_authenticator = false` although firmware b07ce354 now sends MA (D-050 probe) | Re-tighten the pilot NAS (`PATCH …/nas/{id} {require_message_authenticator: true}`, re-render, restart FreeRADIUS) after one confirming capture; add a `/platform/health` warning for relaxed clients (S) |
| §4.3 RadSec production path | PARTIAL | server side built (034, tests); device untested | — |
| §4.4 CoA: hub-originated, S-10 tenant check, `session_actions` non-repudiation | IMPLEMENTED (dispatcher off) | `apps/worker/src/coa/dispatcher.ts`; `tests/security` S-10; host `coaEnabled:false` | — |
| §4.5 EAP private CA, `default_eap_type` peap/ttls | PARTIAL | `ecloud-inner` EAP-TTLS site exists (`infra/freeradius/raddb/sites-enabled/ecloud`, Cycle A); CA/cert lifecycle not implemented (no WPA-Enterprise in pilot, open Q4) | Doc fix; no apply |
| §4.6 nightly reconciliation; optional hash chain | MISSING | no `chain_hash` (grep 0), no reconcile job; SIM-14 wrap correction exists (`accounting_anomalies`) | Reconcile job (above); hash chain stays optional |
| §4.8 MAC-auth `low_assurance_ok` policy flag, duplicate-MAC alert | MISSING | `client_devices.mac_auth_enabled` exists; no policy flag, no duplicate-MAC alert | Owner question folded into §12 Q8 (below) |
| **§5 captive portal** | | | |
| 5.1 HTTPS + HSTS, separate origin | IMPLEMENTED | portal HSTS when secure; D-047 separate hostname | — |
| 5.2 `uam-secret` mandatory, sealed | IMPLEMENTED | P6-B: no secret on create, `rotate-uam-secret` mandatory, host portal ref `enc:v2.` | — |
| 5.3 `userurl` filter | IMPLEMENTED | `safeUserUrl` | — |
| 5.4 rate limits | IMPLEMENTED (stricter) | `PORTAL_LIMITS` | — |
| 5.5 voucher alphabet/length/HMAC, batches ≤ 10 000 | IMPLEMENTED | `apps/api/src/routes/vouchers.ts`, sync cap 1000 | — |
| 5.6 credential `pc-<16 hex>`, 90 s, bound to NAS+MAC+session | IMPLEMENTED | `internal/portal-credential.ts` | — |
| 5.7 `custom_css` sanitised | IMPLEMENTED (stricter) | P6-B: `custom_css` not accepted | — |
| 5.8 CSP `default-src 'self' …` | STALE-DOC | `apps/portal/src/index.ts:305-306`: `default-src 'none'` + nonce, `form-action 'self' <nas> <login> <vendor>`, `frame-ancestors 'none'`, `base-uri 'none'` | Doc fix |
| 5.9 social login OIDC/PKCE | SUPERSEDED | Q64/D-023: no social IdP in pilot; e-mail OTP via SendGrid instead (D-060, `internal/otp.ts`) | Doc fix |
| 5.10 retention (attempts 90 d, auth_events 90 d, sessions 13 m) | PARTIAL | D-025: raw 7 d / accounting 13 m / audit 24 m applied by `apps/worker/src/jobs/retention.ts` (`RETENTION_APPLY`, host `retentionApply:false`); `portal_login_attempts`/`auth_events` 90-day pruning not in the job (grep 0) | Add `portal_login_attempts` and `auth_events` pruning to `retention.prune` (S, A6) and turn `RETENTION_APPLY` on at the pilot after a dry-run plan |
| **§6 admin platform** | | | |
| 6.1 Argon2id m=19456 t=2 p=1 | IMPLEMENTED | `packages/db/src/admin.ts:11` | — |
| 6.2 / 6.2.1 MFA off by default (D-046) | IMPLEMENTED | `mfa-mode.integration.test.ts`; host `ADMIN_MFA_MODE` env | — |
| 6.3 `api.` host Bearer-only never cookies; re-auth for sensitive actions | PARTIAL | cookie model IMPLEMENTED; edge/tunnel rule "api host refuses cookies" not verified on vps-local (edge config outside this lane); re-auth for secret reveal dropped with D-046 | Lane 1/3: confirm the edge config for `api.ezelink.ai` strips/ignores cookies; otherwise doc fix |
| 6.4 CSRF `X-CSRF-Token` | STALE-DOC | `Origin` + `X-Requested-With` (`apps/api/src/auth/middleware.ts`) | Doc fix (with API §4) |
| 6.6 API keys `ek_<prefix8>` | STALE-DOC | `eck_<12>_<43>` (`routes/access.ts:622`) | Doc fix |
| 6.7 audit coverage incl. `withPlatform()` calls, exports, CoA requests | IMPLEMENTED | `audit.ts`; `platform:access` rows; export guard audits; `session:disconnect` audit | — |
| 6.8 SSRF rules for webhooks/IdPs, `additionalProperties:false`, lint forbidding raw queries | PARTIAL | webhooks + vendor-api SSRF IMPLEMENTED; zod strict per schema; no eslint rule found (`eslint.config.*` has no `no-restricted` entry) and `sql.raw` is simply unused | Add an eslint `no-restricted-syntax` rule for `sql.raw`/`pool.query` in `apps/*` (S) |
| 6.9 Renovate weekly, base images by digest, gitleaks | PARTIAL | digests + Trivy + lockfile gate IMPLEMENTED; no Renovate/Dependabot (`.github/dependabot.yml`, `renovate.json` absent); `scripts/check-no-secrets.sh` instead of gitleaks | Add Dependabot config for npm + Docker + Actions (S) |
| 6.10 container hardening (non-root, read-only, cap_drop ALL, no-new-privileges, pids) | IMPLEMENTED | host inspect api/worker/portal/redis `ro=true capdrop=[ALL] no-new-privileges`, freeradius `ro=true capdrop=[ALL]` (runs as `freerad` via entrypoint; `Config.User` empty); postgres unhardened by design | — |
| 6.11 secrets via `*_FILE`, no values in `docker inspect` | IMPLEMENTED | host api/worker/freeradius env names are all `*_FILE` for secrets (`DATA_ENCRYPTION_KEY_FILE`, `INTERNAL_SECRET_TOKEN_FILE`, `SMTP_PASSWORD_FILE`, …) | — |
| **§7 WireGuard** | SUPERSEDED | D-042/D-043 | Doc fix: mark deferred |
| **§8 logging/alerting** | | | |
| Alert rules (auth failures, unknown NAS, CoA NAK rate, relaxed MA client, stale wg peer, disk, pg connections) | MISSING | `/metrics` exists; no alert router/webhook; `/platform/health` reports some counts | Decide alert channel (owner Q10) then wire Prometheus/alert rules on vps-local (lane 1 ops) |
| **§9 secrets management** | | | |
| `/opt/ecloud/secrets/*` files, Compose secrets | IMPLEMENTED | D-060/D-061: `/opt/ecloud/secrets/smtp_password`, `internal_secret_token` manifest; host env `*_FILE` | — |
| Rotation table (master key yearly with `kid`, session key ring, Postgres password 180 d) | PARTIAL | re-seal CLI (D-054) covers version bumps; no `kid`; runbooks in `docs/SECRETS_MANAGEMENT.md` (lane 2) | See key-ring item |
| **§10 backups / runbooks** | | | |
| 10.1 nightly `pg_dump` + `age`, restore drill with RLS negative test | IMPLEMENTED | `infra/vps-local/backup/{backup.sh,restore.sh,restore-drill.sh,recipients.example.txt}`; `docs/RESTORE_DRILL.md` (lane 1 verifies execution) | — |
| 10.2 `nas_clients.status='quarantined'` | STALE-DOC | no such status (grep 0); NAS block/unblock routes exist (`/nas/:id/block`, `/unblock`, migration 046) | Doc fix: runbook uses `block` |
| **§11 production gate** | PARTIAL | P10 review covers code + drafts; live gate against `ss -lntup`, edge config, FreeRADIUS clients on vps-local not performed | Schedule the live production-gate review (A8) once D-065 and migration 049 land |
| **§12 open questions** | | | |
| Q17/Q21/Q22 OVH console, host hardening, operator accounts | SUPERSEDED | D-043 old VPS cancelled; D-041 vps-local | Doc fix |
| Q4 EAP scope, Q8 MAC-auth low assurance, Q10 alert channel | NEEDS-OWNER | no DECISIONS row answers them | Owner: (a) WPA-Enterprise in scope? (b) restrict MAC-auth to flagged policies? (c) alert channel (webhook target)? |
| **§13 vendor-API rules 1–15** | IMPLEMENTED | `packages/vendor-api/src/http.test.ts`, `clients.test.ts`, `apps/api/src/cycle-d.integration.test.ts`; `VENDOR_API_DENY_CIDRS` in config | — |

## docs/SECURITY_REVIEW_P10.md

| claim | verdict | evidence | apply item? |
|---|---|---|---|
| **§1 T1–T18 evidence** | | | |
| T1 implemented controls incl. MFA atomic attempts, fail2ban events | IMPLEMENTED | `apps/api/src/auth/mfa-verify.test.ts`, `security-events.ts`; TOTP part SUPERSEDED by D-046 | — |
| T4 tunnel-only RADIUS on `100.100.0.1` (drafted) | SUPERSEDED | D-042 LAN binding; host port binding | Doc fix |
| T5 `enc:v1` sealing | STALE-DOC | D-054: v2 on the host | Doc fix |
| T6 `api.` vhost Bearer-only (drafted Caddy) | SUPERSEDED | D-041 no Caddy; edge container | Doc fix |
| T7, T8, T9, T10, T11, T12, T13 controls with named tests | IMPLEMENTED | files cited exist: `http/route.ts`, `coa/radclient.ts`, `auth/authorize.ts`, `tests/isolation/*`, `auth/middleware.ts`, `config-hardening.test.ts`, `portal-credential.ts`, `tests/security/db-security.test.ts` | — |
| T14 container limits (drafted) | IMPLEMENTED | host inspect limits + `infra/vps-local/compose` `pids`/memory | — |
| T15 pilot: no ports on postgres/redis, internal listener never published | IMPLEMENTED | host inspect | — |
| T16 wg0 input rules | SUPERSEDED | D-042 | — |
| T17 CI gates | IMPLEMENTED | `ci.yml` `supply-chain`, `images` | — |
| T18 sshd drop-in, apply scripts with dead-man | SUPERSEDED (host) | drafts for the Ubuntu VPS; vps-local sshd managed by EZEOS (D-041) | Doc fix |
| **§2 SECURITY.md baseline** | | | |
| TLS DRAFTED (Caddy) | SUPERSEDED | D-047 Cloudflare tunnel + self-signed origin | Doc fix |
| Password hashing, RBAC, sessions, CSRF, validation, parameterised DB, audit — IMPLEMENTED | IMPLEMENTED | as §1 rows | — |
| RADIUS secrets: GAP key ring, dual window | MISSING (still) | no `kid` (`crypto.ts`), no dual window (grep 0) | Same two items as SECURITY §4.1 |
| Backups cycle P10-B | IMPLEMENTED | `infra/vps-local/backup/*`, `docs/RESTORE_DRILL.md` | — |
| **§4.1 fixed findings** | | | |
| F-P10-01 atomic MFA attempts, per-IP limit | IMPLEMENTED | `routes/auth.ts:240-260`, `mfa-verify.test.ts` | — |
| F-P10-02 security events | IMPLEMENTED | `security-events.ts`, portal `index.ts:896` | — |
| F-P10-03 `*_FILE` secrets | IMPLEMENTED | `packages/shared/src/secret-files.test.ts`; host env | — |
| F-P10-08 production cookie checks | IMPLEMENTED | `config.ts:289-295` | — |
| F-P10-09 redaction keys | IMPLEMENTED | `logger-redaction.test.ts` | — |
| F-P10-10 `INTERNAL_API_TOKEN_PREVIOUS` | IMPLEMENTED | `internal/aaa.ts:980-995`, `token-rotation.test.ts` | — |
| F-P10-11 digest pins + upgrade at build | IMPLEMENTED | `infra/docker/Dockerfile`, `infra/freeradius/Dockerfile`; `ci.yml:191` Trivy by digest | — |
| F-P10-13 nftables hazards fixed in drafts | SUPERSEDED | Ubuntu VPS drafts unused on vps-local (D-043) | — |
| **§4.2 listed findings** | | | |
| F-P10-04 key ring | MISSING | see above | Key-ring item |
| F-P10-05 per-key rate limit | MISSING | see above | Rate-limit item |
| F-P10-06 dual-secret window | MISSING | see above | Dual-window item |
| F-P10-07 renderer fixed | IMPLEMENTED | `apps/api/src/radius-clients/*`, `radius-clients.integration.test.ts`; host freeradius env `RADIUS_CLIENTS_RENDERED` | — |
| F-P10-14 tailwind 4 migration | PARTIAL | dev-only advisories; no migration recorded | Low priority; no apply tonight |
| F-P10-16 `/readyz` public reveals dependency status; F-P10-17 `/metrics` unauthenticated internal | PARTIAL | `/readyz` on the public app (`app.ts:165`); edge blocking of `/readyz`/`/metrics`/`/internal` on vps-local not verified (edge config outside this lane) | Lane 1: confirm the edge returns 404 for `/readyz`, `/metrics`, `/internal` on all three hostnames (the Caddy fix F-P10R-2 must have an edge equivalent) |
| F-P10-19 owner host items (deploy identity, auditd, token files) | NEEDS-OWNER | D-024 deferred; no DECISIONS row closes them for vps-local | Owner: decide the deployment identity and auditd/AIDE for vps-local before production |
| F-P10-20 worker cannot open `enc:` secrets for CoA | IMPLEMENTED | D-056/D-061: `/internal/nas/:id/secret`, worker client; host env on both containers; D-065 device half pending | Doc fix: strike F-P10-20 |
| F-P10-21 Actions by tag, no Renovate | MISSING | `ci.yml:23-112` `@v4` tags; no dependabot/renovate | Pin Actions by SHA + Dependabot (S) |
| F-P10-22 FreeRADIUS read-only/tmpfs not runtime-verified on Linux | IMPLEMENTED | host inspect: freeradius `ReadonlyRootfs=true`, `CapDrop=[ALL]`, healthy | Doc fix: mark verified on vps-local |
| **§4.3 / §8 review fixes** | | | |
| Rendered clients: `nas-<uuid>`, secret allow-list 16–128, SIGHUP insufficient → restart, exit codes | IMPLEMENTED | `render.ts` (`SECRET_RE`, `isAcceptableSecret` D-051 exception), `radius-clients.integration.test.ts` "SIGHUP is not enough"; `tests/scripts/radius-reload-watch.test.ts` | — |
| Migration 027 unicast CHECK | IMPLEMENTED | `027_nas_ip_unicast_host.sql`; host migration 27 applied | — |
| F-P10R-1…R-4 Caddy/nftables/sshd fixes | SUPERSEDED | Ubuntu VPS only (D-043) | — |
| F-P10R-5 `INTERNAL_API_TOKEN_PREVIOUS` warning | IMPLEMENTED | `internal/aaa.ts` / startup warning | — |
| F-P10R-7b Actions SHA pinning accepted residual | NEEDS-OWNER | still by tag | Owner: accept tag pinning for the pilot, or pin by SHA now (S)? |

## Apply items (lane 4 summary, in proposed order)

1. Apply migration 049 on vps-local at the next deploy (pending; A6 gate).
2. Re-tighten `require_message_authenticator` on the pilot NAS and add a relaxed-client warning to `/platform/health` (S, A8).
3. Key ring for `DATA_ENCRYPTION_KEY`/`MFA_ENCRYPTION_KEY` (`kid` or `*_PREVIOUS` opener + re-wrap) — F-P10-04 (M, A8).
4. Dual-secret rotation window for NAS secrets via the dynamic-client lookup — F-P10-06 (M, A3+A8).
5. Per-API-key / per-tenant request rate limit + invalid-key throttle — F-P10-05 (S/M, A8).
6. Nightly `accounting.reconcile` job (SECURITY §4.6, API §5) (M, A3).
7. Retention: prune `portal_login_attempts`/`auth_events` (90 d) and enable `RETENTION_APPLY` after a plan dry-run (S, A6).
8. Audit-log CSV export route under the export guard (S).
9. Webhook management endpoints or an explicit "worker-only until requested" note (needs owner Q4).
10. Dependabot + SHA-pinned Actions; eslint rule against `sql.raw`/`pool.query` (S).
11. Backfill PHASE2 §5.4 with the AP1832 pilot evidence (DT-03/DT-11) and run DT-04/05/06 with iperf3; D-065 Disconnect test when the owner is at the AP.
12. Doc fixes (STALE-DOC rows above): hostnames (D-047), topology (D-041/D-043), config names, queue/job tables, CSRF scheme, API-key format, Argon2 params, impersonation rule (D-062), `enc:v2`, D-061 endpoint, portal CSP, `block` instead of `quarantined`, strike F-P10-20.

NEEDS-OWNER questions (one line each): D-065 Disconnect test date on AP1832; lab EZEGATE availability for DT-15; keep single `ezeadmin` operator vs D-024 identity on vps-local; WPA-Enterprise in scope (Q4) / MAC-auth low-assurance flag (Q8) / alert channel (Q10); host-level brute-force control on vps-local (firewalld only today); F-P10-19 auditd/AIDE and token files; accept Actions tag pinning for the pilot.
