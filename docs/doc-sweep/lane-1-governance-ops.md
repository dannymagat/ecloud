# Lane 1 — Governance, status, ops, deployment, dev/test docs, VPS change lists

- Worker: Orchestrator sub-agent (Fable 5.1), read-only.
- Start 2026-10-15 21:46 +04, end 2026-10-15 22:40 +04.
- Repository: `feature/universal-aaa` at `be95176` (working tree has 11 uncommitted paths, incl. untracked `packages/db/migrations/049_portal_registration_devices.sql`).
- Files: 27, all read end-to-end with the Read tool. None exceeded 60 KB; no file was chunked.
- Host checks (`ssh vps-local`, read-only, no sudo): `docker ps`/`docker inspect`/`docker images`, `systemctl is-enabled/is-active`, `ss -lntu`, `ls` of `/opt/ecloud`, `/etc/ecloud`, `/etc/systemd/system`, non-secret keys of `/opt/ecloud/ecloud.env`, and SQL `SELECT` through `docker exec -i ecloud-postgres psql`. The `sudo -n` forms were not needed and not attempted. Denied: none by the permission system; `ls /opt/ecloud/secrets` and `ls /data/ecloud-backups` are `Permission denied` for `ezeadmin` (expected, not retried).
- Host facts used below (all verified 21:55–22:10 +04): 7 containers healthy, all tagged `0e8f735`; image ids show api `9a0c77f47b51` = tag `1592364`, worker `b8065c7a3384` = tag `7afd5fe`, edge `b914c7259434` = admin tag `d7795a7`, portal/freeradius `0e8f735`. Listeners: tcp `0.0.0.0:443`, `0.0.0.0:444`, udp `192.168.203.196:1812/1813`, tcp `127.0.0.1:6379` (system Redis). `schema_migrations` = 48 rows, max `048_secret_version_trigger_split`. `permissions` = 112. `administrators`: `danny@ezelink.com` active, `admin@ezecloud.local` disabled. `users.sample.valid_until` NULL. `nas_clients` 1 (`enc:v2.`), `captive_portals` 1 (`enc:v2.`). `platform_default_policy` enabled, 10000/10000 kbps, 86400 s. Sessions last 24 h: 9 (`active`,`stopped`); `accounting_records` 153; `session_actions` 0; `audit_logs` `platform:password_reset` 0. `ecloud-backup.timer` enabled/active (last run 06:24 +04 today); `ecloud-docker-user` enabled/active; `ecloud-check.timer` absent. api env: `NODE_ENV=production`, `ADMIN_MFA_MODE=off`, `TRUST_PROXY_HOPS=1`, `STORAGE_DRIVER=local`, `STORAGE_LOCAL_ALLOW_PRODUCTION=true`, `INTERNAL_CLEARTEXT_ACK=1`, `INTERNAL_SECRET_TOKEN_FILE`, `SMTP_PASSWORD_FILE`. worker env: `INTERNAL_SECRET_TOKEN_FILE`, `ECLOUD_INTERNAL_URL=http://api:3001`; **no `ECLOUD_COA_ENABLED`, no `RETENTION_APPLY`** (both default false). `/etc/ecloud/docker-user.env`: web CIDR `192.168.203.0/24`, RADIUS CIDR `192.168.203.0/24`.
- Repository facts used below: `PERMISSION_CATALOGUE.length` 112, `ROLE_TEMPLATES` 6, `TENANT_SCOPED_TABLES.length` 46, `PLATFORM_TABLES` 11 (from `packages/*/dist`); OpenAPI 113 paths (`apps/admin/src/api/openapi.json`); CI jobs `secrets`, `supply-chain`, `check`, `integration`, `radius-contract`, `images` (`.github/workflows/ci.yml`); `AGENT_LANES.md` (cited by D-053) does not exist in the repo; `BRIEF.md` (cited by DEPLOYMENT_ARCHITECTURE evidence index) does not exist.

## Checklist

- [x] `.claude-to-hermes.md` — 10 claims, IMPLEMENTED 6, PARTIAL 0, MISSING 1, STALE-DOC 1, SUPERSEDED 1, OUT-OF-SCOPE 0, NEEDS-OWNER 1
- [x] `.hermes-coordination.md` — 4 claims, IMPLEMENTED 1, PARTIAL 0, MISSING 0, STALE-DOC 2, SUPERSEDED 1, OUT-OF-SCOPE 0, NEEDS-OWNER 0
- [x] `AGENTS.md` — 3 claims, IMPLEMENTED 0, PARTIAL 2, MISSING 1, STALE-DOC 0, SUPERSEDED 0, OUT-OF-SCOPE 0, NEEDS-OWNER 0
- [x] `AGENT_TASK_TEMPLATE.md` — 1 claim, IMPLEMENTED 1, PARTIAL 0, MISSING 0, STALE-DOC 0, SUPERSEDED 0, OUT-OF-SCOPE 0, NEEDS-OWNER 0
- [x] `ARCHITECTURE.md` — 3 claims, IMPLEMENTED 1, PARTIAL 1, MISSING 0, STALE-DOC 1, SUPERSEDED 0, OUT-OF-SCOPE 0, NEEDS-OWNER 0
- [x] `CLAUDE.md` — 5 claims, IMPLEMENTED 2, PARTIAL 0, MISSING 0, STALE-DOC 3, SUPERSEDED 0, OUT-OF-SCOPE 0, NEEDS-OWNER 0
- [x] `DECISIONS.md` — 16 claims, IMPLEMENTED 12, PARTIAL 4, MISSING 0, STALE-DOC 0, SUPERSEDED 0, OUT-OF-SCOPE 0, NEEDS-OWNER 0
- [x] `DEPLOYMENT_ARCHITECTURE.md` — 12 claims, IMPLEMENTED 4, PARTIAL 1, MISSING 2, STALE-DOC 1, SUPERSEDED 4, OUT-OF-SCOPE 0, NEEDS-OWNER 0
- [x] `DISCOVERY_REPORT.md` — 3 claims, IMPLEMENTED 0, PARTIAL 0, MISSING 0, STALE-DOC 1, SUPERSEDED 2, OUT-OF-SCOPE 0, NEEDS-OWNER 0
- [x] `GOAL.md` — 5 claims, IMPLEMENTED 4, PARTIAL 1, MISSING 0, STALE-DOC 0, SUPERSEDED 0, OUT-OF-SCOPE 0, NEEDS-OWNER 0
- [x] `IMPLEMENTATION_PLAN.md` — 5 claims, IMPLEMENTED 3, PARTIAL 0, MISSING 1, STALE-DOC 0, SUPERSEDED 0, OUT-OF-SCOPE 0, NEEDS-OWNER 1
- [x] `ORCHESTRATOR.md` — 3 claims, IMPLEMENTED 2, PARTIAL 1, MISSING 0, STALE-DOC 0, SUPERSEDED 0, OUT-OF-SCOPE 0, NEEDS-OWNER 0
- [x] `QUESTIONS.md` — 13 claims, IMPLEMENTED 3, PARTIAL 3, MISSING 0, STALE-DOC 1, SUPERSEDED 5, OUT-OF-SCOPE 0, NEEDS-OWNER 1
- [x] `README.md` — 4 claims, IMPLEMENTED 2, PARTIAL 1, MISSING 0, STALE-DOC 1, SUPERSEDED 0, OUT-OF-SCOPE 0, NEEDS-OWNER 0
- [x] `REMOTE_ENVIRONMENT.md` — 2 claims, IMPLEMENTED 0, PARTIAL 0, MISSING 0, STALE-DOC 1, SUPERSEDED 1, OUT-OF-SCOPE 0, NEEDS-OWNER 0
- [x] `SECURITY.md` — 10 claims, IMPLEMENTED 7, PARTIAL 3, MISSING 0, STALE-DOC 0, SUPERSEDED 0, OUT-OF-SCOPE 0, NEEDS-OWNER 0
- [x] `STATUS.md` — 11 claims, IMPLEMENTED 2, PARTIAL 1, MISSING 2, STALE-DOC 4, SUPERSEDED 1, OUT-OF-SCOPE 1, NEEDS-OWNER 0
- [x] `TARGET_ARCHITECTURE.md` — 9 claims, IMPLEMENTED 1, PARTIAL 0, MISSING 1, STALE-DOC 2, SUPERSEDED 5, OUT-OF-SCOPE 0, NEEDS-OWNER 0
- [x] `TEST_PLAN.md` — 5 claims, IMPLEMENTED 2, PARTIAL 2, MISSING 1, STALE-DOC 0, SUPERSEDED 0, OUT-OF-SCOPE 0, NEEDS-OWNER 0
- [x] `docs/DEVELOPMENT.md` — 10 claims, IMPLEMENTED 3, PARTIAL 0, MISSING 0, STALE-DOC 4, SUPERSEDED 3, OUT-OF-SCOPE 0, NEEDS-OWNER 0
- [x] `docs/FAILURE_DRILLS.md` — 5 claims, IMPLEMENTED 2, PARTIAL 0, MISSING 1, STALE-DOC 1, SUPERSEDED 0, OUT-OF-SCOPE 0, NEEDS-OWNER 1
- [x] `docs/PERFORMANCE.md` — 5 claims, IMPLEMENTED 2, PARTIAL 1, MISSING 1, STALE-DOC 0, SUPERSEDED 0, OUT-OF-SCOPE 0, NEEDS-OWNER 1
- [x] `docs/RESTORE_DRILL.md` — 6 claims, IMPLEMENTED 2, PARTIAL 0, MISSING 2, STALE-DOC 1, SUPERSEDED 1, OUT-OF-SCOPE 0, NEEDS-OWNER 0
- [x] `docs/TESTING.md` — 7 claims, IMPLEMENTED 2, PARTIAL 0, MISSING 1, STALE-DOC 4, SUPERSEDED 0, OUT-OF-SCOPE 0, NEEDS-OWNER 0
- [x] `docs/VPS_CHANGE_LIST.md` — 3 claims, IMPLEMENTED 1, PARTIAL 0, MISSING 0, STALE-DOC 0, SUPERSEDED 2, OUT-OF-SCOPE 0, NEEDS-OWNER 0
- [x] `docs/VPS_LOCAL_CHANGE_LIST.md` — 15 claims, IMPLEMENTED 4, PARTIAL 1, MISSING 1, STALE-DOC 3, SUPERSEDED 4, OUT-OF-SCOPE 0, NEEDS-OWNER 2
- [x] `infra/vps/README.md` — 3 claims, IMPLEMENTED 2, PARTIAL 0, MISSING 0, STALE-DOC 0, SUPERSEDED 1, OUT-OF-SCOPE 0, NEEDS-OWNER 0

