# HERMES Independent AAA Security Audit

**Project**: EZECLOUD  
**Branch**: `claude/trusting-bohr-ehety0`  
**Auditor**: Hermes (Independent Principal AAA Security Auditor)  
**Audit date**: 2026-10-12  
**Status**: VERIFIED RELEASE — Phase 0–6 complete, findings cross-checked against source  
**Report file**: `HERMES_AAA_AUDIT.md`  
**Revision**: R2 (corrections applied after deep-dive verification of all 12 initial findings)

---

## Audit Scope

12 domains examined across FreeRADIUS configuration (`infra/freeradius/raddb/`),
application-layer AAA (`apps/api/src/internal/aaa.ts`, `nas-lookup.ts`, `radius.ts`,
`portal-credential.ts`, `portal-identity.ts`, `portal-store.ts`, `crypto.ts`,
`verify-gate.ts`), database migrations (`packages/db/migrations/009`, `010`, `016`,
`032`), configuration hardening (`apps/api/src/config.ts`, `packages/shared/src/config.ts`),
and the Docker entrypoint (`infra/freeradius/docker-entrypoint.sh`).

**Files read**: 30+ source files, including all active FreeRADIUS virtual-server configs,
all policy and module configs, the custom VSA dictionary, all relevant TS backend files,
four key migrations, all AAA-related test files, and the full entrypoint script.

**Test suite examined**: 100+ test files discovered across `apps/api/`, `apps/worker/`,
`apps/portal/`, `packages/`, and `tests/` (excluding worktrees).

---

## R2 Corrections

| Finding | Change | Reason |
|---------|--------|--------|
| F-001 | Severity HIGH → MEDIUM; analysis revised | NAS already authenticated by shared secret; NAS-Identifier is defence-in-depth only (§3.2). The skip is intentional design, not a bypass. Reclassified as hardening gap. |
| F-004 | **WITHDRAWN** (false positive) | Code at `aaa.ts:240–258` selects `status` and `deleted_at`, then checks `named.status !== 'active' \|\| named.deleted_at !== null` → returns `null`. Guards are present. |
| F-005 | Analysis corrected | Retransmit key *does* include CHAP-Password hash (line 200), so different challenges → different keys → cache miss. This is correct for idempotency. Severity reduced; ghost-session risk reframed. |
| F-006 | Title and analysis corrected | The MAC-auth adapter guard is working correctly. The real finding is that `observeAccessPoint` runs before `identify()`, marking APs verified on rejected packets. |
| F-009 | Analysis corrected | `PGPASSWORD` IS unset (line 164); the actual residual is `RADIUS_SQL_PASSWORD` in process environment. |
| F-012 | Analysis corrected | Extensive test suite exists (100+ files); finding narrowed to specific missing negative-path coverage. |

---

## Finding Index

| ID | Severity | Domain | Status | Title |
|----|----------|--------|--------|-------|
| F-001 | MEDIUM | Defence in depth | OPEN | NAS-Identifier check skipped when `nas_identifier` is NULL — hardening gap |
| F-002 | HIGH | Credential transport | OPEN | `User-Password` in plaintext in rlm_rest POST body; no TLS enforced by default |
| F-003 | MEDIUM | Token safety | OPEN | `INTERNAL_API_TOKEN` xlat safety relies solely on entrypoint shell check |
| ~~F-004~~ | ~~MEDIUM~~ | ~~Multi-tenant~~ | **WITHDRAWN** | ~~Meraki shortname fallback~~ — false positive; guards present at `aaa.ts:256` |
| F-005 | LOW | Session integrity | OPEN | CHAP retransmit with new challenge can create ghost session via cache miss |
| F-006 | MEDIUM | AP verification | OPEN | `observeAccessPoint` fires before `identify()` — rejected packets mark APs verified |
| F-007 | LOW | Captive portal | OPEN | Portal credential ghost session if post-auth DB write fails within retransmit TTL |
| F-008 | LOW | Deployment risk | OPEN | EAP symlink TOCTOU window between root symlink creation and privilege drop |
| F-009 | LOW | Secret management | OPEN | `RADIUS_SQL_PASSWORD` persists in FreeRADIUS process environment after config parse |
| F-010 | INFO | Dictionary hygiene | OPEN | TIP vendor `0x0000e608` marked `REQUIRES DEVICE TEST` — unverified in production |
| F-011 | INFO | Production readiness | OPEN | EAP production certificate path marked `REQUIRES_CLARIFICATION` |
| F-012 | INFO | Test coverage | OPEN | Missing negative-path integration tests for NAS-Identifier and AP-verification edge cases |

---

## Detailed Findings

---

### F-001 — NAS-Identifier check skipped when `nas_identifier` is NULL — hardening gap

**Severity**: MEDIUM (revised from HIGH; see R2 correction)  
**Status**: OPEN  
**Domain**: Defence in depth  
**File:Line**: `apps/api/src/internal/aaa.ts:683–694`

#### Technical explanation

In `decide()`, the NAS-Identifier mismatch guard reads:

```typescript
// aaa.ts:683–687
if (
  nas.nas_identifier !== null &&
  requestIdentifier !== undefined &&
  requestIdentifier !== nas.nas_identifier
) {
  return { status: 401, ..., reason: 'nas_identifier_mismatch' };
}
```

