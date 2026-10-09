#!/usr/bin/env bash
# LOCAL restore drill against the dev stack (docker compose `ecloud-dev-postgres`).
#
#   scripts/backup/restore-drill.sh            # source database: ecloud (dev)
#   DRILL_SOURCE_DB=ecloud AGE_BIN=/path/to/age scripts/backup/restore-drill.sh
#   DRILL_SYNTHETIC_RADACCT_ROWS=1000000 scripts/backup/restore-drill.sh   # scale run (see below)
#
# Scale run: with DRILL_SYNTHETIC_RADACCT_ROWS=N the source is a scratch CLONE
# (`ecloud_drill_src_<ts>`, created by pg_dump | pg_restore of the source inside the container) with N
# synthetic radius.radacct_raw rows added; the clone is dropped at the end like the restore target.
#
# What it does (SECURITY_ARCHITECTURE.md §10.1 "monthly restore drill", DEPLOYMENT_ARCHITECTURE §5):
#   1. throwaway age identity in a temp dir OUTSIDE the repository (deleted at the end);
#   2. negative checks of the tooling (private key in recipients file, local-only upload,
#      tampered set) — each must be refused;
#   3. three backups with BACKUP_RETENTION_COUNT=2 and an off-site upload hook (a temp "remote"
#      directory standing in for S3/rclone) → exactly 2 local sets remain, all uploaded;
#   4. restore of the newest OFF-SITE copy into a scratch database `ecloud_restore_drill_<ts>`;
#   5. verification: migration status (packages/db CLI), exact per-table row counts, RLS flags,
#      policy and grant counts vs the source, content hash of organizations, and the T-10
#      negative test (ecloud_app without SET LOCAL app.current_org sees 0 rows);
#   6. DROP of the scratch database (always, via trap) and removal of the temp dir.
# It never writes to the source database and never touches any database it did not create.
# Prints one JSON result document on stdout (timings in ms).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/../.." && pwd)"
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"
# shellcheck disable=SC2034 # read by lib.sh log()
LOG_TAG=drill

export BACKUP_PG_CONTAINER="${BACKUP_PG_CONTAINER:-ecloud-dev-postgres}"
export BACKUP_PG_USER="${BACKUP_PG_USER:-ecloud}"
SOURCE_DB="${DRILL_SOURCE_DB:-ecloud}"
AGE_BIN="${AGE_BIN:-age}"
AGE_KEYGEN="${AGE_KEYGEN:-$(dirname "$(command -v "$AGE_BIN" 2>/dev/null || echo "$AGE_BIN")")/age-keygen}"
export AGE_BIN
PLATFORM_PASSWORD="${ECLOUD_PLATFORM_PASSWORD:-ecloud_dev_password}" # DEV ONLY default
PG_HOST_PORT="${POSTGRES_PORT:-5432}"
STAMP="$(date -u +%Y%m%d%H%M%S)"
SCRATCH="ecloud_restore_drill_$STAMP"
[[ "$SOURCE_DB" =~ ^[a-z_][a-z0-9_]*$ ]] || die "bad DRILL_SOURCE_DB"
[ -x "$AGE_KEYGEN" ] || command -v "$AGE_KEYGEN" >/dev/null || die "age-keygen not found"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/ecloud-drill.XXXXXX")"
case "$TMP" in "$REPO"*) die "temp dir must be outside the repository" ;; esac
created_scratch=0
created_clone=0
SYNTHETIC="${DRILL_SYNTHETIC_RADACCT_ROWS:-0}"
case "$SYNTHETIC" in '' | *[!0-9]*) die "DRILL_SYNTHETIC_RADACCT_ROWS must be an integer" ;; esac
CLONE="ecloud_drill_src_$STAMP"
cleanup() {
  if [ "$created_clone" = "1" ]; then
    docker exec "$BACKUP_PG_CONTAINER" psql -X -q -U "$BACKUP_PG_USER" -d postgres \
      -c "DROP DATABASE IF EXISTS \"$CLONE\" WITH (FORCE)" >/dev/null 2>&1 &&
      log "dropped scratch source clone $CLONE" || log "WARNING: could not drop $CLONE"
  fi
  if [ "$created_scratch" = "1" ]; then
    docker exec "$BACKUP_PG_CONTAINER" psql -X -q -U "$BACKUP_PG_USER" -d postgres \
      -c "DROP DATABASE IF EXISTS \"$SCRATCH\" WITH (FORCE)" >/dev/null 2>&1 &&
      log "dropped scratch database $SCRATCH" || log "WARNING: could not drop $SCRATCH"
  fi
  rm -rf "$TMP"
}
trap cleanup EXIT

