#!/usr/bin/env bash
# P10-B load test (LOCAL dev stack only): api + portal containers at the PILOT resource limits
# (DEPLOYMENT_ARCHITECTURE.md §2.2: api 384 MiB / 0.75 CPU, portal 256 MiB / 0.5 CPU, same
# hardening as the compose `app` profile), a scratch database `ecloud_loadtest_<ts>` (created,
# migrated, seeded, DROPPED at the end), Redis logical db 11, and k6 (grafana/k6 container) on the
# dev compose network. Container CPU/memory are sampled with `docker stats` during every scenario.
#
#   npm run build
#   docker build -f infra/docker/Dockerfile --target api    -t ecloud-api:p10b .
#   docker build -f infra/docker/Dockerfile --target portal -t ecloud-portal:p10b .
#   scripts/load/run-load.sh                      # default scenario list, 60 s each
#   LOAD_SCENARIOS="password:10 portal:5" LOAD_DURATION=30s scripts/load/run-load.sh
#   LOAD_API_CPUS=2 LOAD_API_ENV="UV_THREADPOOL_SIZE=2" ...   # experiments beyond the pilot budget
#
# Scenarios: password:<rps> | voucher:<rps> (POST /internal/aaa/authorize) | portal:<flows/s>.
# Scenario names must be unique within one run (the k6 summary file is named after them).
# Prints the summary JSON (p50/p95/p99, error rate, CPU/memory) on stdout.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/../.." && pwd)"
log() { printf '%s [load] %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }
die() {
  log "ERROR: $*"
  exit 1
}

PG=ecloud-dev-postgres
API_IMAGE="${LOAD_API_IMAGE:-ecloud-api:p10b}"
PORTAL_IMAGE="${LOAD_PORTAL_IMAGE:-ecloud-portal:p10b}"
K6_IMAGE="${LOAD_K6_IMAGE:-grafana/k6:0.57.0}"
SCENARIOS="${LOAD_SCENARIOS:-password:5 password:10 password:20 voucher:20 voucher:50 portal:2 portal:5}"
DURATION="${LOAD_DURATION:-60s}"
DEV_PW="${ECLOUD_PLATFORM_PASSWORD:-ecloud_dev_password}" # DEV ONLY default
APP_PW="${ECLOUD_APP_PASSWORD:-ecloud_dev_password}"      # DEV ONLY default
STAMP="$(date -u +%Y%m%d%H%M%S)"
DB="ecloud_loadtest_$STAMP"
API=ecloud-p10b-api
PORTAL=ecloud-p10b-portal
TOKEN="load_test_internal_token_$(openssl rand -hex 16)" # per-run, never stored
TMP="$(mktemp -d "${TMPDIR:-/tmp}/ecloud-load.XXXXXX")"
case "$TMP" in "$REPO"*) die "temp dir must be outside the repository" ;; esac
mkdir -p "$TMP/out" "$TMP/fixture"
chmod 777 "$TMP/out"

for img in "$API_IMAGE" "$PORTAL_IMAGE"; do
  docker image inspect "$img" >/dev/null 2>&1 || die "image $img missing (see header)"
done
for c in ecloud-dev-postgres ecloud-dev-redis; do
  [ "$(docker inspect -f '{{.State.Health.Status}}' "$c")" = healthy ] || die "$c not healthy"
done
NET="$(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}{{end}}' "$PG")"

cleanup() {
  docker rm -f "$API" "$PORTAL" >/dev/null 2>&1 || true
  docker exec "$PG" psql -X -q -U ecloud -d postgres -c "DROP DATABASE IF EXISTS \"$DB\" WITH (FORCE)" >/dev/null 2>&1 &&
    log "dropped $DB" || log "WARNING: could not drop $DB"
  docker exec ecloud-dev-redis redis-cli -n 11 FLUSHDB >/dev/null 2>&1 || true
  if [ "${LOAD_KEEP:-0}" = 1 ]; then log "kept $TMP"; else rm -rf "$TMP"; fi
}
trap cleanup EXIT

log "scratch database $DB on network $NET"
docker exec "$PG" psql -X -q -v ON_ERROR_STOP=1 -U ecloud -d postgres -c "CREATE DATABASE \"$DB\" OWNER ecloud_platform"
PLATFORM_URL="postgres://ecloud_platform:${DEV_PW}@127.0.0.1:${POSTGRES_PORT:-5432}/$DB"
node "$REPO/packages/db/dist/cli.js" migrate --url "$PLATFORM_URL" >/dev/null
node "$REPO/packages/db/dist/cli.js" seed --url "$PLATFORM_URL" >/dev/null
LOAD_PLATFORM_URL="$PLATFORM_URL" LOAD_OUT="$TMP/fixture/fixture.json" npx tsx "$SCRIPT_DIR/seed.ts"
chmod 644 "$TMP/fixture/fixture.json"
docker exec ecloud-dev-redis redis-cli -n 11 FLUSHDB >/dev/null

# shellcheck disable=SC2054 # the commas belong to the --tmpfs option value
HARDEN=(--read-only --tmpfs /tmp:rw,noexec,nosuid,size=64m --cap-drop ALL
  --security-opt no-new-privileges:true --pids-limit 128 --network "$NET")
