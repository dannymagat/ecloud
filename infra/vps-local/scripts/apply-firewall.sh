#!/usr/bin/env bash
# SSH-safe apply of the LAN-only DOCKER-USER policy on vps-local (DRAFT, NOT RUN).
# docs/VPS_LOCAL_CHANGE_LIST.md LCL-FW-1 / LCL-FW-2. Run from /opt/ecloud/infra/vps-local/scripts:
#
#   sudo ECLOUD_APPROVED_CHANGE=LCL-FW-1 ./apply-firewall.sh snapshot           # read state -> /root
#   sudo ECLOUD_APPROVED_CHANGE=LCL-FW-2 ./apply-firewall.sh config <lan-ip> <web-cidrs> <radius-cidrs>
#        (cidrs comma-separated, e.g. 192.168.203.0/24 — REQUIRES_CLARIFICATION, owner)
#   sudo ECLOUD_APPROVED_CHANGE=LCL-FW-2 ./apply-firewall.sh apply              # load + 10-min dead-man
#   ... from a LAN client: https://<lan-ip>:8443 answers; from outside the CIDRs it does not ...
#   sudo ECLOUD_APPROVED_CHANGE=LCL-FW-2 ./apply-firewall.sh confirm            # disarm + persist (unit)
#   sudo ECLOUD_APPROVED_CHANGE=LCL-FW-2 ./apply-firewall.sh rollback           # unit off, chain reset
#   sudo ECLOUD_APPROVED_CHANGE=LCL-FW-1 ./apply-firewall.sh check              # diff vs snapshot
#
# This script NEVER changes firewalld (no zone, service, port or rich rule; no --reload) and
# never touches the LAN / WAN zones of EZEOS, sshd, nginx, cloudflared or the system Redis. It
# only (re)builds the DOCKER-USER chain that Docker owns for exactly this purpose. The dead-man
# resets DOCKER-USER to Docker's default (RETURN), which is the pre-change state.
set -euo pipefail
# shellcheck source-path=SCRIPTDIR source=../../vps/scripts/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/../../vps/scripts/common.sh"
require_approval

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FW_DIR="$(cd "$HERE/../firewall" && pwd)"
ENV_FILE=/etc/ecloud/docker-user.env
UNIT=ecloud-docker-user
DEADMAN_UNIT=ecloud-dockeruser-deadman
DEADMAN_SECONDS="${DEADMAN_SECONDS:-600}"
SNAP_DIR=/root/ecloud-fw-snapshots

state() {
  echo "## firewalld"
  firewall-cmd --state 2>&1 || true
  firewall-cmd --get-active-zones 2>&1 || true
  local z
  for z in $(firewall-cmd --get-zones 2>/dev/null); do
    echo "### zone $z (runtime)"
    firewall-cmd --zone="$z" --list-all 2>&1 || true
    echo "### zone $z (permanent)"
    firewall-cmd --permanent --zone="$z" --list-all 2>&1 || true
  done
  echo "## direct rules"
  firewall-cmd --direct --get-all-rules 2>&1 || true
  echo "## sysctl"
  sysctl net.ipv4.ip_forward 2>&1 || true
  echo "## iptables filter FORWARD policy"
  iptables -w -S FORWARD 2>&1 | head -1 || true
}

case "${1:-}" in
  snapshot)
    install -d -m 0700 "$SNAP_DIR"
    f="$SNAP_DIR/fw.$(date +%F-%H%M%S).txt"
    state >"$f" 2>&1
    nft list ruleset >"$f.nft" 2>&1 || true
    echo "saved $f (+ .nft)"
    ;;
  check)
    last="$(find "$SNAP_DIR" -maxdepth 1 -name 'fw.*.txt' 2>/dev/null | sort | head -1)"
    [ -n "$last" ] || { echo "no snapshot yet: run '$0 snapshot' first" >&2; exit 3; }
    echo "diff of firewalld/sysctl state vs the FIRST snapshot $last (expected: only the 'docker' zone):"
    diff <(cat "$last") <(state 2>&1) && echo "no difference"
    ;;
  config)
    [ "$#" -eq 4 ] || { echo "usage: $0 config <lan-ip> <web-cidrs,> <radius-cidrs,>" >&2; exit 2; }
    # Validate before anything is written into a file that is later sourced.
    [[ "$2" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || { echo "refusing: not an IPv4 address: $2" >&2; exit 3; }
    [[ "$3" =~ ^[0-9./,]+$ && "$4" =~ ^[0-9./,]+$ ]] || { echo "refusing: CIDR lists may contain only digits . / ," >&2; exit 3; }
    install -d -m 0755 /etc/ecloud
    tmp="$(mktemp /etc/ecloud/.docker-user.XXXXXX)"
    {
      echo "# host-local (apply-firewall.sh config $(date -u +%FT%TZ)); NEVER commit"
      echo "ECLOUD_LAN_IP=$2"
      echo "ECLOUD_WEB_CIDRS=\"${3//,/ }\""
      echo "ECLOUD_RADIUS_CIDRS=\"${4//,/ }\""
    } >"$tmp"
    # Validate before installing (docker-user.sh refuses empty / 0.0.0.0/0 / malformed values).
    # shellcheck disable=SC1090
    (set -a; . "$tmp"; set +a; IPTABLES=true "$FW_DIR/docker-user.sh" apply) || { rm -f "$tmp"; exit 3; }
    chmod 0644 "$tmp"
    mv -f "$tmp" "$ENV_FILE"
    cat "$ENV_FILE"
    ;;
  apply)
    [ -f "$ENV_FILE" ] || { echo "refusing: $ENV_FILE missing; run '$0 config ...' first" >&2; exit 3; }
    systemctl is-active --quiet docker || { echo "refusing: docker is not running (LCL-DOCKER-3)" >&2; exit 3; }
    iptables -w -S DOCKER-USER >"/root/docker-user.before.$(date +%F-%H%M%S)" 2>&1 || true
    deadman_arm "$DEADMAN_UNIT" "$DEADMAN_SECONDS" "$FW_DIR/docker-user.sh" rollback
    # shellcheck disable=SC1090
    (set -a; . "$ENV_FILE"; set +a; "$FW_DIR/docker-user.sh" apply)
    "$FW_DIR/docker-user.sh" show
    echo "loaded. NOW: test from a LAN client, then '$0 confirm' within ${DEADMAN_SECONDS}s"
    ;;
  confirm)
    if ! systemctl is-active --quiet "$DEADMAN_UNIT.timer"; then
      echo "refusing: dead-man not armed or already fired; re-run 'apply'" >&2
      exit 3
    fi
    deadman_disarm "$DEADMAN_UNIT"
    install -m 0644 "$FW_DIR/ecloud-docker-user.service" /etc/systemd/system/$UNIT.service
    systemctl daemon-reload
    systemctl enable --now $UNIT.service
    systemctl --no-pager status $UNIT.service | head -5
    ;;
  rollback)
    systemctl disable --now $UNIT.service 2>/dev/null || true
    rm -f /etc/systemd/system/$UNIT.service
    systemctl daemon-reload
    systemctl stop "$DEADMAN_UNIT.timer" 2>/dev/null || true
    "$FW_DIR/docker-user.sh" rollback
    ;;
  *)
    echo "usage: $0 snapshot|check|config|apply|confirm|rollback" >&2
    exit 2
    ;;
esac
