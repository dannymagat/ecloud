# Project Status

## Current Stage
`PHASES 3–10 LOCAL WORK COMPLETE (2026-10-09) — AWAITING OWNER APPROVAL OF THE VPS CHANGE LIST (D-031)`

Owner approved the Phase 2 decision gate on 2026-10-07 (DECISIONS.md D-021 … D-034). Phase 3 is authorised for **local development on the MacBook only**. **VPS deployment is gated (D-031)**: no remote host, EZEAP, EZE controller, DNS, firewall, Caddy or RADIUS exposure change may happen until the exact change list is presented and approved.

## Confirmed Goal
Multi-tenant cloud bandwidth management platform (ECLOUD): admin policy control, captive portal (uspot / CoovaChilli), AAA/RADIUS, policy translation to verified device mechanisms on EZEAP / TIP OpenWiFi, sessions/accounting, reporting, WireGuard site connectivity, domains `ezecloud.ezelink.ai`, `api.ezecloud.ezelink.ai`, `portal.ezecloud.ezelink.ai`.

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
| 3 | M11-L1 Reconcile hotspot spec + MULTI_VENDOR_INTEGRATION_PLAN.md + registry design | **DONE 2026-10-08** — see cycle log |
| 4 | M11-L2 Vendor-neutral contract, evidence levels, registry code, admin label fix | **DONE 2026-10-08** — see cycle log |
| 5 | M11-L3 Additive multi-vendor data structures (migration 019, controllers, registry mirror) | **DONE 2026-10-08** — see cycle log |
| 6 | M11-L4 Simulator contracts (SIMULATOR_TESTED only) | **DONE 2026-10-08** — SIM-01…SIM-18 all pass (SIM-14 unblocked by vendor quirks hook) |

### Cycle log
**Cycle 1 — M9 container images — DONE 2026-10-08**
- Implemented: `infra/docker/Dockerfile` (multi-target api/worker/portal/admin, Node 22.23.3 bookworm-slim, workspace-scoped `npm ci`, no dev deps at runtime, tini, non-root, HEALTHCHECK), `prune-runtime.sh`, `.dockerignore`, admin served by unprivileged nginx (LOCAL testing only; production stays native Caddy, D-030) with CSP, nosniff, frame deny and hidden-path 404; compose `app` and `migrate` profiles (127.0.0.1 only, read-only root, cap_drop ALL, no-new-privileges, memory/pids limits); portal graceful shutdown.
- Review: independent security review → PASS WITH FIXES (low/info only: nginx CSP + hidden paths, XFF, runtime tidy, doc precision). Fixed in one round.
- Tests: four amd64 images built; all `/healthz` 200; SPA loads in a headless browser with 0 CSP violations; portal stops with exit 0; images refuse to start in production mode with dev defaults or local storage without opt-in.
- Not done (VPS change-list items, gated by D-031): digest pinning, apt pinning, registry push, multi-arch CI. radclient 3.2.1 in the worker image vs FreeRADIUS 3.2.10 server.

**Cycle 3 — M11-L1 multi-vendor reconciliation and plan — DONE 2026-10-08**
- `MULTI_VENDOR_INTEGRATION_PLAN.md` (691 lines): reconciliation R-01…R-43 (decision register wins), code-grounded discovery, evidence model (four-state status + evidence level + lifecycle, validator rules V1–V12), native vs gateway architecture, nine-operation vendor-neutral contract, compatibility registry schema and initial rows, L2–L4 shapes and acceptance criteria.
- Cambium: researched only from 9 cited public URLs (all re-read by the reviewer); no adapter, no invented endpoints. 21 other roadmap vendors + 2 legacy candidates: planned, capabilities UNKNOWN.
- Found live defect R-10: the admin app describes "Verified" as "verified by a recorded device test" while no cell has device evidence → fixed in L2. Conservative rule V12 applied: only LAB_VALIDATED evidence reads as device-enforced; source-verified cells read "Expected (source-verified, not device-tested)".
- Review: PASS WITH FIXES (5 medium, 8 low; no fabrication; counts 29 cells / 40 attributes recomputed). All fixed in one round; orchestrator confirmed.
- Owner questions raised: OQ-1 dashboard in ECLOUD admin vs EZECONTROL, OQ-2 Arabic/RTL release 1, OQ-3 Cambium model/firmware/cnMaestro, OQ-6 per-site fail-open, OQ-16 confirm VERIFIED_SUPPORTED = source-verified semantics (applied conservatively), OQ-17 controller fetch policy.

