#!/usr/bin/env bash
# =============================================================================================
#  DOCKER-USER policy for vps-local (DRAFT, NOT APPLIED; docs/VPS_LOCAL_CHANGE_LIST.md LCL-FW-2)
#
#    docker-user.sh apply      (re)build the DOCKER-USER chain, idempotent
#    docker-user.sh show       print the chain
#    docker-user.sh rollback   reset DOCKER-USER to Docker's default (single RETURN)
#
#  Why DOCKER-USER and not firewalld rich rules: Docker publishes ports with DNAT; firewalld's
#  forward chain on EL8 (firewalld 0.9, nftables backend) starts with `ct status dnat accept`,
#  so zone/rich rules never see a Docker-published port (verified in an oraclelinux:8
#  container, infra/vps-local/scripts/validate-local.sh). DOCKER-USER is Docker's documented
#  hook for filtering traffic TO containers (iptables-nft `filter FORWARD`, after DNAT).
#
#  Policy (LAN-only pilot, D-042):
#    - replies (ESTABLISHED,RELATED) pass;
#    - NEW tcp 8443/8444 (edge) whose ORIGINAL destination is ECLOUD_LAN_IP pass only from
#      ECLOUD_WEB_CIDRS;
#    - NEW udp 1812/1813 (freeradius) whose original destination is ECLOUD_LAN_IP pass only
#      from ECLOUD_RADIUS_CIDRS;
#    - every other NEW connection from outside the ECLOUD bridge into it is logged + dropped
#      (WAN interfaces included, whatever address they get later);
#    - container-originated traffic (egress, CoA to the NAS) and container<->container traffic
#      on br-ecloud are not matched here.
#  Settings come from the environment (the systemd unit reads /etc/ecloud/docker-user.env,
#  host-local, never committed): ECLOUD_LAN_IP, ECLOUD_WEB_CIDRS, ECLOUD_RADIUS_CIDRS
#  (space-separated), ECLOUD_BRIDGE (default br-ecloud).
#  IPv6: Docker's ip6tables support is off by default and the ECLOUD network is IPv4-only; the
#  ip6tables chain is only reset to Docker's default if it exists.
# =============================================================================================
set -euo pipefail

BRIDGE="${ECLOUD_BRIDGE:-br-ecloud}"
IPTABLES="${IPTABLES:-iptables}"
WEB_PORTS="8443,8444"
RADIUS_PORTS="1812,1813"

need_config() {
  local v
  for v in ECLOUD_LAN_IP ECLOUD_WEB_CIDRS ECLOUD_RADIUS_CIDRS; do
    if [ -z "${!v:-}" ]; then
      echo "refusing: $v is not set (see /etc/ecloud/docker-user.env)" >&2
      exit 3
    fi
  done
  is_ipv4 "$ECLOUD_LAN_IP" || { echo "refusing: ECLOUD_LAN_IP must be an IPv4 address" >&2; exit 3; }
  local c
  for c in $ECLOUD_WEB_CIDRS $ECLOUD_RADIUS_CIDRS; do
    private_cidr "$c" || {
      echo "refusing: $c is not an RFC1918 IPv4 address/CIDR with prefix >= /8 inside 10/8, 172.16/12 or 192.168/16" >&2
      exit 3
    }
  done
}

# is_ipv4 <a.b.c.d>
is_ipv4() {
  [[ "$1" =~ ^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$ ]] || return 1
  local o
  for o in "${BASH_REMATCH[@]:1}"; do [ "$((10#$o))" -le 255 ] || return 1; done
}

# private_cidr <a.b.c.d[/p]>: RFC1918 only, and never wider than the private block itself
# (so never shorter than /8; 0.0.0.0/0 and public space are refused).
private_cidr() {
  local addr="${1%/*}" p=32
  [[ "$1" == */* ]] && p="${1#*/}"
  [[ "$p" =~ ^[0-9]{1,2}$ ]] && [ "$p" -ge 8 ] && [ "$p" -le 32 ] || return 1
  is_ipv4 "$addr" || return 1
  local a b
  IFS=. read -r a b _ _ <<<"$addr"
  a=$((10#$a))
  b=$((10#$b))
  if [ "$a" -eq 10 ]; then return 0; fi
  if [ "$a" -eq 172 ] && [ "$b" -ge 16 ] && [ "$b" -le 31 ] && [ "$p" -ge 12 ]; then return 0; fi
  if [ "$a" -eq 192 ] && [ "$b" -eq 168 ] && [ "$p" -ge 16 ]; then return 0; fi
  return 1
}

ensure_chain() {
  "$IPTABLES" -w -N DOCKER-USER 2>/dev/null || true
  "$IPTABLES" -w -F DOCKER-USER
}

apply_v4() {
  need_config
  ensure_chain
  "$IPTABLES" -w -A DOCKER-USER -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
  local c
  for c in $ECLOUD_WEB_CIDRS; do
    "$IPTABLES" -w -A DOCKER-USER -s "$c" -o "$BRIDGE" -p tcp -m multiport --dports "$WEB_PORTS" \
      -m conntrack --ctstate NEW --ctorigdst "$ECLOUD_LAN_IP" -j RETURN
  done
  for c in $ECLOUD_RADIUS_CIDRS; do
    "$IPTABLES" -w -A DOCKER-USER -s "$c" -o "$BRIDGE" -p udp -m multiport --dports "$RADIUS_PORTS" \
      -m conntrack --ctstate NEW --ctorigdst "$ECLOUD_LAN_IP" -j RETURN
  done
  "$IPTABLES" -w -A DOCKER-USER ! -i "$BRIDGE" -o "$BRIDGE" -m conntrack --ctstate NEW \
    -m limit --limit 5/min -j LOG --log-prefix "ecloud-docker-drop "
  "$IPTABLES" -w -A DOCKER-USER ! -i "$BRIDGE" -o "$BRIDGE" -m conntrack --ctstate NEW -j DROP
  "$IPTABLES" -w -A DOCKER-USER -j RETURN
}

reset_chain() {
  local bin="$1"
  if "$bin" -w -S DOCKER-USER >/dev/null 2>&1; then
    "$bin" -w -F DOCKER-USER
    "$bin" -w -A DOCKER-USER -j RETURN
  fi
}

case "${1:-}" in
  apply)
    apply_v4
    ;;
  show)
    "$IPTABLES" -w -S DOCKER-USER
    ;;
  rollback)
    reset_chain "$IPTABLES"
    reset_chain "${IP6TABLES:-ip6tables}"
    echo "DOCKER-USER reset to Docker's default (RETURN only)"
    ;;
  *)
    echo "usage: $0 apply|show|rollback" >&2
    exit 2
    ;;
esac
