# Questions Requiring Clarification

Updated 2026-10-07 after Phase 2 (architecture + protocol validation). Phase 1 questions Q1–Q22 keep their numbers; Q23–Q82 were raised by the Phase 2 artifacts. Every open question lists the **default** Phase 3 will assume if unanswered. Items marked → DEVICE TEST are now test cases in [PHASE2_VALIDATION.md](PHASE2_VALIDATION.md) §5 rather than owner questions.

## Owner decision gate — 2026-10-07

The owner reviewed Phase 2 and ruled as follows (recorded in DECISIONS.md D-021 … D-034):

| Question(s) | Owner ruling | Status now |
|---|---|---|
| Q23–Q82 | Documented defaults **accepted**, except the amendments below. | APPROVED DEFAULTS |
| Q22 | `ubuntu` acceptable for development/manual pilot; design a separate least-privilege deployment identity before automated deployment; do not create it yet (D-024). | AMENDED |
| Q57 | Retention 7 days / 13 months / 24 months accepted as pilot defaults only; production regulatory retention REQUIRES_CLARIFICATION (D-025). | AMENDED |
| Q59 | No MinIO on the pilot VPS; storage abstraction with local filesystem for non-critical assets, S3-compatible external storage in production; backups never only on the VPS filesystem (D-026). | AMENDED |
| Q70 | Impersonation: permission-controlled, time-limited, audited, visible, cannot create API keys / rotate secrets / change privileged bindings; tenant-controlled enablement for production (D-027). | AMENDED |
| Q82 / Q11 | Model every policy type now; enforcement staged (rates → session timeout → idle timeout → validity → vouchers → quotas → concurrency → schedules → VLAN → burst); adapters report `VERIFIED_SUPPORTED / REQUIRES_DEVICE_TEST / UNSUPPORTED / ECLOUD_SIDE_ONLY` per field (D-028). | AMENDED |
| Q13, Q33 | Domain structure approved; admin SPA may use `ecloud.ezelink.ai/api/v1` same-origin; no DNS change without deployment approval (D-029). | ANSWERED |
| Q14 | `/opt/ecloud` (D-030). | ANSWERED |
| Q15 | Keep native Caddy with backup → preserve → validate → reload → verify procedure (D-030). | ANSWERED |
| Q51, Q35-exposure | Tunnel-only RADIUS for the pilot; no public 1812/1813/3799; RadSec fallback (D-032). | ANSWERED |
| Q52, Q53 | Hub `100.100.0.1`, UDP 51820, subject to collision/routing verification (D-032). | ANSWERED (verification pending) |
| Q16 | Still open: customer LAN ranges never assumed; conflict check before assigning tunnel ranges. | OPEN |
| Q9, Q50 | Lab EZEAP, test SSIDs, NAT/router, EZE controller access will be provided; EZE gateway with CoovaChilli may be provided (D-034). | ANSWERED |
| Q6 (D-006) | Remains REQUIRES_DEVICE_TEST until real-device tests pass. | → DEVICE TEST |
| Q21, Q17, Q18, Q19, Q20 | Not yet decided; all VPS changes are gated by D-031 (present exact change list and stop). | OPEN (gated) |
| Q2, Q5, Q7, Q8, Q10 | Already answered in Phase 2 requirements. | ANSWERED |

Phase 3 (local foundation implementation) is authorised. VPS deployment is not.

Legend: **ANSWERED** · **PARTIAL** (owner gave the principle; details still open) · **OPEN** · **→ DEVICE TEST** (now a DT case in PHASE2_VALIDATION.md §5, not an owner question).

## Status of Phase 1 questions Q1–Q22

