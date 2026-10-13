#!/bin/sh
#
#  EZECLOUD FreeRADIUS entrypoint wrapper.
#
#  1. Resolves *_FILE secrets (Compose `secrets:` -> /run/secrets/<name>,
#     DEPLOYMENT_ARCHITECTURE.md §4.2) into the environment variables the
#     raddb overlay reads with $ENV{...}. Values are never printed.
#  2. Fails fast, naming only the VARIABLE, when a required value is missing
#     (FreeRADIUS silently expands an undefined $ENV{} to an empty string).
#  3. Hands over to the image's own /docker-entrypoint.sh
#     (`freeradius -f "$@"`).
#
set -eu

#  Runs a check as the service user (the container may start as root, see below).
#  Supplementary groups for freerad: its own group plus any groups granted to the container
#  (compose `group_add`, e.g. 10001 = ecloud-secrets for the 0440 secret files), never gid 0.
#  `--init-groups` would reset them to /etc/group and lose the compose grant.
freerad_groups() {
	gids="$(id -g freerad)"
	for g in $(id -G); do
		[ "$g" = "0" ] && continue
		case ",$gids," in *",$g,"*) ;; *) gids="$gids,$g" ;; esac
	done
	printf '%s' "$gids"
}

as_freerad() {
	if [ "$(id -u)" = "0" ]; then
		setpriv --reuid=freerad --regid=freerad --groups="$(freerad_groups)" "$@"
	else
		"$@"
	fi
}

file_env() {
	var="$1"
	file_var="${var}_FILE"
	eval "val=\${$var:-}"
	eval "fval=\${$file_var:-}"
	if [ -n "$val" ] && [ -n "$fval" ]; then
		echo "freeradius: both $var and $file_var are set; use one" >&2
		exit 1
	fi
	if [ -n "$fval" ]; then
		if [ ! -r "$fval" ]; then
			echo "freeradius: $file_var points to an unreadable file" >&2
			exit 1
		fi
		val=$(cat "$fval")
		export "$var=$val"
	fi
}

for v in RADIUS_SQL_PASSWORD RADIUS_STATUS_SECRET RADIUS_DEV_CLIENT_SECRET INTERNAL_API_TOKEN RADIUS_EAP_KEY_PASSWORD; do
	file_env "$v"
done

#  HERMES_AAA_AUDIT.md F-009 (accepted, D-049): the secrets resolved above stay in this
#  process environment for the lifetime of radiusd, because FreeRADIUS expands $ENV{} at
#  config-parse time inside its own process -- nothing outside it can clear them afterwards.
#  Exposure is limited to processes of the same UID in this container: the service runs
#  read_only with ALL capabilities dropped, no-new-privileges, a single process, and no other
#  container shares its PID namespace or /proc. PGPASSWORD is the exception and IS unset after
#  the schema check below. Revisit if this container ever runs a second process or a shell.

#  Non-secret defaults.
export RADIUS_LISTEN_IP="${RADIUS_LISTEN_IP:-*}"
export RADIUS_SQL_PORT="${RADIUS_SQL_PORT:-5432}"

#  Required. RADIUS_DEV_CLIENT_* are only read by the dev clients.conf; a
#  production deployment mounts a rendered clients.conf over it and sets
#  RADIUS_CLIENTS_RENDERED=1 to skip that check.
required="RADIUS_STATUS_SECRET RADIUS_SQL_HOST RADIUS_SQL_DB RADIUS_SQL_USER RADIUS_SQL_PASSWORD ECLOUD_INTERNAL_URL INTERNAL_API_TOKEN"
if [ -z "${RADIUS_CLIENTS_RENDERED:-}" ]; then
	required="$required RADIUS_DEV_CLIENT_CIDR RADIUS_DEV_CLIENT_SECRET"
fi
missing=""
for v in $required; do
	eval "val=\${$v:-}"
	[ -n "$val" ] || missing="$missing $v"
done
if [ -n "$missing" ]; then
	echo "freeradius: required environment variable(s) not set:$missing" >&2
	exit 1
fi

#  Credential transport (HERMES_AAA_AUDIT.md F-002). rlm_rest POSTs the whole RADIUS
#  request to /internal/aaa/authorize, User-Password included. Cleartext HTTP is allowed
#  only for the dev stack (loopback / host.docker.internal); a production deployment --
#  identified by RADIUS_CLIENTS_RENDERED, the same indicator the rendered-clients check
#  below uses -- must use https, and must pin the EZECLOUD-issued CA, because
#  check_cert = yes against the system trust store would not trust that CA anyway.
case "${ECLOUD_INTERNAL_URL:-}" in
https://*)
	if [ -z "${RADIUS_INTERNAL_CA_FILE:-}" ]; then
		echo "freeradius: ECLOUD_INTERNAL_URL is https but RADIUS_INTERNAL_CA_FILE is not set; the internal CA must be pinned" >&2
		exit 1
	fi
	if ! as_freerad test -r "$RADIUS_INTERNAL_CA_FILE"; then
		echo "freeradius: RADIUS_INTERNAL_CA_FILE=$RADIUS_INTERNAL_CA_FILE is missing or unreadable by freerad" >&2
		exit 1
	fi
	#  Activate the pin in the shipped module config, which ships it commented out so the
	#  dev stack (plain http) starts without a CA file present.
	rest_mod=/etc/freeradius/mods-available/rest
	if ! grep -q '^[[:space:]]*ca_file[[:space:]]*=' "$rest_mod"; then
		sed -i "s|^\([[:space:]]*\)#[[:space:]]*ca_file = .*|\1ca_file = ${RADIUS_INTERNAL_CA_FILE}|" "$rest_mod"
	fi
	if ! grep -q "^[[:space:]]*ca_file = ${RADIUS_INTERNAL_CA_FILE}\$" "$rest_mod"; then
		echo "freeradius: failed to activate ca_file in $rest_mod" >&2
		exit 1
	fi
	;;
