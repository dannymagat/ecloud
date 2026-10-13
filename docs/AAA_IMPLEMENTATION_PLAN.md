# AAA Implementation Plan — EZECLOUD / EZECONTROL
Version 1.0  |  2026-10-12

This plan converts the gaps identified in AAA_AUDIT.md into concrete, independently testable
phases.  Each phase lists affected files, deliverables, tests, and rollback procedure.

Gap IDs referenced: G1-G10 (critical), H1-H5 (high-priority) from AAA_AUDIT.md.
Feature classifications: Implemented-tested / Implemented-untested / Partially / Planned / Missing.

---

## Phase 2 — Core FreeRADIUS hardening and hot-reload

Priority: HIGHEST — blocks all other phases.
Addresses: H4 (stale sessions), R2 (NAS hot-reload), R3 (single SPOF).

### 2A. NAS client hot-reload without FR restart — DONE (commit ec93e7a), feature off by default

CORRECTION to the original plan: there is no `client_map` subsection in rlm_rest, in 3.2 or
any other release, and the claim contradicted this repo's own verified note at
clients.conf:20 (SIGHUP re-reads modules but NOT clients, verified on this image). The
supported mechanism is the `dynamic-clients` virtual server, which the pinned image ships as
sites-available/dynamic-clients. A packet from an unknown address inside a declared network
runs a fake, EMPTY request whose only useful attribute is Packet-Src-IP-Address; whatever
that server puts in the control list becomes the client definition, cached for `lifetime`.

Delivered:
  apps/api/src/internal/radius-client-lookup.ts   GET /internal/radius/client?ip=<address>
  apps/api/src/internal/radius-client-lookup.test.ts  (13 cases)
  infra/freeradius/raddb/mods-available/rest_clients          (second rlm_rest instance)
  infra/freeradius/raddb/sites-available/ecloud-dynamic-clients
  infra/freeradius/raddb/clients.conf                        (client ecloud_dynamic block)
  infra/freeradius/{Dockerfile,docker-entrypoint.sh,README.md}
  infra/vps/compose/compose.pilot.yaml, infra/vps-local/compose/ecloud.env.example

No migration was needed: nas_clients already holds the address, sealed secret, shortname and
require_message_authenticator. The planned 034_nas_reload_events.sql was not written.

A second rlm_rest instance is required because a module's section is selected by the name of
the calling section, and the dynamic-clients server has only `authorize`, which the main
instance already uses for /internal/aaa/authorize.

Security: this is the only endpoint that returns a NAS shared secret, so it refuses to serve
when the FreeRADIUS -> api leg is cleartext in production (F-002 acknowledges cleartext for
User-Password; every NAS secret is a different matter). Unknown / inactive / deleted /
undecryptable / malformed all answer 404 with no body, so it cannot enumerate registered NAS.

Server limits that cannot be configured away, both documented for operators:
  - the dynamic network MUST be a network; /32 and /128 are rejected;
  - at most ONE new client is added per second;
  - a rotated secret takes effect after `lifetime` seconds (default 300).

Status: VERIFIED_FROM_SOURCE. The image builds and both `freeradius -C` checks pass with the
module and virtual server linked in ("Loaded virtual server ecloud_dynamic_clients"). NOT yet
LAB_VALIDATED: no RADIUS packet has been admitted through this path, because that needs a
source address inside the dynamic network — a contract-suite or lab test. RADIUS_DYNAMIC_
CLIENT_SUBNET therefore defaults to TEST-NET-2 (198.51.100.0/24), i.e. off.

Rollback: set RADIUS_DYNAMIC_CLIENT_SUBNET back to 198.51.100.0/24. The static rendered
clients.d file is untouched and still wins for every NAS it contains (most specific network
matches first).

### 2B. Stale session sweep automated test — ALREADY COMPLETE, do not re-schedule

