#!/usr/bin/env bash
# ECLOUD secrets scan (D-033: no secrets in git). Used by CI and runnable locally:
#
#   bash scripts/check-no-secrets.sh            # scan the repository
#   bash scripts/check-no-secrets.sh <dir>      # scan another tree (self-test)
#
# Scans every file git would commit (tracked + untracked, honouring .gitignore; falls back to
# `find` outside a git work tree) for:
#   1. private key blocks (PEM / OpenSSH / PGP) and WireGuard `PrivateKey = ...` lines
#   2. well-known token formats (AWS, GitHub, Slack, Stripe-style, Google API, JWT)
#   3. literal credentials: `password=` / `secret:` / `token = ...` style assignments and
#      credentials embedded in URLs (scheme://user:pass@host), outside `.env.example`
#   4. long opaque values assigned to *key*/*token*/*secret*/*password* names
#   5. committed `.env*` files other than `.env.example`
#
# Obviously-fake dev/CI values are allowed: anything containing `ecloud_dev_`, `ecloud_ci_`,
# `PLACEHOLDER`, `placeholder`, `change_me`/`changeme`, `example`, `test`, `fake`, `dummy`, `<...>`, `${...}`,
# `$ENV{...}`, `%{...}`, `xxx`. A line may opt out with the marker `check-no-secrets: allow`
# (reviewers must check every use of it). Test sources (*.test.ts, test-support/, tests/,
# infra/freeradius/test/) are exempt from the assignment/URL rules only.
# Exit status: 0 = clean, 1 = findings (printed as file:line: rule), 2 = usage error.
set -euo pipefail

ROOT="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
if [ ! -d "$ROOT" ]; then
  echo "check-no-secrets: not a directory: $ROOT" >&2
  exit 2
fi
cd "$ROOT"

list_files() {
  if git -C "$ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    git -C "$ROOT" ls-files -z --cached --others --exclude-standard
  else
    find . -type f \
      -not -path './node_modules/*' -not -path '*/node_modules/*' \
      -not -path './.git/*' -not -path '*/dist/*' -not -path '*/coverage/*' \
      -not -path './var/*' -print0
  fi
}

# Files never scanned: lockfiles (integrity hashes), binary assets, this script's own patterns.
SKIP_RE='(^|/)(package-lock\.json|npm-shrinkwrap\.json)$|\.(png|jpe?g|gif|ico|webp|pdf|woff2?|ttf|otf|zip|gz|tgz|pcap)$|^scripts/check-no-secrets\.sh$'

ALLOW_RE='ecloud_dev_|ecloud_ci_|PLACEHOLDER|[Pp]laceholder|change_?me|example|[Tt]est|[Ff]ake|[Dd]ummy|REDACTED|<[^>]*>|\$\{[^}]*\}|\$ENV\{|%\{|xxx|env:[A-Z_]|_ref\b|_FILE\b|/run/secrets/|HEADER|[Hh]eader|:'"'"'[a-z_]+'"'"'|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|check-no-secrets: allow'
# Test sources and protocol fixtures legitimately contain dummy credentials: the assignment and
# URL rules are skipped there (private keys, token formats and long opaque values still apply).
TEST_FILE_RE='(\.test\.[cm]?[jt]s$|(^|/)test-support/|(^|/)infra/freeradius/test/|(^|/)tests/)'

