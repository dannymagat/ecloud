#!/usr/bin/env bash
# Validate a per-environment secrets directory produced by generate.sh (P10-A).
#
#   bash scripts/secrets/validate.sh <dir>
#
# Checks (never prints a value):
#   - directory mode 0700 and owned by the current user; every file mode 0600, same owner
#   - every secret of secrets.manifest and every derived file is present and non-empty
#   - minimum length per manifest, no whitespace / newline inside the value
#   - no dev or placeholder material (ecloud_dev_, ecloud_ci_, change_me, placeholder, example,
#     password, secret, test) and at least 12 distinct characters
#   - no value reused between two primary secrets
#   - derived connection strings embed the current role passwords
# Exit status: 0 = valid, 1 = findings, 2 = usage error.
set -euo pipefail
# shellcheck source-path=SCRIPTDIR source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

[ $# -eq 1 ] || die "usage: validate.sh <dir>"
DIR="$1"
[ -d "$DIR" ] || die "not a directory: $DIR"

findings=0
fail() {
  echo "secrets: FAIL $1" >&2
  findings=$((findings + 1))
}

me="$(id -u)"
[ "$(file_mode "$DIR")" = "700" ] || fail "$DIR: directory mode must be 700 (is $(file_mode "$DIR"))"
[ "$(file_owner_uid "$DIR")" = "$me" ] || fail "$DIR: not owned by uid $me"

DEV_RE="$SECRETS_DEV_RE"

check_file() {
  local name="$1" min="$2" path="$DIR/$1" value distinct
  if [ ! -f "$path" ]; then
    fail "$name: missing"
    return
  fi
  [ "$(file_mode "$path")" = "600" ] || fail "$name: file mode must be 600 (is $(file_mode "$path"))"
  [ "$(file_owner_uid "$path")" = "$me" ] || fail "$name: not owned by uid $me"
  value="$(cat "$path"; printf x)"
  value="${value%x}"
  if [ -z "$value" ]; then
    fail "$name: empty"
    return
  fi
  case "$value" in *[[:space:]]*) [ "$name" = redis_conf ] || fail "$name: contains whitespace or a newline" ;; esac
  [ "${#value}" -ge "$min" ] || fail "$name: shorter than $min characters"
  if printf '%s' "$value" | grep -q -E -e "$DEV_RE"; then
    [ "$name" = redis_conf ] || fail "$name: contains dev/placeholder material"
  fi
  distinct="$(printf '%s' "$value" | fold -w1 | sort -u | wc -l | tr -d ' ')"
  [ "$distinct" -ge 12 ] || fail "$name: fewer than 12 distinct characters (weak)"
}

primary_hashes=()
while IFS='|' read -r name min _kind _consumers _runbook; do
  check_file "$name" "$min"
  if [ -f "$DIR/$name" ]; then
    primary_hashes+=("$(cksum <"$DIR/$name" | cut -d' ' -f1)")
  fi
done < <(manifest_entries)

for name in "${DERIVED_SECRETS[@]}"; do check_file "$name" 16; done

dups="$(printf '%s\n' "${primary_hashes[@]+"${primary_hashes[@]}"}" | sort | uniq -d | wc -l | tr -d ' ')"
[ "$dups" = "0" ] || fail "$dups value(s) reused between primary secrets"

contains() { [ -f "$DIR/$1" ] && [ -f "$DIR/$2" ] && grep -q -F -- "$(cat "$DIR/$2")" "$DIR/$1"; }
contains database_url ecloud_app_password || fail "database_url: does not embed ecloud_app_password"
contains database_url_platform ecloud_platform_password ||
  fail "database_url_platform: does not embed ecloud_platform_password"
contains redis_url redis_password || fail "redis_url: does not embed redis_password"
contains redis_conf redis_password || fail "redis_conf: does not embed redis_password"

if [ "$findings" -gt 0 ]; then
  echo "secrets: $findings finding(s) in $DIR" >&2
  exit 1
fi
echo "secrets: OK ($DIR: $(manifest_entries | wc -l | tr -d ' ') secrets + ${#DERIVED_SECRETS[@]} derived files)"