The planned files do not exist and are not the right names: the sweep is
apps/worker/src/jobs/reap.ts, and it is already tested.

  apps/worker/src/jobs/reap.test.ts:6,9,15   the rule itself (cutoff = now − (2 × interval +
                                              grace); last interim else start time; strictly
                                              beyond the threshold), plus authorization
                                              expiry (D-036) at :44-45
  apps/worker/src/attribution.integration.test.ts:218,251  the pipeline: stale sessions closed
                                              by the reaper after the grace period, and a
                                              stale session revived by a Start is not reaped
                                              on its old timestamp (F5)

AAA_TEST_RESULTS.md previously marked this untested; corrected in commit a6c267d.

### 2C. Second FreeRADIUS replica — DEFERRED, and the plan as written does not work

Three problems, so this is not scheduled:

1. It does not provide the HA it claims. Both replicas would run on vps-local, which is the
   single point of failure. A second container survives a crash of radiusd and nothing else —
   not a host reboot, a kernel panic, a power loss or a disk failure. Real redundancy needs a
   second host, which the pilot does not have (D-041, D-043).
2. The nginx it depends on is gone. The plan load-balances UDP 1812 through an nginx stream
   block; the owner retired nginx on vps-local when EZECLOUD took ports 443/444.
3. Round-robin across replicas breaks EAP. EAP is a multi-round-trip conversation with
   per-session state held in the server; without affinity, the second packet of an exchange
   can reach the replica that knows nothing about it. PAP/CHAP/MAB are unaffected, but 802.1X
   and PEAP/TTLS (Phase 4) would be.

The cheaper and more correct answer for NAS-level redundancy is the NAS's own secondary
RADIUS server setting, pointed at a second HOST once one exists, with the same per-NAS secret.
That is a deployment decision for the owner, not code.

Revisit when: a second host exists, OR the owner accepts process-level-only restart
protection and EAP stays disabled.
---

## Phase 3 — Local / public / hybrid deployment (RadSec + VPN)

Priority: HIGH — required before any remote NAS deployment.
Addresses: G1 (RadSec), deployment modes B and C.

### 3A. RadSec listener (TLS over TCP 2083) — IMPLEMENTED, feature off by default

CORRECTIONS to the original plan: no `mods-available/tls` module exists or is needed (the TLS
block lives in the listen section); the site reuses the `ecloud` virtual server through
`virtual_server = ecloud` instead of copying its sections; no certificate is committed under
raddb/certs (mounted at runtime, like EAP); the migration is 034, and pinning is by certificate
SERIAL (required, not optional), not by a sha256 column.

Delivered:
  infra/freeradius/raddb/sites-available/ecloud-radsec   listener + `ecloud-radsec` client list
  infra/freeradius/raddb/policy.d/ecloud                  ecloud_tls_identity (authorize + preacct)
  infra/freeradius/raddb/sites-available/ecloud-inner     copies the identity into the EAP tunnel
  infra/freeradius/raddb/mods-config/sql/.../queries.conf packet_tls_client_cn / _serial
  infra/freeradius/{Dockerfile,docker-entrypoint.sh}      opt-in link, F-008 check, schema check
  packages/db/migrations/034_nas_radsec.sql               nas_clients.radsec_*, radacct_raw columns
  packages/shared/src/radsec.ts                           one acceptance rule for API and worker
  apps/api/src/internal/aaa.ts                            resolveNas cert path, cache key
  apps/worker/src/accounting/drain.ts                     accounting attributed by certificate
  scripts/radsec-ca.sh                                    CA, server set, per-NAS issuance

Two isolation defects of the first draft were found and fixed before commit: the retransmit /
decision cache key did not include the certificate (two NAS behind one NAT address shared a key),
and RadSec accounting would have been attributed by the NAT source address.

Tests: packages/shared/src/radsec.test.ts (4), apps/api/src/units.test.ts (cache key),
apps/api/src/radsec.integration.test.ts (11), apps/worker/src/radsec-attribution.integration.test.ts
(2; both fail with the drainer branch disabled).

