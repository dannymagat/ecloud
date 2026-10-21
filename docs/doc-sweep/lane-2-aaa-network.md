# Lane 2 — AAA, RADIUS, secrets, NAS pending/adoption (EZECLOUD)

**Coverage is partial and deliberately so. Read this before the merge.**

Lane 2 as assigned is 35 files / 792 KB (`du`, block-rounded; 735 KB by bytes). This report covers
**10 files / ~128 KB, read whole with evidence**. The other 25 are **not covered by me** and were
handed back at 21:49 for reassignment to Hermes via the owner. They are listed below so the
mechanical diff against `INVENTORY.md` shows the gap rather than hiding it.

Why: one session cannot read 792 KB end-to-end after a full working day, and sub-agents were not
available to me tonight (my operating rules allow the Agent tool only on the owner's own
instruction, a CLAUDE.md rule or a skill — not on a peer's or a project file's say-so). Ten files
with real citations are worth more to the apply plan than thirty-five with assertions.

Selection rationale: these ten are where today's work (D-050 … D-065, task 10, the Blocked write
path, the re-seal) makes my verdicts better than a fresh reader's.

### Covered (10)

- [x] `packages/vendor-api/README.md` — 7 claims — IMPLEMENTED 6, STALE-DOC 1
- [x] `packages/adapters/README.md` — 7 claims — IMPLEMENTED 4, STALE-DOC 3
- [x] `docs/NAS_PENDING_AUDIT_NOTES.md` — 14 claims — IMPLEMENTED 4, PARTIAL 2, MISSING 2, STALE-DOC 4, SUPERSEDED 2
- [x] `docs/AAA_SECRET_SEALING_V2_PROPOSAL.md` — 22 claims — IMPLEMENTED 11, PARTIAL 2, MISSING 3, STALE-DOC 3, SUPERSEDED 3
- [x] `docs/SECRETS_MANAGEMENT.md` — 13 claims — IMPLEMENTED 6, PARTIAL 1, MISSING 2, STALE-DOC 4
- [x] `docs/AAA_SECURITY.md` — 16 claims — IMPLEMENTED 7, PARTIAL 3, MISSING 3, STALE-DOC 1, SUPERSEDED 2
- [x] `docs/AAA_ARCHITECTURE.md` — 12 claims — IMPLEMENTED 7, PARTIAL 3, SUPERSEDED 2
- [x] `NAS_PENDING_ADOPTION_REQUIREMENTS.md` — 16 claims — IMPLEMENTED 6, PARTIAL 5, MISSING 3, SUPERSEDED 1, NEEDS-OWNER 1
- [x] `docs/NAS_PENDING_GAP_ANALYSIS.md` — 15 claims — IMPLEMENTED 9, PARTIAL 1, MISSING 2, STALE-DOC 3
- [x] `docs/contracts/aaa-authorize.md` — 12 claims — IMPLEMENTED 10, PARTIAL 1, STALE-DOC 1

### NOT covered by this report (25) — reassigned

`MULTI_VENDOR_INTEGRATION_PLAN.md` (160K), `docs/VENDOR_INTEGRATION_RESEARCH.md` (68K),
`AAA_ARCHITECTURE.md` (60K, root), `infra/freeradius/README.md` (44K),
`WIREGUARD_ARCHITECTURE.md` (44K), `NETWORK_INTEGRATION.md` (40K), `HERMES_AAA_AUDIT.md` (40K),
`docs/AAA_AUDIT.md` (28K), `ECLOUD_MULTI_VENDOR_HOTSPOT.md` (24K),
`docs/AAA_IMPLEMENTATION_PLAN.md` (20K), `docs/AAA_DEPLOYMENT.md` (16K),
`docs/AAA_TEST_RESULTS.md` (16K), `docs/AAA_COMPATIBILITY_MATRIX.md` (12K),
`infra/freeradius/test/README.md` (4K), and the 11 EZEControl UAM docs under
`/Users/danny/Project/EZEControl/docs/uam/` (60K total — all `OUT-OF-SCOPE` for apply by D-058,
worth reading only for EZECLOUD-side items, and the lowest-yield 60 KB in the lane).

## Roll-up for the merge

**Apply items (MISSING / PARTIAL), highest value first.** Sizes are my estimate, not the
Orchestrator's scale.

| # | Item | Source | Size | Risk | Depends on |
|---|---|---|---|---|---|
| L2-1 | Gate the authorize path on `is_adopted` — §8 requires "adoption is complete" and `aaa.ts` never reads it, so `NOT_ADOPTED` is advisory only | `NAS_PENDING_ADOPTION_REQUIREMENTS.md` §8 | S | **high** — changes who can authenticate; must default-allow existing rows | nothing; prerequisite for L2-2 |
| L2-2 | `nas_discovery_observations` table + platform-admin-only read; UI must distinguish "cannot see" from "nothing arrived" | same §6; `NAS_PENDING_GAP_ANALYSIS.md` §6 | M | medium | L2-1 |
| L2-3 | Bind the vendor-API envelope (S-2 is still open on `controllers.credential_secret_ref` and `vendor_api_credentials.secret_ref`) | `AAA_SECRET_SEALING_V2_PROPOSAL.md` purpose catalogue | M | medium | nothing |
| L2-4 | Revisit internal-listener TLS — that leg now carries PAP passwords **and** plaintext NAS secrets; `config.internalTls` already exists | `AAA_SECURITY.md` §2.5 / R1 | M | medium | owner on `INTERNAL_CLEARTEXT_ACK` |
| L2-5 | Route both auth paths through the shared `nas-eligibility` predicate (it exists but only the overview uses it) | `NAS_PENDING_AUDIT_NOTES.md` inconsistency 2 | M | medium | nothing |
| L2-6 | Renderer-equivalence test (v2 plaintext byte-identical to v1; `render.ts` output unchanged) — the one test that would prove the re-seal plaintext-preserving in CI | sealing proposal §7.11 | S | low | nothing |
| L2-7 | Assert the re-seal signals no reload (verified by inspection only today) | sealing proposal §7.12 | S | low | nothing |
| L2-8 | Fourth return value from `policyAvailabilityForSites` for `POLICY_DISABLED` | gap analysis §7 | S | low | nothing |
| L2-9 | `POLICY_UNAVAILABLE` — needs a resolution call that can fail, not a reachability query | gap analysis §7 | M | low | L2-8 |
| L2-10 | `OWNERSHIP_UNRESOLVED` — needs a query not requiring a live site; arguably a platform orphan report | gap analysis §7 | M | low | nothing |
| L2-11 | Provisioning state so adoption does not report Active on a database write alone | requirements §7 step 9 | M | medium | nothing |
| L2-12 | Per-NAS CoA rate limit (now that CoA actually works for sealed NAS) | `AAA_SECURITY.md` R7 | S | low | nothing |
| L2-13 | Review the decision cache against §10's "cache must not authorize revoked eligibility" | requirements §10 | S | medium | nothing |
| L2-14 | Trust Verified/Unverified on the NAS record (exists for access points only) | requirements §5 | M | low | L2-2 |

Unchanged pre-existing items I confirmed are still open, listed so the merge does not treat them as
new: dual-secret rotation window (F-P10-06), `data_encryption_key` key ring (F-P10-04), FreeRADIUS
SPOF, NAS hot-reload without restart, fixed minimum reject delay.

**Doc fixes.** `SECRETS_MANAGEMENT.md` header ("nothing applied on the VPS" — 20 secrets are
installed) and R2 ("clients.conf rendering does not exist yet" — it is the deploy gate); the two
contradicted security rules in `AAA_SECURITY.md` (§2.1 "no default secret", §4 S3 "minimum 32 random
bytes"); `NAS_PENDING_GAP_ANALYSIS.md` §6 ("the switch is currently off and the row does not exist"
— the owner enabled it at 13:03Z); `AAA_ARCHITECTURE.md` §1 ("no shared secrets live here" — the
rendered clients file contains them) and §6 (policy precedence is longer than user > group > site);
`packages/adapters/README.md` (five adapters documented, nine registered); the sealing proposal's
status line, its drifted line references, its single-trigger prescription and its `allowV1` design;
`aaa-authorize.md` §1 (second listener token) and its "keep both identical" drift.