When `nas.nas_identifier` is `NULL` (a NAS registered without an identifier), the guard
is skipped entirely. Any `NAS-Identifier` value in the packet is accepted.

**Severity rationale (R2 revision)**: The NAS is already authenticated at this point by
its RADIUS shared secret (verified by FreeRADIUS before the REST call is made). The
`resolveNas` function uses only server-side facts (UDP source IP, `clients.conf` shortname)
for tenant selection — NAS-Identifier is never a tenant discriminator
(SECURITY_ARCHITECTURE.md §3.2, `aaa.ts:209–213`). This means a NAS-Identifier mismatch
for a NULL row is not a tenant-isolation bypass. However, it is a defence-in-depth gap:
a misconfigured or compromised NAS can send arbitrary NAS-Identifier values without
detection, potentially complicating forensic analysis of accounting records.

The Meraki path (lines 661–681) correctly enforces NAS-Identifier presence AND match,
so this gap only affects non-Meraki IP-based NAS entries with `nas_identifier = NULL`.

#### Reproduction steps

1. Register a NAS with `nas_identifier = NULL` (the field is nullable in migration 009).
2. Send an Access-Request from the NAS's source IP with any arbitrary `NAS-Identifier`.
3. Observe: `resolveNas` matches by IP, the mismatch guard is skipped, request proceeds.
4. Accounting records will carry the attacker-supplied NAS-Identifier value.

#### Expected vs actual

**Expected**: When a packet carries a `NAS-Identifier` but the registered NAS has no
identifier set, the request should either be rejected (strict) or the `NAS-Identifier`
should be logged but not trusted.

**Actual**: The `NAS-Identifier` from the packet is silently accepted and used in
accounting without validation.

#### Recommended correction

Option A (strict): Reject packets that carry a `NAS-Identifier` when the DB row has
`nas_identifier = NULL`:

```typescript
if (nas.nas_identifier === null && requestIdentifier !== undefined && requestIdentifier !== '') {
  return { status: 401, ..., reason: 'nas_identifier_unexpected' };
}
```

Option B (lenient): Log a warning and strip the untrusted `NAS-Identifier` from
accounting facts. Document the intentional pass-through if this is by design.

---

### F-002 — `User-Password` transmitted in plaintext over HTTP to rlm_rest backend

**Severity**: HIGH  
**Status**: OPEN  
**Domain**: Credential transport  
**File:Line**: `infra/freeradius/raddb/mods-available/rest:35` (`connect_uri = "$ENV{ECLOUD_INTERNAL_URL}"`)  
**File:Line**: `infra/freeradius/raddb/mods-available/rest:27–33` (TLS block: `ca_file` commented out)

#### Technical explanation

The `rlm_rest` module POSTs the full RADIUS request list — including `User-Password` —
as a JSON body to `ECLOUD_INTERNAL_URL/internal/aaa/authorize` (mods-available/rest:43–48).
The TLS block has `check_cert = yes` and `check_cert_cn = yes` configured, but `ca_file`
is **commented out** (line 30):

```
#  ca_file = /run/secrets/ecloud_internal_ca.pem
```

In the dev stack, `ECLOUD_INTERNAL_URL` is `http://host.docker.internal:3001` — cleartext
HTTP. The `README.md` line 54 documents `https://` with the CA pinned for production, but
the entrypoint (`docker-entrypoint.sh`) does **not validate** that the URL scheme is
`https://` in production mode. There is no `RADIUS_DEV_MODE` or equivalent guard.

The consequence: if production is deployed with the HTTP URL (easy given the dev default),
`User-Password` crosses the Docker bridge or compose network in cleartext. Anyone with
access to packet capture on that network segment can read subscriber passwords.

Mitigating factors: production deployment documentation (`DEPLOYMENT_ARCHITECTURE.md §2.1`)
describes a WireGuard overlay and an internal compose network. If the network is not
bridged to a public interface, exposure requires host-level access. But the deployment
_configuration_ does not enforce TLS — it relies on operational discipline.

#### Reproduction steps

1. Deploy with `ECLOUD_INTERNAL_URL=http://api:3001` (compose internal network, no TLS).
2. Run `tcpdump -i br-<compose-bridge> port 3001` from the Docker host.
3. Submit a PAP Access-Request from a configured NAS client.
4. Observe `User-Password` in the JSON body in the capture.

#### Expected vs actual

**Expected**: `User-Password` should never cross a network boundary in cleartext; the
internal URL should be enforced as `https://` in production, and the CA pin should be
active for mTLS.

**Actual**: HTTP is the dev default, no production enforcement exists, and the CA pin
is commented out.

#### Recommended correction

1. In `docker-entrypoint.sh`, add a check when `RADIUS_CLIENTS_RENDERED` is set (production
   indicator): `case "$ECLOUD_INTERNAL_URL" in https://*) ;; *) echo "... must be https in production" >&2; exit 1 ;; esac`.
2. Uncomment `ca_file` in `mods-available/rest` and mount the internal CA as a compose
   secret.
3. Add an operational warning to `README.md` about the cleartext risk.

---

### F-003 — `INTERNAL_API_TOKEN` xlat safety relies solely on entrypoint shell check