| ID | Question (short) | Phase 2 status | What the owner said / what remains | Default |
|---|---|---|---|---|
| Q1 | `ssh vps` alias mismatch | RESOLVED (2026-10-07) | — | — |
| Q2 | Is this VPS production or pilot? | **ANSWERED** | "Current VPS is DEVELOPMENT/PILOT, not final production"; architecture must be portable (D-001) | pilot |
| Q3 | Device vendor/model/firmware/management | **PARTIAL** | Family answered: EZEAP running TIP OpenWiFi (uCentral); CoovaChilli gateways (EZEGATE precedent). **Still open:** exact models, firmware build, `capabilities.version.schema`, whether every site has a gateway (WG Q2) | schema 4.2.0 as pinned by ezecontroller; uspot TIP fork (DT-01) |
| Q4 | Bridged vs routed/NAT at each site | **PARTIAL** | Both modes must be supported. **Still open:** per-site mode inventory; acceptance that a captive SSID always gets an AP-routed subnet (see Q24) | design supports both; portal SSID = downstream |
| Q5 | Where/how bandwidth is enforced | **ANSWERED (principle)** | "VPS is NOT the enforcement point; site device enforces; mechanism must be VERIFIED." Mechanisms verified: per-SSID `rate-limit`; uspot RADIUS attrs (DT-04) | per PHASE2_VALIDATION ledger |
| Q6 | CoA/Disconnect support and port | **→ DEVICE TEST** (D-006) | Schema path verified; end-to-end = DT-07/DT-08/DT-15 | Disconnect only; fallback Session-Timeout cap |
| Q7 | Captive portal mechanism | **ANSWERED** | CoovaChilli and uspot (TIP OpenWiFi), UAM external portal (D-005) | two adapters |
| Q8 | Site ↔ cloud connectivity | **ANSWERED (intent)** | WireGuard VPN VPS ↔ sites; topology to be proposed (A1: A primary, C fallback, B pending DT-18). **Still open:** approval of A/C and hub port (Q66), public RADIUS allowed? (Q35) | topology A + RadSec fallback |
| Q9 | One real device for Phase 2 test | **OPEN** | Required for all DT cases; extended by A9: one AP (3 SSIDs) + NAT router + optional EZE gateway (Q82) | — |
| Q10 | Single org vs multi-tenant | **ANSWERED** | Multi-tenant (D-007), hierarchy given | multi-tenant |
| Q11 | Policy controls in first release | **PARTIAL** | Full list given (rate, burst, quotas, timeouts, concurrency, validity, schedules, VLAN, priority); **which are release-1 vs later** still open | all stored; enforceability per adapter preview |
| Q12 | Subscriber auth methods | **PARTIAL** | username/password, voucher, MAC/device, social login (extensible IdP). **Still open:** which IdPs (Q30), MAC-auth acceptance (Q31) | all four; social via broker |
| Q13 | Domains / DNS | **PARTIAL** | `ecloud.ezelink.ai` primary; evaluate `api.`/`portal.` (D-014 proposes them). **Still open:** approve structure; point DNS (unproxied) at the VPS when Phase 3 deploys | proposed three hosts; dev via hosts file |
| Q14 | Deploy root | **OPEN** | DEP recommends `/opt/ecloud` | `/opt/ecloud` |
| Q15 | Keep native Caddy | **OPEN** | DEP/D-015 recommend keep | keep |
| Q16 | Address overlap (sites/VPN vs Docker) | **OPEN** | Needed for `172.28.0.0/16` (Compose) and `100.100.0.0/16` (overlay); site LAN ranges per tenant (WG Q1) | as proposed; reassign if collision |
| Q17 | OVH edge firewall / KVM console | **OPEN** | Prerequisite for host firewall (SEC §2.5) | assume none; sequence SSH allow first |
| Q18 | OVH snapshots/backups | **OPEN** | Also: offsite backup target (DEP Q5, API Q5 object storage) | none assumed; pg_dump to local + bucket later |
| Q19 | `cf-dns-failover.sh` cron | **OPEN** | — | leave untouched |
| Q20 | Developer token files in `/home/ubuntu` | **OPEN** | SEC: remove before any auth service runs | flag, do not touch without approval |
| Q21 | Host prerequisites approval | **OPEN** (D-020) | Reboot, upgrades, swap, log rotation, firewall, fail2ban, sshd hardening — gates **deployment**, not coding | none applied |
| Q22 | Operator accounts / auditd / deploy user | **OPEN** | Also CI runner identity (DEP Q8) | single `ubuntu` until approved |

## A. Blocking for Phase 3 start (all have defaults — Phase 3 proceeds on defaults and records them in STATUS.md)

