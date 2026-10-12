#!/usr/bin/env bash
# Re-render the FreeRADIUS NAS allow-list and restart freeradius. Operator step after ANY
# NAS change (create, IP change, rotate-secret, disable); docs/VPS_LOCAL_CHANGE_LIST.md
# LCL-RADIUS-1. FreeRADIUS reads clients only at start-up (SIGHUP does not reload them).
#
#   ssh -t vps-local 'sudo /opt/ecloud/infra/vps-local/scripts/reload-radius.sh'
#
# radius-clients exit codes (apps/api radius-clients-cli):
#   0  file written                                   -> restart freeradius
#   3  file written, some invalid NAS rows skipped    -> restart freeradius, print the skipped ids,
#                                                        exit 3 so the operator fixes those NAS
#   1/2 or anything else: nothing written (e.g. zero NAS, DB down, undecryptable secret)
#                                                     -> do NOT restart; the old file stays; exit 1
#
# This script's own exit codes (radius-reload-watch.sh depends on them):
#   0  re-rendered and restarted
#   3  re-rendered and restarted, some invalid NAS rows skipped (reload DID happen)
#   4  refused to run: not root
#   1  nothing written, freeradius NOT restarted
# Exit 3 must keep meaning "the reload happened": the watcher consumes the
# pending signal on 3, and treating it as a failure would restart FreeRADIUS
# once a minute for as long as one bad NAS row exists.
set -uo pipefail
# Exit 4, not 3: exit 3 means "reloaded, with skipped rows" to the watcher.
[ "$(id -u)" -eq 0 ] || { echo "run with sudo" >&2; exit 4; }
ECC="${ECC:-/opt/ecloud/bin/ecloud-compose}"

out="$("$ECC" --profile radius run --rm -T radius-clients 2>&1)"
rc=$?
echo "$out"
case "$rc" in
  0 | 3)
    "$ECC" --profile radius restart freeradius || { echo "freeradius restart FAILED" >&2; exit 1; }
    if [ "$rc" -eq 3 ]; then
      echo "WARNING: some NAS rows were skipped (invalid); see the skipped ids in the JSON above." >&2
      exit 3
    fi
    echo "clients re-rendered and freeradius restarted"
    ;;
  *)
    echo "radius-clients exited $rc: nothing was written, freeradius NOT restarted (old clients stay)" >&2
    exit 1
    ;;
esac