Status: VERIFIED_FROM_SOURCE plus a local live run (infra/freeradius/README.md §9): a real RadSec
connection to the 3.2.10 image delivered the CN and serial to the API and to radacct_raw, and
handshakes without a certificate or from a foreign CA were refused. NOT LAB_VALIDATED: no vendor
NAS has connected. An Access-Accept through the real API over RadSec has not been run.

Open (REQUIRES_CLARIFICATION):
  - an admin path to enrol a NAS (radsec_enabled + serial); today it is a direct row update;
  - a RadSec NAS still needs a unique nas_ip (ck_nas_clients_nas_ip_by_adapter);
  - CoA / Disconnect cannot reach a NAS behind NAT;
  - where the RadSec CA key lives and who may issue;
  - publishing TCP 2083 (pilot is LAN-only, D-043).

### 3B. WireGuard configuration guide
Affected files:
  docs/AAA_DEPLOYMENT.md (section: VPN setup)
  infra/wireguard/wg0.conf.example (new)

Implementation:
  WireGuard peer config for remote NAS -> EZECLOUD VPS.
  NAS sends RADIUS to FreeRADIUS internal IP over WireGuard tunnel.
  Include: key generation, allowed IPs, MTU recommendation (1420).

Tests:
  Manual VPN bring-up test with a test NAS or WireGuard client emulator.

### 3C. rlm_rest TLS verification
Affected files:
  infra/freeradius/raddb/mods-available/rest

Implementation:
  Uncomment ca_file, set tls_min_version = "1.2".
  Add EZECLOUD internal CA cert to FR container.
  Confirm: openssl s_client from FR container -> API returns valid chain.

Tests:
  FR sends auth request while API uses self-signed cert from EZECLOUD CA; verify Accept.
  Revoked cert (key mismatch): verify FR rejects connection.

---

## Phase 4 — External identity providers and captive portal completion

Priority: HIGH — required for enterprise Wi-Fi and social login use cases.
Addresses: G2 (LDAP), G7 (OIDC/SAML), G8 (OTP), G5 (external RADIUS proxy).

### 4A. LDAP / Active Directory integration
Affected files:
  infra/freeradius/raddb/mods-available/ldap (new)
  apps/api/src/internal/aaa-ldap.ts (new)
  packages/db/migrations/036_identity_provider_ldap.sql (new)

Implementation:
  EZECLOUD-side: when identity_providers.type='ldap', aaa-ldap.ts performs:
    - ldapjs BIND with user DN and supplied password.
    - If BIND succeeds -> Accept.
    - Return group membership for VLAN/policy selection (memberOf attribute).
  FreeRADIUS: rlm_ldap configured for BIND-only (does not need cleartext password).
  Store: identity_providers.config = { host, port, base_dn, user_dn_template, tls: bool }.
  Secret: identity_providers.client_secret_ref = bind password (envelope-encrypted).

Tests:
  Unit: mock ldapjs; verify bind success -> Accept, bind failure -> Reject.
  Integration: test against OpenLDAP container (testcontainers).

### 4B. External RADIUS proxy
Affected files:
  infra/freeradius/raddb/proxy.conf (new)
  infra/freeradius/raddb/sites-available/ecloud-proxy (new)
  apps/api/src/internal/aaa.ts (proxy routing decision)
  packages/db/migrations/037_external_radius.sql (new: external_radius_servers table)

Implementation:
  When NAS sends auth and user's identity_provider is 'radius_proxy', API returns:
    { code: 'Proxy', realm: 'proxy-<ext_radius_id>' }
  FreeRADIUS ecloud site intercepts Proxy code, routes to rlm_realm -> proxy.conf entry.
  proxy.conf entries rendered from external_radius_servers table on FR start (same
  pattern as clients.d).

Tests:
  Unit: mock external RADIUS returns Access-Accept; verify EZECLOUD Accept.
  Unit: mock external RADIUS returns Access-Reject; verify Reject.

### 4C. OTP (email / SMS)
Affected files:
  apps/api/src/internal/otp.ts (new)
  apps/api/src/routes/portal-otp.ts (new)
  packages/db/migrations/038_otp_tokens.sql (new)

