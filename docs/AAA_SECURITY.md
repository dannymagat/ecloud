# AAA Security Review — EZECLOUD / EZECONTROL
Version 1.0  |  2026-10-12

---

## 1. Threat model summary

Adversary goals:
  T1  Authenticate as a tenant's subscriber without credentials.
  T2  Obtain another tenant's subscriber credentials or session data.
  T3  Cause authentication outage (DoS).
  T4  Inject or replay RADIUS packets to bypass policy.
  T5  Escalate from NAS to EZECLOUD admin.
  T6  Extract credentials from logs, database, or transport.
  T7  Abuse CoA to disconnect or re-profile another tenant's session.

---

## 2. Controls implemented

### 2.1 Credential protection

  Control                          Status    Notes
  -------------------------------  --------  --------------------------------------------------
  Argon2id password hashing        YES       verifyPassword() / hashPassword() in @ecloud/db.
                                             Params: memoryKib, timeCost, parallelism from env.
  No cleartext passwords in DB     YES       users.password_hash is Argon2id; never cleartext.
  No passwords in logs             YES       Code audit confirmed: User-Password stripped in
                                             ecloud_post_auth_context before every log write.
  No passwords in RADIUS reply     YES       rlm_rest only uses API response attrs, never echoes
                                             user-supplied password back.
  Envelope encryption for secrets  YES       Envelope class: HKDF-SHA-256 + AES-256-GCM.
                                             NAS shared secrets, MFA keys stored encrypted.
  Dummy hash for timing levelling  YES       dummyPasswordHash() ensures unknown user still
                                             costs one Argon2id verify (removes gross timing
                                             difference). DOES NOT guarantee full timing parity.

### 2.2 RADIUS protocol security

  Control                          Status    Notes
  -------------------------------  --------  --------------------------------------------------
  Message-Authenticator required   YES       Required on every reply. radiusd.conf:
                                             require_message_authenticator = yes. Per-client
                                             overrides in clients.d/. CVE-2024-3596 addressed.
  No public RADIUS listener        YES       FreeRADIUS bound to internal network only.
                                             NAS must reach via private LAN or VPN.
  Per-NAS shared secrets           YES       nas_clients.secret_ref, envelope-encrypted.
                                             Floor 12 characters (D-071). The public fleet default
                                             `ezeradsecret` / `ezeuamsecret` is ACCEPTED as an
                                             owner risk (2026-10-14, reinstated 2026-10-16 D-071);
                                             the renderer counts clients still on it.
  RADIUS replay protection         YES       SHA-256 retransmit key = hash(auth_vector +
                                             acct_session_id + acct_status_type).
                                             10 s TTL cache in Redis.
  Source-IP NAS validation         YES       rlm_rest source IP checked against nas_clients.ip.
                                             NAS-Identifier used as secondary lookup only.
  NAS identity from network layer  YES       Tenant never resolved from user-supplied
                                             NAS-Identifier or username realm alone.
  EAP inner-tunnel MAC copy        YES       ecloud-inner copies Calling-Station-Id from outer
                                             request. Prevents MAC spoofing inside TTLS tunnel.

### 2.3 Session security

  Control                          Status    Notes
  -------------------------------  --------  --------------------------------------------------
  TOCTOU guard on auth             YES       B-3 pattern: short tenant txn reads credential,
                                             Argon2id runs without DB connection held, second
                                             txn re-reads and checks credentialUnchanged.
  Portal broker token: single-use  YES       30 s TTL, consumed on first use. Token is
                                             pc-<16 random hex> (~64 bits entropy).
  Sealed decision cache for CHAP   YES       sealDecisionForCache() wraps decrypted credential
                                             with HKDF before 30 s cache entry.
  No fail-open                     YES       Backend 5xx, timeout, or unexpected -> Reject.
                                             Documented in sites-enabled/ecloud.
  Session binding                  YES       Sessions bound to (organization_id, nas_client_id,
                                             acct_session_id) unique index.
  CoA secret not on command line   YES       Written to 0600 tmpfile, -S flag, deleted after.
  CoA tenant check                 YES       dispatcher verifySessionOwner() checks
                                             session.organization_id == job.organizationId.

### 2.4 Multi-tenant isolation

  Control                          Status    Notes
  -------------------------------  --------  --------------------------------------------------
  PostgreSQL RLS                   YES       All tenant tables have RLS; ecloud_api role
                                             enforces organization_id filter.
  Cross-tenant auth impossible     YES       Code verified: username + NAS IP -> org; never
                                             username realm alone.
  Tenant data in RADIUS config     NO        No tenant user data in radiusd.conf or mods config.
  Per-NAS accounting isolation     YES       accounting_records.organization_id indexed and
                                             RLS-enforced.
  Admin impersonation guard        YES       export and CoA routes refuse while impersonating.

