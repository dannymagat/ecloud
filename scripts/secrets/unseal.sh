#!/usr/bin/env bash
# Decrypt a sops/age secrets file back into a 0700/0600 directory (P10-A), e.g. on the deploy
# runner or the host at /opt/ecloud/secrets. Derived files are re-rendered by generate.sh.
#
#   SOPS_AGE_KEY_FILE=<operator key> bash scripts/secrets/unseal.sh <in.enc.yaml> <dir> <env> \\
#     [--db-host H] [--db-name N] [--redis-host H]
# The optional host/name options are passed to generate.sh for the derived connection strings;
# pass the same values used when the set was generated, or they fall back to the defaults.
set -euo pipefail
# shellcheck source-path=SCRIPTDIR source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
umask 077

[ $# -ge 3 ] || die "usage: unseal.sh <in.enc.yaml> <dir> <env> [--db-host H] [--db-name N] [--redis-host H]"
IN="$1"
DIR="$2"
ENV_NAME="$3"
shift 3
# Only the derived-string options are forwarded; never --rotate / --out (unseal must not mint).
GEN_OPTS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --db-host | --db-name | --redis-host) GEN_OPTS+=("$1" "${2:?$1 needs a value}"); shift 2 ;;
    *) die "unseal.sh: unsupported option '$1'" ;;
  esac
done
command -v sops >/dev/null 2>&1 || die "sops is not installed; nothing was written"
mkdir -p "$DIR"
chmod 700 "$DIR"
while IFS='|' read -r name _rest; do
  value="$(sops --decrypt --extract "[\"$name\"]" "$IN")" || die "cannot decrypt $name"
  write_secret "$DIR/$name" "$value"
done < <(manifest_entries)
# Re-render derived files (connection strings) from the decrypted primary secrets.
bash "$SECRETS_LIB_DIR/generate.sh" "$ENV_NAME" --out "$DIR" "${GEN_OPTS[@]+"${GEN_OPTS[@]}"}" >/dev/null
bash "$SECRETS_LIB_DIR/validate.sh" "$DIR"
