#!/usr/bin/env bash
# =============================================================================
# radius-reload-watch.sh — Host-side FreeRADIUS hot-reload watcher (vps-local)
#
# Polls Redis for the `radius:clients:reload_pending` key written by the API
# when a NAS client is created, updated, deleted, or has its secret rotated.
# When the key is present, runs reload-radius.sh to re-render clients.conf and
# restart the ecloud-freeradius container.
#
# INSTALL (run once as root/sudo). Both scripts are required: this watcher
# resolves reload-radius.sh from its own directory and refuses to run without
# it.
#   install -m 0755 infra/vps-local/scripts/reload-radius.sh      /opt/ecloud/bin/
#   install -m 0755 infra/vps-local/scripts/radius-reload-watch.sh /opt/ecloud/bin/
#   install -d -m 0755 /var/log/ecloud
#
#   # /etc/cron.d/ecloud-radius-reload  (cron.d format: the user field is required)
#   * * * * * root /opt/ecloud/bin/radius-reload-watch.sh >> /var/log/ecloud/radius-reload.log 2>&1
#
# Timing: cron fires every 60 s and the API sets the key with a 300 s TTL
# (apps/api/src/radius-clients/reload-signal.ts), so a signal cannot expire
# unseen. Worst-case lag is one cron interval plus the reload itself.
#
# Requirements:
#   - redis-cli in PATH. On Oracle Linux 8 (this host, D-041) it is provided by
#     the `redis` package: dnf install -y redis
#     (`redis-tools` is a Debian/Ubuntu package name and does not exist here.)
#   - REDIS_URL in /opt/ecloud/ecloud.env  (e.g. redis://[:<pass>@]<host>:<port>/<db>)
#   - reload-radius.sh in the same bin/ directory
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="/opt/ecloud/ecloud.env"
REDIS_KEY="radius:clients:reload_pending"
ATTEMPT_KEY="radius:clients:reload_attempts"
# Bound on consecutive failed reloads. Without it, a reload that fails every
# time (for example a restart that never comes up) is retried by cron every
# 60 s indefinitely, and each attempt restarts FreeRADIUS.
MAX_ATTEMPTS="${ECLOUD_RELOAD_MAX_ATTEMPTS:-5}"
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

if [[ -n "${REDIS_URL:-}" ]]; then
  # Strip scheme
  _url="${REDIS_URL#redis://}"
  # Extract password if present (redis://:pass@host:port/db). It goes to
  # redis-cli through REDISCLI_AUTH, never through argv: an `-a <pass>`
  # argument is readable by any local user in `ps`.
  if [[ "$_url" == *@* ]]; then
    _pass="${_url%%@*}"; _pass="${_pass#:}"
    _url="${_url#*@}"
    export REDISCLI_AUTH="$_pass"
    unset _pass
  fi
  REDIS_HOST="${_url%%:*}"
  _rest="${_url#*:}"
  REDIS_PORT="${_rest%%/*}"
fi

redis_get() {
  redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" GET "$1" 2>/dev/null || true
}

redis_del() {
  redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" DEL "$1" > /dev/null 2>&1 || true
}

# INCR plus a TTL, so a burst of failures expires rather than blocking reloads
# for ever. Prints the new count, or the empty string if Redis is unreachable.
redis_incr_attempt() {
  local n
  n="$(redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" INCR "$ATTEMPT_KEY" 2>/dev/null || true)"
  redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" EXPIRE "$ATTEMPT_KEY" 3600 > /dev/null 2>&1 || true
  printf '%s' "$n"
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

ATTEMPTS="$(redis_get "$ATTEMPT_KEY")"
if [[ -n "$ATTEMPTS" ]] && (( ATTEMPTS >= MAX_ATTEMPTS )); then
  log "ERROR: $ATTEMPTS consecutive failed reloads — not retrying."
  log "ERROR: fix the cause, run reload-radius.sh manually, then: redis-cli DEL $ATTEMPT_KEY"
  # Exit 0 so cron stops mailing every minute. The pending key is kept so the
  # reload is still visibly outstanding.
  exit 0
fi

log "Reload pending: $VALUE"
log "Running reload-radius.sh ..."

set +e
"$RELOAD_SCRIPT"
RC=$?
set -e

case "$RC" in
  0)
    log "Reload succeeded — deleting key"
    redis_del "$REDIS_KEY"
    redis_del "$ATTEMPT_KEY"
    ;;
  3)
    # reload-radius.sh exit 3: clients.conf WAS written and FreeRADIUS WAS
    # restarted, but some invalid NAS rows were skipped. The reload happened,
    # so the signal is consumed; retrying would restart FreeRADIUS every
    # minute for as long as the bad row exists, each restart a brief auth
    # outage. The skipped ids are in the output above for the operator.
    log "Reload succeeded with skipped NAS rows (exit 3) — deleting key; fix the skipped ids"
    redis_del "$REDIS_KEY"
    redis_del "$ATTEMPT_KEY"
    ;;
  *)
    N="$(redis_incr_attempt)"
    log "ERROR: reload-radius.sh exited $RC — key retained for next attempt (attempt ${N:-unknown}/$MAX_ATTEMPTS)"
    exit "$RC"
    ;;
esac
