# AAA Test Results — EZECLOUD / EZECONTROL
Version 1.0  |  2026-10-12

This document records the results of AAA-specific testing.  It will be updated as each
implementation phase completes.  "Lab test" means end-to-end with real or emulated hardware.
"Unit test" means automated Vitest tests in this repository (`npm test` = `vitest run`).

Evidence levels are the five-state evidence axis of MULTI_VENDOR_INTEGRATION_PLAN.md
(§"evidence level", line 106; enum in `packages/shared/src/evidence.ts`):
DOCUMENTED < VERIFIED_FROM_SOURCE < SIMULATOR_TESTED < LAB_VALIDATED < PRODUCTION_VALIDATED.
A passing unit or integration test in this repository is VERIFIED_FROM_SOURCE at most.
A stub/simulator test is SIMULATOR_TESTED.  Nothing is LAB_VALIDATED without a recorded
real-device test (D-028, D-034), and no device test has been run — so no row below is
LAB_VALIDATED or PRODUCTION_VALIDATED.

  NOTE: DECISIONS.md D-028 defines the orthogonal four-state *capability status*
  (VERIFIED_SUPPORTED / REQUIRES_DEVICE_TEST / UNSUPPORTED / ECLOUD_SIDE_ONLY), not the
  evidence levels used here.  The two axes are different; see
  MULTI_VENDOR_INTEGRATION_PLAN.md §"Status vs evidence".

---

## 1. Test environment

  VPS:        ezeadmin@192.168.203.196:2234 (production-equivalent, containers UP)
  FreeRADIUS: 3.2.10 (Docker container ecloud-freeradius)
  Database:   PostgreSQL 16 (Docker container ecloud-postgres)
  API:        EZECLOUD API v1f1e1bc (container ecloud-api, port 443 internal)
  Test suite: npm test (Vitest, `vitest run`) — 1515 passed, 518 skipped, 0 failed
              (baseline 2026-10-12; see the caveat in §2 — the FreeRADIUS contract
              suite did NOT execute in that run)
  Lab NAS:    None yet configured.

---

## 2. Automated test results (baseline)

  Test suite run:  2026-10-12  (npm test, i.e. `vitest run`)
  Result:          1515 passed  /  518 skipped  /  0 failed
  Coverage:        Not yet measured for AAA-specific paths.

  CAVEAT — the headline number excludes most of the RADIUS-protocol evidence.
  `tests/aaa-contract/freeradius-rest.test.ts` is the suite that exercises the real
  FreeRADIUS leg (PAP, CHAP, MAB, accounting, wrong-secret drop).  It calls
  `describe.skip` unless BOTH `ECLOUD_TEST_RADIUS=1` and
  `ECLOUD_TEST_REQUIRE_INTEGRATION=1` are set and Docker is running
  (freeradius-rest.test.ts:36-42).  Neither was set in the baseline run, so every row
  below whose only evidence is that file was NOT executed.  Run it with:
    npm run test:aaa-contract

  Known skipped suites (relevant to AAA):
    - tests/aaa-contract/freeradius-rest.test.ts  (ECLOUD_TEST_RADIUS=1 + Docker)
    - *.integration.test.ts across apps/api and apps/worker  (ECLOUD_TEST_DATABASE_URL)
    - CoA dispatcher end-to-end (ECLOUD_COA_ENABLED=true)

---

## 3. PAP authentication (unit tests)

  Test                                    Result      Evidence              Covering test
  --------------------------------------  ----------  --------------------  ------------------------------------------------
  Known user, correct password            PASS        VERIFIED_FROM_SOURCE  apps/api/src/integration.test.ts:674
  Known user, wrong password              PASS        VERIFIED_FROM_SOURCE  apps/api/src/aaa-password-verify.integration.test.ts:255
  Unknown user (timing levelling)         PASS        VERIFIED_FROM_SOURCE  apps/api/src/internal/portal-identity.test.ts:12
  Suspended user                          PASS        VERIFIED_FROM_SOURCE  apps/api/src/aaa-password-verify.integration.test.ts:210
  Expired user (valid_until in past)      NOT TESTED  DOCUMENTED            none — see note (a)
  Not-yet-valid user (valid_from future)  NOT TESTED  DOCUMENTED            none — see note (a)
  Site mismatch                           NOT TESTED  DOCUMENTED            none — see note (b)
  Retransmit duplicate packet             PASS        VERIFIED_FROM_SOURCE  apps/api/src/integration.test.ts:674,
                                                                            apps/api/src/units.test.ts:123
  Backend 5xx -> reject                   NOT RUN     SIMULATOR_TESTED*     tests/aaa-contract/freeradius-rest.test.ts:199

  (a) The behaviour IS implemented — `user_not_yet_valid` at apps/api/src/internal/aaa.ts:510
      and `user_expired` at aaa.ts:513 — but no test in the repository references either
      reject reason.  Implemented, unverified.  Gap, not a pass.
  (b) No test references a `site_mismatch` reject.  The nearest coverage is a different
      reason: `tenant_inactive` for an inactive site
      (apps/api/src/aaa-password-verify.integration.test.ts:281).
  *   SIMULATOR_TESTED only when the contract suite is actually run (see §2); it did not
      execute in the baseline, hence NOT RUN.

