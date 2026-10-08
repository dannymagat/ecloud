# Project Status

## Current Stage
`PHASE 3 — FOUNDATION IMPLEMENTATION (LOCAL) COMPLETE — AWAITING OWNER REVIEW`

Owner approved the Phase 2 decision gate on 2026-10-07 (DECISIONS.md D-021 … D-034). Phase 3 is authorised for **local development on the MacBook only**. **VPS deployment is gated (D-031)**: no remote host, EZEAP, EZE controller, DNS, firewall, Caddy or RADIUS exposure change may happen until the exact change list is presented and approved.

## Confirmed Goal
Multi-tenant cloud bandwidth management platform (ECLOUD): admin policy control, captive portal (uspot / CoovaChilli), AAA/RADIUS, policy translation to verified device mechanisms on EZEAP / TIP OpenWiFi, sessions/accounting, reporting, WireGuard site connectivity, domains `ecloud.ezelink.ai`, `api.ecloud.ezelink.ai`, `portal.ecloud.ezelink.ai`.

## Owner Decisions in Force (2026-10-07)
- D-001…D-020 APPROVED as design. **D-006 (CoA/Disconnect) stays REQUIRES_DEVICE_TEST.** Approval ≠ verified device capability.
- Permission naming `resource:action` (D-021). Specificity `temporary > client_device > user > voucher_batch > user_group > site > organization default` (D-022).
- Q23–Q82 defaults accepted; amendments: deployment identity (D-024), retention as pilot defaults only (D-025), storage abstraction / no MinIO (D-026), constrained impersonation (D-027), model all policy types with staged enforcement and the four-state adapter field status (D-028).
- Domains and same-origin `/api/v1` for the admin SPA (D-029); `/opt/ecloud` and the Caddy change procedure (D-030); tunnel-only RADIUS, hub `100.100.0.1`, UDP 51820 pending collision check (D-032); no secrets in Git (D-033); device-test rule and lab availability (D-034).

## Phase 3 Scope (authorised, local)
Repository structure, application architecture, TypeScript project, database schema/migrations, policy engine, adapter interfaces, API foundation, RBAC foundation, tenant isolation, unit tests, integration-test framework, Docker development definitions, documentation.

Not authorised: EZEAP changes, EZE controller changes, public RADIUS, public DNS, any VPS change.

## Phase 3 Milestones
| # | Milestone | Status |
|---|---|---|
| M1 | Governance artifacts updated with owner decisions | DONE 2026-10-07 |
| M2 | Monorepo scaffold (npm workspaces, TypeScript, lint, test runner, Compose dev stack, env template) | DONE 2026-10-07 — build, lint, 48 tests green |
| M3 | Database package: migrations, RLS, seeds (permissions, role templates), migration runner, tests | DONE 2026-10-07 — 11 migrations, 37 tables, FORCE RLS on 31, 53 tests incl. 12 integration |
| M4 | Policy engine + adapters packages: intent model, resolution, capability declarations (four-state), translation, golden tests | DONE 2026-10-07 — 125 tests, ~98% line coverage; orchestrator downgraded 2 CoA declarations per D-006 |
| M5 | API foundation: auth, sessions, RBAC middleware, tenant context, core CRUD, internal AAA authorize, OpenAPI | DONE 2026-10-07 — endpoint list and deliberate exclusions in API_ARCHITECTURE.md "Implemented endpoints" / "Not implemented in Phase 3"; MFA enforcement, AAA tenant attribution hardened in M8 |
| M6 | Worker skeleton + FreeRADIUS dev container definition (rlm_rest / rlm_sql insert-only) | DONE 2026-10-07 — FreeRADIUS container (accept/reject/unavailable, insert-only accounting, retransmit ACK); worker: accounting drain, quota, reap, CoA dispatcher (disabled by default, D-006), outbox → webhooks with SSRF guard, partitions, retention (dry-run default) |
| M7 | Integration-test framework, tenant-isolation tests, CI workflow | DONE 2026-10-07 — 578 tests green against PostgreSQL 16 + Redis 7 (`npm run test:integration`), 0 `it.fails` left; FreeRADIUS contract suite (8 tests) runs in CI `radius-contract` (needs Docker) |
| M8 | Security review of auth/RBAC/RLS code; reconciliation; docs | DONE 2026-10-07 — see reconciliation log; findings fixed with regression tests |

## Orchestrator Reconciliation Log (Phase 3)
- 2026-10-07 — Adapter declarations `coovachilli-uam.coaChange` and `openwifi-config.coaChange` were delivered as VERIFIED_SUPPORTED (documentation-verified); downgraded to REQUIRES_DEVICE_TEST per owner rule D-006/D-034 and a guard test added so no adapter can declare verified CoA/Disconnect before device tests.
- 2026-10-07 — `infra/compose/postgres-init/01_roles.sql` gained the `ecloud_radius` role and `GRANT CREATE ON DATABASE` for the platform role (needed by migration 009); applied out-of-band to the running local dev stack.
- 2026-10-07 — Incident (local dev DB only, no remote impact): while cleaning temporary test objects the FreeRADIUS agent dropped the `radius` schema on the local `ecloud` dev database after migrations had been applied; it re-applied migration 009 and verified objects and ownership. Grants to `ecloud_radius` were re-applied by the orchestrator. No files, volumes or remote systems affected. Lesson recorded: agents must not drop shared schemas on the dev stack.

