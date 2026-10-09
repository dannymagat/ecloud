#!/usr/bin/env bash
# One-shot host setup for the ECLOUD backup (DRAFT, NOT RUN). docs/VPS_LOCAL_CHANGE_LIST.md
# LCL-BK-2 / LCL-BK-3. Run from /opt/ecloud/infra/vps-local/scripts:
#
#   sudo ECLOUD_APPROVED_CHANGE=LCL-BK-3 ./setup-backup.sh key          # deploy key + print PUBLIC key
#   sudo ECLOUD_APPROVED_CHANGE=LCL-BK-3 ./setup-backup.sh known-hosts  # pin github.com host keys
#   sudo ECLOUD_APPROVED_CHANGE=LCL-BK-2 ./setup-backup.sh install      # scripts, configs, timer
#   sudo ECLOUD_APPROVED_CHANGE=LCL-BK-2 ./setup-backup.sh rollback     # timer off, files removed
#
# Never creates or reads an age PRIVATE key. Requires git (dnf install git, LCL-BK-1) and age in
# /usr/local/bin (LCL-BK-1) for the backup itself.
set -euo pipefail
# shellcheck source-path=SCRIPTDIR source=../../vps/scripts/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/../../vps/scripts/common.sh"
require_approval

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)" # /opt/ecloud
KEY=/root/.ssh/ecloud-backup-deploy
KNOWN=/etc/ecloud/github_known_hosts

case "${1:-}" in
  key)
    install -d -m 0700 /root/.ssh
    if [ ! -f "$KEY" ]; then
      ssh-keygen -q -t ed25519 -N '' -C "ecloud-backup@vps-local" -f "$KEY"
    fi
    chmod 0600 "$KEY"
    echo "Add this PUBLIC key in GitHub: dannymagat/ecloud -> Settings -> Deploy keys -> Add,"
    echo "title 'vps-local backups', tick 'Allow write access':"
    cat "$KEY.pub"
    ;;
  known-hosts)
    install -d -m 0755 /etc/ecloud
    tmp="$(mktemp)"
    ssh-keyscan -t ed25519,ecdsa,rsa github.com 2>/dev/null >"$tmp"
    [ -s "$tmp" ] || { rm -f "$tmp"; echo "ssh-keyscan returned nothing" >&2; exit 3; }
    echo "Compare these SHA256 fingerprints with GitHub's published ones"
    echo "(docs.github.com: 'GitHub's SSH key fingerprints') BEFORE answering yes:"
    ssh-keygen -lf "$tmp"
    read -r -p "Fingerprints match? [yes/NO] " a
    [ "$a" = yes ] || { rm -f "$tmp"; echo "not pinned" >&2; exit 3; }
    install -m 0644 "$tmp" "$KNOWN"
    rm -f "$tmp"
    echo "pinned in $KNOWN"
    ;;
  install)
    install -d -m 0755 "$ROOT/bin" /etc/ecloud
    install -d -m 0700 /data/ecloud-backups
    install -m 0755 "$ROOT/scripts/backup/backup.sh" "$ROOT/scripts/backup/lib.sh" "$ROOT/bin/"
    install -m 0755 "$HERE/../backup/upload-github.sh" "$ROOT/bin/"
    [ -f "$ROOT/secrets/backup.env" ] || install -m 0600 "$HERE/../backup/backup.env.example" "$ROOT/secrets/backup.env"
    [ -f /etc/ecloud/backup-github.env ] || install -m 0600 "$HERE/../backup/backup-github.env.example" /etc/ecloud/backup-github.env
    install -m 0644 "$ROOT/scripts/backup/systemd/ecloud-backup.service" "$ROOT/scripts/backup/systemd/ecloud-backup.timer" /etc/systemd/system/
    install -d -m 0755 /etc/systemd/system/ecloud-backup.service.d
    install -m 0644 "$HERE/../systemd/ecloud-backup.service.d/10-vps-local.conf" /etc/systemd/system/ecloud-backup.service.d/
    systemctl daemon-reload
    [ -s "$ROOT/secrets/backup-recipients.txt" ] || echo "MISSING: $ROOT/secrets/backup-recipients.txt (age PUBLIC key)"
    command -v git >/dev/null || echo "MISSING: git (dnf install git)"
    [ -x /usr/local/bin/age ] || echo "MISSING: /usr/local/bin/age"
    echo "installed. First run: systemctl start ecloud-backup.service; then: systemctl enable --now ecloud-backup.timer"
    ;;
  rollback)
    systemctl disable --now ecloud-backup.timer 2>/dev/null || true
    rm -rf /etc/systemd/system/ecloud-backup.service.d
    rm -f /etc/systemd/system/ecloud-backup.service /etc/systemd/system/ecloud-backup.timer
    systemctl daemon-reload
    echo "timer/service removed; backups in /data/ecloud-backups and the deploy key kept."
    echo "Revoke the deploy key in GitHub if it is no longer needed."
    ;;
  *)
    echo "usage: $0 key|known-hosts|install|rollback" >&2
    exit 2
    ;;
esac
