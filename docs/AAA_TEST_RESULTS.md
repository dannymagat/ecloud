# AAA Test Results — EZECLOUD / EZECONTROL
Version 1.0  |  2026-10-12

This document records the results of AAA-specific testing.  It will be updated as each
implementation phase completes.  "Lab test" means end-to-end with real or emulated hardware.
"Unit test" means automated Jest tests in this repository.

---

## 1. Test environment

  VPS:        ezeadmin@192.168.203.196:2234 (production-equivalent, containers UP)
  FreeRADIUS: 3.2.10 (Docker container ecloud-freeradius)
  Database:   PostgreSQL 16 (Docker container ecloud-postgres)
  API:        EZECLOUD API v1f1e1bc (container ecloud-api, port 443 internal)
  Test suite: npm test (Jest) — 1515 passed, 518 skipped, 0 failed (baseline 2026-10-12)
  Lab NAS:    None yet configured.

---

## 2. Automated test results (baseline)

  Test suite run:  2026-10-12  (npm test -- --silent)
  Result:          1515 passed  /  518 skipped  /  0 failed
  Coverage:        Not yet measured for AAA-specific paths.

  Known skipped suites (relevant to AAA):
    - Worker integration tests (require running PostgreSQL testcontainer)
    - CoA dispatcher end-to-end (require ECLOUD_COA_ENABLED=true)
    - Stale session sweep (require test DB with time-travel fixture)

---

## 3. PAP authentication (unit tests)

  Test                                    Result      Suite
  --------------------------------------  ----------  ----------------------------------
  Known user, correct password            PASS        apps/api: aaa.test.ts
  Known user, wrong password              PASS        apps/api: aaa.test.ts
  Unknown user (timing levelling)         PASS        apps/api: aaa.test.ts
  Suspended user                          PASS        apps/api: aaa.test.ts
  Expired user (valid_until in past)      PASS        apps/api: aaa.test.ts
  Not-yet-valid user (valid_from future)  PASS        apps/api: aaa.test.ts
  Site mismatch                           PASS        apps/api: aaa.test.ts
  Retransmit duplicate packet             PASS        apps/api: aaa.test.ts
  Backend 5xx -> reject                   PASS        apps/api: aaa.test.ts

---

## 4. MAB authentication (unit tests)

  Test                                    Result      Suite
  --------------------------------------  ----------  ----------------------------------
  Known MAC, mac_auth_enabled=true        PASS        apps/api: aaa.test.ts
  Known MAC, mac_auth_enabled=false       PASS (rej)  apps/api: aaa.test.ts
  Blocked MAC                             PASS (rej)  apps/api: aaa.test.ts
  Unknown MAC                             PASS (rej)  apps/api: aaa.test.ts

---

## 5. Voucher authentication (unit tests)

  Test                                    Result      Suite
  --------------------------------------  ----------  ----------------------------------
  Valid voucher, first use                PASS        apps/api: vouchers.test.ts
  Valid voucher, max_uses exceeded        PASS (rej)  apps/api: vouchers.test.ts
  Expired voucher                         PASS (rej)  apps/api: vouchers.test.ts
  Wrong code                              PASS (rej)  apps/api: vouchers.test.ts
  Quota applied on accept                 PASS        apps/api: vouchers.test.ts

---

## 6. Policy engine (unit tests)

  Test                                    Result      Suite
  --------------------------------------  ----------  ----------------------------------
  Bandwidth attrs in reply (MikroTik)     PASS        packages/policy-engine: resolve.test.ts
  Bandwidth attrs in reply (WISPr)        PASS        packages/policy-engine: resolve.test.ts
  Session-Timeout set from policy         PASS        packages/policy-engine: resolve.test.ts
  Idle-Timeout set from policy            PASS        packages/policy-engine: resolve.test.ts
  Quota pre-auth reject (daily exceeded)  PASS        packages/policy-engine: resolve.test.ts
  VLAN attr emitted (802.1X adapter)      PASS        packages/policy-engine: resolve.test.ts
  Schedule validity check                 PASS        packages/policy-engine: schedule.test.ts
  Group policy fallback                   PASS        packages/policy-engine: resolve.test.ts

---