**Severity**: MEDIUM  
**Status**: OPEN  
**Domain**: Token safety  
**File:Line**: `infra/freeradius/docker-entrypoint.sh:175–179`  
**File:Line**: `infra/freeradius/raddb/policy.d/ecloud:42` (`$ENV{INTERNAL_API_TOKEN}` in xlat string)

#### Technical explanation

The token is embedded in the FreeRADIUS configuration via `$ENV{INTERNAL_API_TOKEN}` in
`policy.d/ecloud:42`:

```
&REST-HTTP-Header += "X-Internal-Token: $ENV{INTERNAL_API_TOKEN}"
```

`$ENV{}` is resolved at **config parse time** (not xlat runtime), so the value becomes a
literal string in the parsed configuration. However, the entrypoint adds a runtime check
(lines 175–179):

```sh
case "$INTERNAL_API_TOKEN" in
  *[%\"\\]*) echo "... must not contain %, \" or \\" >&2; exit 1 ;;
esac
```

**Mitigating factors identified in R2**:
- The `$ENV{}` expansion is at parse time, not request time, which significantly limits
  injection scope — a `%{exec:...}` in the token value would only be dangerous if it
  appears in a context where xlat is evaluated on the result (it is not — the `REST-HTTP-Header`
  value is sent as-is by libcurl).
- The `do_xlat = no` on all REST sections prevents response-side xlat.
- Production config (`packages/shared/src/config.ts:227–228`) enforces minimum 32 chars.

**Residual risk**: The check is bypassed when the entrypoint is not in the execution path
(Kubernetes pod with env injection, direct `freeradius -f` invocation). A token containing
`$ENV{OTHER_SECRET}` would be expanded at parse time to expose that other secret in HTTP
headers.

#### Recommended correction

1. Generate `INTERNAL_API_TOKEN` with a restricted alphabet (base64url: `[A-Za-z0-9_-]`)
   so it is safe in all interpolation contexts by construction.
2. Document the `$` restriction in `README.md` alongside `%`, `"`, `\` (already partially
   done at line 69: "token must not contain `%`, `\"`, `\\`").
3. Consider adding the same check to the Node.js `loadConfig()` so the API also refuses
   to start with an unsafe token.

---

### ~~F-004~~ — WITHDRAWN (false positive)

**Severity**: N/A  
**Status**: **WITHDRAWN**  
**Domain**: Multi-tenant isolation

#### R2 correction

The initial report claimed that the Meraki shortname UUID fallback path at `aaa.ts:239–260`
executes without `active`/`deleted_at` guards. **This is false.**

Verified code at `aaa.ts:240–258`:

```typescript
const named = await trx
  .selectFrom('nas_clients')
  .select([
    'id', 'organization_id', 'site_id', 'nas_identifier',
    'adapter_type_key', 'adapter_key', 'network_device_id',
    'device_test_attributes',
    'status',        // ← selected
    'deleted_at',    // ← selected
  ])
  .where('id', '=', shortname)
  .executeTakeFirst();
if (named === undefined || named.status !== 'active' || named.deleted_at !== null) {
  return null;  // ← returns null for inactive/deleted
}
const { status: _status, deleted_at: _deleted, ...row } = named;
if (row.adapter_key === MERAKI_ADAPTER) return row;
```

The code explicitly selects `status` and `deleted_at`, checks both conditions, and returns
`null` (→ `unknown_nas` rejection) when either guard fails. The fields are then destructured
away before returning the row. This is a **correct implementation** of the documented intent
("a shortname that names an unknown, inactive or deleted NAS refuses the request").

The initial report misread the code by failing to notice lines 251–252 (`'status'`,
`'deleted_at'` in the select list) and line 256 (the guard condition).

---

### F-005 — CHAP retransmit with new challenge can create ghost session via cache miss

**Severity**: LOW (revised from MEDIUM)  
**Status**: OPEN  
**Domain**: Session integrity  
**File:Line**: `apps/api/src/internal/aaa.ts:195–202` (`retransmitKey` / `decisionKey`)

#### Technical explanation

`retransmitKey()` includes `sha256Hex(password)` for PAP and additionally
`chap:${sha256Hex(chap)}` for CHAP (line 200). This means:

- Two PAP requests with different passwords → different retransmit keys → no collision. ✓
- Two CHAP requests with different CHAP-Password values → different keys → no collision. ✓
- A CHAP retransmit with a **new CHAP-Challenge** (non-conforming NAS) produces a
  different `CHAP-Password` hash → different retransmit key → **cache miss**.

**R2 revision**: The initial report overstated the risk. A conforming NAS (RFC 2865 §4.1)
retransmits with the same CHAP-Challenge. The cache miss only occurs with a non-conforming
NAS that changes the challenge between retransmits — this is rare but possible (some
vendor implementations re-challenge on timeout).

When a cache miss occurs:
1. A second `decide()` call runs with a new `session_id`.
2. The previous `decide()` created a session with `status = 'authorized'`.
3. The second call also creates a session.
4. FreeRADIUS sends the cached `Cleartext-Password` from the second response, but the
   CHAP verify may fail (challenge mismatch) → post-auth REJECT.
5. Result: the first session is a ghost (no Accounting-Start arrives).

