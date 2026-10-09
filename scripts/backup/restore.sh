#!/usr/bin/env bash
# ECLOUD restore: verify checksums, decrypt with an age identity, pg_restore into a target DB.
#
#   scripts/backup/restore.sh --set DIR --identity FILE --target-db NAME
#                             [--pg-container NAME] [--pg-user ROLE] [--create] [--skip-empty-check [--allow-live-target]]
#
# Safety rails:
#   * checksums (SHA256SUMS) are verified before anything is decrypted;
#   * the decrypted dump is streamed (never written to disk);
#   * the target database must be EMPTY (no tables outside pg_catalog/information_schema) unless
#     --skip-empty-check is given; with --create it must not exist yet and is created here;
#   * --skip-empty-check against the live database name (BACKUP_PG_DATABASE, default ecloud) also
#     needs --allow-live-target (never restore over the live DB by a single mistyped flag);
#   * the age identity (private key) is only read from FILE — keep it offline, never on the VPS
#     except for the duration of a disaster recovery (SECURITY_ARCHITECTURE.md §10.1).
# Roles referenced by the dump (ecloud_app, ecloud_platform, ecloud_radius, …) must already exist
# in the target cluster (infra/compose/postgres-init creates them).
set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"
# shellcheck disable=SC2034 # read by lib.sh log()
LOG_TAG=restore

SET_DIR="" IDENTITY="" TARGET="" CREATE=0 FRESH=0 ALLOW_LIVE=0
BACKUP_PG_CONTAINER="${BACKUP_PG_CONTAINER:-}"
BACKUP_PG_USER="${BACKUP_PG_USER:-ecloud}"
AGE_BIN="${AGE_BIN:-age}"
while [ $# -gt 0 ]; do
  case "$1" in
    --set) SET_DIR="$2"; shift 2 ;;
    --identity) IDENTITY="$2"; shift 2 ;;
    --target-db) TARGET="$2"; shift 2 ;;
    --pg-container) BACKUP_PG_CONTAINER="$2"; shift 2 ;;
    --pg-user) BACKUP_PG_USER="$2"; shift 2 ;;
    --create) CREATE=1; shift ;;
    --skip-empty-check) FRESH=1; shift ;;
    --allow-live-target) ALLOW_LIVE=1; shift ;;
    *) die "unknown argument: $1" ;;
  esac
done
[ -d "$SET_DIR" ] || die "--set DIR required"
[ -f "$IDENTITY" ] || die "--identity FILE required"
[[ "$TARGET" =~ ^[a-z_][a-z0-9_]{0,62}$ ]] || die "--target-db must be a plain lowercase identifier"
if [ "$FRESH" = "1" ] && [ "$TARGET" = "${BACKUP_PG_DATABASE:-ecloud}" ] && [ "$ALLOW_LIVE" != "1" ]; then
  die "--skip-empty-check on the live database name $TARGET also requires --allow-live-target"
fi

psql_admin() { pg_cmd psql -X -v ON_ERROR_STOP=1 -At -U "$BACKUP_PG_USER" -d postgres "$@"; }

DB_FILE="$(cd "$SET_DIR" && ls ecloud-db-*.dump.age 2>/dev/null | head -n1)"
[ -n "$DB_FILE" ] || die "no ecloud-db-*.dump.age in $SET_DIR"

t0="$(now_ms)"
verify_sums "$SET_DIR"
log "checksums ok ($SET_DIR)"
t1="$(now_ms)"

exists="$(psql_admin -c "SELECT 1 FROM pg_database WHERE datname = '$TARGET'")"
if [ "$CREATE" = "1" ]; then
  [ -z "$exists" ] || die "target database $TARGET already exists (refusing --create)"
  psql_admin -c "CREATE DATABASE \"$TARGET\"" >/dev/null
  log "created database $TARGET"
else
  [ -n "$exists" ] || die "target database $TARGET does not exist (use --create)"
  if [ "$FRESH" != "1" ]; then
    tables="$(pg_cmd psql -X -At -U "$BACKUP_PG_USER" -d "$TARGET" -c \
      "SELECT count(*) FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema')")"
    [ "$tables" = "0" ] || die "target database $TARGET is not empty ($tables tables); refusing"
  fi
fi

log "decrypt | pg_restore -> $TARGET"
"$AGE_BIN" -d -i "$IDENTITY" "$SET_DIR/$DB_FILE" |
  pg_cmd pg_restore --exit-on-error -U "$BACKUP_PG_USER" -d "$TARGET"
t2="$(now_ms)"
log "restore complete: verify $((t1 - t0))ms, restore $((t2 - t1))ms"
printf '{"verify_ms":%d,"restore_ms":%d,"target":"%s"}\n' "$((t1 - t0))" "$((t2 - t1))" "$TARGET"
