#!/usr/bin/env bash
# LOCAL validation of the infra/vps-local drafts. Every check runs on the workstation or in a
# throw-away container with its own network namespace (never --network host, never
# --privileged): nothing touches vps-local, the developer host's firewall, DNS or any device.
#
#   bash infra/vps-local/scripts/validate-local.sh
#
# Checks:
#   1. bash -n (and shellcheck when installed) of every script
#   2. docker compose config -q (workstation Compose AND the host's 2.27.0) of compose.pilot.yaml + compose.vps-local.yaml (dummy secrets),
#      plus the effective ports / origins (api+portal unpublished, edge + RADIUS on the LAN IP)
#   3. make-lan-tls.sh on Oracle Linux 8 openssl 1.1.1: CA (name-constrained), leaf, refusal to
#      overwrite the CA, refusal to issue outside the constraint
#   4. edge behaviour: the real built admin SPA (apps/admin/dist) served by the pinned
#      nginx-unprivileged image with the edge config, read-only, cap_drop ALL, TLS verified
#      against the test CA; private paths 404, SPA fallback, /api proxied with overwritten
#      X-Forwarded-For / https proto, portal cookie allow-list, security headers, http->https
#   5. dockerd --validate of daemon.json with Docker 26.1 (host runs 26.1.3)
#   6. DOCKER-USER script on Oracle Linux 8 (iptables-nft 1.8.5) with firewalld 0.9 running
#      (nftables backend): idempotent apply, refusals, survives `firewall-cmd --reload`,
#      rollback; and firewalld's forward chain accepts DNAT'ed packets (why not rich rules)
#   7. upload-github.sh against a local bare repository on Oracle Linux 8 git: the backup branch
#      is one orphan commit with the newest N sets, >limit files split and reassembled,
#      main/master, plaintext and non-age files refused
#   8. reload-radius.sh with a fake compose: freeradius restarted on renderer exit 0 and 3 (3 is
#      propagated), never on 1/2
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
LCL="$REPO/infra/vps-local"
OL_IMAGE="${OL_IMAGE:-oraclelinux:8}"
NGINX_IMAGE="$(sed -n 's/^ARG NGINX_IMAGE=//p' "$REPO/infra/docker/Dockerfile")"
PY_IMAGE="${PY_IMAGE:-python:3.12-alpine}"
CURL_IMAGE="${CURL_IMAGE:-curlimages/curl:8.11.1}"
DIND_IMAGE="${DIND_IMAGE:-docker:26.1-dind}"
SHELLCHECK_IMAGE="${SHELLCHECK_IMAGE:-koalaman/shellcheck:stable}"
COMPOSE_HOST_IMAGE="${COMPOSE_HOST_IMAGE:-docker/compose-bin:v2.27.0}"
LAN_IP=192.168.203.196
WORK="$(mktemp -d)"
NET="lcl-edge-test-$$"
pass=0
fail=0

