#!/usr/bin/env bash
# Reset an EXISTING platform administrator's password on vps-local (D-059). LCL-APP-5.
#   ssh -t vps-local 'sudo ECLOUD_APPROVED_CHANGE=LCL-APP-5 /opt/ecloud/infra/vps-local/scripts/reset-admin-password.sh <email> [display name]'
#
# The recovery path for a lockout, so it never needs hand-written SQL against the production
# database — which is what disabling admin@ezecloud.local required on 2026-10-15.
#
# The password is typed without echo and passed on stdin (packages/db cli: never an argument, so
# it is not in the process list, the shell history or the compose logs). The command prints only
# the email, the administrator id and how many sessions it revoked.
#
# EVERY LIVE SESSION OF THAT ADMINISTRATOR IS REVOKED, including any it was holding to impersonate
# a tenant. If you are resetting your OWN account you will be signed out of all your browsers and
# will need to sign in again with the new password. Reset the account you are NOT currently
# relying on first if you want to keep a way in.
set -euo pipefail
# shellcheck source-path=SCRIPTDIR source=../../vps/scripts/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/../../vps/scripts/common.sh"
require_approval
email="${1:-}"
display_name="${2:-}"
[ -n "$email" ] || { echo "usage: $0 <email> [display name]" >&2; exit 2; }
read -r -s -p "NEW password for $email (not echoed): " pw
echo
read -r -s -p "Repeat: " pw2
echo
[ "$pw" = "$pw2" ] || { echo "passwords differ" >&2; exit 2; }
args=(--email "$email" --password-stdin)
[ -n "$display_name" ] && args+=(--display-name "$display_name")
printf '%s' "$pw" | /opt/ecloud/bin/ecloud-compose --profile migrate run --rm -T migrate \
  node packages/db/dist/cli.js reset-platform-admin-password "${args[@]}"
