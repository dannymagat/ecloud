#!/usr/bin/env bash
# =============================================================================
# radius-reload-watch.sh — Host-side FreeRADIUS hot-reload watcher (vps-local)
#
# Polls Redis for the `radius:clients:reload_pending` key written by the API
# when a NAS client is created, updated, deleted, or has its secret rotated.
# When the key is present, runs reload-radius.sh to re-render clients.conf and
# restart the ecloud-freeradius container.
#
# INSTALL (run once as root/sudo):
#   cp infra/vps-local/scripts/radius-reload-watch.sh /opt/ecloud/bin/
#   chmod +x /opt/ecloud/bin/radius-reload-watch.sh
#
#   # /etc/cron.d/ecloud-radius-reload
#   * * * * * root /opt/ecloud/bin/radius-reload-watch.sh >> /var/log/ecloud/radius-reload.log 2>&1
#
# The cron runs every minute; combined with the 30-s Redis TTL the worst-case
# lag is ~90 s (key written just after a cron tick, watcher fires 60 s later,
# reload-radius.sh takes ~30 s).  This is acceptable for NAS provisioning.
#
# Requirements:
#   - redis-cli in PATH (sudo apt-get install redis-tools)
#   - REDIS_URL in /opt/ecloud/ecloud.env  (e.g. redis://127.0.0.1:6379/0)
#   - reload-radius.sh in the same bin/ directory
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="/opt/ecloud/ecloud.env"
REDIS_KEY="radius:clients:reload_pending"
LOG_TAG="radius-reload-watch"

log() { echo "$(date -u +%FT%TZ) [$LOG_TAG] $*"; }

# Load env (REDIS_URL, etc.) if available
if [[ -f "$ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  set -a; source "$ENV_FILE"; set +a
fi

# Derive redis-cli args from REDIS_URL (redis://[:<pass>@]<host>:<port>/<db>)
REDIS_HOST="${REDIS_HOST:-127.0.0.1}"
REDIS_PORT="${REDIS_PORT:-6379}"
REDIS_AUTH_ARGS=()

if [[ -n "${REDIS_URL:-}" ]]; then
  # Strip scheme
  _url="${REDIS_URL#redis://}"
  # Extract password if present (redis://:pass@host:port/db)
  if [[ "$_url" == *@* ]]; then
    _pass="${_url%%@*}"; _pass="${_pass#:}"
    _url="${_url#*@}"
    REDIS_AUTH_ARGS=("-a" "$_pass" "--no-auth-warning")
  fi
  REDIS_HOST="${_url%%:*}"
  _rest="${_url#*:}"
  REDIS_PORT="${_rest%%/*}"
fi

redis_get() {
  redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" "${REDIS_AUTH_ARGS[@]}" GET "$1" 2>/dev/null || true
}

redis_del() {
  redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" "${REDIS_AUTH_ARGS[@]}" DEL "$1" > /dev/null 2>&1 || true
}

RELOAD_SCRIPT="$SCRIPT_DIR/reload-radius.sh"
if [[ ! -x "$RELOAD_SCRIPT" ]]; then
  log "ERROR: reload-radius.sh not found or not executable at $RELOAD_SCRIPT"
  exit 1
fi

VALUE="$(redis_get "$REDIS_KEY")"

if [[ -z "$VALUE" ]]; then
  # No reload pending — normal case, exit silently.
  exit 0
fi

log "Reload pending: $VALUE"
log "Running reload-radius.sh ..."

if "$RELOAD_SCRIPT"; then
  log "Reload succeeded — deleting key"
  redis_del "$REDIS_KEY"
else
  RC=$?
  log "ERROR: reload-radius.sh exited $RC — key retained for next attempt"
  exit $RC
fi