**Cycle 4 — M11-L2 vendor-neutral contract, evidence levels, registry — DONE 2026-10-08**
- Implemented: `EvidenceLevel`/`Lifecycle` enums; `evidenceLevel` + `evidenceRefs` on every adapter declaration; 29 verified cells and 40 attributes back-filled to PHASE2 V-rows (all VERIFIED_FROM_SOURCE); typed compatibility registry (30 rows, 27 vendors; first-party rows derived from the engine; EZEGATE coova-chilli 1.2.9 presented REQUIRES_DEVICE_TEST pending DT-15; Cambium researched only; 23 roadmap vendors planned/UNKNOWN); validator V1–V12 with a negative test per rule; nine-operation `VendorAdapter` wrappers for the five first-party adapters (UAM md verified timing-safe, replay and tenant checks mandatory, PAP encoding matches reference); admin labels fixed (R-10): "Verified (source)" / "Expected (source-verified, not device-tested)", "Lab validated" only with a DT reference; Disconnect button requires device-enforced status.
- First-party behaviour unchanged: golden and capabilities tests untouched; reviewer compared HEAD vs working tree on 30 translate/reply/disconnect cases with 0 differences.
- Review: PASS WITH FIXES (4 medium: DT coverage not checked by V3, production lifecycle allowed, optional replay check, 3 cells with weak evidence). All fixed; the 3 cells were resolved by a fresh source read → new ledger rows V-146 (upstream uspot interim), V-147 (upstream uspot MAC auth), V-148 (CoovaChilli MAC auth). Orchestrator spot-checked V-148 in `chilli.c` and corrected CAPTIVE_PORTAL_ARCHITECTURE.md (CoovaChilli `macpasswd` has no default; unset → MAC-based User-Name).
- Tests: npm test 573 passed; integration 818 passed, 1 skipped (S3 contract); secrets scan OK.
- Open: API does not yet emit evidence levels (L3); accounting normaliser duplicated until L3 relocation; `unknown_nas` vs `bad_signature` ordering — portal must map all failures to one generic page.

**Cycle 5 — M11-L3 multi-vendor data structures — DONE 2026-10-08**
- Migrations 019 (vendors, hardware_models, firmware_versions, compatibility_entries mirror; tenant table `controllers` with FORCE RLS, same-org composite FKs, https-only base_url, sealed credential; `nas_clients.deployment_mode` + `controller_id`; network_devices model/firmware/controller/managed) and 020 (no userinfo in base_url). Additive only.
- `ecloud-db seed` mirrors the code registry with a hash check; `ecloud-db registry-check` detects drift (hash 7197825…f646 verified).
- Permissions: controller:read/create/update/delete/secret:rotate, compatibility:read (105 total). Endpoints: GET /compatibility[/{key}], GET /vendors, controllers CRUD + rotate-credential (refused under impersonation; credential write-only, never returned or audited). Adapter catalogue now emits evidence_level, device_enforced, dt_refs from the registry.
- Closed L2 deviations: worker re-exports the adapters accounting normaliser (duplicate deleted); webhook URL guard moved to `packages/shared/src/net-guard.ts`.
- Fixed the SIM-18 cross-tenant accounting defect (every session match scoped to organization + NAS; collisions stored without a session and audited at platform level, deduped hourly) and the stale-session reaper.
- Review: PASS WITH FIXES (2 medium URL-guard gaps `https://localhost./` and `[::127.0.0.1]`; 4 low). All fixed; orchestrator confirmed both bypasses now rejected.

**Vendor quirks hook (SIM-14) — DONE 2026-10-08:** report-only 32-bit counter-wrap detection for openwifi-uspot-uam; worker output unchanged. Open: the worker does not act on wrap anomalies yet, so usage after a wrap is still under-counted.

**Orchestrator verification after cycles 3–6 (2026-10-08):** build, lint, format:check, secrets scan OK; registry-check ok; integration 952 passed, 1 skipped (S3 contract without endpoint) across 81 files. Simulator evidence (SIMULATOR_TESTED, code behaviour only): openwifi-uspot-uam and coovachilli-uam — redirectParse, authorizationHandoff (PAP only), accountingNormalize. Registry promotion of these claims is not yet applied.

