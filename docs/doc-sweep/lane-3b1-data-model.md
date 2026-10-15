# Lane 3b-1 — data model (DATABASE_DESIGN.md, packages/db/README.md, packages/storage/README.md)

Date: 2026-10-15 · Reader: Hermes sub-agent · Branch: `feature/universal-aaa` (read-only)

Method: each file read end-to-end (`read_file`, full-file reads), then targeted verification against
`packages/db/migrations/001..049`, `packages/db/src/{tables,schema,retention,cli}.ts`,
`packages/storage/src/*`, and `DECISIONS.md` (grep only).

Migration inventory verified with one `ls`: **001..049 all present, no gaps**
(001_functions … 049_portal_registration_devices).

## Checklist

- [x] `DATABASE_DESIGN.md` — 25 claims: IMPLEMENTED 12, PARTIAL 4, STALE-DOC 7, MISSING 1, NEEDS-OWNER 2 (one row covers two)
- [x] `packages/db/README.md` — 26 claims: IMPLEMENTED 20, STALE-DOC 5, NEEDS-OWNER 1
- [x] `packages/storage/README.md` — 15 claims: IMPLEMENTED 14, NEEDS-OWNER 1

Totals: **66 claims** — IMPLEMENTED 46, PARTIAL 4, STALE-DOC 10, MISSING 1, NEEDS-OWNER 5.

---

## 1. DATABASE_DESIGN.md (59 KB, 439 lines, read in one pass)

Overall: the document's status header ("Status: **PROPOSED** … Nothing in this document has been
created on any host", line 3) is itself the biggest stale statement — §14/§14.1/§14.x already
record implementation, and migrations 001..049 exist. The design body (§1–§13) is substantially
built; the drift is that the doc stops describing reality at migration 026 while the repo is at 049.

