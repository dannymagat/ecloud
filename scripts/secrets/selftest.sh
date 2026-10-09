#!/usr/bin/env bash
# Self-test of generate.sh / validate.sh in a throw-away directory (CI + local). Prints no values.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
dir="$tmp/selftest"
expect_fail() {
  if bash "$here/validate.sh" "$dir" >/dev/null 2>&1; then
    echo "selftest: FAIL - validate.sh accepted: $1" >&2
    exit 1
  fi
}

bash "$here/generate.sh" selftest --out "$dir" >/dev/null
bash "$here/validate.sh" "$dir" >/dev/null

# idempotent: a re-run keeps every value
before="$(cat "$dir"/* | cksum)"
bash "$here/generate.sh" selftest --out "$dir" >/dev/null
[ "$before" = "$(cat "$dir"/* | cksum)" ] || { echo "selftest: FAIL - re-run changed values" >&2; exit 1; }

# rotation changes exactly the rotated secret (+ the derived files that embed it)
old_token="$(cksum <"$dir/internal_api_token")"
old_pepper="$(cksum <"$dir/voucher_pepper")"
old_url="$(cksum <"$dir/database_url")"
bash "$here/generate.sh" selftest --out "$dir" --rotate internal_api_token --rotate ecloud_app_password >/dev/null
[ "$old_token" != "$(cksum <"$dir/internal_api_token")" ] || { echo "selftest: FAIL - rotate kept value" >&2; exit 1; }
[ "$old_pepper" = "$(cksum <"$dir/voucher_pepper")" ] || { echo "selftest: FAIL - rotate touched another secret" >&2; exit 1; }
[ "$old_url" != "$(cksum <"$dir/database_url")" ] || { echo "selftest: FAIL - derived URL not re-rendered" >&2; exit 1; }
bash "$here/validate.sh" "$dir" >/dev/null

# negative cases
chmod 644 "$dir/voucher_pepper"; expect_fail "world-readable file"; chmod 600 "$dir/voucher_pepper"
chmod 755 "$dir"; expect_fail "world-readable directory"; chmod 700 "$dir"
cp "$dir/voucher_pepper" "$tmp/keep"
printf 'ecloud_dev_voucher_pepper_change_me' >"$dir/voucher_pepper"; expect_fail "dev default"
printf 'short' >"$dir/voucher_pepper"; expect_fail "too short"
cp "$dir/internal_api_token" "$dir/voucher_pepper"; expect_fail "reused value"
cp "$tmp/keep" "$dir/voucher_pepper"; chmod 600 "$dir/voucher_pepper"
rm "$dir/portal_state_secret"; expect_fail "missing secret"
bash "$here/generate.sh" selftest --out "$dir" >/dev/null
bash "$here/validate.sh" "$dir" >/dev/null

# refuses a non-ignored path inside the repository
repo="$(cd "$here/../.." && pwd)"
if git -C "$repo" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  if bash "$here/generate.sh" selftest --out "$repo/docs/selftest-secrets" >/dev/null 2>&1; then
    rm -rf "$repo/docs/selftest-secrets"
    echo "selftest: FAIL - generated into a committable path" >&2
    exit 1
  fi
  [ ! -e "$repo/docs/selftest-secrets" ] || { echo "selftest: FAIL - refused path was created" >&2; exit 1; }
fi
echo "secrets selftest: OK"
