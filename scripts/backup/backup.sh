#!/usr/bin/env bash
# ECLOUD backup: PostgreSQL custom-format dump + config tarball, encrypted client-side with age
# BEFORE anything touches disk, SHA-256 checksums, keep-N retention, off-site upload hook.
#
#   scripts/backup/backup.sh [--env-file FILE]
#
# Design: SECURITY_ARCHITECTURE.md §10.1, DEPLOYMENT_ARCHITECTURE.md §5, D-026 (backups must not
# depend solely on the VPS filesystem), D-033 (no secrets in git). Nothing here is applied to the
# VPS by this repository; the VPS change list (docs/VPS_CHANGE_LIST.md) carries the schedule.
#
# Configuration (environment, or an env file with mode 0600 passed via --env-file):
#   BACKUP_DIR                  local backup root                        (default /var/backups/ecloud)
#   BACKUP_AGE_RECIPIENTS_FILE  age PUBLIC key(s), one per line          (required)
#   BACKUP_RETENTION_COUNT      complete backup sets kept locally         (default 7)
#   BACKUP_PG_CONTAINER         run pg_dump via `docker exec` in this container (pilot layout)
#   BACKUP_PG_USER              database role for pg_dump (pg_read_all_data is enough) (default ecloud)
#   BACKUP_PG_DATABASE          database to dump                          (default ecloud)
#   BACKUP_DATABASE_URL         host-mode alternative (BACKUP_PG_CONTAINER empty); prefer PGPASSFILE
#   BACKUP_CONFIG_PATHS         space-separated files/dirs for the config tarball (missing ones skipped)
#   BACKUP_UPLOAD               none | rclone | command                   (default none)
#   BACKUP_RCLONE_REMOTE        e.g. offsite:ecloud-backups/pilot (rclone S3-compatible remote)
#   BACKUP_UPLOAD_COMMAND       command run as `$BACKUP_UPLOAD_COMMAND <set-dir>` (BACKUP_UPLOAD=command)
#   BACKUP_ALLOW_LOCAL_ONLY     1 = allow BACKUP_UPLOAD=none (DEV/DRILL ONLY; D-026 forbids it in prod)
#   BACKUP_PUSH_URL             optional uptime-kuma push URL called after success
#   BACKUP_TEXTFILE_DIR         optional node_exporter textfile dir: writes ecloud_backup.prom
#                               (ecloud_backup_last_success_timestamp_seconds, size, duration)
#   AGE_BIN                     age binary                                (default age)
#
# Output: $BACKUP_DIR/<UTC stamp>/{ecloud-db-<stamp>.dump.age, ecloud-config-<stamp>.tar.gz.age,
# SHA256SUMS, manifest.json}. Directory 0700, files 0600. A failed run leaves only a
# `.partial-*` directory, which the next run removes. Exit code != 0 on any failure.
set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"
# shellcheck disable=SC2034 # read by lib.sh log()
LOG_TAG=backup

if [ "${1:-}" = "--env-file" ]; then
  [ -f "${2:-}" ] || die "env file not found: ${2:-}"
  perms="$(stat -c %a "$2" 2>/dev/null || stat -f %Lp "$2")"
  case "$perms" in
    600 | 400) ;;
    *) die "env file $2 must be mode 0600 or 0400 (is $perms)" ;;
  esac
  # It is sourced as shell: only root or the invoking user may own it.
  owner="$(stat -c %u "$2" 2>/dev/null || stat -f %u "$2")"
  [ "$owner" = 0 ] || [ "$owner" = "$(id -u)" ] || die "env file $2 must be owned by root or uid $(id -u) (is $owner)"
  set -a
  # shellcheck disable=SC1090
  . "$2"
  set +a
fi

BACKUP_DIR="${BACKUP_DIR:-/var/backups/ecloud}"
BACKUP_RETENTION_COUNT="${BACKUP_RETENTION_COUNT:-7}"
BACKUP_PG_USER="${BACKUP_PG_USER:-ecloud}"
BACKUP_PG_DATABASE="${BACKUP_PG_DATABASE:-ecloud}"
BACKUP_UPLOAD="${BACKUP_UPLOAD:-none}"
AGE_BIN="${AGE_BIN:-age}"