| ID | Question | Default | Source |
|---|---|---|---|
| Q23 | Permission naming: confirm the A6 catalogue (`organization:read`, `nas:update`, `session:disconnect`) is canonical and A7's dotted names are replaced. | A6 canonical (PHASE2_VALIDATION C-01) | API Q8, MT §4.2, A7 §2 |
| Q24 | Policy specificity: `client_device > user` (A6/A5b) or `user > client-device` (brief wording)? | A6 order (`temporary > client_device > user > voucher_batch > user_group > site > org default`) | PE Q1, DB §3.4, C-02 |
| Q25 | Merge semantics: single-winner with field-level fall-through (allows boosts; site ceilings expressed as SSID `rate-limit`) vs most-restrictive? | single-winner (PE D1) | PE Q2 |
| Q26 | Subscriber `username` unique per organization or per site? | per organization | DB Q1, MT M6 |
| Q27 | Realm on the wire (`user@org-slug`)? | no; tenant from NAS identity | DB Q2, AAA §7 |
| Q28 | One primary `user_group` per subscriber or many-to-many? | single primary group | DB Q6 |
| Q29 | Platform admin identity: one global account with bindings into many orgs, or per-org accounts? | global | DB Q7 |
| Q30 | Will one physical site/NAS ever serve two organizations (shared venue)? If yes, realm/SSID tenant resolution and NAS↔org many-to-many are needed now. | no | MT M2 |
| Q31 | Secrets model: one RADIUS secret per NAS (not per site) and a separate DAS/CoA secret per NAS (`nas_clients.coa_secret_ref`)? | yes to both | AAA Q5, SEC §4.1 |
| Q32 | Fail mode when ECLOUD api/DB is unreachable: fail-closed for unknown subjects + cached-allow (≤15 min) for recently authorized subjects; no fail-open? | fail-closed + cached-allow (PE D7, AAA Q2) | AAA Q2, PE Q7 |
| Q33 | SPA calls the API same-origin via `ecloud.ezelink.ai/api/v1` (`__Host-` cookie) while `api.ecloud.` stays for integrations? | yes (C-08) | API Q1 |
| Q34 | Redis in the pilot (sessions, queues, rate limits, policy cache) or defer to save memory? | include Redis (needed for Idempotency-Key, cached-allow, BullMQ) | DEP Q9 |
| Q35 | Frontend: React + TypeScript + Tailwind SPA (team precedent) — any objection? | React SPA | A7 Q1 |
| Q36 | Who inserts the `sessions` row — engine at authorize or drainer at Acct-Start? (internal, needs A3/A5b sign-off) | engine inserts `authorized`; drainer activates on Start (C-07) | PE Q10 |

## B. Blocking for Phase 5–7 (AAA tuning, portal on device, enforcement, CoA, connectivity)