Implementation:
  otp_tokens table: id, organization_id, user_id, code_hash, expires_at, used_at, channel.
  POST /portal/otp/send: generate 6-digit code, hash with Argon2id (fast params), send
    via configured SMS (Twilio) or email (SMTP/SES) provider.
  POST /portal/otp/verify: verify code, issue broker token on success.
  Codes expire in 10 minutes, single-use.
  Rate-limit: max 5 OTP sends per user per 15 min.

Tests:
  Unit: code generation, hash, expiry, single-use enforcement.
  Integration: mock SMS provider; verify end-to-end send -> verify flow.

### 4D. OIDC social login (Google, generic OIDC)
Affected files:
  apps/api/src/internal/oidc-flow.ts (new)
  apps/api/src/routes/portal-oidc.ts (new)
  packages/db/migrations/039_oidc_state.sql (new)

Implementation:
  GET /portal/oidc/start: generate state + PKCE verifier, redirect to provider.
  GET /portal/oidc/callback: exchange code for ID token, verify signature, extract sub.
  Upsert user (identity_providers.type='oidc'|'google'), issue broker token.
  PKCE required. No implicit flow.
  State expires in 10 minutes.

Tests:
  Unit: mock OIDC provider; verify state validation, PKCE exchange, sub extraction.

### 4E. Guest self-registration
Affected files:
  apps/api/src/routes/portal-signup.ts (new)
  packages/db/migrations/040_guest_signup_policy.sql (new)

Implementation:
  POST /portal/signup: create user (origin='portal_signup') with captive portal's
  default guest policy, optional email verification.
  Rate-limit: max 3 signups per IP per hour.

---

## Phase 5 — Authorization, quotas, and CoA hardening

Priority: HIGH — required for production quota enforcement.
Addresses: H3 (CoA not lab-tested), outstanding CoA gaps.

### 5A. Lab-test CoA on MikroTik and CoovaChilli
  Synthetic test NAS instances (Docker RouterOS emulator or real lab hardware).
  Confirm: Disconnect-ACK, CoA bandwidth change (MikroTik), Disconnect on quota breach.
  Document evidence in AAA_TEST_RESULTS.md.
  Update adapter evidence[] arrays from REQUIRES_DEVICE_TEST to VERIFIED.

### 5B. Per-NAS CoA rate limit
Affected files:
  apps/worker/src/coa/dispatcher.ts

Implementation:
  Add Redis sliding-window rate limit: max N CoA requests per NAS per minute (configurable).
  Exceed limit: job delayed, not dropped.

### 5C. Voucher mid-session expiry enforcement
Affected files:
  apps/worker/src/jobs/enforcement.ts (extend)
  packages/db/migrations/041_enforcement_voucher_expiry.sql (new)

Implementation:
  Scheduled job checks vouchers.expires_at < now() for all active sessions.
  Triggers Disconnect or CoA per session_enforcement strategy.

### 5D. require_eap flag for 802.1X-only NAS
Affected files:
  packages/db/migrations/042_nas_require_eap.sql (new: nas_clients.require_eap)
  apps/api/src/internal/aaa.ts (enforce flag)
  infra/freeradius/raddb/policy.d/ecloud (enforce in authorize section)

Implementation:
  If nas_clients.require_eap=true and request is PAP (not EAP): return Reject.
  Prevents PAP downgrade on 802.1X-only switches.

---

## Phase 6 — Multi-vendor adapters and admin dashboard AAA modules

Priority: MEDIUM.
Addresses: H1 (missing vendors), admin modules.

### 6A. UniFi adapter
Affected files:
  packages/adapters/src/adapters/unifi-radius.ts (new)
  packages/adapters/src/adapters/unifi-radius.test.ts (new)

### 6B. Omada adapter
Affected files:
  packages/adapters/src/adapters/omada-radius.ts (new)

### 6C. Aruba adapter (WISPr + Aruba-User-Role)
Affected files:
  packages/adapters/src/adapters/aruba-instant.ts (new)