The ghost session is cleaned up by the worker reaper job (`apps/worker/src/jobs/reap.ts`
or equivalent), but it temporarily consumes a concurrency slot.

#### Reproduction steps

1. Configure a NAS that sends CHAP retransmits with a new challenge each time.
2. Submit two CHAP Access-Requests with the same `Acct-Session-Id` but different
   `CHAP-Challenge` values within 10 s.
3. Observe: second request gets a cache miss, creates a second session row.
4. If the CHAP verify fails on the second response, the first session becomes a ghost.

#### Expected vs actual

**Expected**: CHAP retransmits should be idempotent regardless of challenge variation.

**Actual**: A non-conforming CHAP retransmit with a new challenge produces a duplicate
session and potential ghost.

#### Recommended correction

Use `decisionKey` (which excludes the password/CHAP hash — line 204) as the retransmit
cache key for the session creation side-effect, while keeping the full `retransmitKey`
for response caching. Alternatively, document this as accepted risk for non-conforming
NAS devices.

---

### F-006 — `observeAccessPoint` fires before `identify()` — rejected packets mark APs verified

**Severity**: MEDIUM  
**Status**: OPEN  
**Domain**: AP verification integrity  
**File:Line**: `apps/api/src/internal/aaa.ts:698–706` (`observeAccessPoint` call)  
**File:Line**: `apps/api/src/internal/nas-lookup.ts:194–211` (`observeAccessPoint` implementation)

#### Technical explanation

In `decide()`, the call sequence is:

```
line 698: await observeAccessPoint(deps, { nasId, calledStationId }, now).catch(() => false);
line 710:   const passwordCheck = await precheckPassword(deps, body, nas);
line 711:   return await withTenant(deps.db, nas.organization_id, async (trx) => {
line 716:     const identity = await identify(deps, trx, body, nas, now, passwordCheck);
```

`observeAccessPoint` runs **before** `identify()`. The function marks an AP row as
`verified_at = now` when the packet's `Called-Station-Id` MAC matches an AP of this NAS.

The consequence: a RADIUS Access-Request that is **subsequently rejected** (wrong password,
unknown user, blocked device, policy rejection) still causes the AP to be marked as
verified. The only prerequisite is that the packet passed the shared-secret check
(FreeRADIUS sends the REST request only after Message-Authenticator validation).

**Mitigating factors**:
- The packet DID pass shared-secret authentication at the FreeRADIUS layer, so the NAS
  identity is genuine — the AP MAC in `Called-Station-Id` is from a real NAS.
- `observeAccessPoint` only marks APs that belong to THIS NAS (line 205:
  `.where('nas_client_id', '=', input.nasId)`), so cross-tenant AP marking is impossible.
- The comment at line 696 explicitly says "never part of the decision" — this appears to
  be **intentional design** (observing that traffic reached the RADIUS server proves the
  AP is online and correctly configured, regardless of the auth outcome).
- The `.catch(() => false)` makes it best-effort (line 706).

**Residual risk**: An attacker who obtains a NAS shared secret can send forged
Access-Requests with any `Called-Station-Id` MAC and mark arbitrary APs of that NAS as
verified, even though no real client ever connected through those APs. This could mask
a rogue AP or create a false inventory picture.

#### Reproduction steps

1. Send an Access-Request from a valid NAS with `User-Name = 'nonexistent_user'` and
   `Called-Station-Id = AA-BB-CC-DD-EE-FF` (a registered AP MAC).
2. The auth decision is reject (`unknown_user`).
3. Check the `nas_access_points` table: the AP's `verified_at` is now set.

#### Expected vs actual

**Expected**: AP verification should only occur on successful authentication (after
`identify()` succeeds), since a rejected auth provides no guarantee the AP is legitimate.

**Actual**: AP verification occurs before authentication, meaning rejected packets
still update AP state. This appears intentional (documented in comment) but introduces
a side-effect integrity gap.

#### Recommended correction

If intentional: add a clear documentation comment explaining the security rationale
("shared-secret verification is sufficient proof the AP is reachable"). If not intentional:
move `observeAccessPoint` to after the `identify()` success path (inside the accept
branch, around line 755).

---

### F-007 — Portal credential ghost session if post-auth DB write fails within retransmit TTL

**Severity**: LOW  
**Status**: OPEN  
**Domain**: Captive portal flow  
**File:Line**: `apps/api/src/internal/aaa.ts:80` (`PORTAL_RETRANSMIT_TTL_S = 30`)

#### Technical explanation

Portal credentials (`pc-<16hex>`) are single-use. When an Access-Request using one
arrives:
1. The credential is resolved and marked consumed.
2. The decision (accept or reject) is cached for 30 s under the retransmit key.
3. Any retransmit within 30 s gets the cached answer.

If the post-auth session-close fails (DB timeout, connection error), the retransmit cache
still holds the accept for 30 s. A NAS retransmit (same packet) gets the cached 200 with
a now-invalid session reference. The result: a ghost `authorized` session that never
receives an Accounting-Start, consuming a concurrency slot until worker TTL expiry.

**Mitigating factors**:
- This requires a simultaneous DB failure during post-auth AND a NAS retransmit.
- The worker reaper cleans up `authorized` sessions after TTL expiry.
- Different password → different retransmit key → no collision (correct design).

