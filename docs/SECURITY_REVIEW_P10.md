# Security review — Phase 10, cycle P10-A (A8)

Date: 2026-10-09 · Scope: whole repository on branch `claude/trusting-bohr-ehety0` (apps/api,
apps/portal, apps/worker, apps/admin build, packages/*, infra/*, CI) against the threat model
T1–T18 of SECURITY_ARCHITECTURE.md §1 and the SECURITY.md checklist. **LOCAL ONLY**: no SSH, no
VPS/DNS/Caddy/EZEAP/controller action; host-side controls are authored as drafts under
`infra/vps/` and listed in `docs/VPS_CHANGE_LIST.md` (D-031). Labels: **IMPLEMENTED** (code +
test in this repo), **DRAFTED** (file authored and validated locally, not applied),
**DESIGN** (documented only), **GAP** (missing).

Method: read of the security-relevant code paths (authn/authz middleware, session/API-key
resolution, CSRF, rate limits, internal listener guard, portal server and portal internal API,
crypto/envelopes, config validation, logging/redaction, SQL access patterns, process spawning,
webhook transport, migrations/RLS tests), dependency and image scanning, and container-based
validation of every host draft. Fixes were limited to small, safe changes with tests; larger
items are listed as findings (§4).

## 1. Threat → control → evidence → residual → gap

| # | Threat | Implemented / drafted control | Evidence (file / test) | Residual risk | Gap |
|---|---|---|---|---|---|
| T1 | Admin account takeover | argon2id m=19456 t=2 p=1; generic 401 + dummy verify for unknown e-mails; per-IP (30/5 min) and per-account (10 failures → 15 min lock) limits failing **closed** without Redis; TOTP (mandatory for platform bindings / `require_mfa`); MFA challenge 5 attempts — **now atomic** (P10-A) + per-IP limit; opaque 256-bit session tokens hashed at rest, idle 30 min / absolute 12 h, revocation; audit of `auth:login` / `auth:login:failed`; fail2ban `ecloud-admin` events (P10-A) | `packages/db/src/admin.ts`; `apps/api/src/auth/rate-limit.ts`; `apps/api/src/routes/auth.ts`; `apps/api/src/auth/principal.ts`; tests `apps/api/src/auth/mfa-verify.test.ts`, `apps/api/src/app.test.ts` (fail-closed login), `apps/api/src/phase4.integration.test.ts`; `infra/vps/fail2ban/` | real-time TOTP phishing relay | WebAuthn (F-P10-18) |
| T2 | Subscriber credential attacks | portal limits per method/account/site/IP (`PORTAL_LIMITS`), 5 password failures / 5 min → 15 min lock; vouchers 32-symbol alphabet, HMAC-SHA-256 with pepper, single-use/limits (D-037); generic rejection page, password never echoed; fail2ban `ecloud-portal` events (P10-A) | `apps/api/src/internal/portal.ts`, `apps/api/src/crypto.ts`; tests `apps/portal/src/index.test.ts` (generic 422/429, no echo, P10-A event), `apps/api/src/portal.integration.test.ts`, `apps/api/src/integration.test.ts` (single-use voucher) | PAP over the AP LAN hop (UAM protocol limit) | — |
| T3 | Portal spoofing / phishing | separate portal origin; CSP with nonce, `frame-ancestors 'none'`, `form-action` limited to the NAS; HSTS when secure; `userurl` filtered (`safeUserUrl`); NAS hand-off URL verified before redirect; branding from DB tokens only; Caddy portal vhost headers (drafted) | `apps/portal/src/index.ts`; `apps/api/src/internal/portal.ts`; tests `apps/portal/src/index.test.ts` (foreign hand-off rejected), `apps/api/src/portal-admin/*.test.ts`; `infra/vps/caddy/sites/ezecloud.caddy` | evil-twin SSIDs cannot be detected by the portal | — |
| T4 | RADIUS client impersonation | tunnel-only RADIUS (D-032) — publish on 100.100.0.1 only (drafted), nftables/DOCKER-USER allow RADIUS only from `wg0` to the hub (drafted); `require_message_authenticator = yes`, `limit_proxy_state = auto`; unknown NAS → reject + `auth_events` with reason `unknown_nas` | `infra/freeradius/raddb/clients.conf`, `sites-enabled/status`; `apps/api/src/internal/aaa.ts`; `infra/vps/nftables/*`, `infra/vps/compose/compose.pilot.yaml`; tests `tests/aaa-contract/` | topology C (public RADIUS) relies on secret + allow-list (not enabled) | production client rendering (F-P10-07) |
| T5 | Stolen / shared RADIUS secrets | one secret per NAS, 32 random bytes, sealed AES-256-GCM (`enc:v1`, HKDF purpose per secret type), returned once, rotation endpoint (`nas:secret:rotate`, refused while impersonating, audited); no plaintext secret columns; FreeRADIUS `-X` forbidden in production | `apps/api/src/routes/resources.ts`, `apps/api/src/crypto.ts`; tests `tests/security/db-security.test.ts` (no plaintext secret columns) | controller-side clear storage outside ECLOUD | dual-secret window (F-P10-06); key ring (F-P10-04) |
| T6 | API abuse | API keys `eck_` + 32 random bytes, SHA-256 at rest, prefix lookup, constant-time compare, expiry/revocation/org status/`allowed_cidrs`; export limit 10/h; idempotency keys; 1 MiB public / 64 KiB internal body limits; `api.` vhost Bearer-only (drafted) | `apps/api/src/auth/principal.ts`, `apps/api/src/export-guard.ts`, `apps/api/src/app.ts`; tests `apps/api/src/units.test.ts`, `apps/api/src/app.test.ts` | — | per-key / per-tenant request rate limit and invalid-key throttling (F-P10-05) |
| T7 | Injection | Kysely parameterised queries only (no `sql.raw` in app code), zod validation of body, query and params on every route (strictness per schema), `radclient` via `execFile` + stdin (no shell), portal HTML auto-escaped, FreeRADIUS `rlm_sql` safe characters, `macaddr`/`inet` types | `apps/api/src/http/route.ts`, `apps/worker/src/coa/radclient.ts`, `apps/portal/src/pages.ts`; tests `apps/worker/src/coa/radclient.test.ts`, `apps/portal/src/index.test.ts` (escaped username), `apps/api/src/app.test.ts` (validation problems) | hostile strings kept in `accounting_records.raw` (rendered escaped) | — |
| T8 | Privilege escalation | deny-by-default `authorize()`, `resource:action` permissions, escalation guards (caller must hold every permission it grants, roles/API keys), impersonation restrictions (D-027), platform-only permissions | `apps/api/src/auth/authorize.ts`, `apps/api/src/routes/access.ts`, `apps/api/src/routes/administrators.ts`; tests `apps/api/src/auth/authorize.test.ts`, `tests/isolation/` | logic bugs in evaluation | — |
| T9 | Cross-tenant exposure | RLS enabled+forced on every `organization_id` table, `SET LOCAL app.current_org`, `ecloud_app` NOBYPASSRLS (re-asserted by `db-roles.sql`, drafted), 404 for foreign objects, tenant from NAS identity | `packages/db/migrations/010_rls_and_grants.sql`, `packages/db/src/tenancy.ts`; tests `tests/isolation/rls-matrix.test.ts`, `tests/isolation/tenant-cases.test.ts` (T-01…), `tests/security/db-security.test.ts` (S-05, S-06, S-10) | RLS fails closed to 0 rows (monitoring) | — |
| T10 | Session hijacking | HttpOnly, SameSite=Lax, Path=/, no Domain; **production now requires `Secure` + `__Host-` name** (P10-A); CSRF: Origin/Referer = admin origin + `X-Requested-With` on cookie-authenticated and cookie-issuing requests; admin CSP without inline script; portal flows bound by signed tokens + cookie | `apps/api/src/auth/middleware.ts`, `apps/api/src/config.ts`; tests `apps/api/src/config-hardening.test.ts`, `apps/api/src/app.test.ts` (CSRF cases), `apps/portal/src/index.test.ts` (forged CSRF 403) | MAC spoofing on open SSIDs (inherent) | — |
| T11 | Replay | portal credential single-use with retransmit horizon, bound to NAS/MAC; FreeRADIUS duplicate detection + `acct_unique_id`; Idempotency-Key replays without re-revealing secrets | `apps/api/src/internal/portal-credential.ts`, `apps/api/src/internal/aaa.ts`; tests `apps/api/src/portal.integration.test.ts` ("single-use credential is gone"), `apps/api/src/units.test.ts` (idempotency) | Disconnect replay inside the tunnel on NAS without Event-Timestamp | — |
| T12 | Unauthorized policy modification | `policy:*` permissions org-scoped, every mutation audited (a committed mutation without audit is logged as a bug), `policy_translations` append-only, migrations as platform role | `apps/api/src/http/route.ts`, `apps/api/src/audit.ts`, `apps/api/src/routes/policies.ts`; tests `apps/api/src/enforcement.integration.test.ts`, `tests/security/db-security.test.ts` (append-only) | insider with Org Admin | four-eyes (future) |
| T13 | Accounting tampering | per-NAS secret + Message-Authenticator; `ecloud_radius` INSERT-only on `radius.radacct_raw`; append-only triggers on parent and every partition (UPDATE/DELETE raise even for owner) | `packages/db/migrations/009_radius_schema.sql`, `010_rls_and_grants.sql`; tests `tests/security/db-security.test.ts` (radius role, append-only) | MD5-based accounting authenticator vs. a secret holder | optional hash chain (design) |
| T14 | Denial of service | body limits; rate limits (auth fail closed, exports fail open); portal per-IP/site caps; separate portal process; container memory/cpu/pids limits (drafted §2.2 values); nftables per-source SSH limit, fail2ban (drafted); RADIUS not public | `apps/api/src/app.ts`, `apps/api/src/internal/portal.ts`; `infra/vps/compose/compose.pilot.yaml`, `infra/vps/nftables/ecloud.nft`, `infra/vps/fail2ban/` | volumetric attacks on the single IP (Q17) | per-key API limits (F-P10-05) |
| T15 | Exposed databases / internal services | dev: all publishes on 127.0.0.1; pilot: postgres/redis without `ports:`, api internal listener (3001) and worker health never published, Redis `requirepass`, DOCKER-USER drop of NEW from `ens3`, Caddy 404 on `/readyz` `/metrics` `/internal` (all drafted) | `infra/compose/docker-compose.dev.yml`; `infra/vps/compose/compose.pilot.yaml`, `infra/vps/nftables/docker-user.sh`, `infra/vps/caddy/sites/ezecloud.caddy`; local smoke test §6.3 | host compromise | — |
| T16 | Internal services via overlay | `wg0` input: only udp 1812/1813 to 100.100.0.1 (+ICMP), everything else dropped; forward: no `wg0`↔`wg0`, no `wg0`→Internet; DOCKER-USER: `wg0` → containers only RADIUS to the hub address (drafted) | `infra/vps/nftables/ecloud.nft`, `docker-user.sh`; validate-local §6.1 | hub-side RADIUS bug reachable from any site | — |
| T17 | Supply chain | lockfile v3, `npm ci`; **CI now**: lockfile integrity gate (registry.npmjs.org + sha512 only), `npm audit signatures`, `npm audit --omit=dev --audit-level=high` gate, CycloneDX SBOM (npm) + per-image SBOM, image build + Trivy gate (CRITICAL with fix) from the digest-pinned official image; base images pinned by digest and OS-upgraded at build (P10-A) | `.github/workflows/ci.yml` (`supply-chain`, `images`), `scripts/security/check-lockfile.mjs`, `infra/docker/Dockerfile`, `infra/freeradius/Dockerfile`; results §5–§6 | zero-days; apt packages unpinned | Actions pinned by tag not SHA, no Renovate/Dependabot (F-P10-21) |
| T18 | Host operator compromise | sshd drop-in (`PermitRootLogin no`, keys only, `AllowUsers`, no agent/X11 forwarding, `LogLevel VERBOSE`), fail2ban, secrets root:10001 0440 outside the repo, apply scripts gated by `ECLOUD_APPROVED_CHANGE` + dead-man (drafted) | `infra/vps/ssh/`, `infra/vps/scripts/`, docs/SECRETS_MANAGEMENT.md | single operator with NOPASSWD sudo + docker group (accepted for pilot, D-024) | deploy identity (D-024), auditd/AIDE (F-45), token files on host (Q20) — owner items (F-P10-19) |

## 2. SECURITY.md baseline checklist

| Item | Status | Where |
|---|---|---|
| TLS for web/API in production | DRAFTED | Caddy ACME + HSTS (`infra/vps/caddy/sites/ezecloud.caddy`); apps refuse non-secure cookies in production |
| Strong password hashing | IMPLEMENTED | argon2id (`packages/db/src/admin.ts`) |
| RBAC / least privilege | IMPLEMENTED | `apps/api/src/auth/authorize.ts`; DB roles + RLS |
| Secure admin sessions / tokens | IMPLEMENTED (+P10-A) | opaque hashed tokens, idle/absolute expiry, `__Host-` + Secure enforced in production |
| CSRF protection | IMPLEMENTED | `apps/api/src/auth/middleware.ts`; portal signed CSRF tokens |
| Strict input / schema validation | IMPLEMENTED | zod per route (`apps/api/src/http/route.ts`) |
| Parameterised DB access | IMPLEMENTED | Kysely; no `sql.raw` in app code |
| Brute-force / abuse controls | IMPLEMENTED (+P10-A) app side; DRAFTED host side | rate limits; atomic MFA attempts; fail2ban jails + app events |
| Secrets outside source control | IMPLEMENTED (+P10-A) | check-no-secrets CI; `_FILE` support; `scripts/secrets/` |
| Protect RADIUS shared secrets | IMPLEMENTED (sealed, per NAS) / GAP (key ring, dual window, renderer) | §1 T5 |
| Restrict database exposure | IMPLEMENTED dev / DRAFTED pilot | no `ports:` on postgres/redis in the pilot file |
| Minimal public ports | DRAFTED | 22, 80, 443 (+udp), 51820 only (`docs/VPS_CHANGE_LIST.md` §5) |
| Audit privileged actions | IMPLEMENTED | `apps/api/src/audit.ts`, route-level audit enforcement |
| Dependency and patch management | IMPLEMENTED (+P10-A CI gates) | §5 |
| Backup encryption / access controls | cycle P10-B | `scripts/backup/`, docs/RESTORE_DRILL.md |
| Log rotation and retention | DRAFTED (Caddy roll, journald for api/portal); daemon.json/journald cap by P10-B | `infra/vps/caddy/`, P10-B drafts |

## 3. Production gate note

SECURITY.md requires a review of all externally reachable services and auth paths before
production acceptance. This review covers the code and the drafted host configuration. It is
**not** that gate: the live review against `ss -lntup`, the applied Caddyfile, nftables and the
rendered FreeRADIUS clients happens after D-031 approval (SECURITY_ARCHITECTURE §11, Phase 11).

## 4. Findings

### 4.1 Fixed in P10-A (with tests)

| Id | Severity | Finding | Fix | Test |
|---|---|---|---|---|
| F-P10-01 | Medium | MFA verify counted attempts with a read-modify-write of the challenge JSON: parallel requests on one challenge each saw the same count. Reproduced in-process: 12 parallel requests → **6** reached the code check (limit 5) with the old code; with Redis latency the window is wider. No per-IP limit on `/auth/mfa/verify`. | atomic `INCR` on `<challenge>:attempts` (TTL = challenge TTL), challenge burnt when exceeded, per-IP limit (30/5 min, fail closed) | `apps/api/src/auth/mfa-verify.test.ts` (fails on the old code: "expected 6 to be 5") |
| F-P10-02 | Medium | No machine-readable auth-failure events, so the fail2ban `ecloud-admin` / `ecloud-portal` jails of SECURITY_ARCHITECTURE §2.4 had nothing to match | `apps/api/src/security-events.ts` (`admin_login_failed`, `admin_mfa_failed`, `admin_invitation_failed`), portal `portal_auth_failed` / `portal_auth_rate_limited`; `event` then `ip`, never e-mail/password/code/token | `mfa-verify.test.ts`, `apps/portal/src/index.test.ts`; fail2ban-regex §6.1 |
| F-P10-03 | Medium | Secrets could only be passed as environment variables (visible in `docker inspect`, `/proc/*/environ`) contrary to §6.11 / §9 | `<NAME>_FILE` for every secret-bearing variable (`resolveSecretFiles`, shared by api/portal/worker); conflicting/unreadable/empty files refused without leaking values or paths | `packages/shared/src/secret-files.test.ts` |
| F-P10-08 | Low | API accepted `SESSION_COOKIE_SECURE=false` and a cookie name without `__Host-` in production (the portal already refused insecure cookies) | production refuses both | `apps/api/src/config-hardening.test.ts` |
| F-P10-09 | Low | Log redaction missed several credential key names | added `pepper`, `mfa_token`, `recovery_code`, `api_key`/`apiKey`, `private_key`/`privateKey`, `preshared_key`/`presharedKey`, `User-Password`, `CHAP-Password` | `packages/shared/src/logger-redaction.test.ts` |
| F-P10-10 | Low | `INTERNAL_API_TOKEN` rotation forced an AAA outage (single accepted token) | optional `INTERNAL_API_TOKEN_PREVIOUS` (`_FILE` supported; production: ≥ 32 chars, ≠ current); both comparisons always run | `apps/api/src/internal/token-rotation.test.ts` |
| F-P10-11 | Medium | Base images pinned by tag only and carrying fixable CRITICAL CVEs (Debian `perl-base` in node bookworm-slim; OpenSSL in the nginx-unprivileged and FreeRADIUS bases) | tag **and** digest pins; `apt-get upgrade` / `apk upgrade` at build | Trivy before/after §6.2 |
| F-P10-12 | Low | `.env.example` did not list `MFA_ENCRYPTION_KEY`, `DATA_ENCRYPTION_KEY`, `VOUCHER_PEPPER`, the cookie/proxy knobs or the `_FILE` convention | documented (placeholders only) | secrets scan OK |
| F-P10-13 | High (if applied as designed) | Design-level hazards in SECURITY_ARCHITECTURE §2.3/2.5: (a) dead-man rollback `nft flush ruleset` and Ubuntu's stock `/etc/nftables.conf` (`flush ruleset`) would delete Docker's NAT/FORWARD rules → q-mira.com outage on rollback or `systemctl reload nftables`; (b) a single global SSH `limit rate` can be exhausted by scanners → operator lock-out; (c) no rule for DHCPv4 renewals on `ens3` (public IPv4 is DHCP) → loss of the address at lease renewal; (d) Caddy's HTTP/3 udp/443 not allowed | drafts use an idempotent create/delete of `table inet ecloud` only, an include-only `nftables.conf`, per-source SSH meters, explicit DHCP and udp/443 rules | `infra/vps/scripts/validate-local.sh` (§6.1) |

### 4.2 Listed (not fixed in P10-A)

| Id | Severity | Finding | Recommendation |
|---|---|---|---|
| F-P10-04 | Medium | Envelope keys (`MFA_ENCRYPTION_KEY`, `DATA_ENCRYPTION_KEY`) have no key id / key ring: in-place rotation makes every sealed TOTP secret, NAS/UAM secret and controller credential undecryptable (docs/SECRETS_MANAGEMENT.md R4/R5 describe the only safe interim procedure) | `v2.<kid>.…` envelope format + key ring config + background re-wrap job; keep `v1` readable |
| F-P10-05 | Medium | No per-API-key / per-tenant request rate limit on the public API (T6); every invalid Bearer token costs a DB lookup | Redis fixed-window per key and per org (fail open), per-IP throttle on invalid keys |
| F-P10-06 | Medium | NAS secret rotation has no dual-secret window (SECURITY_ARCHITECTURE §4.1); a NAS rejects until reconfigured | dual client definitions during the window once the renderer exists |
| F-P10-07 | High (pilot readiness) | The production FreeRADIUS `clients.conf` renderer from `nas_clients` does not exist yet; the pilot `freeradius` service is therefore behind a Compose profile and VPS-RADIUS-1 is blocked | implement the worker renderer (0600, read-only mount, `RADIUS_CLIENTS_RENDERED=1`) |
| F-P10-14 | Low | `npm audit` (dev): 7 advisories (5 high, 2 moderate) all via `tailwindcss` 3 → `chokidar`/`fast-glob`/`micromatch`/`braces`, `postcss-nested`/`postcss-selector-parser` — build-time CSS tooling of `apps/admin`, not in any runtime image (production audit: 0). Fix requires tailwindcss 4 (major) | schedule the tailwind 4 migration; CI reports dev advisories (artifact), gates production only |
| F-P10-15 | Low | Admin test image: nginx 1.28.2 in `nginxinc/nginx-unprivileged:1.28.2-alpine` has 1 CRITICAL + 6 HIGH fixed only in 1.28.3 (no newer upstream image digest at review time) | local-testing image only (production serves the SPA from Caddy, D-030); CI scans it report-only; bump when upstream publishes |
| F-P10-16 | Low | `/readyz` on the public listener reveals dependency status | blocked at the edge (Caddy 404); optionally move to the internal listener |
| F-P10-17 | Info | `/metrics` (cycle P10-B) is unauthenticated on the internal listener, reachable from every container on `ecloud_internal` | acceptable inside zone 2; Caddy answers 404; consider a scrape token if untrusted containers join the network |
| F-P10-18 | Planned | TOTP is phishable in real time (T1 residual) | WebAuthn (SECURITY_ARCHITECTURE §6.2 Phase 10 upgrade) |
| F-P10-19 | Owner | Host items outside the repo: deploy identity (D-024), auditd/AIDE (F-45), token files on the host (Q20), OVH console (Q17) | owner decisions; listed in docs/VPS_CHANGE_LIST.md |
| F-P10-20 | Low (functional) | The worker resolves `secret_ref` only as `env:`/`file:`, while the API seals NAS secrets as `enc:v1` → CoA/Disconnect for API-created NAS records cannot get the secret (CoA is off, D-006) | decide whether the worker holds `DATA_ENCRYPTION_KEY` (wider key exposure) or the API renders CoA secrets; resolve before enabling CoA |
| F-P10-21 | Low | GitHub Actions referenced by tag (`actions/checkout@v4`, …), no Renovate/Dependabot | pin by commit SHA + automated update PRs |
| F-P10-22 | Info | Pilot FreeRADIUS `read_only` + tmpfs paths and the root:10001 0440 secret model are not runtime-verified on Linux (Docker Desktop on macOS does not enforce bind-mount ownership like Linux) | verify on the first approved host run |

## 5. Dependencies (SCA), lockfile, SBOM

| Check | Result (2026-10-09, local, npm 10.9.7 / Node 22.22.2) |
|---|---|
| `npm audit --omit=dev` | **0** vulnerabilities (exit 0) |
| `npm audit` (incl. dev) | 7 (moderate 2, high 5, critical 0) — all F-P10-14 (tailwindcss 3 chain, build-time only) |
| `npm audit signatures` | 565 packages with verified registry signatures, 141 with verified attestations |
| `node scripts/security/check-lockfile.mjs` | OK: 619 registry packages, all `sha512` + `https://registry.npmjs.org/`; negative test (git URL + missing integrity) exits 1 with both problems |
| `npm sbom --sbom-format cyclonedx --omit=dev` | CycloneDX 1.5, 175 components |
| CI | `supply-chain` job: lockfile gate → `npm ci` → signatures → production audit gate (high) → full audit artifact → SBOM artifact (90 days). No new tool dependency (npm built-ins + a 60-line script) |

## 6. Containers and host drafts

### 6.1 Host drafts — `bash infra/vps/scripts/validate-local.sh`

```
nftables v1.0.9 (Old Doc Yak #3)
PASS  nftables: nft -c + idempotent apply + Docker table survives (Ubuntu 24.04 nft)
PASS  DOCKER-USER: idempotent apply + rollback (iptables-nft)
v2.11.7 h1:yj0Y4fYZGPkSvibBJ1sTWE33xC0fxztVyXEW5iIdUT4=
PASS  caddy: validate + fmt with q-mira stand-in + import
OpenSSH_9.6p1 Ubuntu-3ubuntu13.19, OpenSSL 3.0.13 30 Jan 2024
PASS  sshd: sshd -t + effective settings win over a later drop-in (Ubuntu 24.04 OpenSSH)
Fail2Ban v1.1.0
Failregex: 3 total      (admin filter: login/mfa/invitation with an address; "unknown" not matched)
Failregex: 1 total      (portal filter: rate-limited lines not counted)
PASS  fail2ban: filters match the app's security events only
validate-local: 5 passed, 0 failed
```
Also: shellcheck (koalaman/shellcheck:stable) clean for `infra/vps/scripts/*.sh`,
`infra/vps/nftables/docker-user.sh`, `scripts/secrets/*.sh`; actionlint 1.7.12 clean for
`.github/workflows/ci.yml`; `docker compose -f infra/vps/compose/compose.pilot.yaml config -q`
OK. Ubuntu 24.04 ships fail2ban 1.0.2 (the test used 1.1.0 from Alpine; filter syntax is the
same).

### 6.2 Images — Trivy 0.75.0 (`aquasec/trivy@sha256:af6acf9a…`), HIGH+CRITICAL

| Image | Before (M9 build, tag-pinned) | After (P10-A Dockerfiles) |
|---|---|---|
| api (node 22.23.3 bookworm-slim) | 52 HIGH / 4 CRITICAL; fixable: 3 CRITICAL + 4 HIGH (`perl-base`) | 48 HIGH / 1 CRITICAL, **0 fixable** |
| portal / worker | same base as api (+ worker: unfixed `freeradius-utils` CRITICALs from Debian) | same node-runtime fix (worker/portal not rebuilt locally; CI builds all) |
| admin (nginx-unprivileged 1.28.2-alpine) | 65 HIGH / 3 CRITICAL, all fixable | 9 HIGH / 1 CRITICAL, all in nginx 1.28.2 itself (F-P10-15) |
| freeradius (3.2.10, Ubuntu 22.04) | 4 HIGH fixable (OpenSSL) | **0** HIGH/CRITICAL |
| npm packages inside images | 0 | 0 |

CI gate: `--severity CRITICAL --ignore-unfixed --exit-code 1` on api, worker, portal, freeradius
(after the fix the api gate exits 0 locally); HIGH + unfixed reported, CycloneDX per image.

Digests pinned (multi-arch index digests as resolved locally, 2026-10-09):

| Base | Digest |
|---|---|
| `node:22.23.3-bookworm-slim` | `sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392` |
| `nginxinc/nginx-unprivileged:1.28.2-alpine` | `sha256:7377697a821c131a924a7105fafbe7414db4e9fcc77a6f08f776f33f141ec3f8` |
| `freeradius/freeradius-server:3.2.10` | `sha256:cc7fd136e7b03e7b332d94297530318e824a4ecfedbce54562cced723e71e812` |
| `postgres:16-alpine` (pilot compose) | `sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea` |
| `redis:7-alpine` (pilot compose) | `sha256:858f009f9709ce576febc734aa78b8f6d624b82571f9ddb6bda4377c833b3499` |

Container re-check (infra/docker, M9 + P10-A): non-root (`node` 1000, nginx 101, `freerad` 101),
tini PID 1, root-owned app files, read-only rootfs + `/tmp` tmpfs, `cap_drop: ALL`,
`no-new-privileges`, pids/memory/cpu limits, npm/corepack removed from runtime images, no
secret `ARG`/`ENV`, `.dockerignore` excludes env/secret material, `HEALTHCHECK` without curl.
Not pinned: apt/apk package versions (upgraded at build; reproducibility traded for patch level).

### 6.3 Pilot Compose smoke test (local, throw-away project)

`postgres` + `db-roles` + `redis` from `compose.pilot.yaml` with secrets generated by
`scripts/secrets/generate.sh pilot`: db-roles exit 0 on first and second run (idempotent);
roles `ecloud_app` (bypassrls f), `ecloud_platform` (t), `ecloud_radius` (f); scram login over
the network with the file password works, a wrong password fails; Redis `NOAUTH` without and
`PONG` with the password; **0** `PASSWORD=` entries in `docker inspect` env of both containers.
Project removed (`down`, then its two volumes by name); the shared dev stack was not touched.

## 7. Verification of this cycle

See the P10-A hand-off report for the exact command outputs (build, lint, format:check,
`npm test`, secrets scan, targeted integration suites).

## 8. Independent review of P10-A (2026-10-09) and fix round

Verdict: **PASS WITH FIXES**. Findings and outcome (review ids F-P10R-n):

| Id | Severity | Finding | Outcome |
|---|---|---|---|
| F-P10R-1 | HIGH | `apply-caddy.sh` ran `caddy validate` as root, which creates root-owned 0600 access logs the `caddy` service cannot open; the subsequent reload could fail after the live Caddyfile had already been swapped, with no restore (q-mira.com down at the next restart) | **Fixed**: validate as the service user (`runuser -u caddy`), chown any stray log files, and on a failed reload / `is-active` / q-mira verify restore the backup, remove `ezecloud.caddy` and reload again. `rollback` uses the same restore path |
| F-P10R-2 | MEDIUM | `respond @ecloud_private 404` never fired on the `ezecloud.ezelink.ai` vhost (Caddy orders `handle` before `respond`): `/readyz`, `/metrics`, `/internal` returned the SPA with 200 | **Fixed**: `handle @ecloud_private { respond 404 }`. New behaviour check in `validate-local.sh` serves the real site file and asserts 404 on all three vhosts + SPA 200; it fails on the old file (regression proven) |
| F-P10R-3 | MEDIUM | freeradius publishes `100.100.0.1:1812-1813/udp`, which cannot bind before `wg0` exists; Docker may start first after a reboot; apply order put WG after APP | **Fixed (draft)**: `infra/vps/systemd/docker.service.d/10-ecloud-wg0.conf` (VPS-WG-3, `Wants=`/`After=` wait-online for `wg0`), apply order now `VPS-WG-*` before `VPS-APP-*`. Wait-online state for a peerless `wg0` is REQUIRES_HOST_TEST |
| F-P10R-4 | LOW/MED | per-source SSH meter can be exhausted with spoofed SYNs from a known operator address; allow-list and fail2ban `ignoreip` were optional/placeholder | **Fixed**: `apply-nftables.sh admins <IPs>` writes the host-local `/etc/nftables.d/zz-ecloud-admins.nft`, loaded in the same transaction as the table (and at boot); `apply` refuses with an empty list unless `ECLOUD_NO_SSH_ALLOWLIST=1`. New precondition PRE-6 (allow-list + `ignoreip`). Harness covers the transaction |
| F-P10R-5 | LOW | `INTERNAL_API_TOKEN_PREVIOUS` has no expiry | **Mitigated**: api logs a warning at startup while it is set; runbook R1 already removes it after the window |
| F-P10R-6 | LOW (CI blocker) | `check-no-secrets` flagged `scripts/drills/failure-drills.ts:46` | Owned by P10-B; resolved in its fix round |
| F-P10R-7 | LOW | `generate.sh` repo-path guard skipped without git; dev-material regex could reject a valid random value (~1e-5); `unseal.sh` lost custom `--db-host`; `apply-nftables.sh confirm` could persist after the dead-man fired; `apply-sshd.sh` could exit with the drop-in installed but no dead-man | **Fixed**: without git only `var/secrets/` is accepted; `generate.sh` re-draws values matching the shared `SECRETS_DEV_RE`; `unseal.sh` forwards only `--db-host/--db-name/--redis-host` (never `--rotate`/`--out`); `confirm` in both scripts refuses when the change is no longer in place; sshd dead-man armed before any display pipeline |
| F-P10R-7b | LOW | CI actions pinned by tag, not SHA; Trivy gate is CRITICAL-with-fix only; `admin` image not gated | **Accepted residual**: SHA pinning listed for the CI identity work (D-024); admin image is local-testing only (production serves the SPA from Caddy) |

Claims corrected: "404 on every public vhost" is now true and asserted by behaviour; "locally
validated: Caddy" now covers syntax **and** routing behaviour, still not permissions/reload on
the real host (the F-P10R-1 fix addresses that path by construction, not by a host test).