- 2026-10-07 — M8 security review (findings from the A9 audit + Codex audit pass, rebuilt and verified in the cloud dev container; local only, no remote change):
  - **T-15** tenant could DELETE platform role templates / their grants → migration 012 (`RESTRICTIVE … FOR DELETE` guards). `it.fails` → `it`.
  - **T-A6** retransmitted Accounting-Request got no Accounting-Response → `sites-enabled/ecloud` maps rlm_sql `noop` to `ok`. `it.fails` → `it`; verified on FreeRADIUS 3.2.5 locally, 3.2.10 in CI.
  - **MFA** was reported but not enforced for platform bindings / `mfa_enforced` → migration 013 `admin_sessions.mfa_verified_at`; sessions without a proved factor hold no permissions (SECURITY_ARCHITECTURE §6.2). Closes API_ARCHITECTURE open question 4.
  - **AAA tenant attribution**: authorize fell back to the NAS-supplied NAS-Identifier; post-auth trusted any `Class`; the accounting drainer resolved the NAS from NAS-IP-Address and attached Class-matched records even for unknown NAS → resolution only from authenticated source IP / client shortname; migration 014 `radacct_raw.packet_src_ip` written by FreeRADIUS; unattributed rows never touch sessions/usage (T-05, T-08 regression tests).
  - **Webhook SSRF**: delivery used global `fetch` on tenant URLs (http, internal addresses, redirects) → https-only transport with public-address check and DNS pinning, no redirects; delivery re-checks webhook/job/envelope organization (T-12).
  - `format:check` failed on three `tsconfig.build.json` files (CI `check` job) → formatted.
- Not done in M8 (needs owner input or later phase): `openwifi_ucentral` adapter ambiguity (API_ARCHITECTURE open question 1); MFA reset/disable for a lost device; `sessions.status = authorized` (open question 2).

## Phase 4 — Core Administration (LOCAL) — progress 2026-10-08
Owner accepted recommendations D-035 … D-038 (NAS adapter key, authorized session state, voucher limits, MFA reset by platform super admin).

| Item | Status |
|---|---|
| Backend for D-035 … D-038 (migrations 015–018) | DONE — applied to local dev DB; 99-permission catalogue (`administrator:mfa_reset` added) |
| API gaps: administrator edit/disable, platform administrators/role templates/audit log/health, `/me/sessions`, users CSV import, voucher batch export (metadata only) | DONE — 61 paths / 100 operations in OpenAPI |
| Admin web app `apps/admin` (React + TypeScript + Tailwind SPA) | DONE (first cut) — login + MFA, org switcher, permission-driven nav, impersonation banner, org and platform screens, policy editor with per-adapter four-state preview, Disconnect disabled (no adapter VERIFIED); 40 component tests; browser smoke against local API |
| Verification (orchestrator, 2026-10-08) | build, lint, format:check, secrets scan OK; **639/639 integration tests** incl. FreeRADIUS contract |
| Not yet built | Admin: My sessions page, voucher CSV export button, administrator edit UI, custom role editor, schedules CRUD, reports, portal designer, i18n/RTL, committed Playwright E2E. API: session Disconnect endpoint (gated by D-006), org-scoped adapter catalogue, draft-policy preview without a subject, dashboard counts endpoint, platform admin invitations |
| Dependency audit | 0 production vulnerabilities; 7 dev-only (Tailwind 3 toolchain: braces/micromatch/postcss) |

Reconciliation: orchestrator removed placeholder credentials from URLs in `apps/admin/scripts/generate-api.mjs` (secrets-scan finding; values were inert, now no user/password in URL); OpenAPI output unchanged.

## Continuous Engineering Loop (adopted 2026-10-08)
Workflow for every authorized Phase 3 task = ECLOUD_MULTI_VENDOR_HOTSPOT.md §11 (plan → implement → automated tests → independent QA/security review → fix → retest; stop after 3 failed cycles on one issue or at any gate; promote only evidenced results). Routine local changes proceed without per-change approval; VPS, device, DNS, Caddy, EZECONTROL, security and architecture gates still apply.

