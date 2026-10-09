# Performance and load test — AAA authorize and captive-portal login (Phase 10, cycle P10-B)

Status: **LOCAL measurements, 2026-10-09**, developer workstation (x86_64, Docker Desktop 16 vCPU /
7.75 GiB, shared with other agents: host load average 6–12 during the runs). api and portal ran
in containers at the **pilot limits** (DEPLOYMENT_ARCHITECTURE.md §2.2). Numbers are indicative
for the 2-vCPU VPS only after the same script runs there (D-031 — not done).

Target (TASK P10-B): **authorize p95 < 100 ms on the pilot memory budget.**

## 1. Harness (`scripts/load/`)

| File | Role |
|---|---|
| `run-load.sh` | builds nothing; uses images `ecloud-api:p10b` / `ecloud-portal:p10b` (`docker build -f infra/docker/Dockerfile --target api|portal`); scratch DB `ecloud_loadtest_<ts>` (migrate + seed, **dropped** at the end), Redis logical db 11 (flushed); api container `--memory 384m --cpus 0.75`, portal `--memory 256m --cpus 0.5`, both `--read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges --pids-limit 128` (same as the compose `app` profile), `NODE_OPTIONS=--max-old-space-size=256/160`, `ARGON2_MEMORY_KIB=19456` (production cost), `LOG_LEVEL=info`; 20 s unrecorded warm-up; `docker stats` sampled continuously; per-run random internal token |
| `seed.ts` | 1 tenant/site/NAS (`openwifi-uspot-uam`), 10/2 Mbit site policy, 500 subscribers (each its own Argon2id hash), 6 000 single-use vouchers, 1 500 pre-signed UAM redirects |
| `authorize.k6.js` | k6 open model (`constant-arrival-rate`), realistic rlm_rest body (contract §2: NAS-IP, NAS-Identifier, NAS-Port-Type, Service-Type, Calling/Called-Station-Id, SSID, Acct-Session-Id, Framed-IP, WISPr-Logoff-URL, ECLOUD-Packet-Src-*, Client-Shortname); every request is a new session (no retransmit-cache hits); `MODE=password` or `voucher` |
| `portal.k6.js` | per iteration: `GET /uam/uspot/?<signed>` (303) → `GET /f/{token}/login` (CSRF) → `POST` (302 to `http://10.1.0.1:3990/logon`) |
| `summarize.mjs` | p50/p95/p99, error rate, CPU/memory per container |

Run: `scripts/load/run-load.sh` (default `password:5 password:10 password:20 voucher:20 voucher:50
portal:2 portal:5`, 60 s each). k6 `grafana/k6:0.57.0` runs as a container on the dev compose
network (same host — it competes for CPU). Portal per-IP / per-NAS rate limits were disabled
(`RATE_LIMIT_DISABLED=true`, development only) because all load comes from one IP and one NAS;
production keeps `flowsPerNas = 300/h` etc. (SECURITY_ARCHITECTURE §5.4).

## 2. Results

Run 2 (final, 03:29–03:37 UTC, with warm-up, after the voucher-lock fix). Latency in ms.

| Scenario (60 s) | Requests | Errors | p50 | p95 | p99 | api CPU avg / max (limit 75 %) | api RSS max (limit 384 MiB) | postgres CPU avg / max |
|---|---|---|---|---|---|---|---|---|
| password 5/s | 301 | 0 % | 47.5 | **76.5** | 142.5 | 22.8 % / 43.7 % | 158 MiB | 4.5 % / 10.9 % |
| password 10/s | 600 | 0 % | 48.9 | **211.9** | 312.5 | 44.2 % / 67.3 % | 149 MiB | 8.3 % / 21.1 % |
| password 20/s (saturation) | 1 118 (82 dropped) | **25.7 %** (503) | 5 573 | 6 219 | 6 475 | 71.6 % / 82.1 % | 179 MiB | 13.1 % / 38.3 % |
| voucher 20/s | 1 201 | 0 % | 15.6 | **21.5** | 49.0 | 18.7 % / 38.3 % | 163 MiB | 14.6 % / 22 % |
| voucher 50/s | 3 001 | 0 % | 14.2 | 334.2 | 1 249.7 | 44.1 % / 87.8 % | 180 MiB | 37.2 % / 69.7 % |
| portal login 2 flows/s (6 req/s) | 360 | 0 % | flow 57 / login 40.7 | flow 94.2 / **login 66.5** | flow 144.8 / login 81.2 | 10.4 % / 40 % | 182 MiB | 2.7 % |
| portal login 5 flows/s (15 req/s) | 900 | 0 % | flow 58 / login 41.5 | flow 89.4 / **login 64.9** | flow 162.8 / login 122 | 25.3 % / 57.4 % | 182 MiB | 4.6 % |

Portal container: CPU ≤ 7 % avg, RSS ≤ 48 MiB (limit 256 MiB); portal steps p95: entry 13.6–18.9,
form 8.1–8.6 ms. Redis ≤ 12 MiB, ≤ 3 % CPU. Postgres (no limit in dev; pilot 640 MiB) ≤ 116 MiB.
No OOM kill, no restart (`OOMKilled=false`, `RestartCount=0` for api and portal). api
`/metrics` after the run: `accept` 6 056, `unavailable` 287 (all from the password-20 saturation).

