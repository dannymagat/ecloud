#!/usr/bin/env bash
# EZECLOUD RadSec CA (RFC 6614; AAA_IMPLEMENTATION_PLAN.md Phase 3A, migration 034).
#
#   bash scripts/radsec-ca.sh init   <ca-dir>                 # create the RadSec CA
#   bash scripts/radsec-ca.sh server <ca-dir> <out-dir> <dns-name>
#                                                            # FreeRADIUS server cert set
#   bash scripts/radsec-ca.sh issue  <ca-dir> <out-dir> <nas-id>
#                                                            # client cert for one NAS
#
# The CA is DEDICATED to RadSec: every certificate it signs passes the FreeRADIUS handshake
# (sites-available/ecloud-radsec), so it must never sign anything else, and the EAP CA or a
# public CA must never be used in its place.
#
# `issue` writes a certificate whose CN is the NAS id (nas_clients.id) with a random 128-bit
# serial, and prints that serial. The NAS is accepted only once its row is enrolled with exactly
# that serial (radsec_enabled = true, radsec_cert_serial = <serial>); issuing again for the same
# NAS and enrolling the new serial retires the previous certificate at once (no CRL is used).
#
# Where the CA directory lives in production, and who may run `issue`, is
# REQUIRES_CLARIFICATION. ca.key is the key to every RadSec NAS identity: keep it offline,
# never on the RADIUS host, never in the repository (inside the repository only var/ is allowed,
# which is gitignored).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CA_DAYS=3650
LEAF_DAYS=825

die() { echo "radsec-ca: $*" >&2; exit 2; }

# Refuse to write key material into the tracked tree.
check_dir() {
  local d
  d="$(cd "$(dirname "$1")" 2>/dev/null && pwd)/$(basename "$1")" || die "no such parent: $1"
  case "$d" in
    "$ROOT"/var/*) ;;
    "$ROOT"|"$ROOT"/*) die "refusing to write inside the repository outside var/: $1" ;;
  esac
}

need_ca() {
  [ -r "$1/ca.pem" ] && [ -r "$1/ca.key" ] || die "$1 holds no RadSec CA (run: init $1)"
}

random_serial() {
  # 128 random bits with the top bit cleared: a positive ASN.1 INTEGER of at most 16 octets.
  local hex
  hex="$(openssl rand -hex 16)"
  printf '%x%s' "$(( 0x${hex:0:1} & 7 ))" "${hex:1}"
}

# Canonical form used by packages/shared/src/radsec.ts: lowercase hex, no leading zeros.
cert_serial() {
  openssl x509 -noout -serial -in "$1" | sed 's/^serial=//' | tr 'A-F' 'a-f' | sed 's/^0*//; s/^$/0/'
}

sign() { # <ca-dir> <csr> <ext-file> <out-pem>
  openssl x509 -req -in "$2" -CA "$1/ca.pem" -CAkey "$1/ca.key" \
    -set_serial "0x$(random_serial)" -days "$LEAF_DAYS" -sha256 -extfile "$3" -out "$4" 2>/dev/null
}

cmd="${1:-}"
case "$cmd" in
  init)
    [ $# -eq 2 ] || die "usage: init <ca-dir>"
    check_dir "$2"
    [ -e "$2/ca.key" ] && die "$2/ca.key already exists; refusing to replace a CA"
    mkdir -p "$2"
    umask 077
    openssl req -x509 -newkey rsa:4096 -nodes -sha256 -days "$CA_DAYS" \
      -subj "/O=EZECLOUD/CN=EZECLOUD RadSec CA" \
      -addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
      -addext "keyUsage=critical,keyCertSign,cRLSign" \
      -keyout "$2/ca.key" -out "$2/ca.pem" 2>/dev/null
    chmod 0600 "$2/ca.key"
    chmod 0644 "$2/ca.pem"
    echo "radsec-ca: created $2/ca.pem and $2/ca.key (keep ca.key offline)"
    ;;
  server)
    [ $# -eq 4 ] || die "usage: server <ca-dir> <out-dir> <dns-name>"
    need_ca "$2"
    check_dir "$3"
    [[ "$4" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]] || die "not a DNS name: $4"
    mkdir -p "$3"
    umask 077
    tmp="$(mktemp -d)"
    trap 'rm -rf "$tmp"' EXIT
    openssl req -newkey rsa:2048 -nodes -subj "/O=EZECLOUD/CN=$4" \
      -keyout "$3/server.key" -out "$tmp/server.csr" 2>/dev/null
    printf 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:%s\n' "$4" >"$tmp/ext.cnf"
    sign "$2" "$tmp/server.csr" "$tmp/ext.cnf" "$3/server.pem"
    cp "$2/ca.pem" "$3/ca.pem"
    chmod 0644 "$3/ca.pem" "$3/server.pem"
    chmod 0640 "$3/server.key"
    echo "radsec-ca: wrote server.pem, server.key, ca.pem to $3 (mount at RADIUS_RADSEC_CERT_DIR)"
    ;;
  issue)
    [ $# -eq 4 ] || die "usage: issue <ca-dir> <out-dir> <nas-id>"
    need_ca "$2"
    check_dir "$3"
    nas="$(printf '%s' "$4" | tr 'A-F' 'a-f')"
    [[ "$nas" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] \
      || die "the NAS id must be a nas_clients.id UUID: $4"
    mkdir -p "$3"
    umask 077
    tmp="$(mktemp -d)"
    trap 'rm -rf "$tmp"' EXIT
    openssl req -newkey rsa:2048 -nodes -subj "/O=EZECLOUD/CN=$nas" \
      -keyout "$3/nas-$nas.key" -out "$tmp/nas.csr" 2>/dev/null
    printf 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=clientAuth\n' >"$tmp/ext.cnf"
    sign "$2" "$tmp/nas.csr" "$tmp/ext.cnf" "$3/nas-$nas.pem"
    cp "$2/ca.pem" "$3/ca.pem"
    chmod 0644 "$3/nas-$nas.pem" "$3/ca.pem"
    chmod 0600 "$3/nas-$nas.key"
    serial="$(cert_serial "$3/nas-$nas.pem")"
    echo "radsec-ca: wrote nas-$nas.pem, nas-$nas.key, ca.pem to $3"
    echo "radsec-ca: NAS $nas certificate serial: $serial"
    echo "radsec-ca: the NAS is accepted only after its row is enrolled with this serial"
    echo "           (nas_clients.radsec_enabled = true, radsec_cert_serial = '$serial')"
    ;;
  *)
    die "usage: radsec-ca.sh init|server|issue ... (see the header of this script)"
    ;;
esac
