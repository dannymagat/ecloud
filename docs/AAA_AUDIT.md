# AAA Audit — EZECLOUD / EZECONTROL
Phase 1 Repository and Architecture Audit

Generated: 2026-10-12
FreeRADIUS version confirmed: **3.2.10** (Ubuntu 22.04 base, Dockerfile pin `sha256:cc7fd136...`)
Scope: All files under `infra/freeradius/`, `apps/api/src/internal/`, `apps/worker/src/coa/`,
       `packages/adapters/src/`, `packages/policy-engine/src/`, and all 33 DB migrations.

---

## 1. Classification key

  Implemented-tested    Working code backed by automated tests (1515 passing, 518 skipped).
  Implemented-untested  Code merged, compiles, no automated coverage for the path.
  Partially             Core path present; one or more required sub-features absent or blocked.
  Planned               Schema/stub present, no backend logic yet.
  Unsupported           Design-documented as not feasible on this stack; intentional.
  Missing               Required by the spec; not present at all.

---

## 2. FreeRADIUS architecture

The FreeRADIUS container is a **protocol front-end only**.

  Decision path:   NAS -> FreeRADIUS (UDP 1812) -> rlm_rest POST /internal/aaa/authorize -> EZECLOUD API
  Accounting path: NAS -> FreeRADIUS (UDP 1813) -> rlm_sql INSERT radius.radacct_raw
  Post-auth path:  FreeRADIUS -> rlm_rest POST /internal/aaa/post-auth  (informational, 204)
  CoA/DAS:         No FreeRADIUS DAS listener. The EZECLOUD worker sends CoA/Disconnect via
                   radclient to the NAS directly (RFC 5176, port 3799 or per-NAS coa_port).

No subscriber data, no policy rules, and no shared secrets live in FreeRADIUS configuration.
Everything sensitive is in the EZECLOUD PostgreSQL database or the secret store.

Virtual servers active:
  ecloud          (sites-enabled/ecloud)       — outer PAP/CHAP/MAB/EAP
  ecloud-meraki   (sites-enabled/ecloud-meraki) — Meraki cloud RADIUS listener
  ecloud-inner    (sites-available/ecloud-inner, opt-in) — EAP-TTLS inner tunnel

Modules active: rest, sql, eap (opt-in), mschap, chap, pap, filter_username,
                rewrite_calling_station_id, rewrite_called_station_id, acct_unique

NAS client registration: clients.conf includes clients.d/; rendered to clients.d/ecloud-nas.conf
by the radius-clients-cli from nas_clients table. FreeRADIUS 3.2 reads clients at start-up only —
a NAS change requires a container restart (verified, documented in infra/freeradius/README.md).

Fail-safe: no fail-open path. Backend 5xx / timeout -> reject. Documented in sites-enabled/ecloud
and aaa-authorize.md contract.

BlastRADIUS (CVE-2024-3596): Message-Authenticator injected into every reply
(sites-enabled/ecloud authorize section), require_message_authenticator = yes in radiusd.conf,
per-client in clients.conf. Addressed.

---

## 3. Authentication methods

### 3.1 RADIUS authentication

Method              Status                Notes
------------------- --------------------- -----------------------------------------------------
PAP                 Implemented-tested    EZECLOUD verifies Argon2id; returns Auth-Type=Accept
                                          or Auth-Type=PAP + Cleartext-Password for vouchers.
CHAP                Partially             Only via portal credential broker (MikroTik HTTP-CHAP
                                          path). Native CHAP (direct user password) unsupported
                                          by design: EZECLOUD stores one-way Argon2id hashes.
MS-CHAPv2           Unsupported           Same reason. mschap module present for the future
                                          but the authorize section never routes to it for
                                          direct user auth. Documented in sites-enabled/ecloud.
EAP-TTLS/PAP        Implemented-untested  Opt-in (RADIUS_EAP_ENABLED=1). Inner PAP only.
                                          ecloud-inner virtual server copies NAS facts from
                                          outer request (MAC/NAS spoof prevention). Tested
                                          in syntax check; no end-to-end automated test.
EAP-TLS             Missing               mods-available/eap has only `ttls {}` block.
                                          REQUIRES_CLARIFICATION for cert management.
PEAP/MSCHAPv2       Unsupported           Cannot verify MSCHAPv2 challenge against Argon2id.
                                          Documented design decision.
EAP-MD5 / LEAP      Unsupported           Not offered. Not linked in eap module config.
MAB (Call-Check)    Implemented-tested    Service-Type=Call-Check handled in aaa.ts. Client
                                          device must have mac_auth_enabled=true.
