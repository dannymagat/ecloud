#!/usr/bin/env bash
# D-030 Caddy change procedure (DRAFT, NOT RUN): back up -> preserve existing sites -> validate
# -> reload (never restart) -> verify existing sites. DEPLOYMENT_ARCHITECTURE.md §3.3.
#
#   sudo ECLOUD_APPROVED_CHANGE=VPS-CADDY-1 ./apply-caddy.sh apply
#   sudo ECLOUD_APPROVED_CHANGE=VPS-CADDY-1 ./apply-caddy.sh rollback <backup file>
#
# Precondition (D-029): DNS for ecloud./api./portal.ezecloud.ezelink.ai already points at the VPS
# (DNS-only), otherwise ACME for the new names fails and retries (q-mira.com keeps serving).
set -euo pipefail
# shellcheck source-path=SCRIPTDIR source=common.sh
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
require_approval

SITE_SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/../caddy/sites" && pwd)/ezecloud.caddy"
LIVE=/etc/caddy/Caddyfile
SITE_LIVE=/etc/caddy/sites/ezecloud.caddy
IMPORT_LINE='import /etc/caddy/sites/*.caddy'
LOG_DIR=/var/log/caddy

verify_existing() {
  curl -fsS -o /dev/null -w 'q-mira.com %{http_code}\n' https://q-mira.com/
}

# Validate AS THE SERVICE USER (F-P10R-1): `caddy validate` provisions log writers, so running it
# as root would create root-owned 0600 access logs that the caddy service then cannot open on
# reload. Any log file still not owned by caddy afterwards is fixed up explicitly.
validate_as_caddy() {
  runuser -u caddy -- caddy validate --config "$1" --adapter caddyfile
}
fix_log_ownership() {
  find "$LOG_DIR" -maxdepth 1 -type f ! -user caddy -exec chown caddy:caddy {} + 2>/dev/null || true
}

# Restore the previous Caddyfile, drop the ECLOUD site, reload, re-verify. Used by `rollback` and
# automatically when the post-swap reload/verify fails, so a broken config is never left live
# (D-030) - not even one that only bites at the next restart.
restore() {
  local backup="$1"
  cp -a "$backup" "$LIVE"
  rm -f "$SITE_LIVE"
  validate_as_caddy "$LIVE"
  fix_log_ownership
  systemctl reload caddy
  sleep 3
  systemctl is-active caddy
  verify_existing
}

case "${1:-}" in
  apply)
    verify_existing
    backup="$LIVE.bak.$(date +%F-%H%M%S)"
    cp -a "$LIVE" "$backup"
    install -d -m 0755 /etc/caddy/sites
    install -d -o caddy -g caddy -m 0750 "$LOG_DIR"
    install -m 0644 "$SITE_SRC" "$SITE_LIVE"
    staged="$(mktemp /etc/caddy/Caddyfile.new.XXXXXX)"
    cp -a "$LIVE" "$staged"
    chmod 0644 "$staged"
    # Existing site blocks stay byte-for-byte; only the import line is appended (once).
    grep -qxF "$IMPORT_LINE" "$staged" || printf '\n%s\n' "$IMPORT_LINE" >>"$staged"
    if ! validate_as_caddy "$staged"; then
      rm -f "$staged" "$SITE_LIVE"
      fix_log_ownership
      echo "validation failed; live config untouched" >&2
      exit 1
    fi
    fix_log_ownership
    diff -u "$LIVE" "$staged" || true
    mv -f "$staged" "$LIVE"
    # From here on any failure restores the backup instead of exiting with the new file live.
    if ! { systemctl reload caddy && sleep 3 && systemctl is-active caddy && verify_existing; }; then
      echo "reload/verify FAILED - restoring $backup" >&2
      restore "$backup"
      echo "restored previous Caddyfile; ECLOUD site NOT applied" >&2
      exit 1
    fi
    echo "applied; backup: $backup"
    ;;
  rollback)
    [ -f "${2:-}" ] || { echo "usage: $0 rollback <backup file>" >&2; exit 2; }
    restore "$2"
    ;;
  *)
    sed -n '2,10p' "${BASH_SOURCE[0]}"
    exit 2
    ;;
esac
