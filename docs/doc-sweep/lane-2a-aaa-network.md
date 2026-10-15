# Lane 2a — AAA, network, WireGuard, vendors, FreeRADIUS, EZEControl UAM hand-off

- Lane: 2a (Lane 2 minus the ten files EZECLOUD covered in `lane-2-aaa-network.md`, minus `MULTI_VENDOR_INTEGRATION_PLAN.md` read by a sibling)
- Start: 2026-10-15T18:02Z (22:02 +04)
- End: 2026-10-15T18:21:28Z (+04: see wall clock)
- Repository: `/Users/danny/Project/EZECLOUD`, branch `feature/universal-aaa`, HEAD `86af9f30204c1006224b39d8bfeff8ce461e7cd1` (read on disk; other sessions active in the checkout, their files untouched)
- Chunked reads: `AAA_ARCHITECTURE.md` (60.6 KB, 2 chunks), `docs/VENDOR_INTEGRATION_RESEARCH.md` (67.0 KB, 2 chunks). All other files read whole.
- Host checks (vps-local, read-only): `docker ps` OK; `docker logs --since 1h ecloud-freeradius` OK (empty: no log lines in the last hour); SELECT-only SQL OK. Denied host checks: none. Note: `docker ps` at 18:05Z shows every ecloud container on image tag `0e8f735` (api/worker "Up About an hour"), not the 1592364/7afd5fe/d7795a7 tags the brief listed; recorded as observed, not investigated.
- Pilot facts used below: `schema_migrations` max 048 (48 rows; repo has `049_portal_registration_devices.sql` not yet applied); one NAS `d82d9ba1a1aa` at 192.168.203.238, adapter `openwifi-uspot-uam`, `enc:v2.` secret_ref v1, `is_adopted` true, `radsec_enabled` false, `coa_supported`/`coa_port` NULL, `require_message_authenticator` false; one portal (uspot, `enc:v2.`); `platform_default_policy` enabled 10000/10000 kbps, 86400 s; `nas_access_points` 7 rows, 1 verified; `radius.radacct_raw` 155 rows, `radpostauth_raw` 0, `accounting_records` 155; `radius.nas` empty; `wireguard_peers` 0; `otp_codes` 0; `session_actions` 0; `adapter_types` 12 keys all `verification_status = unknown`; administrators: `danny@ezelink.com` active ("Administrator"), `admin@ezecloud.local` disabled.
- Verdict rules applied: DECISIONS.md authoritative; EZEControl/controller/firmware/UI work = OUT-OF-SCOPE (D-058); no secrets printed (env/file names only).

## Checklist

- [x] `../EZEControl/docs/uam/README.md` — 6 claims, IMPLEMENTED 1, PARTIAL 0, MISSING 0, STALE-DOC 5, SUPERSEDED 0, OUT-OF-SCOPE 0, NEEDS-OWNER 0
- [x] `../EZEControl/docs/uam/01-state.md` — 9 claims, IMPLEMENTED 3, PARTIAL 0, MISSING 0, STALE-DOC 4, SUPERSEDED 0, OUT-OF-SCOPE 2, NEEDS-OWNER 0
- [x] `../EZEControl/docs/uam/02-root-causes.md` — 9 claims, IMPLEMENTED 1, PARTIAL 0, MISSING 0, STALE-DOC 2, SUPERSEDED 1, OUT-OF-SCOPE 5, NEEDS-OWNER 0
- [x] `../EZEControl/docs/uam/03-uam-flow.md` — 5 claims, IMPLEMENTED 4, PARTIAL 0, MISSING 0, STALE-DOC 0, SUPERSEDED 0, OUT-OF-SCOPE 1, NEEDS-OWNER 0
- [x] `../EZEControl/docs/uam/04-actions.md` — 8 claims, IMPLEMENTED 4, PARTIAL 0, MISSING 0, STALE-DOC 1, SUPERSEDED 1, OUT-OF-SCOPE 2, NEEDS-OWNER 0
- [x] `../EZEControl/docs/uam/DEPLOY_BOOTSTRAP_PLAN.md` — 10 claims, IMPLEMENTED 6, PARTIAL 0, MISSING 0, STALE-DOC 2, SUPERSEDED 1, OUT-OF-SCOPE 0, NEEDS-OWNER 1
- [x] `../EZEControl/docs/uam/PILOT_OBSERVATIONS_2026-10-15.md` — 5 claims, IMPLEMENTED 1, PARTIAL 1, MISSING 1, STALE-DOC 1, SUPERSEDED 0, OUT-OF-SCOPE 1, NEEDS-OWNER 0
- [x] `../EZEControl/docs/uam/PUBLIC_BUNDLE_SWEEP_AND_PER_AP_SECRETS.md` — 6 claims, IMPLEMENTED 1, PARTIAL 1, MISSING 0, STALE-DOC 0, SUPERSEDED 1, OUT-OF-SCOPE 2, NEEDS-OWNER 1
- [x] `../EZEControl/docs/uam/RENDERER_SECRET_FLOOR_RECOMMENDATION.md` — 9 claims, IMPLEMENTED 4, PARTIAL 1, MISSING 1, STALE-DOC 0, SUPERSEDED 3, OUT-OF-SCOPE 0, NEEDS-OWNER 0
- [x] `../EZEControl/docs/uam/READONLY_REVIEW_NAS_AUTH_FIREWALL_2026-10-15.md` — 12 claims, IMPLEMENTED 9, PARTIAL 1, MISSING 0, STALE-DOC 2, SUPERSEDED 0, OUT-OF-SCOPE 0, NEEDS-OWNER 0
- [x] `../EZEControl/docs/uam/SMTP_DEPLOY_AND_TEST.md` — 6 claims, IMPLEMENTED 4, PARTIAL 1, MISSING 0, STALE-DOC 0, SUPERSEDED 1, OUT-OF-SCOPE 0, NEEDS-OWNER 0
- [x] `infra/freeradius/test/README.md` — 6 claims, IMPLEMENTED 6, PARTIAL 0, MISSING 0, STALE-DOC 0, SUPERSEDED 0, OUT-OF-SCOPE 0, NEEDS-OWNER 0
- [x] `docs/AAA_COMPATIBILITY_MATRIX.md` — 13 claims, IMPLEMENTED 7, PARTIAL 1, MISSING 0, STALE-DOC 5, SUPERSEDED 0, OUT-OF-SCOPE 0, NEEDS-OWNER 0
- [x] `docs/AAA_DEPLOYMENT.md` — 17 claims, IMPLEMENTED 7, PARTIAL 0, MISSING 1, STALE-DOC 8, SUPERSEDED 1, OUT-OF-SCOPE 0, NEEDS-OWNER 0
- [x] `docs/AAA_TEST_RESULTS.md` — 10 claims, IMPLEMENTED 6, PARTIAL 1, MISSING 0, STALE-DOC 3, SUPERSEDED 0, OUT-OF-SCOPE 0, NEEDS-OWNER 0
- [x] `docs/AAA_IMPLEMENTATION_PLAN.md` — 25 claims, IMPLEMENTED 10, PARTIAL 2, MISSING 12, STALE-DOC 1, SUPERSEDED 0, OUT-OF-SCOPE 0, NEEDS-OWNER 0
- [x] `docs/AAA_AUDIT.md` — 17 claims, IMPLEMENTED 6, PARTIAL 4, MISSING 0, STALE-DOC 5, SUPERSEDED 1, OUT-OF-SCOPE 0, NEEDS-OWNER 1
- [x] `AAA_ARCHITECTURE.md` — 38 claims, IMPLEMENTED 21, PARTIAL 7, MISSING 3, STALE-DOC 2, SUPERSEDED 4, OUT-OF-SCOPE 0, NEEDS-OWNER 1
- [x] `HERMES_AAA_AUDIT.md` — 16 claims, IMPLEMENTED 7, PARTIAL 2, MISSING 0, STALE-DOC 1, SUPERSEDED 5, OUT-OF-SCOPE 0, NEEDS-OWNER 1
- [x] `NETWORK_INTEGRATION.md` — 16 claims, IMPLEMENTED 8, PARTIAL 3, MISSING 0, STALE-DOC 0, SUPERSEDED 1, OUT-OF-SCOPE 3, NEEDS-OWNER 1
- [x] `WIREGUARD_ARCHITECTURE.md` — 13 claims, IMPLEMENTED 2, PARTIAL 2, MISSING 1, STALE-DOC 0, SUPERSEDED 5, OUT-OF-SCOPE 2, NEEDS-OWNER 1
- [x] `ECLOUD_MULTI_VENDOR_HOTSPOT.md` — 19 claims, IMPLEMENTED 11, PARTIAL 6, MISSING 0, STALE-DOC 0, SUPERSEDED 2, OUT-OF-SCOPE 0, NEEDS-OWNER 0
- [x] `docs/VENDOR_INTEGRATION_RESEARCH.md` — 17 claims, IMPLEMENTED 13, PARTIAL 2, MISSING 0, STALE-DOC 0, SUPERSEDED 2, OUT-OF-SCOPE 0, NEEDS-OWNER 0
- [x] `infra/freeradius/README.md` — 21 claims, IMPLEMENTED 17, PARTIAL 1, MISSING 0, STALE-DOC 3, SUPERSEDED 0, OUT-OF-SCOPE 0, NEEDS-OWNER 0

