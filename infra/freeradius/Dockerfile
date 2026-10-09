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
#     `inner-tunnel` virtual servers (replaced by `ecloud`) and the `eap`
#     module (802.1X is a later milestone; its certs are then supplied by
#     ECLOUD PKI, not generated in the image).
RUN rm -f "${RADDB}/sites-enabled/default" \
          "${RADDB}/sites-enabled/inner-tunnel" \
          "${RADDB}/mods-enabled/eap"

#  2. Overlay only the files that differ from the image defaults.
COPY --chown=freerad:freerad raddb/ ${RADDB}/
RUN ln -s ../mods-available/rest "${RADDB}/mods-enabled/rest" \
 && ln -s ../mods-available/sql  "${RADDB}/mods-enabled/sql" \
 && chown -h freerad:freerad "${RADDB}/mods-enabled/rest" "${RADDB}/mods-enabled/sql" \
 && chmod 0640 "${RADDB}/clients.conf" "${RADDB}/sites-enabled/status"

COPY --chown=root:root --chmod=0755 docker-entrypoint.sh /usr/local/bin/ecloud-entrypoint.sh
COPY --chown=root:root --chmod=0755 healthcheck.sh       /usr/local/bin/ecloud-healthcheck.sh

#  3. Syntax/dictionary check at build time (placeholders only, see header).
RUN RADIUS_LISTEN_IP=127.0.0.1 RADIUS_DEV_CLIENT_CIDR=127.0.0.1 \
    RADIUS_DEV_CLIENT_SECRET=build-check-placeholder RADIUS_STATUS_SECRET=build-check-placeholder \
    RADIUS_SQL_HOST=localhost RADIUS_SQL_PORT=5432 RADIUS_SQL_DB=ecloud \
    RADIUS_SQL_USER=build-check RADIUS_SQL_PASSWORD=build-check-placeholder \
    ECLOUD_INTERNAL_URL=http://127.0.0.1:1 INTERNAL_API_TOKEN=build-check-placeholder \
    freeradius -C -d "${RADDB}" -l stdout

#  4. Run unprivileged. radiusd.conf keeps `user = freerad`; since the
#     process already is freerad no setuid is attempted. Ports 1812/1813
#     are unprivileged; the config/log/run dirs are owned by freerad.
USER freerad

EXPOSE 1812/udp 1813/udp

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
    CMD ["/usr/local/bin/ecloud-healthcheck.sh"]

ENTRYPOINT ["/usr/local/bin/ecloud-entrypoint.sh"]
#  Foreground (-f added by the image entrypoint), log to stdout for Docker.
CMD ["freeradius", "-l", "stdout"]