| ID | Question | Default | Source |
|---|---|---|---|
| Q37 | Which SSID types per site: PSK-only, WPA-Enterprise, open + portal? (Per-client RADIUS rate is verified only for portal clients.) | open+portal first; 802.1X optional | NI Q1 |
| Q38 | Acceptable that captive-portal SSIDs always get an AP-routed subnet (NAT on the AP) even at bridge-mode sites? If not, portal moves to a CoovaChilli gateway. | acceptable (hybrid `hsIface` precedent); DT-13 checks the alternative | NI Q2 |
| Q39 | Plan units/granularity: integer Mbit/s (SSID `rate-limit`) vs bit/s (RADIUS WISPr); sub-1-Mbit plans need the RADIUS path. | store kbit/s; WISPr bit/s for portal clients; SSID cap rounds up to integer Mbit/s | NI Q3, PE §4.1 |
| Q40 | Which captive deployment comes first: uspot on EZEAP or CoovaChilli on an EZE gateway? | uspot on EZEAP | CP Q1 |
| Q41 | Is the EZE gateway CoovaChilli 1.2.9 still in service and may it be upgraded to current master (`coaport`/JSON behaviour verified on master only)? | keep 1.2.9; DT-15 documents gaps | CP Q2 |
| Q42 | Is `radius-gw-proxy`/RadSec via the OpenWiFi gateway in scope, or will EZEAP reach ECLOUD RADIUS directly (tunnel)? | direct over tunnel; RadSec fallback only | CP Q6, WG Q3 |
| Q43 | Is 802.1X WPA-Enterprise in pilot scope? If yes: PEAP-MSCHAPv2 (requires NT-hash storage) or EAP-TTLS/PAP only? Who issues the RADIUS server certificate? | out of pilot; EAP-TTLS/PAP first if added | AAA Q1, SEC Q4 |
| Q44 | Policy-change latency without CoA: acceptable to cap `Session-Timeout` at 15–60 min (forces re-auth; uspot users without MAC-auth see the portal again)? | 30 min cap | AAA Q4 |
| Q45 | `min_session_s` floor (300 s) for drain-time Session-Timeout on NAS without octet attributes — acceptable re-auth cadence? | 300 s | PE Q6 |
| Q46 | Does every site have a Linux/OpenWrt-capable gateway (EZEGATE/EZEOS) that can run WireGuard, or are some sites AP-only (forcing topology B or C)? | gateway present at pilot site; AP-only sites use RadSec | WG Q2 |
| Q47 | Is CoA/Disconnect a must-have for the pilot? If yes and NAS are behind NAT, a tunnel is mandatory. | nice-to-have; Disconnect only | WG Q4, D-006 |
| Q48 | Will two sites ever present the same RADIUS source IP (NAT without WireGuard)? Changes `uq_nas_clients_ip` to `(nas_ip, nas_identifier)`. | no (tunnel gives unique IPs); DT-20 verifies | DB Q3, MT §9 |
| Q49 | Who owns and schedules the ezecontroller "policy fragment" API + state webhook (Option A), and which controller API key would ECLOUD use? | pilot = Option C, no controller change | NI Q4, API Q2 |
| Q50 | Lab availability for device tests: one EZEAP with three lab SSIDs (or one per mode), a NAT router, controller test SSIDs, and optionally an EZE gateway with CoovaChilli re-pointed to lab FreeRADIUS. Who executes and signs the results (PHASE2_VALIDATION §5.4)? | — (extends Q9) | NI Q5, CP Q1–Q2, A9 |

## C. Hardening / operations

| ID | Question | Default | Source |
|---|---|---|---|
| Q51 | RADIUS exposure: tunnel-only in pilot (recommended) or public UDP with allowlist? If any site cannot run WireGuard, approve RadSec with per-NAS client certificates — who issues device certs (ECLOUD PKI vs OpenWiFi certs)? | tunnel-only; RadSec work in Phase 5 if needed | AAA Q3, SEC Q3, DEP Q10 |
| Q52 | Should CoA/Disconnect originate only from the WireGuard hub IP (fixed `uc-ip` requirement of `dynamic-authorization.host`)? | yes (`100.100.0.1`) | NI Q6 |
| Q53 | Hub UDP port (51820 proposed) and OVH edge behaviour for UDP 51820/1812/1813/3799 (ties Q17). | 51820 | WG Q3, Q8 |
| Q54 | Who owns site gateway configuration — ECLOUD-generated bundle applied by site staff, or ECLOUD-managed? | bundle applied by site staff | WG Q5 |
| Q55 | May the EZE controller later emit `service.wireguard-overlay` for APs (topology B), given it would hold AP private keys? | no until DT-18 | WG Q6 |
| Q56 | Monitoring over tunnel: enable SNMP on EZEAP or telemetry-only? | telemetry-only | WG Q7 |
| Q57 | Retention: raw `radius.radacct_raw` after draining (7 days proposed); `accounting_records` 13 months; audit logs 24 months — any regulatory requirement in the operating country; who is data controller per tenant? | as proposed | AAA Q6, DB Q5, SEC Q5 |
| Q58 | Who owns the custom RADIUS dictionary additions (ChilliSpot Gigawords 21–23, CoovaChilli aliases, TIP vendor 0000e608 TLV) and the on-device dictionary check? | A3 owns dictionary; DT-01 checks device | AAA Q7 |
| Q59 | Object storage for branding assets/backups: MinIO on the VPS or an external bucket (ties Q18)? | MinIO container in pilot | API Q5, A7 §6 |
| Q60 | Alert channel for uptime-kuma / security alerts (Slack/Telegram/Discord/webhook) — no MTA on host. | generic webhook placeholder | DEP Q6, SEC Q10 |
| Q61 | Container registry (GHCR vs other) and who owns the org. | GHCR | DEP Q11 |
| Q62 | Accept the host-side WireGuard peer reconciler (unprivileged containers) instead of a sudo helper driven from the worker? | yes | SEC Q9 |
| Q63 | Accept that MAC authentication is low-assurance and restrict it to flagged policies? | yes | SEC Q8, CP Q5 |