psql_on() { docker exec -i "$BACKUP_PG_CONTAINER" psql -X -At -v ON_ERROR_STOP=1 -U "$1" -d "$2" -c "$3"; }
expect_fail() {
  local name="$1"
  shift
  if "$@" >/dev/null 2>"$TMP/neg.err"; then die "negative check '$name' unexpectedly succeeded"; fi
  log "negative check ok: $name ($(tail -n1 "$TMP/neg.err" | sed 's/.*ERROR: //'))"
}

# --- 1. throwaway identity ------------------------------------------------------------------
"$AGE_KEYGEN" -o "$TMP/identity.txt" 2>/dev/null
grep '^# public key: ' "$TMP/identity.txt" | sed 's/^# public key: //' >"$TMP/recipients.txt"
mkdir -p "$TMP/offsite"
cat >"$TMP/upload.sh" <<'SH'
#!/bin/sh
# Stand-in for the off-site hook (rclone/S3 in production): copy the set to another location.
set -eu
cp -R "$1" "$DRILL_OFFSITE_DIR/"
SH
chmod +x "$TMP/upload.sh"
export DRILL_OFFSITE_DIR="$TMP/offsite"
export BACKUP_DIR="$TMP/local"
export BACKUP_AGE_RECIPIENTS_FILE="$TMP/recipients.txt"
export BACKUP_PG_DATABASE="$SOURCE_DB"
export BACKUP_RETENTION_COUNT=2
export BACKUP_CONFIG_PATHS="$REPO/infra/compose $REPO/infra/freeradius/raddb"

# --- 1b. optional scale clone ---------------------------------------------------------------
if [ "$SYNTHETIC" -gt 0 ]; then
  created_clone=1
  # Clone via dump/restore (a TEMPLATE copy would need the source to have no other sessions).
  psql_on "$BACKUP_PG_USER" postgres "CREATE DATABASE \"$CLONE\"" >/dev/null
  docker exec "$BACKUP_PG_CONTAINER" sh -c \
    "pg_dump -Fc -U '$BACKUP_PG_USER' -d '$SOURCE_DB' | pg_restore --exit-on-error -U '$BACKUP_PG_USER' -d '$CLONE'"
  s0="$(now_ms)"
  psql_on "$BACKUP_PG_USER" "$CLONE" "INSERT INTO radius.radacct_raw
      (acctsessionid, acctuniqueid, username, nasipaddress, nasidentifier, acctstatustype,
       acctsessiontime, acctinputoctets, acctoutputoctets, callingstationid, calledstationid,
       framedipaddress, eventtimestamp, received_at, packet_src_ip)
    SELECT 'drill-' || (g / 6), md5('drill-' || g), 'drill-user-' || (g % 500), '203.0.113.9',
       'drill-nas', CASE WHEN g % 6 = 0 THEN 'Start' WHEN g % 6 = 5 THEN 'Stop' ELSE 'Interim-Update' END,
       (g % 6) * 600, (g % 6) * 1048576, (g % 6) * 4194304, 'AA-BB-CC-00-00-01', '00-11-22-33-44-55:drill',
       '10.9.0.1', now() - interval '1 second' * g, now() - interval '1 second' * g, '203.0.113.9'
    FROM generate_series(1, $SYNTHETIC) AS g" >/dev/null
  log "scale clone $CLONE: +$SYNTHETIC synthetic radacct_raw rows in $(($(now_ms) - s0)) ms"
  SOURCE_DB="$CLONE"
  export BACKUP_PG_DATABASE="$CLONE"
