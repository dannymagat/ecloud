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

### B-3 re-measurement (password verify outside the transaction, 2026-10-09 08:26–09:30 local)

Same harness and pilot limits (api 0.75 CPU / 384 MiB, `ARGON2_MEMORY_KIB=19456`, 20 s warm-up,
60 s per scenario). "before" = image `ecloud-api:p10b-before-b3` (the P10-B image above, B-1 fix
included); "after" = `ecloud-api:b3` (B-3 + the Argon2 admission gate, §3). Runs were interleaved
before/after so both saw the same host. The workstation was shared with other agents: host load
average 3–7 during the runs (one spike to 10.4), and the password path is CPU-bound, so the
spread below is mostly host noise.

Full scenario runs (one each; latency ms):

| Scenario | before: req / err / p50 / **p95** / p99 | after: req / err / p50 / **p95** / p99 | api CPU avg before / after |
|---|---|---|---|---|
| password 5/s | 301 / 0 % / 44.7 / **53.8** / 79.3 | 301 / 0 % / 46.3 / **53.9** / 94.0 | 20.7 % / 19.9 % |
| password 10/s | 600 / 0 % / 44.2 / **84.3** / 192.9 | 600 / 0 % / 45.5 / **55.9** / 108.2 | 39.7 % / 38.6 % |
| password 20/s (saturated) | 1 123 (77 dropped) / **19.1 %** 503 / 5 464 / 6 053 / 6 261; 909 accepted | 1 086 (114 dropped) / **16.3 %** 503 / 5 673 / 9 053 / 9 914; 909 accepted | 73.4 % / 74.1 % |
| voucher 20/s | 1 201 / 0 % / 15.6 / **20.9** / 36.0 | 1 201 / 0 % / 17.2 / **23.3** / 60.9 | 18.2 % / 19.9 % |

Variance, password 10/s p95 over all 60 s runs at 0.75 CPU (host load avg at start):
before 84.3 (4.3), 67.2 (4.7), 85.5 (4.0), 2 028 (5.2), 3 541 (6.6), 99.0 (3.2);
after 55.9 (4.1), 65.7 (2.6), 81.1 (4.5), 5 368 (2.5→5.9), 11 927 (5.0), 11 724 (4.3), 6 277 (3.7).
password 5/s p95: before 53.8 / 58.9 / 63.2, after 53.9 / 57.2 / 66.6. With `LOAD_API_CPUS=2`
(no quota throttling) 10/s p95 was before 222.5 ms (api CPU 94.7 %) / after 219.5 ms (72.2 %),
host load 10.4 → 4.6 during that pair. A first after-build without the admission gate measured
password 20/s at 1.2 % errors but p50 10.8 s / p95 13.9 s (requests queued unbounded and were
accepted long after FreeRADIUS' 1.5 s `rlm_rest` timeout), which is why the gate was added.

Reading (honest): B-3 removes the connection hold (proven by
`apps/api/src/aaa-password-verify.integration.test.ts`, a pool of ONE connection serves a
concurrent query while the verify runs), so a password storm no longer drains the pg pool that
voucher, portal-credential and accounting requests share. It does **not** raise the Argon2id CPU
ceiling (B-2): accepted throughput at 20/s is identical (909 in 60 s, ≈ 15/s). Untipped, 10/s p95
is 56–81 ms after vs 67–99 ms before — within the noise. 10/s on 0.75 CPU sits at the CPU cliff for
**both** builds on this shared host: when the host is busy the per-hash CPU cost rises
(memory-hard Argon2id), the arrival rate exceeds service rate and a backlog forms (before 2 of 6
runs, after 4 of 7 runs; after's tipped tails are longer because nothing caps the wait before the
gate, see §3 B-3). The target "password authorize 10/s p95 < 100 ms" therefore remains **not
reliably met** on 0.75 CPU; it needs more CPU (B-2), not a code change. Re-measure on the VPS.

### Verdict against the target

| Path | p95 < 100 ms on the pilot budget? |
|---|---|
| voucher / portal-credential (`pc-…`, HMAC/lookup) authorize ≤ 20/s | **met** (21.5 ms) |
| captive-portal password login (portal → api identify, includes Argon2id) ≤ 5 flows/s | **met** (login step 64.9 ms, whole 3-request flow 89.4 ms) |
| RADIUS password (Argon2id) authorize ≤ 5/s | **met** (76.5 ms) |
| RADIUS password authorize 10/s | **not reliably met** (70–212 ms; after B-3 56–81 ms untipped, but both builds tip into multi-second backlogs on a busy host — CPU-bound, B-2) |
| ≥ 17/s password, ≥ 50/s voucher | **saturated** — password: fail-closed 503 after the 5 s wait (pool wait before B-3, Argon2 admission gate after; the pool is no longer exhausted); voucher 50/s p95 334 ms |

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
| **B-3** | **Argon2 ran inside the tenant DB transaction** (`identify()` was called inside `withTenant(…)`), so every password verify held a pool connection ("idle in transaction") for the hash time + CPU queueing. Under saturation the pool (max 10) emptied and requests failed after `connectionTimeoutMillis` 5 s with 503 (fail-closed, correct but late), and every other path sharing the pool failed with them. | password 20/s: 287 `unavailable` decisions, p50 5.6 s ≈ pool timeout | **Fixed (2026-10-09)**: AAA authorize and portal identify read the credential in a short tenant tx, verify with no connection held, then re-read the user in the decision tx and reject `credential_changed` unless the hash/row/method flag is unchanged (API_ARCHITECTURE.md AAA notes). Overload: `apps/api/src/internal/verify-gate.ts` admits at most UV_THREADPOOL_SIZE (4) concurrent verifies; a verify that cannot start within 5 s → the same fail-closed 503. Measured (above): same CPU ceiling, pool no longer the failure point. Residual: the 5 s gate wait starts at the gate, not at request arrival, so a tipped backlog can answer after 5–12 s (FreeRADIUS has already rejected at 1.5 s); aligning the wait with the `rlm_rest` timeout is an owner decision |
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

## B-3 review fix (2026-10-09)

Independent review PASS WITH FIXES. Applied: the AAA path waits at most **1 s** for a verify slot
(`AAA_VERIFY_MAX_WAIT_MS`, below FreeRADIUS's ~1.5 s `rlm_rest` timeout, so overload answers 503 →
reject before FreeRADIUS gives up, and no session is created for a login nobody receives); the
portal keeps 5 s. The wait queue is capped at 8 × concurrency and refuses at once beyond that
(bounded memory under a flood). Tests: per-call deadline, queue cap, AAA overload answers in
1.0–1.5 s. Load numbers above are unchanged by this fix (it only affects the overloaded regime).
