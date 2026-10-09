#!/usr/bin/env bash
# SSH-safe apply of infra/vps/nftables (DRAFT, NOT RUN). SECURITY_ARCHITECTURE.md §2.5.
#
#   sudo ECLOUD_APPROVED_CHANGE=VPS-FW-1 ./apply-nftables.sh admins <ip|cidr>...  # operator allow-list
#   sudo ECLOUD_APPROVED_CHANGE=VPS-FW-1 ./apply-nftables.sh stage      # copy + syntax check only
#   sudo ECLOUD_APPROVED_CHANGE=VPS-FW-1 ./apply-nftables.sh apply      # load with dead-man (10 min)
#   ... open a NEW ssh session from a second terminal; check https://q-mira.com ...
#   sudo ECLOUD_APPROVED_CHANGE=VPS-FW-1 ./apply-nftables.sh confirm    # disarm + persist at boot
#   sudo ECLOUD_APPROVED_CHANGE=VPS-FW-1 ./apply-nftables.sh rollback   # remove table inet ecloud
#
# Rollback ONLY deletes `table inet ecloud`. It never runs `nft flush ruleset` (the outline in
# SECURITY_ARCHITECTURE §2.5 did): that would also delete Docker's NAT/FORWARD rules and take
# q-mira.com's container publish down until Docker restarts.
# Preconditions: OVH KVM console access verified (Q17); second operator key registered; the
# operator's source addresses written with `admins` (F-P10R-4: the per-source SSH meter can be
# exhausted with spoofed SYNs from a known operator address; allow-listed sources bypass it).
# The allow-list lives only on the host (/etc/nftables.d/zz-ecloud-admins.nft, never committed)
# and is loaded in the same transaction as the table, and again at boot (sorted after ecloud.nft).
# `apply` refuses with an empty allow-list unless ECLOUD_NO_SSH_ALLOWLIST=1 is set deliberately.
set -euo pipefail
# shellcheck source-path=SCRIPTDIR source=common.sh
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
require_approval

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../nftables" && pwd)"
DEADMAN_SECONDS="${DEADMAN_SECONDS:-600}"
UNIT=ecloud-nft-deadman
ADMINS=/etc/nftables.d/zz-ecloud-admins.nft

# One atomic transaction: the table file (delete + recreate) plus the host-local allow-list.
load_ruleset() {
  local tx
  tx="$(mktemp /run/ecloud-nft.XXXXXX)"
  echo 'include "/etc/nftables.d/ecloud.nft"' >"$tx"
  if [ -f "$ADMINS" ]; then echo "include \"$ADMINS\"" >>"$tx"; fi
  local rc=0
  nft "$@" -f "$tx" || rc=$?
  rm -f "$tx"
  return "$rc"
}

has_admins() { [ -f "$ADMINS" ] && grep -q '^add element' "$ADMINS"; }

case "${1:-}" in
  admins)
    shift
    [ "$#" -gt 0 ] || { echo "usage: $0 admins <ipv4|ipv6|cidr>..." >&2; exit 2; }
    tmp="$(mktemp /etc/nftables.d/.admins.XXXXXX)"
    echo "# host-local SSH allow-list (apply-nftables.sh admins); NEVER commit" >"$tmp"
    for a in "$@"; do
      case "$a" in
        *:*) echo "add element inet ecloud ssh_admins6 { $a }" >>"$tmp" ;;
        *.*) echo "add element inet ecloud ssh_admins4 { $a }" >>"$tmp" ;;
        *) rm -f "$tmp"; echo "not an address: $a" >&2; exit 2 ;;
      esac
    done
    chmod 0640 "$tmp"
    mv -f "$tmp" "$ADMINS"
    load_ruleset -c
    echo "allow-list written ($# entries). Also add the same addresses to fail2ban ignoreip (VPS-FW-4)."
    ;;
  stage)
    install -d -m 0755 /etc/nftables.d
    install -m 0644 "$SRC_DIR/ecloud.nft" /etc/nftables.d/ecloud.nft
    load_ruleset -c
    has_admins || echo "WARNING: no SSH allow-list yet; run '$0 admins <your IP>' before apply" >&2
    nft list ruleset >"/root/nft-ruleset.before.$(date +%F-%H%M%S)"
    echo "staged and syntax-checked; current ruleset saved under /root"
    ;;
  apply)
    if ! has_admins && [ "${ECLOUD_NO_SSH_ALLOWLIST:-}" != 1 ]; then
      echo "refusing: empty SSH allow-list; run '$0 admins <operator IPs>' (or set ECLOUD_NO_SSH_ALLOWLIST=1)" >&2
      exit 3
    fi
    load_ruleset -c
    deadman_arm "$UNIT" "$DEADMAN_SECONDS" /usr/sbin/nft delete table inet ecloud
    load_ruleset
    echo "loaded. NOW: open a new ssh session, curl -sI https://q-mira.com, then run '$0 confirm'"
    ;;
  confirm)
    deadman_disarm "$UNIT"
    # F-P10R-7: if the dead-man already fired, the table is gone; never persist an unloaded state.
    if ! nft list table inet ecloud >/dev/null 2>&1; then
      echo "table inet ecloud is NOT loaded (dead-man fired?); nothing persisted. Re-run apply." >&2
      exit 1
    fi
    cp -a /etc/nftables.conf "/etc/nftables.conf.bak.$(date +%F-%H%M%S)"
    install -m 0644 "$SRC_DIR/nftables.conf" /etc/nftables.conf
    nft -c -f /etc/nftables.conf
    systemctl enable nftables
    echo "persisted: /etc/nftables.conf includes /etc/nftables.d/*.nft (no flush ruleset)"
    ;;
  rollback)
    nft delete table inet ecloud 2>/dev/null || true
    systemctl stop "$UNIT.timer" 2>/dev/null || true
    echo "table inet ecloud removed; Docker and other tables untouched"
    ;;
  *)
    sed -n '2,22p' "${BASH_SOURCE[0]}"
    exit 2
    ;;
esac