MAB (MAC-username)  Implemented-tested    generic-radius-8021x only: User-Name == Calling-
                                          Station-Id with optional matching User-Password.
Voucher (PAP)       Implemented-tested    HMAC lookup, use_count/max_uses, duration_s logic.
Portal credential   Implemented-tested    Single-use broker token (pc-<16hex>), 30 s retransmit
                                          cache, CHAP hand-off for MikroTik.

### 3.2 Captive portal authentication

Method              Status                Notes
------------------- --------------------- -----------------------------------------------------
Username/password   Implemented-tested    portal-identity.ts; Argon2id; TOCTOU guard (B-3).
Voucher             Implemented-tested    Code normalisation, HMAC hash, expiry, max_uses.
MAC authentication  Implemented-tested    client_devices table; mac_auth_enabled flag.
Click-through       Planned               auth_methods check constraint includes 'click_through';
                                          no backend flow yet.
OTP SMS/email       Planned               identity_providers.type = 'sms_otp' in schema;
                                          no OTP generation or delivery code found.
Guest self-reg      Planned               users.origin = 'portal_signup' in schema;
                                          no portal sign-up flow verified.
Sponsor-approved    Missing               No schema or backend for sponsor approval workflow.
Social login OIDC   Planned               identity_providers.type IN ('oidc','google','facebook');
                                          schema present, no OIDC authorization-code flow found.
SAML                Planned               type='saml' in schema; no SAML backend found.
Paid subscriptions  Missing               No subscription/billing integration.
Free WiFi limits    Implemented-tested    Policy engine quotas + click_through / voucher paths.

### 3.3 External identity providers

Provider            Status                Notes
------------------- --------------------- -----------------------------------------------------
Local SQL           Implemented-tested    users table, Argon2id, group membership.
LDAP                Missing               identity_providers schema supports it but no
                                          rlm_ldap configuration exists in FreeRADIUS and no
                                          LDAP backend in the API.
Active Directory    Missing               Same as LDAP. AD is LDAP-compatible.
External RADIUS     Planned               identity_providers.type = 'radius_proxy';
                                          no proxy.conf or rlm_realm in FreeRADIUS config.
REST API auth       Implemented-untested  rlm_rest calls /internal/aaa/authorize which can
                                          be extended; no standalone REST IdP adapter found.
OIDC/OAuth2         Planned               Schema only (see 3.2).
SAML                Planned               Schema only (see 3.2).

---

## 4. Authorization engine

Feature                     Status                Notes
--------------------------- --------------------- -------------------------------------------
Per-user bandwidth limits   Implemented-tested    Via adapter-specific VSAs; per-adapter
                                                  translation in packages/policy-engine.
Download/upload speed        Implemented-tested    MikroTik: Mikrotik-Rate-Limit.
                                                  CoovaChilli: WISPr-Bandwidth-Max-Down/Up.
                                                  TIP/uspot: WISPr attributes.
                                                  Generic 802.1X: WISPr (REQUIRES_DEVICE_TEST).
Session timeout             Implemented-tested    Session-Timeout in reply; clipped to schedule
                                                  end, validity window, or quota drain time.
Idle timeout                Implemented-tested    Idle-Timeout in reply.
Daily quota                 Implemented-tested    usage_counters, daily period, pre-auth check.
Monthly quota               Implemented-tested    usage_counters, monthly period.
Total data allowance        Implemented-tested    usage_counters, total period.
Simultaneous login limit    Implemented-tested    EZECLOUD-side: active sessions count check.
Device restrictions         Implemented-tested    max_devices per user, mac_auth_enabled flag.
MAC allowlist               Implemented-tested    client_devices.mac_auth_enabled = true.
MAC blocklist               Implemented-tested    client_devices.blocked = true -> reject.
Dynamic VLAN assignment     Implemented-untested  RFC 3580 triplet for 802.1X adapters;
                                                  not lab-tested on physical hardware.
Time-based access           Implemented-tested    schedules table + policy_engine schedule.ts.
Expiration dates            Implemented-tested    users.valid_from/valid_until; voucher expiry.
Tenant-specific rules       Implemented-tested    All policies scoped by organization_id + RLS.
NAS/AP-specific policies    Implemented-untested  Policy scope_type includes NAS; adapter
                                                  capability matrix per adapter_key.
Group-based authorization   Implemented-tested    user_groups, policy assignments.
Role-based policies         Implemented-tested    policy scope_type in ('user','group','site').
Standard RADIUS attrs       Implemented-tested    Session-Timeout, Idle-Timeout, Class,
                                                  Acct-Interim-Interval, Framed-IP-Address.
