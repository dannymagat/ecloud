# Restore drill — backups, encryption, off-site copy, RTO/RPO (Phase 10, cycle P10-B)

Status: **LOCAL drill executed 2026-10-09 against the dev stack** (docker compose
`ecloud-dev-postgres`, PostgreSQL 16.15). Nothing was applied to the VPS (D-031); the nightly
schedule and the off-site target are items of `docs/VPS_CHANGE_LIST.md` (VPS-BK-1) and Q18.

Binding sources: SECURITY_ARCHITECTURE.md §10.1 (backups, age, monthly drill, T-10 negative test),
DEPLOYMENT_ARCHITECTURE.md §5 (pg_dump -Fc, retention, RPO 24 h / RTO 2 h pilot), D-026 (backups
must not depend solely on the VPS filesystem), D-033 (no secrets in git).

## 1. Tooling (`scripts/backup/`)

| File | Purpose |
|---|---|
| `backup.sh` | `pg_dump -Fc` (inside the Postgres container via `docker exec`, or host `pg_dump`) **piped straight into `age -R <recipients>`** — no plaintext dump ever touches disk; optional config tarball (also age-encrypted); `SHA256SUMS` + `manifest.json`; directory 0700 / files 0600; atomic `.partial-*` → final rename; keep-N retention (`BACKUP_RETENTION_COUNT`); off-site upload hook (`BACKUP_UPLOAD=rclone` → `rclone copy --immutable` + `rclone check`, or `command`); optional uptime-kuma push and node_exporter textfile metric (`ecloud_backup_last_success_timestamp_seconds`) |
| `restore.sh` | verifies `SHA256SUMS` **before** decrypting, streams `age -d | pg_restore --exit-on-error`, refuses a non-empty target unless `--skip-empty-check`, `--create` refuses an existing database |
| `restore-drill.sh` | the repeatable drill below (throwaway age identity in a temp dir outside the repo, scratch databases created **and dropped** by the script) |
| `lib.sh` | shared helpers (checksums, recipients-file check: refuses any `AGE-SECRET-KEY-` line) |
| `recipients.example.txt`, `backup.env.example` | EXAMPLE public key (its private half was deleted at generation — undecryptable by design) and example env |
| `systemd/ecloud-backup.{service,timer}` | DRAFT nightly unit (02:15 UTC, `Persistent=true`, 128 MiB / 25 % CPU, `ProtectSystem=strict`) |

Guard rails enforced by the scripts (each one exercised as a negative check in the drill):

- `BACKUP_UPLOAD=none` fails unless `BACKUP_ALLOW_LOCAL_ONLY=1` (dev/drill only) — **D-026**.
- A recipients file containing a private key is refused (the host must only ever hold public keys).
- A tampered backup set fails checksum verification before any decryption.
- An env file passed with `--env-file` must be mode 0600/0400.

Dumps contain only password hashes and `*_ref` ciphertext by construction (A6 §10); the age
identity (private key) stays **offline** and is brought to a host only for a recovery. Keep two
recipients (owner + ops key) so that losing one key does not lose the backups (key rotation:
SECURITY_ARCHITECTURE.md §9, "Backup age key — 2 years").

## 2. How to run

```bash
npm run build                                   # packages/db/dist/cli.js is used for `status`
AGE_BIN=/path/to/age scripts/backup/restore-drill.sh            # small: the dev `ecloud` DB
DRILL_SYNTHETIC_RADACCT_ROWS=1000000 AGE_BIN=/path/to/age \
  scripts/backup/restore-drill.sh                                # scale run on a scratch clone
```

`age` v1.2.1 (official release tarball, darwin-amd64) was used from a temp directory outside the
repository; on the VPS it is the Ubuntu `age` package (VPS change list). The drill never writes
to the source database; for the scale run it builds a scratch clone `ecloud_drill_src_<ts>`
(pg_dump | pg_restore inside the container) and drops it at the end together with the restore
target `ecloud_restore_drill_<ts>`. After both runs `SELECT datname FROM pg_database` listed only
`ecloud`, `ecloud_audit_20261007`, `ecloud_test`, `postgres`, `template0/1`.

Drill sequence: throwaway identity → negative checks → 3 backups with `BACKUP_RETENTION_COUNT=2`
and an off-site hook (a temp "remote" directory standing in for rclone/S3) → assert 2 local /
3 off-site sets, files 0600, dump not readable as `PGDMP` (encrypted) → tampered copy refused →
**restore of the OFF-SITE copy** into a fresh scratch DB → verification → drop.

Verification after restore (all compared with the source at dump time):

1. `ecloud-db status` (migration runner) on the restored DB — same summary and exit code as the source.
2. Exact row counts of every table in `public` and `radius` (75 tables incl. partitions).
3. RLS flags (`relrowsecurity` / `relforcerowsecurity`) per table, `pg_policies` count, table grants of `ecloud_app` / `ecloud_platform` / `ecloud_radius`.
4. Content hash of `organizations`, highest `radius.radacct_raw.radacctid`.
5. **T-10 negative test**: `ecloud_app` without `app.current_org` sees **0** rows of `sites` (RLS forced); with `SET LOCAL app.current_org` it sees the tenant's rows. (`organizations` is the tenant root and has no RLS by design, so it is not the probe table.)

## 3. Results (2026-10-09, developer workstation: x86_64, 16 vCPU Docker Desktop)