**Cycle 6 — M11-L4 simulator contracts — DONE 2026-10-08**
- Implemented SIM-01…SIM-18 (`tests/simulators`, helpers `packages/testing/src/simulators`): forged/tampered/missing md, unknown NAS, cross-tenant, replay, open-redirect payloads, byte-for-byte opaque preservation, PAP/CHAP vectors (recomputed independently with Python hashlib by the reviewer), accounting retransmit/out-of-order/missing Stop/Gigawords/32-bit wrap/NAS reboot/multi-NAS roaming, unsupported policy, Disconnect mandatory attributes. Machine-readable `SIMULATOR_RESULTS.json` bound to its run (run id + outcome hash).
- **Defects found by the simulators:** (1) SIM-18 cross-tenant accounting attribution in the worker drainer → fixed in L3; (2) SIM-07 `userurl` values with backslashes (`http:\\evil.example`, `https:/\\evil.example/`, `http://evil\\@x`) accepted after normalisation → orchestrator fixed `safeUserUrl` to refuse any backslash.
- Evidence (SIMULATOR_TESTED, code behaviour only, not hardware): openwifi-uspot-uam redirectParse + authorizationHandoff; coovachilli-uam redirectParse + authorizationHandoff + accountingNormalize. Withheld: uspot accountingNormalize (SIM-14 needs the vendor quirks hook). authorizationHandoff evidence is PAP only. Registry promotion not yet applied.
- Review: PASS WITH FIXES; fixed. Tests: simulators 62 passed + 1 todo with DB (four consecutive runs); npm test 651 passed.
- Note: one transient failure was seen while another agent ran tests on the same test database concurrently; drain tests do not take the production lock. Single full integration runs are unaffected.

**Security finding from cycle 6 (L4 simulators), 2026-10-08 — CLOSED: fixed in cycle 5 (L3), reviewed, SIM-18 and worker regression tests pass.**
- Defect: `apps/worker/src/accounting/drain.ts` `createSession` inserts with `ON CONFLICT (acct_unique_id) DO NOTHING` and re-reads by `acct_unique_id` without an organization check. `acctuniqueid` is derived from NAS-supplied Class + Acct-Session-Id, so an authenticated NAS of organization B that echoes organization A's values gets its accounting attached to A's session (simulator observed A's counters overwritten and A's session stopped).
- Scope: local code only; nothing is deployed, so no production impact. Pinned as a failing test (`tests/simulators/db.integration.test.ts`, `[DEFECT]`); the fix must turn it green and add a worker regression test.
- Related: stale sessions (after Accounting-On/Off) are never closed by the reaper.

**Orchestrator verification after cycles 1–2 (2026-10-08):** build, lint, format:check, secrets scan OK; integration 743 passed, 1 skipped (S3 contract without endpoint) across 63 files.

**Cycle 2 — M10 storage abstraction (D-026) — DONE 2026-10-08**
- Implemented `@ecloud/storage`: `ObjectStorage` interface, tenant-scoped keys `org/{org}/{purpose}/{id}` (traversal, absolute, null-byte, uppercase and cross-tenant keys rejected), branding purpose (PNG/JPEG/WebP ≤ 5 MiB, magic-byte check, SVG rejected), local driver (versioned content + metadata commit, 0700/0600, symlink protection, stale tmp sweep), S3 driver (AWS SDK v3, path-style, signed URLs pin stored content type), `forTenant()` scoping. Production guard: local driver refused in production without `STORAGE_LOCAL_ALLOW_PRODUCTION=true`; non-https S3 endpoint refused.
- Review: independent security review → PASS WITH FIXES (1 medium: bucket-missing reported as object-missing; 8 low). All fixed in one fix round; orchestrator spot-checked the medium fix.
- Tests: `npm test` 498 passed; integration 735 passed; S3 contract 14/14 against a throwaway RustFS container (2026-10-08, digest recorded by agent); secrets scan OK.
- Evidence limits: S3 driver tested against RustFS only (AWS/R2/B2/Wasabi untested). Not wired into the API yet (no asset endpoint exists).