| # | claim (short, section ref) | verdict | evidence (path:line / D-number) | apply item? |
|---|---|---|---|---|
| 1 | Header: "PROPOSED … nothing created on any host" (L3) | STALE-DOC | 49 migrations exist, `packages/db/migrations/001_functions.sql` … `049_portal_registration_devices.sql`; §14 of the same doc contradicts L3 | Doc fix: change status to IMPLEMENTED-with-deltas, point to §14 |
| 2 | PG16 target, uuid PK default `gen_random_uuid()` (§1 L13) | IMPLEMENTED | `packages/db/migrations/002_tenancy_rbac.sql`, uuid PKs throughout; no extension needed (§14 L396) | - |
| 3 | `timestamptz` everywhere + shared `set_updated_at()` trigger (§1 L15) | IMPLEMENTED | `packages/db/migrations/001_functions.sql`; `trg_wireguard_peers_updated_at` at `003_network.sql:93` | - |
| 4 | MAC columns typed `macaddr` (§1 L22) | IMPLEMENTED | `003_network.sql:34`, `004_subscribers.sql:108`, `006_captive_portal.sql:69`, `007_sessions_accounting.sql:21`, `028_multivendor_cycle_a.sql:50` | - |
| 5 | `citext` for emails (§1/§3.1 L118) | STALE-DOC (already self-corrected in §14 L396) | `grep -rln citext packages/db/migrations/` → only `001_functions.sql` (comment); implementation uses `text` + `lower()` unique indexes | Doc fix: fold §14 row into §3.1 so the table stops claiming citext |
| 6 | Secrets never stored, only `*_ref` + hashes (§1 L21) | PARTIAL | `*_ref` columns present; documented exceptions `mfa_credentials.secret_enc` (§14 L405) and sealed-secret machinery added later (`047_secret_sealing_v2.sql`, `048_secret_version_trigger_split.sql`) are not described in §1 | Apply (doc+model): describe the v2 sealing model in §1/§3 |
| 7 | ERD 2.1 tenancy/RBAC tables all exist (§2.1) | IMPLEMENTED | `packages/db/src/tables.ts:9-20` (`organizations`…`invitations`) | - |
| 8 | ERD 2.2/2.3 entities (network, subscribers, policy, sessions, accounting, portal) exist | IMPLEMENTED | `packages/db/src/tables.ts:8-68` — 60 tables in `ALL_TABLES`, including `wireguard_peers`, `policy_translations`, `usage_counters`, `auth_events`, `portal_login_attempts`, `webhook_deliveries` | - |
| 9 | "37 tables in `public`" after 011; "47 tables after 026" (§14 L414, L439) | STALE-DOC | `ALL_TABLES` now has **60** tables (counted from `packages/db/src/tables.ts:8-68`); migrations run to 049 | Doc fix: update counts, or state counts are asserted by `tables.test.ts` instead |
| 10 | ERD/§3 omit the multivendor registry, portal versioning, orders/payments, OTP, bandwidth profiles/access plans | MISSING (doc coverage) | tables present but undocumented here: `vendors`, `hardware_models`, `firmware_versions`, `compatibility_entries`, `controllers`, `vendor_api_credentials/sessions`, `nas_access_points`, `otp_codes`, `bandwidth_profiles`, `access_plans`, `orders`, `payment_events`, `portal_assets/terms_versions/versions/registrations`, `terms_acceptances`, `device_registrations`, `session_enforcement`, `accounting_anomalies` (`packages/db/src/tables.ts:22-57`) from migrations 019,021-022,028-032,035-038,040,045,049 | Apply (L): add §3.8 "post-Phase-4 tables" + refresh ERDs (19 tables) |
| 11 | `usage_counters.period_type ∈ daily/monthly/total` (§3.5 L174) | STALE-DOC | widened to include `weekly` — `036_quota_periods_time.sql:33-35`; original at `007_sessions_accounting.sql:179` | Doc fix |
| 12 | Policy fields incl. weekly quotas, online-time, exhaustion action, `unlimited_fields` (§3.4 L158) | IMPLEMENTED | `036_quota_periods_time.sql:44-55`, `037_quota_exhaustion_action.sql`, `039_policy_unlimited_fields.sql` | - |
| 13 | `uq_nas_clients_ip (nas_ip) WHERE deleted_at IS NULL`, globally unique (§3.2 L138) | PARTIAL | `003_network.sql:131` as designed, but later work adds `027_nas_ip_unicast_host.sql` (IPv4-mapped normalisation) and per-vendor exceptions `032_meraki_cloud_radius.sql:111,114` | Apply (doc): document the uniqueness exceptions; relates to Q3 |
| 14 | `wireguard_peers` with global unique `public_key`/`tunnel_ip` (§3.2 L139) | IMPLEMENTED (but dormant) | `003_network.sql:65,90,91,92`; WireGuard deferred for the LAN pilot per **D-042** | - |
| 15 | Voucher `code_hash` + optional `code_enc` (§3.6 L185, Q4) | IMPLEMENTED | `005_policy_vouchers.sql:132` (`code_enc text`) | - |
| 16 | Append-only enforced 3 ways: grants, `forbid_mutation()` trigger, partition drop (§3.5 L178) | IMPLEMENTED | `001_functions.sql:19`; grants in `010_rls_and_grants.sql` | - |
| 17 | RLS on every tenant table, FORCE, `app.current_org` GUC; platform via GUC (§8 L305-321) | STALE-DOC | implemented as `enable_tenant_rls()` (`001_functions.sql:31`) + separate BYPASSRLS platform connection; §14 L397 says the GUC form is deliberately **not** used — §8's SQL block still shows the rejected design | Doc fix: replace §8 snippet with the implemented policy |
| 18 | Monthly RANGE partitions created ahead by job; default partition (§5 L249) | IMPLEMENTED | `ensure_month_partitions()` `001_functions.sql:61-94` (re-applies RLS to new partitions), invoked at `005:255`, `006:82`, `007:99`, `007:129` | - |
| 19 | Retention: accounting 13 months, audit 24 months, auth_events/portal/translations 90 d, webhooks 30 d (§5 L248) | PARTIAL | `packages/db/src/retention.ts:3` implements accounting 13 months / audit 24 months per **D-025** (which also sets RADIUS raw staging 7 days); the 90-day and 30-day classes are not visible in `retention.ts` | Apply (S): confirm/implement 90-day (auth_events, portal_login_attempts, policy_translations) and 30-day (webhook_deliveries) pruning |
| 20 | `radius` schema with `radacct_raw`, `radpostauth_raw`, NAS view, role `freeradius` (§4.2) | PARTIAL / superseded names | `packages/db/src/tables.ts:73-76` → `radius.radacct_raw`, `radius.radpostauth_raw`, `radius.nas` (a **table**, not `nas_v`); role renamed `ecloud_radius` (§14 L399) | Doc fix: §4.2 item 3 still speaks of `nas_v`/`freeradius` |
| 21 | Hybrid (c) `rlm_rest` + `rlm_sql` recommended (§4.2 L228) | IMPLEMENTED (direction) | drain-from-`radacct_raw` model is the one built (§14.1, D-025 7-day staging) | - |
| 22 | First platform admin via CLI, no credentials in migrations (§9 L340, §14 L411) | IMPLEMENTED | `packages/db/src/cli.ts:12,49,65` (`create-platform-admin --email … --password-stdin`) | - |
| 23 | §14 L412 open infra item: `GRANT CREATE ON DATABASE … TO ecloud_platform` in `01_roles.sql` | NEEDS-OWNER | still listed as "open item for infra" in the doc; not verified in this lane (infra lane owns `01_roles.sql`) | Question: is the dev-DB `CREATE` grant done, or still open? |
| 24 | Size estimates / pilot VPS fit (§6) and backup plan (§10) | NEEDS-OWNER / out of this lane | §6 explicitly "to be replaced with pilot measurements"; §10 pilot `pg_dump` plan is an ops-lane claim | Question: are pilot measurements available to replace §6? |
| 25 | Open questions Q1–Q7 (§12) still open in the doc | PARTIAL | Q3 partially answered by **D-042** (LAN pilot, WireGuard deferred); Q5 answered by **D-025** (13/24 months, pilot defaults, regulatory REQUIRES_CLARIFICATION) | Doc fix: mark Q3/Q5 resolved with D-numbers |