fi

# --- 2. negative checks -----------------------------------------------------------------------
cp "$TMP/identity.txt" "$TMP/bad-recipients.txt"
expect_fail "private key in recipients file" \
  env BACKUP_AGE_RECIPIENTS_FILE="$TMP/bad-recipients.txt" BACKUP_UPLOAD=command \
  BACKUP_UPLOAD_COMMAND="$TMP/upload.sh" "$SCRIPT_DIR/backup.sh"
expect_fail "local-only backup without BACKUP_ALLOW_LOCAL_ONLY (D-026)" \
  env BACKUP_UPLOAD=none "$SCRIPT_DIR/backup.sh"

# --- 3. backups + retention + upload ----------------------------------------------------------
src_counts() {
  psql_on "$BACKUP_PG_USER" "$1" "SELECT n.nspname || '.' || c.relname || '=' ||
    (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM %I.%I', n.nspname, c.relname), false, true, '')))[1]::text
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r','p') AND n.nspname IN ('public','radius') ORDER BY 1"
}
rls_flags() {
  psql_on "$BACKUP_PG_USER" "$1" "SELECT n.nspname || '.' || c.relname || ':' || c.relrowsecurity || ':' || c.relforcerowsecurity
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r','p') AND n.nspname IN ('public','radius') ORDER BY 1"
}
scalar() { psql_on "$BACKUP_PG_USER" "$1" "$2"; }
POLICIES_SQL="SELECT count(*) FROM pg_policies"
GRANTS_SQL="SELECT count(*) FROM information_schema.role_table_grants WHERE grantee IN ('ecloud_app','ecloud_platform','ecloud_radius')"
ORG_HASH_SQL="SELECT coalesce(md5(string_agg(o::text, '|' ORDER BY o.id)), 'empty') FROM organizations o"
LAST_ACCT_SQL="SELECT coalesce(max(radacctid)::text, 'none') FROM radius.radacct_raw"

src_counts "$SOURCE_DB" >"$TMP/source.counts"
rls_flags "$SOURCE_DB" >"$TMP/source.rls"
SRC_POLICIES="$(scalar "$SOURCE_DB" "$POLICIES_SQL")"
SRC_GRANTS="$(scalar "$SOURCE_DB" "$GRANTS_SQL")"
SRC_ORG_HASH="$(scalar "$SOURCE_DB" "$ORG_HASH_SQL")"
SRC_LAST_ACCT="$(scalar "$SOURCE_DB" "$LAST_ACCT_SQL")"
SRC_ORGS="$(scalar "$SOURCE_DB" "SELECT count(*) FROM organizations")"
SRC_SIZE="$(scalar "$SOURCE_DB" "SELECT pg_database_size('$SOURCE_DB')")"

backup_ms=()
last_set=""
for i in 1 2 3; do
  b0="$(now_ms)"
  last_set="$(BACKUP_UPLOAD=command BACKUP_UPLOAD_COMMAND="$TMP/upload.sh" "$SCRIPT_DIR/backup.sh")"
  backup_ms+=("$(($(now_ms) - b0))")
  [ "$i" = 3 ] || sleep 1.1 # distinct UTC-second stamps
done
LOCAL_SETS="$(find "$BACKUP_DIR" -maxdepth 1 -mindepth 1 -type d -name '20*' | wc -l | tr -d ' ')"
OFFSITE_SETS="$(find "$TMP/offsite" -maxdepth 1 -mindepth 1 -type d | wc -l | tr -d ' ')"
[ "$LOCAL_SETS" = "2" ] || die "retention: expected 2 local sets, found $LOCAL_SETS"
[ "$OFFSITE_SETS" = "3" ] || die "upload: expected 3 off-site sets, found $OFFSITE_SETS"
SET_NAME="$(basename "$last_set")"
DB_BYTES="$(size_of "$last_set"/ecloud-db-*.dump.age)"
PERMS="$(stat -c %a "$last_set/SHA256SUMS" 2>/dev/null || stat -f %Lp "$last_set/SHA256SUMS")"
[ "$PERMS" = "600" ] || die "backup files must be 0600 (got $PERMS)"
if grep -a -q 'PGDMP' "$last_set"/ecloud-db-*.dump.age; then die "dump is not encrypted"; fi
log "backups ok: local=$LOCAL_SETS offsite=$OFFSITE_SETS, newest=$SET_NAME (${DB_BYTES} bytes)"

# Tampered copy must be refused before decryption.
cp -R "$TMP/offsite/$SET_NAME" "$TMP/tampered"
printf 'x' >>"$TMP/tampered"/ecloud-db-*.dump.age
expect_fail "tampered backup set (checksum)" \
  "$SCRIPT_DIR/restore.sh" --set "$TMP/tampered" --identity "$TMP/identity.txt" --target-db "${SCRATCH}_never" --create

# --- 4. restore the OFF-SITE copy into a scratch database ------------------------------------
r0="$(now_ms)"
created_scratch=1
restore_json="$("$SCRIPT_DIR/restore.sh" --set "$TMP/offsite/$SET_NAME" --identity "$TMP/identity.txt" \
  --target-db "$SCRATCH" --create)"
restore_total_ms="$(($(now_ms) - r0))"

# --- 5. verification ----------------------------------------------------------------------------
v0="$(now_ms)"
src_counts "$SCRATCH" >"$TMP/restored.counts"
rls_flags "$SCRATCH" >"$TMP/restored.rls"
COUNTS_EQUAL=false
cmp -s "$TMP/source.counts" "$TMP/restored.counts" && COUNTS_EQUAL=true
RLS_EQUAL=false
cmp -s "$TMP/source.rls" "$TMP/restored.rls" && RLS_EQUAL=true
TABLES="$(wc -l <"$TMP/restored.counts" | tr -d ' ')"
ROWS="$(awk -F= '{s+=$2} END {print s+0}' "$TMP/restored.counts")"
RLS_FORCED="$(grep -c ':true:true$' "$TMP/restored.rls" || true)"
DST_POLICIES="$(scalar "$SCRATCH" "$POLICIES_SQL")"
DST_GRANTS="$(scalar "$SCRATCH" "$GRANTS_SQL")"
DST_ORG_HASH="$(scalar "$SCRATCH" "$ORG_HASH_SQL")"
DST_LAST_ACCT="$(scalar "$SCRATCH" "$LAST_ACCT_SQL")"
# T-10 negative test on a tenant table (`sites`, RLS forced; `organizations` is the tenant root
# without RLS by design): the app role without a tenant context sees nothing, with it sees rows.
APP_NO_CTX="$(psql_on ecloud_app "$SCRATCH" "SELECT count(*) FROM sites")"
SITES_TOTAL="$(scalar "$SCRATCH" "SELECT count(*) FROM sites")"
APP_WITH_CTX="n/a"
first_org="$(scalar "$SCRATCH" "SELECT organization_id FROM sites ORDER BY organization_id LIMIT 1")"
if [ -n "$first_org" ]; then
  APP_WITH_CTX="$(docker exec -i "$BACKUP_PG_CONTAINER" psql -X -q -At -v ON_ERROR_STOP=1 -U ecloud_app -d "$SCRATCH" <<SQL | tail -n1
BEGIN;
SELECT set_config('app.current_org', '$first_org', true);
SELECT count(*) FROM sites;
COMMIT;
SQL
)"
fi
MIG_OUT="$TMP/migrate-status.txt"
MIG_EXIT=0
node "$REPO/packages/db/dist/cli.js" status \
  --url "postgres://ecloud_platform:${PLATFORM_PASSWORD}@127.0.0.1:${PG_HOST_PORT}/${SCRATCH}" >"$MIG_OUT" 2>&1 || MIG_EXIT=$?