*)
	if [ -n "${RADIUS_CLIENTS_RENDERED:-}" ]; then
		#  The pilot stack runs api and freeradius on one host's private compose network and
		#  predates this check, so refusing outright would stop an already-deployed stack from
		#  restarting. The operator must therefore acknowledge the cleartext leg explicitly;
		#  there is no silent default either way.
		if [ "${ECLOUD_INTERNAL_CLEARTEXT_ACK:-}" != "1" ]; then
			echo "freeradius: ECLOUD_INTERNAL_URL is not https:// in a production deployment (RADIUS_CLIENTS_RENDERED is set); rlm_rest would send User-Password in cleartext." >&2
			echo "freeradius: issue an internal certificate and set ECLOUD_INTERNAL_URL=https://..., or set ECLOUD_INTERNAL_CLEARTEXT_ACK=1 to accept the risk on a private network." >&2
			exit 1
		fi
		echo "freeradius: WARNING - rlm_rest is sending User-Password over cleartext $ECLOUD_INTERNAL_URL (ECLOUD_INTERNAL_CLEARTEXT_ACK=1). HERMES_AAA_AUDIT.md F-002." >&2
	fi
	;;
esac

#  Rendered clients (docs/SECURITY_REVIEW_P10.md F-P10-07): fail closed unless the
#  rendered-clients volume is really mounted over clients.d/ (the image's dev client
#  is then hidden) and holds a non-empty rendered file with at least one client.
#  An empty directory would start a server that silently ignores every NAS.
if [ -n "${RADIUS_CLIENTS_RENDERED:-}" ]; then
	clients_dir=/etc/freeradius/clients.d
	rendered="$clients_dir/${RADIUS_CLIENTS_RENDERED_FILE:-ecloud-nas.conf}"
	if as_freerad test -e "$clients_dir/dev.conf"; then
		echo "freeradius: RADIUS_CLIENTS_RENDERED is set but $clients_dir/dev.conf is visible; mount the rendered-clients volume over $clients_dir" >&2
		exit 1
	fi
	#  As freerad: with ALL capabilities dropped, root cannot even search the 2750 node:101
	#  rendered-clients directory (no CAP_DAC_READ_SEARCH); freerad reads it through gid 101.
	if ! as_freerad test -s "$rendered" || ! as_freerad test -r "$rendered"; then
		echo "freeradius: rendered clients file $rendered is missing, empty or unreadable; run the radius-clients renderer first" >&2
		exit 1
	fi
	if ! as_freerad grep -q '^client nas-' "$rendered"; then
		echo "freeradius: rendered clients file $rendered defines no client" >&2
		exit 1
	fi
fi

#  802.1X / EAP-TTLS (Cycle A, D-044): opt-in. The EZECLOUD eap module and the
#  ecloud-inner site are linked only when RADIUS_EAP_ENABLED=1 AND the mounted
#  certificate set is readable BY freerad; otherwise they are unlinked (a
#  restarted container keeps its filesystem) and every EAP-Message is rejected
#  by the outer server. Linking happens here as root (mods-enabled/ and
#  sites-enabled/ are root-owned); privileges are dropped below. Certificates
#  are never in the image (production: REQUIRES_CLARIFICATION; dev:
#  scripts/dev-eap-certs.sh).
raddb=/etc/freeradius
export RADIUS_EAP_CERT_DIR="${RADIUS_EAP_CERT_DIR:-$raddb/eap-certs}"
export RADIUS_EAP_KEY_PASSWORD="${RADIUS_EAP_KEY_PASSWORD:-}"
eap_linked() {
	[ -L "$raddb/mods-enabled/eap" ] && [ -L "$raddb/sites-enabled/ecloud-inner" ]
}
if [ "${RADIUS_EAP_ENABLED:-}" = "1" ]; then
	for f in server.pem server.key ca.pem; do
		if ! as_freerad test -r "$RADIUS_EAP_CERT_DIR/$f"; then
			echo "freeradius: RADIUS_EAP_ENABLED=1 but $RADIUS_EAP_CERT_DIR/$f is missing or unreadable by freerad" >&2
			exit 1
		fi
	done
	if [ "$(id -u)" = "0" ]; then
		ln -sfn ../mods-available/eap "$raddb/mods-enabled/eap"
		ln -sfn ../sites-available/ecloud-inner "$raddb/sites-enabled/ecloud-inner"
	elif ! eap_linked; then
		echo "freeradius: RADIUS_EAP_ENABLED=1 needs the container to start as root (it links the EAP configuration, then drops to freerad)" >&2
		exit 1
	else
		#  HERMES_AAA_AUDIT.md F-008: this is the unprivileged second pass, after the privilege
		#  drop. Root created these links; confirm they still point where it put them before
		#  FreeRADIUS parses them, so a write between the two passes cannot swap in another
		#  module or virtual server. Not reachable in the pilot (read_only root filesystem), but
		#  the dev compose has a writable raddb.
		for _pair in "mods-enabled/eap ../mods-available/eap" \
			"sites-enabled/ecloud-inner ../sites-available/ecloud-inner"; do
			_link="${_pair%% *}"
			_want="${_pair#* }"
			_got="$(readlink "$raddb/$_link" 2>/dev/null || true)"
			if [ "$_got" != "$_want" ]; then
				echo "freeradius: $_link points at '$_got', expected '$_want' (EAP configuration tampered between privilege drop and parse)" >&2
				exit 1
			fi
		done
		unset _pair _link _want _got
	fi
