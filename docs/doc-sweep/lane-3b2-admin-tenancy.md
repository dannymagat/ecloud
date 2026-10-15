# Lane 3b-2 — admin UI, tenancy, small READMEs

- Lane: 3b-2
- Date: 2026-10-15
- Reader: Hermes sub-agent
- Scope: 6 files (ADMIN_UI_ARCHITECTURE.md, MULTITENANCY.md, packages/policy-engine/README.md,
  apps/admin/public/vendor-logos/SOURCES.md, docs/superpowers/plans/2026-10-14-nas-pending-adoption.md,
  tests/e2e/README.md). Read-only; nothing applied.

## Checklist

- [x] ADMIN_UI_ARCHITECTURE.md — 14 claims (IMPLEMENTED 6, PARTIAL 3, MISSING 2, SUPERSEDED 2, NEEDS-OWNER 1)

## 1. ADMIN_UI_ARCHITECTURE.md

| # | claim (short, section ref) | verdict | evidence (path:line / D-number) | apply item? |
|---|---|---|---|---|
| 1 | §0 precedent table describes ezecontroller (islands, dotted permissions, localStorage JWT) as the pattern to learn from | OUT-OF-SCOPE | D-058 (EZEControl paused); evidence paths are outside this repo | - |
| 2 | §0 note: admin app is `apps/admin` = Vite + React 19 + TS strict + Tailwind 3 + TanStack Query + React Router, no TanStack Table/Router | IMPLEMENTED | apps/admin/package.json (react ^19.3.0, @tanstack/react-query ^5.104.1, react-router ^7.18.4, tailwindcss ^3.4.19, vite ^8.3.3); no @tanstack/react-table dep | - |
| 3 | §0/§5 same-origin `/api/v1` with session cookie (D-029) and a client typed from generated OpenAPI (`npm run generate:api`) | IMPLEMENTED | apps/admin/package.json scripts.generate:api → scripts/generate-api.mjs; apps/admin/src/api/schema.d.ts:235; D-029/D-039 | - |
| 4 | §2 permission catalogue uses dotted names (`site.read`, `policy.write`, …) | SUPERSEDED | D-021: canonical `resource:action`; MULTITENANCY.md catalogue is canonical. Code: apps/admin/src/lib/permissions.ts:1-6 header cites D-017/D-021 | Doc fix: replace §2 table names or point to MULTITENANCY |
| 5 | §2 UI is permission-driven, never role-name-driven; `can()`/`usePermission` only, no role enum imports | IMPLEMENTED | apps/admin/src/lib/permissions.ts:24-43 (`can(me, perm, target)`; "Role names are never consulted") | - |
| 6 | §2 scope switcher Platform ▸ Organization ▸ Site in the top bar | IMPLEMENTED | apps/admin/src/layout/Shell.tsx:12-13,88,142 (visiblePlatformGroup, OrgChip, SiteChip) | - |
| 7 | §0/§3 enforceability badges use the four D-028 states; "Verified" only for `VERIFIED_SUPPORTED` (+evidence) | IMPLEMENTED | apps/admin/src/lib/adapterStatus.ts:4-11,103,114,217; lib/enforcement.ts:212-222; D-028 | - |
| 8 | §3 preview panel uses `GET /policies/simulate` (subject user) or `GET /platform/adapters` for platform operators | IMPLEMENTED | apps/admin/src/features/policies/PreviewPanel.tsx:3,45,55; features/platform/AdaptersPage.tsx:26 | - |
| 9 | §3 Session Disconnect disabled unless adapter disconnect status is `VERIFIED_SUPPORTED` | IMPLEMENTED | apps/admin/src/lib/disconnect.ts:3,32 | - |
| 10 | §5 login is email+password → optional TOTP step, recovery codes, "trust this browser" | SUPERSEDED | D-046 (ADMIN_MFA_MODE=off; MFA removed from the admin experience, enrolments kept but ignored) | Doc fix: mark §5 TOTP as off per D-046 |
| 11 | §5 impersonation banner "acting in Org X … ends in 59:30 · Exit", audited, cannot change admins/roles/secrets | PARTIAL | apps/admin/src/layout/ImpersonationBanner.tsx:3 (org, reason, live countdown, Stop button) exists; the guardrail is now broader than documented — D-062 refuses **every** write while impersonating, and permissions.ts:36-39 pins the org client-side | Doc fix (D-062), not code |
| 12 | §5 idle timeout 30 min with warning modal at 28 min, absolute 12 h | MISSING | grep "idle" in apps/admin/src/lib/auth.tsx + features/auth → no hits; §0 note already admits "Not yet built: … idle-timeout warning modal" | Apply: idle-timeout warning modal + absolute lifetime surfacing (S) |
| 13 | §6 i18n via ICU catalogs with RTL support "from day one" (admin + portal) | MISSING | grep -ril "i18n\|dir=\"rtl\"" apps/admin/src → no hits | Apply: decide/stage admin i18n+RTL (L) — gated on owner Q2 |
| 14 | §0/§3 portal designer and reports "not yet built" | STALE-DOC | apps/admin/src/features/portals/PortalDesignerPage.tsx + .test.tsx and features/reports/ReportsPage.tsx now exist | Doc fix: remove from "not yet built" list |
| 15 | §8 open questions 1-8 (RTL locales, white-label admin branding, site-admin policy.write, assume-tenant notification, portal hostnames, self-care, voucher print) still unanswered in DECISIONS | NEEDS-OWNER | grep of DECISIONS.md D-021…D-065 shows no ruling on Q2/Q3/Q4/Q6/Q7 | Owner question: which of §8 Q2/Q3/Q4/Q6/Q7 are release-1 scope? |