---

## 4. MAB authentication (unit tests)

  Test                                    Result      Evidence              Covering test
  --------------------------------------  ----------  --------------------  ------------------------------------------------
  Known MAC, mac_auth_enabled=true        PASS        VERIFIED_FROM_SOURCE  apps/api/src/cycle-a.integration.test.ts:840,
                                                                            apps/api/src/cycle-a.test.ts:175
  Known MAC, mac_auth_enabled=false       PASS (rej)  VERIFIED_FROM_SOURCE  apps/api/src/cycle-a.test.ts:206
  Blocked MAC                             NOT TESTED  DOCUMENTED            none — see note (c)
  Unknown MAC                             NOT TESTED  DOCUMENTED            none — see note (c)
  Generic MAB reaches EZECLOUD unchanged  NOT RUN     SIMULATOR_TESTED*     tests/aaa-contract/freeradius-rest.test.ts:368

  (c) Both are implemented in one branch — apps/api/src/internal/aaa.ts:476 rejects when the
      device is unknown, has `mac_auth_enabled = false` or is `blocked`, and aaa.ts:727 raises
      `device_blocked` — but no test references `device_blocked`, and none covers the
      unknown-MAC path.  Only the `mac_auth_enabled = false` case is exercised.

---

## 5. Voucher authentication (unit tests)

  Test                                    Result      Evidence              Covering test
  --------------------------------------  ----------  --------------------  ------------------------------------------------
  Valid voucher, first use                PASS        VERIFIED_FROM_SOURCE  apps/api/src/portal.integration.test.ts:441
  Valid voucher, max_uses exceeded        PASS (rej)  VERIFIED_FROM_SOURCE  packages/policy-engine/src/resolve.test.ts:851
  Expired voucher                         PASS (rej)  VERIFIED_FROM_SOURCE  packages/policy-engine/src/resolve.test.ts:810
  Revoked voucher / disabled method       PASS (rej)  VERIFIED_FROM_SOURCE  apps/api/src/portal.integration.test.ts:483
  Wrong code (brute-force cap)            PASS (rej)  VERIFIED_FROM_SOURCE  apps/api/src/portal.integration.test.ts:752
  Quota applied on accept                 PASS        VERIFIED_FROM_SOURCE  packages/policy-engine/src/resolve.test.ts:810
  Vendor failure never consumes a voucher PASS        VERIFIED_FROM_SOURCE  apps/api/src/cycle-d.integration.test.ts:821

---

## 6. Policy engine (unit tests)

  Test                                    Result      Evidence              Covering test
  --------------------------------------  ----------  --------------------  ------------------------------------------------
  Bandwidth attrs in reply (MikroTik)     PASS        VERIFIED_FROM_SOURCE  packages/policy-engine/src/translate.test.ts:195
  Bandwidth attrs in reply (WISPr)        PASS        VERIFIED_FROM_SOURCE  packages/policy-engine/src/translate.test.ts:195
  Session-Timeout set from policy         PASS        VERIFIED_FROM_SOURCE  packages/policy-engine/src/translate.test.ts:282
  Idle-Timeout set from policy            PASS        VERIFIED_FROM_SOURCE  packages/policy-engine/src/translate.test.ts:332
  Quota pre-auth reject (daily exceeded)  PASS        VERIFIED_FROM_SOURCE  packages/policy-engine/src/resolve.test.ts:544
  VLAN attr emitted (802.1X adapter)      PARTIAL     VERIFIED_FROM_SOURCE  packages/policy-engine/src/translate.test.ts:388
  Schedule validity check                 PASS        VERIFIED_FROM_SOURCE  packages/policy-engine/src/schedule.test.ts:68
  Group policy fallback                   PASS        VERIFIED_FROM_SOURCE  packages/policy-engine/src/resolve.test.ts:143
  Layer precedence + priority ordering    PASS        VERIFIED_FROM_SOURCE  packages/policy-engine/src/resolve.test.ts:221
  Simultaneous-use / device caps          PASS        VERIFIED_FROM_SOURCE  packages/policy-engine/src/resolve.test.ts:693,714

  The previous revision attributed the attribute-emission rows to resolve.test.ts.  Emission
  is translate.test.ts; resolve.test.ts decides which policy applies.  VLAN is PARTIAL
  deliberately: the RFC 3580 triplet is emitted in lab mode only (translate.test.ts:388), so
  it is not a device-enforced capability on any NAS — see AAA_COMPATIBILITY_MATRIX.md.