Total: 24 files, 313 claims — IMPLEMENTED 159, PARTIAL 36, MISSING 19, STALE-DOC 45, SUPERSEDED 29, OUT-OF-SCOPE 18, NEEDS-OWNER 7. Unread: none. (Verdict counting rule: the first verdict named in a row's verdict cell; rows marked "IMPLEMENTED as described (gap stands)" count as IMPLEMENTED and carry their apply item in the last column.)

## Findings

### `../EZEControl/docs/uam/README.md` (2 KB, hand-off index 2026-10-13)

| claim | verdict | evidence | apply item? |
|---|---|---|---|
| Splash reference lives at `docs/portal/uspot-splash-reference.html` with its own README | IMPLEMENTED | `docs/portal/README.md:1-5`, file present | no |
| Guest SSID on AP1832 at 192.168.203.199 "does not work at all" (four stacked blockers) | STALE-DOC | Pilot login verified end to end 2026-10-15 (`PILOT_OBSERVATIONS_2026-10-15.md`, D-050); NAS now 192.168.203.238 (`nas_clients` SELECT), 1 active session, 155 `radius.radacct_raw` rows | doc: mark README as historical (2026-10-13 snapshot) |
| Portal row pinned to a soft-deleted NAS, `pickPortal` returns null | STALE-DOC | pilot: portal `8c2ed364` has `adapter_config.nas_client_id` NULL (unpinned); `apps/api/src/internal/portal.ts:257-270` pinned → unpinned → platform default | no |
| UDP 1812 dropped by the vps firewall (non-persistent inline rule) | STALE-DOC | host: `ECLOUD_RADIUS_CIDRS`/`ECLOUD_WEB_CIDRS` keys present in `/opt/ecloud/ecloud.env`; `ecloud-docker-user.service` active; DOCKER-USER rule for udp 1812,1813 to 192.168.203.196 present | no |
| UAM secret never equal on both sides | STALE-DOC | bootstrap rerun with matching values (D-050); logins succeed (PILOT_OBSERVATIONS) | no |
| Hosts table: ecloud via `ssh vps-local` (ezeadmin, no passwordless sudo) | STALE-DOC | `sudo -n` works for docker/grep tonight (host checks above) | doc |

### `../EZEControl/docs/uam/01-state.md` (6 KB, 2026-10-13 snapshot)

| claim | verdict | evidence | apply item? |
|---|---|---|---|
| AP1832 at 192.168.203.199, captive portal not running, `/etc/config/uspot` stock | OUT-OF-SCOPE | AP/firmware state (D-058); pilot NAS IP now 192.168.203.238 | no |
| Controller profile 141 carries UAM settings; engine mapping in `src/ap_config_engine.ts` | OUT-OF-SCOPE | controller code (D-058) | no |
| ecloud stack: edge 443→8443 admin/API, 444→8444 portal, api:3000, worker:3003, freeradius bound 192.168.203.196:1812-1813 | IMPLEMENTED | `docker ps` 18:05Z shows ecloud-edge/api/worker/portal/freeradius/postgres/redis healthy; `infra/vps-local/compose/compose.vps-local.yaml` header | no |
| `PUBLIC_ADMIN_ORIGIN` / `PUBLIC_API_ORIGIN` / `PUBLIC_PORTAL_ORIGIN` set in `/opt/ecloud/ecloud.env` | IMPLEMENTED | host key-name grep: all three present (values not read) | no |
| `https://portal.ezelink.ai/uam/uspot/` answers 400 to a bare GET, `/healthz` 200 | IMPLEMENTED (not re-probed) | D-047 hostnames; not re-tested tonight | no |
| NAS rows: three soft-deleted, one LIVE `01a13011` at .199 | STALE-DOC | pilot: `01a13011` live at 192.168.203.238; five soft-deleted rows (`01a121fb`, `01a12e38`, `01a13010`, `01a13a5a`, `01a13a5f`) | doc |
| Portal row `01a121ff` pinned to deleted NAS, walled garden `www.google.com` | STALE-DOC | pilot: only portal is `8c2ed364`, unpinned, walled_garden `{portal.ezelink.ai,ezecloud.ezelink.ai}` | no |
| FreeRADIUS: Accounting-Requests rejected "Shared secret is incorrect", zero Access-Requests | STALE-DOC | 155 accounting rows, 1 active session; `docker logs --since 1h` empty (no errors) | no |
| `ECLOUD_RADIUS_CIDRS`/`ECLOUD_WEB_CIDRS` absent from `ecloud.env`; `docker-user.sh:93-98` needs them | STALE-DOC | keys present on host; `infra/vps-local/firewall/docker-user.sh:40,90,96` reads them (unit reads `/etc/ecloud/docker-user.env`, `:25`) | no |

### `../EZEControl/docs/uam/02-root-causes.md` (9 KB)

| claim | verdict | evidence | apply item? |
|---|---|---|---|
| B1 renderer never emits a `uspot` section (captive JSON position) | OUT-OF-SCOPE | controller + firmware (D-058); pilot works since 2026-10-15 so resolved on that side | no |
| B2 no IPv4 on the captive bridge (`ipv4.addressing` missing) | OUT-OF-SCOPE | controller renderer | no |
| B3 `uspot.<section>.ifname` never emitted | OUT-OF-SCOPE | firmware `interface/captive.uc` | no |
| B4 spotfilter config truncated at boot | OUT-OF-SCOPE | firmware init script | no |
| B5 ecloud portal pinned to a soft-deleted NAS (`portal.ts:197-203`) | STALE-DOC | `pickPortal` now at `apps/api/src/internal/portal.ts:257`; pilot row unpinned; platform-default fallback added by migration 041 (`portal.ts:249-250`) | doc: line refs |
| B6 UDP 1812 dropped; env vars missing | STALE-DOC | see 01-state | no |
| B7 UAM secret stored write-only (D-045), cannot be compared, only set | IMPLEMENTED | D-045 ("UAM and controller secrets stay write-only"); `captive_portals.uam_secret_ref` sealed `enc:v2.` (pilot SELECT); no reveal route for UAM (`routes/access-points-page.ts:9` reveal is NAS RADIUS secret only) | no |
| Hygiene: reused secret appeared in transcripts; generate fresh values for both | SUPERSEDED | D-051 (fleet default `ezeradsecret` kept as a public constant), D-050 (pilot NAS uses a 16-char value by choice) | no |
| Hand-modified `cpd.uc` persists in the AP overlay; restore from `/rom` | OUT-OF-SCOPE | AP overlay (D-058) | list only |

### `../EZEControl/docs/uam/03-uam-flow.md` (5 KB)

| claim | verdict | evidence | apply item? |
|---|---|---|---|
| uspot components, nft capture, CPD redirect with `challenge`/`md` signed by the UAM secret | OUT-OF-SCOPE (firmware description) | n/a | no |
| Portal POSTs credentials to its own endpoint, API verifies Argon2 hash, mints single-use `pc-<16 hex>` (90 s TTL), computes CHAP, portal 302s to `/logon` | IMPLEMENTED | `apps/api/src/internal/portal-credential.ts`, `portal.ts`, `aaa.ts:28` (`PORTAL_RETRANSMIT_TTL_S`), D-018 single-use ≤16-byte credential; D-049 | no |
| Username in Access-Request/accounting is `pc-…`, wrong password produces no Access-Request | IMPLEMENTED | D-049 rationale; PILOT_OBSERVATIONS "portal credential issued" then `/internal/aaa/authorize` 200 | no |
| On Accept uspot applies rate limit, `Session-Timeout`, `Idle-Timeout`, `Acct-Interim-Interval` from reply | IMPLEMENTED (server side) | `aaa.ts:855-880` translate + `buildReplyAttributes`; `aaaInterimIntervalS` | no |
| Walled garden: portal origin must be in the list | IMPLEMENTED | pilot portal `walled_garden {portal.ezelink.ai,ezecloud.ezelink.ai}` | no |

### `../EZEControl/docs/uam/04-actions.md` (4 KB, ordered action list 2026-10-13)

| claim | verdict | evidence | apply item? |
|---|---|---|---|
| A1 persist firewall allow-list in `ecloud.env`, restart `ecloud-docker-user.service` | IMPLEMENTED | keys present; unit active; DOCKER-USER udp 1812,1813 rule present | no |
| A2 repoint or unpin the portal row | IMPLEMENTED | pilot portal unpinned (`nas_client_id` NULL) | no |
| A3 add `portal.ezelink.ai` to walled garden | IMPLEMENTED | pilot `walled_garden {portal.ezelink.ai,ezecloud.ezelink.ai}` | no |
| A4 set a fresh UAM secret, do not reuse the old value | SUPERSEDED | D-050/D-051: fleet-default UAM secret `ezeuamsecret` kept by owner decision | no |
| B1/B2 controller captive JSON shape + re-push profile 141 | OUT-OF-SCOPE | controller (D-058) | no |
| C1/C2 AP: nothing by hand; web-root tarball packaging | OUT-OF-SCOPE | firmware (D-058) | no |
| Verification order 1-5 | IMPLEMENTED | PILOT_OBSERVATIONS: login, authorize 200, Accounting-Start answered; 155 accounting rows | no |
| Risk: `AP1832-TESTING` open SSID; inline firewall rule lost on reboot; rotate two secrets | STALE-DOC / SUPERSEDED | firewall persisted; secrets decision D-051 | no |

### `../EZEControl/docs/uam/DEPLOY_BOOTSTRAP_PLAN.md` (9 KB, 2026-10-15 plan)

| claim | verdict | evidence | apply item? |
|---|---|---|---|
| Live migration ledger stops at 033; 12 migrations 034-045 pending | STALE-DOC | pilot `schema_migrations` max 048 (48 rows); repo has 049 unapplied | doc: historical |
| Stack runs `IMAGE_TAG=1f1e1bc`; no GHCR pull possible | STALE-DOC | `docker ps`: all containers on `0e8f735`; `/opt/ecloud/infra.bak-1f1e1bc-20261015T091238` shows the switch happened | no |
| Migrations run only via the `migrate` one-shot profile (`node packages/db/dist/cli.js migrate`, `--dry-run`, `status` exit 2) | IMPLEMENTED | `infra/vps/compose/compose.pilot.yaml` migrate service; `packages/db/src/cli.ts` | no |
| Migrate service lacks `DATA_ENCRYPTION_KEY`; add a `bootstrap` one-shot service mounting `database_url_platform` + `data_encryption_key` | IMPLEMENTED | `infra/vps/compose/compose.pilot.yaml:324-334` `bootstrap:` service; host wrapper `/opt/ecloud/bin/ecloud-compose` loads pilot + vps-local override | no |
| Bootstrap script `apps/api/src/bootstrap/tenant.ts` reconciles, safe to run twice, emits `tenant_bootstrapped` | IMPLEMENTED | file present (`apps/api/src/bootstrap/tenant.ts`, integration test); D-050 bootstrap rerun | no |
| Bootstrap NAS IP `192.168.203.226/32`, secrets `ezeradsecret`/`ezeuamsecret` | SUPERSEDED | D-050: RADIUS secret 16-char value by choice, NAS now 192.168.203.238 (pilot SELECT) | no |
| `docker-user.sh` reads `/etc/ecloud/docker-user.env`, not `ecloud.env` | IMPLEMENTED | `infra/vps-local/firewall/docker-user.sh:25,42` | no |
| `reload-radius.sh` prints `clients:` / `skipped:` JSON | IMPLEMENTED | `infra/vps-local/scripts/reload-radius.sh`; `apps/api/src/radius-clients/run.ts:128,202` (adds `fleetDefaultSecret`) | no |
| Rollback = `IMAGE_TAG` back + backup; migrations forward-only | IMPLEMENTED | `setup-backup.sh` present; D-054 dump path | no |
| Branch push / build-on-host procedure | NEEDS-OWNER | D-053/D-058 era procedure; remote registry "falls behind the host" — is GHCR publication required before the next deploy? | NEEDS-OWNER |

### `../EZEControl/docs/uam/PILOT_OBSERVATIONS_2026-10-15.md` (2 KB)

| claim | verdict | evidence | apply item? |
|---|---|---|---|
| Login verified end to end; AP applied 10000000/10000000 bps | IMPLEMENTED | `platform_default_policy` 10000/10000 kbps enabled (D-055); 1 active session on pilot | no |
| `aaa.ts:830-843` caps Session-Timeout at `aaaSessionTimeoutCapS` under `next_reauth`; uspot users logged out every 1800 s | STALE-DOC (fixed) | `packages/policy-engine/src/enforcement.ts:69-79` `sessionTimeoutCapFor` returns null for `NO_SILENT_REAUTH_ADAPTERS`; `aaa.ts:860-867` comment names this exact regression; D-052/D-065 | no |
| Options: CoA/Disconnect strategy for `openwifi-uspot-uam`, per-adapter cap, or remember-me | PARTIAL | per-adapter cap exemption built; CoA path built (D-056/D-061, `apps/api/src/internal/nas-secret.ts`) but device test deferred (D-065); `adapter_types.openwifi-uspot-uam.verification_status = unknown` on pilot | A-01 run the D-065 CoA device test and write the evidence-registry entry so `chooseEnforcementStrategy` leaves `next_reauth` |
| iOS captive-detection note belongs in end-user troubleshooting text | MISSING | no troubleshooting doc under `docs/portal/` mentions captive probes (grep `captive.apple.com` none) | A-02 (S) doc line |
| Unauthorised background devices stay associated for hours | OUT-OF-SCOPE | AP behaviour | no |

### `../EZEControl/docs/uam/PUBLIC_BUNDLE_SWEEP_AND_PER_AP_SECRETS.md` (6 KB)

| claim | verdict | evidence | apply item? |
|---|---|---|---|
| Controller `public/js` carries only the two deliberate defaults; Mapbox token restriction owner action | OUT-OF-SCOPE | controller bundle; D-058 (1) drops the Mapbox item | no |
| NAS secret is rotate-only; `nas:secret:reveal` reads it back once (D-045) | IMPLEMENTED | `apps/api/src/routes/access-points-page.ts:9,441` reveal route; no "set secret to X" route | no |
| Adoption rotates the secret (`randomToken`, 32+ chars) and shows it once to a holder of `nas:secret:reveal` | PARTIAL | adoption flow exists (migration 046, D-058 "adoption flow with the revealed-secret hint" continues); not re-verified in this lane (Lane 2 covered NAS pending docs) | defer to lane-2 NAS findings |
| Controller badge "inheriting the fleet default" + length guard | OUT-OF-SCOPE | live as `fleetbadge-20261015T123457Z`, frozen by D-058 | no |
| Open question: renderer carve-out vs raise the controller value | SUPERSEDED | D-051 option B: `isAcceptableSecret` in `apps/api/src/radius-clients/render.ts:78-83` | no |
| Automating ecloud→controller profile PUT needs its own security review | NEEDS-OWNER | not built; D-058 pauses controller work — is the ecloud→controller write ever wanted? | NEEDS-OWNER |

### `../EZEControl/docs/uam/RENDERER_SECRET_FLOOR_RECOMMENDATION.md` (7 KB)

| claim | verdict | evidence | apply item? |
|---|---|---|---|
| Recommendation: do not carve out; raise the controller default | SUPERSEDED | D-051 chose option B (carve-out) | no |
| Condition 1: one exported constant carrying the controller release id | IMPLEMENTED | `render.ts:72-78` `FLEET_DEFAULT_RADIUS_SECRET` next to `FLEET_DEFAULT_CONTROLLER_RELEASE`; D-064 notes a later move to `@ecloud/shared` only if reopened (`packages/shared/src` has no copy) | no |
| Condition 2: exact-equality exception, floor unchanged | IMPLEMENTED | `render.ts:65,82-83` | no |
| Condition 3: `check-no-secrets: allow` annotation naming the decision | IMPLEMENTED | `render.ts:78` "(public fleet constant, D-051)" | no |
| Condition 4: third run-summary count on the fleet default | IMPLEMENTED | `render.ts:168-169` `fleetDefaultSecretCount`; `run.ts:128,202`; `radius-clients-cli.ts:73-75` WARNING line | no |
| Alert with non-zero threshold on NAS count on the fleet default | PARTIAL | only the CLI WARNING line; no alert rule / metric (grep `fleetDefaultSecret` outside render/run/cli: none) | A-03 (S) emit a metric or alert from the run summary — dropped by D-064 for the badge; the metric half is not named there: NEEDS-OWNER whether it stays dropped |
| Badge in the admin NAS list for NAS on the default secret | SUPERSEDED | D-064: badge/alert not built, reopen on owner's word | no |
| Meraki path must refuse a client on the fleet default | MISSING | `render.ts` has no Meraki rule (grep `meraki` none); D-064 notes "Meraki refuses the default by length" only as design for a reopened D-057 | A-04 (S) renderer rule: refuse fleet default on Meraki cloud entries (D-044 says Meraki is build/test-only, so low risk) |
| Inheriting is a disclosure event: explicit, audited, never from migration/restore | SUPERSEDED | D-057 design, then D-064 dropped the build; no `inherit:` can exist | no |

### `../EZEControl/docs/uam/READONLY_REVIEW_NAS_AUTH_FIREWALL_2026-10-15.md` (10 KB)

| claim | verdict | evidence | apply item? |
|---|---|---|---|
| NAS CRUD routes under `/api/v1/orgs/:orgId/nas` with `nas:read/create/update/delete`; secret `randomToken(32)` returned once | IMPLEMENTED | `apps/api/src/routes/resources.ts` (list filter `:650`, create `:704`, rotate `:956`); `access-points-page.ts:441` reveal | no |
| `POST /nas/:id/rotate-secret` refuses while impersonating, audited, signals clients reload | IMPLEMENTED | `resources.ts:956`; D-062 every write refused while impersonating | no |
| Reveal needs TOTP only when `ADMIN_MFA_MODE=required`; default `off` | IMPLEMENTED | `apps/api/src/config.ts:47` default `off` (D-046) | no |
| Gap: `blocked` unreachable through the API; `block_reason`/`is_adopted` have no write path | STALE-DOC (fixed since 16d240e) | `resources.ts:650` filter accepts `blocked`; `POST /nas/:id/block` `:846`, `/unblock` `:901`; `POST /nas/:id/adopt` `access-points-page.ts:701`; `is_adopted`/`block_reason` in read columns `:522-523` | no |
| Gap: `uq_nas_clients_ip` is cross-tenant (409 leaks another org's IP) | IMPLEMENTED as described (gap stands) | `packages/db/migrations/003_network.sql:131` unique on `nas_ip` only, live rows; no tenant column in the index | NEEDS-OWNER: is a global NAS-IP uniqueness (and the resulting cross-org 409) acceptable for the pilot? |
| Gap: 027 CHECK `NOT VALID`, active rows only | IMPLEMENTED as described | `027_nas_ip_unicast_host.sql` | no (renderer skips bad rows) |
| Gap: create/rotate use the unbound `sealSecretRef`; `nas_clients.secret_ref` has no format CHECK | STALE-DOC / SUPERSEDED | create and rotate now call `sealNasSecret` (bound v2 envelope) `resources.ts:27,704,994`; existing rows re-sealed (D-054); the format CHECK migration dropped by D-064 | no |
| Gap: no administrator password change/reset endpoint; recovery is database surgery | PARTIAL | CLI `reset-platform-admin-password --password-stdin` built (`packages/db/src/cli.ts:13-15,50`, `admin.ts:144-167`, audit `platform:password_reset` `:208`; wrapper `infra/vps-local/scripts/reset-admin-password.sh`) per D-059; still no HTTP change-password route for any administrator (grep `change-password`/`forgot`: none) | A-06 (M) self-service `POST /auth/change-password` (current password required, sessions revoked, audited) — NEEDS-OWNER whether wanted while MFA is off |
| Lockout keyed on submitted email allows a 900 s denial-of-login | IMPLEMENTED as described | `apps/api/src/auth/rate-limit.ts` (not re-read; cited by the review) | NEEDS-OWNER: accept, or key lockout on email+IP? |
| SMTP used only for guest OTP; invitations travel out of band | IMPLEMENTED | `packages/shared/src/config.ts` SMTP optional; `apps/api/src/mail.ts:4-8` | no |
| `apply-firewall.sh` header still says DRAFT; dead-man default 600 s; approval gate is a presence check | IMPLEMENTED as described | `infra/vps-local/scripts/apply-firewall.sh:2,28,88` | A-07 (S) drop the "DRAFT, NOT RUN" header (the unit is active on the host) and bound `DEADMAN_SECONDS` |
| Pilot state: DOCKER-USER allows the LAN /24 on 1812/1813; AP1832 at 192.168.203.238 | IMPLEMENTED | host `iptables -S DOCKER-USER` udp 1812,1813 rule; `nas_clients.nas_ip = 192.168.203.238` | no |


### `../EZEControl/docs/uam/SMTP_DEPLOY_AND_TEST.md` (3 KB)

| claim | verdict | evidence | apply item? |
|---|---|---|---|
| Code 823647a plumbs `SMTP_PASSWORD_FILE`; key at `/opt/ecloud/secrets/smtp_password` (root:ecloud-secrets 0440) | IMPLEMENTED | commit `823647a`; `infra/vps/compose/compose.pilot.yaml:195,218`; host `ls -l /opt/ecloud/secrets`: `smtp_password` `-r--r-----` root ecloud-secrets | no |
| `SMTP_HOST/PORT/USER/FROM/IMPLICIT_TLS` appended to `ecloud.env` | IMPLEMENTED | host key-name grep: all five present; settings schema in `packages/shared/src/config.ts` | no |
| Deploy: recreate api; failure strings `SMTP_FROM: required when SMTP_HOST is set` | IMPLEMENTED | D-060 deployed 15:34-15:38 local, send test delivered | no |
| Send test via `apps/api/dist/mail.js` `createMailer` | IMPLEMENTED | `apps/api/src/mail.ts:4,26` | no |
| End-to-end OTP check on the portal | PARTIAL | `otp_codes` 0 rows on pilot: no guest OTP has been sent through the real path yet | A-05 (S) run one email-OTP login on the pilot and record it |
| Sender verification / domain authentication | SUPERSEDED | D-060: Single Sender only, no SPF/DKIM/DMARC, risk accepted | no |

### `infra/freeradius/test/README.md` (3.5 KB)

| claim | verdict | evidence | apply item? |
|---|---|---|---|
| 14 radclient attribute files for DT-03/07/08/09/15/16 and T-A1..T-A9, placeholders only | IMPLEMENTED | `infra/freeradius/test/*.txt` (14 files present, listed above); `PHASE2_VALIDATION.md` DT ids | no |
| Run from the dev container after `npm run dev:stack` with `RADIUS_DEV_CLIENT_SECRET` | IMPLEMENTED | `package.json:31` `dev:stack`; `infra/compose/docker-compose.dev.yml:110-111` | no |
| Server runs `require_message_authenticator = yes`; Status-Server on 127.0.0.1:18121 | IMPLEMENTED | `raddb/clients.d/dev.conf:25`, `clients.conf:25-26`; `sites-enabled/status:8-14`; `healthcheck.sh:14` | no |
| FreeRADIUS has no 3799 listener; Disconnect/CoA sent from the worker | IMPLEMENTED | `apps/worker/src/coa/{dispatcher,radclient}.ts`; `docs/AAA_AUDIT.md` §2 | no |
| MikroTik HTTP-CHAP: EZECLOUD answers `Auth-Type = CHAP` + `Cleartext-Password` | IMPLEMENTED | `apps/api/src/internal/aaa.ts:348,833` | no |
| Expected until the api runs: Access-Reject "AAA backend unavailable" | IMPLEMENTED (not re-run) | `sites-enabled/ecloud` fail-closed path; contract suite `tests/aaa-contract/freeradius-rest.test.ts` | no |

### `docs/AAA_COMPATIBILITY_MATRIX.md` (9 KB, v1.0 2026-10-12)

| claim | verdict | evidence | apply item? |
|---|---|---|---|
| §1 PAP/EAP-TTLS/MAB "P" for EZE/TIP/CoovaChilli/MikroTik/Meraki/generic; everything else X | STALE-DOC | TIP OpenWiFi uspot PAP is now pilot-proven (login 2026-10-15, 155 accounting rows); UniFi/Omada/Mist/postback adapters exist (`adapter_types` 12 keys on pilot; migrations 030/031) | doc: refresh matrix to the 12 adapter keys; mark TIP uspot PAP "Y (pilot)" |
| CHAP only via the MikroTik HTTP-CHAP path (Argon2id store) | IMPLEMENTED | `aaa.ts:348,833`; `docs/AAA_AUDIT.md` §3.1 | no |
| §3 CoA: EZE/TIP `?`, CoovaChilli Disconnect only, MikroTik port 1700, Meraki DAS 3799 Disconnect only | IMPLEMENTED (design) | `packages/adapters/src/vendor/mikrotik.ts:469` (1700); `adapters/meraki-splash.ts:7` (3799); D-006, D-044; pilot `adapter_types.*.verification_status = unknown` | no (device test = A-01) |
| §3 "UniFi/Omada: no adapter exists" | STALE-DOC | `unifi-external-portal`, `omada-api`, `mist-guest-portal` keys (031); `packages/vendor-api/src/{unifi,omada,mist,ruckus}.ts` | doc |
| Octet64 wrap detection via `accounting_anomalies` | IMPLEMENTED | table on pilot; `apps/worker/src/accounting/drain.ts`; `apps/worker/src/enforcement.integration.test.ts:168,228` | no |
| L2 NAS hot-reload needs a container restart | PARTIAL / STALE-DOC | dynamic-clients site built (`sites-available/ecloud-dynamic-clients`, `rest_clients`, `apps/api/src/internal/radius-client-lookup.ts`) but off: `RADIUS_DYNAMIC_CLIENT_SUBNET` unset on the host (defaults TEST-NET-2); restart path is `reload-radius.sh` | see A-08 (watcher) and NEEDS-OWNER (enable dynamic clients on the LAN /24?) |
| L4 RadSec not implemented | STALE-DOC | `sites-available/ecloud-radsec` (97 lines), migration `034_nas_radsec.sql`, `packages/shared/src/radsec.ts`, `apps/worker/src/radsec-attribution.integration.test.ts`; off on the pilot (`radsec_enabled` false, no `RADIUS_RADSEC_*` env key) | doc |
| L5 IPv6 listener "configured" | STALE-DOC | `sites-enabled/ecloud` has no `ipv6addr` (count 0); listeners bind `$ENV{RADIUS_LISTEN_IP}` only (`:28-37`) | doc |
| L7 VLAN via CoA not implemented | IMPLEMENTED as described | no Tunnel-* in `apps/worker/src/coa/dispatcher.ts` changeable set (cited by AAA_TEST_RESULTS §6 lab-mode only) | no |
| L8 PPPoE: no adapter, no Framed-Protocol | IMPLEMENTED as described | `Framed-Protocol` only in `generic-radius-8021x.ts`/`openwifi-hostapd-radius.ts` capability tables | no |
| L9 no sponsor workflow | IMPLEMENTED as described | `packages/shared/src/portal-methods.test.ts` only mention; no route | NEEDS-OWNER: is sponsor approval wanted? |
| L10 no billing integration | STALE-DOC | migration `045_orders_payment_events.sql` (billing spine, no provider) | doc |
| L11 single FreeRADIUS container | IMPLEMENTED | `compose.pilot.yaml:357` one service; `docs/AAA_IMPLEMENTATION_PLAN.md` 2C deferred with reasons | no |

### `docs/AAA_DEPLOYMENT.md` (16 KB, v1.0 2026-10-12)

| claim | verdict | evidence | apply item? |
|---|---|---|---|
| §1 env: `RADIUS_SHARED_SECRET`, `ECLOUD_FR_INTERNAL_IP`, `RADIUS_LISTEN_PORT`, `ECLOUD_COA_ENABLED`, `RADIUS_EAP_ENABLED` in `ecloud.env` | STALE-DOC | no `RADIUS_SHARED_SECRET`/`ECLOUD_FR_INTERNAL_IP`/`RADIUS_LISTEN_PORT` anywhere in `infra/`, `apps/*/config.ts` or `packages/shared/src/config.ts`; real names: `RADIUS_LISTEN_IP` (`docker-entrypoint.sh:68`), `RADIUS_EAP_ENABLED=1` (`:173`), `ECLOUD_COA_ENABLED` (`apps/worker/src/config.ts:32`) | doc |
| `ECLOUD_COA_ENABLED` default false, enable only after lab CoA testing | IMPLEMENTED, and currently OFF on the pilot | `apps/worker/src/config.ts:32,123` `boolFlag(false)`; host: no `COA` key in `/opt/ecloud/ecloud.env`, `ecloud-worker` env has no `ECLOUD_COA_ENABLED` | A-09 (S, NEEDS-OWNER) the D-065 device test cannot pass until `ECLOUD_COA_ENABLED=true` is set on the worker and NAS `coa_supported`/`coa_port` are set (both NULL on `d82d9ba1a1aa`); D-065 does not mention either |
| §2 `up -d` starts 6 containers; freeradius/radius-clients behind `profiles: ['radius']`; migrate behind `['migrate']` | IMPLEMENTED | `compose.pilot.yaml:157,301,361` (plus `bootstrap` `:338`); `docker ps` 7 containers | no |
| Health probe `docker exec ecloud-freeradius /healthcheck.sh` reads `RADIUS_STATUS_SECRET_FILE` | IMPLEMENTED | `infra/freeradius/healthcheck.sh:14` | no |
| §3 NAS registration `POST /v1/platform/sites/<site_id>/nas-clients` with a caller-supplied `secret` | STALE-DOC | real route `POST /api/v1/orgs/:orgId/nas` (`routes/resources.ts`), secret server-generated and shown once; no caller-chosen secret (READONLY_REVIEW §1 confirmed) | doc |
| §3 restart FreeRADIUS after NAS change (`ecloud-compose restart freeradius`); hot-reload "planned" | STALE-DOC | `infra/vps-local/scripts/reload-radius.sh` is the operator step (re-render + restart); hot-reload built but off (see matrix L2) | doc |
| §4 mode A LAN RADIUS; firewall allows 1812/1813 from NAS to LAN IP | IMPLEMENTED | D-042; host DOCKER-USER rule | no |
| §5 mode B WireGuard with `10.99.0.1/24`, `apt install wireguard`, MASQUERADE | SUPERSEDED | D-032 hub `100.100.0.1`, D-042/D-043 WireGuard deferred; host is Oracle Linux 8 (`dnf`, D-041); `WIREGUARD_ARCHITECTURE.md` is the design | doc |
| §6 portal creation `POST /v1/platform/sites/<site_id>/captive-portals`; redirect `/portal/<slug>`; adapter list incl. `external-postback` | STALE-DOC | portals under `/api/v1/orgs/:orgId/...`; UAM entry `/uam/uspot/` etc.; key is `external-portal-postback`; 12 keys not 5 | doc |
| §7 EAP-TTLS: certs in `infra/freeradius/certs/`, `RADIUS_EAP_ENABLED=true` | STALE-DOC | no `infra/freeradius/certs` dir; entrypoint expects `RADIUS_EAP_ENABLED=1` and a mounted `RADIUS_EAP_CERT_DIR` (`docker-entrypoint.sh:160-184`); `mods-available/eap:25,51` ttls | doc |
| §8 CoA enablement steps; disconnect route `/v1/platform/sites/<site_id>/sessions/<id>/disconnect` | STALE-DOC | sessions routes are `/api/v1/orgs/:orgId/sessions/...` and `session-actions/:id` (`routes/sessions.ts:325,395,589`) | doc |
| §9 tenant isolation by RLS; no FreeRADIUS-level separation | IMPLEMENTED | D-008; migration 010; `docs/AAA_AUDIT.md` §7 | no |
| §10 health `GET /health`; metrics `aaa_auth_accept_total` etc.; PagerDuty alerts | STALE-DOC / MISSING | api serves `/healthz` (`apps/api/src/app.ts:162,224`); real metric names `ecloud_aaa_authorize_decisions_total`, `ecloud_aaa_authorize_duration_seconds` (`apps/api/src/metrics.ts:46,51`); no alerting rules in `infra/monitoring` for auth-reject rate (not verified beyond grep) | A-10 (S) doc fix + NEEDS-OWNER: is an alert pipeline wanted for the pilot? |
| §11 backup via `scripts/backup/backup.sh` (age-encrypted pg_dump), nightly timer, `docs/RESTORE_DRILL.md` | IMPLEMENTED | files present; host `ecloud-backup.timer` next run 2026-10-16 06:22 +04 | no |
| §12 upgrade: `git pull` on the host, `ecloud-compose pull` | STALE-DOC | `/opt/ecloud` has no `.git` (host `ls`); images are built on the host or pulled by tag (DEPLOY_BOOTSTRAP_PLAN) | doc |
| §13 troubleshooting SQL `WHERE drained_at IS NULL` on `radius.radacct_raw` | IMPLEMENTED | `radius.radacct_raw` exists on pilot (155 rows); column per migration 009 (not re-read) | no |
| §14 hot-reload watcher: API writes `radius:clients:reload_pending`, cron runs `radius-reload-watch.sh`; host install REQUIRES_CLARIFICATION | MISSING on the host (resolves the clarification) | repo: `apps/api/src/radius-clients/reload-signal.ts`, `infra/vps-local/scripts/radius-reload-watch.sh:35-36`, `tests/scripts/radius-reload-watch.test.ts`; host: `/opt/ecloud/bin` holds only `backup.sh ecloud-compose lib.sh upload-github.sh`, no `/etc/cron.d/ecloud-radius-reload`, no `/var/log/ecloud/radius-reload.log` | A-08 (S) install the watcher + cron on vps-local (change-list id needed), or document that every NAS change needs a manual `reload-radius.sh` |

### `docs/AAA_TEST_RESULTS.md` (16 KB, v1.0 2026-10-12)

| claim | verdict | evidence | apply item? |
|---|---|---|---|
| Baseline `npm test` 1515 passed / 518 skipped (2026-10-12); contract suite skipped unless `ECLOUD_TEST_RADIUS=1` + `ECLOUD_TEST_REQUIRE_INTEGRATION=1` | IMPLEMENTED (gate) / STALE (numbers) | `tests/aaa-contract/freeradius-rest.test.ts:36-42`; `package.json:29` `test:aaa-contract`; counts not re-run tonight | no |
| API "v1f1e1bc"; lab NAS "none yet configured" | STALE-DOC | pilot on `0e8f735`; AP1832 is a live NAS with sessions | doc |
| §3 `user_expired`/`user_not_yet_valid`/`site_mismatch`, §4 `device_blocked`/unknown-MAC: implemented, untested | IMPLEMENTED as described (gap stands) | grep of `*.test.ts` across apps/packages/tests: zero references to any of the four reasons | A-11 (S) add reject-reason tests for `user_expired`, `user_not_yet_valid`, `device_blocked`, unknown MAC |
| §6 VLAN triplet lab-mode only | IMPLEMENTED | `packages/policy-engine/src/translate.test.ts:388` (cited; not re-read) | no |
| §7 accounting rows incl. wrap and reaper tests; Phase 2B complete | IMPLEMENTED | `apps/worker/src/jobs/reap.test.ts`, `attribution.integration.test.ts` present | no |
| §8 CoA dispatcher unit rows; "no per-NAS CoA rate limit exists" | IMPLEMENTED as described | `apps/worker/src/coa/dispatcher.ts` has no rate limiting (grep `rate`: none) | A-12 (M) per-NAS CoA rate limit (AAA_IMPLEMENTATION_PLAN 5B) — NEEDS-OWNER priority |
| §9 all lab rows PENDING incl. "TIP OpenWiFi PAP auth -> Accept" | STALE-DOC | TIP uspot PAP/UAM proven on AP1832 2026-10-15 (PILOT_OBSERVATIONS; pilot sessions); CoA rows still pending (D-065) | A-13 (S) record the AP1832 evidence row (date, session id) in §9 and in the adapter evidence registry |
| §10 security rows (Message-Authenticator, 0600 secret file, rate limit `hitLimitFailOpen`) | PARTIAL | `sites-enabled/ecloud:75-80`; `radclient.test.ts`; but auth routes now use `hitLimit` (`routes/auth.ts:22,111,237,607`), `hitLimitFailOpen` remains at `auth/rate-limit.ts:108` for exports — row text stale | doc |
| §11 TG5 OTP no test until Phase 4C; TG7 RadSec no test until 3A | STALE-DOC | `apps/api/src/internal/otp.test.ts`; `apps/worker/src/radsec-attribution.integration.test.ts`; `apps/api/src/radsec.integration.test.ts` (per plan) | doc |
| TG1 EAP-TTLS needs eapol_test | IMPLEMENTED as described | `infra/freeradius/README.md:215` local eapol_test run 2026-10-10, not in CI | no |

### `docs/AAA_IMPLEMENTATION_PLAN.md` (18 KB, v1.0 2026-10-12)

| claim | verdict | evidence | apply item? |
|---|---|---|---|
| 2A dynamic clients DONE (ec93e7a): `radius-client-lookup.ts`, `rest_clients`, `ecloud-dynamic-clients`; default subnet TEST-NET-2 = off | IMPLEMENTED (off on pilot) | files present; `docker-entrypoint.sh:73`, `compose.pilot.yaml:391`; host env has no `RADIUS_DYNAMIC_CLIENT_SUBNET` | NEEDS-OWNER: enable for 192.168.203.0/24 on the pilot? (one new client/s, 300 s secret lag) |
| 2B stale sweep already tested | IMPLEMENTED | `apps/worker/src/jobs/reap.test.ts` | no |
| 2C second FreeRADIUS replica deferred | IMPLEMENTED (decision) | one service in compose | no |
| 3A RadSec IMPLEMENTED, off by default; open: admin enrol path, unique nas_ip, CoA behind NAT, CA key custody, publishing 2083 | PARTIAL | code present (see matrix L4); no admin route sets `radsec_enabled`/serial (grep `radsec` in routes: not found in `resources.ts` NasCreate list per READONLY_REVIEW) | NEEDS-OWNER: RadSec enrolment UI/CLI and CA custody; blocked by D-043 anyway |
| 3B `infra/wireguard/wg0.conf.example` | MISSING | no `infra/wireguard/` directory | no apply (WireGuard deferred by D-042) |
| 3C rlm_rest TLS verification (`ca_file`, `tls_min_version`) | IMPLEMENTED (opt-in), cleartext on pilot | commit `2599658`; `mods-available/rest:28-35` `ca_file` toggled when `ECLOUD_INTERNAL_URL` is https; `compose.pilot.yaml:203-204,269,381-382`; host env has no `INTERNAL_TLS_*` key, so FreeRADIUS→api is `http://api:3001` with the cleartext acknowledgement (D-049 F-009 context) | A-14 (M) enable the internal TLS leg on vps-local (`make-lan-tls.sh`, `INTERNAL_TLS_CERT_FILE/KEY_FILE`, `ECLOUD_INTERNAL_URL=https://api:3001`); also lifts the D-061 cleartext-ack condition |
| 4A LDAP/AD (`aaa-ldap.ts`, `mods-available/ldap`, migration 036) | MISSING | `mods-available/` = eap rest rest_clients sql; no ldap in `apps/api/src` or migrations (036 is quota_periods) | NEEDS-OWNER: LDAP in scope for the pilot? |
| 4B external RADIUS proxy (`proxy.conf`, `external_radius_servers`) | MISSING | no `proxy.conf`; no such table on pilot | NEEDS-OWNER |
| 4C OTP email/SMS (`otp_tokens`, `/portal/otp/*`) | IMPLEMENTED (different names, email only) | migration `035_otp_codes.sql`, `apps/api/src/internal/otp.ts`, SMTP via SendGrid (D-060); no SMS provider | no (SMS: NEEDS-OWNER) |
| 4D OIDC/social login (PKCE) | MISSING | no `oidc`/`pkce` in `apps/api/src` outside tests; `identity_providers` table only | NEEDS-OWNER: D-018 design stands; priority? |
| 4E guest self-registration | IMPLEMENTED (recently) | migration `049_portal_registration_devices.sql` (not yet applied on pilot: ledger at 048) | A-15 (S) apply 049 with the next deploy (A6 gate) |
| 5A lab-test CoA on MikroTik/CoovaChilli | MISSING (device) | D-065; `adapter_types` all `unknown` | A-01 |
| 5B per-NAS CoA rate limit | MISSING | dispatcher has none | A-12 |
| 5C voucher mid-session expiry enforcement job | MISSING | `apps/worker/src/jobs/enforcement.ts` has no voucher/expires logic (grep none); quota job exists (`jobs/quota.ts`) | A-16 (M) mid-session voucher/validity expiry push — NEEDS-OWNER priority |
| 5D `require_eap` flag | MISSING | no `require_eap` in migrations or `aaa.ts` | NEEDS-OWNER |
| 6A/6B UniFi/Omada adapters (`unifi-radius.ts`, `omada-radius.ts`) | IMPLEMENTED (different shape) | cycle D: `unifi-external-portal`, `omada-api`, `mist-guest-portal` (031); `packages/vendor-api/src/{unifi,omada,mist}.ts` | doc |
| 6C Aruba adapter | IMPLEMENTED (via postback engine) | cycle C `external-portal-postback` profiles (`packages/adapters/src/vendor/postback/profiles.ts`), D-044 | doc |
| 6D RADIUS flow tester `POST /radius/test` | PARTIAL | `POST /api/v1/orgs/:orgId/policies/simulate` (`routes/policies.ts:652`) is a logic-only policy trace; no per-NAS Access-Request dry run with reject reason | NEEDS-OWNER: is the simulate route enough? |
| 6E admin AAA modules under `apps/portal/src/pages/aaa/` | STALE-DOC | admin SPA is `apps/admin/src/features` (not `apps/portal`); not inventoried in this lane (Lane 3) | doc |
| 7A EAP-TLS | MISSING | `mods-available/eap` ttls only (`:25,51`) | NEEDS-OWNER |
| 8A DRAFT banners in `ecloud-edge.conf:1` and `docker-user.sh:1` | IMPLEMENTED (fixed) | `ecloud-edge.conf:1` "EZECLOUD LAN edge"; `docker-user.sh:1-3` no DRAFT; remaining DRAFT: `apply-firewall.sh:2` (A-07) | no |
| 8B `ExecStartPre` re-arm before Docker | MISSING | `infra/vps-local/systemd/*.service` has only `After=docker.service` (`:6`) | A-17 (S) NEEDS-OWNER (host change, change-list id) |
| 8C key-rotation runbooks `docs/runbooks/key-rotation.md` | MISSING | no `docs/runbooks/`; re-seal CLI exists (D-054) but no runbook for `DATA_ENCRYPTION_KEY`/`MFA_ENCRYPTION_KEY`/voucher pepper rotation | A-18 (S) write the rotation runbook around `secret-reseal-cli.js` |
| 8D 150 ms reject floor | MISSING | no delay logic in `aaa.ts` (grep none); timing levelling exists for unknown users (`portal-identity.test.ts:12`) | NEEDS-OWNER |
| 8E auth limiters fail closed | IMPLEMENTED | `routes/auth.ts:111,237,607` use `hitLimit` (fail-closed 503 per READONLY_REVIEW §2); `hitLimitFailOpen` kept for exports | no |

### `docs/AAA_AUDIT.md` (26 KB, 2026-10-12, 33 migrations)

| claim | verdict | evidence | apply item? |
|---|---|---|---|
| §2 FreeRADIUS front-end only: rlm_rest authorize/post-auth, rlm_sql insert-only, no DAS listener | IMPLEMENTED | D-004; `sites-enabled/ecloud:159,205,236`; `mods-available/sql`; worker CoA | no |
| §2 Message-Authenticator on every reply; `require_message_authenticator = yes` | IMPLEMENTED | `sites-enabled/ecloud:75-80`; `clients.d/dev.conf:25` | no |
| §2 NAS change requires container restart | PARTIAL | dynamic clients built, off (plan 2A) | see matrix L2 |
| §3.1 PAP/CHAP-via-portal/MAB/voucher/portal credential rows | IMPLEMENTED | `aaa.ts:84,95` TTLs 10 s / 30 s; `:348,833` CHAP | no |
| §3.2 click-through "Planned, no backend"; OTP "Planned"; self-reg "Planned"; sponsor Missing; OIDC/SAML Planned; paid subscriptions Missing | STALE-DOC (partly) | click-through handled in `portal-credential.ts`/`portal-identity.ts`; OTP built (035, `otp.ts`, D-060); self-registration (049); billing spine (045); OIDC/SAML/sponsor still absent | doc; OIDC/SAML/sponsor NEEDS-OWNER |
| §3.3 LDAP/AD Missing; external RADIUS Planned | IMPLEMENTED as described | see plan 4A/4B | NEEDS-OWNER |
| §4 authorization engine rows (quotas, schedule, concurrency, VLAN lab-only, burst UNSUPPORTED) | IMPLEMENTED | `packages/policy-engine/src/{resolve,schedule,translate,enforcement}.ts`; D-022/D-028 | no |
| §5 accounting rows; stale detection "no automated test" | STALE-DOC | `jobs/reap.test.ts` exists (AAA_TEST_RESULTS §7 correction) | doc |
| §6 CoA rows; `ECLOUD_COA_ENABLED` default false; admin disconnect `POST /sessions/:id/disconnect`, `/reauthorize` | PARTIAL / STALE-DOC | dispatcher present; routes are `session-actions` (`routes/sessions.ts:589`) — no `/reauthorize` route found (grep none); flag OFF on pilot (A-09) | doc + A-09 |
| §7 tenant mapping by packet source IP or UUID shortname, never NAS-Identifier | SUPERSEDED (Meraki) | D-044: Meraki NAS identified by NAS-Identifier + per-NAS secret; `apps/api/src/internal/portal-meraki.ts`, `packages/shared/src/meraki-cloud-radius.ts` | doc |
| §8 nine adapters; UniFi/Omada/Cisco/Aruba/Ruckus/Cambium missing | STALE-DOC | 12 keys on pilot; cycles C/D (030/031), `packages/vendor-api/src/ruckus.ts`; Cisco/Aruba via postback profiles | doc |
| §9 RadSec Missing; no VPN guide; IPv6 partial; HA missing | STALE-DOC (RadSec) / IMPLEMENTED (rest) | RadSec built (034); WireGuard design doc exists but deferred (D-042); no `ipv6addr` listener; single container | doc |
| §10 rate limiting `hitLimitFailOpen` on auth | STALE-DOC | auth routes use `hitLimit` (fail closed) | doc |
| §10 TLS for internal API "Partially, REQUIRES_CLARIFICATION" | PARTIAL | opt-in built (2599658), not enabled on pilot | A-14 |
| §11 RADIUS flow tester Missing | PARTIAL | `policies/simulate` | NEEDS-OWNER (plan 6D) |
| §12 G1..G10, H1..H5 | mixed, see rows above | G4 (hot reload) PARTIAL/off; G8 OTP built; G10 billing spine; G1 RadSec built-off; H1 vendors built; H4 reaper tested; G2/G3/G5/G6/G7/G9/H2/H3/H5 stand | roll-up only |
| §13 keep list | IMPLEMENTED | n/a | no |

### `AAA_ARCHITECTURE.md` (60.6 KB, read in 2 chunks: lines 1-220, 221-441)

| claim | verdict | evidence | apply item? |
|---|---|---|---|
| §0.1 FreeRADIUS front-end only; every Access-Request = one rlm_rest POST `/internal/aaa/authorize` | IMPLEMENTED | `raddb/mods-available/rest:40-52` (`timeout = 1.5`, `do_xlat = no`, `body = json`); D-004 | no |
| §0.2 accounting via rlm_sql insert-only into `radius.radacct_raw`, worker drains | IMPLEMENTED | `mods-config/sql/main/postgresql/queries.conf`; pilot 155 raw = 155 `accounting_records`; `apps/worker/src/accounting/drain.ts` | no |
| §0.3 portal credential ≤16 bytes, 90 s, single-use; subscriber passwords stay Argon2 | IMPLEMENTED | `apps/api/src/internal/portal-credential.ts`; D-018; 03-uam-flow row | no |
| §0.3/§2.4/§2.6 PEAP-MSCHAPv2 optional with NT-hash storage (`users.nt_hash`) | MISSING by design | `mods-available/eap:25,51` ttls only; `docs/AAA_AUDIT.md` §3.1 "Unsupported"; no `nt_hash` column | NEEDS-OWNER: §12 Q1 (PEAP with NT-hash) — recommend recording "EAP-TTLS/PAP only" as a DECISIONS row |
| §0.4 EZECLOUD-initiated CoA via `radclient` from the worker, no `originate-coa` | IMPLEMENTED | `apps/worker/src/coa/{dispatcher,radclient}.ts`; no 3799 listener | no |
| §0.5 BlastRADIUS: `require_message_authenticator = yes`, `limit_proxy_state = auto`, per-NAS relaxation column | IMPLEMENTED | `clients.d/dev.conf:25-26`; `nas_clients.require_message_authenticator` (pilot column; AP1832 row `false` because radcli had no Message-Authenticator until b07ce354) | no |
| §1 diagram: RADIUS on the WireGuard hub `100.100.0.1`, worker `raddb-renderer` | SUPERSEDED | D-042 (LAN RADIUS, WireGuard deferred); renderer is the api CLI `radius-clients-cli` + `reload-radius.sh`, not a worker | doc |
| §2.1 pipeline: `filter_username`, `rewrite_*_station_id`, Message-Authenticator on non-EAP replies, `eap`, `rest`; post-auth rest 204 | IMPLEMENTED | `sites-enabled/ecloud:54-88,159,205,236` | no |
| §2.2 UAM PAP/CHAP via broker credential, `Class` echoed, 401 = reject | IMPLEMENTED | `aaa.ts:11,111,127` 200/401 contract; `sites-enabled/ecloud:87-88` | no |
| §2.3 MAC-auth: `Service-Type = Call-Check` or User-Name == Calling-Station-Id; `client_devices` lookup; never compare the MAC password | IMPLEMENTED | `docs/AAA_AUDIT.md` §3.1 MAB rows; `aaa.ts:476` (per AAA_TEST_RESULTS) | no |
| §2.4 802.1X EAP-TTLS/PAP with inner server copying NAS facts | IMPLEMENTED (opt-in, off on pilot) | `sites-available/ecloud-inner`; `docker-entrypoint.sh:160-184`; no `RADIUS_EAP_ENABLED` on host | no |
| §2.5 vouchers never on the wire; voucher typed as username on a splash | PARTIAL | voucher via portal implemented (`portal-identity.ts:248`); "voucher typed as User-Name on a NAS splash" path not found (grep `voucher namespace`: none) | NEEDS-OWNER: is direct-RADIUS voucher login wanted? |
| §3 clients: pilot renders `clients.conf` from `nas_clients`; later `read_clients`/dynamic-clients | IMPLEMENTED | `apps/api/src/radius-clients/{render,run,write}.ts`; dynamic clients built (plan 2A) | no |
| §3 one secret per NAS (no tenant CIDR clients) | IMPLEMENTED | `render.ts` per-row entries; D-042 | no |
| §3 tenant resolution: `Packet-Src-IP-Address` first, `NAS-Identifier` second | SUPERSEDED (Meraki) / IMPLEMENTED | `aaa.ts:209-213` (Hermes §4); D-044 Meraki by NAS-Identifier + secret + UUID shortname (`aaa.ts:240-258`) | no |
| §3 RadSec listener with `require_client_cert = yes`, per-NAS certs | IMPLEMENTED (off) | `sites-available/ecloud-radsec`; `scripts/radsec-ca.sh`; `nas_clients.radsec_*` | no |
| §4.1 rest `timeout = 1.5`, mTLS or bearer token | PARTIAL | `rest:51` 1.5 s; token header `X-Internal-Token` via `$ENV{INTERNAL_API_TOKEN}` (`policy.d/ecloud:42`); TLS leg opt-in, cleartext + ack on pilot | A-14 |
| §4.2 HTTP code mapping; no fail-open; `fail` → reject + linelog alert | IMPLEMENTED (linelog not found) | `sites-enabled/ecloud:66-71,87-88`; no `linelog` in `sites-enabled/ecloud` (grep none) | doc |
| §4.3 reply matrix (WISPr bit/s, ChilliSpot kbit/s, 32-bit `Max-Total-Octets`, VLAN lab-only); Gigawords dictionary gap | IMPLEMENTED | `packages/policy-engine/src/translate.ts`; `raddb/dictionary.ecloud` defines ChilliSpot Gigawords (7 hits) | no |
| §5.2 single INSERT per status type `ON CONFLICT DO NOTHING`, idempotency key | IMPLEMENTED | `queries.conf`; pilot unique counts equal | no |
| §5.3 drain rules; W1 proposed `radacct_raw.drained_at` + partial index | MISSING (schema) | pilot `radius.radacct_raw` columns have no `drained_at`; worker uses a Redis cursor (`W1`) | A-19 (S) NEEDS-OWNER: add `drained_at` or drop the proposal; `docs/AAA_DEPLOYMENT.md` §13 SQL already assumes the column (doc error either way) |
| §6 DAS table; uspot-T Disconnect via hostapd DAS, no Acct-Stop; CoovaChilli needs `User-Name` | IMPLEMENTED (design) / REQUIRES DEVICE TEST | `dispatcher.ts` builds per-adapter identification; D-006; D-065 test pending | A-01 |
| §6 worker binds hub `100.100.0.1` as CoA source (W8) | SUPERSEDED | D-042 LAN pilot; worker sends from the docker bridge via the host | no |
| §6 separate DAS secret `nas_clients.coa_secret_ref` | MISSING | no `coa_secret*` column (pilot columns, migrations grep none); dispatcher uses `secret_ref` (`dispatcher.ts:126,241`) | A-20 (M) NEEDS-OWNER: separate DAS secret (SECURITY_ARCHITECTURE asks for it; the controller's `dynamic-auth` block has its own secret field) |
| §7 no realm on the wire; `split_username_nai` optional | IMPLEMENTED (no realm) | no `split_username_nai` in `sites-enabled/ecloud` (grep none) — optional path not built | no |
| §8 secrets ≥32 random chars, sealed, 0600 render; rotation via UI | IMPLEMENTED | `randomToken(32)`; `sealNasSecret`; rotate route `resources.ts:956`; D-054 | no |
| §8 logging: `log { auth = no … }`, linelog 0600 | PARTIAL | no `auth_badpass`/`linelog` grep hits in Dockerfile/entrypoint/site — radiusd.conf defaults presumed; not verified | doc: state what the image actually logs |
| §8 firewall: 1812/1813 on `100.100.0.1` only; 2083 public optional | SUPERSEDED | D-042/D-043: LAN address + firewalld/DOCKER-USER; host rule verified | no |
| §9 image `freeradius/freeradius-server:3.2.10` pinned by digest | IMPLEMENTED | `infra/freeradius/Dockerfile:17` | no |
| §9 config generation by a worker `raddb-renderer` into a `fr_config` volume with `radiusd -C` pre-check | STALE-DOC | raddb is baked into the image; only `clients.d/ecloud-nas.conf` is rendered (`reload-radius.sh`); `freeradius -C` check in entrypoint | doc |
| §9 reload via `radmin add client file` | STALE-DOC | `reload-radius.sh:4` "SIGHUP does not reload them" → restart; dynamic clients for no-restart | doc |
| §9 health Status-Server 18121 loopback | IMPLEMENTED | `healthcheck.sh:14` | no |
| §9 metrics via `freeradius_exporter`; resources 192 MiB / 0.5 vCPU | PARTIAL / STALE-DOC | no exporter in `infra/monitoring` (not verified beyond listing); compose limits differ (`compose.pilot.yaml:82,151,227,254`) | doc |
| §10 T-A1..T-A15 test matrix | PARTIAL | T-A1 proven on AP1832 (pilot); T-A6/T-A7 unit-level; T-A8/9/11/13 pending (D-065; RadSec local run only) | A-13 |
| §12 open questions 1-7 | see rows | Q2 no fail-open: IMPLEMENTED; Q3: D-043/D-044; Q4: cap 1800 built then exempted for uspot (`enforcement.ts:69-79`); Q5: per-NAS (D-042), DAS secret MISSING; Q6: 7 d (D-025, `jobs/retention.ts`); Q7: `dictionary.ecloud`; Q1 PEAP: NEEDS-OWNER | — |
| §13 device-test list 1-10 | PARTIAL | item 1 (uspot attrs) and 3 (rate honoured 10/10 Mbps) observed on AP1832 2026-10-15; 4-10 pending | A-13 |
| §14 W1-W10 worker notes; `session_actions.status` CHECK lacks `skipped_disabled` | PARTIAL | reaper `lost_interim` (`jobs/reap.ts:13`), retention (`jobs/retention.ts:3`), wrap rules (`drain.ts:12,596`) IMPLEMENTED; `skipped_disabled`/`coa_secret_ref` proposals never migrated (grep none) | A-19/A-20 |
| §14 P7-A: strategy `next_reauth` always today; cap 1800 | IMPLEMENTED, amended | `sessionTimeoutCapFor` returns null for no-silent-reauth adapters (uspot) after cf6ffe7; D-052/D-065 | doc: add the uspot exemption to §14 |

### `HERMES_AAA_AUDIT.md` (40 KB, R2/R4 2026-10-12, read whole in 3 chunks)

| claim | verdict | evidence | apply item? |
|---|---|---|---|
| F-001 NAS-Identifier guard skipped when `nas_identifier` is NULL | IMPLEMENTED as described (still OPEN) | `aaa.ts:747-757`: guard runs only when `nas.nas_identifier !== null`; the strict missing/mismatch branch at `:735-745` is the Meraki path only; pilot NAS has an identifier so unaffected | A-22 (S) NEEDS-OWNER: option A (reject) or B (log + strip) for NULL-identifier NAS, or record as accepted risk in DECISIONS |
| F-002 `User-Password` cleartext to rlm_rest; no production https enforcement | PARTIAL (control built, risk live on pilot) | commit `2599658`; `docker-entrypoint.sh:100-131` refuses non-https in production unless `ECLOUD_INTERNAL_CLEARTEXT_ACK=1` and logs a WARNING; pilot runs `http://api:3001` (no `INTERNAL_TLS_*`/`ECLOUD_INTERNAL_URL` key in `ecloud.env`; compose default) | A-14 |
| F-003 token xlat safety: restrict alphabet, check in Node config | IMPLEMENTED | `packages/shared/src/config.ts:72-77` alphabet rule; entrypoint check `:55,79,290` | doc: mark FIXED |
| F-004 withdrawn | n/a | `aaa.ts:240-258` | no |
| F-005 CHAP retransmit ghost | SUPERSEDED | D-048 accepted, not changed | no |
| F-006 `observeAccessPoint` before `identify()` | SUPERSEDED | D-048 accepted as intentional | no |
| F-007 portal credential ghost | SUPERSEDED | D-049 accepted | no |
| F-008 EAP symlink TOCTOU: verify targets after privilege drop | IMPLEMENTED | `docker-entrypoint.sh:196-198,238` readlink checks ("tampered") | doc: mark FIXED |
| F-009 secrets in `/proc/<pid>/environ` | SUPERSEDED | D-049 accepted (read_only, cap_drop ALL, single process) | no |
| F-010 TIP vendor 58888 TLV undefined | IMPLEMENTED as described (open) | `dictionary.ecloud:28-30` REQUIRES DEVICE TEST | A-21 (S) capture DT-03 vendor TLV bytes on AP1832 (test support allowed by D-058) — NEEDS-OWNER priority |
| F-011 EAP production certificate path REQUIRES_CLARIFICATION | IMPLEMENTED as described (open) | `docker-entrypoint.sh:159-166` mount contract; no PKI decision | NEEDS-OWNER: EAP cert source (internal CA via `make-lan-tls.sh`-style vs public CA) |
| F-012 negative-path tests for F-001/F-005/F-006/F-003 | PARTIAL | F-001 mismatch case covered (`cycle-e.integration.test.ts`), NULL case not; F-005/F-006 accepted (D-048) so no test; F-003 token-alphabet covered by `config-hardening.test.ts` (per Hermes 12; not re-read) | no |
| Summary counts: 10 OPEN, 0 FIXED, 0 ACCEPTED | STALE-DOC | F-003/F-008 fixed; F-005/006/007/009 accepted (D-048/D-049); F-002 mitigated | doc: refresh the status table |
| Positive observations 1-32 (fail-closed, BlastRADIUS, do_xlat, VerifyGate, scrubbing, FORBIDDEN_REPLY_ATTRIBUTES, Meraki identity, RLS matrix, CoA secret file, Meraki DAS host regex, ACK-only, wrap rules, advisory locks, markOnce) | IMPLEMENTED | spot-checked: `aaa.ts` FORBIDDEN filter (`:878-880` above), `drain.ts` wrap, `radclient.ts`, `sites-enabled/ecloud:75-80`; others as cited by Hermes with file:line, not re-read tonight | no |
| Observation 16 TOTP MFA with 5 attempts | SUPERSEDED (MFA off) | D-046 `ADMIN_MFA_MODE` default `off` (`config.ts:47`) | no |
| Phase 7 TOTP replay (`afterTimeStep` unused) | IMPLEMENTED as described, moot | MFA off (D-046) | no |

### `NETWORK_INTEGRATION.md` (37 KB, A2 design 2026-10-07, read whole in 2 chunks)

| claim | verdict | evidence | apply item? |
|---|---|---|---|
| §1.1 per-SSID `rate-limit.{ingress,egress}` Mbit/s via uCentral | IMPLEMENTED (fragment) | `packages/adapters/src/openwifi/ucentral-fragment.ts:3,39` (`ucentral-ssid-rate-limit/v1`, VERIFIED_FROM_SOURCE per D-028) | no |
| §1.2 per-client RADIUS bandwidth only on the uspot path (WISPr bps / ChilliSpot kbps) | IMPLEMENTED | `packages/adapters/src/adapters/openwifi-uspot-uam.ts:34,76-77`; AP1832 applied 10000000/10000000 bps 2026-10-15 (PILOT_OBSERVATIONS) — first device evidence | A-13 (evidence registry) |
| §1.3 uspot honours Session-Timeout/Idle-Timeout/Acct-Interim-Interval/Max-Total-Octets; accounting | IMPLEMENTED (server) / device: Session-Timeout proven | PILOT_OBSERVATIONS: timeout at exactly 1800 s observed; 155 accounting rows | no |
| §1.4 CoA/Disconnect via `dynamic-authorization`; uspot kicks on hostapd `coa`; REQUIRES DEVICE TEST | PARTIAL | D-006; D-065 test deferred; worker CoA path built; `ECLOUD_COA_ENABLED` off on pilot | A-01, A-09 |
| §1.5 captive portal only on a downstream interface | OUT-OF-SCOPE (controller/firmware fact) | consistent with 02-root-causes B2 | no |
| §1.6 auth paths (802.1X, MAC-auth, uspot radius/uam, click-to-continue) | IMPLEMENTED (adapters) | `packages/adapters/src/adapters/{openwifi-hostapd-radius,openwifi-uspot-uam,uspot-upstream-uam,openwifi-config}.ts`; registry `registry.ts:7-14` | no |
| §1.7 EZE controller gateway on 15002 pushes `configure` | OUT-OF-SCOPE | controller (D-058) | no |
| §1.10 two adapters `openwifi-radius` + `openwifi-config` | IMPLEMENTED (renamed) | keys `openwifi-hostapd-radius`, `openwifi-uspot-uam`, `openwifi-config` (D-035) | doc: names |
| §2 capability matrix rows (burst unsupported, daily/monthly quota EZECLOUD-side, concurrency EZECLOUD-side) | IMPLEMENTED | `packages/policy-engine/src/{resolve,enforcement}.ts`; adapters declare burst UNSUPPORTED (AAA_AUDIT §4) | no |
| §5 runtime control via uCentral `configure`/`script` | OUT-OF-SCOPE | controller | no |
| §7 architecture: PTL → adapters; telemetry adapter from controller state | PARTIAL | policy engine + adapters built; controller inventory job exists (`apps/worker/src/jobs/controller-inventory.ts`); telemetry (associations) ingest not verified | NEEDS-OWNER: is controller-state telemetry (option A) still planned under D-058? |
| §7.3 config adapter secrets injected at push time, never in Git | IMPLEMENTED (design) | D-033; `controllers` table + `rotate-credential` route (`routes/controllers.ts:425`) | no |
| §8 option C for the pilot, evolve to A; never B | IMPLEMENTED (decision) | D-013; `routes/openwifi-config.ts` fragments exist; D-058 pauses the controller half | no |
| §8 dependency: fixed WireGuard hub IP for `dynamic-authorization.host` | SUPERSEDED | D-042: LAN pilot, host IP 192.168.203.196 is the DAS client | no |
| §10 open questions 1-6 | mostly answered | Q1: open+portal pilot (AP1832); Q2: accepted (AP-routed hotspot subnet); Q3: both units supported; Q4: D-013; Q5: AP1832 provided (D-034); Q6: superseded by D-042 | no |
| §11 device tests 1-12 | PARTIAL | item 2 partially proven (rate + Session-Timeout on AP1832); 1,3-12 pending; CoA = D-065 | A-13 |

### `WIREGUARD_ARCHITECTURE.md` (42 KB, A1 design 2026-10-07, read whole in 2 chunks)

| claim | verdict | evidence | apply item? |
|---|---|---|---|
| §1 W1-W14 WireGuard facts (UDP, cryptokey routing, roaming, keepalive 25 s, MTU 1420, in-tree ≥5.6, no TCP) | IMPLEMENTED (reference facts, no system claim) | upstream citations only | no |
| §2 pilot VPS facts: Ubuntu 6.8 kernel, `57.129.69.122`, module present, tools absent | SUPERSEDED | D-041/D-043: that VPS is cancelled; pilot host is `vps-local` (Oracle Linux 8, 192.168.203.196) — not re-checked for WireGuard tonight | doc: mark historical |
| §3 EZEAP cannot be a plain WireGuard peer; `service.wireguard-overlay` = unetd; topology B REQUIRES DEVICE TEST | OUT-OF-SCOPE (firmware/controller fact) | D-010 records it | no |
| §4 topology A (site gateway peer) primary, C (RadSec) mandatory fallback, B after device test | SUPERSEDED (deferred) | D-010 approved the design; D-042 defers WireGuard "until remote sites exist"; D-043 LAN-only; D-044 Meraki cloud RADIUS amends D-032 | no |
| §5 address plan `100.100.0.0/16`, hub `100.100.0.1`, `/24` per tenant, UDP 51820 | SUPERSEDED (deferred) | D-032 fixed the hub/port "subject to collision verification"; D-042 deferred | no |
| §6 impact table: CIDR clients per tenant block | SUPERSEDED | AAA_ARCHITECTURE §3 and D-042: one secret per NAS, no tenant CIDR clients; `render.ts` per-row | no |
| §7 host-native systemd-networkd `.netdev` on the hub | MISSING (deferred) | no `infra/vps*/` WireGuard unit or netdev (grep `wireguard` in infra: none) | no apply until D-042 is reopened |
| §8 peer provisioning: table `vpn_peers(...)`, worker reconcile with `wg set`, rotation, revocation, audit | PARTIAL | table exists as `wireguard_peers` (`packages/db/migrations/003_network.sql:63-65`, RLS in 010), 0 rows on the pilot; `apps/api/src/routes/platform-ops.ts` references it; no reconcile worker (grep `wg set`: none) | NEEDS-OWNER: keep `wireguard_peers` dormant or build the reconcile job when a remote site exists |
| §9 nftables hub rules (`inet ecloud` table, no site-to-site, 3799 egress) | SUPERSEDED | pilot uses firewalld + DOCKER-USER on vps-local (`infra/vps-local/firewall/docker-user.sh`), LAN-only (D-042/D-043) | no |
| §10 failure modes; NAS `secondary` RADIUS server as fallback | IMPLEMENTED (design) / NEEDS-OWNER | `docs/AAA_IMPLEMENTATION_PLAN.md` 2C: NAS secondary pointed at a second host "when one exists" | NEEDS-OWNER (second host) |
| §11 production portability (multi-hub, HA, anycast) | NEEDS-OWNER | no decision after D-043; pilot is single-host | NEEDS-OWNER: target production topology |
| Open questions 1-8 (Q16 LAN ranges, Q3/Q4 gateways, Q8 approval, CoA must-have, ownership, topology B, SNMP, OVH firewall) | PARTIAL | Q8 answered by D-032/D-042; CoA stays REQUIRES_DEVICE_TEST (D-006/D-065); OVH question moot (D-043); Q16/Q3/Q4/5/6/7 unanswered | NEEDS-OWNER (only when remote sites are planned) |
| Device tests T1-T8 | OUT-OF-SCOPE / deferred | firmware/AP tests; D-042 | list only |

### `ECLOUD_MULTI_VENDOR_HOTSPOT.md` (22 KB, owner prompt/spec 2026-10-07)

| claim | verdict | evidence | apply item? |
|---|---|---|---|
| §0 multi-tenant hierarchy, `resource:action` permissions, policy specificity order | IMPLEMENTED | D-007, D-021, D-022; `packages/policy-engine/src/resolve.ts` | no |
| §0 VPS is a control/AAA plane, not the shaper; adapters declare 4-state capabilities | IMPLEMENTED | D-003, D-028; `packages/adapters/src/types.ts:89-102` (`capabilities`, `translate`, `buildDisconnect`, `buildCoa`) | no |
| §0 D-006 CoA stays REQUIRES_DEVICE_TEST | IMPLEMENTED | D-006, D-065; `adapter_types.verification_status = unknown` (12/12) | no |
| §0 pilot RADIUS WireGuard-tunnel-only; RadSec fallback | SUPERSEDED | D-042 (LAN), D-044 (Meraki cloud RADIUS build/test only) | no |
| §0 hostnames `api.ezecloud.ezelink.ai` / `portal.ezecloud.ezelink.ai`; native Caddy; `q-mira.com` | SUPERSEDED | D-047 (`api.ezelink.ai`, `portal.ezelink.ai`); D-043 (vps-local edge container, no Caddy) | doc |
| §2 Cambium first third-party adapter; then MikroTik, UniFi, Omada | IMPLEMENTED (reordered) | Cycle B MikroTik/Teltonika, C postback (`cambium-hotspot` profile `postback/profiles.ts:135-143`), D UniFi/Omada/Mist (D-044 order) | no |
| §2 two deployment modes native / gateway | IMPLEMENTED | `nas_clients.deployment_mode`; registry `deploymentModes` (VENDOR_RESEARCH §3 gap row) | no |
| §3 adapter interface (`discoverCapabilities … healthCheck`) | PARTIAL | `VendorAdapter` has `parseRedirect`/`validateContext`/`buildSetupGuide` (`packages/adapters/src/vendor/types.ts`); no `healthCheck` or `discoverCapabilities` operation found (grep in `vendor/types.ts` not re-read) | NEEDS-OWNER: is a vendor `healthCheck` wanted? |
| §4 Cambium: `ga_*` params, `hotspot_login.cgi` on 880/444, cnMaestro EasyPass as optional strategy | PARTIAL | `cambium-hotspot` profile built (postback); cnMaestro API strategy not built (`packages/vendor-api/src` has unifi/omada/mist/ruckus only) | NEEDS-OWNER: cnMaestro EasyPass priority |
| §5 portal: branding per org/site, EN + AR RTL, click-through, voucher, local credentials first; email/SMS OTP and OAuth as providers | PARTIAL | `apps/portal/src/i18n.ts`, `styles.ts` (rtl); methods `click_through/password/voucher/email_otp/sms_otp` (`packages/shared/src/portal-methods.ts:68-72`); email OTP live (D-060); SMS provider and OAuth not built | NEEDS-OWNER: SMS provider; OIDC priority |
| §5 consent/retention/export/deletion with tenant isolation | PARTIAL | migration 049 (registration + terms acceptance); retention job (`jobs/retention.ts`); subscriber export/deletion not verified in this lane (Lane 3) | defer to Lane 3 |
| §6 strong per-NAS secrets, reject unknown NAS, NAT-aware tenant resolution, RadSec on verified endpoints | IMPLEMENTED | `render.ts`, `aaa.ts:209-213`; RadSec built/off; D-044 Meraki | no |
| §6 never silently accept unenforceable settings; CoA only after verification else next login | IMPLEMENTED | `policy_translations`, `chooseEnforcementStrategy` `next_reauth` (`policy-engine/src/enforcement.ts`) | no |
| §6 accounting normalisation (retransmit, out-of-order, missing Stop, restart, rollover, gigawords) | IMPLEMENTED | `apps/worker/src/accounting/{drain,normalize}.ts`; `jobs/reap.ts`; AAA_TEST_RESULTS §7 | no |
| §7 signed short-lived portal state, replay protection, rate limits, SSRF/redirect allowlists, no long-lived keys in HTML | IMPLEMENTED | Hermes positive observations 19, 22; `safeUserUrl`; `portal_state_secret` host secret | no |
| §7 fail-open/fail-closed per site explicit | PARTIAL | global fail-closed (no per-site switch found) | NEEDS-OWNER: per-site fail-open ever wanted? (recommend no) |
| §8 EZECONTROL dashboard views (Hardware Integrations, setup wizard, diagnostics, support bundles) | PARTIAL / OUT-OF-SCOPE | setup guides API (`routes/setup-guides.ts:225,245`), vendor gallery (`vendor/gallery.ts`); no support-bundle/diagnostics route (grep none); "EZECONTROL" naming = the EZECLOUD admin here, not the controller | A-23 (M) diagnostics/support bundle — NEEDS-OWNER priority |
| §9 phases: foundation → device validation → Cambium → MikroTik/UniFi/Omada → enterprise | IMPLEMENTED (code) / device validation pending | cycles A-E done 2026-10-10 (D-044); AP1832 uspot pilot is the first device evidence | A-13 |
| §11 bounded agentic loop, promote only evidenced results | IMPLEMENTED (process) | `packages/shared/src/evidence.ts:4-14` rules V12/R-39 | no |

### `docs/VENDOR_INTEGRATION_RESEARCH.md` (67 KB, research 2026-10-10, read in 2 chunks: lines 1-180, 181-355, lines trimmed)

| claim | verdict | evidence | apply item? |
|---|---|---|---|
| §0 everything here is `DOCUMENTED`; no cell `VERIFIED_SUPPORTED` | IMPLEMENTED (honesty rule) | `adapter_types.verification_status = unknown` ×12 on the pilot; `evidence.ts` | no |
| §1 summary table (24 vendor rows) | IMPLEMENTED as research | pilot `vendors` 29 rows, `compatibility_entries` 33 (registry seeded) | no |
| §2 families F1-F9 → adapter keys | IMPLEMENTED | 12 keys on the pilot: F1 `coovachilli-uam`/uspot ×2, F2 `mikrotik-hotspot`, F3 `external-portal-postback`, F4 `meraki-splash`, F5 `unifi-external-portal`, F6 `omada-api`, F7 `mist-guest-portal`, F9 `generic-radius-8021x`, plus `openwifi-config`, `openwifi-hostapd-radius`; F8 Ruckus NBI = stub only (`packages/vendor-api/src/ruckus.ts`) | no |
| §3 contract gaps: `findNas` by AP MAC/controller, nonce replay key, vendor credentials store, MikroTik rate family, API-limits output, multi deployment modes, cloud RADIUS | IMPLEMENTED | migrations 028-032; `packages/policy-engine/src/api-limits.ts` (`translateApiLimits`); `packages/vendor-api/src/credentials.ts`; D-044 | no |
| §3.1 F9 generic 802.1X with opt-in EAP-TTLS | IMPLEMENTED (EAP off on pilot) | `adapters/generic-radius-8021x.ts`; entrypoint EAP gate | no |
| §3.3 MikroTik: CoA port 1700, Message-Authenticator required, CHAP hand-off | IMPLEMENTED | `vendor/mikrotik.ts:469`, tests `:461-500`; `aaa.ts:833` | no |
| §3.4 F3 postback profiles (`cisco-webauth`, `aruba-ecp`, `fortinet-ecp`, `ruckus-wispr`, `cambium-hotspot`, `omada-external-portal`, `huawei-portal`, `postback-generic`) | IMPLEMENTED | `packages/adapters/src/vendor/postback/profiles.ts` (cambium `:135-143`) | no |
| §3.5 Meraki: `MERAKI_CLOUD_RADIUS_ENABLED` default OFF; Disconnect only; `Filter-Id` rates | IMPLEMENTED (flag off) | `apps/api/src/config.ts` flag; `sites-enabled/ecloud-meraki`, `raddb/meraki.d/00-disabled.conf`; D-044 build/test only | no |
| §3.6 UniFi: authorise via Network API; revoke `UNAUTHORIZE_GUEST_ACCESS` | PARTIAL | `packages/vendor-api/src/unifi.ts` authorise built; revoke not implemented (§8 says so; grep `UNAUTHORIZE_GUEST_ACCESS` count printed above) | A-24 (S) UniFi revoke action — NEEDS-OWNER priority (no UniFi lab device) |
| §3.7 Omada API mode ≥ 6.2.10 | IMPLEMENTED (6.2.10 form only) | `packages/vendor-api/src/omada.ts` | no |
| §3.8 Mist signed grant; JWT alternative documented, not implemented | IMPLEMENTED / MISSING (JWT) | `packages/vendor-api/src/mist.ts` | NEEDS-OWNER (wired captive portal needs JWT) |
| §4 build order steps 1-10 | IMPLEMENTED through step 9 (code); step 10 long tail after lab capture | D-044 roadmap | no |
| §5 setup-guide gallery: values filled at render, "tested on" only from LAB_VALIDATED DT results | IMPLEMENTED | `routes/setup-guides.ts`; `packages/adapters/src/registry/dt-results.ts`; `vendor/gallery.ts` | no |
| §5 RADIUS server value = WireGuard hub `100.100.0.1` or RadSec endpoint | SUPERSEDED | D-042: LAN address 192.168.203.196 | doc: guides must show the deployment's RADIUS address (verify `setup-guides.ts` reads config, not a constant) |
| §5 portal path scheme REQUIRES_CLARIFICATION; hostname `portal.ezecloud.ezelink.ai` | SUPERSEDED | D-047 `portal.ezelink.ai`; paths `/uam/uspot/`, `/pb/<profile>/<nasid>/`, `/mikrotik/` exist | doc |
| §6 open questions 1-14 | PARTIAL | 1 resolved (D-044); 9 partly resolved (JWT documented); 2-8, 10-14 open, all REQUIRES_DEVICE_TEST/lab | NEEDS-OWNER: which vendors get lab hardware next (D-034) |
| §8 Cycle D status table | IMPLEMENTED | files listed exist (`unifi.ts`, `omada.ts`, `mist.ts`, `ruckus.ts`, `api-limits.ts`, `credentials.ts`) | no |

### `infra/freeradius/README.md` (44.6 KB, read whole in 2 chunks; appendix = contract copy)

| claim | verdict | evidence | apply item? |
|---|---|---|---|
| Layout: Dockerfile, entrypoint, healthcheck, raddb overlay (sites-enabled/ecloud, status, ecloud-inner, eap, rest, sql, queries.conf, policy.d/ecloud, clients.d/dev.conf, dictionary.ecloud), test/ | IMPLEMENTED | `find infra/freeradius` listing above matches, plus `rest_clients`, `ecloud-dynamic-clients`, `ecloud-radsec`, `ecloud-meraki`, `meraki.d/` which the tree block omits | doc: add the Phase 2A/3A/E files to the tree block |
| §1 mapping rows (rest authorize, pipeline, PAP/CHAP/MS-CHAP, EAP opt-in, rendered clients, no fail-open, Gigawords dictionary, insert-only SQL, `acct_unique` on `Class`, no 3799 listener, BlastRADIUS, `-l stdout`, image pin, `-C` at build) | IMPLEMENTED | `Dockerfile:17`; `sites-enabled/ecloud`; `dictionary.ecloud:71-85`; `healthcheck.sh`; `docker-entrypoint.sh` | no |
| §2 production publishes `${RADIUS_BIND_IP}:1812-1813` = WireGuard hub `100.100.0.1` (D-032) | STALE-DOC / SUPERSEDED | `compose.pilot.yaml:417` still `100.100.0.1:1812`; the vps-local override publishes `${ECLOUD_LAN_IP}:1812` (`compose.vps-local.yaml:74`), D-042 | doc |
| §2 production resources 192 MiB / 0.5 vCPU | STALE-DOC | `compose.pilot.yaml:287` freeradius `memory: 320M, cpus: '0.5'` | doc |
| §2 `ECLOUD_INTERNAL_URL` credential-bearing leg (F-002) with `RADIUS_CLIENTS_RENDERED` production check | IMPLEMENTED (ack on pilot) | `docker-entrypoint.sh:100-131`; pilot runs cleartext with `ECLOUD_INTERNAL_CLEARTEXT_ACK` (compose default) | A-14 |
| §2 env table incl. `RADIUS_DYNAMIC_CLIENT_SUBNET`/`_LIFETIME`, token alphabet `[A-Za-z0-9_-]+` | IMPLEMENTED | `docker-entrypoint.sh:55,68,73,79`; `packages/shared/src/config.ts:72-77` | no |
| §3 `do_xlat = no` ignored on 3.2.10; API must use object form | IMPLEMENTED | `apps/api/src/internal/radius.ts:4-5` | no |
| §4 dictionary decisions (ChilliSpot 15/21-24, no CoovaChilli aliases, TIP 58888 undefined, ECLOUD-* 3000-3009, MikroTik stock) | IMPLEMENTED | `raddb/dictionary.ecloud:28-30,71-85` | A-21 (TIP TLV capture) |
| §5 smoke verification 2026-10-07 and M8 | IMPLEMENTED (historical evidence) | not re-run | no |
| §5b silent discard when the NAS omits Message-Authenticator; radcli 1.3.0 gate; fix = radcli patch, else per-NAS relaxation | IMPLEMENTED | firmware fix b07ce354 (brief; memory `radcli-no-message-authenticator`, patch 020); pilot NAS row has `require_message_authenticator = false` (SELECT) — relaxation path (fix 2) was used and is still in force although the AP now carries fix 1 | A-25 (S) NEEDS-OWNER: set `require_message_authenticator = true` again on `d82d9ba1a1aa` now that AP1832 runs b07ce354 (re-render + reload; closes the CVE-2024-3596 relaxation) |
| §5b `radiusd.conf` has `auth = no`; ground truth = api log + `auth_events` | IMPLEMENTED | `radius.radpostauth_raw` 0 rows, `auth_events` table present on pilot | no |
| §6.1 `ecloud_radius` role not provisioned in the dev stack | STALE-DOC | `infra/compose/postgres-init/01_roles.sql:8-23` creates `ecloud_radius` with `\getenv radius_password` | doc |
| §6.2 `packet_src_ip` done (014) | IMPLEMENTED | pilot `radius.radacct_raw` has `packet_src_ip`, `packet_client_shortname`, `packet_tls_client_cn/serial` | no |
| §6.3 RadSec, `read_clients`, `radpostauth_raw`, linelog "outside this milestone"; EAP cert REQUIRES_CLARIFICATION | PARTIAL / STALE-DOC | RadSec now §9 (built); `radius.radpostauth_raw` table exists (empty); linelog absent; EAP cert still open (F-011) | doc; NEEDS-OWNER (EAP cert) |
| §7 EAP-TTLS opt-in contract (root for the link step, cert dir, `-C` twice, eapol_test local run) | IMPLEMENTED | `docker-entrypoint.sh:159-207`; `mods-available/eap:25,51` | no |
| §8 Meraki listeners off by default; `MERAKI_RADIUS_FILE`; schema check for `packet_client_shortname`; `RADIUS_SCHEMA_WAIT_S` | IMPLEMENTED | `config.ts:227`; `raddb/meraki.d/00-disabled.conf`; entrypoint schema check (Hermes obs. 14) | no |
| §9 RadSec opt-in: TCP 2083, `require_client_cert`, CN/serial columns, F-008 link check; CoA behind NAT unsupported; unique `nas_ip` REQUIRES_CLARIFICATION | IMPLEMENTED (off on pilot) | `sites-available/ecloud-radsec`; `docker-entrypoint.sh:232-238`; `radsec_enabled = false` on the pilot NAS | NEEDS-OWNER (plan 3A open items) |
| Appendix "identical copy of docs/contracts/aaa-authorize.md; keep both identical" | IMPLEMENTED | `diff` of the appendix vs `docs/contracts/aaa-authorize.md`: only the contract's H1 line differs (1 line) | no |
| Appendix §1 timeouts (authorize 1.0/1.5 s, post-auth 1.0/1.0 s), pool max 8, no retries | IMPLEMENTED | `mods-available/rest:44,51` | no |
| Appendix §3 rules 1-7 (object form, Auth-Type set, per-adapter attributes, `Class = ai:<32hex>`, Session-Timeout cap, no `User-Password` in reply) | IMPLEMENTED | `radius.ts:4-5,83`; `aaa.ts:878-880` FORBIDDEN filter; cap rule amended for uspot (`enforcement.ts:69-79`) | doc: rule 6 should note the no-silent-reauth exemption |
| Appendix §4 status mapping, §5 post-auth 204 with `ECLOUD-*` outcome fields, Cycle E Meraki reject reasons | IMPLEMENTED | `sites-enabled/ecloud:87-88,205,236`; `aaa.ts:735-745` (`nas_identifier_missing`/`mismatch`), `:240-258` shortname | no |

## Apply-item index (for the merge; ids are lane-local)

| id | item | source doc § | size | needs owner? |
|---|---|---|---|---|
| A-01 | Run the D-065 CoA/Disconnect device test on AP1832 and write the evidence-registry entry so `chooseEnforcementStrategy` can leave `next_reauth` | PILOT_OBSERVATIONS; AAA_ARCHITECTURE §6/§13; AAA_TEST_RESULTS §9 | S (test) | yes (owner at the AP; D-065) |
| A-02 | Add the iOS captive-detection note to end-user troubleshooting text | PILOT_OBSERVATIONS | S | no |
| A-03 | Metric/alert on `fleetDefaultSecret` run-summary count (CLI warning only today) | RENDERER_SECRET_FLOOR §"Visibility" | S | yes (D-064 dropped the badge; metric half unnamed) |
| A-04 | Renderer rule: refuse the fleet default secret on Meraki cloud entries | RENDERER_SECRET_FLOOR §"Zero on Meraki" | S | no (Meraki build/test only, D-044) |
| A-05 | Run one real email-OTP login on the pilot (`otp_codes` is empty) and record it | SMTP_DEPLOY_AND_TEST §5 | S | no |
| A-06 | Self-service administrator change-password route (sessions revoked, audited) | READONLY_REVIEW §2 | M | yes (MFA off, D-046) |
| A-07 | Drop the "DRAFT, NOT RUN" header from `apply-firewall.sh`; bound `DEADMAN_SECONDS` | READONLY_REVIEW §3; AAA_IMPLEMENTATION_PLAN 8A | S | no |
| A-08 | Install `radius-reload-watch.sh` + `reload-radius.sh` + cron on vps-local (not installed; `/opt/ecloud/bin` lacks both) or document manual reload | AAA_DEPLOYMENT §14 | S (host change, change-list id) | yes (host change) |
| A-09 | Set `ECLOUD_COA_ENABLED=true` on the worker and `coa_supported`/`coa_port` on NAS `d82d9ba1a1aa` before the D-065 test (both unset today) | AAA_DEPLOYMENT §8; AAA_AUDIT §6 | S | yes |
| A-10 | Fix doc: `/healthz`, real metric names; decide whether an alert pipeline is wanted | AAA_DEPLOYMENT §10 | S | yes (alerting) |
| A-11 | Reject-reason tests: `user_expired`, `user_not_yet_valid`, `device_blocked`, unknown MAC | AAA_TEST_RESULTS §3-4 | S | no |
| A-12 | Per-NAS CoA rate limit in the dispatcher | AAA_IMPLEMENTATION_PLAN 5B; AAA_TEST_RESULTS §8 | M | yes (priority) |
| A-13 | Record the AP1832 pilot evidence (uspot PAP/UAM accept, 10/10 Mbps applied, Session-Timeout honoured) in AAA_TEST_RESULTS §9, AAA_ARCHITECTURE §10/§13 and `dt-results.ts` | AAA_TEST_RESULTS §9; NETWORK_INTEGRATION §11 | S | no |
| A-14 | Enable the TLS leg FreeRADIUS→api on vps-local (`make-lan-tls.sh`, `INTERNAL_TLS_*`, `ECLOUD_INTERNAL_URL=https://api:3001`); removes the F-002 cleartext ack and the D-061 cleartext condition | HERMES F-002; AAA_IMPLEMENTATION_PLAN 3C | M (host change) | yes (host change) |
| A-15 | Apply migration 049 with the next deploy (ledger at 048) | AAA_IMPLEMENTATION_PLAN 4E | S (A6 gate) | yes (deploy) |
| A-16 | Mid-session voucher/validity expiry enforcement job | AAA_IMPLEMENTATION_PLAN 5C; AAA_AUDIT §6 | M | yes (priority) |
| A-17 | `ExecStartPre` re-arm of DOCKER-USER before Docker starts | AAA_IMPLEMENTATION_PLAN 8B | S (host) | yes |
| A-18 | Key-rotation runbook around `secret-reseal-cli.js` (`DATA_ENCRYPTION_KEY`, `MFA_ENCRYPTION_KEY`, peppers) | AAA_IMPLEMENTATION_PLAN 8C | S (doc) | no |
| A-19 | Decide `radius.radacct_raw.drained_at` (proposed, never migrated; AAA_DEPLOYMENT §13 SQL assumes it) | AAA_ARCHITECTURE §14 W1 | S | yes |
| A-20 | Separate DAS/CoA secret per NAS (`coa_secret_ref`) | AAA_ARCHITECTURE §6/§14; SECURITY_ARCHITECTURE | M | yes |
| A-21 | Capture the TIP vendor 58888 TLV bytes on AP1832 (DT-03) and define it in `dictionary.ecloud` | HERMES F-010; freeradius README §4 | S (test support, D-058 allows) | yes (priority) |
| A-22 | F-001: NULL `nas_identifier` guard (reject, or log+strip, or record as accepted risk) | HERMES F-001 | S | yes |
| A-23 | Diagnostics / redacted support bundle route | ECLOUD_MULTI_VENDOR_HOTSPOT §8 | M | yes (priority) |
| A-24 | UniFi `UNAUTHORIZE_GUEST_ACCESS` revoke action | VENDOR_INTEGRATION_RESEARCH §3.6/§8 | S | yes (no lab device) |
| A-25 | Re-enable `require_message_authenticator = true` on NAS `d82d9ba1a1aa` now that AP1832 runs b07ce354; re-render + reload | freeradius README §5b | S | yes (touches the live NAS row) |

Doc-fix candidates (STALE-DOC, 45 rows) cluster in: `docs/AAA_DEPLOYMENT.md` (routes, env names, hot-reload, WireGuard, `/health`), `docs/AAA_COMPATIBILITY_MATRIX.md` (12 adapter keys, RadSec, IPv6, billing), `docs/AAA_AUDIT.md`/`HERMES_AAA_AUDIT.md` status tables, `AAA_ARCHITECTURE.md` §1/§9/§14 (hub address, renderer, uspot cap exemption), `infra/freeradius/README.md` §2/§6, and the five 2026-10-13 UAM hand-off docs (now historical).