**NEEDS-OWNER (3).**

1. For a newly adopted NAS, is the platform default an acceptable assignment, or must adoption
   require an explicit policy? (§7 says explicit assignment is the default and warns against
   treating an unrestricted global fallback as valid; D-055 now makes the fallback catch every
   unassigned NAS.)
2. Is `pilot.enc.yaml` in a private ops repository and current, or are the installed host files
   under `/opt/ecloud/secrets/` the only copy? (`SECRETS_MANAGEMENT.md` §2 assumes the sealed half.)
3. Is the pilot's `freeradius` image pinned by SHA256 digest rather than a mutable tag?
   (`AAA_SECURITY.md` §4 S8 requires it; I did not verify it and will not assert it.)

---

## `packages/vendor-api/README.md` (4 KB, read whole)

| Claim | Verdict | Evidence | Apply item? |
|---|---|---|---|
| One SSRF-safe HTTPS client in `http.ts` | IMPLEMENTED | `packages/vendor-api/src/http.ts` exists; package exports it | no |
| Per-request DNS resolution, every answer re-checked against the controller-kind address policy, connection pinned to the checked address | IMPLEMENTED | `http.ts` present and named as the single egress path; no second HTTP client in `packages/vendor-api/src` (`cli credentials errors http index mist omada rate-limit redirects ruckus sealed unifi`) | no |
| TLS always verified — system roots, pinned CA PEM, or pinned SHA-256 leaf fingerprint; no insecure mode | IMPLEMENTED | same file; no `rejectUnauthorized` escape present in the package surface | no |
| No redirects, one deadline per request, response size cap, per-controller token bucket | IMPLEMENTED | `rate-limit.ts` is the token bucket; `http.ts` holds the rest | no |
| Clients: `unifi.ts`, `omada.ts`, `mist.ts` (no outbound call), `ruckus.ts` (documented stub) | IMPLEMENTED | all four files present | no |
| Sealed credentials opened in-process only (`sealed.ts`, `credentials.ts`) | IMPLEMENTED | both files present | no |
| `sealed.ts` comment: the derived vendor-API key "can open vendor-API secrets and nothing else (NAS / UAM secrets use other purposes)" | IMPLEMENTED | TRUE as of today: `NAS_SECRET_PURPOSE = 'ecloud:nas:secret:v2'` (`apps/api/src/crypto.ts:171`), `UAM_SECRET_PURPOSE = 'ecloud:uam:secret:v2'` (`apps/api/src/internal/portal.ts:112`), vendor-API label `'ecloud:vendor-api:secret:v1'` — three distinct HKDF labels. **Was misleading before 750b6b2**, when NAS and UAM shared one label (finding S-1): the parenthetical's plural implied two purposes where there was one. Now accurate. | no | <!-- check-no-secrets: allow (purpose label / public fleet default, D-071) -->
| "Nothing in this package is device-tested" | IMPLEMENTED | consistent with D-028 and the `REQUIRES_DEVICE_TEST` posture; no device-test evidence exists in the repo | no |

**Doc fix candidate (1):** none blocking. Optional: note in `sealed.ts` that the NAS/UAM separation
became true only at 750b6b2 (S-1), so a reader of older history is not misled.

---

## `packages/adapters/README.md` (4 KB, read whole)

| Claim | Verdict | Evidence | Apply item? |
|---|---|---|---|
| "The five NAS adapters of `POLICY_ENGINE.md` §3" | **STALE-DOC** | `packages/adapters/src/registry.ts:14-22` registers **nine**: the five listed plus `generic-radius-8021x`, `mikrotik-hotspot`, `external-portal-postback`, `meraki-splash`. Added by Cycles D/E (D-044) after this README was written. | doc fix |
| The capability table covers the adapters | **STALE-DOC** | Same four adapters absent from the table, so the table under-reports supported hardware — including `meraki-splash`, which has its own renderer path (`apps/api/src/radius-clients/meraki.ts`) and deliberately different secret rules. | doc fix |
| "plus a small amount of shared code (`base.ts`)" | **STALE-DOC** | `packages/adapters/src/` also holds `enforcement.ts`, `evidence.ts`, `source-refs.ts`. | doc fix (minor) |
| "Nothing here sends packets; AAA does" | IMPLEMENTED | package has no socket/HTTP client; dispatch lives in `apps/worker/src/coa/` and FreeRADIUS | no |
| "Every declaration carries an `evidence` string" | IMPLEMENTED | enforced by the type, not convention: `packages/adapters/src/types.ts:56,66,73,80` each declare `readonly evidence: string` | no |
| "`capabilities.test.ts` encodes the expected VERIFIED set per adapter so a status cannot be upgraded without touching the test (D-028)" | IMPLEMENTED | `packages/adapters/src/capabilities.test.ts` exists, alongside `registry.test.ts`, `evidence.test.ts`, `golden.test.ts`, `enforcement.test.ts` | no |
| "`ChilliSpot-Max-*-Gigawords` (21–23) are missing from FreeRADIUS's `dictionary.chillispot` and **need** the EZECLOUD dictionary additions" | **STALE-DOC** (the need is met) | The additions exist and are deployed: `infra/freeradius/raddb/dictionary.ecloud:45` defines `ChilliSpot-Max-Input-Gigawords 21 integer`, with 22 and 23 alongside. The upstream gap is still real; the EZECLOUD side is built, so "need" should read "are provided by `infra/freeradius/raddb/dictionary.ecloud`". | doc fix |
| API surface: `getAdapter`/`listAdapters`/`listCapabilities` in `registry.ts`; `NasAdapter` methods in `types.ts` | IMPLEMENTED | both files present with those roles | no |

---

## `docs/NAS_PENDING_AUDIT_NOTES.md` (8 KB, read whole)

The file opens "Every claim below was traced in code; nothing is inferred from documentation."
That was true when written. **Every `path:line` citation in it has since drifted**, and four of its
proposals were built differently from what it proposes — mostly today. It is the most
out-of-date file of the ten, and also the most useful, because its gap list is what got built.

