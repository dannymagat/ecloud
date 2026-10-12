# AAA Architecture — EZECLOUD / EZECONTROL
Version 1.0  |  2026-10-12

---

## 1. Architectural overview

EZECLOUD implements a three-tier AAA architecture:

  Tier 1  NAS / Access Layer
          Physical or virtual devices: Wi-Fi APs, switches, gateways, PPPoE concentrators.
          Speaks RADIUS (UDP), RadSec (TCP/TLS), or calls captive portal.

  Tier 2  Protocol Gateway
          FreeRADIUS 3.2 — terminates RADIUS, delegates ALL business logic to Tier 3 via
          rlm_rest.  No user data, policy, or shared secrets live here.

  Tier 3  EZECLOUD Platform
          TypeScript API (Express), Worker (BullMQ), PostgreSQL, Redis.
          Owns all authentication, authorization, accounting, CoA, and policy logic.

ASCII architecture diagram:

  +------------------+   RADIUS/UDP      +-------------------------+
  |   NAS / AP       |------------------>| FreeRADIUS 3.2          |
  |  (any vendor)    |<------------------| (Tier 2, protocol only) |
  +------------------+   reply attrs     |                         |
          |              RadSec/TLS      | modules:                |
          |  (future)     via TCP 2083   |  rlm_rest -> API Tier3  |
          |                             |  rlm_sql  -> radacct_raw|
          v                             |  rlm_eap  (TTLS/TLS)    |
  +------------------+                  +-------------------------+
  | Captive Portal   |  HTTP(S)                  |  REST
  | (browser-side)   |------+                    v
  +------------------+      |         +----------------------------+
                            |         |   EZECLOUD API             |
                            +-------->|   /internal/aaa/authorize  |
                                      |   /internal/aaa/post-auth  |
                                      |   /internal/aaa/accounting |
                                      |                            |
                                      |   Policy Engine            |
                                      |   Identity Broker          |
                                      |   CoA Dispatcher           |
                                      +----------------------------+
                                               |          |
                               +---------------+          +------------------+
                               v                                             v
                    +-------------------+                         +-------------------+
                    |   PostgreSQL 16   |                         |   Redis 7         |
                    |   - sessions      |                         |   - retransmit    |
                    |   - accounting    |                         |     cache (10 s)  |
                    |   - policies      |                         |   - session       |
                    |   - nas_clients   |                         |     enforcement   |
                    |   - users/vouchers|                         |     queue         |
                    |   - radacct_raw   |                         +-------------------+
                    +-------------------+
                               |
                               v
                    +-------------------+
                    |   BullMQ Worker   |
                    |   - acct drain    |
                    |   - CoA dispatch  |
                    |   - stale sweep   |
                    |   - enforcement   |
                    +-------------------+
                               |
                               v (RFC 5176 / CoA-Request)
                    +-------------------+
                    |   NAS CoA port    |
                    |   UDP 3799 / 1700 |
                    +-------------------+

External identity integrations (future):

  EZECLOUD API  <-->  LDAP/AD gateway (planned)
  EZECLOUD API  <-->  OIDC provider (planned, identity_providers.type='oidc')
  EZECLOUD API  <-->  SAML IdP (planned, identity_providers.type='saml')
  EZECLOUD API  <-->  External RADIUS (planned, identity_providers.type='radius_proxy')

---

## 2. Authentication flows

### 2.1 PAP / MAB (current production path)

  NAS            FreeRADIUS          EZECLOUD API
   |  Access-Req   |                      |
   |-------------->|  POST /authorize     |
   |               |--------------------->|
   |               |                      | 1. Resolve NAS by source IP
   |               |                      | 2. Lookup user by username + org
   |               |                      | 3. Argon2id verify (or MAC check)
   |               |                      | 4. Policy resolve -> attrs
   |               |                      | 5. Return {code:'Accept', attrs:[...]}
   |               |<---------------------|
   |  Access-Accept|                      |
   |<--------------|                      |

### 2.2 EAP-TTLS/PAP (opt-in, RADIUS_EAP_ENABLED=1)

  NAS          FreeRADIUS (ecloud)   FreeRADIUS (ecloud-inner)   EZECLOUD API
   |  EAP-Start  |                         |                          |
   |------------>| TLS handshake           |                          |
   |<----------->| (server cert)           |                          |
   |  TTLS tunnel|                         |                          |
   |------------>|  tunnel inner PAP       |                          |
   |             |------------------------>|  POST /authorize         |
   |             |                         |------------------------->|
   |             |                         |<-------------------------|
   |  Accept     |<------------------------|                          |
   |<------------|                         |                          |