### 6D. RADIUS flow tester endpoint
Affected files:
  apps/api/src/routes/radius-test.ts (new)

Implementation:
  POST /radius/test { nas_client_id, username, password, method }
  Runs the full authorize() path in dry-run mode (no session created).
  Returns: { decision, attrs_emitted, policy_id, reject_reason, checks: [...] }.
  Credentials redacted from response (show only first/last char of password).
  Requires 'radius:test' permission (admin only).
  Never emits RADIUS packets; logic-only trace.

### 6E. Admin dashboard AAA modules
Affected files:
  apps/portal/src/pages/aaa/ (new directory — 15 modules listed in spec)

Implementation:
  Build React pages wiring to existing API routes.
  Priority order: Online Users, CoA/Disconnect, NAS Registration, Voucher Management,
  Auth Logs, RADIUS Test, Bandwidth Profiles, External RADIUS.

---

## Phase 7 — EAP-TLS and PKI

Priority: MEDIUM (required for enterprise WPA3-Enterprise deployments).
Addresses: G3 (EAP-TLS).

### 7A. EAP-TLS in FreeRADIUS
Affected files:
  infra/freeradius/raddb/mods-available/eap (extend tls block)
  infra/freeradius/certs/ (new: CA, server cert, CRL)

Implementation:
  Add tls { ... } section in eap module with:
    private_key_file, certificate_file, ca_file, dh_file (2048-bit).
    check_crl = yes (link to CRL URL).
    cipher_list = "HIGH:!aNULL:!MD5:!SSLv3".
  Add rlm_rest callback for OCSP-stapling validation.
  Client cert enrollment: out-of-scope for Phase 7; document as requiring external PKI
  (e.g., step-ca, EJBCA, or cloud PKI).

Tests:
  openssl s_client -connect FR:1812 (via radtest) with client cert.
  Revoked cert (CRL) -> Reject.

---

## Phase 8 — Security hardening and production readiness

Priority: MEDIUM.
Addresses: R1-R9 from AAA_SECURITY.md, standing security audit findings.

### 8A. Fix DRAFT banners in live configs
  Remove "DRAFT, NOT APPLIED" from:
    infra/vps-local/edge/ecloud-edge.conf:1
    infra/vps-local/firewall/docker-user.sh:1

### 8B. Firewall race window
  Add ExecStartPre to docker-user.service to re-arm rules before Docker starts.
  Test: reboot VM; verify DOCKER-USER rules active before first container starts.

### 8C. Key rotation runbooks
  MFA_ENCRYPTION_KEY rotation: encrypt new; dual-read old+new; re-encrypt; retire old.
  DATA_ENCRYPTION_KEY rotation: same pattern.
  VOUCHER_HMAC_KEY rotation: script to re-hash all vouchers.
  Document in docs/runbooks/key-rotation.md.

### 8D. Minimum reject delay
  Add 150 ms floor to every Reject response in aaa.ts to reduce timing side-channel.
  Keep it below typical NAS timeout (5 s) to avoid unnecessary retransmits.

### 8E. Export rate-limit Redis failure
  Change hitLimitFailOpen -> failClosed for auth-related rate limiters.
  Export rate limiter may remain fail-open (documented risk accepted).

---

## Sequencing and dependencies

  Phase 2 (NAS hot-reload, stale tests, replica)  ->  unblocks Phase 3 deployment
  Phase 3 (RadSec, VPN, rlm_rest TLS)             ->  unblocks remote-NAS onboarding
  Phase 4 (LDAP, OTP, OIDC)                       ->  unblocks enterprise + social auth
  Phase 5 (CoA lab, quotas, require_eap)           ->  unblocks production enforcement
  Phase 6 (vendors, tester, dashboard)             ->  unblocks operator self-service
  Phase 7 (EAP-TLS, PKI)                          ->  unblocks WPA3-Enterprise
  Phase 8 (hardening)                              ->  gates production sign-off

---

END OF AAA_IMPLEMENTATION_PLAN.md
