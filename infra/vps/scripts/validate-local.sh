#!/usr/bin/env bash
# LOCAL validation of the infra/vps drafts (P10-A). Every check runs in a throw-away container
# with its own network namespace (never --network host, never --privileged): nothing touches the
# developer host's firewall, the VPS, DNS or Caddy.
#
#   bash infra/vps/scripts/validate-local.sh
#
# Checks: nft -c on Ubuntu 24.04's nftables (the VPS version) + coexistence with a foreign table
# (Docker stand-in) across apply/re-apply/rollback; DOCKER-USER script idempotency; caddy
# validate + fmt (caddy 2.11, the VPS major/minor); sshd -t / sshd -T with the drop-in on
# Ubuntu 24.04's OpenSSH; fail2ban-regex of both filters against sample app log lines.
set -euo pipefail
VPS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UBUNTU_IMAGE="${UBUNTU_IMAGE:-ubuntu:24.04}"
CADDY_IMAGE="${CADDY_IMAGE:-caddy:2.11}"
ALPINE_IMAGE="${ALPINE_IMAGE:-alpine:3.22}"
pass=0
fail=0
step() {
  local name="$1"
  shift
  if "$@"; then
    echo "PASS  $name"
    pass=$((pass + 1))
  else
    echo "FAIL  $name"
    fail=$((fail + 1))
  fi
}

nft_ubuntu() {
  docker run --rm --cap-add NET_ADMIN -v "$VPS_DIR/nftables:/n:ro" "$UBUNTU_IMAGE" bash -euc '
    apt-get update -qq >/dev/null && apt-get install -y -qq nftables >/dev/null
    nft --version
    nft -c -f /n/ecloud.nft
    # Docker stand-in: a foreign table that must survive apply, re-apply and rollback.
    nft add table ip dockerstandin
    nft add chain ip dockerstandin POSTROUTING "{ type nat hook postrouting priority srcnat; }"
    nft -f /n/ecloud.nft
    nft -f /n/ecloud.nft
    nft list table ip dockerstandin >/dev/null
    # allow-list transaction (F-P10R-4): table + host-local elements load atomically, twice
    mkdir -p /etc/nftables.d && cp /n/ecloud.nft /etc/nftables.d/ecloud.nft
    printf "add element inet ecloud ssh_admins4 { 192.0.2.10 }\nadd element inet ecloud ssh_admins6 { 2001:db8::10 }\n" > /etc/nftables.d/zz-ecloud-admins.nft
    printf "include \"/etc/nftables.d/ecloud.nft\"\ninclude \"/etc/nftables.d/zz-ecloud-admins.nft\"\n" > /tmp/tx.nft
    nft -c -f /tmp/tx.nft && nft -f /tmp/tx.nft && nft -f /tmp/tx.nft
    nft list set inet ecloud ssh_admins4 | grep -q 192.0.2.10
    nft list set inet ecloud ssh_admins6 | grep -q 2001:db8::10
    test "$(nft list tables | grep -c "table inet ecloud")" = 1
    nft list chain inet ecloud input | grep -q "tcp dport 22 ct state new add @ssh_meter4"
    nft delete table inet ecloud
    nft list table ip dockerstandin >/dev/null
    ! nft list tables | grep -q "inet ecloud"
    # nftables.conf must not flush the ruleset
    ! grep -Eq "^[[:space:]]*flush[[:space:]]+ruleset" /n/nftables.conf
  '
}

docker_user() {
  docker run --rm --cap-add NET_ADMIN -v "$VPS_DIR/nftables:/n:ro" "$ALPINE_IMAGE" sh -euc '
    apk add --no-cache bash iptables ip6tables >/dev/null
    bash /n/docker-user.sh apply
    first="$(bash /n/docker-user.sh show)"
    bash /n/docker-user.sh apply
    test "$first" = "$(bash /n/docker-user.sh show)"
    echo "$first" | grep -q -- "--ctorigdst 100.100.0.1"
    bash /n/docker-user.sh rollback
    test "$(iptables -S DOCKER-USER | grep -c -- "-A DOCKER-USER")" = 1
  '
}

caddy_validate() {
  docker run --rm -v "$VPS_DIR/caddy/sites:/etc/caddy/sites:ro" \
    -v "$VPS_DIR/test/Caddyfile.harness:/etc/caddy/Caddyfile:ro" "$CADDY_IMAGE" sh -euc '
    caddy version
    caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile 2>&1 | tail -1 | grep -q "Valid configuration"
    caddy fmt /etc/caddy/sites/ezecloud.caddy | diff -q - /etc/caddy/sites/ezecloud.caddy >/dev/null
  '
}