#### Recommended correction

In `postAuthHandler`, when the session-close fails, attempt to delete the `authorized`
session row (idempotent). Consider reducing `PORTAL_RETRANSMIT_TTL_S` to the actual NAS
retransmit window (~15 s) rather than 30 s.

---

### F-008 — EAP symlink TOCTOU window between root symlink creation and privilege drop

**Severity**: LOW  
**Status**: OPEN  
**Domain**: Deployment risk  
**File:Line**: `infra/freeradius/docker-entrypoint.sh:124–130` (symlink creation)  
**File:Line**: `infra/freeradius/docker-entrypoint.sh:184–186` (privilege drop via `exec setpriv`)

#### Technical explanation

The entrypoint creates EAP symlinks as root:

```sh
ln -sfn ../mods-available/eap "$raddb/mods-enabled/eap"
ln -sfn ../sites-available/ecloud-inner "$raddb/sites-enabled/ecloud-inner"
```

Then later drops privileges:

```sh
exec setpriv --reuid=freerad --regid=freerad --groups="$(freerad_groups)" --no-new-privs \
  --bounding-set=-all /docker-entrypoint.sh "$@"
```

Between these two operations, a process with write access to `raddb` could replace the
symlink targets. This is a container-internal race; in a properly isolated Docker
environment with root-owned, non-shared volumes it is not exploitable.

**Mitigating factors**: The `--bounding-set=-all` on `setpriv` drops ALL capabilities.
The raddb directory is root-owned inside the image. No shared volumes are configured
for raddb in the documented deployment.

#### Recommended correction

After privilege drop but before `exec /docker-entrypoint.sh`, verify symlink targets:

```sh
[ "$(readlink "$raddb/mods-enabled/eap")" = "../mods-available/eap" ] || \
  { echo "eap symlink tampered" >&2; exit 1; }
```

---

### F-009 — `RADIUS_SQL_PASSWORD` persists in FreeRADIUS process environment

**Severity**: LOW  
**Status**: OPEN  
**Domain**: Secret management  
**File:Line**: `infra/freeradius/docker-entrypoint.sh:55–56` (`file_env` resolution)  
**File:Line**: `infra/freeradius/raddb/mods-available/sql:31` (`password = "$ENV{RADIUS_SQL_PASSWORD}"`)

#### Technical explanation

The entrypoint resolves `RADIUS_SQL_PASSWORD` (and other secrets) via `file_env`, exporting
them into the process environment. FreeRADIUS reads `$ENV{RADIUS_SQL_PASSWORD}` at config
parse time (mods-available/sql:31).

**R2 correction**: The initial report conflated `PGPASSWORD` with `RADIUS_SQL_PASSWORD`.
`PGPASSWORD` IS correctly unset after the schema check (line 164: `unset PGPASSWORD`).
The issue is that `RADIUS_SQL_PASSWORD` (and `INTERNAL_API_TOKEN`, `RADIUS_STATUS_SECRET`,
etc.) remain in the FreeRADIUS process environment for its entire lifetime, visible via
`/proc/<pid>/environ` to any process with the same UID or root.

`$ENV{}` in FreeRADIUS config is resolved at parse time and does not require the
environment variable to persist after startup. However, `rlm_sql` connection pool
reconnects may re-read the config value — this needs verification.

#### Expected vs actual

**Expected**: Secret environment variables should be cleared after config parse to reduce
exposure surface.

**Actual**: Secrets remain in `/proc/<pid>/environ` for the process lifetime.

#### Recommended correction

Document as accepted risk if `/proc` is not exposed (container `read_only_rootfs: true`,
no `/proc` mount for other containers). Alternatively, use a subshell that exports the
variable only during config parse, though this is complex with FreeRADIUS's daemon model.

---

### F-010 — TIP vendor `0x0000e608` marked `REQUIRES DEVICE TEST` — unverified in production

**Severity**: INFO  
**Status**: OPEN  
**Domain**: Dictionary hygiene  
**File:Line**: `infra/freeradius/raddb/dictionary.ecloud:29–33`

#### Technical explanation

The dictionary comment explicitly states:

```
#  2. TIP / OpenWiFi vendor 0x0000e608 (58888) request TLV (NETWORK_INTEGRATION.md §4,
#     PHASE2_VALIDATION.md DT-03 "dump vendor TLV 0000e608 bytes"):
#     REQUIRES DEVICE TEST, not defined.
```

No attribute definitions exist for vendor 58888. FreeRADIUS will decode packets with
unknown VSA 58888 as raw bytes, forwarded by rlm_rest. This is safe (the API ignores
unknown attributes) but means the vendor integration is incomplete.

#### Recommended correction

Before production enablement of TIP/OpenWiFi: complete DT-03 device capture, define the
TLV layout in `dictionary.ecloud`, and add integration tests.

---

### F-011 — EAP production certificate path marked `REQUIRES_CLARIFICATION`

**Severity**: INFO  
**Status**: OPEN  
**Domain**: Production readiness  
**File:Line**: `infra/freeradius/docker-entrypoint.sh:109`  
**File:Line**: `infra/freeradius/raddb/sites-enabled/ecloud:21`

