#!/usr/bin/env bash
# Create the first platform super admin on vps-local (DRAFT, NOT RUN). LCL-APP-5.
#   ssh -t vps-local 'sudo ECLOUD_APPROVED_CHANGE=LCL-APP-5 /opt/ecloud/infra/vps-local/scripts/create-admin.sh <email>'
# The password is typed without echo and passed on stdin (packages/db cli: never an argument).
set -euo pipefail
# shellcheck source-path=SCRIPTDIR source=../../vps/scripts/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/../../vps/scripts/common.sh"
require_approval
email="${1:-}"
[ -n "$email" ] || { echo "usage: $0 <email>" >&2; exit 2; }
read -r -s -p "Password for $email (not echoed): " pw
echo
read -r -s -p "Repeat: " pw2
echo
[ "$pw" = "$pw2" ] || { echo "passwords differ" >&2; exit 2; }
printf '%s' "$pw" | /opt/ecloud/bin/ecloud-compose --profile migrate run --rm -T migrate \
  node packages/db/dist/cli.js create-platform-admin --email "$email" --password-stdin