VSAs                        Partially             MikroTik and WISPr implemented. Cisco AVPair,
                                                  Aruba-User-Role, Ruckus, Cambium: Missing.
Vendor policy adapters      Partially             9 adapters exist; many vendors Missing
                                                  (see compatibility matrix).
Burst rate shaping          Unsupported           Policy schema has burst_download/upload_kbps
                                                  but all adapters declare UNSUPPORTED (no
                                                  burst attribute in any target NAS).

---

## 5. Accounting

Feature                     Status                Notes
--------------------------- --------------------- -------------------------------------------
Accounting-Start            Implemented-tested    rlm_sql INSERT -> radacct_raw -> worker drain
                                                  -> sessions (status: authorized -> active).
Accounting-Stop             Implemented-tested    sessions.status = 'stopped', counters updated.
Interim-Update              Implemented-tested    sessions.last_interim_at, counters updated.
Accounting-On/Off           Implemented-tested    acctstatustype check constraint includes
                                                  'Accounting-On'/'Accounting-Off'.
Session tracking            Implemented-tested    sessions table, acct_unique_id key.
Online/offline status       Implemented-tested    status IN ('authorized','active','stopped','stale').
Upload/download bytes       Implemented-tested    input_octets/output_octets with wrap detection.
Session duration            Implemented-tested    session_time_s.
32-bit counter wrap fix     Implemented-untested  accounting_anomalies table + wrap_offset.
NAS identification          Implemented-tested    nasipaddress, nasidentifier, nas_client_id FK.
User/device identification  Implemented-tested    username, mac (macaddr), user_id FK.
Duplicate packet handling   Implemented-tested    ON CONFLICT DO NOTHING on composite unique
                                                  index (acctuniqueid, acctstatustype,
                                                  session_time, input, output).
Stale session detection     Implemented-untested  Worker sweep; sessions with no interim past
                                                  TTL -> 'stale'. No automated test found.
NAS failure recovery        Partially             Acct-On/Off handling present. No
                                                  automated reconciliation test.
SQL-backed accounting       Implemented-tested    radius.radacct_raw -> public.accounting_records
                                                  via worker drain job.
Active sessions API         Implemented-tested    GET /sessions (sessions.ts).
Historical usage API        Implemented-tested    GET /accounting (accounting.ts, 31-day window).
Usage counters API          Implemented-tested    GET /usage (usage.ts).

---

## 6. Dynamic authorization (CoA / RFC 5176)

Feature                     Status                Notes
--------------------------- --------------------- -------------------------------------------
Disconnect-Request          Implemented-untested  Worker coa/dispatcher.ts -> radclient. Full
                                                  retry/timeout logic. Requires ECLOUD_COA_ENABLED=true.
CoA-Request                 Implemented-untested  Same dispatcher, action = 'coa_update'.
ACK/NAK parsing             Implemented-tested    parseRadclientOutput; regex on stdout.
Retry logic                 Implemented-tested    configurable retries, exponential via BullMQ.
Secret protection           Implemented-tested    Written to 0600 temp file, -S flag, deleted
                                                  after use. Never on command line.
Event-Timestamp injection   Implemented-tested    withRequestHygiene() in dispatcher.
Message-Authenticator       Implemented-tested    Same.
Per-vendor CoA port         Implemented-untested  nas_clients.coa_port; MikroTik default 1700.
Meraki DAS                  Implemented-untested  das_host n<N>.meraki.com, UDP 3799.
Session close on Disconnect Implemented-tested    Closed only on ACK + acctStopEmitted=false.
ECLOUD_COA_ENABLED flag     Implemented           Default false. Lab/production gating.
session_enforcement table   Implemented-tested    Strategy (coa_change/disconnect_reauth/
                                                  next_reauth/none) tracked per session change.
Quota breach enforcement    Implemented-untested  worker/jobs/enforcement.ts triggers CoA/
                                                  Disconnect on quota exceeded.
Admin Disconnect UI         Implemented-untested  POST /sessions/:id/disconnect route;
                                                  no end-to-end test.
Bandwidth change during     Partially             coa_change strategy present in policy-engine;
active session                                    no vendor is lab-confirmed to support it.
Subscription/voucher expiry Partially             session_enforcement trigger includes
                                                  'quota_breach','schedule_end'; voucher expiry
                                                  checked at authorize time but no mid-session
                                                  expiry-push confirmed.

---

## 7. Multi-tenant isolation