---

## 7. Accounting pipeline (unit tests)

  Test                                    Result      Evidence              Covering test
  --------------------------------------  ----------  --------------------  ------------------------------------------------
  Accounting-Start creates session        PASS        VERIFIED_FROM_SOURCE  apps/worker/src/integration.test.ts:132
  Accounting-Stop closes session          PASS        VERIFIED_FROM_SOURCE  apps/worker/src/integration.test.ts:132
  Interim update refreshes counters       PASS        VERIFIED_FROM_SOURCE  apps/worker/src/accounting/normalize.test.ts:150
  Out-of-order interim never decreases    PASS        VERIFIED_FROM_SOURCE  apps/worker/src/accounting/normalize.test.ts:166
  Duplicate packet idempotent             PASS        VERIFIED_FROM_SOURCE  apps/worker/src/accounting/normalize.test.ts:159
  32-bit counter wrap detected            PASS        VERIFIED_FROM_SOURCE  apps/worker/src/enforcement.integration.test.ts:168,228,
                                                                            packages/adapters/src/enforcement.test.ts:57,98,108
  Acct-On closes prior sessions for NAS   PASS        VERIFIED_FROM_SOURCE  apps/worker/src/attribution.integration.test.ts:218
  Stale session revived by a Start        PASS        VERIFIED_FROM_SOURCE  apps/worker/src/attribution.integration.test.ts:251
  Stale-session reaper timestamp source   PASS        VERIFIED_FROM_SOURCE  apps/worker/src/jobs/reap.test.ts:9
  One radacct_raw row per distinct packet  NOT RUN     SIMULATOR_TESTED*     tests/aaa-contract/freeradius-rest.test.ts:254

  Correction to the previous revision, which marked counter wrap and stale-session detection
  untested: both ARE tested, at the lines above.  Phase 2B of AAA_IMPLEMENTATION_PLAN.md is
  therefore already complete and should not be re-scheduled.

---

## 8. CoA dispatcher (unit tests)

  Test                                    Result      Evidence              Covering test
  --------------------------------------  ----------  --------------------  ------------------------------------------------
  ACK response parsed correctly           PASS        VERIFIED_FROM_SOURCE  apps/worker/src/coa/dispatcher.test.ts:71,
                                                                            apps/worker/src/coa/radclient.test.ts:53
  NAK response parsed correctly           PASS        VERIFIED_FROM_SOURCE  apps/worker/src/coa/dispatcher.test.ts:100,
                                                                            apps/worker/src/coa/radclient.test.ts:63
  Timeout -> retry queued                 PASS        VERIFIED_FROM_SOURCE  apps/worker/src/coa/dispatcher.test.ts:115,
                                                                            apps/worker/src/coa/radclient.test.ts:74
  Secret written to 0600 tmpfile          PASS        VERIFIED_FROM_SOURCE  apps/worker/src/coa/radclient.test.ts:89
  Secret file deleted when runner throws  PASS        VERIFIED_FROM_SOURCE  apps/worker/src/coa/radclient.test.ts:118
  Disabled dispatcher never sends         PASS        VERIFIED_FROM_SOURCE  apps/worker/src/coa/dispatcher.test.ts:54
  Unsupported adapter / missing identity  PASS        VERIFIED_FROM_SOURCE  apps/worker/src/coa/dispatcher.test.ts:135
  CoA sends only changeable attributes    PASS        VERIFIED_FROM_SOURCE  apps/worker/src/coa/dispatcher.test.ts:162
  Per-NAS CoA rate limit                  NOT TESTED  DOCUMENTED            none — no rate limit exists (AAA_SECURITY.md R7)
  Against a real NAS                      NOT TESTED  DOCUMENTED            no device test has been run (D-028)

  Every row above is a unit test against a stubbed radclient.  No CoA packet has reached real
  hardware, so no row here is LAB_VALIDATED.

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