---

## 2. packages/db/README.md (11 KB, 181 lines, read in one pass)

Overall: the most accurate of the three. Drift is numeric (table/permission counts) and one
grant-table name. 26 claims (#26-#51): IMPLEMENTED 20, STALE-DOC 5, NEEDS-OWNER 1.

| # | claim (short, section ref) | verdict | evidence (path:line / D-number) | apply item? |
|---|---|---|---|---|
| 26 | Layout table: every listed `src/*.ts` exists with the stated role (L10-21) | IMPLEMENTED | `packages/db/src/tenancy.ts:29,48,104` (`withTenant`/`withSite`/`withPlatform`), `partitions.ts:16` (`ensureMonthPartitions`), `admin.ts:66` (`createPlatformAdmin`), `tables.ts`, `migrate.ts`, `cli.ts` | - |
| 27 | Layout table is complete | STALE-DOC | undocumented modules now exist, e.g. `packages/db/src/enforcement.ts:19` (session-enforcement advisory locks `pg_advisory_xact_lock`), `retention.ts`, plus `admin.ts` extras `resetPlatformAdminPassword:162` / `setPlatformAdmin:239` not in the CLI line L14 | Doc fix (S): add `enforcement.ts`, `retention.ts`, and the admin reset/set subcommands |
| 28 | CLI verbs `migrate\|status\|baseline\|seed\|ensure-partitions\|create-platform-admin` (L14,L26-32) | IMPLEMENTED | `packages/db/src/cli.ts:12,49,65` | - |
| 29 | CLI connects via `DATABASE_URL_PLATFORM`, never prints credentials (`redactUrl`) (L35) | IMPLEMENTED | `cli.ts` / `migrate.ts`; no secret values inspected | - |
| 30 | Runner: filename regex, unique numeric versions, `schema_migrations(name PK, version, checksum, applied_at, applied_by, duration_ms, baselined)` (L40-41) | IMPLEMENTED | `packages/db/src/migrate.ts:183-189` | - |
| 31 | One transaction per file, recorded in the same transaction, stop on first failure (L42-43) | IMPLEMENTED | `migrate.ts` apply loop; asserted by `packages/db/src/migrate.test.ts:151` | - |
| 32 | sha256 LF-normalised checksum drift / orphans are errors, never auto-repaired (L44-45) | IMPLEMENTED | `migrate.ts` verification path; covered in `migrate.test.ts` | - |
| 33 | `-- ecloud:no-transaction` directive; `CONCURRENTLY`/`VACUUM` without it is refused (L46-49) | IMPLEMENTED | `migrate.ts:23` (`NO_TRANSACTION_DIRECTIVE`), `migrate.ts:132-133` (refusal message) | - |
| 34 | Session advisory lock `pg_advisory_lock(8120371001)` serialises runner/seed/admin (L50-51) | IMPLEMENTED | `migrate.ts:267` (`MIGRATION_LOCK_KEY`), value confirmed `8120371001` in built `dist/migrate.d.ts:4` | - |
| 35 | "Every file starts with `SET LOCAL lock_timeout = '5s'`" (L53) | STALE-DOC | `grep -c lock_timeout packages/db/migrations/001_functions.sql` → 1, but `grep -L lock_timeout packages/db/migrations/*.sql` lists files without it | Apply (S): either add the pragma to the stragglers or soften the claim; a runner-level `SET LOCAL lock_timeout` would make it true by construction |
| 36 | No extensions required; `citext` replaced by `lower()` indexes (L54) | IMPLEMENTED | consistent with DATABASE_DESIGN §14 L396; no `CREATE EXTENSION` in migrations | - |
| 37 | Three roles created out-of-band, migrations never create roles (L58-65) | IMPLEMENTED | `010_rls_and_grants.sql` grants conditionally on role existence (L132 pattern) | - |
| 38 | `ecloud_radius` gets `SELECT` on `radius.nas_v` (L65) | IMPLEMENTED | `009_radius_schema.sql:99` creates the view; `010_rls_and_grants.sql:132` grants it; `integration.test.ts:688` asserts `ecloud_app` gets 42501 on it | - (note: DATABASE_DESIGN §4.2 is the stale one here, not this README) |
| 39 | "`TENANT_SCOPED_TABLES`, 31 tables" (L67) | STALE-DOC | counted **49** entries in `packages/db/src/TENANT_SCOPED_TABLES` (`packages/db/src/tables.ts`); `PLATFORM_TABLES`/`DATA_TABLES` are now derived (`tables.ts`: `ALL_TABLES.filter(...)`), and `tables.test.ts:58,79` only assert the partition sums | Doc fix: drop the hard count or say "derived; see `tables.test.ts`" |
| 40 | RLS shape: ENABLE+FORCE, `tenant_isolation USING organization_id = NULLIF(current_setting('app.current_org', true),'')::uuid`, unset GUC ⇒ no rows (L69-78) | IMPLEMENTED | `001_functions.sql:31` (`enable_tenant_rls`), asserted in `integration.test.ts` (RLS / FORCE-on-owner cases) | - |
| 41 | `roles`/`role_permissions` template read + RESTRICTIVE delete guards from migration 012 (L79-83) | IMPLEMENTED | `012_*.sql` (`template_delete_guard`), T-15 | - |
| 42 | Partitions re-protected by `enable_tenant_rls` / `ensure_month_partitions` (L84-87) | IMPLEMENTED | `001_functions.sql:61-94` | - |
| 43 | Platform access is a separate BYPASSRLS connection, not a GUC; `withPlatform` refuses non-BYPASSRLS (L88-90) | IMPLEMENTED | `packages/db/src/tenancy.ts:84-89` (`SELECT rolbypassrls … WHERE rolname = current_user`, throws), audit action `platform:access` at `tenancy.ts:71` | - |
| 44 | `PLATFORM_TABLES` = organizations, administrators, admin_sessions, mfa_credentials, permissions, adapter_types (L91-92) | STALE-DOC | `PLATFORM_TABLES` is now computed as the complement of `TENANT_SCOPED_TABLES` over 60 tables, so the enumerated six are no longer the whole set | Doc fix: same as #39 |
| 45 | Append-only set = accounting_records, auth_events, audit_logs, portal_login_attempts, policy_translations, webhook_deliveries; grants + `forbid_mutation()` + DETACH/DROP retention (L121-127) | IMPLEMENTED | `001_functions.sql:19` (`forbid_mutation`), `010_rls_and_grants.sql`, `packages/db/src/retention.ts:3` (13/24 months per **D-025**) | - |
| 46 | PG16 has no identity on partitioned tables ⇒ explicit `<table>_id_seq` (L132-133) | IMPLEMENTED | `007_sessions_accounting.sql` sequences | - |
| 47 | `radius.radacct_raw` dedupe key, `packet_src_ip` (mig 014) is the only tenant-resolution source, 7-day drain delete (L137-146) | IMPLEMENTED | `009_radius_schema.sql`, `014_*`; 7 days per **D-025** | - |
| 48 | "`PERMISSION_CATALOGUE`, 98 keys" (L152) | STALE-DOC | catalogue is built, not listed (`packages/shared/src/permissions.ts:314` `buildCatalogue()`), and the test only asserts `>= 60` (`packages/shared/src/permissions.test.ts:86`); 98 is unverifiable and likely drifted | Doc fix: drop the number or cite the test bound |
| 49 | `adapter_types` seeded with four keys, `verification_status='unknown'`, flags NULL (D-028, D-034) (L157-158) | IMPLEMENTED | `011_seed_adapter_types.sql:8-12` (`openwifi_ucentral`, `uspot`, `coovachilli`, `generic_radius`) | - |
| 50 | First Platform Super Admin via CLI, argon2id, min 12 chars, no default credentials (L159-161) | IMPLEMENTED | `packages/db/src/admin.ts:19,53,66` | - |
| 51 | Prereq: `GRANT CREATE ON DATABASE ecloud TO ecloud_platform` must be run once as superuser (L177-179) | NEEDS-OWNER | same open item as DATABASE_DESIGN §14 L412 | Question: has this been applied on the non-test `ecloud` database? |

---

## 3. packages/storage/README.md (7 KB, 116 lines, read in one pass)

Overall: the most faithful doc of the three — nearly every claim is backed by named code or a test.
15 claims (#52-#66): IMPLEMENTED 14, NEEDS-OWNER 1. No STALE-DOC, no MISSING.

| # | claim (short, section ref) | verdict | evidence (path:line / D-number) | apply item? |
|---|---|---|---|---|
| 52 | Storage abstraction per D-026, local for pilot non-critical assets, S3 in production, switch is config-only (`STORAGE_DRIVER`) (L3-5) | IMPLEMENTED | **D-026** at `DECISIONS.md:45` (APPROVED (design)); `packages/storage/src/factory.ts:16` (`createStorage(config)`) | - |
| 53 | `createStorage` is the only driver constructor; never import a driver class (L22) | IMPLEMENTED | `packages/storage/src/factory.ts:16`; drivers in `local-driver.ts` / `s3-driver.ts`, not re-exported for direct construction | - |
| 54 | `forTenant(storage, orgId)` with `put/get/delete`, meta `{key,size,contentType,sha256,lastModified}` (L13-19) | IMPLEMENTED | `packages/storage/src/tenant.ts:19,40` (`TenantObjectStorage`, `forTenant`) | - |
| 55 | Keys `org/{organizationId}/{purpose}/{id}`, lower-case uuid, id `[a-z0-9._-]` 1-128, no `..` (L26-31) | IMPLEMENTED | `packages/storage/src/keys.ts`; asserted `keys.test.ts:16,41,49,58` (incl. rejection of unregistered purpose `backups`) | - |
| 56 | Traversal/absolute/backslash/NUL/control chars rejected with `InvalidStorageKeyError` on every driver call (L33-34) | IMPLEMENTED | `packages/storage/src/errors.ts:9`; `keys.test.ts` negative cases | - |
| 57 | `assertOwnKey` / `assertKeyInTenant` reject cross-tenant keys; `list` only accepts the two org prefixes (L35-37) | IMPLEMENTED | `packages/storage/src/keys.test.ts:4-6` imports `assertKeyInTenant`, `buildObjectKey`, `parseObjectKey`; `tenant.ts:40` | - |
| 58 | Only purpose is `branding`: png/jpeg/webp, 5 MiB (L41-43) | IMPLEMENTED | `packages/storage/src/purposes.ts:21-24` (`allowedContentTypes` exactly those three, `maxBytes: 5 * MIB`) | - |
| 59 | Declared type must be allow-listed AND match magic bytes; SVG rejected; size enforced while reading; body buffered then SHA-256'd (L45-49) | IMPLEMENTED | `purposes.ts:83` (webp RIFF/WEBP sniff), `purposes.ts:63-66` (`maxBytes` tightening only), `packages/storage/src/upload.ts` | - |
| 60 | Interface: `put/get/head/delete/list/getSignedReadUrl/checkHealth/close`, TTL 1-3600 s default 300, `capabilities.signedReadUrls` (L53-55) | IMPLEMENTED | `packages/storage/src/types.ts:47-48,92-93,104-107`; `s3-driver.ts:70` (`signedReadUrls: true`) | - |
| 61 | Error → status map (400/404/413/415/501/503), cause never shown (L57-59) | IMPLEMENTED | `packages/storage/src/errors.ts:9,16,23,37,44,54` — all six classes present, extending `AppError` (RFC 9457) | - |
| 62 | local driver: `objects/<key>/<version>`, `meta/<key>.json`, `tmp/`; 0700/0600; `O_NOFOLLOW`; 1-hour tmp sweep; metadata-rename commit ordering (L68-78) | IMPLEMENTED | `local-driver.ts:34-36` (`DIR_MODE 0o700`, `FILE_MODE 0o600`, `O_NOFOLLOW`), `:61,101,106,304-306` (`tmpMaxAgeMs` sweep), tests `local-driver.test.ts:66-72,91,111,174` | - |
| 63 | local driver refused in production unless `STORAGE_LOCAL_ALLOW_PRODUCTION=true` (L83-85) | IMPLEMENTED | enforced in `loadConfig`, asserted `packages/shared/src/config.test.ts:82,103-108` | - |
| 64 | s3: SDK v3, checksums `WHEN_REQUIRED`, `x-amz-meta-sha256`, HEAD-404 confirmed with `HeadBucket`, bucket 404 ⇒ 503, signed URL pins type/disposition (L87-94) | IMPLEMENTED | `s3-driver.ts:63,65,81-82`; `s3-driver.test.ts:9,83,98` (`HeadBucketCommand`, `NotFound` 404 mapping) | - |
| 65 | "Serving objects" rule for future endpoints (Content-Type from metadata, `nosniff`, signed URLs only, cap HTTP body) (L96-103) | IMPLEMENTED | consumer exists: `apps/api/src/portal-admin/routes.ts:647,1388` (stored type + `X-Content-Type-Options: nosniff`), `preview.ts:15`, asserted `portal-admin.integration.test.ts:763-772`; `portal_assets` at `packages/db/src/tables.ts:51,131` | - (README's "future endpoints" framing is mildly stale: the rule is already honoured by portal-admin asset serving) |
| 66 | S3 contract verified only against RustFS (2026-10-08); AWS/R2/B2/Wasabi untested (L114-116) | NEEDS-OWNER | honest limitation; no RustFS reference found in code or `DECISIONS.md` (grep `rustfs` → no hits outside this README) | Question: which S3 provider will production use, so the contract can be run against it before go-live? |

---

## Apply candidates (ranked)

| rank | item | from | size | risk |
|---|---|---|---|---|
| 1 | Document the 19 post-Phase-4 tables (multivendor registry, orders/payments, OTP, bandwidth profiles/access plans, portal versioning/registrations, session_enforcement, accounting_anomalies) and refresh the ERDs in DATABASE_DESIGN §2/§3 | #10 | L | low (doc only, but large) |
| 2 | Implement/confirm the 90-day and 30-day retention classes (`auth_events`, `portal_login_attempts`, `policy_translations`; `webhook_deliveries`) alongside the existing 13/24-month rules | #19 | S | medium (data deletion — needs D-025 re-read + dry-run) |
| 3 | Make "every migration sets `lock_timeout = 5s`" true — add the pragma to the files missing it, or set it once in the runner | #35 | S | low |
| 4 | Describe the v2 secret-sealing model (migrations 047/048, `mfa_credentials.secret_enc`) in DATABASE_DESIGN §1/§3 so "no secrets stored" stops being contradicted | #6 | S | low |
| 5 | Document the `uq_nas_clients_ip` exceptions (IPv4-mapped normalisation 027, Meraki cloud-RADIUS 032) | #13 | S | low |
| 6 | Add `enforcement.ts` / `retention.ts` and the admin reset/set subcommands to the db README layout + CLI lines | #27 | S | low |

## Doc fixes (STALE-DOC)

1. `DATABASE_DESIGN.md:3` — status is still "PROPOSED … nothing created on any host" while 49 migrations exist (#1).
2. `DATABASE_DESIGN.md` §3.1 — citext claim; implementation uses `text` + `lower()` indexes (#5).
3. `DATABASE_DESIGN.md:414,439` — table counts 37/47; actual `ALL_TABLES` = 60 (#9).
4. `DATABASE_DESIGN.md` §3.5 L174 — `usage_counters.period_type` now includes `weekly` (036_quota_periods_time.sql:33-35) (#11).
5. `DATABASE_DESIGN.md` §8 L305-321 — shows the rejected `app.platform_access` GUC design; implementation uses a separate BYPASSRLS connection (#17).
6. `DATABASE_DESIGN.md` §4.2 — `nas_v` / role `freeradius` naming; actual role is `ecloud_radius` (#20).
7. `DATABASE_DESIGN.md` §12 — mark Q3 resolved by **D-042** and Q5 by **D-025** (#25).
8. `packages/db/README.md:67` — "31 tables" → 49 tenant-scoped (#39).
9. `packages/db/README.md:91-92` — `PLATFORM_TABLES` is now derived, not the listed six (#44).
10. `packages/db/README.md:152` — "98 keys" unverifiable; test asserts only `>= 60` (#48).

## Needs owner

1. Has `GRANT CREATE ON DATABASE ecloud TO ecloud_platform` been applied on the non-test database? (DATABASE_DESIGN §14 L412 / db README L177-179)
2. Are pilot measurements available to replace the DATABASE_DESIGN §6 size estimates and confirm the §10 backup plan?
3. Which S3-compatible provider will production use, so the storage contract can be run against it (only RustFS tested, 2026-10-08)?
4. Retention for the 90/30-day classes: is the current absence intentional (deferred) or a gap? (ties to apply item 2)