**Totals: 178 claims — IMPLEMENTED 71, PARTIAL 22, MISSING 15, STALE-DOC 31, SUPERSEDED 31, OUT-OF-SCOPE 1, NEEDS-OWNER 7.**

## Findings

### `.claude-to-hermes.md`

| claim | verdict | evidence | apply item? |
|---|---|---|---|
| Phase 0–2 commits `2eb9be9`, `a6c267d`, `2599658`, `e18c8b4`, `aa89398`, `ec93e7a`, `607751b` exist on `feature/universal-aaa` | IMPLEMENTED | `git cat-file -t` = commit for all seven | — |
| Reload watcher: exit-code split (3 = reloaded with skipped rows, 4 = not root), attempt cap, `REDISCLI_AUTH`; cron entry not installed | IMPLEMENTED | `infra/vps-local/scripts/reload-radius.sh:24-25`; `radius-reload-watch.sh:36,59`; host: no `/etc/cron.d/ecloud-radius-reload`, no `/opt/ecloud/bin/radius-reload-watch.sh`, `redis-cli` in PATH | — |
| Host-side hot-reload install (watcher + cron) is still REQUIRES_CLARIFICATION; pilot reloads by hand with `reload-radius.sh` | MISSING | host `/opt/ecloud/infra/vps-local/scripts/` holds both scripts, nothing in `/opt/ecloud/bin`, no cron; D-050 ran `reload-radius.sh` manually | Decide and, if wanted, install the radius-reload watcher cron on vps-local now that `2eb9be9` is deployed (S, needs root = owner) |
| F-002: internal listener TLS (`INTERNAL_TLS_CERT_FILE`/`KEY_FILE`), `ECLOUD_INTERNAL_CLEARTEXT_ACK` in production | IMPLEMENTED | `apps/api/src/config.ts` declares `INTERNAL_TLS_CERT_FILE`, `ECLOUD_INTERNAL_CLEARTEXT_ACK`; test `apps/api/src/internal-tls.test.ts` exists. Note: the api container sets only the D-061 twin `INTERNAL_CLEARTEXT_ACK=1`, not `ECLOUD_INTERNAL_CLEARTEXT_ACK` (that one lives on the freeradius side) | — |
| F-003: `INTERNAL_API_TOKEN` alphabet `[A-Za-z0-9_-]` enforced in shared config | IMPLEMENTED | `packages/shared/src/config.ts:64`; `packages/shared/src/config.test.ts` exists | — |
| `PUBLIC_PORTAL_ORIGIN=https://ezecloud.ezelink.ai:444` unreachable; fix is a portal hostname on 443 (owner's call) | SUPERSEDED | D-047: `portal.ezelink.ai`; host env `PUBLIC_PORTAL_ORIGIN=https://portal.ezelink.ai` | — |
| "The host has NOT been updated yet: `/opt/ecloud/ecloud.env` still carries the old origins" | STALE-DOC | host env: `PUBLIC_ADMIN_ORIGIN=https://ezecloud.ezelink.ai`, `PUBLIC_API_ORIGIN=https://api.ezelink.ai`, `PUBLIC_PORTAL_ORIGIN=https://portal.ezelink.ai` | Append a dated line to the hand-back: host origins updated (D-047 applied) |
| 2A dynamic clients: `radius-client-lookup.ts`, `ecloud-dynamic-clients`, `rest_clients` exist, OFF by default, VERIFIED_FROM_SOURCE only | IMPLEMENTED | all three paths exist; `RADIUS_DYNAMIC_CLIENT_SUBNET` not set on host (default TEST-NET-2) | — |
| 2B: `stale-sweep.ts` does not exist; sweep is `reap.ts` | IMPLEMENTED | `apps/worker/src/jobs/reap.ts` exists, `stale-sweep.ts` absent | — |
| 2C: second FreeRADIUS replica deferred; NAS-side secondary server is the owner's deployment decision | NEEDS-OWNER | doc §2C; no second replica in `compose.pilot.yaml` | Owner: is RADIUS HA (a second host as NAS secondary) wanted before production, or deferred? |

### `.hermes-coordination.md`

| claim | verdict | evidence | apply item? |
|---|---|---|---|
| Branch `claude/trusting-bohr-ehety0` is the working branch | STALE-DOC | branch exists but HEAD is `feature/universal-aaa` (`git worktree list`) | Mark the bulletin historical (2026-10-12) or delete it |
| Worktrees `wt/t1-ssh-target`, `wt/t2-aaa-dedupe`, `wt/t4-reload-tests` exist | IMPLEMENTED | `git worktree list`: `.worktrees/t_c000a0d2` (t1), `t_bd104262` (t2), `t_b3721bb0` (t4) | — |
| Open blockers: NAS secret for AP `.198` and UAM secret REQUIRES_CLARIFICATION; NAS IP still `.196` | SUPERSEDED | D-050/D-051: NAS `d82d9ba1a1aa` sealed with RADIUS + UAM secrets, rendered `clients:1`; host `nas_clients` 1 row `enc:v2.` | — |
| Sessions `ezecloud-54` and `ezecloud-49` are the addressees | STALE-DOC | `.claude-to-hermes.md:26` "there is no `ezecloud-54` socket" | (same as row 1) |

### `AGENTS.md`

| claim | verdict | evidence | apply item? |
|---|---|---|---|
| AAA changes get A3+A2+A9 review; security changes A8 review | PARTIAL | STATUS.md cycle log records reviews through 2026-10-09; the 2026-10-13..15 AAA/security deploys (D-054, D-056/D-061, D-062) are recorded in DECISIONS only ("reviewed for authz" in D-056), no review artefact in the repo | Record review evidence (reviewer, commit, result) for D-054/D-056/D-061/D-062 in STATUS.md |
| Production deployment needs A1+A8+A9 approval evidence | PARTIAL | pilot deploys logged in STATUS.md "VPS change log" only up to 2026-10-10; later deploys (0e8f735 stack, api 1592364, worker 7afd5fe) have no log row | Extend the STATUS change log to 2026-10-15 (see STATUS.md) |
| Lane rules file `AGENT_LANES.md` (named by D-053 as the Cloudflare-write guard) | MISSING | `ls AGENT_LANES.md` → not in repo | Add `AGENT_LANES.md` or point D-053 at the real file (owner laptop?) |

### `AGENT_TASK_TEMPLATE.md`

| claim | verdict | evidence | apply item? |
|---|---|---|---|
| Tasks define inputs, evidence, tests, risks, completion criteria | IMPLEMENTED | STATUS.md cycle entries carry review + tests + known limits per cycle | — |

### `ARCHITECTURE.md`

| claim | verdict | evidence | apply item? |
|---|---|---|---|
| Status `PROPOSED — discovery required` | STALE-DOC | platform deployed and serving sessions (host: 9 sessions/24 h, 153 accounting records) | Set status to "IMPLEMENTED (pilot); device enforcement per PHASE2_VALIDATION" |
| Layers: admin UI, API, AAA, policy engine, session manager, database | IMPLEMENTED | `apps/{admin,api,portal,worker}`, `packages/{policy-engine,adapters,db}` | — |
| Enforcement only at a VERIFIED device mechanism; `*` dynamic control UNVERIFIED | PARTIAL | adapters carry four-state status (`packages/adapters/src/evidence.ts`); no DT executed except DT-01 (STATUS.md:201); D-065 CoA test deferred | — (device test tracked under D-065) |

### `CLAUDE.md`

| claim | verdict | evidence | apply item? |
|---|---|---|---|
| Remote target is `ssh vps-local`; EZEOS 8.10 / Oracle Linux 8, dnf | IMPLEMENTED | ssh banner "EZEOS v2.1"; D-041 | — |
| "Do NOT use `ssh vps`" | IMPLEMENTED | D-043 (old VPS cancelled) | — |
| "Current project phase: DISCOVERY ONLY — remote server changes are NOT authorized" | STALE-DOC | D-040/D-041/D-043 and 7 healthy containers on vps-local since 2026-10-09 | Rewrite "CURRENT SAFETY STATE" to the live gates: D-031 per-id approval, owner standing approval (2026-10-15), D-058 scope, read-only SELECT rule, D-052 direct-write rule |
| "The exact technology stack must be determined through discovery" | STALE-DOC | D-004/D-008/D-009/D-011 decided and built | (same rewrite) |
| Anti-hallucination list (no invented IPs, VSAs, …) | STALE-DOC (partly) | still valid as a rule, but the "unknown → REQUIRES_CLARIFICATION" vocabulary is now the DECISIONS status set (`REQUIRES_DEVICE_TEST` etc.) | (same rewrite) |

### `DECISIONS.md` (authoritative; checked the decisions that claim an implemented state)

| claim | verdict | evidence | apply item? |
|---|---|---|---|
| D-042 RADIUS on the LAN address only, allowed from the AP subnet | IMPLEMENTED | host udp `192.168.203.196:1812/1813`; `/etc/ecloud/docker-user.env` RADIUS CIDR `192.168.203.0/24`; `ecloud-docker-user` active | — |
| D-046 `ADMIN_MFA_MODE=off` default, re-enable without data loss | IMPLEMENTED | `apps/api/src/config.ts:47` `.default('off')`; api env `ADMIN_MFA_MODE=off` | — |
| D-047 hostnames `ezecloud.ezelink.ai`, `api.ezelink.ai`, `portal.ezelink.ai` via tunnel; `PUBLIC_API_ORIGIN` read by no code | IMPLEMENTED | host env origins; listeners `0.0.0.0:443/444`; `grep PUBLIC_API_ORIGIN apps/*/src` → compose only | — |
| D-051 renderer carve-out: `FLEET_DEFAULT_RADIUS_SECRET`, `isAcceptableSecret`, `check-no-secrets: allow`, `fleetDefaultSecret` count | IMPLEMENTED | `apps/api/src/radius-clients/render.ts:78,82-83,168-169` | — |
| D-052 `users.sample.valid_until = NULL`; direct DB writes get a same-day row | IMPLEMENTED | SQL: `sample` → `valid_until` NULL; D-055, D-063 rows exist | — |
| D-054 re-seal to v2 (1 NAS + 1 portal) | IMPLEMENTED | SQL: `nas_clients.secret_ref` prefix `enc:v2.`, `captive_portals.uam_secret_ref` prefix `enc:v2.`; `apps/api/src/secret-reseal-cli.ts` exists | — |
| D-055 `platform_default_policy` enabled 10/10 Mbps, 86400 s | IMPLEMENTED | SQL row: `enabled true, download_rate_kbps 10000, upload_rate_kbps 10000, session_timeout_s 86400`; migration `043_platform_default_policy.sql`; `ensurePlatformDefaultPortal` in `apps/api/src/internal/portal.ts` | — |
| D-056/D-061 `GET /internal/nas/:id/secret` guarded by `INTERNAL_SECRET_TOKEN`; worker fetches per dispatch; `INTERNAL_CLEARTEXT_ACK` | IMPLEMENTED | `apps/api/src/app.ts:232`; `apps/api/src/config.ts:137-143`; `apps/worker/src/infra/secrets.ts:5-8`; api/worker env `INTERNAL_SECRET_TOKEN_FILE`, api `INTERNAL_CLEARTEXT_ACK=1` | — |
| D-061/D-065: CoA/Disconnect "live and proven from inside the network"; device half pending | PARTIAL | worker env has **no `ECLOUD_COA_ENABLED`**; `apps/worker/src/config.ts:32` default false; `apps/worker/src/coa/dispatcher.ts:6` records `unsupported`/`skipped_disabled` and sends nothing; `session_actions` 0 rows | Before the D-065 device test: set `ECLOUD_COA_ENABLED=true` on the worker (compose override) and record it; D-061's "never `unsupported`" only holds with the flag on |
| D-059 CLI `reset-platform-admin-password` / `set-platform-admin`, audit `platform:password_reset` | IMPLEMENTED | `packages/db/src/cli.ts:13-14,235,260`; host `reset-admin-password.sh` present; 0 audit rows (never run) | — |
| D-062 every write refused while impersonating (4ce1502) | IMPLEMENTED | `apps/api/src/http/route.ts:89-92,152`; `git show 4ce1502` touches `route.ts`, `routes/auth.ts`, `routes/platform.ts` | — |
| D-063 `admin@ezecloud.local` disabled, `danny@ezelink.com` active | IMPLEMENTED | SQL `administrators`: exactly those two rows/statuses | — |
| D-060 SendGrid: `SMTP_*` in `ecloud.env`, key via `SMTP_PASSWORD_FILE` | IMPLEMENTED | host env `SMTP_HOST=smtp.sendgrid.net`, `SMTP_PORT=587`, `SMTP_USER=apikey`, `SMTP_FROM=noreply@ezelink.ai`; api env `SMTP_PASSWORD_FILE=/run/secrets/smtp_password` | — |
| D-064 "migration 049 narrowing `secret_ref` NOT written" | PARTIAL | true for that migration, but an **untracked** `packages/db/migrations/049_portal_registration_devices.sql` now occupies number 049 (host has 48 applied) | Commit or drop the untracked 049 before the next deploy; if D-064 reopens, the tightening migration takes 050+ |
| D-025 pilot retention 7 d / 13 mo / 24 mo in force | PARTIAL | `retention.prune` is dry-run unless `RETENTION_APPLY=true` (`apps/worker/src/config.ts`, DEVELOPMENT.md:173); worker env has no `RETENTION_APPLY` → nothing is pruned on the pilot | Owner: enable `RETENTION_APPLY=true` on the pilot worker so D-025 retention actually runs? (NEEDS-OWNER) |
| D-024 dedicated least-privilege deployment identity before automated deployment | PARTIAL | deploys are still `ezeadmin` + password sudo, images `docker load`ed (VPS_LOCAL_CHANGE_LIST §4.1); no CI deploy identity | — (gated on "automated deployment", not yet started) |

### `DEPLOYMENT_ARCHITECTURE.md`

| claim | verdict | evidence | apply item? |
|---|---|---|---|
| Host = OVH VPS `vps`, Ubuntu, 2 vCPU/3.7 GiB, Caddy 2.11.4 | SUPERSEDED | D-041/D-043: pilot is `vps-local` (EZEOS/OL8, 8 CPU/15.7 GB); old VPS cancelled | Add a header note: pilot host and edge superseded by D-041/D-043/D-047 |
| Native Caddy is the only public HTTP entry; site blocks for three names | SUPERSEDED | D-041/D-043: `ecloud-edge` (nginx-unprivileged) on 443/444 + Cloudflare tunnel; no Caddy on host | (same header note) |
| api `127.0.0.1:3000`, portal `127.0.0.1:3001` published | STALE-DOC | code `PORTAL_PORT` 3002 (`packages/shared/src/config.ts:47`); vps-local publishes neither (compose `!reset`); the doc's own M9 note records the deviation | Fold the M9 deviations into §2.1 |
| FreeRADIUS on `100.100.0.1` (WireGuard hub), CoA from the hub | SUPERSEDED | D-042: LAN address `192.168.203.196`; WireGuard deferred | (same header note) |
| Memory/CPU limits per service (api 384 MiB / 0.75 CPU …) | IMPLEMENTED | `infra/vps/compose/compose.pilot.yaml:227` `memory: 384M, cpus: '0.75'`; 12 memory limits total | (see PERFORMANCE B-2 for the CPU question) |
| Secrets as `*_FILE` + Compose `secrets:`; never in git | IMPLEMENTED | api env `SMTP_PASSWORD_FILE`, `INTERNAL_SECRET_TOKEN_FILE`; `/opt/ecloud/secrets` unreadable to `ezeadmin` (0750) | — |
| `migrate` one-shot before api/worker; expand/contract migrations | IMPLEMENTED | compose profile `migrate`; host 48 applied; `VPS_LOCAL_CHANGE_LIST` release procedure | — |
| Backup: nightly `pg_dump -Fc`, encrypted, off-site target REQUIRES CLARIFICATION (Q18) | SUPERSEDED | owner chose GitHub orphan branch (STATUS.md:223, 2026-10-10); `ecloud-backup.timer` active, last run today 06:24 +04 | — |
| Monitoring: uptime-kuma, node_exporter, cAdvisor on loopback; alerts via webhook | MISSING | no such containers (`docker ps`); `ecloud-check.timer` not installed; `infra/monitoring/*.yml` are drafts | Decide the pilot monitoring minimum (LCL-MON-1 check timer at least) — see VPS_LOCAL_CHANGE_LIST |
| Docker log rotation (`daemon.json` 10m×3) and journald cap | PARTIAL | host `/etc/docker/daemon.json` = `{data-root, json-file 10m×3, live-restore}`; `/etc/systemd/journald.conf.d/` absent | journald cap = LCL-LOG-1 (owner decision) |
| CI builds and pushes images to `ghcr.io/<org>`; deploy over SSH with `IMAGE_TAG` rollback | PARTIAL | CI `images` job exists; images are named `ghcr.io/dannymagat/*` but transferred by `docker save/load`; rollback by `IMAGE_TAG` works (`-pre-*` tags on host) | — |
| Production pilot settings: `NODE_ENV=production`, `TRUST_PROXY_HOPS=1`, storage opt-in explicit | IMPLEMENTED | api env `NODE_ENV=production`, `TRUST_PROXY_HOPS=1`, `STORAGE_DRIVER=local`, `STORAGE_LOCAL_ALLOW_PRODUCTION=true` | — |
| Open questions Q13–Q22, items D1–D6 for the old VPS | SUPERSEDED | D-043 | (same header note) |

### `DISCOVERY_REPORT.md`

| claim | verdict | evidence | apply item? |
|---|---|---|---|
| Target `vps-6391e47f` facts (F-01…F-45) | SUPERSEDED | D-043: host cancelled | Add "HISTORICAL — host cancelled 2026-10-09 (D-043)" banner |
| Proposed Phase 2 architecture (Caddy edge, Compose tier, PostgreSQL, FreeRADIUS) | SUPERSEDED | D-004…D-020 approved; edge/host amended by D-041/D-043 | (banner) |
| "Phase 2 is not implemented; no change made to the remote server" | STALE-DOC | pilot live since 2026-10-09 (STATUS.md:221) | (banner) |

### `GOAL.md`

| claim | verdict | evidence | apply item? |
|---|---|---|---|
| Feature set: RBAC, orgs/sites, NAS, users, policies, AAA, portal, sessions, accounting, reporting, audit, backup | IMPLEMENTED | STATUS.md Phases 3–10; OpenAPI 113 paths; host sessions/accounting rows; backup timer | — |
| Enforcement point MUST be verified before implementation | PARTIAL | adapters report four-state status; only DT-01 executed (STATUS.md:201); bandwidth DT-04 and Disconnect DT-07 not run (D-065) | Schedule DT-04/DT-07 on AP1832 (owner lab time; see D-065) |
| Captive portal: configurable login/error/success/expired/logout + branding | IMPLEMENTED | P6-B portals/themes (STATUS.md:152); `be95176` "published template reaches the guest" | — |
| AAA standards-based, no guessed VSAs | IMPLEMENTED | `packages/adapters/src/evidence.ts`, source refs; TESTING.md §7 rule | — |
| Multi-tenant isolation; secrets never in source control | IMPLEMENTED | D-007; 46 tenant tables, 70 relations with FORCE RLS on host; CI `secrets` job | — |

### `IMPLEMENTATION_PLAN.md`

| claim | verdict | evidence | apply item? |
|---|---|---|---|
| Phases 3–4 (foundation, core admin) | IMPLEMENTED | STATUS.md M1–M8, Phase 4 table | — |
| Phase 5 exit: test account authenticates, accounting validated | IMPLEMENTED | host: 9 sessions/24 h (`active`,`stopped`), 153 accounting records; D-050 RADIUS probe | — |
| Phase 6 exit: real client completes end-to-end login | IMPLEMENTED | sessions from NAS `d82d9ba1a1aa` on the pilot (D-052/D-065 "uspot sessions") | — |
| Phase 7 exit: measured bandwidth matches policy | MISSING | DT-04 never run; device harness dry-run only (TESTING.md §7.1) | Run DT-04 with `tests/device/run.ts --live` on AP1832 (owner lab) |
| Phase 11 production acceptance: full matrix + rollback drill | NEEDS-OWNER | no acceptance run; restore/failure drills workstation-only | Owner: when is production acceptance scheduled, and on which host? |

### `ORCHESTRATOR.md`

| claim | verdict | evidence | apply item? |
|---|---|---|---|
| Evidence policy: every environment conclusion traceable | IMPLEMENTED | DECISIONS rows cite SQL/commands/commits; PHASE2 labels | — |
| Change control: DECISIONS.md updated **before** implementation | PARTIAL | D-062 recorded after commit `4ce1502`; D-052/D-055/D-063 are direct DB writes recorded same day (rule in D-052) | — (rule now explicit in D-052; keep) |
| Stop at decision gates; owner questions only when material | IMPLEMENTED | D-031 gate, owner standing approval 2026-10-15 | — |

### `QUESTIONS.md`

| claim | verdict | evidence | apply item? |
|---|---|---|---|
| Q13/Q33 domain structure `api.ezecloud.` / `portal.ezecloud.ezelink.ai` | SUPERSEDED | D-039 → D-047 (`api.ezelink.ai`, `portal.ezelink.ai`) | Add a "post-2026-10-07 rulings" table pointing Q13/Q15/Q16–Q21/Q44/Q70 at D-039…D-065 |
| Q14 deploy root `/opt/ecloud` | IMPLEMENTED | host `ls /opt/ecloud` | — |
| Q15 keep native Caddy | SUPERSEDED | D-041/D-043 (no Caddy on vps-local) | (table) |
| Q16–Q21 (overlay ranges, OVH console, snapshots, cf-dns-failover, token files, host prerequisites) | SUPERSEDED | D-043 host cancelled; D-042 WireGuard deferred | (table) |
| Q22 deployment identity / CI runner | NEEDS-OWNER | D-024 defers it to "before automated deployment"; deploys now routine | Owner: create the least-privilege deploy identity on vps-local now, or keep owner-run `sudo` until CI deploys? |
| Q34 Redis in the pilot | IMPLEMENTED | `ecloud-redis` healthy | — |
| Q44 Session-Timeout cap 30 min when no other bound | SUPERSEDED | D-052: after `cf6ffe7` `deriveSessionTimeout` has no candidate on uspot for an unbounded account → no Session-Timeout; `AAA_SESSION_TIMEOUT_CAP_S` still in `apps/api/src/config.ts` | Clarify in DEVELOPMENT.md how `AAA_SESSION_TIMEOUT_CAP_S` and `cf6ffe7` interact (which wins on uspot) |
| Q57 retention defaults | PARTIAL | see D-025 row (prune dry-run on pilot) | (D-025 NEEDS-OWNER) |
| Q59 storage abstraction, no MinIO | IMPLEMENTED | `packages/storage`; api `STORAGE_DRIVER=local` with opt-in | — |
| Q60 alert channel (webhook) | PARTIAL | no uptime-kuma/webhook; only SMTP (D-060) exists | fold into the monitoring decision (DEPLOYMENT_ARCHITECTURE row) |
| Q61 GHCR registry | PARTIAL | image names `ghcr.io/dannymagat/*`, no push (`docker load`) | — |
| Q70 impersonation guardrails (no keys/secrets/bindings) | SUPERSEDED | D-062: every write refused | (table) |
| Summary: "remaining owner input only D-031 and D-034" | STALE-DOC | D-035…D-065 since | (table) |

### `README.md`

| claim | verdict | evidence | apply item? |
|---|---|---|---|
| Layout `apps/ api · worker · portal`, `packages/ shared · db · policy-engine · adapters · testing` | STALE-DOC | `ls apps` → admin api portal worker; `ls packages` → adapters db policy-engine shared storage testing vendor-api | Update the layout block (admin, storage, vendor-api; `infra/vps`, `infra/vps-local`, `infra/docker`, `tests/`) |
| Quick start `nvm use && npm install`, `npm run build/lint/test`, `npm run dev:stack` | IMPLEMENTED | `package.json` scripts; `.nvmrc` present | — |
| Phase 3 monorepo: Node 22, ESM, Vitest, Express 5, PostgreSQL 16, Redis 7 | IMPLEMENTED | `tsconfig.base.json`, `vitest.config.ts`, host postgres:16/redis:7 | — |
| Definition of Done (real client, correct policy, accounting, admin views, secure) | PARTIAL | authenticates + accounting + admin views on the pilot (host rows); bandwidth enforcement and Disconnect not device-verified (DT-04/DT-07, D-065) | — (tracked by GOAL/IMPLEMENTATION_PLAN rows) |

### `REMOTE_ENVIRONMENT.md`

| claim | verdict | evidence | apply item? |
|---|---|---|---|
| Inventory of `vps-6391e47f` (§1–§14) | SUPERSEDED | D-043 | Add "HISTORICAL — host cancelled (D-043); vps-local discovery is in STATUS.md 2026-10-09" banner |
| Method `ssh vps` with passwordless `sudo -n` | STALE-DOC | CLAUDE.md "Do NOT use `ssh vps`"; vps-local sudo needs a password (D-041) | (banner) |

### `SECURITY.md`

| claim | verdict | evidence | apply item? |
|---|---|---|---|
| TLS for web/API in production | IMPLEMENTED | edge TLS (`/opt/ecloud/tls/edge.crt`), Cloudflare `noTLSVerify` (D-047) | — |
| Strong password hashing (Argon2id) | IMPLEMENTED | D-016; PERFORMANCE.md B-2 (`ARGON2_MEMORY_KIB=19456`) | — |
| RBAC and least privilege; secure admin sessions; CSRF | IMPLEMENTED | 112 permissions, 6 role templates; `__Host-` cookie + Origin/X-Requested-With (DEVELOPMENT.md:133) | — |
| Brute-force/abuse controls | IMPLEMENTED | lockout 10/5 min, portal per-account lock (STATUS.md:151,156) | — |
| Secrets outside source control; RADIUS secrets protected | IMPLEMENTED | CI `secrets` job; NAS/portal refs `enc:v2.`; reveal audited (D-045) | — |
| Restrict database exposure; minimal public ports | PARTIAL | no 5432/6379 EZECLOUD listener; but 443/444 bind `0.0.0.0` on the appliance (DOCKER-USER limits to LAN + tunnel origin) — accepted by D-047 | — |
| Audit privileged actions | PARTIAL | API writes audited; three direct DB writes bypassed audit (D-052, D-055, D-063, recorded in DECISIONS only) | Add an admin disable/enable route or CLI so D-063-type changes go through audit (D-063 names this gap) |
| Dependency and patch management | IMPLEMENTED | CI `supply-chain` job (`.github/workflows/ci.yml:29`) | — |
| Backup encryption/access controls | IMPLEMENTED | age-encrypted sets, private key offline (STATUS.md:223) | — |
| Log rotation and retention | PARTIAL | Docker json-file 10m×3 on host; journald uncapped; DB retention prune dry-run | (LCL-LOG-1 + D-025 rows) |

### `STATUS.md`

| claim | verdict | evidence | apply item? |
|---|---|---|---|
| Current stage: "PHASES 3–10 LOCAL WORK COMPLETE — AWAITING OWNER APPROVAL OF THE VPS CHANGE LIST (D-031)" | STALE-DOC | pilot live since 2026-10-09; D-040…D-065 | Rewrite "Current Stage", "Next Action" and "Open Items" to the 2026-10-15 state (D-058 scope, D-065 open device test) |
| Confirmed goal domains `api.ezecloud.`/`portal.ezecloud.ezelink.ai` | SUPERSEDED | D-047 | (same rewrite) |
| "Owner Decisions in Force" lists D-021…D-034 only | STALE-DOC | DECISIONS.md has D-035…D-065 | (same rewrite) |
| Counts: 11/18 migrations, 37 tables, catalogue 99 → 105 permissions | STALE-DOC | host 48 migrations applied; catalogue 112; 46 tenant tables | (same rewrite) |
| VPS change log ends 2026-10-10 (`bfa257c`, `dbc10fb`) | STALE-DOC | host runs stack `0e8f735` with api `1592364`, worker `7afd5fe`, admin `d7795a7` (image ids); deploys of 2026-10-13..15 (D-047, D-054, D-056/D-061, D-060, D-062) are unlogged | Append change-log rows for 2026-10-13..15 (tags, pre-deploy backups, migrations 034–048) |
| Backups live: timer 02:15 UTC, keeps 7, GitHub branch `vps-local` | IMPLEMENTED | `ecloud-backup.timer` enabled/active, last run 06:24 +04 (= 02:24 UTC); `/etc/ecloud/backup-github.env`, `/opt/ecloud/bin/upload-github.sh` | — |
| `ADMIN_MFA_MODE=off` deployed (D-046) | IMPLEMENTED | api env | — |
| Phase 7/8: Disconnect/Reauthorize refuse (D-006); strategy always `next_reauth` | PARTIAL | D-056/D-061 endpoint live; worker still `ECLOUD_COA_ENABLED` unset → nothing sent; D-065 device test pending | (DECISIONS D-061/D-065 row) |
| Phase 10 residual "Prometheus server not in the pilot (uptime-kuma is)" | MISSING | neither runs on vps-local (`docker ps`) | (monitoring decision) |
| Phase 10 residual "drain cursor in Redis (rescan after data loss)" | MISSING | no `worker_cursors` migration (`grep -rl worker_cursors packages/db/migrations` empty) | Persist the drain cursor in Postgres (`worker_cursors`), S, worker + migration |
| P5 lab: AP default password changed; future AP access via SSH key | OUT-OF-SCOPE | AP/controller item (D-058) | — |

### `TARGET_ARCHITECTURE.md`

| claim | verdict | evidence | apply item? |
|---|---|---|---|
| Status "PROPOSED — awaiting owner approval before Phase 3" | STALE-DOC | approved 2026-10-07 (DECISIONS header), built, deployed | Set status "APPROVED 2026-10-07, implemented on the pilot; amendments D-041/D-042/D-043/D-046/D-047" |
| Caddy edge 80/443 as the only public HTTP entry | SUPERSEDED | D-041/D-043 | (status note) |
| WireGuard hub UDP 51820 for site connectivity | SUPERSEDED | D-042 (deferred) | (status note) |
| Portal at `portal.ezecloud.ezelink.ai` | SUPERSEDED | D-047 | (status note) |
| Admin auth: Argon2id, TOTP, `__Host-` cookies | SUPERSEDED (TOTP) | D-046 | (status note) |
| RadSec mandatory for any NAS over the public internet | SUPERSEDED | D-044 (Meraki cloud RADIUS by NAS-Identifier + secret; build/test only) | (status note) |
| RBAC "about 60 `resource:action` keys" | STALE-DOC | 112 keys | (status note) |
| Monitoring: node_exporter, cAdvisor, exporters + Prometheus/Grafana or uptime-kuma | MISSING | none deployed | (monitoring decision) |
| Three processes from one codebase + FreeRADIUS + PostgreSQL + Redis; accounting pipeline rlm_sql → worker; reaper | IMPLEMENTED | 7 containers healthy; `apps/worker/src/jobs/reap.ts`; 153 accounting records | — |

### `TEST_PLAN.md`

| claim | verdict | evidence | apply item? |
|---|---|---|---|
| Unit/component tests for policy, RBAC, DB constraints, accounting, portal | IMPLEMENTED | Vitest projects; suite 1544 passed / 518 skipped (`.claude-to-hermes.md:285`) | — |
| Integration steps 1–12 on the real access device | PARTIAL | 1–6, 8–11 evidenced on the pilot (sessions + accounting rows); 7 (bandwidth) and 12 (disconnect) not verified (D-065) | (DT-04/DT-07 lab item) |
| Negative tests (wrong password, unknown NAS, DB/AAA/API unavailable, replay) | IMPLEMENTED | `tests/aaa-contract/`, `tests/simulators/`, `docs/FAILURE_DRILLS.md` | — |
| Recovery tests: service/server restart, backup/restore, rollback, failed migration | PARTIAL | drills and restore drill executed on the workstation only (FAILURE_DRILLS.md:3, RESTORE_DRILL.md:3); not on vps-local | (FAILURE_DRILLS / RESTORE_DRILL rows) |
| Final acceptance on a real device path incl. bandwidth enforcement | MISSING | no DT beyond DT-01 | (lab item) |

### `docs/DEVELOPMENT.md`

| claim | verdict | evidence | apply item? |
|---|---|---|---|
| Prerequisites, install, dev stack, test/lint commands | IMPLEMENTED | `package.json` scripts (`dev:stack`, `test:integration`, `test:isolation`, `test:aaa-contract`, `db:migrate`, `dev:admin`), `.nvmrc` | — |
| `PERMISSION_CATALOGUE` 98 keys | STALE-DOC | 112 (`packages/shared/dist`) | Refresh counts: 112 permissions, 46 tenant tables, 48 migrations, internal routes list |
| FORCE RLS on all 32 tenant-scoped tables | STALE-DOC | `TENANT_SCOPED_TABLES.length` 46; host 70 relations forced (partitions included) | (same refresh) |
| Internal listener serves `/internal/aaa/authorize`, `/internal/aaa/post-auth` only | STALE-DOC | also `/internal/portal/*`, `/internal/nas/:id/secret` (`apps/api/src/app.ts:232`), radius-client lookup, `/metrics` | (same refresh) |
| "Platform-bound accounts must enrol TOTP at first sign-in" | SUPERSEDED | D-046; line 141 already documents `ADMIN_MFA_MODE`, line 234 contradicts it | Delete/rewrite line 234 |
| Worker: secret refs `env:`/`file:` only; other schemes → `unsupported` | SUPERSEDED | D-056/D-061; `apps/worker/src/infra/secrets.ts:7-8` resolves `enc:` via the api | Rewrite the worker secrets paragraph (lines 198–200) and add `INTERNAL_SECRET_TOKEN` to the worker env table |
| `ECLOUD_COA_ENABLED` default false, nothing sent while false | IMPLEMENTED | `apps/worker/src/config.ts:32`; pilot still false | (D-061/D-065 row) |
| Production: Caddy serves `apps/admin/dist` for `ezecloud.ezelink.ai` | SUPERSEDED | D-041/D-043: `ecloud-edge` nginx image | Replace "Production" paragraph with the edge-container description |
| Container images "M9, LOCAL only"; nothing pushed | STALE-DOC | host images `ghcr.io/dannymagat/ecloud-*:<tag>` loaded, running | (same refresh) |
| Storage: pilot `STORAGE_DRIVER=local` with `STORAGE_LOCAL_ALLOW_PRODUCTION=true` | IMPLEMENTED | api env | — |

### `docs/FAILURE_DRILLS.md`

| claim | verdict | evidence | apply item? |
|---|---|---|---|
| Harness `scripts/drills/failure-drills.ts`, 40/40 on the local stack | IMPLEMENTED | file exists; results dated 2026-10-09 | — |
| F-1 pool idle-error handler, F-2 scheduler re-registration, with tests | IMPLEMENTED | `packages/db/src/pool-resilience.integration.test.ts`, `apps/worker/src/metrics.integration.test.ts` exist | — |
| Residual 1: persist drain cursor in Postgres (`worker_cursors`) | MISSING | no migration references `worker_cursors` | (STATUS row: persist drain cursor) |
| Residual 2: graceful api stop takes the full 10 s (keep-alive) | STALE-DOC | `apps/api/src/index.ts:70` `closeAllConnections()`, `:78` `closeIdleConnections()` — mitigation present | Update §4 item 2 to "fixed" (or state the remaining gap) |
| Residual 4: repeat drills on the pilot host | NEEDS-OWNER | not run on vps-local; drills stop/restart production containers | Owner: approve a maintenance window to run `failure-drills.ts` against vps-local (brief RADIUS outage)? |

### `docs/PERFORMANCE.md`

| claim | verdict | evidence | apply item? |
|---|---|---|---|
| Harness `scripts/load/` (run-load.sh, k6 scripts) | IMPLEMENTED | `scripts/load/run-load.sh` exists | — |
| B-1 `FOR UPDATE OF v` fix + regression test; B-3 verify-gate + `AAA_VERIFY_MAX_WAIT_MS` | IMPLEMENTED | `apps/api/src/voucher-concurrency.integration.test.ts`, `apps/api/src/aaa-password-verify.integration.test.ts`, `apps/api/src/internal/verify-gate.ts` (`AAA_VERIFY_MAX_WAIT_MS`) | — |
| B-2: password path CPU-bound at 0.75 CPU; option: raise api CPU limit | NEEDS-OWNER | `compose.pilot.yaml:227` still `cpus: '0.75'` (sized for the 2-vCPU VPS); vps-local has 8 CPU | Owner: raise api `cpus` to 1.0–2.0 on vps-local (compose override, api recreate)? |
| "Re-measure on the VPS" | MISSING | no pilot-host run recorded | Run `scripts/load/run-load.sh` against vps-local in a window (after the CPU decision) |
| Alert rules `infra/monitoring/alerts.yml` consume the new metrics | PARTIAL | file exists; no Prometheus on the pilot → rules inert | (monitoring decision) |

### `docs/RESTORE_DRILL.md`

| claim | verdict | evidence | apply item? |
|---|---|---|---|
| Tooling `scripts/backup/{backup,restore,restore-drill,lib}.sh`, systemd unit | IMPLEMENTED | files exist; host `/opt/ecloud/bin/{backup.sh,lib.sh,upload-github.sh}`, timer active | — |
| Off-site target REQUIRES CLARIFICATION (Q18) | SUPERSEDED | owner decision 2026-10-10: GitHub branch `vps-local` (STATUS.md:223) | Update §5 bullet 1 |
| Off-site retention not implemented (copy grows unbounded) | STALE-DOC | `infra/vps-local/backup/upload-github.sh:10,33` keeps newest `BACKUP_GITHUB_KEEP=7` | Update §5 bullet 4 |
| `ecloud_backup` role (BYPASSRLS, read-only) via `db-roles.sql` | IMPLEMENTED | `infra/vps/compose/db-roles.sql:23-24` | — |
| Run the drill monthly; first run on the pilot replaces workstation numbers | MISSING | no vps-local/Mac restore of a real `vps-local` branch set recorded (LCL-BK-3 verify step) | Run one restore drill from the GitHub branch with the offline key (Mac, scratch Postgres) and record RTO |
| Backup monitoring: uptime-kuma push (`BACKUP_PUSH_URL`) / `EcloudBackupMissing` | MISSING | no uptime-kuma, no Prometheus; only `journalctl -u ecloud-backup` | (monitoring decision) |

### `docs/TESTING.md`

| claim | verdict | evidence | apply item? |
|---|---|---|---|
| Layers and commands (`npm run test:*`) | IMPLEMENTED | `package.json`; `test:portal-e2e` exists but is undocumented | Add `test:portal-e2e` to §2 |
| CI jobs: `secrets`, `check`, `integration`, `radius-contract` | STALE-DOC | ci.yml also has `supply-chain` and `images` | Update §9 |
| "All 24 DT are REQUIRES_DEVICE_TEST; none has been executed" | STALE-DOC | STATUS.md:201 DT-01 executed 2026-10-07 (PASS, identification only); D-050 RADIUS probe from AP1832 | Update §7 table row DT-01 and the intro |
| RLS matrix 31 tables × 5 probes | STALE-DOC | 46 tenant tables | Refresh counts |
| DoD traceability "status after Phase 3" | STALE-DOC | pilot evidence exists (sessions, accounting, admin views) | Refresh §8 with pilot evidence and the still-missing DT rows |
| L4 simulator results file bound to run id | IMPLEMENTED | `tests/simulators/SIMULATOR_RESULTS.json` exists | — |
| e2e Playwright (Phase 6) | MISSING | `tests/e2e/` = Vitest smoke (`api-healthz.test.ts`, `portal-uam-radius.test.ts`); STATUS.md:57 "committed Playwright E2E" not built | Decide whether browser E2E is wanted for the pilot (M, QA lane) |

### `docs/VPS_CHANGE_LIST.md`

| claim | verdict | evidence | apply item? |
|---|---|---|---|
| Change list for `vps` (PRE-*, PKG-*, VPS-SSH/FW/WG/APP/CADDY/DNS/BK/MON) | SUPERSEDED | D-040 (paused) then D-043 (host cancelled) | Add "HISTORICAL — applies to the cancelled OVH VPS (D-043); vps-local list supersedes" banner |
| VPS-SSH-1, PKG-1/2 partially applied on the old host | SUPERSEDED | D-040; host cancelled | (banner) |
| Files `infra/vps/*` authored and locally validated; `compose.pilot.yaml` + `db-roles.sql` reused by vps-local | IMPLEMENTED | all listed paths exist; vps-local compose overrides the pilot file | — |

### `docs/VPS_LOCAL_CHANGE_LIST.md`

| claim | verdict | evidence | apply item? |
|---|---|---|---|
| "DRAFT. Claude has applied nothing" | STALE-DOC | go-live 2026-10-09 (STATUS.md:221), stack healthy | Rewrite the header: applied items, dates, what remains (L items) |
| Scope LAN only, no tunnel, nothing public | SUPERSEDED | D-047 (public hostnames through the tunnel); host env origins | (header rewrite) |
| Ports 8443/8444 bound to `192.168.203.196` only | STALE-DOC | host listeners `0.0.0.0:443`, `0.0.0.0:444`; `compose.vps-local.yaml:17` "host 443 (container 8443)…"; `check-host.sh` probes `:444` | Replace 8443/8444 with 443/444 throughout §1, §4.4, §4.7 |
| Origins `https://192.168.203.196:8443/8444` | SUPERSEDED | D-047 | (header rewrite) |
| Internal CA + edge cert in `/opt/ecloud/tls` | IMPLEMENTED | host `ls /opt/ecloud/tls` → `ca ecloud-lan-ca.crt edge.crt edge.key` | — |
| LCL-FW-2: RADIUS only from `192.168.203.198/32` | STALE-DOC | host `ECLOUD_RADIUS_CIDRS="192.168.203.0/24"` (within D-042 "named AP subnet(s)") | State the actual CIDRs in §4.3 |
| LCL-DOCKER-4 network-online drop-in; `ecloud-docker-user.service` | IMPLEMENTED | host `/etc/systemd/system/docker.service.d/10-ecloud-network-online.conf`, `ecloud-docker-user.service` enabled/active | — |
| LCL-ADM-2 reset-password CLI in image `1592364`, host wrapper | IMPLEMENTED | `packages/db/src/cli.ts:235`; host `reset-admin-password.sh`; api image id = tag `1592364`; never run (0 audit rows) | — |
| LCL-APP-5 "login … MFA enrolment" | SUPERSEDED | D-046 | (header rewrite) |
| §4.5 portal certificate options A/B/C for real hotspot clients | SUPERSEDED | D-047: public `portal.ezelink.ai` behind Cloudflare (publicly trusted edge) | Replace §4.5 with the D-047 state and the remaining walled-garden device step (OUT-OF-SCOPE for AP config) |
| LCL-BK-1..3 GitHub backups | IMPLEMENTED | timer active, `/etc/ecloud/backup-github.env`, `github_known_hosts`, `/opt/ecloud/bin/upload-github.sh` | — |
| LCL-MON-1 `ecloud-check.timer` every 5 min | MISSING | no unit file on host | Install `ecloud-check.{service,timer}` (S, owner root step) — the only host health check today is manual |
| LCL-LOG-1 journald cap (owner decision) | NEEDS-OWNER | `/etc/systemd/journald.conf.d/` absent | Owner: cap the appliance journal (`infra/logging/journald-ecloud.conf`) or leave EZEOS defaults? |
| Open items: DHCP reservation for .196; EZEOS upgrade preserves `/opt`; branch protection on `dannymagat/ecloud` | NEEDS-OWNER | no evidence either way from the host | Owner: (a) DHCP reservation set? (b) does an EZEOS upgrade keep `/opt`/`/etc`? (c) branch protection on code branches against the write deploy key? |
| Images transferred by `docker save/scp/load`; GHCR push optional | PARTIAL | host image list is local tags, no registry pull; CI `images` job exists | — |

### `infra/vps/README.md`

| claim | verdict | evidence | apply item? |
|---|---|---|---|
| nftables, fail2ban, sshd drop-in, Caddy site, WireGuard drop-in for `vps` — DRAFT, not applied | SUPERSEDED | D-043; VPS_LOCAL_CHANGE_LIST §7 lists them as "no longer apply" | Add one line: "vps-local uses only `compose/` and `scripts/common.sh` from this directory (D-043)" |
| `compose/compose.pilot.yaml`, `db-roles.sql` are the pilot Compose base | IMPLEMENTED | reused unchanged on vps-local (`/opt/ecloud/infra/vps/compose` per LCL-FILES-1; `compose.vps-local.yaml` overrides) | — |
| `validate-local.sh` + `test/` run container-based checks | IMPLEMENTED | files exist; STATUS.md:198 "validate-local 6/6" | — |

## Apply items (lane 1 view, for the Orchestrator's merge)

1. Worker `ECLOUD_COA_ENABLED` is still unset/false on the pilot: D-061's "retried-then-recorded error, never `unsupported`" cannot happen until it is set; prerequisite for the D-065 device test. (S, compose override; record in DECISIONS.)
2. STATUS.md + CLAUDE.md are two deploys and 30 decisions behind (stage header, safety state, change log, counts). (S, doc fix, no risk.)
3. Pilot monitoring is absent: no `ecloud-check.timer`, no uptime-kuma, no Prometheus; alert rules and backup-missing alerts are inert. Minimum: install LCL-MON-1 (owner root step). (S/M.)
4. Retention prune is dry-run on the pilot (`RETENTION_APPLY` unset) — D-025 retention is not enforced. NEEDS-OWNER.
5. Untracked `049_portal_registration_devices.sql` sits in the working tree while the host has 48 applied; commit/drop before the next deploy, and renumber any D-064 tightening migration to 050+. (S.)
6. Persist the accounting drain cursor in Postgres (`worker_cursors`) — Phase 10 residual, still open. (S/M.)
7. Historical banners on DISCOVERY_REPORT, REMOTE_ENVIRONMENT, VPS_CHANGE_LIST, infra/vps/README; header rewrites on DEPLOYMENT_ARCHITECTURE, TARGET_ARCHITECTURE, VPS_LOCAL_CHANGE_LIST (ports 443/444, D-047 scope). (S, doc.)
8. DEVELOPMENT.md / TESTING.md / README.md count and layout refresh (112 permissions, 46 tenant tables, 48 migrations, 6 CI jobs, DT-01 executed, apps/admin + packages/storage + vendor-api). (S, doc.)
9. Run the failure drills and load test on vps-local in an approved window; restore-drill one real GitHub backup set with the offline key. NEEDS-OWNER for the window.
10. `AGENT_LANES.md` named by D-053 does not exist in the repo; create or re-point. (S.)