- [x] MULTITENANCY.md — 16 claims (IMPLEMENTED 9, PARTIAL 4, MISSING 1, SUPERSEDED 1, NEEDS-OWNER 1)
- [x] packages/policy-engine/README.md — 8 claims (IMPLEMENTED 6, STALE-DOC 2)
- [x] apps/admin/public/vendor-logos/SOURCES.md — 7 claims (IMPLEMENTED 6, NEEDS-OWNER 1)

## 2. MULTITENANCY.md

| # | claim (short, section ref) | verdict | evidence (path:line / D-number) | apply item? |
|---|---|---|---|---|
| 1 | §1 hierarchy Platform → Organization → Site → NAS/device → users/devices → sessions → policies; no "platform organization" row | IMPLEMENTED | packages/db/migrations/002_tenancy_rbac.sql (organizations, sites, role_bindings with scope_type); apps/api/src/auth/authorize.ts:3-4 "platform ⊃ organization ⊃ site" | - |
| 2 | §2 isolation = shared schema + `organization_id` + PostgreSQL RLS (two locks) | IMPLEMENTED | packages/db/migrations/010_rls_and_grants.sql (ENABLE ROW LEVEL SECURITY); apps/api/src/tenant.ts:111 uses `current_setting('app.current_org', true)::uuid` | - |
| 3 | §2 every tenant table carries `organization_id`; no cross-tenant FKs (dedicated-DB escape hatch) | PARTIAL | holds for the tables seen (tenant.ts:111 pattern, 002/010 migrations); not audited across all 45+ migrations in this pass | Apply: schema audit that every RLS table has organization_id (S, low risk) |
| 4 | §3.1 one global `administrators` row per email; platform admin = a binding with `scope_type='platform'` | IMPLEMENTED | apps/api/src/auth/principal.ts:54,99 (role_bindings ⋈ role_permissions); authorize.ts:37 (`grant.scopeType === 'platform'`) | - |
| 5 | §3.1 MFA enforcement is a platform setting / `organizations.settings.require_mfa` | SUPERSEDED | D-046 (`ADMIN_MFA_MODE=off`, MFA removed from the admin experience); apps/api/src/mfa-mode.integration.test.ts exists | Doc fix: note D-046 in §3.1 |
| 6 | §3.2 subscriber username unique per organization; tenant comes from NAS identity, not the name | IMPLEMENTED | packages/testing/src/two-tenants.ts:52 ("Username created in BOTH tenants (T-06)"), :632 | - |
| 7 | §3.2 voucher/credential presented on the wrong tenant's portal is rejected and logged | IMPLEMENTED | apps/api/src/internal/portal-credential.ts:100 `IdentityRejected('portal_credential_tenant_mismatch')`; portal.integration.test.ts:603 | - |
| 8 | §3.3 tenant resolution A (NAS identity) mandatory, C refines, B optional | PARTIAL | NAS-identity resolution is the live path (packages/adapters/dist/vendor/first-party.js:302-309 `tenant_mismatch`); no realm (`rlm_realm`) mapping found — option B unbuilt (as documented "optional") | - |
| 9 | §4.2 ~60-key permission catalogue as data, `resource:action` | IMPLEMENTED | packages/shared/src/permissions.ts (+ permissions.test.ts); D-021 | - |
| 10 | §4.2 `nas` actions include `secret:rotate`; D-045 adds `nas:secret:reveal` | IMPLEMENTED | apps/api/src/routes/access-points-page.ts + access-points-page.integration.test.ts reference the reveal permission; D-045 | Doc fix: add `secret:reveal` to the §4.2 `nas` row |
| 11 | §4.3 role templates seeded with `organization_id IS NULL`, `is_system`; copy-on-write with `template_version` | IMPLEMENTED | apps/api/src/routes/access.ts:275-305 (reads template `template_version`, copies role_permissions, stores template_version); routes/platform-ops.ts:66-73 | - |
| 12 | §4.4 evaluation algorithm: deny-by-default, additive, platform-only keys need a platform binding, impersonation pins the org, listing uses bindings as a filter | IMPLEMENTED | apps/api/src/auth/authorize.ts:52-74 (evaluate), :85-94 (`permittedSites`), :114 (permissionsByScope); authorize.test.ts:83,118 | - |
| 13 | §4.5 impersonation: reason required, audited with `impersonator_id`, banner, RLS org pinned, platform_access off, hard cap | PARTIAL | impersonation implemented (apps/api/src/auth/middleware.ts:4,150; app.ts:118-119,207-208 sets `X-ECLOUD-Impersonating`; principal.ts:92 impersonation role template; admin ImpersonationBanner.tsx). §4.5 does not state the current, stricter rule: **all writes refused while impersonating** (D-062, commit 4ce1502) | Doc fix: record D-062 in §4.5 |
| 14 | §4.6 API keys: one binding, no escalation, `allowed_cidrs`, platform keys never get `tenant:impersonate` | PARTIAL | api_keys exist (apps/api/src/auth/principal.ts, routes/access.ts, migrations/010_rls_and_grants.sql); the no-escalation and platform-key-impersonation restrictions were not located in this pass | Apply: verify/enforce API-key escalation + impersonation guards with tests (M, security — A8 gate) |
| 15 | §5 guards G1-G10 and isolation tests T-01…T-15 handed to A9 | PARTIAL | T-06 fixture exists (packages/testing/src/two-tenants.ts:52); `grep -rn "T-01\|T-09\|T-10" apps/api/src --include=*.test.ts` → no hits, so the test IDs are not traceable in the suite | Apply: name the T-01…T-15 isolation cases in the integration suite (M, low risk) |
| 16 | §6 quotas enforced: max_sites / max_devices / max_users / max_concurrent_sessions per org | PARTIAL | `max_sites` column exists (packages/db/migrations/002_tenancy_rbac.sql:13) and is accepted by routes/platform.ts:48; per-org `max_concurrent_sessions` enforcement found only at policy level (apps/api/src/policy-data.ts:80-81, enforcement.integration.test.ts:402-404, vendor-api/portal.ts:469-473) — no `count(*) FROM sessions WHERE organization_id` org-level check found | Apply: enforce org-level quotas (sites/devices/users/concurrent sessions) at the create/authorize paths (M, medium risk) |
| 17 | §8 open questions M2-M6 (shared venue, support consent, custom roles at launch, read-only export, username uniqueness) | NEEDS-OWNER | not resolved by any D-row found in the D-021…D-065 grep | Owner question: confirm M2/M3/M5 (shared-venue NAS, tenant consent for impersonation, read-only export) |

