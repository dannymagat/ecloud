# syntax=docker/dockerfile:1
#
#  ECLOUD application images (M9) -- one multi-target Dockerfile, build context = repo root.
#
#    docker build -f infra/docker/Dockerfile --target api    -t ecloud-api:local    .
#    docker build -f infra/docker/Dockerfile --target worker -t ecloud-worker:local .
#    docker build -f infra/docker/Dockerfile --target portal -t ecloud-portal:local .
#    docker build -f infra/docker/Dockerfile --target admin  -t ecloud-admin:local  .
#
#  Design (DEPLOYMENT_ARCHITECTURE.md §4.3, SECURITY_ARCHITECTURE.md §6.10):
#  - Base images pinned by exact tag (pin by digest for production, see the M9 notes).
#  - `npm ci` against the root package-lock.json, scoped to ONE workspace (`-w`), so every
#    image installs only what its app needs. The build stage adds the root devDependencies
#    (typescript) via --include-workspace-root; the runtime stage gets a separate
#    `npm ci --omit=dev` tree, i.e. dev dependencies never reach the final image.
#  - `tsc -b <app>/tsconfig.build.json` builds the app and its referenced packages only.
#  - Runtime: non-root `node` user, tini as PID 1, app files owned by root (read-only for
#    the process), nothing written to the image filesystem -> runs with `--read-only`.
#  - No secrets: no secret ARG/ENV; configuration is injected at run time (env / *_FILE).
#  - The admin SPA image is for LOCAL testing only; production serves the static build
#    from native Caddy (D-030).
#
ARG NODE_IMAGE=node:22.23.3-bookworm-slim
ARG NGINX_IMAGE=nginxinc/nginx-unprivileged:1.28.2-alpine

# ---------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS node-base
ENV NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false
WORKDIR /src

# Every workspace manifest + the lockfile, extracted from the full context. The output only
# changes when a package.json or the lockfile changes, so the npm ci layers below stay cached
# across source edits (and new workspaces are picked up without editing this file).
FROM node-base AS manifests
COPY . /ctx
RUN mkdir /manifests \
 && cd /ctx \
 && cp package.json package-lock.json /manifests/ \
 && find . -name package.json -not -path '*/node_modules/*' -not -path './package.json' \
      -exec cp --parents {} /manifests/ \;

