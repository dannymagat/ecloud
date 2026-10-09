#!/usr/bin/env bash
# Generate per-environment ECLOUD secrets LOCALLY (P10-A; SECURITY_ARCHITECTURE.md §9 pilot stage).
#
#   bash scripts/secrets/generate.sh <env> [--out DIR] [--rotate NAME]... [--db-host H]
#                                         [--db-name N] [--redis-host H]
#
#   <env>        environment name, e.g. pilot, staging (lowercase, [a-z0-9-])
#   --out DIR    target directory (default: var/secrets/<env>; must be git-ignored when it is
#                inside this repository)
#   --rotate N   replace secret N (see secrets.manifest) even if it exists; repeatable.
#                Without --rotate, existing files are NEVER overwritten (idempotent re-runs).
#   --db-host / --db-name / --redis-host
#                hosts used in the derived connection strings (defaults: postgres, ecloud, redis
#                = the service names of infra/vps/compose/compose.pilot.yaml)
#
# Output: DIR (0700) with one 0600 file per secret, no trailing newline, plus derived files
# database_url, database_url_platform, redis_url, redis_conf. Values are never printed.
# Encrypt the directory for the ops repository with seal.sh (sops + age); copy it to the host
# only through the approved procedure (docs/SECRETS_MANAGEMENT.md). Validate with validate.sh.
set -euo pipefail
# shellcheck source-path=SCRIPTDIR source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
umask 077

usage() { sed -n '2,22p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 2; }

[ $# -ge 1 ] || usage
ENV_NAME="$1"
shift
[[ "$ENV_NAME" =~ $ENV_NAME_RE ]] || die "invalid environment name '$ENV_NAME' (expected $ENV_NAME_RE)"

OUT=""
DB_HOST=postgres
DB_NAME=ecloud
REDIS_HOST=redis
ROTATE=()
while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT="${2:?--out needs a value}"; shift 2 ;;
    --rotate) ROTATE+=("${2:?--rotate needs a value}"); shift 2 ;;
    --db-host) DB_HOST="${2:?}"; shift 2 ;;
    --db-name) DB_NAME="${2:?}"; shift 2 ;;
    --redis-host) REDIS_HOST="${2:?}"; shift 2 ;;
    -h | --help) usage ;;
    *) die "unknown argument '$1'" ;;
  esac
done
OUT="${OUT:-$SECRETS_REPO_ROOT/var/secrets/$ENV_NAME}"

for name in "${ROTATE[@]+"${ROTATE[@]}"}"; do
  manifest_entries | cut -d'|' -f1 | grep -qx -- "$name" || die "--rotate: '$name' is not in secrets.manifest"
done

case "$OUT" in /*) ;; *) OUT="$(pwd)/$OUT" ;; esac

# Never write secrets into a tracked / committable path of the repository (checked before
# anything is created).
case "$OUT/" in
  "$SECRETS_REPO_ROOT"/*)
    if git -C "$SECRETS_REPO_ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
      git -C "$SECRETS_REPO_ROOT" check-ignore -q "$OUT/probe" ||
        die "refusing to write secrets to $OUT: it is inside the repository and not git-ignored"
    else
      # No git (e.g. an exported tree): only the known-ignored var/secrets/ is allowed, never
      # silently any repository path.
      case "$OUT/" in
        "$SECRETS_REPO_ROOT"/var/secrets/*) ;;
        *) die "refusing to write secrets to $OUT: no git work tree to prove it is ignored (use var/secrets/ or a path outside the repository)" ;;
      esac
    fi
    ;;
esac

mkdir -p "$OUT"
chmod 700 "$OUT"
OUT="$(cd "$OUT" && pwd)"

is_rotated() {
  local n
  for n in "${ROTATE[@]+"${ROTATE[@]}"}"; do [ "$n" = "$1" ] && return 0; done
  return 1
}

created=0
rotated=0
kept=0
while IFS='|' read -r name _min kind _consumers _runbook; do
  path="$OUT/$name"
  if [ -e "$path" ] && ! is_rotated "$name"; then
    kept=$((kept + 1))
    continue
  fi
  while :; do
    case "$kind" in
      token) value="$(random_token)" ;;
      password) value="$(random_password)" ;;
      *) die "secrets.manifest: unknown kind '$kind' for $name" ;;
    esac
    [[ "$value" =~ $SECRETS_DEV_RE ]] || break
  done
  if [ -e "$path" ]; then rotated=$((rotated + 1)); else created=$((created + 1)); fi
  write_secret "$path" "$value"
done < <(manifest_entries)

# Derived files (always re-rendered from the current primary values).
read_secret() { cat "$OUT/$1"; }
write_secret "$OUT/database_url" \
  "postgres://ecloud_app:$(read_secret ecloud_app_password)@${DB_HOST}:5432/${DB_NAME}"
write_secret "$OUT/database_url_platform" \
  "postgres://ecloud_platform:$(read_secret ecloud_platform_password)@${DB_HOST}:5432/${DB_NAME}"
write_secret "$OUT/redis_url" "redis://:$(read_secret redis_password)@${REDIS_HOST}:6379"
write_secret "$OUT/redis_conf" "requirepass $(read_secret redis_password)"

echo "secrets: $ENV_NAME -> $OUT (created $created, rotated $rotated, kept $kept; derived ${#DERIVED_SECRETS[@]})"
echo "secrets: values were not printed. Next: bash scripts/secrets/validate.sh $OUT"