elif [ "$(id -u)" = "0" ]; then
	rm -f "$raddb/mods-enabled/eap" "$raddb/sites-enabled/ecloud-inner"
elif eap_linked; then
	echo "freeradius: EAP configuration is linked but RADIUS_EAP_ENABLED is not 1; start the container as root to unlink it" >&2
	exit 1
fi

#  Schema check (Cycle E review F4): queries.conf writes
#  radius.radacct_raw.packet_client_shortname (migration 032). Started against an older schema,
#  every accounting INSERT would fail. Refuse to start until the column exists. Waits up to
#  RADIUS_SCHEMA_WAIT_S (default 60) for the database / the migrate job; RADIUS_SCHEMA_CHECK=0
#  skips the check (only for a throw-away configuration test without a database).
if [ "${RADIUS_SCHEMA_CHECK:-1}" != "0" ]; then
	wait_s="${RADIUS_SCHEMA_WAIT_S:-60}"
	case "$wait_s" in ''|*[!0-9]*) echo "freeradius: RADIUS_SCHEMA_WAIT_S must be a number of seconds" >&2; exit 1 ;; esac
	schema_query="SELECT count(*) FROM information_schema.columns WHERE table_schema = 'radius' AND table_name = 'radacct_raw' AND column_name = 'packet_client_shortname'"
	found=""
	reachable=""
	waited=0
	#  libpq reads the password from the environment (never on argv).
	PGPASSWORD="$RADIUS_SQL_PASSWORD" # check-no-secrets: allow (environment reference, not a value)
	export PGPASSWORD
	while :; do
		if out=$(PGCONNECT_TIMEOUT=5 psql -X -A -t -q \
			-h "$RADIUS_SQL_HOST" -p "$RADIUS_SQL_PORT" -U "$RADIUS_SQL_USER" -d "$RADIUS_SQL_DB" \
			-c "$schema_query" 2>/dev/null); then
			reachable=1
			if [ "$(echo "$out" | tr -d '[:space:]')" = "1" ]; then found=1; break; fi
		fi
		[ "$waited" -ge "$wait_s" ] && break
		sleep 2
		waited=$((waited + 2))
	done
	unset PGPASSWORD
	if [ -z "$found" ]; then
		if [ -n "$reachable" ]; then
			echo "freeradius: database schema is too old: radius.radacct_raw.packet_client_shortname is missing. Apply migration 032 (npm run db:migrate / the migrate job) BEFORE starting this FreeRADIUS image." >&2
		else
			echo "freeradius: cannot verify the database schema (no connection to $RADIUS_SQL_HOST:$RADIUS_SQL_PORT/$RADIUS_SQL_DB within ${wait_s}s)" >&2
		fi
		exit 1
	fi
fi

#  The token is embedded in the configuration as $ENV{INTERNAL_API_TOKEN}, expanded at
#  config-parse time, so `$` matters as much as the xlat characters: a token containing
#  $ENV{OTHER_SECRET} would expand that secret into an outgoing HTTP header
#  (HERMES_AAA_AUDIT.md F-003). loadConfig enforces the same alphabet for every caller; this
#  check stays as defence in depth for a FreeRADIUS started without the API.
case "$INTERNAL_API_TOKEN" in
	*[%\"\\$]*)
		echo "freeradius: INTERNAL_API_TOKEN must not contain %, \", \\ or \$ (it is embedded in the configuration and expanded at parse time)" >&2
		exit 1 ;;
esac

#  Drop root before anything parses configuration or opens a socket.
if [ "$(id -u)" = "0" ]; then
	#  Needs CAP_SETUID, CAP_SETGID and CAP_SETPCAP (bounding-set clear); the hardened compose
	#  services drop ALL capabilities, so the freeradius service adds exactly these three.
	exec setpriv --reuid=freerad --regid=freerad --groups="$(freerad_groups)" --no-new-privs \
		--bounding-set=-all /docker-entrypoint.sh "$@"
fi
exec /docker-entrypoint.sh "$@"