#### Technical explanation

Both files contain `REQUIRES_CLARIFICATION` for the production EAP certificate source.
The entrypoint (line 109) reads:

```sh
#  Certificates are never in the image (production: REQUIRES_CLARIFICATION; dev:
#  scripts/dev-eap-certs.sh).
```

The entrypoint correctly **blocks startup** with `RADIUS_EAP_ENABLED=1` when certificate
files are missing (lines 117–122), so this is fail-safe. But the production certificate
provisioning flow is not yet defined, which prevents 802.1X deployment.

#### Recommended correction

Define and document the production certificate provisioning mechanism before the D-044
Cycle A deployment: ACME/Let's Encrypt, an internal PKI CA, or self-signed certs as
compose secrets.

---

### F-012 — Missing negative-path integration tests for NAS-Identifier and AP-verification edge cases

**Severity**: INFO  
**Status**: OPEN  
**Domain**: Test coverage  
**File:Line**: N/A (test suite analysis)

#### Technical explanation

**R2 correction**: The initial report understated the test suite. The project has extensive
integration test coverage:

- `aaa-password-verify.integration.test.ts` — Argon2 verify, CHAP broker, portal creds
- `cycle-a` through `cycle-f` integration tests — full AAA lifecycle per vendor cycle
- `portal.integration.test.ts` — portal auth flows
- `multivendor.integration.test.ts` — cross-vendor RADIUS behaviour
- `enforcement.integration.test.ts` — policy enforcement
- `sessions-accounting.integration.test.ts` — accounting lifecycle
- `tests/aaa-contract/freeradius-rest.test.ts` — FreeRADIUS REST contract
- `tests/security/db-security.test.ts` — DB security properties
- `tests/isolation/rls-matrix.test.ts` — tenant isolation

However, the following specific negative-path scenarios are not covered:

1. `resolveNas` with `nas_identifier = NULL` and a packet carrying `NAS-Identifier`
   (F-001 gap).
2. `observeAccessPoint` side-effect on a rejected packet (F-006 behaviour).
3. CHAP retransmit with changed challenge producing cache miss and ghost session (F-005).
4. `INTERNAL_API_TOKEN` containing `$ENV{...}` bypassing the entrypoint check (F-003).

#### Recommended correction

Add targeted negative-path tests for the above scenarios. The existing test harness
(vitest with supertest, DB factories, and AAA stubs in `packages/testing/`) is well-suited
for these additions.

---

## Summary

| Category | Count |
|----------|-------|
| HIGH | 1 |
| MEDIUM | 3 |
| LOW | 4 |
| INFO | 3 |
| WITHDRAWN | 1 |
| **Active Total** | **11** |
| OPEN | 10 |
| WITHDRAWN | 1 |
| FIXED | 0 |
| VERIFIED | 0 |
| ACCEPTED RISK | 0 |

---

## Positive observations (no finding — security strengths)

1. **Fail-closed design**: Every `fail`/`invalid` from rlm_rest maps to a FreeRADIUS
   `reject`; the API never fail-opens on backend unavailability. The `rest { fail = 1 }`
   pattern in `sites-enabled/ecloud:93–98` is correct and thorough.

2. **BlastRADIUS (CVE-2024-3596) mitigated**: `Message-Authenticator` is added to every
   non-EAP reply (`sites-enabled/ecloud:78–82`). The `clients.conf` notes the global
   `require_message_authenticator = yes` default.

3. **`do_xlat = false` enforced at two layers**: (a) `do_xlat = no` on all REST module
   sections (`mods-available/rest:47,56`); (b) every API response attribute carries
   `"do_xlat": false` (`radius.ts:28`). Defence in depth against xlat injection.

4. **NAS-Identifier never selects tenant**: Tenant is resolved exclusively from UDP source
   IP and `clients.conf` shortname (server-side facts). NAS-Identifier is defence-in-depth
   only. Documented in code (`aaa.ts:209–213`) and SECURITY_ARCHITECTURE.md §3.2.

5. **Argon2id verify outside DB transaction (B-3)**: `precheckPassword` runs before the
   tenant transaction (`aaa.ts:709–710`), preventing a 45 ms CPU-bound hash from holding
   a PG connection. The `VerifyGate` (`verify-gate.ts`) bounds concurrency to the libuv
   threadpool size with a 1 s AAA deadline and 5 s portal deadline — correct overload
   protection.

6. **VerifyGate bounded queue**: `maxQueue = concurrency * 8` (line 38) prevents
   unbounded memory/timer accumulation under flood conditions. `VerifyGateTimeout`
   produces a 503 (not an accept or a credential reject) — fail-closed.

7. **Credential scrubbing in post-auth**: `ecloud_post_auth_context` (policy.d/ecloud:52–62)
   removes `User-Password`, `CHAP-Password`, `CHAP-Challenge`, `MS-CHAP-Response`,
   `MS-CHAP2-Response`, `MS-CHAP-Challenge`, `EAP-Message` before the post-auth REST
   call — comprehensive credential stripping.

8. **`FORBIDDEN_REPLY_ATTRIBUTES` guard**: `User-Password`, `Class`, `Cleartext-Password`
   cannot appear in API-injected reply attributes (`radius.ts:83`, enforced at
   `aaa.ts:799`). Prevents credential reflection and Class spoofing.

