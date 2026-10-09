# Failure drills — local dev stack (Phase 10, cycle P10-B)

Status: **executed 2026-10-09 on the LOCAL dev stack**, all 40 checks passed after two fixes found
by the drills (§3). Nothing ran against the VPS, EZEAP devices or the EZE controller (D-031).
These are SIMULATOR/LOCAL results: they prove ECLOUD's own behaviour (fail-closed AAA, recovery,
drain idempotency), not any device's retry/fallback behaviour (D-034).

## 1. Harness

`scripts/drills/failure-drills.ts` (run: `npm run build && npx tsx scripts/drills/failure-drills.ts
[--only postgres,redis,freeradius,api,worker]`, JSON report on stdout).

- **Isolation**: a scratch database `ecloud_failure_drill_<ts>` (created, migrated with
  `ecloud-db migrate` + `seed`, **dropped at the end**), Redis logical db 12 (flushed at the end),
  api / portal / worker as host processes from `dist/` on the dev ports 3000–3003 (+ portal metrics
  3005). The dev `freeradius` container already sends rlm_rest to `host.docker.internal:3001`, so
  real Access-Requests go radclient → FreeRADIUS → api. The script refuses to start when those
  ports are busy.
- **Fixture**: one tenant, site, NAS at the freeradius container address (= authenticated packet
  source), captive portal (uspot UAM, simulator UAM secret), one subscriber (Argon2id), an active
  10/2 Mbit site policy.
- **Shared containers** (`ecloud-dev-postgres`, `-redis`, `-freeradius`) are stopped/restarted
  briefly; after every drill and in a `finally` (plus an `uncaughtException` safety net) the
  script starts them again and waits for `healthy`.
- Probes per drill: `POST /internal/aaa/authorize` (HTTP), Access-Request through FreeRADIUS
  (`radclient` in the container), portal UAM entry `GET /uam/uspot/?…` and full password login,
  api `/readyz`, worker `/healthz` + `/metrics`, and SQL on the scratch DB for accounting/sessions.

## 2. Results (run 2026-10-09 02:56–02:58 UTC, 40/40 checks PASS)

Times are wall-clock on the workstation (Docker Desktop, x86_64). "Recovered" is measured from
the `docker start` / process start to the first successful probe.

### Baseline — 4/4
authorize HTTP 200 (`control:Auth-Type`, 168 ms incl. first Argon2id), RADIUS Access-Accept,
portal password login 302 → `http://10.1.0.1:3990/logon…`, `/readyz` 200. Process start: api
830 ms, portal 414 ms, worker 823 ms.

### Postgres stop/start — 9/9

| Check | Expected (documented behaviour) | Observed |
|---|---|---|
| authorize HTTP while down | 503, no `Auth-Type` (AAA_ARCHITECTURE / contract: never fail open) | 503 in 6 ms |
| RADIUS through FreeRADIUS | Access-Reject | Access-Reject (1.2 s) |
| portal UAM entry | 503 error page | 503 HTML error page |
| api `/readyz` / worker `/healthz` | 503 / 503 degraded | 503 / 503 |
| recovery | authorize 200, Accept, portal 303, worker 200 | container healthy 5.4 s; authorize 200 after **5.7 s**; total outage 7.8 s |

The api/worker processes **stayed up**: the pool logged `postgres idle connection lost; pool will
reconnect` (2× api, 4× worker) instead of crashing — see fix F-1.

### Redis stop/start — 11/11

| Check | Expected | Observed |
|---|---|---|
| authorize HTTP while down | 503 (retransmit cache unreachable → fail closed, `RedisKv` has no offline queue) | 503 in 3 ms |
| RADIUS / portal / readyz / worker | Reject / 503 page / 503 / 503 | as expected |
| recovery | authorize 200 … | Redis healthy 5.4 s; authorize 200 after **5.7 s** |
| schedulers after Redis data loss (dev Redis has no persistence) | re-registered | `ecloud_worker_scheduler_registrations_total` 1 → **2** (fix F-2) |
| drain after cursor loss | all new rows drained, no duplicates | 20 raw → 20 records, 20 distinct `radacctid` (cursor restarted at 0, idempotency skip) |

