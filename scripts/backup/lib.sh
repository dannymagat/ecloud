# shellcheck shell=bash
# Shared helpers for scripts/backup/*.sh (sourced, not executed).
# SECURITY_ARCHITECTURE.md §10.1, DEPLOYMENT_ARCHITECTURE.md §5, D-026, D-033.

log() { printf '%s [%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${LOG_TAG:-backup}" "$*" >&2; }
die() {
  log "ERROR: $*"
  exit 1
}

# sha256 of a file, portable across GNU coreutils (VPS) and macOS (developer workstation).
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

# Verifies every line of a SHA256SUMS file ("<hex>  <name>") relative to its directory.
verify_sums() {
  local dir="$1" line want name got
  [ -f "$dir/SHA256SUMS" ] || die "missing $dir/SHA256SUMS"
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    want="${line%% *}"
    name="${line#*  }"
    [ -f "$dir/$name" ] || die "checksum listed file missing: $name"
    got="$(sha256_of "$dir/$name")"
    [ "$got" = "$want" ] || die "checksum mismatch: $name"
  done <"$dir/SHA256SUMS"
}

# Milliseconds since the epoch (GNU date has %N; macOS date does not).
now_ms() {
  if date +%s%N 2>/dev/null | grep -qv N; then
    echo $(($(date +%s%N) / 1000000))
  else
    node -e 'process.stdout.write(String(Date.now()))' 2>/dev/null || echo $(($(date +%s) * 1000))
  fi
}

# file size in bytes (GNU stat -c / BSD stat -f).
size_of() { stat -c %s "$1" 2>/dev/null || stat -f %z "$1"; }

# The recipients file must hold only age PUBLIC keys (never an identity / private key).
check_recipients_file() {
  local f="$1"
  [ -n "$f" ] || die "BACKUP_AGE_RECIPIENTS_FILE is not set"
  [ -f "$f" ] || die "recipients file not found: $f"
  if grep -q 'AGE-SECRET-KEY-' "$f"; then
    die "recipients file contains an age PRIVATE key; only public keys (age1...) belong on the host"
  fi
  grep -Eq '^(age1[0-9a-z]{58}|ssh-(ed25519|rsa) )' "$f" || die "no age/ssh public key in $f"
}

# pg_dump / pg_restore / psql either inside the Postgres container (docker exec, the pilot
# layout) or from the host (BACKUP_PG_CONTAINER empty; libpq env or URL).
pg_cmd() {
  local tool="$1"
  shift
  if [ -n "${BACKUP_PG_CONTAINER:-}" ]; then
    docker exec -i "$BACKUP_PG_CONTAINER" "$tool" "$@"
  else
    "$tool" "$@"
  fi
}
