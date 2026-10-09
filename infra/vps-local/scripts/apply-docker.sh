#!/usr/bin/env bash
# Docker daemon config + enable on vps-local (DRAFT, NOT RUN). docs/VPS_LOCAL_CHANGE_LIST.md
# LCL-DOCKER-1..3. Run from /opt/ecloud/infra/vps-local/scripts:
#
#   sudo ECLOUD_APPROVED_CHANGE=LCL-DOCKER-1 ./apply-docker.sh stage     # checks + validate only
#   sudo ECLOUD_APPROVED_CHANGE=LCL-DOCKER-2 ./apply-docker.sh config    # install daemon.json
#   sudo ECLOUD_APPROVED_CHANGE=LCL-DOCKER-3 ./apply-docker.sh enable    # enable --now docker
#   sudo ECLOUD_APPROVED_CHANGE=LCL-DOCKER-3 ./apply-docker.sh rollback  # stop/disable, restore config
#
# Docker is installed but has never been enabled on this host (discovery 2026-10-09). Enabling
# it: registers a firewalld zone `docker`, sets net.ipv4.ip_forward=1 and — ONLY if it had to
# switch ip_forward on itself — sets the iptables FORWARD policy to DROP. `stage` records both so
# the owner can judge the effect on the EZEOS appliance before `enable` (LCL-PRE-6).
set -euo pipefail
# shellcheck source-path=SCRIPTDIR source=../../vps/scripts/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/../../vps/scripts/common.sh"
require_approval

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$HERE/../docker/daemon.json"
DST=/etc/docker/daemon.json
DATA_ROOT=/data/docker
BK_DIR=/root/ecloud-docker-backup

case "${1:-}" in
  stage)
    findmnt -no FSTYPE /data | grep -qx xfs || { echo "refusing: /data is not xfs" >&2; exit 3; }
    xfs_info /data | grep -q 'ftype=1' || { echo "refusing: /data xfs lacks ftype=1 (overlay2)" >&2; exit 3; }
    dockerd --validate --config-file "$SRC"
    echo "ip_forward now: $(sysctl -n net.ipv4.ip_forward)  (0 => Docker will set FORWARD policy DROP)"
    echo "iptables FORWARD: $(iptables -w -S FORWARD | head -1)"
    echo "existing $DST: $([ -f "$DST" ] && echo present || echo none)"
    echo "existing /var/lib/docker: $(du -sh /var/lib/docker 2>/dev/null | cut -f1 || echo none)"
    echo "routes (172.28/16 and 172.29/16 must not collide):"
    ip -4 route | grep -E '^(172\.(1[6-9]|2[0-9]|3[01])\.|default)' || true
    ;;
  config)
    install -d -m 0700 "$BK_DIR"
    if [ -f "$DST" ]; then cp -p "$DST" "$BK_DIR/daemon.json.$(date +%F-%H%M%S)"; fi
    dockerd --validate --config-file "$SRC"
    install -d -m 0710 "$DATA_ROOT"
    install -d -m 0755 /etc/docker
    install -m 0644 "$SRC" "$DST"
    echo "installed $DST (takes effect at the next docker start)"
    ;;
  enable)
    systemctl enable --now docker.service
    docker info --format 'root={{.DockerRootDir}} driver={{.Driver}} cgroup={{.CgroupVersion}}'
    firewall-cmd --get-active-zones || true
    echo "NOW: check-host.sh baseline (EZEOS UI must still answer)"
    ;;
  rollback)
    systemctl disable --now docker.service docker.socket || true
    last="$(find "$BK_DIR" -maxdepth 1 -name 'daemon.json.*' 2>/dev/null | sort | tail -1)"
    if [ -n "$last" ]; then cp -p "$last" "$DST"; else rm -f "$DST"; fi
    echo "docker stopped + disabled; $DST restored. $DATA_ROOT left in place (data)."
    echo "If 'firewall-cmd --permanent --get-zones' now lists 'docker' and the LCL-FW-1 snapshot did"
    echo "not: firewall-cmd --permanent --delete-zone=docker && firewall-cmd --reload (owner decision)."
    ;;
  *)
    echo "usage: $0 stage|config|enable|rollback" >&2
    exit 2
    ;;
esac