### FreeRADIUS restart — 3/3
Request during restart: no reply (the NAS times out — device-side retry/fallback is a device
question, D-034, never an Accept); healthy after 5.5 s; Access-Accept again **6.5 s** after the
restart command; api unaffected (200).

### API restart (SIGTERM, graceful) — 7/7
Five authorize requests in flight at SIGTERM: **all 200** (drained). While down: RADIUS
Access-Reject (rlm_rest connect failure → `fail` → reject), portal 503 page. New process
listening 1.2 s after start; authorize 200 after **1.4 s**. Graceful stop took **10.0 s**: the
full `shutdownGraceMs`, because FreeRADIUS keeps rlm_rest keep-alive connections open (see §4).

### Worker restart (SIGKILL, hard crash) — 6/6

| Check | Expected | Observed |
|---|---|---|
| batch A drained before the crash | records = raw | 171/171 |
| rows inserted before the kill + while down | pending | 171/471 drained while down |
| AAA independent of the worker | 200 | 200 |
| after restart: no loss, no duplication | records = raw, distinct `radacctid` = records | **471 / 471 / 471** (drained 13.4 s after start; drain lag 5 s + 5 s tick) |
| stale session (last sign of life 2 h ago) | `stopped` / `lost_interim` | stopped / lost_interim |
| authorization without accounting (`WORKER_AUTHORIZATION_TTL_S=30`) | `expired` | expired |

After every drill: `{"ecloud-dev-postgres":"healthy","ecloud-dev-redis":"healthy",
"ecloud-dev-freeradius":"healthy"}`; scratch database dropped; Redis db 12 flushed.

## 3. Defects found and fixed in this cycle

| ID | Found by | Defect | Fix | Test |
|---|---|---|---|---|
| **F-1** (high) | first Postgres drill: the drill harness itself died with `Unhandled 'error' event … terminating connection due to administrator command`; the api and worker use the same `createPool()` | `packages/db` `createPool()` registered no `pool.on('error')`. node-postgres emits idle-client errors on the pool; without a listener a PostgreSQL restart (or `pg_terminate_backend`, failover, network drop) **crashes the api and worker processes**. | `createPool()` always installs an idle-error handler (optional `onIdleError` callback); api and worker log a warning. | `packages/db/src/client.test.ts` (unit), `packages/db/src/pool-resilience.integration.test.ts` (terminates its own backend, next query reconnects) |
| **F-2** (medium) | Redis drill (code review → drill) | BullMQ job schedulers live in Redis and were registered only at worker start. Redis without persistence (dev; any Redis data loss in the pilot) left **no** drain/reap/enforce/outbox schedules until the worker was restarted: usage, quotas and session reaping silently stopped. | Worker re-registers its schedulers on every Redis reconnect (`ready` after the first connect; upsert is idempotent) and counts it (`ecloud_worker_scheduler_registrations_total`). | `apps/worker/src/metrics.integration.test.ts` (flushes its own logical db 14, kills its connections, waits for the schedulers to come back) — fails without the fix |

The drain cursor also lives in Redis; losing it makes the drain rescan `radacct_raw` from 0. The
drill confirms this is safe (per-row `radacctid` idempotency), but the rescan cost grows with the
table (1 M rows ≈ minutes of DB work) — see §4.

## 4. Residual risks / follow-ups (not fixed here)

1. **Drain cursor in Redis** (DATABASE_DESIGN/Phase 3 note): on Redis data loss the drain rescans
   all retained `radacct_raw` rows. Pilot compose enables Redis AOF (VPS-APP-1); proposal: persist
   the cursor in a Postgres table (`worker_cursors`) in a later migration.
2. **Graceful api stop takes the full grace period (10 s)** while FreeRADIUS holds keep-alive
   rlm_rest connections; in-flight requests complete, but a rolling restart therefore costs ~10 s
   + start (~1.4 s) of RADIUS rejects on a single-instance pilot. Options: shorter
   `shutdownGraceMs` for the internal listener, or `Connection: close` once shutdown starts.
3. Outage behaviour of the NAS itself (does it retry, fall back, cache?) is a device test
   (DT list, D-034) — the drills only prove ECLOUD never answers Accept while degraded.
4. The drills run on the developer workstation; repeat on the pilot host after approval
   (VPS change list), with Docker `restart: unless-stopped` covering process crashes.