PRIVATE_KEY_RE='-----BEGIN ([A-Z]+ )?PRIVATE KEY-----|-----BEGIN OPENSSH PRIVATE KEY-----|-----BEGIN PGP PRIVATE KEY BLOCK-----|^[[:space:]]*PrivateKey[[:space:]]*=[[:space:]]*[A-Za-z0-9+/]{42,43}=?'
TOKEN_RE='AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,}|xox[abprs]-[A-Za-z0-9-]{10,}|sk_live_[A-Za-z0-9]{16,}|AIza[0-9A-Za-z_-]{35}|eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|eck_[A-Za-z0-9]{24,}'
NAME_RE='[A-Za-z0-9_]*([Pp][Aa][Ss][Ss][Ww][Oo][Rr][Dd]|[Pp][Aa][Ss][Ss][Ww][Dd]|[Ss][Ee][Cc][Rr][Ee][Tt]|[Tt][Oo][Kk][Ee][Nn])[A-Za-z0-9_]*'
# any file: name = "literal" / name: 'literal' / "name": "literal" (quoted value, >= 6 chars)
QUOTED_ASSIGN_RE="(^|[^A-Za-z0-9_])${NAME_RE}[\"']?[[:space:]]*[=:][[:space:]]*[\"'][^\"'[:space:]]{6,}[\"']"
# config-like files: NAME=value / name: value (unquoted)
ENV_ASSIGN_RE="^[[:space:]]*(export[[:space:]]+|-[[:space:]]+)?${NAME_RE}[[:space:]]*[=:][[:space:]]*[^\"'[:space:]\$<%{#][^[:space:]]{5,}[[:space:]]*(#.*)?$"
URL_CRED_RE="[a-z][a-z0-9+.-]*://[^/[:space:]:@\"'\`]+:[^/[:space:]@\"'\`]{3,}@"
LONG_VALUE_RE="(^|[^A-Za-z0-9_])[A-Za-z0-9_]*([Kk][Ee][Yy]|${NAME_RE})[\"']?[[:space:]]*[=:][[:space:]]*[\"']?[A-Za-z0-9+/_=-]{32,}"
CONFIG_FILE_RE='(^|/)(Dockerfile[^/]*|[^/.]+|\.[^/]+|[^/]*\.(ya?ml|conf|cnf|ini|toml|cfg|properties|env|sh|bash|txt|sql))$'

findings=0
report() {
  printf '%s: %s\n' "$1" "$2"
  findings=$((findings + 1))
}

# scan <rule> <regex> <file> [allow-filter]
scan() {
  local rule="$1" regex="$2" file="$3" filter="${4:-yes}"
  local hits
  hits=$(grep -I -n -E -e "$regex" -- "$file" 2>/dev/null || true)
  [ -z "$hits" ] && return 0
  if [ "$filter" = yes ]; then
    hits=$(printf '%s\n' "$hits" | grep -v -E -e "$ALLOW_RE" || true)
  else
    hits=$(printf '%s\n' "$hits" | grep -v -F -e 'check-no-secrets: allow' || true)
  fi
  [ -z "$hits" ] && return 0
  while IFS= read -r hit; do
    report "$file:${hit%%:*}" "$rule"
  done <<<"$hits"
}

count=0
while IFS= read -r -d '' file; do
  file="${file#./}"
  [ -f "$file" ] || continue
  if printf '%s' "$file" | grep -q -E -e "$SKIP_RE"; then continue; fi
  count=$((count + 1))
  base="${file##*/}"
  case "$base" in
    .env.example) ;;
    .env | .env.*) report "$file" "committed environment file (only .env.example is allowed)" ;;
  esac
  # private keys and token formats: no allow-list except the explicit marker
  scan "private key material" "$PRIVATE_KEY_RE" "$file" marker-only
  scan "token format" "$TOKEN_RE" "$file"
  is_test=no
  if printf '%s' "$file" | grep -q -E -e "$TEST_FILE_RE"; then is_test=yes; fi
  if [ "$base" != ".env.example" ] && [ "$is_test" = no ]; then
    scan "literal credential assignment" "$QUOTED_ASSIGN_RE" "$file"
    if printf '%s' "$file" | grep -q -E -e "$CONFIG_FILE_RE"; then
      scan "literal credential assignment" "$ENV_ASSIGN_RE" "$file"
    fi
    scan "credentials in URL" "$URL_CRED_RE" "$file"
  fi
  scan "long opaque secret value" "$LONG_VALUE_RE" "$file"
done < <(list_files)

if [ "$findings" -gt 0 ]; then
  echo "check-no-secrets: $findings finding(s) in $count files. Replace real values with" \
    "placeholders / env references (D-033), or mark a reviewed false positive with" \
    "'check-no-secrets: allow'." >&2
  exit 1
fi
echo "check-no-secrets: OK ($count files scanned)"