Variance: run 1 (no warm-up, 03:13–03:21) measured password 5/s p95 279 ms and 10/s p95 677 ms;
an isolated warm 30 s run measured 10/s p95 70.4 ms (and 75.8 ms with `--cpus 2`, 83.8 ms with
`UV_THREADPOOL_SIZE=1`). Password-path tails on this shared host are dominated by CPU
contention/CFS throttling of the 0.75-CPU quota, so the 10/s figure is "70–212 ms".

Before the voucher-lock fix (§3, B-1) the 10-s smoke run measured voucher 10/s **p95 1 193 ms**;
after it voucher 10/s p95 44 ms and 20/s p95 21.5 ms.

### Verdict against the target

| Path | p95 < 100 ms on the pilot budget? |
|---|---|
| voucher / portal-credential (`pc-…`, HMAC/lookup) authorize ≤ 20/s | **met** (21.5 ms) |
| captive-portal password login (portal → api identify, includes Argon2id) ≤ 5 flows/s | **met** (login step 64.9 ms, whole 3-request flow 89.4 ms) |
| RADIUS password (Argon2id) authorize ≤ 5/s | **met** (76.5 ms) |
| RADIUS password authorize 10/s | **not reliably met** (70–212 ms) |
| ≥ 17/s password, ≥ 50/s voucher | **saturated** — password: fail-closed 503 after the 5 s pool wait; voucher 50/s p95 334 ms |

Pilot sizing reference: one site with hundreds of clients produces a handful of authorizations per
second at peak (session starts + re-auth), and captive-portal logins authorize the NAS's
Access-Request with a single-use `pc-…` credential — the cheap path — so the pilot load is inside
the "met" rows. Bulk reconnect storms (AP reboot → every client re-authenticates) are the case to
watch: they hit the password ceiling first.

## 3. Bottlenecks

| ID | Finding | Evidence | Status |
|---|---|---|---|
| **B-1** | **Voucher logins of one batch were serialised**: `SELECT … FROM vouchers v JOIN voucher_batches b … FOR UPDATE` locked the shared `voucher_batches` row as well, for the whole authorize transaction (also in the portal identity broker). | voucher 10/s p95 1 193 ms → 44 ms after the fix | **Fixed**: `FOR UPDATE OF v` (`apps/api/src/internal/aaa.ts`, `internal/portal-identity.ts`); regression test `apps/api/src/voucher-concurrency.integration.test.ts` (fails without the fix: 5 062 ms vs < 3 000 ms) |
| **B-2** | **Argon2id is the password-path ceiling**: ~45 ms CPU per verify at m=19 MiB, t=2 → at 0.75 CPU the theoretical max is ~16 verifies/s; measured saturation ≈ 17/s. | api CPU 72 % avg (limit 75 %) at 20/s; p50 jumps 49 → 5 573 ms | By design (OWASP parameters, SECURITY_ARCHITECTURE §6.1). Options for the owner: raise the api CPU limit (budget allows 1.0), or a second api replica later |
| **B-3** | **Argon2 runs inside the tenant DB transaction** (`identify()` is called inside `withTenant(…)`), so every password verify holds a pool connection ("idle in transaction") for the hash time + CPU queueing. Under saturation the pool (max 10) empties and requests fail after `connectionTimeoutMillis` 5 s with 503 (fail-closed, correct but late). | password 20/s: 287 `unavailable` decisions, p50 5.6 s ≈ pool timeout | **Open (recommendation)**: verify the password before opening the transaction (or load-shed: bounded Argon2 semaphore → immediate 503/Reject), and keep FreeRADIUS `rlm_rest` timeouts below the NAS retransmit interval. Not changed in this cycle: it restructures the AAA decision path (AAA owner) |
| **B-4** | Postgres CPU rises steeply at 50 voucher/s (37 % avg, 70 % peak) — per authorize: NAS lookup, policy resolution, session insert, voucher update, decision cache. | voucher 50/s | Acceptable for the pilot; profile query count per authorize before scaling |
| **B-5** | Tail latency on the password path is sensitive to CPU throttling (0.75 CPU quota) and host noise; `UV_THREADPOOL_SIZE` 1 vs 4 made no material difference. | variance section | Re-measure on the VPS |

Memory: the pilot limits have ample headroom (api ≤ 182/384 MiB, portal ≤ 54/256 MiB, Redis
≤ 12/128 MiB); no limit change is needed for memory.

## 4. Monitoring hooks added in this cycle

`ecloud_aaa_authorize_duration_seconds` (histogram by outcome) and
`ecloud_aaa_authorize_decisions_total{outcome,reason,retransmit}` on the api internal listener,
`ecloud_api_http_request_duration_seconds`, worker queue depths and job outcomes, portal login
outcomes and latencies — all used by `infra/monitoring/alerts.yml`
(`EcloudAuthorizeLatencyP95High` > 100 ms for 10 min, `EcloudAaaBackendUnavailable`, event-loop
lag, memory near limit).
