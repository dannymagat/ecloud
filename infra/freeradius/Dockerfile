# syntax=docker/dockerfile:1
#
#  ECLOUD FreeRADIUS -- AAA_ARCHITECTURE.md §9 "FreeRADIUS container design".
#
#  Base: official image, pinned by tag AND digest (P10-A); OS packages upgraded at build
#  time (the pinned base carried fixable OpenSSL CVEs, docs/SECURITY_REVIEW_P10.md).
#  Facts verified on this image (2026-10-07): Ubuntu 22.04, radiusd 3.2.10,
#  /etc/raddb -> /etc/freeradius owned by freerad:freerad, /var/log/freeradius
#  and /var/run/freeradius owned by freerad, radclient at /usr/bin/radclient,
#  entrypoint `freeradius -f "$@"`.
#
#  Secrets: NONE in this image. Everything sensitive is read at start-up
#  from the environment or *_FILE (docker-entrypoint.sh). The build-time
#  `freeradius -C` syntax check below runs with throw-away placeholder
#  values that are not persisted in any layer (plain RUN env, no ENV).
#
FROM freeradius/freeradius-server:3.2.10@sha256:cc7fd136e7b03e7b332d94297530318e824a4ecfedbce54562cced723e71e812

RUN apt-get update \
 && apt-get upgrade -y --no-install-recommends \
 && rm -rf /var/lib/apt/lists/*

ARG RADDB=/etc/freeradius

#  1. Remove what ECLOUD does not run: the stock `default` and
#     `inner-tunnel` virtual servers (replaced by `ecloud`) and the stock
#     `eap` module (its test certificates in /etc/freeradius/certs are
#     expired, root-only and never used). 802.1X (Cycle A) uses ECLOUD's own
#     mods-available/eap + sites-available/ecloud-inner, linked in at start-up
#     by the entrypoint only with RADIUS_EAP_ENABLED=1 and mounted certs.
RUN rm -f "${RADDB}/sites-enabled/default" \
          "${RADDB}/sites-enabled/inner-tunnel" \
          "${RADDB}/mods-enabled/eap"

#  2. Overlay only the files that differ from the image defaults.
COPY --chown=freerad:freerad raddb/ ${RADDB}/
RUN ln -s ../mods-available/rest "${RADDB}/mods-enabled/rest" \
 && ln -s ../mods-available/sql  "${RADDB}/mods-enabled/sql" \
 && chown -h freerad:freerad "${RADDB}/mods-enabled/rest" "${RADDB}/mods-enabled/sql" \
 && chmod 0750 "${RADDB}/clients.d" \
 && chmod 0640 "${RADDB}/clients.conf" "${RADDB}/clients.d/dev.conf" "${RADDB}/sites-enabled/status"

COPY --chown=root:root --chmod=0755 docker-entrypoint.sh /usr/local/bin/ecloud-entrypoint.sh
COPY --chown=root:root --chmod=0755 healthcheck.sh       /usr/local/bin/ecloud-healthcheck.sh

#  3. Syntax/dictionary check at build time (placeholders only, see header).
RUN RADIUS_LISTEN_IP=127.0.0.1 RADIUS_DEV_CLIENT_CIDR=127.0.0.1 \
    RADIUS_DEV_CLIENT_SECRET=build-check-placeholder RADIUS_STATUS_SECRET=build-check-placeholder \
    RADIUS_SQL_HOST=localhost RADIUS_SQL_PORT=5432 RADIUS_SQL_DB=ecloud \
    RADIUS_SQL_USER=build-check RADIUS_SQL_PASSWORD=build-check-placeholder \
    ECLOUD_INTERNAL_URL=http://127.0.0.1:1 INTERNAL_API_TOKEN=build-check-placeholder \
    freeradius -C -d "${RADDB}" -l stdout

#  3b. Same check with the opt-in 802.1X/EAP-TTLS configuration linked in, using
#      a throw-away self-signed certificate created, used and deleted inside
#      this single RUN (no key material in any layer).
RUN set -e; d="$(mktemp -d)"; \
    openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj "/CN=ecloud-build-check" \
      -keyout "$d/server.key" -out "$d/server.pem" 2>/dev/null; \
    cp "$d/server.pem" "$d/ca.pem"; chown -R freerad:freerad "$d"; \
    ln -s ../mods-available/eap "${RADDB}/mods-enabled/eap"; \
    ln -s ../sites-available/ecloud-inner "${RADDB}/sites-enabled/ecloud-inner"; \
    RADIUS_LISTEN_IP=127.0.0.1 RADIUS_DEV_CLIENT_CIDR=127.0.0.1 \
    RADIUS_DEV_CLIENT_SECRET=build-check-placeholder RADIUS_STATUS_SECRET=build-check-placeholder \
    RADIUS_SQL_HOST=localhost RADIUS_SQL_PORT=5432 RADIUS_SQL_DB=ecloud \
    RADIUS_SQL_USER=build-check RADIUS_SQL_PASSWORD=build-check-placeholder \
    ECLOUD_INTERNAL_URL=http://127.0.0.1:1 INTERNAL_API_TOKEN=build-check-placeholder \
    RADIUS_EAP_CERT_DIR="$d" RADIUS_EAP_KEY_PASSWORD= \
    freeradius -C -d "${RADDB}" -l stdout; \
    rm -f "${RADDB}/mods-enabled/eap" "${RADDB}/sites-enabled/ecloud-inner"; rm -rf "$d"

#  4. Run unprivileged. The container STARTS as root only so the entrypoint
#     can (un)link the opt-in EAP configuration in the root-owned
#     mods-enabled/ and sites-enabled/ (they stay root-owned: the service user
#     cannot change which modules load); it then drops to freerad with
#     `setpriv --reuid/--regid freerad --init-groups --no-new-privs
#     --bounding-set=-all` before exec'ing FreeRADIUS, so radiusd never runs as
#     root (radiusd.conf `user = freerad`: no setuid attempted). Ports
#     1812/1813 are unprivileged; the config/log/run dirs are owned by freerad.
#     (Run with `--user freerad` the entrypoint skips the root step and refuses
#     RADIUS_EAP_ENABLED=1 unless the links already match.)

EXPOSE 1812/udp 1813/udp

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
    CMD ["/usr/local/bin/ecloud-healthcheck.sh"]

ENTRYPOINT ["/usr/local/bin/ecloud-entrypoint.sh"]
#  Foreground (-f added by the image entrypoint), log to stdout for Docker.
CMD ["freeradius", "-l", "stdout"]
