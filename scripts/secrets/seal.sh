#!/usr/bin/env bash
# Encrypt a secrets directory into one sops/age file for the private ops repository (P10-A).
#
#   SOPS_AGE_RECIPIENTS=age1...,age1... bash scripts/secrets/seal.sh <dir> <out.enc.yaml>
#   (or a .sops.yaml in the current directory, see scripts/secrets/.sops.yaml.example)
#
# The plaintext YAML exists only inside <dir> (0700/0600) for the duration of the call.
# Requires `sops` (https://github.com/getsops/sops) with age support; refuses to run without it.
set -euo pipefail
# shellcheck source-path=SCRIPTDIR source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
umask 077

[ $# -eq 2 ] || die "usage: seal.sh <dir> <out.enc.yaml>"
DIR="$1"
OUT="$2"
command -v sops >/dev/null 2>&1 || die "sops is not installed; nothing was written"
bash "$SECRETS_LIB_DIR/validate.sh" "$DIR" >/dev/null || die "validate.sh failed for $DIR; refusing to seal"

plain="$(mktemp "$DIR/.seal.XXXXXX")"
trap 'rm -f "$plain"' EXIT
{
  while IFS='|' read -r name _rest; do
    printf "%s: '%s'\n" "$name" "$(cat "$DIR/$name")"
  done < <(manifest_entries)
} >"$plain"

args=(--encrypt --input-type yaml --output-type yaml)
if [ -n "${SOPS_AGE_RECIPIENTS:-}" ]; then args+=(--age "$SOPS_AGE_RECIPIENTS"); fi
sops "${args[@]}" "$plain" >"$OUT.tmp"
mv -f "$OUT.tmp" "$OUT"
echo "secrets: sealed $(manifest_entries | wc -l | tr -d ' ') secrets from $DIR into $OUT"
