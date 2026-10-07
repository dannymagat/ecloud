# Project Status

## Current Stage
`PHASE 3 — FOUNDATION IMPLEMENTATION (LOCAL) IN PROGRESS`

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
| M5 | API foundation: auth, sessions, RBAC middleware, tenant context, core CRUD, internal AAA authorize, OpenAPI | IN PROGRESS |
| M6 | Worker skeleton + FreeRADIUS dev container definition (rlm_rest / rlm_sql insert-only) | FreeRADIUS container DONE 2026-10-07 (smoke-tested accept/reject/unavailable + insert-only accounting); worker IN PROGRESS |
| M7 | Integration-test framework, tenant-isolation tests, CI workflow | IN PROGRESS |
| M8 | Security review of auth/RBAC/RLS code; reconciliation; docs | PENDING |

## Orchestrator Reconciliation Log (Phase 3)
- 2026-10-07 — Adapter declarations `coovachilli-uam.coaChange` and `openwifi-config.coaChange` were delivered as VERIFIED_SUPPORTED (documentation-verified); downgraded to REQUIRES_DEVICE_TEST per owner rule D-006/D-034 and a guard test added so no adapter can declare verified CoA/Disconnect before device tests.
- 2026-10-07 — `infra/compose/postgres-init/01_roles.sql` gained the `ecloud_radius` role and `GRANT CREATE ON DATABASE` for the platform role (needed by migration 009); applied out-of-band to the running local dev stack.
- 2026-10-07 — Incident (local dev DB only, no remote impact): while cleaning temporary test objects the FreeRADIUS agent dropped the `radius` schema on the local `ecloud` dev database after migrations had been applied; it re-applied migration 009 and verified objects and ownership. Grants to `ecloud_radius` were re-applied by the orchestrator. No files, volumes or remote systems affected. Lesson recorded: agents must not drop shared schemas on the dev stack.

## Verified Environment Facts
See REMOTE_ENVIRONMENT.md and PHASE2_VALIDATION.md. Ledger: 105 claims — 40 verified, 17 proposed, 1 unknown, 47 requires device test; 24 device tests (DT-01…DT-24), none executed yet.

## Open Items Needing Owner Input
- VPS deployment gate (D-031): exact change list to be presented before first deployment; Q16/Q17/Q18/Q19/Q20/Q21 decided then.
- Device-test lab schedule (D-034).
- Production regulatory retention (D-025) before production.

## Next Action
Execute Phase 3 milestones M2–M8 locally. Report milestones, test results, unresolved risks and any decision needing owner approval. Present the VPS change list and stop before any remote change.