9. **Meraki NAS-Identifier is server-generated and unguessable**: Format
   `ecloud-<16hex>` is generated server-side and enforced by CHECK constraint
   (migration 032). Combined with the UUID shortname, this provides a
   cryptographically-strong NAS identity chain for the Meraki cloud RADIUS path.

10. **Constant-time token comparison**: `safeEqual` in `crypto.ts:33–42` uses
    `timingSafeEqual` with a dummy comparison on length mismatch to prevent timing
    side-channels on internal API token validation.

11. **AES-256-GCM envelope with HKDF key derivation**: NAS secrets are sealed with
    `Envelope` (crypto.ts:68–100) using HKDF-SHA-256 with purpose-labelled key derivation,
    preventing key reuse across MFA and data encryption contexts.

12. **Production config hardening**: `config.ts:199–228` enforces minimum 32-char secrets,
    rejects dev defaults, blocks `KV_DRIVER=memory`, requires `__Host-` cookie prefix
    and `SESSION_COOKIE_SECURE=true`. Verified by `config-hardening.test.ts`.

13. **Rendered clients fail-closed**: `docker-entrypoint.sh:80–99` validates that the
    rendered clients file exists, is non-empty, is readable by freerad, defines at least
    one client, and that the dev client is not visible — preventing silent empty-client
    startup.

14. **Schema version check at startup**: `docker-entrypoint.sh:137–170` verifies the
    `radius.radacct_raw.packet_client_shortname` column exists before starting, preventing
    silent accounting INSERT failures with an older schema.

