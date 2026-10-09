#!/bin/sh
#
#  ECLOUD FreeRADIUS entrypoint wrapper.
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

for v in RADIUS_SQL_PASSWORD RADIUS_STATUS_SECRET RADIUS_DEV_CLIENT_SECRET INTERNAL_API_TOKEN; do
	file_env "$v"
done

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

#  Rendered clients (docs/SECURITY_REVIEW_P10.md F-P10-07): fail closed unless the
#  rendered-clients volume is really mounted over clients.d/ (the image's dev client
#  is then hidden) and holds a non-empty rendered file with at least one client.
#  An empty directory would start a server that silently ignores every NAS.
if [ -n "${RADIUS_CLIENTS_RENDERED:-}" ]; then
	clients_dir=/etc/freeradius/clients.d
	rendered="$clients_dir/${RADIUS_CLIENTS_RENDERED_FILE:-ecloud-nas.conf}"
	if [ -e "$clients_dir/dev.conf" ]; then
		echo "freeradius: RADIUS_CLIENTS_RENDERED is set but $clients_dir/dev.conf is visible; mount the rendered-clients volume over $clients_dir" >&2
		exit 1
	fi
	if [ ! -s "$rendered" ] || [ ! -r "$rendered" ]; then
		echo "freeradius: rendered clients file $rendered is missing, empty or unreadable; run the radius-clients renderer first" >&2
		exit 1
	fi
	if ! grep -q '^client nas-' "$rendered"; then
		echo "freeradius: rendered clients file $rendered defines no client" >&2
		exit 1
	fi
fi

case "$INTERNAL_API_TOKEN" in
	*[%\"\\]*)
		echo "freeradius: INTERNAL_API_TOKEN must not contain %, \" or \\ (it is embedded in an xlat string)" >&2
		exit 1 ;;
esac

exec /docker-entrypoint.sh "$@"