MIG_SRC_EXIT=0
node "$REPO/packages/db/dist/cli.js" status \
  --url "postgres://ecloud_platform:${PLATFORM_PASSWORD}@127.0.0.1:${PG_HOST_PORT}/${SOURCE_DB}" >"$TMP/migrate-src.txt" 2>&1 || MIG_SRC_EXIT=$?
MIG_SUMMARY="$(grep '^status:' "$MIG_OUT" || tail -n1 "$MIG_OUT")"
MIG_SRC_SUMMARY="$(grep '^status:' "$TMP/migrate-src.txt" || tail -n1 "$TMP/migrate-src.txt")"
MIG_APPLIED="$(grep -c '^  applied' "$MIG_OUT" || true)"
verify_ms="$(($(now_ms) - v0))"

ok=true
[ "$COUNTS_EQUAL" = true ] || ok=false
[ "$RLS_EQUAL" = true ] || ok=false
[ "$SRC_POLICIES" = "$DST_POLICIES" ] || ok=false
[ "$SRC_GRANTS" = "$DST_GRANTS" ] || ok=false
[ "$SRC_ORG_HASH" = "$DST_ORG_HASH" ] || ok=false
[ "$SRC_LAST_ACCT" = "$DST_LAST_ACCT" ] || ok=false
[ "$APP_NO_CTX" = "0" ] || ok=false
if [ "$SITES_TOTAL" != "0" ]; then [ "$APP_WITH_CTX" != "0" ] || ok=false; fi
[ "$MIG_EXIT" = "$MIG_SRC_EXIT" ] || ok=false
[ "$MIG_SUMMARY" = "$MIG_SRC_SUMMARY" ] || ok=false