# Behaviour, not just syntax (F-P10R-2): serve the real site file over plain HTTP (hostnames
# rewritten to :8080 vhosts, no ACME) and assert the private paths answer 404 on all three vhosts
# while the admin SPA still answers 200. Upstreams are absent, so proxied paths would be 502.
caddy_behaviour() {
  docker run --rm -v "$VPS_DIR/caddy/sites:/s:ro" "$CADDY_IMAGE" sh -euc '
    mkdir -p /var/log/caddy /opt/ecloud/admin /etc/caddy/sites
    echo spa > /opt/ecloud/admin/index.html
    sed -E "s/^(ezecloud|api\.ezecloud|portal\.ezecloud)\.ezelink\.ai \{/http:\/\/\1.ezelink.ai:8080 {/" \
      /s/ezecloud.caddy > /etc/caddy/sites/ezecloud.caddy
    printf "{\n\tadmin off\n\tauto_https off\n}\nimport /etc/caddy/sites/*.caddy\n" > /etc/caddy/Caddyfile
    caddy start --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1
    code() { wget -q -S -O /dev/null --header "Host: $1" "http://127.0.0.1:8080$2" 2>&1 | grep -oE "HTTP/1\.1 [0-9]{3}" | tail -1 | cut -d" " -f2; }
    code404() { c="$(code "$1" "$2" || true)"; [ "${c:-404}" = 404 ] || { echo "$1$2 -> $c (want 404)"; exit 1; }; }
    for h in ezecloud.ezelink.ai api.ezecloud.ezelink.ai portal.ezecloud.ezelink.ai; do
      for p in /readyz /metrics /metrics/x /internal /internal/aaa/authorize; do code404 "$h" "$p"; done
    done
    c="$(code ezecloud.ezelink.ai /some/spa/route)"; [ "$c" = 200 ] || { echo "SPA -> $c"; exit 1; }
    code404 api.ezecloud.ezelink.ai /api/v1/auth/login
  '
}

sshd_check() {
  docker run --rm -v "$VPS_DIR/ssh/sshd_config.d:/d:ro" "$UBUNTU_IMAGE" bash -euc '
    apt-get update -qq >/dev/null && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq openssh-server >/dev/null
    mkdir -p /run/sshd && ssh-keygen -A >/dev/null
    grep -q "^Include /etc/ssh/sshd_config.d/\*.conf" /etc/ssh/sshd_config
    cp /d/10-ecloud-hardening.conf /etc/ssh/sshd_config.d/
    # cloud-init style later file must not override the hardening (first value wins)
    printf "PasswordAuthentication yes\nX11Forwarding yes\n" > /etc/ssh/sshd_config.d/50-cloud-init.conf
    sshd -t
    eff="$(sshd -T -C user=ubuntu,host=client,addr=192.0.2.1)"
    sshd -V 2>&1 | head -1 || true
    for kv in "permitrootlogin no" "passwordauthentication no" "kbdinteractiveauthentication no" \
              "x11forwarding no" "allowusers ubuntu" "maxauthtries 3" "allowtcpforwarding local" \
              "clientaliveinterval 300"; do
      echo "$eff" | grep -qx "$kv" || { echo "missing: $kv"; exit 1; }
    done
  '
}

fail2ban_regex() {
  docker run --rm -v "$VPS_DIR/fail2ban:/f:ro" -v "$VPS_DIR/test:/t:ro" "$ALPINE_IMAGE" sh -euc '
    apk add --no-cache fail2ban >/dev/null
    fail2ban-client --version
    a="$(fail2ban-regex /t/sample-auth-events.log /f/filter.d/ecloud-admin.conf)"
    p="$(fail2ban-regex /t/sample-auth-events.log /f/filter.d/ecloud-portal.conf)"
    echo "$a" | grep -E "^Lines:|Failregex:"
    echo "$p" | grep -E "^Lines:|Failregex:"
    # admin: 3 events with a real address (the "unknown" one must not match); portal: 1 (rate
    # limited lines are not counted)
    echo "$a" | grep -q "Failregex: 3 total"
    echo "$p" | grep -q "Failregex: 1 total"
  '
}

step "nftables: nft -c + idempotent apply + Docker table survives (Ubuntu 24.04 nft)" nft_ubuntu
step "DOCKER-USER: idempotent apply + rollback (iptables-nft)" docker_user
step "caddy: validate + fmt with q-mira stand-in + import" caddy_validate
step "caddy: private paths 404 on every vhost, SPA 200 (behaviour)" caddy_behaviour
step "sshd: sshd -t + effective settings win over a later drop-in (Ubuntu 24.04 OpenSSH)" sshd_check
step "fail2ban: filters match the app's security events only" fail2ban_regex

echo "validate-local: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
