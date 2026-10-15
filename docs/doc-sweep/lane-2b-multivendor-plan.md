# Lane 2b — MULTI_VENDOR_INTEGRATION_PLAN.md

- Lane: 2b (split from Lane 2, one file)
- Start / end (UTC): 2026-10-15T18:00:02Z / 2026-10-15T18:12Z
- Repository: `/Users/danny/Project/EZECLOUD`, branch `feature/universal-aaa`, HEAD `86af9f30204c1006224b39d8bfeff8ce461e7cd1`
- Document: `MULTI_VENDOR_INTEGRATION_PLAN.md`, 1,144 lines, last commit `1f1e1bc` (2026-10-10 23:10 +04). Read end-to-end with the Read tool in **6 chunks** (1–400, 401–600, 601–780, 781–960, 961–1144; a 400-line chunk at 401 exceeded the token cap and was re-read as 200/180/180/184).
- Host checks (vps-local, read-only): `docker ps` (7 containers healthy: worker, api, edge, portal, freeradius, postgres, redis) and one SELECT-only psql batch. **Denied host checks: none.** Nothing printed from the host contains a secret.
- Test-run figures quoted in the document (file/test counts, run ids, hashes) were **not re-run tonight**; tests are checked for existence only.
- Observation outside this document: the repository carries `packages/db/migrations/049_portal_registration_devices.sql` (another session's work, Lane 3 scope) while the pilot's `schema_migrations` max is `048`. Not a plan claim; recorded for the Orchestrator.

## Checklist

- [x] MULTI_VENDOR_INTEGRATION_PLAN.md — 107 claims, IMPLEMENTED 73, PARTIAL 5, MISSING 4, STALE-DOC 9, SUPERSEDED 5, OUT-OF-SCOPE 1, NEEDS-OWNER 10

Evidence conventions: `path:line` is in the repository at HEAD above; `pilot:` is the vps-local SELECT output; `D-nnn` is DECISIONS.md.

## Findings

### Header, §1 Summary, §3 Discovery summary (OBSERVED 2026-10-08)

| claim | verdict | evidence | apply item? |
|---|---|---|---|
| Header: "Status: PROPOSED (L1 deliverable, docs only)" | STALE-DOC | §8.1–§17 of the same file record L2–L4 and Cycles A–E as DONE/BUILT; code exists (rows below) | yes — doc fix: header status line + date |
| §1.1 / §3: five engine adapters behind one `NasAdapter`; composition wrapper, golden tests unchanged | IMPLEMENTED (count now 9) | `packages/policy-engine/src/capabilities.ts:15-27` lists 9 engine keys (5 first-party + `generic-radius-8021x`, `mikrotik-hotspot`, `external-portal-postback`, `meraki-splash`); `packages/adapters/src/adapters/` has 9 files; `packages/adapters/src/vendor/first-party.ts`; `packages/adapters/src/golden.test.ts` present; pilot `adapter_types` = 12 (9 engine + 3 vendor-API kinds) | no (doc fix folded into the header row) |
| §1.3 / §4.2: 29 VERIFIED cells + 40 attributes mapped to `VERIFIED_FROM_SOURCE` with source refs | IMPLEMENTED | `packages/adapters/src/source-refs.ts`, `packages/adapters/src/evidence.test.ts` (pins the table; not re-run) | no |
| §1.3 / R-10: admin badge relabelled "Verified (source)", "Lab validated" only with DT ref; old "verified by a recorded device test" text forbidden | IMPLEMENTED | `apps/admin/src/features/platform/AdaptersPage.tsx:36`, `apps/admin/src/features/policies/PreviewPanel.tsx:78`, `apps/admin/src/lib/adapterStatus.ts:108`, source-scan test `apps/admin/src/components/StatusBadge.test.tsx:179` | no |
| §1.4: Cambium is researched only, no adapter; cnMaestro not the primary path | SUPERSEDED (D-044) | D-044 ordered Cycle C; `cambium-hotspot` post-back profile exists at `packages/adapters/src/vendor/postback/profiles.ts:135`; registry row stays `researched` (pilot `compatibility_entries` lifecycle researched = 1). The file's own §15 records this | no (doc fix: §1.4 pointer to §15) |
| §1.5 / R-15, R-16: hotspot services in EZECLOUD, EZECONTROL unchanged; Option A (policy-fragment API, Q49) a later owner decision | OUT-OF-SCOPE | D-013, D-031, D-058 (EZEControl paused) — any controller-side variant is listed, not planned | no |
| §3 "Permissions: 99 keys; no `controller:*`, no `compatibility:*`" | STALE-DOC | `PERMISSION_CATALOGUE` length 112 (`packages/shared/src/permissions.ts`, `controller:read` at :389, `compatibility:read` at :390); pilot `permissions` = 112 | yes — doc fix (mark §3 as a dated snapshot) |
| §3 "Portal: skeleton only, no UAM parsing, no portal flows" | STALE-DOC | `apps/portal/src/index.ts:8,9,17,640` routes `/hotspot/mikrotik/`, `/pb/…`, `/meraki/{nasid}/`, `/guest/s/…` | same doc fix |
| §3 "18 migrations; no vendor/controller/model/firmware tables" | STALE-DOC | `packages/db/migrations/` 001–049; 019 creates `vendors`, `hardware_models`, `firmware_versions`, `compatibility_entries`, `controllers` | same doc fix |
| §3 / §5.3 AAA: NAS resolved only from packet source IP / client shortname; NAS-Identifier **never** selects a tenant | SUPERSEDED (D-044, amends D-032) | Meraki NAS resolve by shortname + required NAS-Identifier binding, `apps/api/src/internal/aaa.ts:742` (`nas_identifier_missing/_mismatch`); source IP still never consulted (§17.1 F2). Rule for all other adapters unchanged | no (doc fix: add the Meraki exception to §5.3) |
| §3 DT-01 is the only device test; fixture file exists | IMPLEMENTED | `test/fixtures/device/EZE-AP1832/r32912-6639b15f62/DT-01_identification_2026-10-07.txt`; `DT_RESULTS` = `DT-01` only (tsx import of `packages/adapters/src/registry/index.ts`); D-065 defers the next device test | no |

### §4 Evidence model, §4.5 validator rules

| claim | verdict | evidence | apply item? |
|---|---|---|---|
| `EVIDENCE_LEVELS`, `LIFECYCLES`, `EvidenceRef`, `OPERATION_CAPABILITIES`, `isDeviceEnforced()` in `packages/shared` | IMPLEMENTED | `packages/shared/src/evidence.ts:10,75,87` | no |
| Validator V1–V12 with a negative test each | IMPLEMENTED | `packages/adapters/src/registry/validate.ts`, `validate.test.ts` (present; not re-run) | no |
| §4.4 labels: `deviceEnforced` true only for LAB/PRODUCTION evidence (V12) | IMPLEMENTED | `packages/shared/src/evidence.ts:87`; API `apps/api/src/routes/platform.ts:368-373` (`device_enforced`, `evidence_level`) | no |
| "Nothing becomes LAB_VALIDATED in M11 except DT-01 identity facts"; `PRODUCTION_VALIDATED` count 0 | IMPLEMENTED | `DT_RESULTS` = DT-01 only; V4 in `validate.ts`; no later DT recorded (D-065) | no |
| OQ-16: owner to confirm "VERIFIED_SUPPORTED = source-verified mechanism, not device enforcement" | NEEDS-OWNER | plan §4.4/§9 OQ-16 applied conservatively; no DECISIONS row confirms it | question: "Confirm that a VERIFIED_SUPPORTED cell with source-only evidence is shown as 'Expected (source-verified, not device-tested)' and never as device-enforced until a lab test passes?" |

### §5 Architecture, §6 Vendor-neutral contract

| claim | verdict | evidence | apply item? |
|---|---|---|---|
| `VendorAdapter` with nine operations; five first-party wrappers; `vendor.engine === getAdapter(key)` | IMPLEMENTED | `packages/adapters/src/vendor/types.ts`, `first-party.ts`, `uam.ts`, `vendor.test.ts` | no |
| Backend-API strategy "typed slot only, no implementation in M11" | SUPERSEDED (D-044) | Cycle D built it outside `VendorAdapter.authorizeSession`: `packages/vendor-api/src/*`, `apps/api/src/vendor-api/portal.ts` (§16 D2 says so) | no (doc fix: §6.3 strategy matrix is M11-era) |
| R-18: gateway mode = CoovaChilli only; MikroTik gateway `planned`, capabilities `UNKNOWN` | SUPERSEDED (D-044) | row `mikrotik-routeros-hotspot` lifecycle `implemented` (tsx row list); `packages/adapters/src/adapters/mikrotik-hotspot.ts` | no (doc fix) |
| `parseRedirect`: `md` last parameter, raw query byte-identical, hostile `userurl` incl. backslash refusal (SIM-07 fix) | IMPLEMENTED | `packages/adapters/src/vendor/uam.ts:172` | no |
| R-30 / OQ-17: `ga_srvr` / controller `base_url` never fetched by EZECLOUD in M11; any future fetcher must resolve, re-check every address, pin, never follow redirects | IMPLEMENTED (by Cycle D) | `packages/vendor-api/src/http.ts:15-18` (own DNS, per-kind re-check, pinned connect, `redirect_refused`), `:141` port allow-list | no |
| R-41: registered vs online AP status via a verified telemetry connector ("later") | MISSING | no monitoring connector; `network_devices.mgmt_status` only (migration 003) | yes — L, low priority, needs design; not an M11/Cycle item |
| R-42: marketing consent, retention/export/deletion (Phase 6 portal) | PARTIAL | repo migration `049_portal_registration_devices.sql` ("registration submissions, terms acceptance, device registration"), not on the pilot (max 048); Lane 3 scope | defer to Lane 3 report |

### §7 Compatibility registry

| claim | verdict | evidence | apply item? |
|---|---|---|---|
| Typed registry in `packages/adapters/src/registry/`; implemented rows derive cells from `engine.capabilities()`; mirror hash | IMPLEMENTED | `registry/{types,derive,vendors,dt-results,compatibility,validate,mirror,index}.ts`; `canonicalJson`, `registryEntryHash` exported | no |
| §8.1 note "30 rows / 27 vendors / 23 planned" | STALE-DOC | tsx import: **33 rows, 29 vendors** (11 implemented, 1 researched, 21 planned); pilot mirror 29 / 1 / 3 / 33 identical; the registry hash quoted in §8.2 is also historical (`ecloud-db registry-check` is the authority) | yes — doc fix (counts) |
| Rows §7.2–§7.4 present: 3 EZE-AP1832 rows, `openwrt-uspot-upstream`, `coova-chilli-1.2.9-ezegate` (V11 override), `coova-chilli-master`, Cambium researched, roadmap planned rows | IMPLEMENTED | implemented row keys from tsx import; `cisco-meraki-planned` kept (`registry.test.ts:238`); `ROADMAP_VENDORS` `vendors.ts:58`, `PROMOTED_VENDOR_ENTRIES` `vendors.ts:125` | no |
| EZEGATE 1.2.9 row presents engine-verified cells as REQUIRES_DEVICE_TEST (V11) until DT-15 | IMPLEMENTED | `registry/validate.test.ts` V11 cases; `derive.ts` (not re-run) | no |
| Cambium model/firmware/controller `UNKNOWN` (OQ-3), EasyPass wanted? (OQ-4), `ga_srvr` public mode (OQ-8) | NEEDS-OWNER | no DECISIONS row answers OQ-3/4/8; Cycle C profile accepts `ga_srvr` only as registered NAS IP / login host (§15 item 4) | question: "Which Cambium model/firmware/cnMaestro deployment is installed, and is cnMaestro EasyPass wanted at all given the Oct-2026 cloud notice?" |
| DB mirror seeded from `@ecloud/adapters`; `ecloud-db seed` idempotent; `registry-check` exit 2 on drift | IMPLEMENTED | `packages/db/src/registry-seed.ts`, `packages/db/src/cli.ts:10`; pilot counts equal the typed registry | no |

### §8.1 L2 — contract + registry code (implementation notes, deviations)

| claim | verdict | evidence | apply item? |
|---|---|---|---|
| Deviation 1 closed: `GET /api/v1/platform/adapters` emits `evidence_level`, `device_enforced`, `dt_refs` via `adapterCellEvidence()` | IMPLEMENTED | `apps/api/src/routes/platform.ts:6,368-373` | no |
| Deviation 2 closed: worker `normalize.ts` re-exports the adapters normaliser; `relocation.test.ts` | IMPLEMENTED | `apps/worker/src/accounting/normalize.ts:7-13`; `apps/worker/src/accounting/relocation.test.ts`; `packages/adapters/src/vendor/accounting.test.ts` | no |
| Admin "Verified (evidence level not reported)" fallback; drift tests extended to `EVIDENCE_LEVELS` / `isDeviceEnforced` | IMPLEMENTED | `apps/admin/src/lib/adapterStatus.ts`; `AdaptersPage.tsx:36` | no |
| Note 11: portal must map every `validateContext` failure to one generic error page and rate-limit (unknown-NAS vs bad-signature oracle) | IMPLEMENTED | `apps/api/src/internal/portal.ts` flows + per-IP limits recorded in §17.1 F3 (`/meraki/<id>/` 20 / 10 min); generic 409/`unknown_nas` behaviour tested in `apps/api/src/cycle-c.integration.test.ts` | no |
| Test-run figures (§8.1/§8.2/§8.3/§13–§17: file and test counts, run ids) | PARTIAL | every named test file exists (list in the header); counts not re-run tonight | no (Orchestrator may schedule one full `npm test` before apply) |

### §8.2 L3 — data structures

| claim | verdict | evidence | apply item? |
|---|---|---|---|
| Migrations 019/020: platform mirror tables, `controllers` with FORCE RLS `tenant_isolation`, `uq_sites_org_id`, `nas_clients.deployment_mode/controller_id`, `network_devices.*` FKs + `managed` | IMPLEMENTED | `packages/db/migrations/019_multivendor_registry.sql:153,192`; `020_controllers_base_url_userinfo.sql`; pilot tables present (`controllers` = 0 rows) | no |
| Permissions `controller:read|create|update|delete|secret:rotate`, `compatibility:read`; templates edited explicitly | IMPLEMENTED | `packages/shared/src/permissions.ts:389-390`; catalogue 112 = pilot 112 | no |
| Endpoints `GET /api/v1/compatibility[/{key}]`, `GET /api/v1/vendors`, controllers CRUD + `rotate-credential` (impersonation refused, audited), credential never returned | IMPLEMENTED | `apps/api/src/routes/registry.ts:3`, `apps/api/src/routes/controllers.ts:3,60`; `apps/api/src/multivendor.integration.test.ts`; envelope purpose `ecloud:controller:credential:v1` (`cycle-a.integration.test.ts:621`) | no |
| Webhook URL guard moved to `@ecloud/shared` (`net-guard.ts`), worker re-exports, tests unchanged | IMPLEMENTED | `packages/shared/src/net-guard.ts:104,119`; `apps/worker/src/jobs/webhook-transport.ts:17` | no |
| `controllers` in `TENANT_SCOPED_TABLES`; two-tenant fixture seeds a controller; tenant-cases cover controllers | IMPLEMENTED | `tests/isolation/rls-matrix.test.ts:10,108`; `packages/testing/src/two-tenants.ts:32-33`; `tests/isolation/tenant-cases.test.ts:415-417` | no |
| SIM-18 drainer defect fixed: org+NAS-scoped lookups, collision audit `accounting:acct_unique_id_collision`, 3600 s dedupe (F6) | IMPLEMENTED | `apps/worker/src/accounting/drain.ts:469-471`; `apps/worker/src/attribution.integration.test.ts` | no |
| Reaper also closes `stale` sessions after 2 × interim + grace | IMPLEMENTED | `apps/worker/src/jobs/reap.ts:5,13,51` | no |
| "admin client regenerated … 67 paths" | STALE-DOC | `apps/admin/src/api/openapi.json` now has 111 `/api/v1/` paths | no (historical figure; fold into header doc fix) |
| Deviation 4: soft-deleted controller still referenced by NAS/device is prevented by the API only (409), not the DB | IMPLEMENTED (as designed) | `routes/controllers.ts` delete path (409 while referenced); accepted deviation | no |

### §8.3 L4 — simulators

| claim | verdict | evidence | apply item? |
|---|---|---|---|
| SIM-01…SIM-18 in `tests/simulators/` + `packages/testing/src/simulators/`; results file bound to run id | IMPLEMENTED | `tests/simulators/{uam-redirect,handoff,accounting,db.integration,results}.test.ts`, `record-results.ts`, `SIMULATOR_RESULTS.json` (`runId dafbef1e…`, `format ecloud-simulator-results/v1`); `docs/TESTING.md:265` §10 | no |
| Proposed promotion: `SIMULATOR_TESTED` on `redirectParse` / `authorizationHandoff` / `accountingNormalize` of `openwifi-uspot-uam` and `coovachilli-uam` ("orchestrator applies later") | MISSING | no `SIMULATOR_TESTED` literal in `packages/adapters/src/registry/{compatibility,derive,vendors}.ts`; `results.test.ts` only proves the promotion would keep V1–V12 green | yes — S: apply the six operation-capability claims from `SIMULATOR_RESULTS.json` to the registry (V2 forbids enforcement cells); re-seed mirror |
| Open finding 3: "nothing ever closes a stale session" | STALE-DOC | contradicted by `apps/worker/src/jobs/reap.ts:51` (`status in ('active','stale')`) and by §8.2 of the same file | yes — doc fix (strike finding 3) |
| Open finding 5: 32-bit wrap detected by `counterWrap32Quirks`, "the worker does not call the hook yet" | STALE-DOC (hook wired) / PARTIAL (alerting) | `apps/worker/src/accounting/drain.ts:581,635,787` calls `accountingQuirksFor(...).detectAnomalies`; `packages/adapters/src/vendor/accounting.ts:275`; whether the anomaly reaches an alert/report was not traced tonight | yes — doc fix; S follow-up: confirm the `counter_wrap_32bit` anomaly surfaces (alert or audit), device behaviour stays REQUIRES_DEVICE_TEST |
| Open finding 6: `nas_identifier` not unique across tenants; portal lookup must fail closed on ambiguity | IMPLEMENTED | `apps/api/src/internal/nas-lookup.ts:265` (`findNasByIdentity`, ambiguous → fail closed); global uniqueness for post-back/MikroTik identifiers `apps/api/src/routes/resources.ts:240`; Meraki reserved shape (migration 032:104) | no |
| Open finding 7: DB simulator group runs `drainOnce` without the production lock (flaky under concurrent agents) | MISSING | plan text only; no lock in `tests/simulators/db.integration.test.ts` checked by name | yes — S: take the drain lock (or a dedicated test DB slot) in the DB-backed simulator group |

### §9 Open items (OQ-1…OQ-17)

| claim | verdict | evidence | apply item? |
|---|---|---|---|
| OQ-1 "EZECONTROL dashboard" = EZECLOUD admin app | IMPLEMENTED (default taken) | admin pages `apps/admin/src/features/org/ControllersPage.tsx`, `features/access-points/AccessPointsPage.tsx`, `features/platform/AdaptersPage.tsx`; D-058 forbids the alternative | no |
| OQ-2 Arabic/RTL in release-1 portal vs Q77 default | NEEDS-OWNER | no DECISIONS row amends Q77; portal `apps/portal/src/i18n.ts` exists (content not assessed, Lane 3) | question: "Is Arabic (RTL) required in the release-1 captive portal, or does the Q77 English-only, RTL-ready default stand?" |
| OQ-5 shared public RADIUS source IP at third-party sites; OQ-6 per-site fail-open | NEEDS-OWNER | Q32/Q48 defaults applied; D-044 adds Meraki (shortname-resolved) but no general shared-IP rule | question: "Keep 'tunnel required for third-party sites' (no shared source IPs) and 'no per-site fail-open', or amend Q48/Q32?" |
| OQ-7 EZE gateway hardware model (V-111) and whether CoovaChilli 1.2.9 may be upgraded (Q41) | NEEDS-OWNER | registry row `coova-chilli-1.2.9-ezegate` keeps `sourceVersionMatchesDevice: false` until DT-15 | question: "Which gateway hardware runs CoovaChilli 1.2.9, and may it be upgraded before the DT-15 lab test?" |
| OQ-9…OQ-14 device tests (IPv6, Cambium, first-party DT-02…DT-24, MikroTik path, Meraki) | NEEDS-OWNER | D-034 (no PASS without the real device), D-065 (CoA device test on AP1832 deferred); `DT_RESULTS` still DT-01 only | question: "When is the lab EZEAP/gateway available for DT-02…DT-24, and which third-party device (Cambium/MikroTik/Meraki) comes first?" |
| OQ-15 `captive_portals.portal_type` legacy CHECK (`uspot`,`coovachilli`,`external`) vs adapter keys (R-35) | PARTIAL | migration `029_mikrotik_teltonika.sql:43` adds `mikrotik`; pilot `captive_portals.portal_type` = `uspot` (1 row); vocabulary still not derived from `nas_clients.adapter_key` | yes — S/M: reconcile `portal_type` with the adapter key (Phase 6 portal work; coordinate with Lane 3) |
| OQ-17 fetch policy for a backend-API connector | IMPLEMENTED | `packages/vendor-api/src/http.ts:15-18,141`; `SECURITY_ARCHITECTURE.md:566` §13 | no |

### §13 Multi-vendor Cycle A (foundation) — DONE 2026-10-10, D-044

| claim | verdict | evidence | apply item? |
|---|---|---|---|
| A1 `nas_access_points` (migration 028), `/api/v1/orgs/{orgId}/access-points`, `findNasByIdentity` fail-closed, admin "Access points (AP MAC)" | IMPLEMENTED | `packages/db/migrations/028_multivendor_cycle_a.sql:7,14`; `apps/api/src/routes/access-points.ts`; `apps/api/src/internal/nas-lookup.ts:265`; `apps/admin/src/features/access-points/AccessPointsPage.tsx`; pilot `nas_access_points` = 7 rows | no |
| A2 `vendor_api_credentials`, `GET/POST/DELETE …/controllers/{id}/api-credential`, sealed `ecloud:vendor-api:secret:v1`, write-only, impersonation refused | IMPLEMENTED | `028_multivendor_cycle_a.sql:15`; `apps/api/src/routes/controllers.ts:60,655`; pilot `vendor_api_credentials` = 0, `controllers` = 0 (feature unused in the pilot) | no |
| A3 post-back anti-forgery login token `lt1.`, HKDF purpose `ecloud:portal:login-token:v1`, Redis `SET NX EX` claim store | IMPLEMENTED | `packages/adapters/src/vendor/login-token.ts:10,29`; `apps/api/src/internal/login-token-store.ts`; `login-token.test.ts` | no |
| A4 MikroTik rate format renderer; FreeRADIUS stock `dictionary.mikrotik` | IMPLEMENTED | `packages/policy-engine/src/mikrotik.ts:161`; `infra/freeradius/README.md:125` | no |
| A5 `generic-radius-8021x` adapter, registry row, migration 028 key, opt-in EAP-TTLS/PAP (`RADIUS_EAP_ENABLED`), inner-tunnel `ECLOUD-EAP-Inner`, MAB rules | IMPLEMENTED | `packages/adapters/src/adapters/generic-radius-8021x.ts`; `028_multivendor_cycle_a.sql:5`; `infra/freeradius/docker-entrypoint.sh` + `Dockerfile` (RADIUS_EAP_ENABLED), `infra/freeradius/raddb/sites-available/ecloud-inner`, `mods-available/eap`; `apps/api/src/internal/aaa.ts:355`; row `generic-radius-8021x` implemented (tsx) | no |
| A5 production EAP server certificate "REQUIRES_CLARIFICATION" | NEEDS-OWNER | no DECISIONS row; EAP stays opt-in with a mounted certificate | question: "Which certificate (CA/issuer, hostname) should FreeRADIUS present for EAP-TTLS when 802.1X is enabled on the pilot?" |
| 13.1 M1: `verified_at` / `verification_source`, RADIUS-observed verification (`observeAccessPoint`), `POST /api/v1/platform/access-points/release` | IMPLEMENTED | `028:14`; `apps/api/src/cycle-a.integration.test.ts:366`; `cycle-c.integration.test.ts:322` | no |
| 13.1 L1: idempotency fingerprints HMAC keyed from `DATA_ENCRYPTION_KEY` purpose `ecloud:idempotency:fingerprint:v1` | IMPLEMENTED | `apps/api/src/http/idempotency.ts:9` | no |
| 13.1 L4: replay keys `pf:replay:v2:`; `legacyReplayKey` to be removed after the 24 h window | PARTIAL | `apps/api/src/internal/portal-store.ts:167,176` — legacy reader still present five days after 2026-10-10 | yes — S: delete `legacyReplayKey` and its read path (window long expired) |
| 13.1 M2 global-slot release on site delete / org archive | IMPLEMENTED | `apps/api/src/global-slots.ts` | no |

### §14 Multi-vendor Cycle B (MikroTik, Teltonika) — BUILT 2026-10-10, D-044

| claim | verdict | evidence | apply item? |
|---|---|---|---|
| B1 `mikrotik-hotspot` engine adapter; migration 029 key + NAS CHECK; all cells DOCUMENTED / REQUIRES_DEVICE_TEST | IMPLEMENTED | `packages/adapters/src/adapters/mikrotik-hotspot.ts`; `capabilities.ts:23`; `029_mikrotik_teltonika.sql:43`; row `mikrotik-routeros-hotspot` implemented | no |
| B2/B3 RouterOS `login.html` renderer, portal `GET /hotspot/mikrotik/`, CHAP challenge as vendor nonce + login token | IMPLEMENTED | `packages/adapters/src/vendor/mikrotik.ts:8`; `apps/portal/src/index.ts:8`; `mikrotik.test.ts` | no |
| B4 CHAP in AAA: sealed CHAP credential `ecloud:portal:chap-credential:v1`; F2 retransmit cache sealed `ecloud:aaa:retransmit-cleartext:v1` | IMPLEMENTED | `apps/api/src/internal/portal-store.ts:128`; `apps/api/src/internal/aaa.ts:121` | no |
| B5/F3 lab opt-in `nas_clients.device_test_attributes`, `platform:adapter:manage` only, audited `nas:lab_mode_changed` | IMPLEMENTED | `029:12`; `apps/api/src/cycle-b.integration.test.ts:507`; pilot: 0 NAS in lab mode | no |
| B6 per-NAS `coa_port`, adapter `defaultPort` fallback in the dispatcher | IMPLEMENTED | `apps/api/src/routes/resources.ts:128`; `apps/worker/src/coa/dispatcher.ts:229` | no |
| Dispatcher secret resolution implied by B6/E4 (worker opens NAS secret itself) | SUPERSEDED (D-056, D-061) | worker now fetches the opened secret from `GET /internal/nas/:id/secret` with its own token (D-061); D-065 confirms live | no (doc fix: one line in §14 B6 / §17 E4) |
| B7 setup guides MikroTik / Teltonika (data only) | IMPLEMENTED | `packages/adapters/src/vendor/gallery.ts:24`; `teltonika.ts:2`; `apps/api/src/routes/setup-guides.ts:5` (+ D-045 gallery) | no |
| 14.1 F1 `nas_clients.hotspot_address/hotspot_port` binding (RFC 1918/6598 CHECK), required for `mikrotik-hotspot` | IMPLEMENTED | `029:17` | no |
| B9 `portal_type = 'mikrotik'` | IMPLEMENTED | `029:43` | no |
| Teltonika wiki HTTP 403 → RutOS field names REQUIRES_CLARIFICATION | NEEDS-OWNER | plan §14; no later source recorded in `docs/VENDOR_INTEGRATION_RESEARCH.md` §7 | question: "Can the owner supply Teltonika RutOS hotspot documentation or a lab RUT device so the field names stop being guesses?" |
| 14.1 merge-safety: 029 rebuilds the NAS adapter CHECK from `pg_get_constraintdef`; `migrate.test.ts` strictly increasing | IMPLEMENTED | `packages/db/src/migrate.test.ts:290`; `packages/db/src/integration.test.ts` | no |

### §15 Multi-vendor Cycle C (post-back engine) — BUILT 2026-10-10, D-044

| claim | verdict | evidence | apply item? |
|---|---|---|---|
| C1 `external-portal-postback` adapter key, `PortalType 'external-postback'`, migration 030 (`adapter_types`, CHECK rebuilt, `nas_clients.adapter_config`) | IMPLEMENTED | `packages/adapters/src/adapters/external-portal-postback.ts`; `capabilities.ts:25,44`; `030_multivendor_cycle_c_postback.sql:9`; row `external-portal-postback` implemented | no |
| C2/C3 engine + profiles `cambium-hotspot`, `aruba-ecp`, `cisco-webauth`, `fortinet-ecp`, `ruckus-wispr`, `omada-external-portal`, `huawei-portal`, `postback-generic` | IMPLEMENTED | `packages/adapters/src/vendor/postback/profiles.ts:135,199,273,328,385,454,513,560`; `engine.ts`; `postback.test.ts` | no |
| C4 generic profile config: fixed `login_path`, optional `login_port` (M1), `strict_login_hosts` (M2) | IMPLEMENTED | `packages/adapters/src/vendor/postback/config.ts:51,67` | no |
| C5 portal `/pb/<profile>/<nasid>/`, login token consumed once, auto-submitting form, CSP `form-action` | IMPLEMENTED | `apps/portal/src/index.ts:9,223`; `apps/api/src/internal/portal-postback.ts`; `apps/portal/src/postback.test.ts`; `apps/api/src/cycle-c.integration.test.ts` | no |
| C6 setup guide endpoint + admin row action | IMPLEMENTED | `apps/api/src/routes/setup-guides.ts:5`; admin `features/setup-guides/VendorGuidePage.tsx` | no |
| 15.1 L1 identifier uniqueness across orgs for public-URL adapters; "a partial unique index can follow once the adapter set is final" | PARTIAL | `apps/api/src/routes/resources.ts:240` (`assertNasIdentifierAvailable`); no partial unique index in migrations 030–049 for this rule (race window remains) | yes — S: add the partial unique index on live NAS identifiers of `external-portal-postback` / `mikrotik-hotspot` (adapter set now final through Cycle E) |
| Aruba `url-hash-key` not implemented (algorithm undocumented) | MISSING (blocked) | plan §15 item 1; no `url-hash-key` code | yes — M, blocked on HPE documentation or a lab capture; keep the guide's "leave unset" |
| Long tail (Grandstream, EnGenius, Zyxel, DrayTek, Ruijie, Extreme, Alcatel, Tanaza, DCN) via `postback-generic` after lab capture | IMPLEMENTED (mechanism) | `profiles.ts:560`; rows stay `planned` (21) | no (lab-gated, D-034) |

### §16 Multi-vendor Cycle D (controller APIs) — IMPLEMENTED 2026-10-10, D-044

| claim | verdict | evidence | apply item? |
|---|---|---|---|
| D1 SSRF-safe `VendorHttpClient`: own DNS, per-kind re-check, pinned connect, TLS verified (roots / CA PEM / fingerprint), no redirects, deadline, response cap, token bucket, port allow-list | IMPLEMENTED | `packages/vendor-api/src/http.ts:15-18,30,120-121,141,212`; `rate-limit.ts`, `errors.ts`; `http.test.ts` | no |
| D2 credentials opened in-process; worker gets only `VENDOR_API_SECRET_KEY` (`vapi1.`, HKDF-derived) — F4 | IMPLEMENTED | `packages/vendor-api/src/credentials.ts`, `sealed.ts`, `cli.ts:9`; `apps/worker/src/config.ts:64` | no |
| D3/D4/D5 `unifi-external-portal`, `omada-api`, `mist-guest-portal` (migration 031); portal `/guest/s/`, `/ext/omada`, `/ext/mist`; Mist grant only to `https://portal[.<region>].mist.com/authorize` | IMPLEMENTED | `packages/vendor-api/src/unifi.ts:8,11`, `omada.ts:9`, `mist.ts:8`; `031_multivendor_cycle_d.sql:5,14`; `apps/portal/src/index.ts:169,640`; `apps/api/src/vendor-api/portal.ts`; pilot `adapter_types` = 12 | no |
| D6 Ruckus NBI stub (`not_implemented`), REQUIRES_CLARIFICATION | IMPLEMENTED (stub) | `packages/vendor-api/src/ruckus.ts:20` | no — decision folded into the Cambium/vendor-priority owner question (is Ruckus NBI wanted, and which SmartZone version?) |
| D7 controller-inventory job (hourly, `WORKER_CONTROLLER_INVENTORY_ENABLED`), F1: candidate only (`inventory_seen_at`), `POST /api/v1/platform/access-points/confirm-inventory` | IMPLEMENTED | `apps/worker/src/jobs/controller-inventory.ts`; `apps/worker/src/config.ts:58`; `031:94`; `apps/api/src/cycle-d.integration.test.ts:704` | no |
| D8 `translateApiLimits` (UniFi minutes/MB, Omada ms/bytes/kbps, Mist `authorize_min`) | IMPLEMENTED | `packages/policy-engine/src/api-limits.ts:108` | no |
| D9 admin `ControllersPage` with credential dialog, "Test connection" | IMPLEMENTED | `apps/admin/src/features/org/ControllersPage.tsx` | no |
| F2 reachability oracle: `VENDOR_API_DENY_CIDRS`, uniform test floor, ports 443/8443/8043/8843/8444, per-org limits | IMPLEMENTED | `apps/api/src/config.ts:77`; `http.ts:141`; `cycle-d.integration.test.ts:90` (`vendorTestFloorMs`) | no |
| F5 flow claim `pf:claim:<flow>`; F6 continue-URL trust (`allowed_continue_hosts`) | IMPLEMENTED | `apps/api/src/vendor-api/portal.ts:268,531` | no |
| F8 `tls_ca_pem` parsed block by block with `X509Certificate`, never a key | IMPLEMENTED | `packages/vendor-api/src/http.ts:30,120-121` (`isCertificatePem`), `apps/api/src/routes/controllers.ts:518`; DB CHECK `031:67-68` | no |
| Open D items (UniFi `/v1` prefix, rx/tx direction, Omada `time` unit, Mist https/regions, Omada/Mist inventory, vendor rate limits, WireGuard reachability to on-prem controllers) | NEEDS-OWNER (lab) | all REQUIRES_DEVICE_TEST / REQUIRES_CLARIFICATION in §16; pilot has 0 controllers — nothing to test against | covered by the device-test owner question (which vendor controller first) |

### §17 Multi-vendor Cycle E (Cisco Meraki) — IMPLEMENTED, build/test only, D-044

| claim | verdict | evidence | apply item? |
|---|---|---|---|
| E1 `meraki-splash` adapter + `vendor/meraki.ts` (parser, `n<digits>.network-auth.com` allow-list, hand-off, grant, guide); row `cisco-meraki-mr-splash-signon` implemented, `cisco-meraki-planned` kept | IMPLEMENTED | `packages/adapters/src/adapters/meraki-splash.ts:117`; `packages/adapters/src/vendor/meraki.ts:19`; `meraki.test.ts`; `registry.test.ts:238` | no |
| E2 portal `GET /meraki/{nasid}/`, login token required, `login_url` as vendor nonce, CSP form-action | IMPLEMENTED | `apps/portal/src/index.ts:17`; `apps/api/src/internal/portal-meraki.ts`; `apps/portal/src/meraki.test.ts` | no |
| E3 migration 032; per-NAS listener pairs rendered only with `MERAKI_CLOUD_RADIUS_ENABLED` + `MERAKI_RADIUS_SOURCE_CIDRS` + `MERAKI_RADIUS_PORT_RANGE`; AAA resolves by shortname + NAS-Identifier; `radacct_raw.packet_client_shortname` | IMPLEMENTED | `032_meraki_cloud_radius.sql:20,27,104`; `packages/shared/src/meraki-cloud-radius.ts:6,12,19`; `apps/api/src/radius-clients/meraki.ts`; `infra/freeradius/raddb/sites-enabled/ecloud-meraki`; `aaa.ts:742`; `drain.ts:268` | no |
| E4 Disconnect only via `nas_clients.das_host` UDP 3799, gated by `ECLOUD_COA_ENABLED` + flag; CoA change unsupported | IMPLEMENTED | `apps/worker/src/coa/dispatcher.ts:5`; `apps/worker/src/coa/meraki.test.ts`; secret path per D-056/D-061 (see §14 row) | no |
| E5 platform flag endpoint, admin banner, `MERAKI_MAX_NAS_PER_ORG`, F7 Message-Authenticator forced unless `MERAKI_ALLOW_RELAXED_MSGAUTH` | IMPLEMENTED | `apps/api/src/routes/meraki.ts:13,106,168`; `MerakiCloudRadius.test.tsx` | no |
| OFF by default; live use needs public RADIUS exposure not allowed by D-043 | IMPLEMENTED (consistent with D-043/D-044) | `meraki-cloud-radius.ts:6` default false; pilot has no Meraki NAS (`nas_clients` by adapter: `openwifi-uspot-uam` = 1) | no |
| Public RADIUS exposure + address / port range, authoritative Meraki source ranges | NEEDS-OWNER | D-044: "Meraki stays build/test-only until a separate approved exposure change"; no later DECISIONS row | question: "Is a public RADIUS exposure for Meraki Cloud wanted during the LAN-only pilot (D-043), and from which Dashboard-published source ranges?" |
| 17.1 F3 reserved identifier `ecloud-<16 hex>` (CHECK), `POST /api/v1/platform/meraki/nas-identifiers/release` | IMPLEMENTED | `032:104`; `apps/api/src/cycle-e.integration.test.ts:698` | no |
| 17.1 F4 FreeRADIUS image carries `postgresql-client`; entrypoint waits `RADIUS_SCHEMA_WAIT_S` for migration 032 | IMPLEMENTED | `infra/freeradius/Dockerfile:19`; `infra/freeradius/README.md:250`; pilot freeradius healthy with max migration 048 | no |
| Trust model documented in `SECURITY_ARCHITECTURE.md` §3.5 / §13 | IMPLEMENTED | `SECURITY_ARCHITECTURE.md:566` (§13); §3.5 reference present (Lane 4 reads the content) | no |

### Cross-document consequences (not claims of this file, recorded for the merge)

| claim | verdict | evidence | apply item? |
|---|---|---|---|
| `STATUS.md:70,75` still reads "no evidence levels; multi-vendor contract absent … INCOMPLETE → M11" | STALE-DOC | this report's §4–§17 rows; Lane 1 owns STATUS.md | yes — doc fix in Lane 1's table (STATUS rows for M11 and Cycles A–E) |

## Verdict totals

IMPLEMENTED 73 · PARTIAL 5 · MISSING 4 · STALE-DOC 9 · SUPERSEDED 5 · OUT-OF-SCOPE 1 · NEEDS-OWNER 10 — 107 claims (one table row = one claim; rows marked "(lab)" or "(blocked)" keep the verdict word that leads the cell).

## Apply items (for APPLY_PLAN.md)

| # | item | source § | size | risk | needs owner? |
|---|---|---|---|---|---|
| 2b-1 | Apply the six `SIMULATOR_TESTED` operation-capability claims from `tests/simulators/SIMULATOR_RESULTS.json` to the registry (`openwifi-uspot-uam`, `coovachilli-uam`: redirectParse, authorizationHandoff, accountingNormalize; V2 keeps enforcement cells untouched); re-run `ecloud-db seed` / `registry-check` | §8.3 | S | low | no |
| 2b-2 | Add the partial unique index for live NAS identifiers of `external-portal-postback` / `mikrotik-hotspot` (closes the two-transaction race left in §15.1 L1); migration ≥ 050 (A6) | §15.1 | S | low | no |
| 2b-3 | Delete `legacyReplayKey` and the legacy `pf:replay` read path in `apps/api/src/internal/portal-store.ts` (24 h window expired 2026-10-11) | §13.1 L4 | S | low | no |
| 2b-4 | Confirm the `counter_wrap_32bit` anomaly reaches an operator-visible surface (audit/alert) now that `drain.ts` calls the quirks hook; otherwise wire it | §8.3 finding 5 | S | low | no |
| 2b-5 | Take the drain lock (or a dedicated DB slot) in the DB-backed simulator group to stop the double-processing flake | §8.3 finding 7 | S | low | no |
| 2b-6 | Reconcile `captive_portals.portal_type` with `nas_clients.adapter_key` (R-35 / OQ-15); coordinate with Lane 3 portal work | §9 OQ-15 | M | medium | yes (OQ-15 schedule) |
| 2b-7 | Aruba `url-hash-key` support — blocked on HPE documentation or a lab capture | §15 item 1 | M | medium | yes (source/lab) |
| 2b-8 | R-41 online-status connector (registered vs online APs) — design only, after the device-test phase | §2 R-41 | L | medium | yes (priority) |
| 2b-D1 | Doc fix: header status/date; §3 marked as the 2026-10-08 snapshot (adapters 9, permissions 112, migrations 049, portal routes); §6.3/§7.4/§8.1 counts (33 rows / 29 vendors / 21 planned); §5.3 Meraki exception; §8.3 findings 3 and 5 struck; B6/E4 secret path per D-056/D-061; "67 paths" | header, §3, §5.3, §6.3, §8.1, §8.2, §8.3, §14, §17 | S | none | no |

## NEEDS-OWNER questions (one line each)

1. OQ-16: confirm that source-only `VERIFIED_SUPPORTED` cells are shown as "Expected (source-verified, not device-tested)" and never as device-enforced until a lab test passes.
2. OQ-3/4/8 (+ Ruckus NBI): which Cambium model / firmware / cnMaestro deployment is installed; is cnMaestro EasyPass wanted at all; is Ruckus SmartZone NBI wanted and which version?
3. OQ-2: is Arabic (RTL) required in the release-1 captive portal, or does the Q77 English-only, RTL-ready default stand?
4. OQ-5/6/7: keep "tunnel required for third-party sites, no per-site fail-open", and which gateway hardware runs CoovaChilli 1.2.9 (may it be upgraded before DT-15)?
5. OQ-9…14 + Cycle B/D open items: when is the lab EZEAP/gateway available for DT-02…DT-24, and which third-party device or controller (Cambium, MikroTik, Teltonika, UniFi/Omada/Mist) is tested first?
6. Cycle A A5 / Cycle E: which certificate should FreeRADIUS present for opt-in EAP-TTLS, and is a public RADIUS exposure for Meraki Cloud wanted during the LAN-only pilot (D-043), from which Dashboard-published source ranges?