### 2.3 Captive portal credential broker

  Browser         Portal App        EZECLOUD API      FreeRADIUS
    |  POST /auth   |                    |                  |
    |-------------->| POST /broker/cred  |                  |
    |               |------------------->|                  |
    |               |   token pc-<hex>   |                  |
    |               |<-------------------|                  |
    | redirect NAS  |                    |                  |
    |<--------------|                    |                  |
    |               NAS sends Access-Req (User=token,Pass=token)
    |                                    |<-- POST /authorize
    |                                    | decrypt broker token
    |                                    | verify credential
    |                                    | return Accept + attrs
    |                                   FreeRADIUS -> NAS Access-Accept

### 2.4 CoA / Disconnect

  Worker                     NAS CoA port
    |  radclient CoA-Request   |
    |------------------------->|
    |  CoA-ACK / CoA-NAK       |
    |<-------------------------|
    | on ACK: update session   |
    | on NAK: log + retry      |

---

## 3. Multi-tenant isolation model

  Tenant boundary = organization_id (UUID).

  NAS-to-tenant resolution:
    1. Source IP matches nas_clients.ip (exact or CIDR range).
    2. NAS-Identifier matches nas_clients.identifier (UUID shortname).
    Never: username or realm selects tenant alone.

  Row-level security:
    PostgreSQL RLS policies on all tenant tables.
    ecloud_api role: can only see rows WHERE organization_id = current_setting('app.org_id').

  FreeRADIUS:
    NAS shared secrets stored in database (nas_clients.secret_ref).
    clients.d/ecloud-nas.conf rendered on container start; restart required for changes.
    No tenant data in radiusd.conf.

---

## 4. Deployment modes

  Mode A — Local RADIUS
    NAS and FreeRADIUS on same private network or VLAN.
    Shared secret: pre-shared key per NAS.
    Port: UDP 1812/1813.

  Mode B — Public / Cloud RADIUS (planned)
    NAS authenticates over internet.
    Requirement: RadSec (TLS port 2083) OR site-to-site VPN (WireGuard recommended).
    Shared secret: per-NAS, 32+ random bytes.
    Certificate: signed by EZECLOUD internal CA or public CA.
    Implementation: see G1 in AAA_AUDIT.md.

  Mode C — Hybrid (planned)
    Local FreeRADIUS instances proxy to central EZECLOUD API.
    Failover: local proxy to backup API endpoint.
    Implementation: requires proxy.conf + realm config in FreeRADIUS.

---

## 5. Identity provider routing

  auth_methods field on users table controls which path(s) FreeRADIUS will attempt:
    'password'  -> Argon2id verify against users.password_hash
    'mac'       -> MAC lookup against client_devices
    'voucher'   -> HMAC voucher lookup
    'idp'       -> identity_providers table: local | oidc | google | facebook | saml |
                   sms_otp | radius_proxy

  rlm_rest authorize POST returns:
    { code: 'Accept', attrs: [...], authType: 'argon2id' | 'voucher' | 'mac' | 'broker_token' }
    { code: 'Reject', message: 'Access denied' }    (generic, no user enumeration)
    { code: 'Challenge', message: '...' }            (future: EAP state machine use)

---

## 6. Policy engine

  resolve(nasClientId, userId | voucherId, requestAttrs) -> PolicyResolution

  PolicyResolution contains:
    - attrs: RADIUS reply attributes (standard + VSA)
    - enforcement: { strategy, quotaCheckAt, expiresAt }
    - vendorTranslation: adapter-specific attribute map

  Translation pipeline:
    1. resolve() selects policy (user > group > site default).
    2. simulate() checks schedule validity.
    3. adapter.translate(policy, capabilities) emits vendor attrs.
    4. attrs merged: standard attrs override vendor attrs on collision.

---

## 7. Accounting pipeline

  rlm_sql (FR)  -> radius.radacct_raw (INSERT, minimal privileges)
  Worker drain  -> normalize -> public.accounting_records (partitioned by month)
  Worker drain  -> upsert  -> public.sessions (status, counters, last_interim_at)

  Accounting anomalies:
    - 32-bit octet counter wrap: detected by accounting_anomalies table, wrap_offset applied.
    - Duplicate packets: ON CONFLICT DO NOTHING on (acct_unique_id, acct_status_type, ...).
    - Missing Stop: stale sweep marks session 'stale' after configurable TTL.
    - NAS restart (Acct-On): all prior active sessions for that NAS force-stopped.

---

## 8. CoA / RFC 5176 engine

  Trigger sources:
    - Quota breach (worker enforcement job)
    - Admin action (POST /sessions/:id/disconnect or /reauthorize)
    - Policy change (future: policy-updated event)
    - Voucher/subscription expiry (future: expiry-push)

  Dispatch:
    - BullMQ job created in session_actions table.
    - Worker picks up, calls radclient with secret in 0600 temp file.
    - Parses ACK/NAK, retries on NAK (configurable).
    - On ACK: updates session.enforcement_state.
    - Vendor CoA compatibility checked against adapter capabilities before dispatch.
    - ECLOUD_COA_ENABLED=false (default): no packets sent; UI shows "Not enabled".

---

END OF AAA_ARCHITECTURE.md
