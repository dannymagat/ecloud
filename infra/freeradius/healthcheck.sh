#!/bin/sh
#
#  Container health: Status-Server request to the loopback status listener
#  (sites-enabled/status, AAA_ARCHITECTURE.md §9). Exit 0 only when
#  FreeRADIUS answers Access-Accept. The secret comes from
#  RADIUS_STATUS_SECRET_FILE (preferred: radclient -S reads the file, nothing
#  on the command line) or RADIUS_STATUS_SECRET; it is never baked in.
#
set -eu

if [ -n "${RADIUS_STATUS_SECRET_FILE:-}" ]; then
	echo "Message-Authenticator = 0x00" | exec radclient -q -r 1 -t 3 -S "$RADIUS_STATUS_SECRET_FILE" 127.0.0.1:18121 status
fi

: "${RADIUS_STATUS_SECRET:?RADIUS_STATUS_SECRET or RADIUS_STATUS_SECRET_FILE must be set}"
echo "Message-Authenticator = 0x00" | exec radclient -q -r 1 -t 3 127.0.0.1:18121 status "$RADIUS_STATUS_SECRET"