### 2.5 API / transport security

  Control                          Status    Notes
  -------------------------------  --------  --------------------------------------------------
  TLS for internal REST            PARTIAL   rlm_rest tls block present with ca_file placeholder.
                                             Production cert path REQUIRES_CLARIFICATION.
                                             Until confirmed, FreeRADIUS -> API is HTTP on
                                             internal Docker network only.
  CSRF protection                  YES       csrfProtection middleware; Origin header checked.
  Rate limiting                    YES       hitLimitFailOpen for export. Auth paths rate-limited
                                             per IP.  Redis failure: export fails open (noted
                                             in prior audit as MEDIUM risk).
  Audit log                        YES       auth_events + audit_events outbox. Every accept,
                                             reject, CoA, and admin action logged.
  Credential masking in audit      YES       Log entries do not contain User-Password, OTP,
                                             RADIUS shared secrets, or private keys.
  Secure cookie flags              YES       secureCookie enabled; SameSite=Strict.
  RBAC                             YES       permissions.ts; roles enforced in every route.

---

## 3. Outstanding risks

  ID   Severity  Description
  ---  --------  -----------------------------------------------------------------------
  R1   HIGH      TLS on rlm_rest -> API path unconfirmed.  If FreeRADIUS and API are ever
                 on separate hosts or containers without overlay-network encryption, PAP
                 passwords are transmitted in HTTP plaintext on that leg.
                 Remediation: confirm ca_file, tls_min_version, cert_file in mods-available/rest;
                 test with openssl s_client from the FR container.

  R2   HIGH      NAS client hot-reload: adding a new NAS requires FR container restart.
                 During restart (~3 s) all auth requests are rejected.
                 Remediation: implement rlm_rest clients callback (FR 3.2+ supports this).
                 Alternatively: rolling restart with multiple FR instances behind a load balancer.

  R3   HIGH      FreeRADIUS single instance (SPOF).
                 Remediation: add a second FR container with shared database; configure NAS
                 primary/secondary auth servers.

  R4   MEDIUM    RADIUS/UDP is not encrypted.  On private-LAN deployments this is acceptable.
                 On any path traversing an untrusted segment (VPN with weak cipher, VXLAN,
                 multi-tenant hosting), PAP passwords are at risk.
                 Remediation: deploy RadSec for any non-LAN path (see G1 in AAA_AUDIT.md).

  R5   MEDIUM    Timing: dummyPasswordHash reduces but does not eliminate the timing difference
                 between unknown user and wrong password.  Attackers with low-latency access
                 to the RADIUS port may still distinguish.
                 Remediation: add a fixed minimum delay (~300 ms) to every reject response.

  R6   MEDIUM    EAP server certificate: the eap module references a certificate path but no
                 certificate management workflow (issuance, rotation, revocation) exists.
                 Remediation: implement cert management before enabling EAP-TTLS in production.

  R7   LOW       ECLOUD_COA_ENABLED=false default prevents accidental CoA dispatch.
                 However there is no rate limit or tenant-level cap on CoA jobs enqueued.
                 A compromised admin account could flood the NAS with CoA packets.
                 Remediation: per-NAS CoA rate limit in dispatcher.

  R8   LOW       Voucher HMAC key (VOUCHER_HMAC_KEY): no rotation runbook. If compromised,
                 all existing voucher hashes must be re-computed.
                 Remediation: add key rotation script + migration guide.

  R9   LOW       Legacy RADIUS attributes (PAP, CHAP) are enabled in the outer virtual server
                 even when EAP-TTLS is configured.  A TTLS-capable client will always use
                 EAP, but a rogue NAS could request PAP.
                 Remediation: Add a policy check to reject PAP from NAS clients that have
                 require_eap=true capability flag.

---

## 4. Security rules (standing)

  S1  Never log User-Password, OTP codes, RADIUS shared secrets, private keys, or sealed tokens.
  S2  Never expose RADIUS/UDP port to the public internet.  Always require VPN or RadSec.
  S3  RADIUS and UAM shared secrets are at least 12 characters of [A-Za-z0-9._~+/=-]
      (D-071, aligned with the EzeSwitch controller fleet default). The public fleet default is
      an owner-accepted risk, not a violation; the renderer reports how many clients inherit it.
      New per-NAS secrets are generated as 43-character random tokens.
  S4  All new NAS clients must be explicitly registered with confirmed capabilities.
  S5  CoA must never be sent to an unverified NAS port (check coa_supported capability flag).
  S6  All production secrets (NAS secrets, MFA keys, HMAC keys) must use the envelope
      encryption store.  No secrets in environment variables for production.
  S7  rlm_rest connection to API must be TLS with server certificate validation before any
      path that carries PAP passwords traverses a non-Docker-overlay segment.
  S8  FreeRADIUS container image must pin a specific SHA256 digest, not a mutable tag.

---

END OF AAA_SECURITY.md