## 7. Accounting pipeline (unit tests)

  Test                                    Result      Suite
  --------------------------------------  ----------  ----------------------------------
  Accounting-Start creates session        PASS        apps/worker: acct-drain.test.ts
  Accounting-Stop closes session          PASS        apps/worker: acct-drain.test.ts
  Interim update refreshes counters       PASS        apps/worker: acct-drain.test.ts
  Duplicate packet idempotent             PASS        apps/worker: acct-drain.test.ts
  32-bit counter wrap detected            PASS        apps/worker: acct-drain.test.ts
  Acct-On closes prior sessions for NAS  PASS        apps/worker: acct-drain.test.ts

---

## 8. CoA dispatcher (unit tests)

  Test                                    Result      Suite
  --------------------------------------  ----------  ----------------------------------
  ACK response parsed correctly           PASS        apps/worker: coa.test.ts
  NAK response parsed correctly           PASS        apps/worker: coa.test.ts
  Timeout -> retry queued                 PASS        apps/worker: coa.test.ts
  Secret written to 0600 tmpfile          PASS        apps/worker: coa.test.ts
  Secret deleted after dispatch           PASS        apps/worker: coa.test.ts
  Cross-tenant CoA rejected               PASS        apps/worker: coa.test.ts
  ECLOUD_COA_ENABLED=false -> no packet   PASS        apps/worker: coa.test.ts

---

## 9. Lab tests — hardware/emulated NAS

  All cells are REQUIRES_DEVICE_TEST until completed.

  NAS                  Test                              Status      Date       Evidence
  -------------------  --------------------------------  ----------  ---------  --------
  MikroTik RouterOS    PAP auth -> Accept                PENDING     -          -
  MikroTik RouterOS    MAB auth -> Accept                PENDING     -          -
  MikroTik RouterOS    Accounting Start/Stop             PENDING     -          -
  MikroTik RouterOS    Disconnect-Request ACK            PENDING     -          -
  MikroTik RouterOS    CoA bandwidth change ACK          PENDING     -          -
  CoovaChilli          PAP auth -> Accept                PENDING     -          -
  CoovaChilli          Accounting Start/Stop             PENDING     -          -
  CoovaChilli          Disconnect-Request ACK            PENDING     -          -
  TIP OpenWiFi         PAP auth -> Accept                PENDING     -          -
  TIP OpenWiFi         EAP-TTLS/PAP auth -> Accept       PENDING     -          -
  TIP OpenWiFi         MAB auth -> Accept                PENDING     -          -
  Cisco Meraki         Cloud RADIUS auth -> Accept       PENDING     -          -
  Cisco Meraki         DAS Disconnect ACK                PENDING     -          -
  Generic 802.1X       VLAN assignment verified          PENDING     -          -

  Evidence format when completed:
    pcap file name, radtest command, FreeRADIUS debug log excerpt, session record UUID.

---

## 10. Security tests

  Test                                       Result      Notes
  -----------------------------------------  ----------  ------------------------------------
  User-Password not in API log output        PASS        Grep of audit_events, no password.
  NAS secret not on process command line     PASS        Grep /proc/<pid>/cmdline in container.
  Cross-tenant auth attempt rejected         PASS        Unit test (org boundary enforced).
  TOCTOU guard: credential changed mid-auth  PASS        Unit test (credentialUnchanged check).
  Message-Authenticator required on reply    PASS        Verified in radiusd.conf + clients.conf.
  Portal broker token: single-use            PASS        Unit test.
  CoA secret file permissions = 0600         PASS        Unit test (fs.statSync assertion).
  Rate limit on auth endpoint                PASS        Unit test (hitLimitFailOpen path).
  BlastRADIUS (CVE-2024-3596) mitigated      PASS        Message-Authenticator on all replies.

---

## 11. Test gaps (to be addressed in Phase 2-8)

  TG1  EAP-TTLS end-to-end: no automated test runner can send TTLS without a real supplicant.
       Plan: use eapol_test (wpa_supplicant) against live FR container in CI.

  TG2  Stale sweep: requires time-travel fixture or sleep; skipped in current suite.
       Plan: mock Date.now() and stub worker clock.

  TG3  CoA end-to-end with ECLOUD_COA_ENABLED=true and mock NAS (radclient echo server).
       Plan: Docker container running a simple CoA-ACK responder.

  TG4  LDAP authentication: no test until Phase 4A (OpenLDAP testcontainer).

  TG5  OTP send/verify: no test until Phase 4C.

  TG6  OIDC flow: no test until Phase 4D.

  TG7  RadSec: no TLS client test until Phase 3A.

  TG8  Hardware NAS: all lab tests pending (see section 9).

---

END OF AAA_TEST_RESULTS.md
