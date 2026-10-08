# ECLOUD — Testing guide

Status: Phase 3 (M7, owner A9). Design sources: `TEST_PLAN.md`, `PHASE2_VALIDATION.md` §5–§6,
`MULTITENANCY.md` §5 (T-01…T-15), `SECURITY_ARCHITECTURE.md` §3 (S-01…S-10),
`docs/contracts/aaa-authorize.md`.

> **Automated tests never prove device behaviour.** Every device test DT-01…DT-24 is
> `REQUIRES_DEVICE_TEST` until a human runs it on real hardware and records the result in
> `PHASE2_VALIDATION.md` §5.4. No script, CI job or test in this repository marks a DT as
> passed, and none may be added that does (see [Device tests](#device-tests-dt-01dt-24)).

## 1. Layers

| Layer | Where | Runner | Needs | Skips when |
|---|---|---|---|---|
| Unit / component | `packages/*/src/**/*.test.ts`, `apps/*/src/**/*.test.ts` | Vitest (one project per workspace) | nothing | never |
| Package integration | `packages/db/src/integration.test.ts`, `apps/*/src/integration.test.ts` | Vitest + `describeIntegration()` | dev stack (postgres, redis) | `ECLOUD_TEST_DATABASE_URL` unset / DB unreachable |
| Tenant isolation | `tests/isolation/` | Vitest project `tests` | postgres | as above |
| Security (DB probes) | `tests/security/` | Vitest project `tests` | postgres | as above |
| AAA contract | `tests/aaa-contract/` | Vitest + real FreeRADIUS container + stub API | dev stack incl. `freeradius`, docker CLI | `ECLOUD_TEST_RADIUS` ≠ `1`, docker or the `freeradius` service unavailable |
| e2e | `tests/e2e/` (Phase 6: Playwright) | Vitest smoke today | built `apps/api/dist/main.js` + postgres | not built / DB unreachable |
| Device tests | `PHASE2_VALIDATION.md` §5 | humans in the lab | real EZEAP / gateway | always manual |

Execution order inside one Vitest run (`vitest.workspace.ts`, `sequence.groupOrder`):
group 0 = `@ecloud/db` (its schema suite drops and recreates `public`/`radius` in
`ecloud_test`), group 1 = every other workspace, group 2 = `tests/`. This removes the race
between the schema reset and suites that migrate or read concurrently.

With `ECLOUD_TEST_REQUIRE_INTEGRATION=1` (`npm run test:integration`, CI) an unreachable
database is a failure instead of a skip; with `ECLOUD_TEST_RADIUS=1` as well, a missing
FreeRADIUS container fails the aaa-contract suite.

## 2. Local commands

```bash
npm run dev:stack                       # postgres:16, redis:7, freeradius 3.2.10 (127.0.0.1 only)
export ECLOUD_TEST_DATABASE_URL=postgres://ecloud_platform:ecloud_dev_password@127.0.0.1:5432/ecloud_test
export ECLOUD_TEST_REDIS_URL=redis://127.0.0.1:6379/1

npm test                                # unit; every integration suite skips with its reason
npm run test:integration                # everything incl. isolation/security (fails if DB is down)
npm run test:isolation                  # tests/isolation + tests/security only
npm run test:aaa-contract               # ECLOUD_TEST_RADIUS=1, tests/aaa-contract only
ECLOUD_TEST_RADIUS=1 npm run test:integration   # everything incl. the FreeRADIUS contract
npm run test:coverage                   # coverage/ (v8)
bash scripts/check-no-secrets.sh        # secrets scan (also a CI job)
```

The aaa-contract suite binds the stub on the port of the container's `ECLOUD_INTERNAL_URL`
(dev default `host.docker.internal:3001`) so the running dev container is used unchanged:
**stop a locally running api internal listener first** (the suite fails with a clear message
if the port is taken). It never starts, stops, rebuilds or reconfigures containers.

Never run `npm run dev:stack:reset` / `docker compose down -v` to "fix" a test: it wipes the
shared dev volume. Tests never drop shared schemas; only the `@ecloud/db` schema suite resets
`ecloud_test` (by design, `migrateTestDatabase({ reset: true })`).

## 3. Environment variables (tests only)

| Variable | Used by | Default / derivation |
|---|---|---|
| `ECLOUD_TEST_DATABASE_URL` | all DB suites (platform role, BYPASSRLS, owner) | unset ⇒ DB suites skip |
| `ECLOUD_TEST_APP_DATABASE_URL` | RLS assertions as `ecloud_app` | `ECLOUD_TEST_DATABASE_URL` with user `ecloud_app` |
| `ECLOUD_TEST_RADIUS_ROLE_DATABASE_URL` | security suite, `ecloud_radius` probes | `ECLOUD_TEST_DATABASE_URL` with user `ecloud_radius` |
| `ECLOUD_TEST_REDIS_URL` | worker/api suites, e2e smoke | unset ⇒ Redis suites skip |
| `ECLOUD_TEST_REQUIRE_INTEGRATION` | `describeIntegration()`, aaa-contract | `1` ⇒ unavailable infra fails |
| `ECLOUD_TEST_RADIUS` | aaa-contract gate | must be `1` to run |
| `ECLOUD_TEST_RADIUS_DATABASE_URL` | aaa-contract accounting assertions (`radius.radacct_raw`) | `ECLOUD_TEST_DATABASE_URL` with the container's `RADIUS_SQL_DB` (dev: `ecloud`) |
| `ECLOUD_TEST_AAA_STUB_HOST` | aaa-contract stub bind address | `127.0.0.1` (macOS Docker Desktop), `0.0.0.0` on Linux (host-gateway) |
| `ECLOUD_TEST_COMPOSE_FILE` | aaa-contract `docker compose -f` | `infra/compose/docker-compose.dev.yml` |

The derived URLs rely on the dev/CI convention that every ECLOUD role has the same
obviously-fake password (`ecloud_dev_password`). Real deployments never use these variables.

## 4. Helpers (`@ecloud/testing`)

| Helper | Purpose |
|---|---|
| `describeIntegration()`, `probeIntegration()` | gate suites on the DB (skip with reason / fail when required) |
| `migrateTestDatabase()` | idempotent migrate + seed once per process (`reset` only for the db schema suite) |
| `withTwoTenants(platformPool)` / `seedTenantGraph()` | org A and org B, each with **one row in every table of `TENANT_SCOPED_TABLES`** (plus a shared username for T-06); random unique values, safe on a shared DB |
| `tenantTablesMissingFromGraph()` | coverage guard: a new tenant table without a row builder fails the isolation suite |
| `sqlProbe(db, sql, params)` | run one statement on a pg client **or** a Kysely transaction, return rows / rowCount / SQLSTATE instead of throwing |
| `expectNoRows()`, `expectDenied()` | assertions on probes (`expectDenied` = SQLSTATE 42501, optional message regex) |
| `startAaaStub()`, `buildAcceptPolicy()`, `buildRejectPolicy()`, `policyValue()` | contract stub of `/internal/aaa/authorize` + `/post-auth` (token check, accept / reject / unavailable / slow modes, request recording) |
| `getTestRadiusRoleDatabaseUrl()`, `withDatabaseUser()`, `withDatabaseName()` | per-role / per-database URLs |

## 5. What the suites cover

### 5.1 Isolation (`tests/isolation/`)

- `rls-matrix.test.ts` — generated from `TENANT_SCOPED_TABLES` (31 tables × 5 probes) plus
  every partition of the 6 partitioned tables, all as `ecloud_app` via `withTenant()`:
  own row visible / B's row and any foreign row invisible (T-09), zero rows without
  `app.current_org` (unset and empty) (T-10), cross-org UPDATE/DELETE affect nothing (T-02),
  INSERT for org B and UPDATE moving a row to org B rejected by RLS `WITH CHECK` / privileges
  (T-03), partitions forced + isolating when addressed directly; plus a catalog guard that
  the RLS-protected set equals `TENANT_SCOPED_TABLES`.
- `tenant-cases.test.ts` — T-01…T-12, T-14, T-15 at database level, BYPASSRLS only for the
  platform role, `withPlatform()` refuses the RLS connection and writes exactly one
  `platform:access` audit row.

### 5.2 Security (`tests/security/db-security.test.ts`)

S-06 (every table with `organization_id` has RLS enabled + forced + policy, partitions
included; the only public tables without RLS are `PLATFORM_TABLES` + `schema_migrations`),
S-05 (tenant work writes no `platform:access` rows; one `withPlatform()` = one row), S-10 DB
part, `ecloud_radius` boundary (no grants in `public`; `radius.radacct_raw` INSERT-only — no
SELECT/UPDATE/DELETE/TRUNCATE; `radius.nas_v` readable, `radius.nas` not), append-only
triggers on every partition and denial even for the owner, `ecloud_app` lacks
UPDATE/DELETE/TRUNCATE on append-only tables, no plaintext secret columns, migration
checksum drift + orphan detection before anything is applied.

### 5.3 AAA contract (`tests/aaa-contract/`)

Real FreeRADIUS 3.2.10 container, `radclient` inside it fed with
`infra/freeradius/test/*.txt`, stub API on the host: 200 PAP policy → Access-Accept with
`Session-Timeout`, `Idle-Timeout`, `Acct-Interim-Interval`, `WISPr-Bandwidth-Max-*`,
`ChilliSpot-Max-Total-Octets`, `Class`, literal `Reply-Message` (do_xlat:false); request
body/headers (`X-Internal-Token`, `X-FreeRADIUS-Section`, attribute objects, normalised
`Calling-/Called-Station-Id`, `ECLOUD-Packet-*`); post-auth body (`ECLOUD-Auth-Result`,
`ECLOUD-Decision`, `ECLOUD-Reply-Class`, no `User-Password`); wrong PAP credential → Reject;
401 → Reject with Reply-Message; 500 and > 1.5 s → Reject "AAA backend unavailable", no
post-auth (no fail-open); wrong shared secret → silently dropped, API never called (S-04,
transport part); accounting Start/Interim/Stop with retransmits → exactly one
`radius.radacct_raw` row per distinct packet, Gigawords folded.

### 5.4 Known gaps pinned as `it.fails` (turn into `it` when fixed)

None open. Closed in M8 (both tests are plain `it` now):

| Test | Gap | Fix |
|---|---|---|
| `tenant-cases` "T-15" | `roles` / `role_permissions` policies are `FOR ALL` with `USING (organization_id IS NULL OR = current org)`; DELETE checks only USING, so `ecloud_app` could delete platform role templates and their grants | migration 012: `RESTRICTIVE … FOR DELETE` guards (`organization_id = current org`); `tenant_isolation` stays the single permissive policy |
| `freeradius-rest` "T-A6" | a retransmitted accounting packet hit `ON CONFLICT DO NOTHING`, rlm_sql returned noop and FreeRADIUS sent **no Accounting-Response** | `sites-enabled/ecloud` accounting: `sql` then `if (noop) { ok }`; an INSERT failure still sends nothing |

## 6. API-level security / isolation tests expected from A5 (apps/api)

Not automatable at DB level; the API suites must add them (integration, supertest, two orgs
seeded with `withTwoTenants()`):

| ID | Test | Expected |
|---|---|---|
| T-01 | org-A admin `GET /api/v1/sites` | only A sites; count = DB rows of A |
| T-02 | org-A admin `GET /users/{id of B}` (and every `/{id}` route, generated from the router) | 404, never 403 |
| T-03 | `POST /policy_assignments` with B's `policy_id` (any FK of another tenant) | 404/422, no row (the DB does **not** stop cross-tenant FKs: RI checks bypass RLS) |
| T-04 | site-admin of A-1 reads sessions of A-2 | 404 / empty |
| T-05/T-06 | `/internal/aaa/authorize` from NAS of A with B-only username; same username in A and B from NAS of B | Reject + `auth_events` (`organization_id = A`); B's user accepted, A's `last_login` untouched. **Implemented (api integration "T-05")**: an unknown source claiming A's NAS-Identifier is rejected; B's NAS replaying A's Class in post-auth changes nothing |
| T-07 | voucher of A on B's portal | reject, `portal_login_attempts.reason = 'tenant_mismatch'` for B |
| T-08 | accounting drainer: foreign `acct_unique_id` from B's NAS | stored with `organization_id NULL`, flagged; A's session unchanged. **Implemented (worker integration "T-08")**: the drainer resolves the NAS only from `radacct_raw.packet_src_ip` (migration 014, written by FreeRADIUS from the authenticated UDP source); a spoofed NAS-IP-Address / Class or a row without `packet_src_ip` is stored unattributed |
| T-11 / S-08 | impersonating support: `PATCH /organizations/{B}`, `PATCH /administrators/{id}`, `POST /nas/{id}/secret:rotate` | 403/404, audit row with `impersonator_id` (note: `organizations`/`administrators` are platform tables without RLS and `ecloud_app` has DML on them, so this is enforced only by the API) |
| T-12 | webhook fan-out for an event of A | delivered only to A's webhooks; payload has no B ids. Delivery also re-checks webhook org = job org = envelope org, and the transport (`apps/worker/src/jobs/webhook-transport.ts`) refuses non-https and non-public targets with DNS pinning (SSRF; unit-tested) |
| T-13 | export job of A downloaded with B's token | 404 (no export table exists yet) |
| T-14 | API key of A with a read-only role calls `session:disconnect` | 403 + audit row |
| T-15 | custom role edited in A, template updated by platform | A's role unchanged; templates not writable via API |
| S-05 | count `platform:access` audit rows during a full tenant request suite | 0 |
| S-07 | webhook replay with `X-ECloud-Timestamp` older than 5 min | receiver reference rejects |
| S-09 | portal request with valid `nasid` of site A but `md` from site B's secret | generic error, no credential, `reason = 'md_mismatch'` |
| S-10 | worker Disconnect for a session of B while scoped to A | refused before send, no `session_actions` row |
| SEC | authn: Argon2id params, lockout 10/5 min, TOTP enforced for platform bindings (**implemented**: api integration "MFA is enforced…"), recovery codes single-use; CSRF (`Origin` / token); rate limits (login 10/5 min, API 600/min, portal per `nasid+mac`); `/internal` requires `X-Internal-Token` (constant-time, 401 without body); RFC 9457 errors leak no SQL/stack; every mutating call writes `audit_logs` in the same transaction; endpoint × role matrix generated from the permission catalogue | per `SECURITY.md` / `PHASE2_VALIDATION.md` §6.5 |

Lab-only: S-01…S-03 (overlay probes from a tenant WireGuard peer; DT-19/DT-20). S-04 also
needs the API half (`auth_events` row `error`) once tenant resolution exists.

## 7. Device tests (DT-01…DT-24)

All 24 are **REQUIRES_DEVICE_TEST**. None has been executed; none is automated; none may be
marked passed by code. They are recorded manually in `PHASE2_VALIDATION.md` §5.4
(results-recording template: DT, date, tester, model/firmware/schema, uspot variant, NAS
path, PASS/FAIL/PARTIAL/N-A, observations, evidence files without secrets, ledger IDs
resolved, decision affected). A result flips an adapter capability only through a reviewed
migration/seed that cites the evidence file (D-028), which re-runs unit/contract/integration.

| DT | Title | Status |
|---|---|---|
| DT-01 | Firmware inventory and uspot variant identification | REQUIRES_DEVICE_TEST |
| DT-02 | Per-SSID `rate-limit` semantics and re-push side effects | REQUIRES_DEVICE_TEST |
| DT-03 | RADIUS attribute capture (Access-Request / Accounting), all three NAS paths | REQUIRES_DEVICE_TEST |
| DT-04 | WISPr / ChilliSpot bandwidth honouring (uspot), iperf3 | REQUIRES_DEVICE_TEST |
| DT-05 | Session-/Idle-Timeout / Acct-Interim-Interval precedence, renderer defaults | REQUIRES_DEVICE_TEST |
| DT-06 | `ChilliSpot-Max-Total-Octets` termination and terminate cause | REQUIRES_DEVICE_TEST |
| DT-07 | Disconnect-Request via hostapd DAS | REQUIRES_DEVICE_TEST |
| DT-08 | CoA-Request behaviour (hostapd, TIP uspot, upstream uspot DAS) | REQUIRES_DEVICE_TEST |
| DT-09 | MAC authentication formats | REQUIRES_DEVICE_TEST |
| DT-10 | Dynamic VLAN from RADIUS (802.1X) | REQUIRES_DEVICE_TEST |
| DT-11 | UAM round trip on a NAT-mode captive SSID incl. mini-browsers | REQUIRES_DEVICE_TEST |
| DT-12 | Walled garden FQDN vs wildcard, pre-auth HTTPS | REQUIRES_DEVICE_TEST |
| DT-13 | Bridge-mode captive reachability (`uamip`), hybrid hotspot | REQUIRES_DEVICE_TEST |
| DT-14 | hostapd path: per-client rate and timeouts | REQUIRES_DEVICE_TEST |
| DT-15 | CoovaChilli gateway (EZEGATE 1.2.9): coaport, CoA, quota, garden | REQUIRES_DEVICE_TEST |
| DT-16 | Accounting-On/Off, lost carrier, stale sessions, hostapd accounting | REQUIRES_DEVICE_TEST |
| DT-17 | State / telemetry cadence to the controller | REQUIRES_DEVICE_TEST |
| DT-18 | WireGuard on the AP (topology B) | REQUIRES_DEVICE_TEST |
| DT-19 | Site gateway peer behind NAT: keepalive, MTU, UDP-blocked fallback | REQUIRES_DEVICE_TEST |
| DT-20 | RADIUS source IP through the tunnel, CoA reachability in NAT mode | REQUIRES_DEVICE_TEST |
| DT-21 | RadSec via `radius-proxy` / `radius-gw-proxy`, DAS pinning | REQUIRES_DEVICE_TEST |
| DT-22 | RADIUS failover, Status-Server health, dual-secret rotation | REQUIRES_DEVICE_TEST |
| DT-23 | Aggregate WAN QoS (optional) | REQUIRES_DEVICE_TEST |
| DT-24 | Secret exposure on the device and in controller state | REQUIRES_DEVICE_TEST |

The aaa-contract suite uses the DT-03/DT-16 attribute files with **placeholder** values; it
verifies FreeRADIUS ↔ ECLOUD wiring only and resolves no DT.

### 7.1 Measurement harness for DT-04 / DT-05 / DT-06 (`tests/device/`, Phase 7)

`tests/device/run.ts` scripts the iperf3 parts of DT-04 (WISPr/ChilliSpot rate, both
directions, ±10 %), DT-05 (Session-Timeout cut-off with continuous traffic; Idle-Timeout
before/after probes) and DT-06 (`ChilliSpot-Max-Total-Octets` cut-off vs quota + one 10 s poll
at the measured rate). One invocation runs one case of a lab profile
(`tests/device/profiles/lab.example.json`: lab description, iperf3 server, expectations — no
field can hold a secret) and writes `var/device-results/<DT>_<case>_<stamp>.json` (raw 1 s
samples, findings, proposed verdict, manual-observation slots such as Acct-Terminate-Cause) plus
a `.row.md` draft of the PHASE2_VALIDATION.md §5.4 row. The analysis rules are stated at the top
of `tests/device/harness/analyze.ts`.

- **Never PASS.** The output verdict is always `PENDING_HUMAN_SIGNOFF` with a *proposed*
  verdict (`PROPOSED_PASS` / `PROPOSED_FAIL` / `INCONCLUSIVE`); options such as `--pass`,
  `--verdict`, `--sign-off` are refused (exit 2). A human records the result in §5.4.
- **Dry run by default** with `tests/device/fake-iperf3.mjs` (no socket; output marked
  `DRY RUN — NOT EVIDENCE`, `evidence_usable: false`). `--live` additionally requires
  `ECLOUD_DEVICE_HARNESS_LIVE=1`; it is for the lab only and has not been run (no device in
  Phase 7).
- CI runs only the dry-run suite (`tests/device/harness.test.ts`).

```bash
npx tsx tests/device/run.ts --profile tests/device/profiles/lab.example.json --dt DT-04 --case u2
ECLOUD_DEVICE_HARNESS_LIVE=1 npx tsx tests/device/run.ts --live --profile <lab.json> \
  --dt DT-05 --case session-timeout-120 --login-offset-s 7
```

### 7.2 `openwifi-config` rate-limit fragment (export only)

`GET /api/v1/orgs/{orgId}/sites/{siteId}/openwifi-config/rate-limit-fragment?ssid=<name>`
(`policy:preview`; `&download=1` for the bare JSON file; admin: *SSID rate-limit export*)
resolves the site baseline (site assignments + organization default only), translates it with
the `openwifi-config` adapter and returns `interfaces[].ssids[{name, rate-limit{ingress-rate,
egress-rate}}]` in integer Mbit/s. It is validated with ajv 8 against the vendored
`packages/adapters/src/openwifi/schema/ucentral.full.json` (unmodified copy of ezecontroller
`src/schemas/ucentral.full.json` at 3d6719a, sha256 recorded in `UCENTRAL_SCHEMA_SOURCE` and
re-checked by the unit test). Nothing is pushed to any controller; `device_enforced` stays
false until DT-02 lab-validates the rate-limit keys.

## 8. Definition of Done traceability (status after Phase 3)

| DoD clause (README) | Automated evidence today | Device evidence | Status |
|---|---|---|---|
| real client connects through a supported device | — (fake-nas e2e is Phase 6) | DT-11, DT-13, DT-15 | NOT MET — device tests pending |
| authenticates through the intended flow | aaa-contract (rlm_rest ↔ stub, HTTP-code mapping, no fail-open) | DT-03, DT-09, DT-11, DT-15 | PARTIAL — contract only; real authorize logic and devices pending |
| receives the correct authorized policy | policy-engine / adapter unit + golden tests (packages) | DT-04, DT-05, DT-06, DT-10, DT-14 | PARTIAL — translation tested; enforcement unverified |
| actual bandwidth enforcement | cannot be automated | DT-02, DT-04, DT-06, DT-14, DT-15 | NOT MET |
| validated accounting records | aaa-contract rlm_sql dedupe + Gigawords folding + retransmit ACK; worker drainer integration (Start/Interim/Stop/Accounting-On, replay idempotency, attribution) | DT-03, DT-05, DT-16 | PARTIAL — devices pending |
| appears in admin session/usage views | — (API/UI phases) | DT-16, DT-17 | NOT MET |
| managed securely | isolation matrix (T-cases DB level), security probes (S-05/S-06/S-10 DB part), secrets scan, MFA enforcement, AAA/accounting tenant attribution from authenticated source only, webhook SSRF guard | DT-07, DT-22, DT-24 | PARTIAL |
| no fabricated / unverified integrations | adapter capability declaration tests (packages/adapters); this repo never auto-flips a DT | §5.4 results only | ENFORCED by process |

## 9. CI (`.github/workflows/ci.yml`)

| Job | What |
|---|---|
| `secrets` | `bash scripts/check-no-secrets.sh` (private keys, token formats, literal `password=`/`secret:`/`token` values, credentials in URLs, long opaque values; `.env.example` and obviously-fake `ecloud_dev_*`/`ecloud_ci_*`/placeholder values excepted; test files exempt from the assignment/URL rules) |
| `check` | `npm ci`, build, `typecheck` of `tests/`, lint, `format:check`, unit tests |
| `integration` | postgres:16 + redis:7 services; roles via `infra/compose/postgres-init/01_roles.sql` (`docker exec … psql`), `db:migrate`, `seed`, `npm run test:integration -- --coverage`, coverage artifact |
| `radius-contract` | builds and starts postgres + freeradius from the dev compose file (stub URL `host.docker.internal:3901`), migrates + seeds the `ecloud` DB, `npm run test:aaa-contract` with `ECLOUD_TEST_REQUIRE_INTEGRATION=1`; logs on failure; tears the ephemeral stack down |

## 10. L4 simulators (`tests/simulators/`, M11)

Design source: `MULTI_VENDOR_INTEGRATION_PLAN.md` §8.3 (SIM-01…SIM-18), §4 (evidence model).

> **Simulator evidence proves ECLOUD code behaviour, not hardware compatibility.** The simulated
> NAS is written from documented parameter lists (CAPTIVE_PORTAL_ARCHITECTURE.md §3.2/§3.3/§4/§7.3,
> PHASE2_VALIDATION V-054/V-070/V-071) and the FreeRADIUS accounting fixtures; it is not a device
> capture. A passing scenario may back `SIMULATOR_TESTED` only on the operation capabilities
> `redirectParse`, `authorizationHandoff`, `accountingNormalize` of `openwifi-uspot-uam` and
> `coovachilli-uam` — never an enforcement capability, never `LAB_VALIDATED`, never
> Disconnect/CoA (D-006).

| File | Scenarios | Runs in |
|---|---|---|
| `uam-redirect.test.ts` | SIM-01 valid signed redirect, SIM-02 forged/missing `md`, SIM-03 tampering, SIM-04 unknown NAS, SIM-07 public `uamip` + hostile `userurl`, SIM-08 byte-for-byte raw query | `npm test` |
| `handoff.test.ts` | SIM-09 PAP XOR (+ device-side decode, T and U/Coova) and CHAP reference vectors (computed externally with Python `hashlib`), SIM-15 VLAN / burst / quota > 4 GiB per degradation mode, SIM-16 Disconnect without mandatory attribute | `npm test` |
| `accounting.test.ts` | SIM-10 retransmit, SIM-11 out-of-order, SIM-13 Gigawords rollover, SIM-14 32-bit wrap (no negative/huge delta; anomaly `counter_wrap_32bit` with estimated lost bytes flagged by the report-only vendor quirks hook `VendorAdapter.accountingQuirks`, uspot TIP only) | `npm test` |
| `db.integration.test.ts` | SIM-05 cross-tenant, SIM-06 replay / TTL (NAS from real `nas_clients`, `SimBroker` stand-in for the Phase 6 broker), SIM-12 missing Stop + reaper, SIM-17 Accounting-On/Off, SIM-18 roaming + cross-tenant (real `drainOnce` / `reapSessions`) | `describeIntegration` (dev stack) |
| `results.test.ts` | registry check of `SIMULATOR_RESULTS.json` (claims ⊆ operation capabilities × the two adapters, each backed by PASS; promotion keeps validator V1–V12 green; V2/V1 negatives) | `npm test` |

Builders live in `@ecloud/testing` (`packages/testing/src/simulators/`: `buildUamRedirect`,
`referenceUamMd`, `referencePapEncode`, `deviceDecodePapTip`/`Upstream`, `referenceChapResponse`,
`SimAccountingSession`, `wireCounter`/`freeradiusFold`, scenario catalogue, results format).
They do not import `@ecloud/adapters`, so the simulator is a second implementation of the
documented formulas. Fixtures use only the fake secret `uam-test-secret-fake`.

Test-title convention: `SIM-NN [adapter-key] …`; `[DEFECT]` marks an `it.fails` pin of a code
defect the scenario exposed (turn into `it` when fixed); `it.todo` marks a BLOCKED check.

Recording the results file (after `npm run build`, dev stack up so the DB group runs):

```bash
ECLOUD_TEST_DATABASE_URL=postgres://ecloud_platform:ecloud_dev_password@127.0.0.1:5432/ecloud_test \
ECLOUD_TEST_REDIS_URL=redis://127.0.0.1:6379/1 ECLOUD_TEST_REQUIRE_INTEGRATION=1 \
  npx tsx tests/simulators/record-results.ts
```

Current recording (2026-10-08, run id `dafbef1e73f3be7aa4304183317ef009`): 55 passed, 0 failed,
0 todo; SIM-01…SIM-18 PASS for every adapter in scope; 6 claims (`redirectParse`,
`authorizationHandoff`, `accountingNormalize` × `openwifi-uspot-uam`, `coovachilli-uam`), none
withheld.

It runs the suite with the JSON reporter (excluding `results.test.ts`, which checks the previous
file) and writes `tests/simulators/SIMULATOR_RESULTS.json` (format `ecloud-simulator-results/v1`):
per-scenario result per adapter (`PASS | FAIL | DEFECT | BLOCKED | NOT_RUN`), the derived `claims`
(each with `proposedStatus: ECLOUD_SIDE_ONLY`, since V1 forbids `VERIFIED_SUPPORTED` with
`SIMULATOR_TESTED`) and the `withheld` claims with their blocking scenarios. The file is bound to
its run: `run.runId` (random) and `run.outcomesHash` = SHA-256 over the run id and the canonical
scenario outcomes; `checkSimulatorResults` rejects a file whose results were edited after recording
or copied from another run. It never edits the registry; the promotion is a separate orchestrator
step.

**`authorizationHandoff` evidence is PAP only.** ECLOUD's hand-off emits the PAP `password` (XOR)
form; the CHAP vectors in `handoff.test.ts` check the simulator's reference implementation only,
not ECLOUD code.

The DB group drives `drainOnce` with an in-memory cursor and no lock (production serialises the
drainer with `state.withLock`). Run it alone against `ecloud_test`: another process draining the
same database at the same time (e.g. a concurrent worker integration run) can process the same
`radacct_raw` rows twice and make SIM-12/17/18 flaky. Inside one `npm run test:integration` the
group ordering (worker in group 1, `tests/` in group 2) prevents the overlap.

Defects found by the simulators (all fixed; the tests are plain `it` now):

| Scenario / test | Defect | Fix |
|---|---|---|
| SIM-18 "colliding Acct-Unique-Session-Id from another tenant's NAS is never merged" (`db.integration`) | an authenticated org-B NAS that sends org A's `Acct-Unique-Session-Id` (NAS-controlled: `md5(Class, Acct-Session-Id)`) was merged into org A's session: counters overwritten, A's session stopped, records attributed to A (`drain.ts createSession`: `ON CONFLICT (acct_unique_id) DO NOTHING` then re-read without an organization check) | L3: `drain.ts` scopes session lookups to the NAS's organization (`ownedBy()`) and records the collision (`recordCollision()`) |
| SIM-07 hostile `userurl` (`uam-redirect`) | `safeUserUrl` accepted backslash forms that WHATWG URL normalises to a public host: `http:\\evil.example` → `http://evil.example/`, `https:/\evil.example/` → `https://evil.example/`, `http://evil\@x` → `http://evil/@x` | orchestrator: `packages/adapters/src/vendor/uam.ts safeUserUrl` refuses any raw value containing `\`; the three payloads are in SIM-07's `hostile` list |
