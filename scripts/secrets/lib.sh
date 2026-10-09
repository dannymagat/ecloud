#!/usr/bin/env bash
# shellcheck disable=SC2034  # file-wide: variables are used by the scripts that source this file
# Shared helpers for scripts/secrets/*.sh (sourced, not executed).
set -euo pipefail

SECRETS_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SECRETS_REPO_ROOT="$(cd "${SECRETS_LIB_DIR}/../.." && pwd)"
SECRETS_MANIFEST="${SECRETS_LIB_DIR}/secrets.manifest"

# Derived files written next to the primary secrets (connection strings / config snippets that
# embed a password, so the apps can use DATABASE_URL_FILE etc.).
DERIVED_SECRETS=(database_url database_url_platform redis_url redis_conf)

ENV_NAME_RE='^[a-z][a-z0-9-]{1,31}$'

die() {
  echo "secrets: $*" >&2
  exit 2
}

# manifest_entries -> "name|min|kind|consumers|runbook" lines without comments
manifest_entries() {
  grep -v -E '^[[:space:]]*(#|$)' "$SECRETS_MANIFEST"
}

# file_mode <path> -> octal permission bits, e.g. 600 (GNU and BSD stat)
file_mode() {
  if stat -c '%a' "$1" >/dev/null 2>&1; then
    stat -c '%a' "$1"
  else
    stat -f '%Lp' "$1"
  fi
}

file_owner_uid() {
  if stat -c '%u' "$1" >/dev/null 2>&1; then
    stat -c '%u' "$1"
  else
    stat -f '%u' "$1"
  fi
}

# Dev / placeholder material that validate.sh rejects. generate.sh re-draws any random value that
# happens to match (about 1 in 10^5 for a 40-char password), so validation can stay strict.
SECRETS_DEV_RE='ecloud_dev_|ecloud_ci_|change_?me|[Pp]laceholder|[Ee]xample|[Pp]assword|[Ss]ecret|[Tt]est'

# random_token -> 64 chars base64url (48 bytes)
random_token() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -base64 48 | tr -d '\n' | tr '+/' '-_' | tr -d '='
  else
    head -c 48 /dev/urandom | base64 | tr -d '\n' | tr '+/' '-_' | tr -d '='
  fi
}

# random_password -> 40 chars [A-Za-z0-9]
random_password() {
  local out=''
  while [ "${#out}" -lt 40 ]; do
    out="$out$(head -c 256 /dev/urandom | LC_ALL=C tr -dc 'A-Za-z0-9')"
  done
  printf '%s' "${out:0:40}"
}

# write_secret <path> <value>: 0600, no trailing newline, atomic rename
write_secret() {
  local path="$1" value="$2" tmp
  tmp="$(mktemp "${path}.XXXXXX")"
  chmod 600 "$tmp"
  printf '%s' "$value" >"$tmp"
  mv -f "$tmp" "$path"
  chmod 600 "$path"
}