Feature                     Status                Notes
--------------------------- --------------------- -------------------------------------------
Per-tenant NAS secrets      Implemented-tested    nas_clients.secret_ref (envelope-sealed).
NAS-to-tenant mapping       Implemented-tested    By packet source IP or UUID shortname only;
                                                  NAS-Identifier never selects tenant.
Per-tenant users            Implemented-tested    RLS on users (organization_id).
Per-tenant policies         Implemented-tested    RLS on policies.
Per-tenant vouchers         Implemented-tested    RLS on vouchers/voucher_batches.
Per-tenant accounting       Implemented-tested    organization_id on sessions/accounting_records.
Per-tenant portal config    Implemented-tested    captive_portals; public_slug globally unique.
Cross-tenant auth leak      Not present           Code verified: resolveNas uses only server-
                                                  side facts; username never selects tenant.
Per-tenant RADIUS config    Partially             Separate nas_clients with per-NAS secrets.
                                                  No per-tenant proxy realm config.

---

## 8. NAS adapter inventory

Adapter key                 Status                Portal type           Vendors covered
--------------------------- --------------------- --------------------- ---------------------------
openwifi-hostapd-radius     Implemented-untested  none-8021x-macauth    TIP OpenWiFi (802.1X)
openwifi-uspot-uam          Implemented-untested  uspot-uam             TIP OpenWiFi (captive)
uspot-upstream-uam          Implemented-untested  uspot-uam             uspot (upstream)
coovachilli-uam             Implemented-untested  coovachilli-uam       CoovaChilli
openwifi-config             Implemented-untested  none (config-only)    TIP OpenWiFi (config)
generic-radius-8021x        Implemented-untested  none-8021x-macauth    Generic 802.1X any vendor
mikrotik-hotspot            Implemented-untested  mikrotik-http-chap    MikroTik RouterOS
external-portal-postback    Implemented-untested  external-postback     Any (custom portal)
meraki-splash               Implemented-untested  meraki-splash         Cisco Meraki (cloud RADIUS)

Adapters noted as "untested" have no end-to-end hardware lab test (D-028 requirement).
"Implemented" here means the TypeScript code compiles and unit tests pass.

Missing vendor adapters:
  Ubiquiti UniFi            Missing
  TP-Link Omada             Missing
  Cisco WLC/IOS-XE          Missing
  Aruba ClearPass-like      Missing
  Ruckus SmartZone          Missing
  Cambium cnMaestro         Missing (controllers table present, no adapter)
  OpenWrt (non-TIP)         Missing

---

## 9. Deployment mode support

Mode            Status                Notes
--------------- --------------------- ---------------------------------------------------
Local RADIUS    Implemented-tested    Default deployment. NAS and FR on same private LAN.
Public RADIUS   Missing               No RadSec (TLS-wrapped RADIUS over TCP 2083).
                                      No WireGuard/VPN integration guide or config.
                                      No NAT traversal documentation.
Hybrid          Missing               No multi-site FR failover config.
IPv4            Implemented           RADIUS_LISTEN_IP configurable.
IPv6            Partially             NAS IPv6 addressing: migration 027 adds unicast_host
                                      check; rlm_sql and rlm_rest work over IPv6 networks
                                      but IPv6 RADIUS listener not tested.
RadSec          Missing               No TLS listener in FreeRADIUS config. No radsec
                                      module. Required for public-internet RADIUS.
HA / failover   Missing               No hot-standby FR config. No shared session state
                                      between FR instances.

---

## 10. Security controls

Control                     Status                Notes
--------------------------- --------------------- -------------------------------------------
Argon2id password hashing   Implemented-tested    verifyPassword() in @ecloud/db.
Secret envelope encryption  Implemented-tested    Envelope class, HKDF, AES-256-GCM.
CHAP cleartext in cache     Implemented-tested    sealDecisionForCache() seals with HKDF.
Replay protection           Implemented-tested    SHA-256 retransmit key, 10 s TTL cache.
Portal credential single-use Implemented-tested   30 s TTL, single-use token.
No fail-open                Implemented-tested    Backend 5xx -> reject.
Audit logging               Implemented-tested    auth_events table, audit_events outbox.
Username never in logs      Implemented-tested    Code verified: User-Password stripped in
                                                  ecloud_post_auth_context before POST.
Message-Authenticator       Implemented-tested    Required on every reply (CVE-2024-3596).
NAS identity from server    Implemented-tested    Packet source IP or UUID shortname, not
                                                  NAS-supplied attributes.
Rate limiting               Implemented-tested    hitLimitFailOpen (Redis); fails open when
                                                  Redis down (standing HIGH finding from
                                                  earlier audit — acceptable for export, risky
                                                  for auth paths if reused there).