case "$BACKUP_RETENTION_COUNT" in
  '' | *[!0-9]*) die "BACKUP_RETENTION_COUNT must be a positive integer" ;;
esac
[ "$BACKUP_RETENTION_COUNT" -ge 1 ] || die "BACKUP_RETENTION_COUNT must be >= 1"
command -v "$AGE_BIN" >/dev/null 2>&1 || [ -x "$AGE_BIN" ] || die "age not found ($AGE_BIN)"
check_recipients_file "${BACKUP_AGE_RECIPIENTS_FILE:-}"
case "$BACKUP_UPLOAD" in
  none)
    [ "${BACKUP_ALLOW_LOCAL_ONLY:-0}" = "1" ] ||
      die "BACKUP_UPLOAD=none: backups must not live only on this host (D-026); set an upload target"
    ;;
  rclone)
    command -v rclone >/dev/null 2>&1 || die "rclone not installed"
    [ -n "${BACKUP_RCLONE_REMOTE:-}" ] || die "BACKUP_RCLONE_REMOTE is not set"
    ;;
  command) [ -n "${BACKUP_UPLOAD_COMMAND:-}" ] || die "BACKUP_UPLOAD_COMMAND is not set" ;;
  *) die "BACKUP_UPLOAD must be none|rclone|command" ;;
esac

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
# One run at a time (timer vs manual run): the cleanup below would otherwise delete the other
# run's in-progress `.partial-*` set. flock is in util-linux (the VPS); absent on macOS dev hosts.
if command -v flock >/dev/null 2>&1; then
  exec 9>"$BACKUP_DIR/.lock"
  flock -n 9 || die "another backup run holds $BACKUP_DIR/.lock"
else
  log "flock not available: running without the single-run lock (dev host only)"
fi
# Leftovers of failed runs never count as backups.
find "$BACKUP_DIR" -maxdepth 1 -type d -name '.partial-*' -exec rm -rf {} +

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
WORK="$BACKUP_DIR/.partial-$STAMP"
FINAL="$BACKUP_DIR/$STAMP"
[ ! -e "$FINAL" ] || die "backup set $FINAL already exists"
mkdir -m 700 "$WORK"
trap 'rm -rf "$WORK"' EXIT

t0="$(now_ms)"
DB_FILE="ecloud-db-$STAMP.dump.age"
log "pg_dump -Fc $BACKUP_PG_DATABASE${BACKUP_PG_CONTAINER:+ (container $BACKUP_PG_CONTAINER)} | age -> $DB_FILE"
if [ -n "${BACKUP_PG_CONTAINER:-}" ]; then
  pg_cmd pg_dump -Fc -U "$BACKUP_PG_USER" -d "$BACKUP_PG_DATABASE" |
    "$AGE_BIN" -R "$BACKUP_AGE_RECIPIENTS_FILE" -o "$WORK/$DB_FILE"
else
  [ -n "${BACKUP_DATABASE_URL:-}" ] || die "set BACKUP_PG_CONTAINER or BACKUP_DATABASE_URL"
  pg_dump -Fc -d "$BACKUP_DATABASE_URL" |
    "$AGE_BIN" -R "$BACKUP_AGE_RECIPIENTS_FILE" -o "$WORK/$DB_FILE"
fi
t1="$(now_ms)"

CONFIG_FILE=""
if [ -n "${BACKUP_CONFIG_PATHS:-}" ]; then
  existing=()
  for p in $BACKUP_CONFIG_PATHS; do
    if [ -e "$p" ]; then existing+=("$p"); else log "config path missing, skipped: $p"; fi
  done
  if [ "${#existing[@]}" -gt 0 ]; then
    CONFIG_FILE="ecloud-config-$STAMP.tar.gz.age"
    log "config tarball (${#existing[@]} paths) | age -> $CONFIG_FILE"
    # Only tar's "Removing leading /" notice is dropped; real errors stay visible.
    tar -czf - "${existing[@]}" 2> >(grep -v 'Removing leading' >&2) |
      "$AGE_BIN" -R "$BACKUP_AGE_RECIPIENTS_FILE" -o "$WORK/$CONFIG_FILE"
  fi
fi
t2="$(now_ms)"

