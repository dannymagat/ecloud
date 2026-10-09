#!/usr/bin/env bash
# =============================================================================================
#  Internal CA + edge certificate for the LAN-only ECLOUD pilot on vps-local
#  DRAFT, NOT RUN on any host (docs/VPS_LOCAL_CHANGE_LIST.md LCL-TLS-1 / LCL-TLS-2).
#
#    sudo ECLOUD_APPROVED_CHANGE=LCL-TLS-1 ./make-lan-tls.sh ca               # once
#    sudo ECLOUD_APPROVED_CHANGE=LCL-TLS-1 ./make-lan-tls.sh leaf <LAN-IP>    # issue / renew
#    ./make-lan-tls.sh show                                                   # read-only
#
#  - CA: ECDSA P-256, 10 years, NAME-CONSTRAINED to the LAN subnet (LAN_CA_PERMITTED_IP, default
#    192.168.203.0/255.255.255.0) and to DNS names under LAN_CA_PERMITTED_DNS (default
#    "ecloud-lan.invalid", i.e. no real DNS name), so a browser that trusts this CA trusts it
#    for nothing else even if the CA key leaked.
#  - Leaf: ECDSA P-256, 397 days, SAN IP:<LAN-IP> (+ optional DNS names inside the constraint),
#    serverAuth only.
#  - Layout (TLS_DIR, default /opt/ecloud/tls):
#      ca/ca.key          root:root 0600  (directory ca/ 0700) — NOT in the automatic backups;
#                         keep one offline copy (owner, LCL-TLS-1), e.g. age-encrypted on the Mac
#      ca/ca.crt, ecloud-lan-ca.crt  0444 — the certificate to install in admin browsers
#      edge.crt           root:root 0444
#      edge.key           root:10001 0440 (ecloud-secrets; the edge container reads it)
#  TLS_DIR / ECLOUD_TLS_OWNER_GID can be overridden for local validation (no root needed then
#  when ECLOUD_TLS_LOCAL_TEST=1).
# =============================================================================================
set -euo pipefail

TLS_DIR="${TLS_DIR:-/opt/ecloud/tls}"
GID="${ECLOUD_TLS_OWNER_GID:-10001}"
PERMITTED_IP="${LAN_CA_PERMITTED_IP:-192.168.203.0/255.255.255.0}"
PERMITTED_DNS="${LAN_CA_PERMITTED_DNS:-ecloud-lan.invalid}"
CA_DAYS="${LAN_CA_DAYS:-3650}"
LEAF_DAYS="${LAN_LEAF_DAYS:-397}"

if [ "${ECLOUD_TLS_LOCAL_TEST:-}" != 1 ] && [ "${1:-}" != show ]; then
  # shellcheck source-path=SCRIPTDIR source=../../vps/scripts/common.sh
  source "$(dirname "${BASH_SOURCE[0]}")/../../vps/scripts/common.sh"
  require_approval
fi
umask 077

chown_maybe() { [ "$(id -u)" -eq 0 ] && chown "$@" || true; }

case "${1:-}" in
  ca)
    if [ -e "$TLS_DIR/ca/ca.key" ] || [ -e "$TLS_DIR/ca/ca.crt" ]; then
      echo "refusing: a CA already exists in $TLS_DIR/ca (a new CA would invalidate every trusted browser)" >&2
      exit 3
    fi
    install -d -m 0755 "$TLS_DIR"
    install -d -m 0700 "$TLS_DIR/ca"
    cfg="$(mktemp)"
    cat >"$cfg" <<EOF
[req]
distinguished_name = dn
prompt = no
x509_extensions = v3_ca
[dn]
O = ECLOUD LAN pilot
CN = ECLOUD LAN pilot CA (vps-local)
[v3_ca]
basicConstraints = critical,CA:true,pathlen:0
keyUsage = critical,keyCertSign,cRLSign
subjectKeyIdentifier = hash
nameConstraints = critical,permitted;IP:${PERMITTED_IP},permitted;DNS:${PERMITTED_DNS}
EOF
    openssl ecparam -name prime256v1 -genkey -noout -out "$TLS_DIR/ca/ca.key"
    openssl req -new -x509 -sha256 -days "$CA_DAYS" -key "$TLS_DIR/ca/ca.key" \
      -config "$cfg" -out "$TLS_DIR/ca/ca.crt"
    rm -f "$cfg"
    chmod 0600 "$TLS_DIR/ca/ca.key"
    chmod 0444 "$TLS_DIR/ca/ca.crt"
    install -m 0444 "$TLS_DIR/ca/ca.crt" "$TLS_DIR/ecloud-lan-ca.crt"
    echo "CA created. SHA-256 fingerprint (compare when installing it in a browser):"
    openssl x509 -in "$TLS_DIR/ca/ca.crt" -noout -fingerprint -sha256
    ;;
  leaf)
    ip="${2:-}"
    [ -n "$ip" ] || { echo "usage: $0 leaf <LAN-IP> [dns-name...]" >&2; exit 2; }
    shift 2
    [ -f "$TLS_DIR/ca/ca.key" ] || { echo "no CA yet: run '$0 ca' first" >&2; exit 3; }
    san="IP:${ip}"
    for d in "$@"; do san="${san},DNS:${d}"; done
    work="$(mktemp -d)"
    cat >"$work/ext" <<EOF
basicConstraints = critical,CA:false
keyUsage = critical,digitalSignature
extendedKeyUsage = serverAuth
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid
subjectAltName = ${san}
EOF
    openssl ecparam -name prime256v1 -genkey -noout -out "$work/edge.key"
    openssl req -new -sha256 -key "$work/edge.key" -subj "/O=ECLOUD LAN pilot/CN=ECLOUD edge" \
      -out "$work/edge.csr"
    openssl x509 -req -sha256 -days "$LEAF_DAYS" -in "$work/edge.csr" \
      -CA "$TLS_DIR/ca/ca.crt" -CAkey "$TLS_DIR/ca/ca.key" -CAcreateserial \
      -CAserial "$TLS_DIR/ca/ca.srl" -extfile "$work/ext" -out "$work/edge.crt"
    openssl verify -CAfile "$TLS_DIR/ca/ca.crt" "$work/edge.crt" >/dev/null
    # Keep the previous pair for rollback.
    for f in edge.crt edge.key; do
      if [ -f "$TLS_DIR/$f" ]; then cp -p "$TLS_DIR/$f" "$TLS_DIR/$f.prev"; fi
    done
    install -m 0444 "$work/edge.crt" "$TLS_DIR/edge.crt"
    install -m 0440 "$work/edge.key" "$TLS_DIR/edge.key"
    chown_maybe "root:$GID" "$TLS_DIR/edge.key"
    rm -rf "$work"
    echo "edge certificate issued for ${san}; restart the edge: ecloud-compose restart edge"
    openssl x509 -in "$TLS_DIR/edge.crt" -noout -subject -enddate
    ;;
  show)
    for f in "$TLS_DIR/ecloud-lan-ca.crt" "$TLS_DIR/edge.crt"; do
      [ -f "$f" ] || { echo "$f: missing"; continue; }
      echo "== $f"
      openssl x509 -in "$f" -noout -subject -enddate -fingerprint -sha256 -ext subjectAltName,nameConstraints 2>/dev/null ||
        openssl x509 -in "$f" -noout -subject -enddate -fingerprint -sha256
    done
    ;;
  *)
    echo "usage: $0 ca | leaf <LAN-IP> [dns...] | show" >&2
    exit 2
    ;;
esac
