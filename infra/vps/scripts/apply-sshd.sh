#!/usr/bin/env bash
# SSH-safe apply of the sshd drop-in (DRAFT, NOT RUN). SECURITY_ARCHITECTURE.md §2.5 step 2.
#
#   sudo ECLOUD_APPROVED_CHANGE=VPS-SSH-1 ./apply-sshd.sh apply     # sshd -t, reload, dead-man 10 min
#   ... keep this session open; log in from a NEW terminal as every AllowUsers account ...
#   sudo ECLOUD_APPROVED_CHANGE=VPS-SSH-1 ./apply-sshd.sh confirm
#   sudo ECLOUD_APPROVED_CHANGE=VPS-SSH-1 ./apply-sshd.sh rollback
#
# `reload` keeps existing sessions; the dead-man removes the drop-in and reloads ssh again.
set -euo pipefail
# shellcheck source-path=SCRIPTDIR source=common.sh
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
require_approval

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/../ssh/sshd_config.d" && pwd)/10-ecloud-hardening.conf"
DST=/etc/ssh/sshd_config.d/10-ecloud-hardening.conf
UNIT=ecloud-sshd-deadman
DEADMAN_SECONDS="${DEADMAN_SECONDS:-600}"

case "${1:-}" in
  apply)
    install -m 0644 "$SRC" "$DST.new"
    mv -f "$DST.new" "$DST"
    if ! sshd -t; then
      rm -f "$DST"
      echo "sshd -t failed; drop-in removed, nothing reloaded" >&2
      exit 1
    fi
    # Arm the dead-man before anything else can fail (F-P10R-7: a failing display pipeline under
    # pipefail used to exit with the drop-in installed but no dead-man armed).
    deadman_arm "$UNIT" "$DEADMAN_SECONDS" /bin/sh -c "rm -f $DST && systemctl reload ssh"
    sshd -T 2>/dev/null | grep -E '^(permitrootlogin|passwordauthentication|x11forwarding|allowusers|maxauthtries) ' || true
    systemctl reload ssh
    echo "reloaded. NOW: log in from a NEW terminal, then run '$0 confirm'"
    ;;
  confirm)
    deadman_disarm "$UNIT"
    [ -f "$DST" ] || { echo "drop-in is gone (dead-man fired?); hardening NOT active. Re-run apply." >&2; exit 1; }
    ;;
  rollback)
    rm -f "$DST"
    sshd -t && systemctl reload ssh
    systemctl stop "$UNIT.timer" 2>/dev/null || true
    echo "drop-in removed and ssh reloaded"
    ;;
  *)
    sed -n '2,9p' "${BASH_SOURCE[0]}"
    exit 2
    ;;
esac