(
  cd "$WORK"
  for f in "$DB_FILE" ${CONFIG_FILE:+"$CONFIG_FILE"}; do
    printf '%s  %s\n' "$(sha256_of "$f")" "$f"
  done
) >"$WORK/SHA256SUMS"

PG_VERSION="$(pg_cmd pg_dump --version 2>/dev/null | head -n1 || echo unknown)"
cat >"$WORK/manifest.json" <<JSON
{
  "format": "ecloud-backup/1",
  "created_at": "$STAMP",
  "database": "$BACKUP_PG_DATABASE",
  "pg_dump": "$PG_VERSION",
  "db_file": "$DB_FILE",
  "db_bytes": $(size_of "$WORK/$DB_FILE"),
  "config_file": "${CONFIG_FILE}",
  "config_bytes": $([ -n "$CONFIG_FILE" ] && size_of "$WORK/$CONFIG_FILE" || echo 0),
  "dump_ms": $((t1 - t0)),
  "config_ms": $((t2 - t1)),
  "encryption": "age (X25519 recipients from BACKUP_AGE_RECIPIENTS_FILE)"
}
JSON
chmod 600 "$WORK"/*
verify_sums "$WORK"
mv "$WORK" "$FINAL"
trap - EXIT
log "backup set complete: $FINAL"

case "$BACKUP_UPLOAD" in
  rclone)
    log "upload: rclone copy -> $BACKUP_RCLONE_REMOTE/$STAMP"
    rclone copy --immutable "$FINAL" "$BACKUP_RCLONE_REMOTE/$STAMP"
    rclone check --one-way "$FINAL" "$BACKUP_RCLONE_REMOTE/$STAMP"
    ;;
  command)
    log "upload: BACKUP_UPLOAD_COMMAND $FINAL"
    # shellcheck disable=SC2086 # the command may carry its own arguments
    $BACKUP_UPLOAD_COMMAND "$FINAL"
    ;;
  none) log "upload: skipped (BACKUP_ALLOW_LOCAL_ONLY=1, dev/drill only)" ;;
esac

# Retention: keep the newest N complete sets (names are sortable UTC stamps).
sets=()
while IFS= read -r d; do sets+=("$d"); done < <(find "$BACKUP_DIR" -maxdepth 1 -mindepth 1 -type d -name '20*T*Z' -exec basename {} \; | sort)
excess=$((${#sets[@]} - BACKUP_RETENTION_COUNT))
if [ "$excess" -gt 0 ]; then
  for old in "${sets[@]:0:excess}"; do
    log "retention: removing $old"
    rm -rf "${BACKUP_DIR:?}/$old"
  done
fi

# The backup set is complete at this point: metric and push failures are logged, never fatal
# (a failing metric write must not mark a good backup as failed).
write_metric() {
  local prom="$BACKUP_TEXTFILE_DIR/ecloud_backup.prom"
  {
    echo '# HELP ecloud_backup_last_success_timestamp_seconds Unix time of the last complete encrypted backup set.'
    echo '# TYPE ecloud_backup_last_success_timestamp_seconds gauge'
    echo "ecloud_backup_last_success_timestamp_seconds $(date +%s)"
    echo '# HELP ecloud_backup_last_size_bytes Size of the last encrypted database dump.'
    echo '# TYPE ecloud_backup_last_size_bytes gauge'
    echo "ecloud_backup_last_size_bytes $(size_of "$FINAL/$DB_FILE")"
    echo '# HELP ecloud_backup_last_duration_seconds Duration of the last pg_dump + encryption.'
    echo '# TYPE ecloud_backup_last_duration_seconds gauge'
    echo "ecloud_backup_last_duration_seconds $(((t1 - t0) / 1000))"
  } >"$prom.tmp" && chmod 644 "$prom.tmp" && mv "$prom.tmp" "$prom"
}
if [ -n "${BACKUP_TEXTFILE_DIR:-}" ]; then
  write_metric || log "textfile metric write failed ($BACKUP_TEXTFILE_DIR); the backup itself succeeded"
fi

if [ -n "${BACKUP_PUSH_URL:-}" ]; then
  curl -fsS -m 10 "$BACKUP_PUSH_URL?status=up&msg=backup-$STAMP" >/dev/null || log "push monitor call failed"
fi
printf '%s\n' "$FINAL"