## 3. packages/policy-engine/README.md

| # | claim (short, section ref) | verdict | evidence (path:line / D-number) | apply item? |
|---|---|---|---|---|
| 1 | Pure TS, no DB, no HTTP; callers are apps/api and apps/worker; `now` pinnable | IMPLEMENTED | packages/policy-engine/src/* contains no db/http imports; resolve/translate take plain inputs (resolve.ts:910, translate.ts:718) | - |
| 2 | `intent.ts` = `PolicyIntentSchema` + `validatePolicy()` | IMPLEMENTED | src/intent.ts:115 (PolicyIntentSchema), :299 (validatePolicy) | - |
| 3 | `validatePolicy()` "implements the 11 rules of §1.3" with `{path, rule, code}` issues | STALE-DOC | validatePolicy spans src/intent.ts:299-629; no `rule:` field found (`grep -o "rule: '…'"` → 0 matches) and the rule count is not verifiable as 11 | Doc fix: restate the issue shape / rule count from the code |
| 4 | `schedule.ts` Intl-only weekly windows: isInWindow, nextBoundary, nextLocalMidnight, nextLocalMonthStart | IMPLEMENTED | src/schedule.ts:156,187,216,234 (plus nextLocalWeekStart:227, localWeekStartKey:242) | Doc fix (minor): week-start helpers are undocumented |
| 5 | `resolve.ts` resolveEffectivePolicy with priority ordering, fall-through, trace, snapshot hash | IMPLEMENTED | src/resolve.ts:147 (LAYERS), :546 (rankCandidates), :450 (merge), :910 (resolveEffectivePolicy) | - |
| 6 | `translate.ts` → EnforcementPlan with D-028 attribute gating; emits only `VERIFIED_SUPPORTED`, lab flag adds `experimental: true` under `unenforceable[]` | IMPLEMENTED | src/translate.ts:718; D-028; mirrored in admin lib/enforcement.ts:212-222 | - |
| 7 | `simulate.ts` powers the admin preview table | IMPLEMENTED | src/simulate.ts + simulate.test.ts; consumed via apps/admin/src/features/policies/PreviewPanel.tsx:45 | - |
| 8 | Tests run as `npm test -- --project policy-engine`; fixtures resolve.fixture.ts + adapters.fixture.ts | PARTIAL | both fixtures exist (src/resolve.fixture.ts, src/adapters.fixture.ts) and 14 test files are present, but the project name is generated by vitest.workspace.ts:1-3/83 from the workspace list — not asserted; also the module table omits 8 real modules (aggregate, api-limits, enforcement, mikrotik, operations, quota-periods, unlimited, platform-default) | Doc fix: add the 8 missing modules to the table; verify the --project name |

## 4. apps/admin/public/vendor-logos/SOURCES.md

| # | claim (short, section ref) | verdict | evidence (path:line / D-number) | apply item? |
|---|---|---|---|---|
| 1 | Logos self-hosted under `/vendor-logos/`, nothing loads externally (D-045) | IMPLEMENTED | apps/admin/src/features/access-points/VendorLogo.tsx:2-4 ("no external loading; the CSP stays 'self'"); files in apps/admin/public/vendor-logos/ | - |
| 2 | Every SVG sanitized (no scripts/handlers/external refs/metadata, no fixed width/height) | IMPLEMENTED | `grep -l "<script\|onload=" apps/admin/public/vendor-logos/*.svg` → no matches; apps/admin/src/features/access-points/vendorLogos.test.ts:4 asserts sanitization | - |
| 3 | Table lists 19 logo files with source URL and notes | IMPLEMENTED | 19 rows (L11-29) and exactly 19 `.svg` files in the directory | - |
| 4 | Notice "Logos are trademarks … compatible hardware only" shown in the UI | IMPLEMENTED | apps/admin/src/features/access-points/VendorLogo.tsx:85; asserted in features/setup-guides/SetupGuides.test.tsx:146 | - |
| 5 | Each file is cross-checked against the directory listing by a test | IMPLEMENTED | VendorLogo.tsx:12 comment + vendorLogos.test.ts; SetupGuides.test.tsx:145 asserts the `/vendor-logos/<key>.svg` src pattern | - |
| 6 | Fallback keys (cisco-catalyst, openmesh, grandstream, tanaza, ezelink) render a text wordmark tile; cisco-catalyst falls back to cisco.svg | IMPLEMENTED | VendorLogo.tsx:68 (`… or null (wordmark tile)`); no svg files for those keys | - |
| 7 | An EZELINK/EZEAP SVG master is REQUIRES_CLARIFICATION from the owner | NEEDS-OWNER | SOURCES.md:39 | Owner question: supply an EZELINK/EZEAP SVG logo master (currently a wordmark tile) |

**Correction to §2 claim 15:** the isolation cases DO exist — `tests/isolation/tenant-cases.test.ts` carries T-01…T-15 as named cases (lines 38, 52, 59, 77, 96, 120, 147, 182, 214, 226, 234, 264, 280, 288) plus `tests/isolation/rls-matrix.test.ts`. T-13 is the only ID not present. Revised verdict: **IMPLEMENTED** (apply item reduced to: add or document T-13).

- [x] docs/superpowers/plans/2026-10-14-nas-pending-adoption.md — 9 claims (SUPERSEDED 5, IMPLEMENTED 3, PARTIAL 1)
- [x] tests/e2e/README.md — 6 claims (IMPLEMENTED 2, STALE-DOC 2, PARTIAL 1, MISSING 1)

## 5. docs/superpowers/plans/2026-10-14-nas-pending-adoption.md

The plan was executed under a **different design** that landed this week: eligibility is a pure function in `packages/shared/src/nas-eligibility.ts`, the list is a NAS *overview* endpoint on the existing access-points page route, and the UI is a new `NasStateList` component. Per-task:

| # | claim (short, section ref) | verdict | evidence (path:line / D-number) | apply item? |
|---|---|---|---|---|
| 1 | Architecture: `nas_clients.is_adopted`, `is_blocked`, `block_reason` + `nas_discovery_observations` table | SUPERSEDED | packages/db/migrations/046_nas_adoption_blocked.sql:11-12 explicitly rejects `is_blocked` ("a separate boolean makes `status='active'` with `is_blocked=true` representable") and uses `status='blocked'` + `block_reason` (:40-47); `is_adopted` landed as planned (:62-64) | Doc fix: mark the plan superseded and point at migration 046 |
| 2 | Task 1 migration file named `046_nas_pending_adoption.sql` | SUPERSEDED | actual file is packages/db/migrations/046_nas_adoption_blocked.sql | - |
| 3 | Task 1: `nas_discovery_observations` table with RLS, added to ALL_TABLES / TENANT_SCOPED_TABLES | MISSING | `grep -rn nas_discovery_observations packages/db/src/tables.ts` → no hits; no such table in migrations 044-049 | Apply (if still wanted): rate-limited discovery-observation store for unknown/unadopted NAS sightings (M, medium risk) — or formally drop it |
| 4 | Task 2: `apps/api/src/internal/nas-eligibility.ts` exporting `evalNasEligibility(trx, nas, site)` (DB-aware) | SUPERSEDED | implemented instead as a pure function: packages/shared/src/nas-eligibility.ts:202 `nasEligibility(facts)` with `NAS_PENDING_REASONS` (:50); no `apps/api/src/internal/nas-eligibility.ts` | Doc fix |
| 5 | Task 2: states/reasons NOT_ADOPTED, BLOCKED, DISABLED, NO_POLICY, OWNERSHIP_UNRESOLVED, ACTIVE | IMPLEMENTED | packages/shared/src/nas-eligibility.ts:50 NAS_PENDING_REASONS; apps/api/src/policy-availability.ts:3 (NO_POLICY, "settled 2026-10-15"); routes/access-points-page.ts:185-186 (pending_reasons, primary_reason) | - |
| 6 | Task 2: `tenant_inactive` on inactive/soft-deleted site on both RADIUS and portal paths | IMPLEMENTED | apps/api/src/internal/aaa.ts:786 `Reject('tenant_inactive', …)`; internal/nas-lookup.ts:65,188-192 | - |
| 7 | Task 2: eligibility enforced before Access-Accept (unadopted NAS rejected with NOT_ADOPTED) | PARTIAL | `grep -rn "is_adopted\|NOT_ADOPTED" apps/api/src/internal/` → **no hits**: the adoption gate is visible in the admin/API overview path only, not in the AAA decide path. `tenant_inactive` gating is wired; adoption gating is not | Apply: enforce `is_adopted` / `status='blocked'` in apps/api/src/internal/aaa.ts before Access-Accept, with tests (M, **high risk** — A2+A3+A9 review per AGENTS.md) |
| 8 | Task 3: new route file `apps/api/src/routes/nas-pending.ts` with `GET /nas/pending`, `POST /nas/:id/adopt|block|unblock` | SUPERSEDED | adopt landed at apps/api/src/routes/access-points-page.ts:701 (idempotent, see :709) with the overview listing at :368-395; block/unblock landed at apps/api/src/routes/resources.ts:846,901 (and :827 notes they are deliberately not reachable via `PATCH /nas/:id`). No `nas-pending.ts`, no `GET /nas/pending` | Doc fix |
| 9 | Task 4: Pending filters/reason chips/"Adopt & Assign Policy" in AccessPointsTable+AccessPointsPage; Task 5 `tests/integration/nas-pending-adoption.test.ts` | SUPERSEDED | shipped as apps/admin/src/features/access-points/NasStateList.tsx (+ NasStateList.test.tsx) and AdoptNasButton.tsx, with data.ts:39,109-116 carrying `pending_reasons`; coverage is apps/api/src/access-points-page.integration.test.ts:654-666, not `tests/integration/nas-pending-adoption.test.ts` (no `tests/integration/` dir exists) | Doc fix |

## 6. tests/e2e/README.md

| # | claim (short, section ref) | verdict | evidence (path:line / D-number) | apply item? |
|---|---|---|---|---|
| 1 | "Status: structure only … this folder holds **one** smoke test" | STALE-DOC | `ls tests/e2e` → api-healthz.test.ts **and** portal-uam-radius.test.ts (2 suites) | Doc fix: add portal-uam-radius.test.ts to the table |
| 2 | `api-healthz.test.ts` boots `apps/api/dist/main.js` and asserts `GET /healthz` = 200 `{"status":"ok"}` | IMPLEMENTED | tests/e2e/api-healthz.test.ts | - |
| 3 | Skips unless `apps/api/dist/main.js` exists and `ECLOUD_TEST_DATABASE_URL` is reachable | IMPLEMENTED | tests/e2e/api-healthz.test.ts (guarded skip with reason) | - |
| 4 | Planned Phase-6 Playwright layout (playwright.config.ts, fixtures/fake-nas, portal/*.spec.ts, admin/*.spec.ts) | MISSING | no `playwright` dependency in package.json (`grep -rn playwright package.json` → no hits); no playwright.config.ts or fixtures/ under tests/e2e | Apply: stand up the Playwright e2e project (L, low risk) — or re-scope the README to the vitest e2e suites actually used |
| 5 | Planned admin specs include "login + TOTP" | STALE-DOC | D-046 removed admin MFA (`ADMIN_MFA_MODE=off`); a TOTP e2e spec is no longer the target | Doc fix: drop TOTP from the planned admin specs (cite D-046) |
| 6 | Device-derived fixtures only, from `test/fixtures/device/<model>/<firmware>/` (DT-03/DT-11/DT-15); e2e never marks DT-xx passed | PARTIAL | the rule is consistent with tests/device/ existing in the repo, but the cited path is `test/fixtures/device/...` (singular `test/`) while the repo uses `tests/` | Doc fix: correct the fixture path to `tests/...` |

---

## Apply candidates (ranked)

1. **Enforce NAS adoption/block state in the AAA decide path** (`apps/api/src/internal/aaa.ts`) — M, **high risk**, needs A2+A3+A9 review. Today an unadopted/blocked NAS is only surfaced in the admin overview; no `is_adopted`/`NOT_ADOPTED` check was found before Access-Accept. (§5 claim 7)
2. **Org-level tenancy quotas** (max_sites / max_devices / max_users / max_concurrent_sessions) enforced at create + authorize — M, medium risk. Columns and API fields exist; no enforcement found. (§2 claim 16)
3. **API-key hardening**: prove/enforce "no escalation beyond the key's binding" and "platform keys never get `tenant:impersonate`", with tests — M, security (A8 gate). (§2 claim 14)
4. **Decide the fate of `nas_discovery_observations`** — M, medium risk: implement the rate-limited sighting store for unknown/unadopted NAS, or formally drop it from the plan/requirements. (§5 claim 3)
5. **Playwright e2e project** (config + fake-nas fixtures + portal/admin specs) — L, low risk; currently entirely planned. (§6 claim 4)
6. Schema audit that every RLS-enabled tenant table carries `organization_id` — S, low risk. (§2 claim 3)
7. Add or document isolation case **T-13** (T-01…T-15 present except T-13) — S, low risk.

## Doc fixes (STALE-DOC / wrong-doc)

- `MULTITENANCY.md` §3.1: MFA enforcement text is superseded by **D-046** (admin MFA off).
- `MULTITENANCY.md` §4.2: add `nas:secret:reveal` to the `nas` permission row (D-045).
- `MULTITENANCY.md` §4.5: record **D-062** — all writes are refused while impersonating.
- `packages/policy-engine/README.md`: the "11 rules of §1.3 with `{path, rule, code}`" description does not match `validatePolicy` (no `rule` field found); and the module table omits 8 real modules (aggregate, api-limits, enforcement, mikrotik, operations, quota-periods, unlimited, platform-default) plus the week-start schedule helpers.
- `docs/superpowers/plans/2026-10-14-nas-pending-adoption.md`: mark **SUPERSEDED** at the top — real artefacts are migration `046_nas_adoption_blocked.sql` (status='blocked', no `is_blocked`), `packages/shared/src/nas-eligibility.ts`, the overview/adopt endpoints in `routes/access-points-page.ts`, block/unblock in `routes/resources.ts`, and `NasStateList.tsx` / `AdoptNasButton.tsx`.
- `tests/e2e/README.md`: two suites not one; drop "login + TOTP" (D-046); fix `test/fixtures/device/...` → `tests/...`.
- `ADMIN_UI_ARCHITECTURE.md`: see §1 table (doc fixes listed there).

## Needs owner

1. `MULTITENANCY.md` §8 M2/M3/M5: shared-venue NAS ownership, whether tenant consent is required before platform impersonation, and whether a tenant read-only export ships at launch.
2. `vendor-logos/SOURCES.md`: is an EZELINK/EZEAP SVG logo master available (today the UI renders a wordmark tile)?
3. Is `nas_discovery_observations` still wanted at all, given the shipped design records pending state on `nas_clients` only?