### Audit 2026-10-08 — implementation vs approved architecture
| Phase 3 scope item (owner authorization) | Evidence | State |
|---|---|---|
| Repository structure, TypeScript project, lint/test/CI | 9 workspaces, CI jobs check/integration/radius-contract/secrets | DONE |
| Database schema/migrations, RLS, tenant isolation | 18 migrations, FORCE RLS, isolation + security suites | DONE |
| Policy engine, adapter interfaces | 5 first-party adapters, golden tests | DONE (no evidence levels; multi-vendor contract absent) |
| API foundation, RBAC | 61 paths, resource:action catalogue (99) | DONE |
| Unit tests, integration-test framework | 639/639 incl. FreeRADIUS contract | DONE |
| **Docker development definitions** | compose has postgres/redis/freeradius only; **no Dockerfiles for api/worker/portal/admin** | **INCOMPLETE → M9** |
| Application architecture: storage abstraction (D-026) | config variable only, no interface/drivers | **INCOMPLETE → M10** |
| Multi-vendor foundation (hotspot spec §9: registry, vendor-neutral contract, evidence levels, simulators, data structures) | none | **INCOMPLETE → M11** (sub-tasks L1–L4) |
| Documentation | architecture + DEVELOPMENT/TESTING docs | DONE (updated per cycle) |
Out of Phase 3 scope: portal UI beyond skeleton (Phase 6), backups (Phase 10), any VPS/device/DNS/Caddy action (gated).

| Cycle | Milestone | Status |
|---|---|---|
| 1 | M9 Reproducible container images for api/worker/portal/admin (local build + compose `app` profile; no deployment) | **DONE 2026-10-08** — see cycle log |
| 2 | M10 Storage abstraction (D-026): interface, local + S3-compatible drivers, contract tests | **DONE 2026-10-08** — see cycle log |
| 3+ | M11 Multi-vendor foundation L1–L4 | NEXT |

### Cycle log
**Cycle 1 — M9 container images — DONE 2026-10-08**
- Implemented: `infra/docker/Dockerfile` (multi-target api/worker/portal/admin, Node 22.23.3 bookworm-slim, workspace-scoped `npm ci`, no dev deps at runtime, tini, non-root, HEALTHCHECK), `prune-runtime.sh`, `.dockerignore`, admin served by unprivileged nginx (LOCAL testing only; production stays native Caddy, D-030) with CSP, nosniff, frame deny and hidden-path 404; compose `app` and `migrate` profiles (127.0.0.1 only, read-only root, cap_drop ALL, no-new-privileges, memory/pids limits); portal graceful shutdown.
- Review: independent security review → PASS WITH FIXES (low/info only: nginx CSP + hidden paths, XFF, runtime tidy, doc precision). Fixed in one round.
- Tests: four amd64 images built; all `/healthz` 200; SPA loads in a headless browser with 0 CSP violations; portal stops with exit 0; images refuse to start in production mode with dev defaults or local storage without opt-in.
- Not done (VPS change-list items, gated by D-031): digest pinning, apt pinning, registry push, multi-arch CI. radclient 3.2.1 in the worker image vs FreeRADIUS 3.2.10 server.

**Orchestrator verification after cycles 1–2 (2026-10-08):** build, lint, format:check, secrets scan OK; integration 743 passed, 1 skipped (S3 contract without endpoint) across 63 files.

**Cycle 2 — M10 storage abstraction (D-026) — DONE 2026-10-08**
- Implemented `@ecloud/storage`: `ObjectStorage` interface, tenant-scoped keys `org/{org}/{purpose}/{id}` (traversal, absolute, null-byte, uppercase and cross-tenant keys rejected), branding purpose (PNG/JPEG/WebP ≤ 5 MiB, magic-byte check, SVG rejected), local driver (versioned content + metadata commit, 0700/0600, symlink protection, stale tmp sweep), S3 driver (AWS SDK v3, path-style, signed URLs pin stored content type), `forTenant()` scoping. Production guard: local driver refused in production without `STORAGE_LOCAL_ALLOW_PRODUCTION=true`; non-https S3 endpoint refused.
- Review: independent security review → PASS WITH FIXES (1 medium: bucket-missing reported as object-missing; 8 low). All fixed in one fix round; orchestrator spot-checked the medium fix.
- Tests: `npm test` 498 passed; integration 735 passed; S3 contract 14/14 against a throwaway RustFS container (2026-10-08, digest recorded by agent); secrets scan OK.
- Evidence limits: S3 driver tested against RustFS only (AWS/R2/B2/Wasabi untested). Not wired into the API yet (no asset endpoint exists).


## Verified Environment Facts
See REMOTE_ENVIRONMENT.md and PHASE2_VALIDATION.md. Ledger: 105 claims — 40 verified, 17 proposed, 1 unknown, 47 requires device test; 24 device tests (DT-01…DT-24). **DT-01 executed 2026-10-07 (PASS, identification only)** on lab AP EZE-AP1832, EZEAP 6 r32912, uCentral schema 4.2.0: uspot is the TIP fork; no WireGuard/unetd on the AP (topology B unsupported on this firmware); hostapd supports DAS and dynamic VLAN. DT-02…DT-24 not executed. No device configuration was changed.

## Open Items Needing Owner Input
- VPS deployment gate (D-031): exact change list to be presented before first deployment; Q16/Q17/Q18/Q19/Q20/Q21 decided then.
- Device-test lab schedule (D-034).
- Production regulatory retention (D-025) before production.

## Next Action
Phase 3 milestones M1–M8 complete locally. Owner decisions pending: API_ARCHITECTURE open questions 1–3, then the D-031 VPS change list (no remote change until approved).