TLS for internal API        Partially             rlm_rest `tls` block present with ca_file
                                                  comment; production cert path
                                                  REQUIRES_CLARIFICATION.
Credential masking in logs  Implemented-tested    No User-Password in any log call found.
Database least-privilege    Implemented-tested    ecloud_radius: INSERT on radius.radacct_raw
                                                  only (revoked from registry/controllers).
Firewall / port exposure    See SECURITY_REVIEW    DRAFT banner issues previously flagged.

---

## 11. Admin dashboard AAA modules

Module                      Status                Notes
--------------------------- --------------------- -------------------------------------------
AAA Overview                Partially             Dashboard route exists; AAA-specific KPIs
                                                  not confirmed.
RADIUS Server Management    Missing               No FreeRADIUS process management UI.
Local Users                 Implemented-untested  /resources/users CRUD routes exist.
External RADIUS Servers     Planned               identity_providers.type='radius_proxy' in
                                                  schema; no management UI or backend.
Authentication Methods      Partially             Per-portal auth_methods config in DB;
                                                  no global RADIUS method toggle UI.
NAS/AP Registration         Implemented-untested  nas_clients CRUD routes.
Authentication Policies     Implemented-untested  /policies routes.
Accounting & Sessions       Implemented-untested  /accounting and /sessions routes.
Online Users                Implemented-untested  /sessions?status=active.
Bandwidth Profiles          Implemented-untested  Embedded in policies.
Voucher Management          Implemented-untested  /vouchers routes.
CoA / Disconnect            Implemented-untested  POST /sessions/:id/disconnect, /reauthorize.
Authentication Logs         Implemented-untested  /reports, auth_events queries.
RADIUS Testing (flow tester) Missing              No endpoint that sends a test Access-Request
                                                  through FreeRADIUS and returns the decision
                                                  trace.
Tenant Configuration        Implemented-untested  /platform/settings routes.

---

## 12. Gap summary

Critical gaps (block production AAA for listed scenarios):

  G1  No RadSec: FreeRADIUS cannot safely accept RADIUS from public-internet APs.
      Any remote NAS must use a VPN; no VPN config exists.

  G2  No LDAP/AD adapter in FreeRADIUS or API. Enterprise Wi-Fi auth against AD is impossible.

  G3  EAP-TLS not implemented. WPA3-Enterprise supplicants needing client certs cannot auth.

  G4  No per-NAS secret hot-reload. Adding/removing a NAS requires FreeRADIUS container restart,
      breaking all active sessions on that instance.

  G5  No external RADIUS proxy. radius_proxy identity_provider type has no backing code.

  G6  No HA / failover. A single FreeRADIUS container is a SPOF for all authentication.

  G7  Social login / OIDC / SAML: schema defined, no backend authorization-code flow.

  G8  SMS/email OTP: schema defined, no OTP generation or delivery backend.

  G9  RADIUS flow tester missing. Operators cannot diagnose accept/reject without log diving.

  G10 No PayWall / subscription billing integration.

High-priority gaps (degrade operations but have workarounds):

  H1  Vendor adapters for UniFi, Omada, Cisco, Aruba, Ruckus, Cambium: missing.
      Operators must use generic-radius-8021x, which emits untested WISPr VSAs.

  H2  EAP-TTLS production cert path REQUIRES_CLARIFICATION. 802.1X cannot be enabled in prod
      without a signed server cert and CA, and no cert management workflow exists.

  H3  CoA/Disconnect not lab-tested on any vendor. All adapter CoA cells are REQUIRES_DEVICE_TEST.

  H4  Stale session detection has no automated test.

  H5  IPv6 RADIUS listener not tested end-to-end.

---

## 13. What to keep (do not rewrite)

The following components are well-engineered and tested. Phase 2+ must build on them:

  - aaa.ts authorize/post-auth handlers (retransmit cache, TOCTOU guard, Argon2id separation)
  - FreeRADIUS sites-enabled/ecloud + ecloud-inner (correct EAP inner trust model)
  - packages/adapters adapter framework (capabilities, evidence, translate, enforcement)
  - packages/policy-engine (resolve, schedule, simulate, enforcement)
  - DB schema migrations 001–033 (well-structured; use ALTER TABLE for extensions)
  - Worker CoA dispatcher + radclient wrapper (secret file, RFC hygiene)
  - SQL accounting pipeline (radacct_raw -> drain -> sessions/accounting_records)
  - Multi-tenant RLS + organization_id scoping

---

END OF AAA_AUDIT.md