cat <<JSON
{
  "drill": "restore",
  "ok": $ok,
  "source_db": "$SOURCE_DB",
  "synthetic_radacct_rows": $SYNTHETIC,
  "source_db_bytes": $SRC_SIZE,
  "scratch_db": "$SCRATCH",
  "backup_set": "$SET_NAME",
  "encrypted_dump_bytes": $DB_BYTES,
  "backup_run_ms": [${backup_ms[0]}, ${backup_ms[1]}, ${backup_ms[2]}],
  "retention": { "keep": 2, "local_sets": $LOCAL_SETS, "offsite_sets": $OFFSITE_SETS },
  "restore": $restore_json,
  "restore_total_ms": $restore_total_ms,
  "verification_ms": $verify_ms,
  "tables": $TABLES,
  "rows": $ROWS,
  "row_counts_equal": $COUNTS_EQUAL,
  "rls_flags_equal": $RLS_EQUAL,
  "rls_forced_tables": $RLS_FORCED,
  "policies": { "source": $SRC_POLICIES, "restored": $DST_POLICIES },
  "grants": { "source": $SRC_GRANTS, "restored": $DST_GRANTS },
  "organizations": { "source": $SRC_ORGS, "hash_equal": $([ "$SRC_ORG_HASH" = "$DST_ORG_HASH" ] && echo true || echo false) },
  "last_radacctid": { "source": "$SRC_LAST_ACCT", "restored": "$DST_LAST_ACCT" },
  "t10_sites_total": $SITES_TOTAL,
  "t10_app_role_without_tenant_sites": $APP_NO_CTX,
  "t10_app_role_with_tenant_sites": "$APP_WITH_CTX",
  "migrations": { "restored": "$MIG_SUMMARY", "restored_exit": $MIG_EXIT, "restored_applied": $MIG_APPLIED, "source": "$MIG_SRC_SUMMARY", "source_exit": $MIG_SRC_EXIT }
}
JSON
[ "$ok" = true ] || die "restore drill FAILED (see JSON above)"
log "restore drill passed"
