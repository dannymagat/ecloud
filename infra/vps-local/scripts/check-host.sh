#!/usr/bin/env bash
# Read-only health / baseline check for vps-local (DRAFT). docs/VPS_LOCAL_CHANGE_LIST.md
# LCL-PRE-4 (run before AND after every step) and LCL-MON-1 (timer). Changes nothing.
#
#   check-host.sh baseline   EZEOS must-not-break services (works without root; more with sudo)
#   check-host.sh ecloud     baseline + ECLOUD containers, edge endpoints, certificate expiry
#
# Exit 0 = all OK, 1 = at least one FAIL. With CHECK_PUSH_URL set (uptime-kuma push monitor,
# REQUIRES_CLARIFICATION where it runs) a successful `ecloud` run is pushed; failures are logged
# to the journal with tag ecloud-check.
set -uo pipefail
LAN_IP="${ECLOUD_LAN_IP:-192.168.203.196}"
TLS_DIR="${ECLOUD_TLS_DIR:-/opt/ecloud/tls}"
fails=0

ok() { echo "OK    $*"; }
bad() {
  echo "FAIL  $*"
  fails=$((fails + 1))
  command -v logger >/dev/null && logger -t ecloud-check -p user.warning "FAIL $*"
}
code() { curl -sk -o /dev/null -m 5 -w '%{http_code}' "$@" 2>/dev/null || echo 000; }
expect() { # expect <label> <wanted-regex> <curl args...>
  local label="$1" want="$2" got
  shift 2
  got="$(code "$@")"
  if [[ "$got" =~ ^($want)$ ]]; then ok "$label -> $got"; else bad "$label -> $got (want $want)"; fi
}
active() {
  if systemctl is-active --quiet "$1"; then ok "service $1 active"; else bad "service $1 not active"; fi
}

baseline() {
  # EZEOS UI (nginx on 80/443) and the :9090 UI: any HTTP answer except 000/5xx counts as up.
  expect 'EZEOS UI https://127.0.0.1/' '[1-4][0-9][0-9]' https://127.0.0.1/
  expect 'EZEOS :9090 https://127.0.0.1:9090/' '[1-4][0-9][0-9]' https://127.0.0.1:9090/
  for s in nginx php-fpm sshd firewalld cloudflared chronyd; do active "$s"; done
  echo "--- listeners (tcp/udp, LISTEN/UNCONN)"
  ss -lntu 2>/dev/null | awk 'NR>1 {print $1, $5}' | sort -u
  if [ "$(id -u)" -eq 0 ]; then
    echo "--- firewalld active zones"
    firewall-cmd --get-active-zones 2>&1
  fi
}

ecloud() {
  if command -v docker >/dev/null && docker info >/dev/null 2>&1; then
    local c st
    for c in ecloud-postgres ecloud-redis ecloud-api ecloud-portal ecloud-worker ecloud-edge; do
      st="$(docker inspect -f '{{.State.Status}}/{{if .State.Health}}{{.State.Health.Status}}{{else}}-{{end}}' "$c" 2>/dev/null || echo absent)"
      case "$st" in running/healthy | running/-) ok "container $c $st" ;; *) bad "container $c $st" ;; esac
    done
  else
    echo "SKIP  containers (docker not reachable for this user; run with sudo)"
  fi
  expect 'edge admin SPA  https://LAN:8443/' '200' "https://$LAN_IP:8443/"
  expect 'edge api health https://LAN:8443/healthz' '200' "https://$LAN_IP:8443/healthz"
  expect 'edge portal     https://LAN:8444/healthz' '200' "https://$LAN_IP:8444/healthz"
  expect 'edge private    https://LAN:8443/readyz' '404' "https://$LAN_IP:8443/readyz"
  if [ -r "$TLS_DIR/edge.crt" ]; then
    if openssl x509 -checkend $((30 * 86400)) -noout -in "$TLS_DIR/edge.crt" >/dev/null; then
      ok "edge certificate valid > 30 days"
    else
      bad "edge certificate expires within 30 days (make-lan-tls.sh leaf)"
    fi
  fi
}

case "${1:-baseline}" in
  baseline) baseline ;;
  ecloud)
    baseline
    ecloud
    ;;
  *)
    echo "usage: $0 baseline|ecloud" >&2
    exit 2
    ;;
esac

if [ "$fails" -eq 0 ]; then
  echo "ALL OK"
  if [ "${1:-}" = ecloud ] && [ -n "${CHECK_PUSH_URL:-}" ]; then
    curl -fsS -m 10 -o /dev/null "$CHECK_PUSH_URL" || echo "push failed"
  fi
  exit 0
fi
echo "$fails FAIL(s)"
exit 1