| Measure | Run A — dev `ecloud` DB | Run B — scale clone (+1 000 000 radacct_raw rows) |
|---|---|---|
| Source size (`pg_database_size`) | 15.5 MB (15 514 647 B) | 490.6 MB (490 568 727 B) |
| Tables / rows verified | 75 / 2 229 | 75 / 1 002 229 |
| Encrypted dump size | 0.45 MB (449 499 B) | 37.9 MB (37 884 903 B) |
| Backup run (dump + encrypt + config + checksums + upload), 3 runs | 1 162 / 713 / 750 ms | 6 119 / 6 298 / 7 867 ms |
| Checksum verification | 28 ms | 209 ms |
| Decrypt + `pg_restore` | 2 258 ms | 14 959 ms |
| Restore total (incl. create DB) | 2 334 ms | 15 221 ms |
| Post-restore verification | 1 872 ms | 2 318 ms |
| Row counts / RLS flags / policies (63) / grants (786) equal | yes / yes / yes / yes | yes / yes / yes / yes |
| Tables with RLS forced | 61 | 61 |
| Migrations (`ecloud-db status`) | `status: clean`, 26 applied (= source) | `status: clean`, 26 applied (= source) |
| T-10: `ecloud_app` without tenant / with tenant (`sites`) | 0 / 1 | 0 / 1 |
| Retention keep=2: local sets / off-site sets | 2 / 3 | 2 / 3 |
| Negative checks (private key in recipients, local-only, tampered set) | 3/3 refused | 3/3 refused |
| Result | `"ok": true` | `"ok": true` |

The 1 M synthetic accounting rows (≈ 6 months of a 50-session site at 10-min interims, or ~2.5
years at the pilot's expected load) restore in 15 s on this workstation, i.e. ~31 s per GB of
database. The pilot VPS has 2 vCPU and slower disks; budget **×4** (≈ 2 min per GB) until a drill
has been run there.

## 4. RPO / RTO

| | Pilot (measured + proposed) | Notes |
|---|---|---|
| **RPO** | **≤ 24 h** (nightly `ecloud-backup.timer`, `Persistent=true` catches a missed run after downtime) | dump time is seconds, so the RPO is the schedule; accounting rows written after the last dump are lost on a total host loss (FreeRADIUS `radacct_raw` lives in the same DB). Lower RPO = WAL archiving / managed PITR (production target ≤ 15 min, DEPLOYMENT_ARCHITECTURE §5). |
| **RTO — database part** | **≈ 15 s for 0.5 GB measured; ≤ 5 min budgeted** at pilot sizes on the VPS | checksum + decrypt + `pg_restore` + verification |
| **RTO — whole service** | **2 h** (unchanged pilot target) | dominated by host rebuild: VPS/OS, Docker, `/opt/ecloud` Compose project, secrets from the offline store, restore, `migrate status`, smoke (`/readyz`, `radclient status`), WireGuard hub re-keying only if the hub key was lost (SECURITY_ARCHITECTURE §10 incident table) |

Monitoring of the backup itself: uptime-kuma push monitor (`BACKUP_PUSH_URL`, alert after 26 h)
for the pilot; `EcloudBackupMissing` in `infra/monitoring/alerts.yml` once node_exporter/Prometheus
exist.

## 5. Gaps and follow-ups

- **Off-site target is still REQUIRES CLARIFICATION (Q18).** The drill proved the hook with a
  local stand-in directory; `rclone copy --immutable` / `rclone check` against a real
  S3-compatible bucket is unexercised (rclone is not installed on this workstation).
- `@ecloud/storage` was **not** used for the upload: its keys are tenant-scoped
  (`organization_id/purpose/…`), backups are platform-level, and the VPS deploy root holds no
  source code; rclone is the documented pilot path (DEPLOYMENT_ARCHITECTURE §5).
- The pilot backup role `ecloud_backup` is now created by `infra/vps/compose/db-roles.sql`:
  `pg_read_all_data` **plus `BYPASSRLS`** (pg_dump refuses FORCE RLS tables without it), no
  password (container-local socket only). Verified in a throw-away Postgres 16: full dump of a
  FORCE RLS table, writes denied. The dev drill still dumps as the dev superuser.
- **Off-site retention is not implemented**: `BACKUP_RETENTION_COUNT` prunes local sets only, so
  the off-site copy grows without bound. Use the bucket's lifecycle rule (e.g. expire after
  35 days) once the target is chosen (Q18); `--immutable` uploads are never overwritten.
- Review fixes (2026-10-09): single-run `flock` on `$BACKUP_DIR/.lock`; textfile metric and push
  failures are logged, never fatal (a good backup is no longer reported failed); the systemd unit
  may write the textfile directory; `EcloudBackupMissing` also fires when no backup ever ran
  (`absent()`); env file must be owned by root or the invoking user; `restore.sh`
  `--target-is-fresh` renamed `--skip-empty-check` and refused on the live database name without
  `--allow-live-target`.
- `BACKUP_CONFIG_PATHS` on the VPS includes `/etc/caddy` and `/etc/nftables.conf`; the WireGuard
  hub key must be encrypted to a **different** (ops) recipient (SECURITY_ARCHITECTURE §10.1) —
  run `backup.sh` a second time with that recipients file and only the key path.
- Run the drill monthly; the first run on the VPS (after approval) replaces the workstation numbers.
