#!/usr/bin/env bash
# Shared guard for infra/vps/scripts/apply-*.sh (sourced). DRAFT — these scripts are authored
# for the owner-approved VPS change (D-031) and have NOT been run on any host.
set -euo pipefail

require_approval() {
  if [ -z "${ECLOUD_APPROVED_CHANGE:-}" ]; then
    echo "refusing: set ECLOUD_APPROVED_CHANGE=<change id from docs/VPS_CHANGE_LIST.md> (D-031 gate)" >&2
    exit 3
  fi
  if [ "$(id -u)" -ne 0 ]; then
    echo "refusing: run with sudo on the target host" >&2
    exit 3
  fi
}

# deadman_arm <unit> <seconds> <command...>: run <command> after <seconds> unless disarmed.
# Uses a transient systemd timer (no `at` dependency; Ubuntu 24.04 ships systemd-run).
deadman_arm() {
  local unit="$1" seconds="$2"
  shift 2
  systemctl stop "$unit.timer" 2>/dev/null || true
  systemd-run --unit="$unit" --on-active="$seconds" --timer-property=AccuracySec=1s "$@"
  echo "dead-man armed: '$*' runs in ${seconds}s unless you disarm it ($unit.timer)"
}

deadman_disarm() {
  systemctl stop "$1.timer"
  echo "dead-man disarmed ($1)"
}
