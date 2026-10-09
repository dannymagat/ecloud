#!/usr/bin/env bash
# =============================================================================================
#  DOCKER-USER policy for vps (DRAFT, NOT APPLIED; docs/VPS_CHANGE_LIST.md, infra/vps/README.md)
#
#    docker-user.sh apply      (re)build the DOCKER-USER chain (iptables + ip6tables), idempotent
#    docker-user.sh show       print the chains
#    docker-user.sh rollback   reset DOCKER-USER to Docker's default (single RETURN)
#
#  Docker's documented hook for filtering traffic TO containers (FORWARD path, after DNAT).
#  Policy (SECURITY_ARCHITECTURE §2.3, D-032):
#    - replies (ESTABLISHED,RELATED) pass;
#    - from wg0: only NEW RADIUS udp 1812/1813 whose ORIGINAL destination was the hub address
#      100.100.0.1 (the freeradius publish) passes; everything else from the overlay is dropped;
#    - from the public NIC: every NEW connection into a container is dropped (nothing is
#      published publicly; all TCP publishes are 127.0.0.1, RADIUS is on the tunnel address);
#    - container-originated traffic (egress, CoA from the worker via wg0) is not matched here.
#  Persisted by ecloud-docker-user.service (After/PartOf docker.service).
#  Interface names are parameters: PUBLIC_IF (default ens3), WG_IF (default wg0),
#  HUB_IP (default 100.100.0.1).
# =============================================================================================
set -euo pipefail

PUBLIC_IF="${PUBLIC_IF:-ens3}"
WG_IF="${WG_IF:-wg0}"
HUB_IP="${HUB_IP:-100.100.0.1}"
IPTABLES="${IPTABLES:-iptables}"
IP6TABLES="${IP6TABLES:-ip6tables}"

ensure_chain() {
  local bin="$1"
  "$bin" -w -N DOCKER-USER 2>/dev/null || true
  "$bin" -w -F DOCKER-USER
}

apply_v4() {
  ensure_chain "$IPTABLES"
  "$IPTABLES" -w -A DOCKER-USER -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
  "$IPTABLES" -w -A DOCKER-USER -i "$WG_IF" -p udp -m multiport --dports 1812,1813 \
    -m conntrack --ctstate NEW --ctorigdst "$HUB_IP" -j RETURN
  "$IPTABLES" -w -A DOCKER-USER -i "$WG_IF" -m limit --limit 5/min -j LOG --log-prefix "ecloud-docker-wg-drop "
  "$IPTABLES" -w -A DOCKER-USER -i "$WG_IF" -j DROP
  "$IPTABLES" -w -A DOCKER-USER -i "$PUBLIC_IF" -m conntrack --ctstate NEW -j DROP
  "$IPTABLES" -w -A DOCKER-USER -j RETURN
}

apply_v6() {
  ensure_chain "$IP6TABLES"
  "$IP6TABLES" -w -A DOCKER-USER -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
  "$IP6TABLES" -w -A DOCKER-USER -i "$WG_IF" -j DROP
  "$IP6TABLES" -w -A DOCKER-USER -i "$PUBLIC_IF" -m conntrack --ctstate NEW -j DROP
  "$IP6TABLES" -w -A DOCKER-USER -j RETURN
}

case "${1:-}" in
  apply)
    apply_v4
    apply_v6
    ;;
  show)
    "$IPTABLES" -w -S DOCKER-USER
    "$IP6TABLES" -w -S DOCKER-USER
    ;;
  rollback)
    for bin in "$IPTABLES" "$IP6TABLES"; do
      ensure_chain "$bin"
      "$bin" -w -A DOCKER-USER -j RETURN
    done
    ;;
  *)
    echo "usage: $0 apply|show|rollback" >&2
    exit 2
    ;;
esac