| Claim | Verdict | Evidence | Apply item? |
|---|---|---|---|
| §8: a direct RADIUS request cannot bypass a gate the portal applies; the check exists in a different place | IMPLEMENTED | The `tenant_inactive` gate is real and inside the decision transaction: `apps/api/src/internal/aaa.ts:786` throws `Reject('tenant_inactive', …)`; `siteState` at `aaa.ts:461`; `decide()` at `aaa.ts:698`; single authorize route at `apps/api/src/app.ts:235`. | no |
| Cited lines for that gate: `aaa.ts:685` (`decide`), `aaa.ts:769-772` (the check), `aaa.ts:448` (`siteState`), `app.ts:230` (route), `nas-lookup.ts:72-84` (`byNasid`) | **STALE-DOC** | All five have drifted: `aaa.ts:685` is a closing brace, `:769-772` is now `observeAccessPoint(`, `:448` is a `verifyPassword` default, `app.ts:230`→`235`, `byNasid` is `nas-lookup.ts:101`. Substance holds; every citation is wrong. | doc fix |
| Portal and RADIUS resolve a NAS by different rules (portal joins `sites`+`organizations`, RADIUS does not) | IMPLEMENTED | still the shape of the two functions | no |
| Inconsistency 1: portal says `unknown_nas` where RADIUS says `tenant_inactive`; both should say `tenant_inactive` | IMPLEMENTED (today) | Done in `1833b9b`: `resolvePortal` returns a discriminated `PortalResolution` carrying `PortalRefusal` = `NasRefusalReason \| 'adapter_mismatch' \| 'no_portal'`, aligning the portal's reason with the code `aaa.ts` already used. | no |
| Inconsistency 2: extract a shared `assertNasEligibility(trx, nas)` called by **both** portal resolution and RADIUS authorization | **PARTIAL** | A shared module exists — `packages/shared/src/nas-eligibility.ts`, exported via `packages/shared/src/index.ts` — but its consumers are `apps/api/src/routes/access-points-page.ts` and `apps/admin/src/features/access-points/data.ts`, i.e. the overview/UI state. Neither `internal/aaa.ts` nor `internal/nas-lookup.ts` calls it, so the two auth paths still carry their own predicates. | **apply: route both auth paths through the shared predicate** |
| §5 lifecycle: store `is_adopted`, `is_blocked`, `block_reason` on `nas_clients` | **SUPERSEDED** | `is_adopted` and `block_reason` exist (migration 046). `is_blocked` deliberately does NOT: the state is `status = 'blocked'`, because a boolean beside `status` lets the administrative state contradict itself — the reasoning is recorded at `packages/db/src/schema.ts:426`. Verified before the choice that every reader of `nas_clients.status` is a positive `= 'active'` comparison, so a new value fails closed. | doc fix (record the `status` choice) |
| Pending reasons: `NOT_ADOPTED`, `OWNERSHIP_UNRESOLVED`, `NO_POLICY`, `POLICY_DISABLED`, `IDENTITY_CONFLICT`, `BLOCKED`, `DISABLED` | PARTIAL | Which of these the list actually reaches is recorded in `f7a8b32` and `docs/NAS_PENDING_GAP_ANALYSIS.md`; not all seven are reachable from the data available to the overview. See that file's rows below. | no |
| §3.1 proposal: add `is_adopted boolean NOT NULL DEFAULT true` | IMPLEMENTED | migration `046_nas_adoption_blocked.sql`; `is_adopted: Generated<boolean>` at `packages/db/src/schema.ts:433` | no |
| §3.1/§3.3 proposal: add a `nas_discovery_observations` table for rate-limited unknown-client sightings | **MISSING** | No such table in `packages/db/migrations/` or `packages/db/src/schema.ts`. Unknown clients still return 404 no-body and leave no record. | **apply: discovery observations table + platform-admin-only read** |
| §3.4 proposal: `GET /api/v1/orgs/:orgId/nas/pending` | **SUPERSEDED** | No such route, deliberately: Pending is a filter on the existing overview endpoint (`status=blocked` is filterable at `apps/api/src/routes/resources.ts`), because a second endpoint would be a second definition of the same question. A separate endpoint remains justified **only** for discovery observations, whose permission boundary differs (platform-admin, no tenant). | doc fix |
| §3.4 proposal: `POST /nas/:id/adopt` setting `is_adopted`, creating the assignment, one transaction, reload | IMPLEMENTED | `0b3baec` / `906e285` (EZECLOUD1): route in `apps/api/src/routes/access-points-page.ts`, `forUpdate` read, 409 `nas-blocked` when the NAS is blocked (§5's adoption prohibition) | no |
| §3.4 proposal: `POST /nas/:id/block` and `unblock` | IMPLEMENTED | `b7e4f53`: both routes in `apps/api/src/routes/resources.ts`; `reason` required; unblock restores `disabled`, never `active` (§11's no-silent-re-enable) | no |
| "Uses existing permissions (`nas:read`, `nas:update`, `nas:create`)" | **SUPERSEDED** | Both actions got their own permission precisely so `nas:update` does not confer them: `nas:adopt` (046) and `nas:block` (`b7e4f53`, catalogue 112). D-057 extends the same reasoning to `nas:secret:fleet_default`. | doc fix |
| §3.2: "no applicable policy … fails silently at authorize time with `no_policy`; the NAS does not indicate in the inventory that it is missing a policy" | IMPLEMENTED | `policyAvailabilityForSites` (`apps/api/src/policy-availability.ts`, `76fc0e5`) is the single definition of "could a policy resolve here", consumed by the overview; `apps/api/src/policy-availability.integration.test.ts` pins the organization-default case a naive version gets wrong. | no |

---

## `docs/AAA_SECRET_SEALING_V2_PROPOSAL.md` (16 KB, read whole)

Written by ezecloud-2a as a proposal; **I implemented it today**, so this is the one file where my
verdicts rest on having built the thing. It was an unusually good spec — §2's AAD composition and
§4's "required parameter, no default" went in verbatim and the compiler then named every reader.
Three of its prescriptions were wrong in ways only building them revealed, and those are the rows
that matter.

| Claim | Verdict | Evidence | Apply item? |
|---|---|---|---|
| Header: "Status: PROPOSAL, not applied" | **STALE-DOC** | Applied and deployed: `750b6b2` (envelope + UAM), `4ce2167` (NAS sites + readers), `8aeda28` (label fix), `258884f` (re-seal CLI); live on vps-local, re-seal run recorded as D-054. | doc fix (mark applied, cite the shas) |
| S-1: `crypto.ts` and `internal/portal.ts` both hold `'ecloud:nas:secret:v1'`, so NAS and UAM secrets share one derived key | IMPLEMENTED (fixed) | Now `NAS_SECRET_PURPOSE = 'ecloud:nas:secret:v2'` (`apps/api/src/crypto.ts:171`) and `UAM_SECRET_PURPOSE = 'ecloud:uam:secret:v2'` (`apps/api/src/internal/portal.ts:112`); `crypto.test.ts` carries the tautology guard of §7.6 | no |
| S-2: `Envelope.encrypt` never calls `setAAD` | IMPLEMENTED (fixed) | `encryptBound`/`decryptBound` with `setAAD(aad(purpose, binding))` in `apps/api/src/crypto.ts` | no |
| Its own correction: AAD over identity alone does not stop rollback; a monotonic element is needed | IMPLEMENTED | `secret_version` in the AAD; migration 047 adds the columns and a no-decrease trigger | no |
| Line references: `crypto.ts:110`, `:71-75`, `:78-86`, `internal/portal.ts:102`, `bootstrap/tenant.ts:143-144`, `:213`, `:226`, `:245`, `:267`, `resources.ts:643`, `:792`, `portal-admin/routes.ts:1045`, `radius-client-lookup.ts:78`, `access-points-page.ts:455`, `load.ts:85`, `meraki.ts:220`, `portal.ts:254` | **STALE-DOC** | Every one has drifted — the four commits above rewrote all of these files. The document is a correct description of a tree that no longer exists. | doc fix |
| "The comment at `packages/vendor-api/src/sealed.ts:39` asserting that NAS / UAM secrets use other purposes is false today" + §1 "delete the false claim regardless of when the rest lands" | **SUPERSEDED** | It was false then and is **true now**, because the label split gave NAS, UAM and vendor-API three distinct purposes. I did **not** delete it: following that instruction after the split would have removed an accurate comment. The instruction was correct when written and became wrong by being carried out late. | doc fix (strike the instruction) |
| Purpose catalogue is the whole set; only the first two collide | IMPLEMENTED | The five constants still exist with those roles; CHAP and retransmit remain KV-scoped and out of scope | no |
| `VENDOR_API_SECRET_PURPOSE` "carries S-2 and not S-1 … should get the same treatment in a separate change" | **MISSING** | Still no AAD on `controllers.credential_secret_ref` or `vendor_api_credentials.secret_ref`; both remain v1 (`cycle-a.integration.test.ts:610`, `multivendor.integration.test.ts:111` assert `^enc:v1\.`). S-2 is therefore still open on two columns. | **apply: bind the vendor-API envelope (S-2, separate change as the proposal says)** |
| §2: AAD = version, purpose, organizationId, rowId, column, secretVersion; mutable columns deliberately excluded | IMPLEMENTED verbatim | `aad()` in `apps/api/src/crypto.ts`; `nas_ip`/`site_id`/`status`/`name` are not bound | no |
| §3: `secret_version` and `uam_secret_version` columns, NOT NULL DEFAULT 1 | IMPLEMENTED | `packages/db/migrations/047_secret_sealing_v2.sql` | no |
| §3: ONE shared `trg_secret_version_no_decrease()` trigger function guarding both tables | **STALE-DOC — the prescription is a defect** | Implemented as specified in 047 and it broke **every UPDATE to both tables**: PL/pgSQL resolves `NEW.<field>` before the `TG_TABLE_NAME` guard can short-circuit, so each table died on the branch written for the other (`record "new" has no field …`). Fixed by migration `048_secret_version_trigger_split.sql` — one function per table, `BEFORE UPDATE OF <column>`. Found by EZECLOUD1 on `ecloud_test` before it reached a server. | doc fix (the proposal must not be copied as written) |
| §3: permissive CHECK `^enc:v[12]\.` now, narrowed to `v2` in a follow-up | **SUPERSEDED (D-064)** | Never landed, deliberately. Narrowing would break `restoreReseal` (`apps/api/src/reseal/secrets.ts:245-249` writes the dumped `enc:v1.` refs back), destroying the rollback for a re-seal that had already run. Task #23 was then closed by the owner. | no |
| §4: pre-generate the NAS id with `newId()`; do **not** seal-then-update in `afterCreate` | IMPLEMENTED | `apps/api/src/routes/resources.ts` create hook; required a fix in shared code — `crud.ts` was overwriting any caller-supplied id, so the ciphertext was bound to an id the row never got (`a30df81`, and the id now comes from `hook.scratch`, not from request-derived values) | no |
| §4: rotation must bump `secret_version` in the same `UPDATE` | IMPLEMENTED | NAS rotate and UAM rotate both write ref and version in one statement | no |
| §4: bootstrap reuses one ciphertext for two rows; must seal once per row | IMPLEMENTED | each branch now seals its own; the reconcile path also raises the version, because bootstrap cannot tell whether the environment's secret differs without opening the stored one | no |
| §4: "give the binding a required parameter type with no default so a missing column is a compile error" | IMPLEMENTED, and it worked | adding the column to `PORTAL_COLUMNS` made the compiler name every reader in seconds; contrast the 2026-10-14 portal defect, which took a day | no |
| §5: dual read behind an `allowV1: true` flag passed by the DB-column call sites | **SUPERSEDED — the flag was the bug** | `allowV1` took a BOOLEAN when the real question was *which key to derive*. The purpose is the HKDF `info`, so a v1 ciphertext cannot be opened by a v2-purpose envelope at all: with the flag as specified, every pre-existing NAS and UAM secret became unopenable the moment the label moved. Caught on vps-local by the renderer reporting `DATA_ENCRYPTION_KEY opens none of the 1 sealed NAS secrets (wrong key?)` with an unchanged key. Replaced in `8aeda28`: `openNasSecret`/`openUamSecret` take the KEY, try `LEGACY_SECRET_PURPOSE` then the current label via the single `openV1Ref`, and `openBoundSecretRef` is v2-only and throws on v1. | doc fix (the proposal must not be copied as written) |
| §6 steps 1-3: deploy code first, dry run, then re-seal row at a time, idempotent and resumable, version NOT incremented | IMPLEMENTED | `apps/api/src/secret-reseal-cli.ts` with `--dry-run`, `--dump`, `--restore`, `--org`; version preserved deliberately | no |
| §6 step 3: optimistic `UPDATE … WHERE id = $id AND secret_ref = $old` | **PARTIAL (different, deliberately)** | Implemented as one transaction that takes the dump and does the writes together, so a concurrent rotation fails the run rather than being silently skipped — and makes "restore the dump" exactly true rather than approximately. The optimistic predicate would have left a partially re-sealed estate with a dump that no longer matched. | no |
| §6 step 4: the re-seal must NOT signal a reload; confirm `radius:clients:reload_pending` absent | IMPLEMENTED | `signalRadiusClientsReload` appears in `apps/api/src/reseal/secrets.ts` **only at line 15, in the header comment explaining why it is not called**; no import, no call, and none in the CLI | no |
| §6 step 5: verify zero `^enc:v1\.`, then tighten and remove `allowV1` | PARTIAL | The verify half was done on vps-local (dry run 2, updated 2, both refs `enc:v2` at version 1, renderer `clients 1 skipped 0`, portal login 200). The tighten half is closed by D-064. `allowV1` is gone for a different reason — it was removed as a defect, not as a cleanup. | no |
| Rollback: a `REVERSE_RESEAL` script that re-seals v1 | **MISSING — superseded in practice** | No such script. The shipped rollback is the dump plus `--restore`, which is strictly better: it writes back the exact prior bytes rather than re-deriving them, and "a rollback that has to be correct about cryptography is not a rollback". The dump from the production run is on the host at `/root/ecloud-reseal/`. | doc fix (replace the §Rollback section with the dump procedure) |
| §7 tests 1-6 (round trip, cross-row, cross-tenant, cross-column, rollback replay, label tautology) | IMPLEMENTED | `apps/api/src/crypto.test.ts`, 11 tests; plus three transplant cases through the renderer in `radius-clients.test.ts` | no |
| §7 test 7: "a v1 ref opens with `allowV1: true` and throws with it absent" | **SUPERSEDED** | The flag no longer exists. Replaced by the test that would actually have caught the outage: a fixture sealed under the **literal** string `'ecloud:nas:secret:v1'` rather than the constant, because a fixture built from the code under test agrees with it by construction. The original §7.7 test did exactly that and passed while production could open nothing. | doc fix |
| §7 test 9: "`bootstrap/tenant.ts` run yields two distinct ciphertexts for the two NAS rows" | **STALE-DOC (premise wrong)** | Bootstrap has exactly **one** `insertInto('nas_clients')`; the reuse was between the insert and the update branches of the *same* row, not two rows. The test as written cannot be built. Covered instead by the bootstrap reconcile test asserting the live row's ref is `enc:v2.` at version 2 and opens under that row's own binding. | doc fix |
| §7 test 11: renderer equivalence — v2 plaintext byte-identical to the v1 plaintext, `render.ts` output unchanged | **MISSING** | No such test. It is the one that would prove the migration plaintext-preserving in CI rather than by the production probe we relied on. | **apply: renderer-equivalence test** |
| §7 test 12: assert the re-seal leaves `radius:clients:reload_pending` absent | **MISSING** | Verified by code inspection only (no import, no call). No test asserts it, so a future edit could add a reload without failing anything. | **apply: assert no reload signal in the re-seal suite** |
| §7 test 13: constraint behaviour after tightening | SUPERSEDED (D-064) | tightening closed | no |
| §7 test 14: the `secret_version` trigger refuses a decrease | IMPLEMENTED | `packages/db/src/secret-version-trigger.integration.test.ts`, 4 tests, including both no-op UPDATEs that 047 alone broke | no |
| §8: for a NAS inheriting the public fleet default, none of this provides secrecy | IMPLEMENTED (unchanged, by decision) | Fleet default is a public constant by the owner's 2026-10-14 decision; D-051 exempts it from the renderer floor and `radius-clients/meraki.ts:144` deliberately refuses it. D-064 closed the `inherit:` sentinel work, so no NAS can be *marked* as inheriting it. | no |

---

## `docs/SECRETS_MANAGEMENT.md` (12 KB, read whole)

The runbook's mechanics are sound; its **status line and two findings are badly out of date**, and
one of them would mislead an operator in an incident. Highest-value doc fixes in the lane.

| Claim | Verdict | Evidence | Apply item? |
|---|---|---|---|
| Header: "nothing has been generated for, copied to or applied on the VPS (D-031)" | **STALE-DOC** | Secrets are installed and in use on vps-local. `sudo ls -1 /opt/ecloud/secrets/` returns 20 files (names only, no values read): `database_url`, `database_url_platform`, `data_encryption_key`, `ecloud_app_password`, `ecloud_platform_password`, `internal_api_token`, `internal_secret_token`, `mfa_encryption_key`, `otp_pepper`, `portal_state_secret`, `postgres_password`, `radius_sql_password`, `radius_status_secret`, `redis_conf`, `redis_password`, `redis_url`, `smtp_password`, `voucher_pepper`, plus `backup.env` and `backup-recipients.txt`. `internal_secret_token` was minted on the host tonight under D-061. | doc fix (status line) |
| `<NAME>_FILE` accepted for the listed 12 variables | **STALE-DOC** | `SECRET_FILE_VARIABLES` in `packages/shared/src/config.ts` now has **15**: the listed ones plus `INTERNAL_SECRET_TOKEN` (D-061), `SMTP_PASSWORD` and `OTP_PEPPER`. | doc fix |
| "`secrets.manifest` … the 11 primary secrets" | **STALE-DOC** | 13 non-comment entries in `scripts/secrets/secrets.manifest`, including `internal_secret_token`. | doc fix |
| Contract: no secret in git / images / `docker inspect` / logs; strong values in production | IMPLEMENTED | `.gitignore`, `.dockerignore`, `scripts/check-no-secrets.sh`, pino redaction in `packages/shared/src/logger.ts`, and the production floors in `packages/shared/src/config.ts` | no |
| "api/portal refuse dev defaults and values < 32 characters when `NODE_ENV=production`" | IMPLEMENTED, with one documented exemption | The dev-default loop and the 32-char floor are in `packages/shared/src/config.ts`. As of `7afd5fe` a process may declare `requireInternalApiToken: false` and skip both **for that one variable**; the worker does, because it has no reader for the shared token (D-061). Worth adding to the table so the exemption is discoverable. | doc fix |
| Tooling table (`generate.sh`, `validate.sh`, `seal.sh`, `unseal.sh`, `selftest.sh`) | IMPLEMENTED | all present under `scripts/secrets/` | no |
| "Neither tool [`sops`/`age`] is installed on the workstation or the VPS today" | NEEDS-OWNER | Not verified by me; the host now holds installed plaintext secrets under `/opt/ecloud/secrets/`, so whether the sealed ops-repository half of the design is actually in use is a question about the owner's process, not the code. **Question: is `pilot.enc.yaml` in a private ops repository and current, or are the host files the only copy?** | no |
| R2: "production `clients.conf` rendering does not exist yet (F-P10-07)" | **STALE-DOC** | It exists and is the normal operating path. `apps/api/src/radius-clients-cli.ts` renders into the `radius_clients` volume; `infra/vps-local/scripts/reload-radius.sh` runs it and restarts FreeRADIUS; D-050 records a render of `clients:1 skipped:0` and a RADIUS probe answered in 1.0 s; the renderer `--check` was run repeatedly today as the deploy gate. I could not list `/etc/freeradius/clients.d/` directly (`Permission denied` from my exec — consistent with the 0640 gid 101 design), so this rests on D-050 and today's gate output rather than a file listing. | doc fix |
| R2: "no dual-secret window yet — finding F-P10-06" | **MISSING** (unchanged) | Rotation still returns one new value and the device must be reconfigured; no overlap window exists. Still the honest state. | apply candidate (dual-secret window), unchanged |
| R2: rotation endpoints return the value once, audited, refused while impersonating (D-027) | IMPLEMENTED | NAS rotate and UAM rotate both do this; the UAM rotate additionally bumps `uam_secret_version` as of task 10 | no |
| R5: `data_encryption_key` has no key ring — "do not rotate in place" | **MISSING** (unchanged, and now more consequential) | Still no key ring. Task 10 raises the stakes: a sealed v2 ref is bound by AAD to its row **and version**, so a key rotation now invalidates every NAS and UAM secret exactly as before, and the re-seal CLI does **not** help — it re-seals under the same key. If a key ring is ever built, the re-seal tool is the natural vehicle (`--org` already scopes it). | apply candidate (key ring), unchanged |
| R8: "per account: disable + `mfa/reset` (D-038)" | **PARTIAL** | Both still exist, but there is now a third, better per-account action: `reset-platform-admin-password --email E --password-stdin` (`1592364`, D-059) sets a new password **and revokes every live session of that administrator** in one transaction, audited as `platform:password_reset`. R8 should cite it. Also worth recording that `admin_sessions` is where impersonation lives, so revoking an administrator's sessions ends any impersonation it held — there is no second table to sweep. | doc fix |
| §4: the worker gets only the derived `vapi1.` key and refuses to run with the master key present | IMPLEMENTED | `apps/worker/src/config.ts:127` detects `DATA_ENCRYPTION_KEY[_FILE]` and refuses; `config.ts:62` states "The worker never receives DATA_ENCRYPTION_KEY" as a decision | no |
| §4 rationale: the master key "also opens NAS / UAM secrets", so the worker must not have it | IMPLEMENTED, and reinforced since | That boundary is exactly why CoA had never worked for a sealed NAS (the worker cannot open `enc:` refs). Resolved by D-056/D-061: the worker fetches the opened secret from the api's internal endpoint using its **own** token, so the boundary holds and Disconnect works. | no |

---

## `docs/AAA_SECURITY.md` (12 KB, read whole)

Dated 2026-10-12, so it predates D-050 … D-065. Two of its **standing security rules are now
contradicted by approved decisions** — the most important findings in this lane, because a rule
that the system knowingly violates stops being a control and starts being noise.

| Claim | Verdict | Evidence | Apply item? |
|---|---|---|---|
| §2.1 "Per-NAS shared secrets … **No default secret.** New NAS registration required." | **SUPERSEDED (owner, 2026-10-14; D-051)** | A public fleet-default secret exists as a constant: `FLEET_DEFAULT_RADIUS_SECRET = 'ezeradsecret'` (`apps/api/src/radius-clients/render.ts:78`), and `isAcceptableSecret` (`:82`) exempts that exact value from the length floor so it renders. D-064 closed the `inherit:` marking work, so no NAS can be *marked* as using it, but a NAS whose secret IS that value renders and is counted by `fleetDefaultSecretCount`. | doc fix (state the exception and its blast radius) | <!-- check-no-secrets: allow (purpose label / public fleet default, D-071) -->
| §4 S3 "Never use a default or empty RADIUS shared secret. **Minimum 32 random bytes.**" | **SUPERSEDED twice** | (a) the fleet default is a deliberate public default; (b) the floor is not 32 bytes — `SECRET_RE = /^[A-Za-z0-9._~+/=-]{16,128}$/` (`render.ts:65`), and D-050 chose a **16-character** secret for the pilot NAS after the 12-char fleet default was refused by the renderer. The rule as written is violated by the pilot's own NAS. | doc fix (restate as: 16-char renderer floor, one documented public exception) |
| §2.1 Argon2id hashing, no cleartext passwords, no passwords in logs or RADIUS replies | IMPLEMENTED | `hashPassword`/`verifyPassword` in `packages/db/src/admin.ts` with argon2id and env-driven cost; pino redaction in `packages/shared/src/logger.ts` | no |
| §2.1 "Envelope encryption for secrets … NAS shared secrets, MFA keys stored encrypted" | IMPLEMENTED, strengthened since | Now v2 bound: AAD over organization, row id, column and a monotonic `secret_version` (task 10, migrations 047/048, re-sealed in production per D-054) | no |
| §2.2 Message-Authenticator required on every reply; CVE-2024-3596 addressed | IMPLEMENTED | `require_message_authenticator` with per-client overrides; the renderer emits `require_message_authenticator` and `limit_proxy_state` per client (`render.ts` `block()`) | no |
| §2.2 Source-IP NAS validation; NAS-Identifier secondary only; tenant never resolved from user-supplied identifiers | IMPLEMENTED | the dynamic lookup keys on `nas_ip` (`apps/api/src/internal/radius-client-lookup.ts`) and the portal's `byNasid` is a secondary path | no |
| §2.3 "CoA secret not on command line: written to 0600 tmpfile, `-S` flag, deleted after" | IMPLEMENTED | `apps/worker/src/coa/radclient.ts:8,116,125` — `mkdtemp`, `-S`, `rm`. **Note the source changed**: as of D-056 the secret is fetched from the api's internal endpoint per dispatch rather than resolved locally, so the tmpfile is now the last hop of a network fetch. | no |
| §2.3 "CoA tenant check: dispatcher `verifySessionOwner()` checks `session.organization_id == job.organizationId`" | IMPLEMENTED by structure, **evidence stale** | No function of that name exists. The guarantee is structural instead: the dispatcher reaches the session and NAS by join from the action row (`apps/worker/src/coa/dispatcher.ts:313-319`, `session_actions → sessions → nas_clients`, selecting `a.organization_id`), so a dispatch can only target the session its action names. Stronger than a comparison, but the cited function should be corrected. | doc fix |
| §2.5 "TLS for internal REST: PARTIAL … FreeRADIUS → API is HTTP on internal Docker network only" | **PARTIAL, and the exposure grew tonight** | Still unencrypted, and as of D-056/D-061 that same listener serves `GET /internal/nas/:id/secret`, which returns a **plaintext RADIUS shared secret**. It is guarded by its own token and refuses production cleartext unless `INTERNAL_CLEARTEXT_ACK=1`, which is set on the host — a knowing acceptance recorded in D-061, not a check. So the leg now carries both PAP passwords and NAS secrets. | **apply: revisit internal-listener TLS (`config.internalTls` already exists)** |
| §3 R1 (HIGH) TLS on rlm_rest → API unconfirmed | **MISSING** (unchanged, scope widened) | as above | apply candidate, unchanged |
| §3 R2 (HIGH) "adding a new NAS requires FR container restart; ~3 s of rejects" | **PARTIAL** | Rendering and reload tooling exist (`apps/api/src/radius-clients-cli.ts`, `infra/vps-local/scripts/reload-radius.sh`, D-PRE-2 reload signal), but `SIGHUP` does not reload clients, so a restart is still required — the remediation named (rlm_rest clients callback) was not taken. The outage window is real and unchanged. | apply candidate, unchanged |
| §3 R3 (HIGH) FreeRADIUS single instance (SPOF) | **MISSING** (unchanged) | one `freeradius` service in `infra/vps/compose/compose.pilot.yaml` | apply candidate, unchanged |
| §3 R5 (MEDIUM) timing: `dummyPasswordHash` reduces but does not eliminate the difference | PARTIAL (unchanged) | control present, fixed minimum delay not added | apply candidate, unchanged |
| §3 R7 (LOW) "no rate limit or tenant-level cap on CoA jobs enqueued" | **MISSING** (unchanged) | no `coaRateLimit`/`coa_rate` anywhere in `apps/worker/src`. More relevant now that CoA actually works for sealed NAS (D-056). | apply candidate, unchanged |
| §3 R8 (LOW) "Voucher HMAC key (`VOUCHER_HMAC_KEY`): no rotation runbook" | **STALE-DOC** | The variable is `VOUCHER_PEPPER` (in `SECRET_FILE_VARIABLES` and `secrets.manifest`), and a runbook entry exists — `docs/SECRETS_MANAGEMENT.md` R6, which states the real constraint: unused vouchers cannot be re-hashed, so open batches must be cancelled and re-issued. | doc fix |
| §4 S6 "No secrets in environment variables for production" | IMPLEMENTED | every secret-bearing variable has a `_FILE` form (15 in `SECRET_FILE_VARIABLES`) and the pilot compose uses only that form | no |
| §4 S2/S5/S8 (no public RADIUS port; CoA only to a verified port; pinned FreeRADIUS digest) | NEEDS-OWNER | S2 and S5 hold by configuration; I did not verify S8's digest pinning on the pilot image and will not assert it. **Question: is the pilot's `freeradius` image pinned by SHA256 digest rather than a mutable tag?** | no |

---

## `docs/AAA_ARCHITECTURE.md` (12 KB, read whole — 248 lines)

Dated 2026-10-12. The three-tier model and the flows are accurate. Two statements are wrong about
the deployed system in ways that matter for threat modelling, and the policy precedence is now
longer than documented.

| Claim | Verdict | Evidence | Apply item? |
|---|---|---|---|
| §1 Tier 2: "FreeRADIUS … **No user data, policy, or shared secrets live here**" | **PARTIAL — the secrets half is false as deployed** | The rendered clients file contains plaintext shared secrets by design: `apps/api/src/radius-clients/render.ts:95` emits `secret = '<plaintext>'` per client, and `RENDERED_HEADER` says so — "contains shared secrets (keep 0640, never commit, never print)". It lives in the `radius_clients` volume, which is deliberately excluded from backups for that reason. User data and policy genuinely do not live there. | doc fix (important for threat modelling) |
| §3: "`clients.d/ecloud-nas.conf` rendered on container start; restart required for changes" | PARTIAL | Rendered by a **separate one-shot** before FreeRADIUS starts (`apps/api/src/radius-clients-cli.ts` under the `radius` compose profile), not by the container itself; FreeRADIUS then mounts the volume read-only. "Restart required" is correct — SIGHUP does not reload clients. | doc fix (minor) |
| §4 Mode A "Shared secret: pre-shared key per NAS"; Mode B "per-NAS, 32+ random bytes" | **SUPERSEDED** | Same contradiction as `AAA_SECURITY.md` S3: the floor is 16-128 characters (`render.ts:65`), D-050 set the pilot NAS to 16, and a public 12-char fleet default is exempted by D-051. | doc fix |
| §6: "`resolve()` selects policy (user > group > site default)" | **SUPERSEDED / incomplete** | The engine has more layers than that, including two below "site": `LAYERS.organization_default` (`packages/policy-engine/src/resolve.ts:401,585`) and `LAYERS.platform_default` (`:420,967`, migration 043). The platform layer went from unreachable to live today — `loadResolutionInput` never loaded the row until `1097ebc`, and the owner enabled it on the pilot at 13:03Z (D-055, 10/10 Mbps, 1 day). A reader using this section would not know an unassigned NAS now gets a fallback policy. | doc fix |
| §1 three-tier split; all business logic in Tier 3 via rlm_rest | IMPLEMENTED | `/internal/aaa/authorize` is the single authorize route (`apps/api/src/app.ts:235`) | no |
| §2.1 PAP/MAB flow: resolve NAS by source IP → user by username+org → Argon2id → policy → attrs | IMPLEMENTED | matches `internal/aaa.ts` `decide()` (`:698`) and the `tenant_inactive` gate at `:786` | no |
| §2.3 captive-portal broker token `pc-<hex>`, single-use, short TTL | IMPLEMENTED | broker token store and single-use consumption in `apps/api/src/internal/` | no |
| §3 NAS-to-tenant resolution: source IP, then NAS-Identifier; never username or realm alone | IMPLEMENTED | dynamic lookup keys on `nas_ip`; `byNasid` (`internal/nas-lookup.ts:101`) is secondary | no |
| §3 RLS on all tenant tables, `ecloud_api` role filtered by `organization_id` | IMPLEMENTED | FORCE RLS with `tenant_isolation` policies; asserted by the schema suite | no |
| §7 accounting pipeline: `rlm_sql → radacct_raw → worker drain → accounting_records` (monthly partitions) + `sessions` upsert; counter wrap, duplicate suppression, stale sweep, Acct-On force-stop | IMPLEMENTED | worker drain suite covers the drain, reordered interims, duplicates and Accounting-On | no |
| §8 CoA: action row in `session_actions`, worker calls `radclient` with the secret in a 0600 temp file, parses ACK/NAK, retries, capability-checked before dispatch, off by default | IMPLEMENTED, with one change of substance | `apps/worker/src/coa/radclient.ts:8,116,125`. **The secret's origin changed**: since D-056 the worker fetches the opened secret from the api's internal endpoint per dispatch (it cannot open `enc:` refs itself and refuses the master key by design). Before that, CoA reported `unsupported` for every API-created NAS since 2026-10-07. | doc fix (document the fetch hop) |
| §5 identity routing and the `authType` values in the authorize reply | IMPLEMENTED (not re-verified in depth) | consistent with `docs/contracts/aaa-authorize.md`; I did not re-derive every `authType` value and am not asserting it | no |

---

## `docs/NAS_PENDING_GAP_ANALYSIS.md` (24 KB, read whole — 265 lines)

The most accurate document in the lane: its §6 settled decisions were implemented as written and
its §7 coverage table is honest about what does not work. **One central premise became true only
today, and one status statement is now wrong** — both about the platform default.

| Claim | Verdict | Evidence | Apply item? |
|---|---|---|---|
| §4 premise: "Policy resolution returns the platform default instead of nothing, so **`NO_POLICY` will almost never fire**" | **STALE-DOC — true only since today** | The premise was false when written and for the whole of 14-15 October: `loadResolutionInput` never loaded `platform_default_policy`, so `input.platform_default` was undefined on every production path and the migration-043 branch in `resolve.ts` was unreachable. Wired in `1097ebc` today. Until then `NO_POLICY` fired exactly as §5 specifies, and the documented divergence did not exist. | doc fix (date the divergence to `1097ebc`) |
| §6 "The switch is currently **off and the row does not exist** … so today every unassigned NAS is `missing`" | **STALE-DOC** | The owner enabled it on the pilot at 13:03Z today (D-055: `enabled = true`, 10000/10000 kbps, `session_timeout_s` 86400, `quota_daily_bytes` NULL). So an unassigned NAS is now `platform_default` → **Active with an advisory**, not Pending with `NO_POLICY`. The sentence inverts the current behaviour. | doc fix (highest priority in this file) |
| §6 "`policyAvailabilityForSites` is written on the policy-engine side" | **STALE-DOC** (location) | It lives at `apps/api/src/policy-availability.ts` (`76fc0e5`), not in `packages/policy-engine`. The intent — one definition, not a second engine — holds; the path is wrong. | doc fix (minor) |
| §6 the three-value precedence table (`assigned` / `platform_default` / `missing`), with the organization-default branch included | IMPLEMENTED exactly | `apps/api/src/policy-availability.ts`; the organization-default case is pinned by `policy-availability.integration.test.ts` ("reports assigned for an organization default with NO assignments at all"), which is the case the document warns is "easy to miss and loud when missed" | no |
| §6 "Blocked is a `status` value, not a boolean", with the compatibility claim verified by checking every reader | IMPLEMENTED | migration 046 widens the CHECK; `packages/db/src/schema.ts:426` records the reasoning; the write path (`b7e4f53`) sets `status = 'blocked'` with a required `block_reason` | no |
| §6 `block_reason` with a CHECK requiring it when blocked and forbidding it otherwise | IMPLEMENTED | migration 046; the block route supplies it and `unblock` clears it | no |
| §6 "`is_adopted boolean NOT NULL DEFAULT true` keeps adoption separate from administrative status" | IMPLEMENTED | `packages/db/src/schema.ts:433` | no |
| §6 "two of the six Pending reasons are not yet reachable" (`POLICY_DISABLED`, `POLICY_UNAVAILABLE`) | IMPLEMENTED (still true) | `policyAvailabilityForSites` still returns three values; nothing supplies the other two | apply candidates (as the doc says) |
| §7 coverage table: `NOT_ADOPTED` and `NO_POLICY` reachable; `IDENTITY_CONFLICT`, `OWNERSHIP_UNRESOLVED`, `POLICY_DISABLED`, `POLICY_UNAVAILABLE` not | IMPLEMENTED (accurate) | matches the shipped `nasEligibility` inputs; `f7a8b32` recorded it | no |
| §7 "`policy_evaluated` … is true in the shipped build" | IMPLEMENTED | `apps/api/src/routes/access-points-page.ts:194` (schema) and `:395` (`eligibility.policyEvaluated`) | no |
| §6 two UI obligations: render the advisory visibly, and distinguish `platform_default` from `assigned` | IMPLEMENTED | EZECLOUD1's `NasStateList` renders `ON_PLATFORM_DEFAULT_POLICY` as an advisory on an Active row (`51aaeda`), which is exactly the "working because a fallback caught it" case — and it now says something true, since the loader landed | no |
| §5 step 3: `blocked` in the CHECK + `nas:adopt` in the catalogue, one migration | IMPLEMENTED | migration 046; `nas:adopt` in `packages/shared/src/permissions.ts`. `nas:block` followed later (`b7e4f53`), taking the catalogue to 112 — the document predates it. | no |
| §5 step 4: Pending state and reasons on the existing overview endpoint plus a filter, rather than a new list endpoint | IMPLEMENTED | overview carries state and reasons; `status=blocked` is a filter on the existing NAS list (`apps/api/src/routes/resources.ts`) | no |
| §5 step 6: adopt-and-assign endpoint, transactional and idempotent | IMPLEMENTED | `906e285` / `0b3baec`: `POST /orgs/:orgId/nas/:id/adopt`, `forUpdate` lock, 409 `nas-blocked`, site-scoped assignment with `assigned_site_id` returned | no |
| §5 step 7 / §6 discovery: observation table, conditionally available, owned by the RADIUS side | **MISSING** | No `nas_discovery_observations` table. The blocking question is answered (the client-lookup endpoint is application code that can record before answering 404), so the work is unblocked and simply not done. | **apply: discovery observations table (unblocked)** |
| §6 "The UI must say which of the two it is" — empty because we cannot see, versus empty because nothing arrived | **MISSING** | No discovery surface exists, so the distinction cannot yet be made. Worth carrying into the apply item rather than discovering it at demo time. | folded into the above |
| §6 adopt-flow reconciliation must order live rows first (`(deleted_at is null) desc, created_at desc`) | IMPLEMENTED | the pattern is in `apps/api/src/bootstrap/tenant.ts` (`fea68cf`) and was used again today; the adopt endpoint locks with `forUpdate` | no |

---

## `NAS_PENDING_ADOPTION_REQUIREMENTS.md` (20 KB, read whole — 280 lines)

The owner's statement of what is wanted, so its rows are requirements and the verdicts are
implementation status. Most of §5 and §11 shipped today. **The largest real gap is in §8.**

| Claim (requirement) | Verdict | Evidence | Apply item? |
|---|---|---|---|
| §8 eligibility: new access requires that "**Adoption is complete**" | **MISSING** | `is_adopted` is **never read** in `apps/api/src/internal/aaa.ts` — the authorize path requires `status = 'active'` (`:273`, `:318`) and checks site/org validity (`:437`), but nothing consults adoption. A NAS with `is_adopted = false` would authenticate subscribers normally. Not a live hole — migration 046 defaults it to `true` and nothing creates a NAS with it false — but it means `NOT_ADOPTED` is **advisory only**, and it must be closed before any discovery/adoption flow can create unadopted rows. | **apply: gate authorize on `is_adopted` (prerequisite for discovery)** |
| §5 four states Pending / Active / Disabled / Blocked | IMPLEMENTED | `blocked` added to the status CHECK (046); Pending derived rather than stored; `b7e4f53` is the write path | no |
| §5 "Pending … New access authorization: **Denied**" | **SUPERSEDED (owner, 2026-10-14; D-055)** | An unassigned NAS now resolves the platform default and is **Active with an advisory**, not Pending-denied. The divergence is recorded in `docs/NAS_PENDING_GAP_ANALYSIS.md` §4 and became real only with `1097ebc` today. | no (documented divergence) |
| §5 "Blocked … automatic adoption prohibited" | IMPLEMENTED | `0b3baec`: adopt returns 409 `nas-blocked` with the reason in the detail, checked after the permission test and before `expect_site_id` | no |
| §5 "Blocked and Disabled must override any automatic activation. Restoring a policy must never silently unblock or re-enable a NAS." | IMPLEMENTED | derivation puts Blocked/Disabled ahead of every Pending reason; `unblock` restores `disabled`, never `active` (`b7e4f53`), so re-enabling is a second explicit act | no |
| §5 six Pending reasons, all applicable retained, stable primary | **PARTIAL** | Four reachable, two not (`POLICY_DISABLED`, `POLICY_UNAVAILABLE`); `OWNERSHIP_UNRESOLVED` unreachable structurally and `IDENTITY_CONFLICT` unevaluated. Full table in `docs/NAS_PENDING_GAP_ANALYSIS.md` §7. | apply candidates (3) |
| §5 "Represent trust verification separately as Verified or Unverified" | **PARTIAL** | Exists for access points — `nas_access_points.verified_at` + `verification_source` (028) — not for the NAS record itself. The vocabulary to reuse is in place. | apply candidate |
| §5 "Store adoption, administrative status and effective-policy eligibility separately"; "a policy loss must not erase adoption history" | IMPLEMENTED | `is_adopted` (adoption), `status` (administrative), policy availability computed per request | no |
| §6 discovery of unknown/unauthenticated sources, rate-limited, Unverified | **MISSING** | No `nas_discovery_observations` table. The blocking question is resolved (the client-lookup endpoint is application code and can record before answering 404), so this is unblocked work, not blocked work. | **apply: discovery observations table** |
| §6 "Unverified discovery visibility must be restricted to platform administrators" | **MISSING** | nothing to restrict yet; the permission boundary is the reason it needs its own endpoint rather than the tenant-scoped overview | folded into the above |
| §6 field list (observed source IP and reported NAS-IP-Address as separate fields, first/last seen, counts, trust indicator, …) | **PARTIAL** | The overview already returns adoption state, administrative state, Pending reasons and effective-policy source; the observation-specific fields depend on the missing table | folded into the above |
| §7 nine-step adopt flow, steps 1-7 (review, tenant/site within permissions, link or create, verify trusted client, select eligible policy, validate uniqueness/compatibility, commit with audit) | IMPLEMENTED | `906e285`/`0b3baec`: `forUpdate` lock, `expect_site_id` guard against a stale view, policy status checked (`policy.status !== 'active'` refused), audited | no |
| §7 step 9 "Activate only after required provisioning and policy checks succeed … do not report Active just because a database update succeeded"; Pending/Provisioning state | **MISSING** | No Provisioning state exists. Adoption commits and the NAS reads Active once the row is written; the `clients.conf` reload is signalled but its success does not gate the state. | **apply: Provisioning state gated on reload success** |
| §7 "Explicit policy assignment is the default for newly adopted NAS devices … Do not accidentally treat an unrestricted global fallback as valid assignment" | **NEEDS-OWNER** | In tension with D-055. `policy_id` on adopt is **optional** because `policy_assignments.target_type` has no NAS target (EZECLOUD1's finding: a policy can only be attached per-site, which affects every NAS at that site), and an unassigned NAS is now caught by the platform default — precisely the "unrestricted global fallback" §7 warns against. **Question: for a newly adopted NAS, is the platform default an acceptable assignment, or must adoption require an explicit policy?** | no |
| §11 management actions carry their own permissions; adoption is not `nas:update` | IMPLEMENTED | `nas:adopt` (046) and `nas:block` (`b7e4f53`), neither implied by `nas:update`; D-057 applies the same reasoning to `nas:secret:fleet_default` | no |
| §9 "Do not apply an Access-Request rejection handler indiscriminately to Accounting-Request, CoA or Disconnect" | **PARTIAL** (not re-verified tonight) | The accounting drain and the authorize path are separate code paths, which satisfies the shape; I did not trace each packet type's trust classification, and §9's "document which packet types produce discovery observations" cannot be answered until discovery exists. | no |
| §10 change table (policy removed → Pending, policy restored → re-evaluate, tenant removed → ownership reason, blocked → deny and preserve status, cache must not authorize revoked eligibility) | **PARTIAL** | The blocked/disabled and tenant-invalid rows hold. "Policy removed → Pending" now depends on the platform default being off (D-055). The cache row is unverified by me: `inputKey` in `apps/api/src/enforcement.ts` keys on per-session facts, and whether a revoked eligibility can authorize from cache deserves its own check rather than my assertion. | apply candidate (cache/version check review) |

---

## `docs/contracts/aaa-authorize.md` (20 KB, read whole — 202 lines)

The most accurate document in the lane after the gap analysis, and the one I would change least.
Its VERIFIED markers are honest and its FreeRADIUS-version caveats still hold. One claim is now
incomplete because the internal listener grew a second surface tonight.

| Claim | Verdict | Evidence | Apply item? |
|---|---|---|---|
| §1 "The API MUST compare `X-Internal-Token` with `INTERNAL_API_TOKEN` (constant-time) and answer `401` without a body" | IMPLEMENTED, but the section is now **incomplete** for the listener as a whole | Still true for `/internal/aaa/*`. As of D-061 the same listener also serves `GET /internal/nas/:id/secret`, guarded by a **different** credential (`INTERNAL_SECRET_TOKEN`, header `X-Internal-Secret-Token`), constant-time, 401 on mismatch and 503 when unconfigured — deliberately so a leak of the shared token cannot yield plaintext RADIUS secrets (owner's ruling, 2026-10-15). A reader of §1 would conclude the listener has one token. | doc fix (add the second token and its scope) |
| §1 "the token must not contain `%`, `"` or `\` (it is embedded in an xlat string)" | IMPLEMENTED | the shared token's alphabet is restricted to `[A-Za-z0-9_-]` in `packages/shared/src/config.ts`, which satisfies this by construction; `INTERNAL_SECRET_TOKEN` uses the same alphabet | no |
| §1 timeouts (authorize connect 1.0 s / request 1.5 s; post-auth 1.0 s), no retries from FreeRADIUS, API should be idempotent for a retransmit | IMPLEMENTED | retransmit cache keyed on the §2 facts with a short TTL (`RETRANSMIT_TTL_S`); single-use portal credentials are released/confirmed via post-auth | no |
| §2 request body shape: one JSON object keyed by attribute, `{type, value[]}` per attribute; named integers sent as names; octets as raw bytes in a JSON string; absent attributes omitted | IMPLEMENTED | the parser handles both integer forms and treats octets as presence checks only | no |
| §2.1 `ECLOUD-Packet-Src-IP-Address` is the **primary** NAS/tenant resolution key and `NAS-Identifier` is never used to select a NAS or tenant | IMPLEMENTED | `apps/api/src/internal/aaa.ts` resolves by source address; `NAS-Identifier` is consistency/logging only, and for Meraki the shortname is decisive instead | no |
| §3 rule 1: object form with `"do_xlat": false` is mandatory because the section-level setting is not honoured on 3.2.10 (VERIFIED, with the `%{User-Name}` expansion as evidence) | IMPLEMENTED | the reply builder emits the object form for every attribute; this is a server-version fact, not a code claim, and the version has not changed | no |
| §3 rule 2: `control:Auth-Type` one of PAP/CHAP/MS-CHAP/Accept; a 200 without it is rejected by FreeRADIUS | IMPLEMENTED | `aaa.ts` sets `control:Auth-Type` on every accept (the module header documents `Accept` for the self-verified path) | no |
| §3 rule 3: `ChilliSpot-*` names including EZECLOUD's additions 21-23; `CoovaChilli-*` names do not exist on the wire | IMPLEMENTED | `infra/freeradius/raddb/dictionary.ecloud:45` defines `ChilliSpot-Max-Input-Gigawords 21` with 22 and 23 alongside. Note `packages/adapters/README.md` still describes these as *needed* rather than provided — flagged in that file's table. | no |
| §3 rule 5: `reply:Class` is the ASCII string `ai:` + 32 lowercase hex of the session UUID; **do not** send raw UUID bytes (the `%{string:…}` xlat stops at the first NUL, ~5 % of UUIDs would collide) | IMPLEMENTED exactly | `apps/api/src/internal/radius.ts:59-61` — `` `ai:${sessionId.replaceAll('-','').toLowerCase()}` `` — set at `aaa.ts:890` and reused as `acct_unique_id` at `:909`; parsed back by `sessionIdFromReplyClass` | no |
| §4 status→outcome table, including `5xx`/timeout → `fail` → Access-Reject with **no fail-open** | IMPLEMENTED | matches `AAA_SECURITY.md` §2.3 "No fail-open"; the authorize handler returns 401 for policy rejections and lets a backend failure become a reject | no |
| §5 post-auth: credentials removed, `ECLOUD-Auth-Result` / `ECLOUD-Decision` / `ECLOUD-Reply-Class` added, answer `204`, used for `auth_events` and releasing the single-use credential | IMPLEMENTED | `aaa.ts:1074` consumes `ECLOUD-Reply-Class` via `sessionIdFromReplyClass` | no |
| Cycle E Meraki: shortname-only resolution, the shared source address never selects a tenant, extra reject reasons, cache keys include the shortname, accounting attributed by `packet_client_shortname` | IMPLEMENTED | the Meraki renderer path is separate (`apps/api/src/radius-clients/meraki.ts`) and deliberately uses the **raw** secret floor rather than the D-051 fleet-default exemption (`meraki.ts:138-144`), because a shared cloud source address makes the secret the only identifying control | no |
| "The same copy of this contract lives in `infra/freeradius/README.md`; keep both identical." | **STALE-DOC (drifted)** | The two are no longer identical: `docs/contracts/aaa-authorize.md` mentions `do_xlat` 23 times against 20 in the README, and `ECLOUD-Packet-Src-IP-Address` 6 times against 5. A duplication instruction that nothing enforces has drifted, which is the predictable outcome. `infra/freeradius/README.md` is in the 25 files I did not cover, so the *direction* of the drift is unverified — someone should diff the two sections and then either enforce the copy in CI or make one file the source and the other a link. | doc fix |
