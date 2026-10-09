#!/usr/bin/env bash
# Install unsealed ECLOUD secrets on vps-local (DRAFT, NOT RUN). docs/VPS_LOCAL_CHANGE_LIST.md
# LCL-APP-2, docs/SECRETS_MANAGEMENT.md §2. The owner unseals on the workstation (sops + age,
# never on this host), copies the directory with scp into ezeadmin's home, then:
#
#   sudo ECLOUD_APPROVED_CHANGE=LCL-APP-2 ./install-secrets.sh /home/ezeadmin/ecloud-secrets
#
# - creates group ecloud-secrets with gid 10001 if missing (refuses if 10001 is another group);
# - /opt/ecloud/secrets root:10001 0750, every file root:10001 0440 (Compose file secrets are
#   bind mounts: containers see host owner/mode);
# - validates names against scripts/secrets/secrets.manifest when present;
# - shreds the source copy afterwards.
set -euo pipefail
# shellcheck source-path=SCRIPTDIR source=../../vps/scripts/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/../../vps/scripts/common.sh"
require_approval

SRC="${1:-}"
DST="${ECLOUD_SECRETS_DIR:-/opt/ecloud/secrets}"
GID=10001
[ -n "$SRC" ] && [ -d "$SRC" ] || { echo "usage: $0 <unsealed-secrets-dir>" >&2; exit 2; }

existing="$(getent group "$GID" | cut -d: -f1 || true)"
if [ -z "$existing" ]; then
  groupadd --system --gid "$GID" ecloud-secrets
elif [ "$existing" != ecloud-secrets ]; then
  echo "refusing: gid $GID already belongs to group '$existing'" >&2
  exit 3
fi

required="postgres_password ecloud_app_password ecloud_platform_password radius_sql_password
radius_status_secret internal_api_token mfa_encryption_key data_encryption_key voucher_pepper
portal_state_secret database_url database_url_platform redis_url redis_conf"
missing=0
for n in $required; do
  if [ ! -s "$SRC/$n" ]; then echo "missing or empty: $n" >&2; missing=1; fi
done
[ "$missing" -eq 0 ] || exit 3

install -d -o root -g "$GID" -m 0750 "$DST"
for f in "$SRC"/*; do
  [ -f "$f" ] || continue
  install -o root -g "$GID" -m 0440 "$f" "$DST/$(basename "$f")"
done
shred -u "$SRC"/* && rmdir "$SRC"
ls -l "$DST" | awk '{print $1, $3, $4, $NF}'