cleanup() {
  docker rm -f "lcl-api-$$" "lcl-portal-$$" "lcl-edge-$$" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

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

# ---- 1 ---------------------------------------------------------------------------------------
syntax() {
  local f rc=0
  for f in "$LCL"/scripts/*.sh "$LCL"/scripts/ecloud-compose "$LCL"/firewall/*.sh "$LCL"/backup/*.sh; do
    bash -n "$f" || rc=1
  done
  # Static analysis (warnings and errors), from the official image when not installed locally.
  local files=(infra/vps-local/scripts/*.sh infra/vps-local/scripts/ecloud-compose
    infra/vps-local/firewall/docker-user.sh infra/vps-local/test/edge-behaviour.sh
    infra/vps-local/backup/upload-github.sh infra/vps-local/scripts/reload-radius.sh)
  if command -v shellcheck >/dev/null; then
    (cd "$REPO" && shellcheck -x -S warning "${files[@]}") || rc=1
  else
    docker run --rm -v "$REPO:/mnt:ro" -w /mnt "$SHELLCHECK_IMAGE" -x -S warning "${files[@]}" || rc=1
  fi
  return "$rc"
}

# ---- 2 ---------------------------------------------------------------------------------------
compose_check() {
  local s="$WORK/secrets" t="$WORK/tlsdummy" env="$WORK/ecloud.env" n
  mkdir -p "$s" "$t"
  for n in postgres_password ecloud_app_password ecloud_platform_password radius_sql_password \
    radius_status_secret internal_api_token mfa_encryption_key data_encryption_key voucher_pepper \
    portal_state_secret database_url database_url_platform redis_url redis_conf; do
    echo dummy >"$s/$n"
  done
  echo dummy >"$t/edge.crt"
  echo dummy >"$t/edge.key"
  cat >"$env" <<EOF
ECLOUD_ROOT=$REPO
IMAGE_TAG=validate
ECLOUD_REGISTRY=ghcr.io/dannymagat
ECLOUD_LAN_IP=$LAN_IP
ECLOUD_SECRETS_DIR=$s
ECLOUD_TLS_DIR=$t
EOF
  local dc=(docker compose --env-file "$env" -f "$REPO/infra/vps/compose/compose.pilot.yaml"
    -f "$LCL/compose/compose.vps-local.yaml" --profile migrate --profile radius)
  "${dc[@]}" config -q || return 1
  # Same check with the host's Compose version (2.27.0; !reset / !override need >= 2.24.4). The
  # static linux/amd64 binary runs without a daemon; paths are mounted at identical locations.
  docker run --rm --platform linux/amd64 -v "$REPO:$REPO:ro" -v "$WORK:$WORK:ro" \
    --entrypoint /docker-compose "$COMPOSE_HOST_IMAGE" --env-file "$env" \
    -f "$REPO/infra/vps/compose/compose.pilot.yaml" -f "$LCL/compose/compose.vps-local.yaml" \
    --profile migrate --profile radius config -q || return 1
  "${dc[@]}" config --format json >"$WORK/compose.json" || return 1
  python3 - "$WORK/compose.json" "$LAN_IP" "$REPO" <<'EOF'
import json, sys
c = json.load(open(sys.argv[1])); ip = sys.argv[2]; repo = sys.argv[3]; s = c["services"]
errs = []
for name in ("api", "portal", "worker", "postgres", "redis"):
    if s[name].get("ports"):
        errs.append(f"{name} must not publish ports: {s[name]['ports']}")
want = {("edge", 8443, "tcp"), ("edge", 8444, "tcp"), ("freeradius", 1812, "udp"), ("freeradius", 1813, "udp")}
got = set()
for name, svc in s.items():
    for p in svc.get("ports", []):
        if p.get("host_ip") != ip:
            errs.append(f"{name} publishes on {p.get('host_ip')!r}, not the LAN IP")
        got.add((name, int(p["published"]), p.get("protocol", "tcp")))
if got != want:
    errs.append(f"published set {sorted(got)} != {sorted(want)}")
for name in ("api", "portal", "worker", "migrate"):
    e = s[name]["environment"]
    for k, v in (("PUBLIC_ADMIN_ORIGIN", f"https://{ip}:8443"), ("PUBLIC_API_ORIGIN", f"https://{ip}:8443"),
                 ("PUBLIC_PORTAL_ORIGIN", f"https://{ip}:8444")):
        if e.get(k) != v:
            errs.append(f"{name} {k}={e.get(k)!r}")
if s["api"]["environment"].get("TRUST_PROXY_HOPS") != "1" or s["portal"]["environment"].get("PORTAL_TRUST_PROXY_HOPS") != "1":
    errs.append("trust proxy hops must stay 1")
rc = s.get("radius-clients", {})
if rc.get("command") != ["node", "apps/api/dist/radius-clients-cli.js"] or rc.get("user") != "1000:101":
    errs.append("radius-clients one-shot missing or changed")
fr = s["freeradius"]
if fr.get("depends_on", {}).get("radius-clients", {}).get("condition") != "service_completed_successfully":
    errs.append("freeradius must wait for radius-clients")
if not any(v.get("source") == "radius_clients" and v.get("target") == "/etc/freeradius/clients.d" and v.get("read_only") for v in fr.get("volumes", [])):
    errs.append("freeradius clients.d mount missing")
if fr["environment"].get("RADIUS_CLIENTS_RENDERED") != "1" or "radius_clients" not in c.get("volumes", {}):
    errs.append("RADIUS_CLIENTS_RENDERED / radius_clients volume missing")
edge = s["edge"]
if not edge.get("read_only") or edge.get("cap_drop") != ["ALL"]:
    errs.append("edge must be read_only with cap_drop ALL")
if not any(v.get("target") == "/etc/nginx/conf.d" and v.get("source") == f"{repo}/infra/vps-local/edge" for v in edge["volumes"]):
    errs.append(f"edge conf.d mount wrong: {edge['volumes']}")
print("\n".join(errs) if errs else "      compose: only edge 8443/8444 + RADIUS 1812/1813 on the LAN IP; origins + radius-clients OK")
sys.exit(1 if errs else 0)
EOF
}

# ---- 3 ---------------------------------------------------------------------------------------
tls_check() {
  mkdir -p "$WORK/tls"
  docker run --rm -v "$LCL/scripts:/s:ro" -v "$WORK/tls:/tls" -e TLS_DIR=/tls \
    -e ECLOUD_TLS_LOCAL_TEST=1 "$OL_IMAGE" bash -euc '
      dnf -q -y install openssl >/dev/null 2>&1
      bash /s/make-lan-tls.sh ca >/dev/null
      bash /s/make-lan-tls.sh leaf '"$LAN_IP"' >/dev/null
      if bash /s/make-lan-tls.sh ca >/dev/null 2>&1; then echo "CA overwrite NOT refused"; exit 1; fi
      if bash /s/make-lan-tls.sh leaf 10.0.0.1 >/dev/null 2>&1; then echo "leaf outside constraint NOT refused"; exit 1; fi
      openssl verify -CAfile /tls/ca/ca.crt /tls/edge.crt >/dev/null
      openssl x509 -in /tls/ca/ca.crt -noout -text | grep -q "Name Constraints: critical"
      openssl x509 -in /tls/edge.crt -noout -text | grep -q "IP Address:'"$LAN_IP"'"
      [ "$(stat -c %a /tls/ca/ca.key)" = 600 ] && [ "$(stat -c %a /tls/edge.key)" = 440 ]
      chmod 0644 /tls/edge.key /tls/ca/ca.key   # test copy only: Docker Desktop bind mounts
    '
}

# ---- 4 ---------------------------------------------------------------------------------------
edge_check() {
  [ -f "$REPO/apps/admin/dist/index.html" ] || { echo "      build the SPA first: npm run build -w @ecloud/admin"; return 1; }
  docker network create "$NET" >/dev/null
  docker run -d --name "lcl-api-$$" --network "$NET" --network-alias api \
    -v "$LCL/test:/t:ro" "$PY_IMAGE" python /t/echo_upstream.py 3000 api >/dev/null
  docker run -d --name "lcl-portal-$$" --network "$NET" --network-alias portal \
    -v "$LCL/test:/t:ro" "$PY_IMAGE" python /t/echo_upstream.py 3002 portal >/dev/null
  # Same shape as the compose `edge` service (the admin image = this base + dist + ENTRYPOINT).
  docker run -d --name "lcl-edge-$$" --network "$NET" --network-alias edge \
    --read-only --tmpfs /tmp:size=32m,mode=1777 --cap-drop ALL --security-opt no-new-privileges:true \
    -v "$REPO/apps/admin/dist:/usr/share/ecloud-admin:ro" -v "$LCL/edge:/etc/nginx/conf.d:ro" \
    -v "$WORK/tls/edge.crt:/run/secrets/edge_tls_crt:ro" -v "$WORK/tls/edge.key:/run/secrets/edge_tls_key:ro" \
    --entrypoint nginx "$NGINX_IMAGE" -g 'daemon off;' >/dev/null
  sleep 2
  docker exec "lcl-edge-$$" nginx -t -q || { docker logs "lcl-edge-$$"; return 1; }
  docker exec "lcl-edge-$$" wget -q -O /dev/null http://127.0.0.1:8081/healthz || return 1
  docker run --rm --network "$NET" -v "$WORK/tls/ca:/ca:ro" -v "$LCL/test:/t:ro" \
    --entrypoint sh "$CURL_IMAGE" /t/edge-behaviour.sh "$LAN_IP"
}

# ---- 5 ---------------------------------------------------------------------------------------
daemon_check() {
  docker run --rm --entrypoint dockerd -v "$LCL/docker:/x:ro" "$DIND_IMAGE" \
    --validate --config-file /x/daemon.json
}

# ---- 6 ---------------------------------------------------------------------------------------
dockeruser_check() {
  docker run --rm --cap-add NET_ADMIN --cap-add NET_RAW -v "$LCL:/l:ro" -v "$REPO/infra/vps/scripts:/v:ro" \
    "$OL_IMAGE" bash -euc '
      dnf -q -y install firewalld iptables nftables >/dev/null 2>&1
      mkdir -p /run/dbus && dbus-daemon --system --fork
      sed -i "s/^FirewallBackend=.*/FirewallBackend=nftables/" /etc/firewalld/firewalld.conf
      (firewalld --nofork --nopid >/tmp/fw.log 2>&1 &)
      for i in $(seq 1 30); do firewall-cmd --state >/dev/null 2>&1 && break; sleep 1; done
      firewall-cmd --state >/dev/null
      # firewalld cannot filter Docker publishes: DNATed packets are accepted before any zone.
      nft list chain inet firewalld filter_FORWARD | grep -q "ct status dnat accept"
      # Docker stand-in: DOCKER-USER chain jumped to from FORWARD.
      iptables -w -N DOCKER-USER && iptables -w -A DOCKER-USER -j RETURN && iptables -w -I FORWARD -j DOCKER-USER
      export ECLOUD_LAN_IP=192.168.203.196 ECLOUD_WEB_CIDRS="192.168.203.0/24" ECLOUD_RADIUS_CIDRS="192.168.203.0/24 192.168.204.10/32"
      S=/l/firewall/docker-user.sh
      bash $S apply; a="$(iptables -w -S DOCKER-USER)"; bash $S apply; b="$(iptables -w -S DOCKER-USER)"
      [ "$a" = "$b" ] || { echo "apply not idempotent"; exit 1; }
      echo "$a" | grep -q -- "-s 192.168.203.0/24 -o br-ecloud -p tcp -m multiport --dports 8443,8444 -m conntrack --ctstate NEW --ctorigdst 192.168.203.196 -j RETURN"
      echo "$a" | grep -q -- "-s 192.168.204.10/32 -o br-ecloud -p udp -m multiport --dports 1812,1813"
      echo "$a" | grep -q -- "! -i br-ecloud -o br-ecloud -m conntrack --ctstate NEW -j DROP"
      [ "$(echo "$a" | tail -1)" = "-A DOCKER-USER -j RETURN" ]
      for bad in "0.0.0.0/0" "" "192.168.203.0/24;reboot" "8.8.8.0/24" "10.0.0.0/7" "192.168.0.0/8" "192.168.203.300" "172.32.0.0/16"; do
        if ECLOUD_WEB_CIDRS="$bad" bash $S apply >/dev/null 2>&1; then echo "accepted bad CIDR [$bad]"; exit 1; fi
      done
      # firewalld reload (nft backend) must not drop the ECLOUD rules.
      bash $S apply; firewall-cmd --reload >/dev/null; iptables -w -S DOCKER-USER | grep -q ctorigdst
      bash $S rollback >/dev/null
      [ "$(iptables -w -S DOCKER-USER | tail -n +2)" = "-A DOCKER-USER -j RETURN" ]
      # apply-firewall.sh config (validation + env file) works with the shared guard.
      mkdir -p /opt/x/infra && cp -r /l /opt/x/infra/vps-local && mkdir -p /opt/x/infra/vps/scripts && cp /v/common.sh /opt/x/infra/vps/scripts/
      if bash /opt/x/infra/vps-local/scripts/apply-firewall.sh config 1 2 3 >/dev/null 2>&1; then echo "ran without approval"; exit 1; fi
      ECLOUD_APPROVED_CHANGE=LCL-FW-2 bash /opt/x/infra/vps-local/scripts/apply-firewall.sh config 192.168.203.196 192.168.203.0/24 192.168.203.0/24 >/dev/null
      grep -q "^ECLOUD_WEB_CIDRS=\"192.168.203.0/24\"" /etc/ecloud/docker-user.env
      if ECLOUD_APPROVED_CHANGE=LCL-FW-2 bash /opt/x/infra/vps-local/scripts/apply-firewall.sh config 192.168.203.196 0.0.0.0/0 192.168.203.0/24 >/dev/null 2>&1; then echo "config accepted 0.0.0.0/0"; exit 1; fi
    '
}

# ---- 7 ---------------------------------------------------------------------------------------
upload_check() {
  docker run --rm -v "$LCL/backup:/b:ro" "$OL_IMAGE" bash -euc '
    dnf -q -y install git >/dev/null 2>&1
    git init -q --bare /remote.git
    export ECLOUD_UPLOAD_TEST=1 BACKUP_GITHUB_REMOTE=/remote.git BACKUP_GITHUB_CONF=/nonexistent BACKUP_GITHUB_KEEP=2 BACKUP_GITHUB_SPLIT_MB=1
    mk() { d=/sets/$1; mkdir -p $d; { printf "age-encryption.org/v1\n"; head -c ${2:-1000} /dev/urandom; } >$d/ecloud-db-$1.dump.age
      echo x >$d/SHA256SUMS; echo {} >$d/manifest.json; }
    for s in 20261009T021500Z 20261010T021500Z 20261011T021500Z; do
      if [ $s = 20261010T021500Z ]; then mk $s 3145728; else mk $s; fi
      bash /b/upload-github.sh /sets/$s >/dev/null
    done
    heads="$(git --git-dir=/remote.git for-each-ref --format="%(refname:short)" refs/heads | tr "\n" " ")"
    [ "$heads" = "vps-local " ] || { echo "unexpected branches: $heads"; exit 1; }
    git clone -q -b vps-local /remote.git /c
    [ "$(git -C /c rev-list --count HEAD)" = 1 ] || { echo "backup branch has history"; exit 1; }
    [ "$(ls /c | tr "\n" " ")" = "20261010T021500Z 20261011T021500Z README.md " ] || { echo "keep-N wrong: $(ls /c)"; exit 1; }
    grep -qx ecloud-db-20261010T021500Z.dump.age /c/20261010T021500Z/PARTS.txt
    cat /c/20261010T021500Z/ecloud-db-20261010T021500Z.dump.age.part* | cmp - /sets/20261010T021500Z/ecloud-db-20261010T021500Z.dump.age
    if BACKUP_GITHUB_BRANCH=main bash /b/upload-github.sh /sets/20261011T021500Z 2>/dev/null; then echo "pushed to main"; exit 1; fi
    if ECLOUD_UPLOAD_TEST=0 bash /b/upload-github.sh /sets/20261011T021500Z 2>/dev/null; then echo "remote override honoured without test flag"; exit 1; fi
    ls -a /sets | grep -q upload-github && { echo "staging dir left behind"; exit 1; }
    printf "plain\nage-encryption.org/v1\n" >/sets/20261011T021500Z/fake.age
    if bash /b/upload-github.sh /sets/20261011T021500Z 2>/dev/null; then echo "accepted a near-miss age header"; exit 1; fi
    rm /sets/20261011T021500Z/fake.age
    # refusals: plaintext file, non-age content
    mkdir -p /bad/20261012T021500Z && echo secret >/bad/20261012T021500Z/dump.sql
    if bash /b/upload-github.sh /bad/20261012T021500Z 2>/dev/null; then echo "pushed plaintext"; exit 1; fi
    mkdir -p /bad2/20261012T021500Z && echo plain >/bad2/20261012T021500Z/x.age
    if bash /b/upload-github.sh /bad2/20261012T021500Z 2>/dev/null; then echo "pushed non-age .age"; exit 1; fi
  '
}

# ---- 8 ---------------------------------------------------------------------------------------
reload_check() {
  docker run --rm -v "$LCL/scripts:/s:ro" "$OL_IMAGE" bash -euc '
    cat >/fake-ecc <<"EOF2"
#!/bin/bash
echo "$*" >>/calls
case "$*" in *"run --rm -T radius-clients"*) echo "{\"skipped\":[\"nas-1\"]}"; exit "$(cat /rc)" ;; esac
exit 0
EOF2
    chmod +x /fake-ecc
    for rc in 0 3 1 2; do
      echo $rc >/rc; : >/calls
      set +e; ECC=/fake-ecc bash /s/reload-radius.sh >/dev/null 2>&1; got=$?; set -e
      restarted=$(grep -c "restart freeradius" /calls || true)
      case $rc in
        0) [ $got = 0 ] && [ $restarted = 1 ] ;;
        3) [ $got = 3 ] && [ $restarted = 1 ] ;;
        *) [ $got = 1 ] && [ $restarted = 0 ] ;;
      esac || { echo "renderer rc=$rc: exit $got, restarts $restarted"; exit 1; }
    done
  '
}

step "1 shell syntax" syntax
step "2 compose config (pilot + vps-local override)" compose_check
step "3 internal CA + edge certificate (OL8 openssl)" tls_check
step "4 edge behaviour (real admin SPA, TLS, headers, private paths, proxy)" edge_check
step "5 daemon.json (dockerd 26.1 --validate)" daemon_check
step "6 DOCKER-USER on OL8 with firewalld (nft backend)" dockeruser_check
step "7 GitHub backup upload (local bare repo: orphan branch, keep N, split, refusals)" upload_check
step "8 reload-radius.sh (restart on renderer exit 0/3 only)" reload_check
echo "passed: $pass  failed: $fail"
[ "$fail" -eq 0 ]