## D. Product / UX

| ID | Question | Default | Source |
|---|---|---|---|
| Q64 | Which social IdPs are required for release 1 (each adds hosts to the walled garden; wildcard FQDNs are not rendered by the TIP renderer)? | none in pilot; Google first when needed | CP Q4 |
| Q65 | Quota reset clock: site-TZ midnight / calendar month, or tenant billing anchor day? | site TZ (PE D6) | PE Q3 |
| Q66 | Concurrency breach default `reject` vs `disconnect_oldest` (once Disconnect is verified); count 802.1X and captive devices together? | `reject`; counted together | PE Q4 |
| Q67 | Degradation default when a field is unenforceable on an adapter: fallback-to-ECLOUD-side/allow-and-flag vs strict reject (e.g. a 20 Mbit/s plan on an 802.1X SSID initially not rate-limited)? | fallback + amber warning (PE D5) | PE Q5 |
| Q68 | Preferred rate attribute family per tenant: WISPr bit/s (default) vs ChilliSpot kbit/s? | WISPr | PE Q8 |
| Q69 | Show `burst_*` in the UI as "stored, not enforced" or hide until an adapter supports it? | shown with warning | PE Q9, A7 |
| Q70 | Platform Support impersonation: allowed without tenant consent (always audited, visible to tenant) or tenant-enabled flag with expiry? Guardrails (no key creation / secret rotation / binding changes) acceptable? Must the tenant be notified? | allowed + audited + visible; guardrails on; production → tenant flag | MT M3, API Q3, A7 Q5, SEC Q7 |
| Q71 | Third-party integrations (billing, PMS, CRM) in release 1 — are API keys and webhooks a pilot deliverable? | Phase 4 | API Q4 |
| Q72 | Voucher re-print: store `code_enc` (recoverable with `voucher:reveal` + audit + MFA step-up) or hash-only (print once)? | hash-only | DB Q4, API Q6, SEC Q6 |
| Q73 | Live dashboards via SSE/WebSocket in pilot, or 30 s polling? | polling | API Q7, A7 §3 |
| Q74 | Custom roles per organization at launch, or templates only? | templates only (schema supports custom) | MT M4 |
| Q75 | May Read Only export reports/accounting (`report:export`)? | no | MT M5 |
| Q76 | Should Site Admins create policies or only assign org-defined ones (`policy:create` scope)? | assign-only | A7 Q4 |
| Q77 | Arabic / RTL required for admin app, portal, or both; release-1 locales? | English only; RTL-ready CSS | A7 Q2 |
| Q78 | White-label admin app per organization (logo/colours/custom domain) or per-site portal branding only? | portal branding only | A7 Q3 |
| Q79 | Single `portal.ecloud.ezelink.ai` for all sites vs custom per-org portal hostnames (adds certificate + walled-garden work per site)? | single host | A7 Q6, CP Q3 |
| Q80 | Subscriber self-care surface in release 1? | no | A7 Q7 |
| Q81 | Voucher print format (card size, QR, logo) and fiscal/legal text? | A4 grid + QR, no fiscal text | A7 Q8 |
| Q82 | Which policy controls must be in release 1 (refines Q11): rate + session/idle timeout + validity + vouchers first; quotas/concurrency/schedules/VLAN later? | that order | Q11, PE |

## Summary

- Phase 1 questions Q1–Q22: resolved/answered 14 (Q1, Q2, Q5, Q7, Q8, Q9, Q10, Q13, Q14, Q15, Q22 amended), device test 1 (Q6), partial 3 (Q3, Q4, Q11/Q12 details), open 5 (Q16, Q17, Q18, Q19, Q20, Q21 — all gated by the VPS deployment gate D-031).
- Q23–Q82: defaults APPROVED by the owner on 2026-10-07 with amendments to Q22, Q57, Q59, Q70, Q82 (DECISIONS.md D-023 … D-028).
- Remaining owner input is needed only for the VPS deployment gate (D-031) and the device-test lab schedule (D-034). Phase 3 coding proceeds on the approved defaults.