COMMON_ENV=(-e NODE_ENV=development -e LOG_LEVEL="${LOAD_LOG_LEVEL:-info}"
  -e "DATABASE_URL=postgres://ecloud_app:${APP_PW}@postgres:5432/$DB"
  -e "DATABASE_URL_PLATFORM=postgres://ecloud_platform:${DEV_PW}@postgres:5432/$DB"
  -e REDIS_URL=redis://redis:6379/11 -e "INTERNAL_API_TOKEN=$TOKEN"
  -e PUBLIC_PORTAL_ORIGIN=http://portal.loadtest -e ARGON2_MEMORY_KIB=19456)
API_EXTRA=()
for kv in ${LOAD_API_ENV:-}; do API_EXTRA+=(-e "$kv"); done
docker run -d --name "$API" "${HARDEN[@]}" --memory 384m --cpus "${LOAD_API_CPUS:-0.75}" "${API_EXTRA[@]}" \
  "${COMMON_ENV[@]}" -e API_PORT=3000 -e INTERNAL_PORT=3001 -e INTERNAL_BIND_HOST=0.0.0.0 \
  -e SESSION_COOKIE_SECURE=false -e RATE_LIMIT_DISABLED=true -e STORAGE_DRIVER=local \
  -e STORAGE_LOCAL_PATH=/tmp/storage -e NODE_OPTIONS=--max-old-space-size=256 \
  -p 127.0.0.1:3101:3001 "$API_IMAGE" >/dev/null
docker run -d --name "$PORTAL" "${HARDEN[@]}" --memory 256m --cpus 0.5 \
  "${COMMON_ENV[@]}" -e PORTAL_PORT=3002 -e "PORTAL_INTERNAL_API_URL=http://$API:3001" \
  -e PORTAL_COOKIE_SECURE=false -e NODE_OPTIONS=--max-old-space-size=160 \
  -e PORTAL_METRICS_PORT=3005 -e PORTAL_METRICS_HOST=0.0.0.0 \
  -p 127.0.0.1:3105:3005 "$PORTAL_IMAGE" >/dev/null
for i in $(seq 1 60); do
  curl -fsS -o /dev/null http://127.0.0.1:3101/healthz 2>/dev/null &&
    curl -fsS -o /dev/null http://127.0.0.1:3105/metrics 2>/dev/null && break
  [ "$i" = 60 ] && die "containers did not become ready"
  sleep 1
done
log "api + portal ready ($API_IMAGE, $PORTAL_IMAGE)"

sample_stats() {
  while :; do
    docker stats --no-stream --format '{{.Name}},{{.CPUPerc}},{{.MemUsage}}' \
      "$API" "$PORTAL" ecloud-dev-postgres ecloud-dev-redis 2>/dev/null | sed "s/^/$1,/" >>"$TMP/out/stats.csv" || true
  done
}

# Warm-up (not recorded): JIT, pg/Redis connections and caches reach steady state first, as on a
# running pilot. Uses users/vouchers far from the recorded range.
WARMUP="${LOAD_WARMUP:-20s}"
if [ "$WARMUP" != 0s ]; then
  log "warm-up $WARMUP (password:3 + voucher:3, not recorded)"
  for wm in password voucher; do
    docker run --rm --network "$NET" -v "$SCRIPT_DIR:/scripts:ro" -v "$TMP/fixture:/load:ro" \
      -v "$TMP/out:/out" -e RATE=3 -e "MODE=$wm" -e "DURATION=$WARMUP" -e "NAME=warmup-$wm" \
      -e "TARGET=http://$API:3001" -e "TOKEN=$TOKEN" -e OFFSET=5000 "$K6_IMAGE" \
      run --quiet /scripts/authorize.k6.js >/dev/null 2>&1 || true
  done
fi

secs="${DURATION%s}"
case "$secs" in '' | *[!0-9]*) die "LOAD_DURATION must be in seconds, e.g. 60s" ;; esac
offset=0
for sc in $SCENARIOS; do
  mode="${sc%%:*}"
  rate="${sc##*:}"
  name="$mode-$rate"
  script=authorize.k6.js
  target="http://$API:3001"
  if [ "$mode" = portal ]; then
    script=portal.k6.js
    target="http://$PORTAL:3002"
  fi
  log "scenario $name ($DURATION)"
  sample_stats "$name" &
  sampler=$!
  docker run --rm --network "$NET" -v "$SCRIPT_DIR:/scripts:ro" -v "$TMP/fixture:/load:ro" \
    -v "$TMP/out:/out" -e "RATE=$rate" -e "MODE=$mode" -e "DURATION=$DURATION" -e "NAME=$name" \
    -e "TARGET=$target" -e "TOKEN=$TOKEN" -e "OFFSET=$offset" "$K6_IMAGE" run --quiet "/scripts/$script" \
    >"$TMP/out/$name.k6.log" 2>&1 || log "k6 exit $? for $name (threshold breach or errors; see summary)"
  [ "$mode" != voucher ] || offset=$((offset + rate * secs * 11 / 10 + 10))
  kill "$sampler" 2>/dev/null || true
  wait "$sampler" 2>/dev/null || true
  sleep 3 # let the api settle between scenarios
done

curl -fsS http://127.0.0.1:3101/metrics >"$TMP/out/api-metrics.txt"
curl -fsS http://127.0.0.1:3105/metrics >"$TMP/out/portal-metrics.txt"
docker inspect -f '{{.State.OOMKilled}} {{.RestartCount}}' "$API" "$PORTAL" >"$TMP/out/oom.txt"
node "$SCRIPT_DIR/summarize.mjs" "$TMP/out" "$SCENARIOS"
