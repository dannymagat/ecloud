#!/usr/bin/env bash
# Dev-only EAP-TTLS certificate set for the ECLOUD FreeRADIUS container (Cycle A, D-044).
#
#   bash scripts/dev-eap-certs.sh [out-dir]     # default: var/freeradius-eap-certs (gitignored)
#
# Writes ca.pem + server.pem + server.key (a throw-away CA and a server certificate it signed,
# valid 30 days). LOCAL DEVELOPMENT ONLY: never commit the output, never use it on a server.
# The production EAP certificate / CA is REQUIRES_CLARIFICATION (issuer, client distribution).
#
# Use with the dev stack (infra/freeradius/README.md "802.1X / EAP"):
#   RADIUS_EAP_ENABLED=1 and the directory mounted read-only at /etc/freeradius/eap-certs.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${1:-$ROOT/var/freeradius-eap-certs}"
case "$OUT" in
  "$ROOT"/var/*|/tmp/*|/private/tmp/*) ;;
  *) echo "dev-eap-certs: refusing to write outside var/ or /tmp: $OUT" >&2; exit 2 ;;
esac
mkdir -p "$OUT"
umask 077
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

openssl req -x509 -newkey rsa:2048 -nodes -days 30 -subj "/CN=ECLOUD dev EAP CA" \
  -keyout "$tmp/ca.key" -out "$OUT/ca.pem" 2>/dev/null
openssl req -newkey rsa:2048 -nodes -subj "/CN=radius.ecloud.invalid" \
  -keyout "$OUT/server.key" -out "$tmp/server.csr" 2>/dev/null
printf 'extendedKeyUsage=serverAuth\nsubjectAltName=DNS:radius.ecloud.invalid\n' >"$tmp/ext.cnf"
openssl x509 -req -in "$tmp/server.csr" -CA "$OUT/ca.pem" -CAkey "$tmp/ca.key" \
  -CAcreateserial -CAserial "$tmp/ca.srl" -days 30 -extfile "$tmp/ext.cnf" -out "$OUT/server.pem" 2>/dev/null
# The CA key is discarded (tmp): this set can never sign anything else.
chmod 0644 "$OUT/ca.pem" "$OUT/server.pem"
chmod 0640 "$OUT/server.key"
echo "dev-eap-certs: wrote ca.pem, server.pem, server.key to $OUT (dev only, 30 days)"