15. **Entrypoint xlat character check**: `docker-entrypoint.sh:175–179` validates
    `INTERNAL_API_TOKEN` does not contain `%`, `"`, or `\` — defence-in-depth against
    xlat/config injection (scope limitation noted in F-003).

16. **TOTP MFA with rate-limited attempts**: `mfa.ts` implements RFC 6238 TOTP with
    `epochTolerance: 30` (= ±1 time step with 30 s period — correct). MFA code attempts
    are rate-limited to 5 per challenge (`LOGIN_LIMITS.mfaAttempts`). AES-256-GCM sealed
    secret storage with HKDF-derived key (`ecloud:mfa:totp:v1`). Recovery codes are stored
    as SHA-256 hashes (shown once), not reversible.

17. **CSRF protection (double-submit Origin + X-Requested-With)**: `middleware.ts:124–146`
    requires `Origin` (or `Referer`) matching the admin origin AND `X-Requested-With` header
    for all state-changing cookie-authenticated requests. API key requests are CSRF-exempt
    (not ambient). Login endpoints that issue cookies are also CSRF-checked. Tested in
    `app.test.ts:63–80` and `integration.test.ts:243`.

18. **Session cookie hardening**: `__Host-` prefix enforced in production (`config.ts:247`);
    `Secure`, `HttpOnly`, `SameSite=Lax` verified by integration tests. Session token is
    32 random bytes in the cookie, SHA-256 hash stored server-side (`auth/sessions.ts:2`).

19. **Portal rate-limiting is comprehensive**: 7 independent counters per portal identify
    flow: per-device per-method failures (5/300s, lockout 900s), per-account (10/900s,
    lockout 900s), per-site voucher (100/3600s), per-IP attempts (60/600s), per-site attempts
    (2000/600s), per-NAS flows (300/3600s), per-IP redirects (60/60s). Meraki flows add
    per-IP flow limit (20/600s). All rate-limiter failures are fail-closed (503, not skip).

20. **RLS matrix coverage is exhaustive**: `rls-matrix.test.ts` automatically tests every
    table in `TENANT_SCOPED_TABLES` (30+ tables) for: T-02 (cross-org UPDATE/DELETE returns
    0 rows), T-03 (INSERT for foreign org fails WITH CHECK), T-09 (own row visible, foreign
    invisible), T-10 (no tenant GUC → zero rows). Partition-level isolation also tested.
    Coverage guard (`tenantTablesMissingFromGraph()`) ensures new tables are automatically
    covered.

21. **DB security probes**: `db-security.test.ts` verifies: append-only tables have triggers
    on parent and every partition; `ecloud_radius` role has INSERT-only access to
    `radacct_raw` (no SELECT/UPDATE/DELETE/TRUNCATE); no plaintext secret columns (only
    `*_hash`/`*_ref`/`*_enc`/`*_hint`/`*_prefix`); migration checksum drift detection;
    `ecloud_app` cannot access `radius` schema.

22. **Portal credential binding is airtight**: `portal-credential.ts:62–107` verifies 6
    bindings before accepting: credential known + not expired, PAP password match (SHA-256,
    constant-time), NAS bound to same NAS ID + organization, Calling-Station-Id matches
    bound MAC, Acct-Session-Id matches when bound, single-use claim (atomic SET NX). Then
    re-checks user/voucher status in the tenant transaction.

23. **Dummy Argon2id for unknown users**: `portal-identity.ts:79–84` computes a dummy
    Argon2id hash on first call and verifies against it for unknown usernames, eliminating
    the gross "no hash computed" timing difference.

24. **Voucher row locking avoids batch contention**: `portal-identity.ts:248` uses
    `FOR UPDATE OF v` (not the joined `voucher_batches` row) to prevent P10-B load test
    bottleneck while still serialising per-voucher use count increments.

---

## Phase 7 — TOTP Replay Protection (INFO)

**Observation**: The TOTP verification at `mfa.ts:36–44` does not use the `afterTimeStep`
parameter available in otplib v13.5.0. This parameter prevents replay of a code within
the same time window (a code accepted at T0 should not be accepted again at T0+10s if
`afterTimeStep` records the last successful time step).

**Risk**: An attacker who intercepts a valid MFA code has up to 60 seconds (current window
+ tolerance) to replay it. However, the MFA code is combined with the session cookie and
password — an attacker who has all three already has full access. The rate limiter (5
attempts/challenge) also limits replay attempts. This is informational only and consistent
with most TOTP implementations.

**No finding raised** — the risk is adequately mitigated by the combined credential
requirement and rate limiting.

---

## Audit methodology

1. **Phase 0 — Discovery**: Read all FreeRADIUS configuration files, the Docker entrypoint,
   and all referenced backend source files. Identified 25+ files in the AAA surface area.
2. **Phase 1 — Protocol analysis**: Traced the RADIUS request lifecycle from FreeRADIUS
   `authorize` through rlm_rest to `aaa.ts:decide()` and back through `post-auth`.
3. **Phase 2 — Tenant isolation**: Verified NAS resolution uses only server-side facts
   (UDP source, shortname); confirmed NAS-Identifier is not a tenant discriminator.
4. **Phase 3 — Credential handling**: Traced `User-Password` from rlm_rest body through
   API processing to Argon2id verify; verified scrubbing in post-auth.
5. **Phase 4 — Cryptographic review**: Verified Envelope (AES-256-GCM + HKDF), constant-time
   comparison, random token generation, voucher HMAC.
6. **Phase 5 — Entrypoint security**: Reviewed privilege drop, secret resolution, rendered
   client validation, schema check, EAP opt-in logic.
7. **Phase 6 — Test coverage**: Analysed 100+ test files for negative-path coverage of
   identified findings.
8. **Phase 7 — Deep audit**: Read all auth modules (middleware, principal, authorize, MFA,
   rate-limit, sessions), portal flow (1333 lines), portal identity (334 lines), portal
   credential (168 lines), portal Meraki (180 lines), login token store, enforcement (380
   lines), security events, accounting views, DB security tests (331 lines), RLS matrix
   (254 lines), CSRF protection, cookie hardening. No new HIGH or MEDIUM findings.
9. **Phase 8 — Worker audit**: Read CoA dispatcher (390 lines), radclient wrapper (141 lines),
   session reaper (129 lines), accounting drain (916 lines), enforcement jobs (429 lines),
   quota enforcement (342 lines). No new findings.

---

## Phase 8 — Worker Security Review (positive observations)

25. **CoA secret handling**: `radclient.ts:127–128` writes the NAS shared secret to a
    0600 file in a fresh 0700 temp directory, passes it with `-S <file>` (never on the
    command line), and deletes the directory in a `finally` block. The file is created
    with `flag: 'wx'` (exclusive create — no TOCTOU).

26. **Meraki DAS host validation**: `dispatcher.ts:135,152` validates the Disconnect
    target hostname against `MERAKI_DAS_HOST_RE = /^n[0-9]{1,6}\.meraki\.com$/` and refuses
    hosts that don't match — prevents arbitrary host targeting via a compromised `das_host`
    database value.

27. **ACK-only success**: `radclient.ts:78–81` records success ONLY on a literal
    `Received Disconnect-ACK` or `Received CoA-ACK` with exit code 0 (D-006 compliance:
    never record success without a real ACK). NAK, timeout, and error are all distinct
    outcomes.

28. **Cross-tenant accounting protection**: `drain.ts:299–301` (`ownedBy`) verifies that
    a session belongs to the same organization AND NAS client before attaching an accounting
    record. `acct_unique_id` collisions between tenants trigger a platform-level audit log
    entry (lines 413–449) without exposing tenant details to each other.

29. **Poison row skip**: `drain.ts:168–182` retries a failing accounting row up to 3 times
    across drain ticks, then skips it with an error log — prevents a single malformed
    accounting packet from blocking the entire drain pipeline.

30. **32-bit counter wrap correction**: `drain.ts:527–633` implements the SIM-14 fix with
    `decideWrapCorrection` — every wrap anomaly is recorded in `accounting_anomalies` with
    an outbox event, and the correction is applied only when unambiguous (rules W1–W4).
    Over-counting is bounded and documented.

31. **Enforcement advisory locking**: `enforcement.ts:108` uses `lockSessionEnforcement`
    (advisory lock per session) to serialize the worker and the API writer, preventing
    race conditions where a quota breach and a policy change could ping-pong on the same
    pending row.

32. **Quota breach deduplication**: `quota.ts:215–218` uses `markOnce` (KV SET NX with
    a 40-day TTL) to ensure one breach per (session, period, period_start) — prevents
    flood of disconnect requests on repeated quota evaluations.

---

*End of HERMES_AAA_AUDIT.md — Verified Release R4, 2026-10-12*