# ---------------------------------------------------------------------------------------
#  Node runtime base: tini, no npm/corepack (not needed at run time, smaller attack surface).
FROM ${NODE_IMAGE} AS node-runtime
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini \
 && rm -rf /var/lib/apt/lists/* \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
 && mkdir -p /var/lib/ecloud/storage \
 && chown node:node /var/lib/ecloud/storage
ENV NODE_ENV=production \
    STORAGE_LOCAL_PATH=/var/lib/ecloud/storage
WORKDIR /app
ENTRYPOINT ["/usr/bin/tini", "--"]

# =======================================================================================
#  api
# =======================================================================================
FROM node-base AS api-build
COPY --from=manifests /manifests/ ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci -w @ecloud/api --include-workspace-root
COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps/api ./apps/api
# The designer preview renders with the portal page templates (`renderPreview` of @ecloud/portal).
COPY apps/portal ./apps/portal
COPY infra/docker/assemble.sh /usr/local/bin/assemble.sh
RUN npx tsc -b apps/api/tsconfig.build.json \
 && sh /usr/local/bin/assemble.sh apps/api /out \
 && mkdir -p /out/apps/portal \
 && cp -R apps/portal/dist /out/apps/portal/dist \
 && find /out/apps/portal \( -name '*.map' -o -name '*.d.ts' -o -name '*.tsbuildinfo' -o -name '*.test.js' \) -delete

FROM node-base AS api-prod-deps
COPY --from=manifests /manifests/ ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci -w @ecloud/api --omit=dev

FROM node-base AS api-runtime-files
COPY --from=api-prod-deps /src/ ./
COPY --from=api-build /out/ ./
COPY infra/docker/prune-runtime.sh /usr/local/bin/prune-runtime.sh
RUN sh /usr/local/bin/prune-runtime.sh

FROM node-runtime AS api
ARG VCS_REF=unknown
ARG SOURCE_URL=https://github.com/dannymagat/ecloud
LABEL org.opencontainers.image.title="ecloud-api" \
      org.opencontainers.image.description="ECLOUD REST API (/api/v1) and internal listener" \
      org.opencontainers.image.source="${SOURCE_URL}" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.licenses="UNLICENSED"
COPY --from=api-runtime-files /src/ ./
USER node
ENV API_PORT=3000 \
    INTERNAL_PORT=3001
# Only the public API port. The internal listener (INTERNAL_PORT, FreeRADIUS -> core) is
# reached on the private Compose network and is deliberately not EXPOSEd.
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=15s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.API_PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "apps/api/dist/main.js"]

# =======================================================================================
#  worker
# =======================================================================================
FROM node-base AS worker-build
COPY --from=manifests /manifests/ ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci -w @ecloud/worker --include-workspace-root
COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps/worker ./apps/worker
COPY infra/docker/assemble.sh /usr/local/bin/assemble.sh
RUN npx tsc -b apps/worker/tsconfig.build.json \
 && sh /usr/local/bin/assemble.sh apps/worker /out

FROM node-base AS worker-prod-deps
COPY --from=manifests /manifests/ ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci -w @ecloud/worker --omit=dev

FROM node-base AS worker-runtime-files
COPY --from=worker-prod-deps /src/ ./
COPY --from=worker-build /out/ ./
COPY infra/docker/prune-runtime.sh /usr/local/bin/prune-runtime.sh
RUN sh /usr/local/bin/prune-runtime.sh

FROM node-runtime AS worker
ARG VCS_REF=unknown
ARG SOURCE_URL=https://github.com/dannymagat/ecloud
LABEL org.opencontainers.image.title="ecloud-worker" \
      org.opencontainers.image.description="ECLOUD BullMQ workers and schedulers" \
      org.opencontainers.image.source="${SOURCE_URL}" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.licenses="UNLICENSED"
# radclient for the CoA / Disconnect dispatcher (DEPLOYMENT_ARCHITECTURE.md §2.1). The
# dispatcher stays OFF unless ECLOUD_COA_ENABLED=true (D-006, REQUIRES_DEVICE_TEST).
RUN apt-get update \
 && apt-get install -y --no-install-recommends freeradius-utils \
 && rm -rf /var/lib/apt/lists/*
COPY --from=worker-runtime-files /src/ ./
USER node
ENV WORKER_HEALTH_PORT=3003
EXPOSE 3003
HEALTHCHECK --interval=15s --timeout=5s --start-period=15s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.WORKER_HEALTH_PORT||3003)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "apps/worker/dist/main.js"]

# =======================================================================================
#  portal
# =======================================================================================
FROM node-base AS portal-build
COPY --from=manifests /manifests/ ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci -w @ecloud/portal --include-workspace-root
COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps/portal ./apps/portal
COPY infra/docker/assemble.sh /usr/local/bin/assemble.sh
RUN npx tsc -b apps/portal/tsconfig.build.json \
 && sh /usr/local/bin/assemble.sh apps/portal /out

FROM node-base AS portal-prod-deps
COPY --from=manifests /manifests/ ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci -w @ecloud/portal --omit=dev

FROM node-base AS portal-runtime-files
COPY --from=portal-prod-deps /src/ ./
COPY --from=portal-build /out/ ./
COPY infra/docker/prune-runtime.sh /usr/local/bin/prune-runtime.sh
RUN sh /usr/local/bin/prune-runtime.sh

FROM node-runtime AS portal
ARG VCS_REF=unknown
ARG SOURCE_URL=https://github.com/dannymagat/ecloud
LABEL org.opencontainers.image.title="ecloud-portal" \
      org.opencontainers.image.description="ECLOUD captive portal server" \
      org.opencontainers.image.source="${SOURCE_URL}" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.licenses="UNLICENSED"
COPY --from=portal-runtime-files /src/ ./
USER node
ENV PORTAL_PORT=3002
EXPOSE 3002
HEALTHCHECK --interval=15s --timeout=5s --start-period=15s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORTAL_PORT||3002)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "apps/portal/dist/main.js"]

# =======================================================================================
#  admin (static SPA; LOCAL testing only -- production = native Caddy, D-030)
# =======================================================================================
FROM node-base AS admin-build
COPY --from=manifests /manifests/ ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci -w @ecloud/admin --include-workspace-root
COPY tsconfig.base.json ./
COPY packages/shared ./packages/shared
COPY apps/admin ./apps/admin
# @ecloud/shared types resolve from its dist/; then typecheck + vite build. Vite emits
# `hidden` source maps for debugging; they are removed so no *.map file ships.
RUN npx tsc -b packages/shared/tsconfig.build.json \
 && npm run build -w @ecloud/admin \
 && find apps/admin/dist -name '*.map' -delete \
 && test -f apps/admin/dist/index.html

FROM ${NGINX_IMAGE} AS admin
ARG VCS_REF=unknown
ARG SOURCE_URL=https://github.com/dannymagat/ecloud
LABEL org.opencontainers.image.title="ecloud-admin" \
      org.opencontainers.image.description="ECLOUD admin SPA static files (local testing image)" \
      org.opencontainers.image.source="${SOURCE_URL}" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.licenses="UNLICENSED"
COPY --chown=root:root --chmod=0644 infra/docker/admin-nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=admin-build --chown=root:root /src/apps/admin/dist/ /usr/share/ecloud-admin/
# The base image already runs as uid 101 (nginx); stated explicitly for clarity.
USER 101
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=5s --start-period=5s --retries=3 \
    CMD ["wget", "-q", "-O", "/dev/null", "http://127.0.0.1:8080/healthz"]
# Bypass the image's docker-entrypoint.d scripts: they rewrite /etc/nginx/conf.d at start-up,
# which a read-only root filesystem forbids. Writable paths needed: /tmp only (pid + temp).
ENTRYPOINT ["nginx", "-g", "daemon off;"]
