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

### 2A. NAS client hot-reload without FR restart
Affected files:
  infra/freeradius/raddb/mods-available/rest
  infra/freeradius/raddb/clients.conf
  apps/api/src/routes/nas-clients.ts (new callback endpoint)
  packages/db/migrations/034_nas_reload_events.sql

Implementation:
  FreeRADIUS 3.2 supports a virtual client lookup via rlm_rest.
  Add a `client_map` subsection to mods-available/rest pointing to
  GET /internal/radius/client?src_ip=<IP>&secret_length=<N>.
  API returns { ipaddr, secret, require_message_authenticator: true }.
  This eliminates the restart requirement for new NAS registrations.
  Existing clients.d file kept as a startup cache for performance.

Tests:
  - Register new NAS via API; send test Access-Request; verify Accept without FR restart.
  - Remove NAS secret; verify subsequent request is Rejected (not leaked Accept).

Rollback:
  Revert mods-available/rest to previous version; FR continues using static clients.d.

### 2B. Stale session sweep automated test
Affected files:
  apps/worker/src/jobs/stale-sweep.ts
  apps/worker/src/jobs/stale-sweep.test.ts (new)

Implementation:
  Write unit tests using a test DB:
    1. Insert active session with last_interim_at = now() - stale_ttl - 1.
    2. Run sweep().
    3. Assert session.status = 'stale'.
  Add integration test via testcontainers (PostgreSQL) for full pipeline.

### 2C. Second FreeRADIUS replica
Affected files:
  infra/vps-local/compose/compose.vps-local.yaml
  infra/freeradius/ (no code change needed; stateless container)

Implementation:
  Add freeradius-2 service with separate RADIUS_LISTEN_PORT=11812 (behind port alias).
  nginx UDP stream block load-balances 1812 -> freeradius-1:1812 and freeradius-2:1812.
  Both containers share the same rlm_sql DSN and rlm_rest endpoint.
  NAS configured with primary auth-server = EZECLOUD:1812, secondary = EZECLOUD:1812.
  Note: NAS must use the same shared secret for both servers (same NAS entry in DB).

Tests:
  - Kill freeradius-1; verify freeradius-2 accepts requests.
  - Restart freeradius-1; verify both replicas accept.

---

## Phase 3 — Local / public / hybrid deployment (RadSec + VPN)

Priority: HIGH — required before any remote NAS deployment.
Addresses: G1 (RadSec), deployment modes B and C.

### 3A. RadSec listener (TLS over TCP 2083)
Affected files:
  infra/freeradius/raddb/sites-available/radsec (new)
  infra/freeradius/raddb/certs/ (TLS cert + CA)
  infra/freeradius/raddb/mods-available/tls (new)
  infra/vps-local/compose/compose.vps-local.yaml (port 2083)
  packages/db/migrations/035_nas_radsec.sql (new: nas_clients.radsec_cert_sha256)

Implementation:
  Create sites-available/radsec using the same inner authorize/post-auth/accounting
  sections as the UDP site.  Reference mods-available/tls for cert paths.
  Add EZECLOUD internal CA (self-signed, 10-year, 4096-bit).
  Add nas_clients.radsec_cert_sha256 for per-NAS cert pinning (optional).
  Document: never expose port 2083 without TLS client cert requirement.

Tests:
  - radsec-client --cert test-client.pem sends Access-Request; verify Accept.
  - Invalid cert -> verify Reject/TLS handshake failure.

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