## P5 lab session 2026-10-08 — SKIPPED by owner
- Owner approved the lab changes (FreeRADIUS reachable on the lab network; AP changed directly). Mac side prepared and seeded a lab tenant through the API; owner applied the lab AP config (uuid 1791450130) and restarted captive services.
- Result: no device test executed. uspot did not start because the rendered captive instance section was not in the AP's stored `/etc/config/uspot` (recorded as a DT-03 attempt in PHASE2_VALIDATION.md). Owner then skipped AP testing.
- Mac side restored: lab API stopped, FreeRADIUS back to 127.0.0.1 only. **Lab AP restored (checked 2026-10-09, read-only):** active config `1791452890` equals the original `1791313886` except radios pinned to the channels ACS had chosen (5 GHz 132, 2.4 GHz 11) — most likely pushed by the EZE controller/RRM; no rollback applied, to avoid overwriting that newer config. The owner deleted the lab config file (which held the retired lab RADIUS secret) from the AP and changed the AP's default password on 2026-10-09. Future AP access should use an SSH key, not a password shared in chat. The lab RADIUS secret was printed in the apply output; it is no longer accepted anywhere and must not be reused.

## Phase 6 — Captive portal (LOCAL) — CODE COMPLETE 2026-10-08 (device exit criterion pending)
Owner: "go to next phase" after skipping P5 device tests; interpreted as Phase 6, built locally with the Continuous Engineering Loop (spec in the job's TASK_P6.md, summarised here).
| Cycle | Scope | Status |
|---|---|---|
| P6-A | Portal service: server-rendered pages, UAM flow via VendorAdapter, identity broker with single-use portal credentials, /internal/portal API, AAA portal-credential path, abuse controls, end-to-end through the UAM simulator and local FreeRADIUS | **DONE 2026-10-08** — reviewed (PASS WITH FIXES: per-account brute-force lock, username timing oracle, 30 s decision cache, hand-off bound to NAS origin, asset cache forwarding) |
| P6-B | Portal administration: portals/themes CRUD, branding assets via @ecloud/storage, permissions, admin portal designer | **DONE 2026-10-08** — reviewed (PASS WITH FIXES: audit-log leak of sealed UAM secret ref fixed), write-only UAM secret rotation, NAS pin + UAM server URL, migrations 021–022; 1068 integration tests |
Exit criterion "real client completes end-to-end login" stays REQUIRES_DEVICE_TEST (AP testing skipped).
- **Owner awareness — non-additive migration:** `022_portal_theme_logo_fk.sql` changes `portal_themes.logo_asset_ref` from text to uuid and first clears logo references that cannot resolve to a same-organization asset, then adds a same-tenant FK. No valid data is removed and nothing is deployed, but it is not purely additive (loop stop rule: destructive migrations need owner awareness).
- **Orchestrator verification 2026-10-08:** dev DB migrated to 022; build, lint, format:check, secrets scan OK; integration 1069 passed, 1 skipped (S3 contract) across 90 files; portal → FreeRADIUS e2e 4/4. Evidence is simulator/local only (SIMULATOR_TESTED); D-006 unchanged.
- Known limits: logos fetchable by random asset id (accepted: branding is public); a known username can be locked at the portal for 15 min (trade-off of the per-account lock); timing equalisation is a design target, not a measured property; `PORTAL_TRUST_PROXY_HOPS=1` and production portal settings are VPS change-list items.
- Portal onboarding order (fail-closed by design): create portal → set NAS pin + UAM server URL → rotate UAM secret (shown once) → configure the NAS.

## Phase 7 — Bandwidth policy enforcement (LOCAL) — CODE COMPLETE 2026-10-08 (device exit criterion pending)
Exit criterion (measured traffic matches policy on a real device) is REQUIRES_DEVICE_TEST; AP testing is skipped. Local scope only; no controller push (EZECONTROL changes not authorised), CoA dispatcher stays disabled (D-006).
| Cycle | Scope | Status |
|---|---|---|
| P7-A | Policy-change propagation, session enforcement view API, worker use of the 32-bit wrap quirks hook, quota/schedule/concurrency end to end | **DONE 2026-10-08** — reviewed (PASS WITH FIXES: pending-row trigger flip-flop bug, propagation cost, silent truncation at the cap, API/worker race, runtime scan size); migration 023 additive |
| P7-B | Device measurement harness (iperf3, dry-run; never auto-PASS), openwifi-config rate-limit fragment export/preview (no push), admin enforcement views and change-impact preview | **DONE 2026-10-08** — review PASS (low notes only); orchestrator made CoA/Disconnect strategy wording neutral so the UI never asserts lab validation itself |
- **Orchestrator verification 2026-10-08:** admin API client regenerated (82 paths); build, lint, format:check, secrets scan OK; dev DB migrated to 023; integration 1159 passed, 1 skipped (S3 contract) across 101 files; portal → FreeRADIUS e2e 4/4; device harness dry-run 14/14.
- **Behaviour change:** sessions with no other bound now receive Session-Timeout 1800 s (owner-accepted Q44 default, now implemented) so policy changes apply at the next login within 30 minutes. `AAA_SESSION_TIMEOUT_CAP_S` (0 = off, else 300–86400).
- Strategy today is always `next_reauth`; CoA/Disconnect stay REQUIRES_DEVICE_TEST (D-006). `applied` means the session ended and the next login uses the current policy — not device confirmation.
- Known limits: an upper-half counter reset is indistinguishable from a 32-bit wrap (over-count up to 2^31 bytes per event, visible in `accounting_anomalies`); schedule-window false positives in the affected count; re-resolution runs inside the policy mutation transaction (bounded by `ENFORCEMENT_MAX_SESSIONS`, unevaluated sessions still get a pending marker).

## Phase 8 — Sessions & Accounting (LOCAL) — CODE COMPLETE 2026-10-08
Scope (IMPLEMENTATION_PLAN.md): active sessions, usage, historical records, supported disconnect/change operations. Disconnect/reauthorize endpoints exist but refuse unless the adapter capability is lab-validated (D-006, V12); lab mode only behind ECLOUD_COA_ENABLED.
| Cycle | Scope | Status |
|---|---|---|
| P8-A | Sessions list/detail with accounting timeline, usage per user/device/site/org (site TZ, freshness), accounting record query + CSV export (read_only excluded, Q75), gated disconnect/reauthorize, retention dry-run report, indexes | **DONE 2026-10-08** — reviewed (PASS WITH FIXES: site-local period labels, export audit completion, budget order, username index, refusal rate limit); migrations 024–025 additive; reauthorize uses `session:coa` |
| P8-B | Admin: active sessions (polling), session detail timeline, usage dashboards, accounting browser, export, gated session actions | **DONE 2026-10-08** — reviewed (PASS WITH FIXES); orchestrator fixed safe Content-Disposition filename decoding and stop-polling-on-error |
- **Orchestrator verification 2026-10-08:** dev DB migrated to 025; build, lint, format:check, secrets scan OK; integration 1222 passed, 1 skipped (S3 contract) across 110 files; portal e2e 4/4. Disconnect/Reauthorize refuse with an evidence-based reason (D-006); lab mode never reports device enforcement. Site/org usage counters start at migration 024 (no backfill).

## Phase 9 — Dashboard & Reports (LOCAL) — CODE COMPLETE 2026-10-08
Scope: operational status, usage, authentication outcomes, site/device health where observable, reporting. Device health is only what ECLOUD observes (RADIUS/accounting activity per NAS: active/quiet/silent/never) — never AP online/offline, since EZECONTROL is off-limits.
| Cycle | Scope | Status |
|---|---|---|
| P9-A | Dashboard aggregate (org/site), auth-outcome and usage time series, on-demand reports with CSV export, platform summary, bounded indexed aggregates | **DONE 2026-10-08** — reviewed (PASS WITH FIXES: free-text RADIUS reject reasons could echo subscriber identifiers → only clean reason codes shown; export budget checked before heavy queries; deleted sites excluded consistently; NAS IP reuse; site-bound tests); migration 026 additive |
| P9-B | Admin dashboard (KPIs, charts, NAS activity), site dashboard, reports page, platform summary | **DONE 2026-10-08** — review PASS (low notes); orchestrator renamed "Online time" to "Session time", fixed duplicate report row keys, documented UTC window edges for mixed time zones; visual browser check done |
- **Visual check (orchestrator, 2026-10-08):** dashboard rendered in headless Chrome against the local API with synthetic demo traffic, at 1400 px light and dark and 400 px: no horizontal overflow, no console errors, reject reasons shown as `module_message` (no leaked username), no online/offline wording. Fixed a y-axis title overlapping byte tick labels; added a note that chart totals use whole buckets while tiles use a rolling window.
- **Dev DB note:** 600 synthetic `auth_events` rows (lab org, NAS 192.0.2.1) remain in the local dev database because the table is append-only by design; the synthetic `usage_hourly` rows were removed.
- **Orchestrator verification 2026-10-08:** build, lint, format:check, secrets scan OK; integration 1283 passed, 1 skipped (S3 contract) across 116 files; portal e2e 4/4.

## Phase 10 — Hardening (LOCAL parts) — COMPLETE 2026-10-09
Local-only cycles; every VPS-side control (firewall, fail2ban, SSH hardening, backup schedule, TLS on Caddy, monitoring agents) is authored as files and goes into the D-031 VPS change list — nothing applied to the server.
| Cycle | Scope | Status |
|---|---|---|
| P10-A | Security hardening: whole-codebase security review against SECURITY_ARCHITECTURE threat model, dependency/SCA + SBOM in CI, container image hardening/scan, secrets-management tooling (sops/age pattern), authored nftables/fail2ban/sshd/Caddy fragments for the VPS change list | **DONE 2026-10-09** — review PASS WITH FIXES (docs/SECURITY_REVIEW_P10.md §8): Caddy apply validated as root could break the next Caddy restart → validate as `caddy`, auto-restore on failed reload; private paths returned the SPA on the admin vhost → `handle` + behaviour check; Docker-after-`wg0` ordering (VPS-WG-3); SSH allow-list now a required precondition (PRE-6); dead-man `confirm` checks; secrets tooling fixes |
| P10-B | Resilience: encrypted backup + restore scripts with a real local restore drill, failure drills (DB, Redis, FreeRADIUS, API, worker down/restart → fail-closed behaviour), load test (authorize p95 target < 100 ms), log rotation and monitoring config drafts | **DONE 2026-10-09** — drills found and fixed 3 defects (Postgres restart crashed api/worker; schedulers lost after Redis data loss; voucher batch row lock serialised logins: p95 1 193 → 44 ms). Restore drill PASS (490 MB restored in 15 s, RLS/policies/grants identical); failure drills 40/40; review PASS WITH FIXES: backup lock, non-fatal metric write, `absent()` backup alert, scheduler restore with retry + periodic missing-only check, restore live-target guard, `ecloud_backup` role (BYPASSRLS, read-only, tested) |

- **Load test (workstation, not VPS):** voucher/portal-credential authorize, portal login and password authorize ≤ 5/s meet p95 < 100 ms; **password authorize at 10/s does not reliably** (p95 70–677 ms on a busy host; saturation ≈ 17/s). Open: **B-3** — Argon2 hash runs inside the tenant DB transaction, holding a pool connection; fix = verify before opening the transaction (touches the AAA decision path; next cycle). Re-measure on the VPS after approval.
- **D-039 domain rename** applied repo-wide (`ezecloud.ezelink.ai`, `api.`/`portal.` and auxiliary names); DECISIONS.md keeps the superseded names in D-005/D-014/D-029 as history. No DNS change.
- **Open residuals:** off-site backup retention via bucket lifecycle (Q18); CI actions pinned by tag not SHA; Prometheus server not in the pilot (uptime-kuma is); drain cursor in Redis (rescan after data loss).
- **Orchestrator verification 2026-10-09:** build, lint, format:check, secrets scan, secrets selftest, lockfile check OK; integration **1315 passed, 1 skipped** (S3 contract) across 126 files; portal e2e 4/4; `infra/vps` validate-local 6/6; promtool 18 rules OK.

## Verified Environment Facts
See REMOTE_ENVIRONMENT.md and PHASE2_VALIDATION.md. Ledger: 105 claims — 40 verified, 17 proposed, 1 unknown, 47 requires device test; 24 device tests (DT-01…DT-24). **DT-01 executed 2026-10-07 (PASS, identification only)** on lab AP EZE-AP1832, EZEAP 6 r32912, uCentral schema 4.2.0: uspot is the TIP fork; no WireGuard/unetd on the AP (topology B unsupported on this firmware); hostapd supports DAS and dynamic VLAN. DT-02…DT-24 not executed. No device configuration was changed.

## Open Items Needing Owner Input
- VPS deployment gate (D-031): exact change list to be presented before first deployment; Q16/Q17/Q18/Q19/Q20/Q21 decided then.
- Device-test lab schedule (D-034).
- Production regulatory retention (D-025) before production.

## Next Action
Owner review of `docs/VPS_CHANGE_LIST.md` (DRAFT, per-id approval, D-031) and DNS-1 for `ezecloud.ezelink.ai` (D-039). Nothing is applied to the VPS, DNS or devices until approved. Local follow-up available without approval: B-3 (password hash outside the DB transaction).
