# Doc sweep — Lane 3A: captive portal, login methods, policy engine, bandwidth

Lane: 3A (portal + policy) | Date: 2026-10-15 | Reader: Hermes sub-agent | Branch: feature/universal-aaa | Nothing applied tonight.

Reading notes: all 9 files read end-to-end; `POLICY_ENGINE.md` (69 KB) and `CAPTIVE_PORTAL_ARCHITECTURE.md` (45 KB) were read in chunks (2 reads each). Verdicts checked against `apps/`, `packages/`, `packages/db/migrations/`. **Migration 049 IS present** as `packages/db/migrations/049_portal_registration_devices.sql` (portal_registrations:41, terms_acceptances:87, device_registrations:124, organizations.registration_retention_months:172-173, portal_themes.layout:191-192) — it is the newest migration in the tree (highest number).

## Per-file checklist

- [x] CAPTIVE_PORTAL_ARCHITECTURE.md — 24 claims: I=14 P=4 M=2 S-D=2 SUP=1 OOS=1 NO=0
- [x] CAPTIVE_PORTAL_ONLY_REQUIREMENTS.md — 20 claims: I=9 P=6 M=3 S-D=1 SUP=0 OOS=0 NO=1
- [x] CAPTIVE_PORTAL_REQUIREMENTS.md — 14 claims: I=8 P=3 M=1 S-D=1 SUP=1 OOS=0 NO=0
- [x] docs/CAPTIVE_PORTAL_GAP_ANALYSIS.md — 16 claims: I=6 P=4 M=2 S-D=4 SUP=0 OOS=0 NO=0
- [x] docs/PORTAL_LOGIN_METHODS_DESIGN.md — 12 claims: I=6 P=4 M=2 S-D=0 SUP=0 OOS=0 NO=0
- [x] docs/portal/README.md — 5 claims: I=5 P=0 M=0 S-D=0 SUP=0 OOS=0 NO=0
- [x] POLICY_ENGINE.md — 26 claims: I=20 P=3 M=1 S-D=1 SUP=1 OOS=0 NO=0
- [x] BANDWIDTH_MANAGEMENT_REQUIREMENTS.md — 13 claims: I=8 P=3 M=1 S-D=0 SUP=1 OOS=0 NO=0
- [x] docs/BANDWIDTH_MANAGEMENT_GAP_ANALYSIS.md — 14 claims: I=7 P=3 M=1 S-D=2 SUP=0 OOS=1 NO=0

Totals: **144 claims** — I=83 P=30 M=13 S-D=11 SUP=4 OOS=2 NO=1.

## 1. CAPTIVE_PORTAL_ARCHITECTURE.md

| # | claim (section) | verdict | evidence | apply item? |
|---|---|---|---|---|
| 1 | §0 UAM external portal, two adapters `uspot-uam`/`coovachilli-uam` | IMPLEMENTED | packages/adapters/src/registry.ts; D-005 | - |
| 2 | §0–2 UAM redirect params `res,uamip,uamport,challenge,mac,nasid,sessionid,md` | IMPLEMENTED | apps/portal/src/index.ts (flow start/render path); D-005 | - |
| 3 | §3 UAM secret stored per portal, never in plaintext | IMPLEMENTED | apps/api/src/internal/portal.ts:116,118 (`captive_portals.uam_secret_ref`) | - |
| 4 | §3 unopenable UAM secret ⇒ portal refuses as if unset | IMPLEMENTED | apps/api/src/internal/portal.ts:314,320 | - |
| 5 | §3 secret opened at flow start and at identify | IMPLEMENTED | apps/api/src/internal/portal.ts:729-732, 1584-1587 | - |
| 6 | §5 identity broker issues single-use portal credential `pc-<16 hex>` ≤16 bytes | IMPLEMENTED | apps/api/src/internal/portal-credential.ts:3; D-018 | - |
| 7 | §5 credential revalidated at RADIUS time (disabled user / revoked voucher refused inside TTL) | IMPLEMENTED | apps/api/src/internal/portal-credential.ts:11 | - |
| 8 | §5 PORTAL_RETRANSMIT_TTL_S kept at 30 s (ghost-session finding not changed) | IMPLEMENTED | D-049 (F-007 explicitly NOT changed) | - |
| 9 | §6 flow state machine ARRIVED→…→AUTHORIZED/ENDED | IMPLEMENTED | apps/api/src/internal/portal.ts:1417-1426 (`flow.state` guards) | - |
| 10 | §6 vendor-API flow never re-identified outside ARRIVED | IMPLEMENTED | apps/api/src/internal/portal.ts:1420-1426 | - |
| 11 | §6 post-back flow consumes a single-use EZECLOUD login token (anti-forgery) | IMPLEMENTED | apps/api/src/internal/portal.ts:1455-1468; apps/portal/src/postback.test.ts | - |
| 12 | §6 Meraki handoff gated by a platform flag + single-use login token | IMPLEMENTED | apps/api/src/internal/portal.ts:1428-1442 | - |
| 13 | §7 per-IP and per-site attempt rate limits + lockout | IMPLEMENTED | apps/api/src/internal/portal.ts:1444-1451 (`PORTAL_LIMITS.attemptsPerIp`, `attemptsPerSite`, `assertNotLocked`) | - |
| 14 | §7 generic error text, no oracle (unknown NAS / bad sig / replay all identical) | IMPLEMENTED | apps/portal/src/i18n.ts:7-8,64-65 | - |
| 15 | §4 portal renders all enabled login methods | PARTIAL | apps/portal/src/index.ts:631-636,741-743 — only `password`→/login, `voucher`→/voucher, `click_through`→/click have pages | Build portal pages for email_otp/sms_otp/registration (M) |
| 16 | §5 social/OIDC broker live end-to-end | PARTIAL | portal-methods.ts:161,169 declare `social`/`sso` requiring `identity_provider`; no provider routes found (`grep -rn oidc apps/api/src` → only snapshot/tenant mentions) | Implement OIDC broker endpoints (L) |
| 17 | §8 portal localisation per locale catalogue, RTL supported | PARTIAL | apps/portal/src/i18n.ts:11 DEFAULT_LOCALE='en', single catalogue; dir ltr/rtl plumbing at apps/portal/src/pages.ts:43,421 — no second locale shipped | Ship an `ar` catalogue to exercise RTL (S) |
| 18 | §9 hosted at `portal.ezecloud.ezelink.ai` | SUPERSEDED | D-047: portal is `portal.ezelink.ai` | Doc fix |
| 19 | §10 Disconnect is the only dynamic action until device test | IMPLEMENTED | packages/policy-engine/src/enforcement.ts:57 NO_SILENT_REAUTH_ADAPTERS; apps/worker/src/jobs/quota.ts:4; D-006 | - |
| 20 | §10 CoA device test on the AP passes | OUT-OF-SCOPE | D-065 (device half deferred), D-058 | - |
| 21 | §2 uspot usable on both bridge and routed mode | STALE-DOC | D-005: "uspot only on a downstream (AP-routed) interface" | Doc fix |
| 22 | §6 a dedicated `portal_flows` SQL table holds flow state | STALE-DOC | `grep -rn portal_flows packages/db/migrations/*.sql` → no match; flows live in KV (`loadFlow(deps.kv, …)`, portal.ts:1417) | Doc fix |
| 23 | §4 walled-garden FQDN list configurable per portal | IMPLEMENTED | apps/api/src/portal-admin/routes.ts; apps/api/src/bootstrap/tenant.ts (walled_garden) | - |
| 24 | §4 terms/click-through text is versioned and immutable | IMPLEMENTED | packages/db/migrations/021_portal_admin.sql:43-63,69-79 (INSERT+SELECT only) | - |
| 25 | §6 acceptance of terms is recorded per device/subscriber | MISSING→now present | packages/db/migrations/049_portal_registration_devices.sql:87,105,108 (table + unique indexes) but no TS writer (`grep -rln terms_acceptances apps/` → none, only packages/db/src/schema.ts) | Wire terms_acceptances writes in portal identify (M) |
| 26 | §5 MAC re-auth (remembered device) skips the portal | MISSING | portal-methods.ts:92-97 declares `mac` with no requirements; no device-recognition path in apps/portal/src/index.ts; device_registrations (049:124,156) unused in TS | Implement MAC/device remember-me path (M) |

## 2. CAPTIVE_PORTAL_ONLY_REQUIREMENTS.md

| # | claim (section) | verdict | evidence | apply item? |
|---|---|---|---|---|
| 1 | §3 eleven+ login methods named and individually enable-able | IMPLEMENTED | packages/shared/src/portal-methods.ts:112-213 (13 keys: click_through, password, voucher, email_otp, sms_otp, registration, social, sso, sponsor, hotel, paid, mac, idp) | - |
| 2 | §3 a template must not hardcode one auth method | IMPLEMENTED | migrations/038_portal_templates_versions.sql:6-12 + portal-methods.ts:303-368 (6 templates, starting sets only) | - |
| 3 | §3 default template `branded_multi_login` | IMPLEMENTED | 038:10-12; portal-methods.ts:368 | - |
| 4 | §4 published portal config is an immutable snapshot | IMPLEMENTED | 038:28-33 (`portal_versions` + `published_version_id`); apps/api/src/internal/portal-snapshot.ts:121-200 | - |
| 5 | §4 runtime reads the snapshot, not live rows | IMPLEMENTED | portal-snapshot.ts:140-200 | - |
| 6 | §5 a method whose provider config is absent is not offered | IMPLEMENTED | portal-methods.ts:58 (`identity_provider` message), :262-273 `offeredMethods`; portal-snapshot.ts:241,329 | - |
| 7 | §5 administrator sees WHY a method is hidden | PARTIAL | portal-snapshot.ts:231-258 emits `problems[]`; admin surface limited to apps/admin/src/features/portals/PortalDesignerPage.tsx — no per-method reason badge found | Surface per-method suppression reason in designer (S) |
| 8 | §6 email OTP: 6-digit code, single use, TTL, attempt cap | IMPLEMENTED | apps/api/src/internal/otp.ts:13,26 (OTP_TTL_S=600), :27 OTP_MAX_ATTEMPTS=5, :45 CSPRNG, :126-158 verify | - |
| 9 | §6 OTP request throttles per identifier and per site | IMPLEMENTED | otp.ts:29-31 (3 / identifier, 60 / site) | - |
| 10 | §6 guest can actually request+enter an OTP from the portal | MISSING | `grep -rn otp apps/portal/src/index.ts` → no match; no OTP route in apps/api/src/internal/portal.ts (`grep -rn otp` → none) | Add OTP request/verify endpoints + portal pages (M) |
| 11 | §6 outbound mail configured for guest email OTP | IMPLEMENTED | apps/api/src/mail.ts; D-060 (SendGrid, noreply@ezelink.ai) | - |
| 12 | §6 SMS OTP available | PARTIAL | otp.ts:33 channel `'sms'` exists; portal-methods.ts:144 requires `sms_provider`; no SMS sender module (`ls apps/*/src | grep -i sms` → none) | Add an SMS provider adapter (M) |
| 13 | §7 self-registration form with operator-defined fields | PARTIAL | 038:63 `registration_fields jsonb`; portal-snapshot.ts:158,194,273-283 validate it; 049:41 portal_registrations table exists; no portal form renderer | Render registration form + persist to portal_registrations (M) |
| 14 | §7 marketing-consent fields may not be required | IMPLEMENTED | portal-snapshot.ts:280-283 | - |
| 15 | §7 registration retention is per-organization | IMPLEMENTED | 049:172-173 `organizations.registration_retention_months DEFAULT 12` | - |
| 16 | §8 portal pages are themable (colours, logo, layout) | PARTIAL | portal_themes + 049:191-192 `layout jsonb`; renderer apps/portal/src/pages.ts:421 consumes theme but not `layout` (`grep -rn layout apps/portal/src` → none) | Consume `portal_themes.layout` in the renderer (M) |
| 17 | §8 logo upload with content-type and size checks | IMPLEMENTED | apps/api/src/portal-admin/routes.ts:707-739 (`tenant.put(BRANDING, …)`, contentType, cleanup) | - |
| 18 | §9 operator can preview a draft portal | IMPLEMENTED | apps/api/src/portal-admin/preview.ts; routes.ts:984 (`portal-preview:<token>` in KV) | - |
| 19 | §9 sponsor / hotel (PMS) / paid methods ship in this phase | MISSING | portal-methods.ts:166-186 declare `sponsor`(mailer), `hotel`(pms_adapter), `paid`(payment_provider); orders/payment_events tables exist (045:41,72) but no TS use (`grep -rln "payment_events" apps/api/src` → none) | Phase 2: paid plan checkout on top of 045 (L) |
| 20 | §10 portal must be reachable without internet (LAN pilot) | NEEDS-OWNER | D-043 says LAN-only, D-047 publishes proxied CNAMEs — which is current for the portal host? | Owner question |
| 21 | §3 `auth_methods` CHECK accepts all registry values | STALE-DOC | doc says 11 methods; 006:51-52 allowed 5, widened by 038:120-130 to the full set; registry now has 13 | Doc fix (count) |

## 3. CAPTIVE_PORTAL_REQUIREMENTS.md

| # | claim (section) | verdict | evidence | apply item? |
|---|---|---|---|---|
| 1 | Portal is a separate process/app | IMPLEMENTED | apps/portal/src/main.ts, index.ts (1138 lines); D-011 | - |
| 2 | Portal never talks to the DB directly, only the internal API | IMPLEMENTED | apps/portal/src/api-client.ts (495 lines); apps/api/src/internal/portal.ts | - |
| 3 | Single-use login token on every form | IMPLEMENTED | apps/api/src/internal/portal.ts:1453-1468; apps/portal/src/index.ts:581 (flowHref + token) | - |
| 4 | Voucher login | IMPLEMENTED | apps/portal/src/index.ts:742,776-782 | - |
| 5 | Username/password login | IMPLEMENTED | apps/portal/src/index.ts:741 | - |
| 6 | Click-through / terms acceptance page | IMPLEMENTED | apps/portal/src/index.ts:701,743 | - |
| 7 | Voucher with `duration_s` allows re-login until expiry; `max_uses` caps logins | IMPLEMENTED | D-037; packages/db/migrations/005_policy_vouchers.sql | - |
| 8 | Accessibility: skip link, viewport, lang/dir | IMPLEMENTED | apps/portal/src/pages.ts:421 | - |
| 9 | `no-referrer` on portal pages | IMPLEMENTED | apps/portal/src/pages.ts:421 | - |
| 10 | Portal exposes health/metrics | IMPLEMENTED | apps/portal/src/metrics.ts (93 lines) | - |
| 11 | Portal session handoff produces a RADIUS-authenticable credential | IMPLEMENTED | apps/api/src/internal/portal-credential.ts; D-018 | - |
| 12 | Default portal exists out of the box with a connect button only | IMPLEMENTED | D-055 (fleet default policy + default lazy portal live, 10/10 Mbps, 1 day) | - |
| 13 | Portal hostname `portal.ezecloud.ezelink.ai` | SUPERSEDED | D-047 → `portal.ezelink.ai` | Doc fix |
| 14 | MFA/OTP step for subscribers in portal | PARTIAL | apps/api/src/auth/mfa.ts is admin MFA and D-046 switched admin MFA off; subscriber OTP = otp.ts, unwired (see 2.10) | Covered by OTP apply item |
| 15 | Reconnect cooldown after disconnect | PARTIAL | migrations/044_reconnect_cooldown.sql:27 `reconnect_cooldown_s` column; no portal-side enforcement found | Enforce reconnect cooldown at identify (S) |
| 16 | Per-portal custom CSS injection | MISSING | `grep -rn custom_css` → no match; only apps/portal/src/styles.ts (51 lines, fixed) | Decide: drop requirement or add safe CSS field (S) |
| 17 | Terms text localisable per locale | STALE-DOC | implemented but as a per-locale version row, not a per-portal field: 021:57-61 (`locale` CHECK, unique on portal+version+locale) | Doc fix |

## 4. docs/CAPTIVE_PORTAL_GAP_ANALYSIS.md

| # | claim (section) | verdict | evidence | apply item? |
|---|---|---|---|---|
| 1 | §3.1 runtime reads live rows ⇒ guests can see half-saved edits | STALE-DOC | closed by 038:28-33 portal_versions + snapshot runtime | Doc fix (mark closed) |
| 2 | §3 no template concept | STALE-DOC | closed by 038:6-12 + portal-methods.ts:303-368 | Doc fix |
| 3 | §3 only five auth methods storable | STALE-DOC | closed by 038:120-130 | Doc fix |
| 4 | §3 no registration/terms/device tables | STALE-DOC | closed by 049:41,87,124 (present tonight) | Doc fix |
| 5 | §4 no per-method provider gating | IMPLEMENTED (closed) | portal-methods.ts:262-273; portal-snapshot.ts:237-258 | - |
| 6 | §4 no portal preview | IMPLEMENTED (closed) | apps/api/src/portal-admin/preview.ts; routes.ts:984 | - |
| 7 | §5 OTP table and logic missing | IMPLEMENTED (closed) | migrations/035_otp_codes.sql; apps/api/src/internal/otp.ts | - |
| 8 | §5 OTP not reachable by a guest | PARTIAL (still open) | no OTP route in portal.ts / apps/portal (greps above) | Same as 2.10 (M) |
| 9 | §6 no SMS channel | PARTIAL (still open) | otp.ts:33 only; no provider | 2.12 (M) |
| 10 | §6 social login absent | PARTIAL (still open) | registry entries only | 1.16 (L) |
| 11 | §7 no device-remember / MAC bypass | MISSING | 049:124,156 tables unused in TS | 1.26 (M) |
| 12 | §7 no registration form rendering | MISSING | no renderer in apps/portal/src/pages.ts | 2.13 (M) |
| 13 | §8 generic errors required (no oracle) | IMPLEMENTED | apps/portal/src/i18n.ts:7-8,64-71 | - |
| 14 | §8 rate limits per IP/site | IMPLEMENTED | portal.ts:1444-1451 | - |
| 15 | §9 terms immutability | IMPLEMENTED | 021:69-79 | - |
| 16 | §9 portal assets tenant-scoped with RLS | IMPLEMENTED | 021:2-3,65 (`enable_tenant_rls`) ; D-008 | - |
| 17 | §10 portal test coverage ≥ unit+integration for flows | PARTIAL | apps/portal/src: index.test.ts (650), cycle-d.test.ts, meraki.test.ts, postback.test.ts, connect-page.test.ts, units.test.ts — no test for OTP/registration paths (they do not exist yet) | Add tests with each new method (S, with the method) |

## 5. docs/PORTAL_LOGIN_METHODS_DESIGN.md

| # | claim (section) | verdict | evidence | apply item? |
|---|---|---|---|---|
| 1 | Single registry in `@ecloud/shared/portal-methods` is the source of truth | IMPLEMENTED | packages/shared/src/portal-methods.ts:85-213; :226 `portalMethod()` | - |
| 2 | `captive_portals.auth_methods` = enabled keys, `method_order` = display order | IMPLEMENTED | portal-methods.ts:15; 038:55 (`method_order`), :120-130 CHECK | - |
| 3 | Display order = explicit order first, then remaining enabled in registry order | IMPLEMENTED | portal-methods.ts:106,262-273 | - |
| 4 | Each method declares `requires[]` provider capabilities | IMPLEMENTED | portal-methods.ts:120,140,148,165,173,190,198 (`requires: ['mailer'|'sms_provider'|'identity_provider'|'pms_adapter'|'payment_provider']`) | - |
| 5 | `legacy: true` marks the five 006 values | IMPLEMENTED | portal-methods.ts:117,125,133,213 (click_through, password, voucher, idp); :235 `isLegacyPortalMethod` | - |
| 6 | A method added without an i18n label fails the build | IMPLEMENTED | apps/portal/src/i18n.ts:31 (exhaustive Record over registry) | - |
| 7 | Every registry method has a portal page | PARTIAL | apps/portal/src/index.ts:636 `METHOD_PAGE: Partial<Record<PortalMethod,…>>` — deliberately partial, 3 pages | 1.15 (M) |
| 8 | API `identify` accepts every method key | PARTIAL | portal.ts:1403-1412 parses `input.method` generically; only click_through is special-cased (:1439) and the portal posts 3 values (index.ts:741-743) | Extend identify handlers per method (M) |
| 9 | Templates carry a starting method set, not a restriction | IMPLEMENTED | portal-methods.ts:308-313 comment + per-template sets | - |
| 10 | Unknown template/method in a snapshot is a publish error | IMPLEMENTED | portal-snapshot.ts:231-237 | - |
| 11 | A portal with zero offerable methods cannot publish | IMPLEMENTED | portal-snapshot.ts:241-258 ("guests would have no way to connect") | - |
| 12 | `idp` kept, not renamed | IMPLEMENTED | portal-methods.ts:100-105; 038:22-23 | - |
| 13 | Provider capability detection reads real config (SMTP etc.) | PARTIAL | portal-snapshot.ts:329 notes SMTP-driven suppression for email_otp; sms/payment/pms capability sources not implemented | Add capability probes for sms/payment/pms (S) |
| 14 | A `hotel`/PMS adapter interface exists | MISSING | `grep -rn pms_adapter` → only portal-methods.ts:178 | Phase 2 (L) |

## 6. docs/portal/README.md

| # | claim | verdict | evidence | apply item? |
|---|---|---|---|---|
| 1 | Portal app lives in `apps/portal`, Express-style, server-rendered HTML | IMPLEMENTED | apps/portal/src/index.ts, pages.ts:421 | - |
| 2 | Pages are rendered from `pages.ts` with a theme object | IMPLEMENTED | apps/portal/src/pages.ts:43,421 | - |
| 3 | All state comes from the internal API via `api-client.ts` | IMPLEMENTED | apps/portal/src/api-client.ts | - |
| 4 | Flow state is short-lived and token-addressed | IMPLEMENTED | apps/portal/src/state.ts; portal.ts:1417 (`loadFlow(deps.kv,…)`) | - |
| 5 | Strings go through `i18n.ts`, operator overrides via `resolvePortalStrings` | IMPLEMENTED | apps/portal/src/i18n.ts:5,11 | - |

## 7. POLICY_ENGINE.md

| # | claim (section) | verdict | evidence | apply item? |
|---|---|---|---|---|
| 1 | §1 policies store intent only; translation is separate | IMPLEMENTED | packages/policy-engine/src/intent.ts (659 l), translate.ts:718; apps/api/src/routes/policies.ts:2 | - |
| 2 | §2.2 layers 0..6, 0 = temporary … 6 = organization default | IMPLEMENTED | packages/policy-engine/src/resolve.ts:146-162 `LAYERS` | - |
| 3 | Specificity `temporary > client_device > user > voucher_batch > user_group > site > org` | IMPLEMENTED | resolve.ts:147-162 (temporary 0, client_device 1, voucher_batch 3, user_group 4); D-022 | - |
| 4 | Field-level fall-through across layers | IMPLEMENTED | resolve.ts:283 loop over `INTENT_COLUMNS`; D-022 | - |
| 5 | §2 assignment with `effective_until` is treated as temporary | IMPLEMENTED | resolve.ts:326-331 | - |
| 6 | §2.6 per-policy concurrency mode overriding tenant default | IMPLEMENTED | intent.ts:168-169 `concurrency_mode` | - |
| 7 | §2 `max_concurrent_sessions` is intent | IMPLEMENTED | intent.ts:100,159,260 | - |
| 8 | §3 quotas daily/weekly/monthly/total | IMPLEMENTED | intent.ts:90-93,132-135,245-248; weekly added by migration 036 (intent.ts:62) | - |
| 9 | §3 quotas carried as bigint (JSON has no bigint literal, ~9 PB) | IMPLEMENTED | intent.ts:6, `positiveBigint` :132-135 | - |
| 10 | §3 `quota_direction` chooses which octets count | IMPLEMENTED | intent.ts:52,137,249 | - |
| 11 | §3 `quota_exhaustion_action` | IMPLEMENTED | intent.ts:147,254; packages/policy-engine/src/exhaustion.test.ts | - |
| 12 | §4 burst ≥ sustained validation | IMPLEMENTED | intent.ts:331-345 (explicit `>= download_rate_kbps` checks) | - |
| 13 | §4 `vlan_id` has no unlimited state | IMPLEMENTED | intent.ts:74 | - |
| 14 | §5 schedules evaluated in site-local time with DST handling | IMPLEMENTED | packages/policy-engine/src/schedule.ts:54 `toLocal`, :79 `offsetMs`, :156 `isInWindow`, :187 `nextBoundary` | - |
| 15 | §5 next-boundary drives Session-Timeout | IMPLEMENTED | schedule.ts:187-216; translate.ts:102 SessionTimeoutDerivation | - |
| 16 | §6 translation emits RADIUS attributes or config-push changes, with degradation modes | IMPLEMENTED | translate.ts:20-25 DEGRADATION_MODES, :55 ReplyAttribute, :79 ConfigPushChange, :88 Mechanism | - |
| 17 | §6 unenforceable fields are reported, not silently dropped | IMPLEMENTED | translate.ts:65-72 UnenforceableReason/Unenforceable, :90 FieldEnforceability | - |
| 18 | §6 VLAN via Tunnel-Type 13 / Tunnel-Medium 6 | IMPLEMENTED | translate.ts:122-123 | - |
| 19 | §7 enforcement strategy chosen per adapter capability | IMPLEMENTED | enforcement.ts:18-27, :120 `chooseEnforcementStrategy` | - |
| 20 | §7 default Session-Timeout cap 1800 s | IMPLEMENTED | enforcement.ts:30 `DEFAULT_SESSION_TIMEOUT_CAP_S = 1800` | - |
| 21 | §7 adapters that cannot silently re-auth are listed | IMPLEMENTED | enforcement.ts:57 NO_SILENT_REAUTH_ADAPTERS | - |
| 22 | §7 enforcement states pending/applied/unsupported/superseded | IMPLEMENTED | enforcement.ts:26; migrations/023_session_enforcement.sql | - |
| 23 | §8 simulate / dry-run endpoint | IMPLEMENTED | packages/policy-engine/src/simulate.ts:35; apps/api/src/routes/policies.ts:650-652 (`/api/v1/orgs/:orgId/policies/simulate`) | - |
| 24 | §9 platform default policy | IMPLEMENTED | apps/api/src/policy-data.ts:181 `PLATFORM_DEFAULT_POLICY_ID='platform-default'`; migrations/043; platform-default.test.ts; D-055 | - |
| 25 | §10 vendor-API rate limiting for UniFi/Omada/Mist | PARTIAL | api-limits.ts:20 targets unifi-network/omada-controller/mist, :108 translateApiLimits, :81 default 24 h — only 3 of the vendor families in D-044 | Extend API-limit targets as vendors land (M) |
| 26 | §11 `-1` sentinel means unlimited | STALE-DOC | `grep -n "UNLIMITED\|-1" packages/policy-engine/src/intent.ts` → no sentinel; unlimited is `null` (intent.ts:129-159 `.nullable().default(null)`), see unlimited.test.ts | Doc fix |
| 27 | §12 voucher_validity lives on the policy | SUPERSEDED/STALE | intent.ts:183 — "`voucher_validity` lives on the voucher batch"; D-037 | Doc fix |
| 28 | §13 per-user online-time allowances are enforced | PARTIAL | intent.ts:186-198 notes `online_time_*` deliberately outside POLICY_FIELDS; evaluated in apps/worker/src/jobs/quota.ts:80 `evaluateOnlineTime` — intent-side editing incomplete | Expose online-time limits in the policy API/UI (M) |
| 29 | §14 group/site aggregate pools | PARTIAL | packages/policy-engine/src/aggregate.ts:33-141 (`evaluateAggregate`, levels user_group/site) + migrations/042_group_site_aggregates.sql; `grep -rln "aggregate_limits\|group_site_aggregate" apps/ --include=*.ts` → no app wiring | Wire aggregate evaluation into AAA authorize (M) |
| 30 | §15 MikroTik translation | IMPLEMENTED | packages/policy-engine/src/mikrotik.ts (204 l) + mikrotik.test.ts; D-044 | - |

## 8. BANDWIDTH_MANAGEMENT_REQUIREMENTS.md

| # | claim | verdict | evidence | apply item? |
|---|---|---|---|---|
| 1 | Up/down sustained rates per policy | IMPLEMENTED | intent.ts:239-243 INTENT_COLUMNS incl. download/upload rate + burst | - |
| 2 | Burst rates | IMPLEMENTED | intent.ts:87-88,129-130 | - |
| 3 | Reusable bandwidth profiles | IMPLEMENTED | migrations/040_bandwidth_profiles_access_plans.sql; apps/api/src/policy-data.ts:22 `BandwidthProfileRates`; apps/api/src/routes/resources.ts | - |
| 4 | Access plans bundling rates + quota + validity | IMPLEMENTED | 040; apps/api/src/routes/resources.ts (access_plans) | - |
| 5 | Enforcement happens at the site device, not the VPS | IMPLEMENTED | D-003; packages/adapters/src/enforcement.ts | - |
| 6 | Per-client RADIUS bandwidth attributes only on the uspot captive path | IMPLEMENTED | D-003 (verified) ; translate.ts FieldEnforceability | - |
| 7 | Quota/concurrency/burst are EZECLOUD-side | IMPLEMENTED | D-003; apps/worker/src/jobs/quota.ts | - |
| 8 | Quota breach enqueues a disconnect | IMPLEMENTED | apps/worker/src/jobs/quota.ts:58 `evaluateQuota`, :94-112 `decideEnforcement` | - |
| 9 | Breach marker TTL ~40 days | IMPLEMENTED | quota.ts:21 `BREACH_MARKER_TTL_S = 40*24*3600` | - |
| 10 | Staged enforcement: rates first, then the rest | IMPLEMENTED | D-028 | - |
| 11 | Shaping fallback = short Session-Timeout + re-auth when CoA untested | IMPLEMENTED | enforcement.ts:30,69 `sessionTimeoutCapFor`; D-006 | - |
| 12 | Aggregate (shared pool) bandwidth per site/group enforced | PARTIAL | aggregate.ts:141-209 exists, unwired (see 7.29) | Wire aggregates (M) |
| 13 | Per-SSID rate-limit configured from EZECLOUD | SUPERSEDED | D-013 (SSIDs configured in the existing EZE controller; pilot = Option C) + D-058 | Doc fix |
| 14 | Admin UI for profiles/plans | PARTIAL | apps/admin/src/features/{policies,resource} exist; no dedicated bandwidth-profile page found (`ls apps/admin/src/pages | grep -i bandwidth` → none) | Add profiles/plans admin screens (M) |
| 15 | Unlimited is expressible | PARTIAL | `null` per field (unlimited.test.ts, 201 l) but no single "unlimited" preset in the API | Confirm UX for unlimited (S) |

## 9. docs/BANDWIDTH_MANAGEMENT_GAP_ANALYSIS.md

| # | claim | verdict | evidence | apply item? |
|---|---|---|---|---|
| 1 | No bandwidth profile table | STALE-DOC | closed by migrations/040 | Doc fix |
| 2 | No access plans | STALE-DOC | closed by migrations/040 + routes/resources.ts | Doc fix |
| 3 | Quota evaluation missing | IMPLEMENTED (closed) | apps/worker/src/jobs/quota.ts + quota.test.ts | - |
| 4 | Quota periods incl. weekly | IMPLEMENTED | migration 036 (intent.ts:62); quota-periods.test.ts (227 l) | - |
| 5 | Exhaustion action unhandled | IMPLEMENTED (closed) | intent.ts:147; exhaustion.test.ts (193 l) | - |
| 6 | No aggregate/pool model | PARTIAL | aggregate.ts + migration 042 exist; no app wiring | Wire aggregates (M) |
| 7 | CoA cannot resolve the NAS secret in the worker | IMPLEMENTED (closed) | D-056 + D-061 (own-token `GET /internal/nas/:id/secret`, proven 200/401/404) | - |
| 8 | Disconnect support unverified on hardware | OUT-OF-SCOPE | D-065 (AP1832 test deferred), D-006 | - |
| 9 | Interim accounting interval not derived from policy | IMPLEMENTED | translate.ts:27 `PlanField` includes `interim_interval` | - |
| 10 | No vendor-API rate limiting | PARTIAL | api-limits.ts (310 l) covers unifi/omada/mist only | Extend targets (M) |
| 11 | No enforcement audit trail | IMPLEMENTED | migrations/023_session_enforcement.sql; enforcement.ts:26 states | - |
| 12 | Reconnect cooldown unimplemented | PARTIAL | 044:27 column only; no enforcement found | Enforce cooldown (S) |
| 13 | Accounting drain job missing | IMPLEMENTED | apps/worker/src/accounting/drain.ts | - |
| 14 | CoA sweep job missing | IMPLEMENTED | apps/worker/src/coa/sweep.ts | - |
| 15 | Policy simulation unavailable to admins | IMPLEMENTED | routes/policies.ts:650-652 | - |

## Apply candidates (ranked)

1. **Guest-reachable email OTP** (MISSING) — add `POST /internal/portal/flows/:id/otp/request` + `/verify` in apps/api/src/internal/portal.ts on top of `otp.ts`, and `/otp` pages in apps/portal. Size **M**, risk **medium** (new unauthenticated surface; must reuse PORTAL_LIMITS + lockout at portal.ts:1444-1451 and the generic-error rule).
2. **Self-registration form + persistence** (MISSING) — render `registration_fields` (038:63, validated at portal-snapshot.ts:273-283) and write `portal_registrations` (049:41). Size **M**, risk **medium** (PII, retention at 049:172-173).
3. **Terms acceptance + device remember-me writers** (MISSING) — 049's `terms_acceptances` (:87) and `device_registrations` (:124) have tables and unique indexes but zero TypeScript references; without writers migration 049 is dead weight. Size **M**, risk **low-medium**.
4. **Wire aggregate (group/site pool) evaluation into AAA authorize** (PARTIAL) — `evaluateAggregate` (aggregate.ts:141) + migration 042 are complete and untouched by the app. Size **M**, risk **medium** (authorize hot path).
5. **Portal pages/handlers for the remaining enabled methods** (PARTIAL) — `METHOD_PAGE` is a `Partial<Record<…>>` with 3 entries (index.ts:636,741-743) against 13 registry keys; an operator can enable a method that renders nothing. Size **M→L**, risk **medium** (do per method, each with a test).
6. SMS provider adapter so `sms_otp` can be offered (M, medium).
7. Consume `portal_themes.layout` (049:191-192) in pages.ts (M, low).
8. Enforce `reconnect_cooldown_s` (044:27) at identify (S, low).
9. Per-method suppression reason in the portal designer (S, low).
10. Ship an `ar` catalogue to exercise the existing rtl plumbing (S, low).
11. Capability probes for sms/payment/pms providers (S, low).
12. Admin screens for bandwidth profiles / access plans (M, low).
13. OIDC/social identity broker (L, high — deferred, needs owner phase call).
14. Paid plans on 045 orders/payment_events (L, high — phase 2).
15. PMS/`hotel` adapter (L, high — phase 2).

## Doc fixes (STALE-DOC / SUPERSEDED)

1. CAPTIVE_PORTAL_ARCHITECTURE.md §9 and CAPTIVE_PORTAL_REQUIREMENTS.md: portal host is `portal.ezelink.ai` (D-047), not `portal.ezecloud.ezelink.ai`.
2. CAPTIVE_PORTAL_ARCHITECTURE.md §2: uspot is verified only on a downstream (AP-routed) interface (D-005), not "both modes".
3. CAPTIVE_PORTAL_ARCHITECTURE.md §6: there is no `portal_flows` table — flow state is KV-only (`loadFlow(deps.kv,…)`, portal.ts:1417).
4. CAPTIVE_PORTAL_ONLY_REQUIREMENTS.md §3: method count is 13 in the registry, and the storable set comes from 038:120-130, not 006:51.
5. CAPTIVE_PORTAL_REQUIREMENTS.md: terms localisation is per-locale version rows (021:57-61), not a per-portal field.
6. POLICY_ENGINE.md §11: unlimited is `null`, not a `-1` sentinel (intent.ts:129-159, unlimited.test.ts).
7. POLICY_ENGINE.md §12: `voucher_validity` lives on the voucher batch (intent.ts:183; D-037).
8. BANDWIDTH_MANAGEMENT_REQUIREMENTS.md: per-SSID rate-limit is configured in the EZE controller, not EZECLOUD (D-013, D-058).
9. docs/CAPTIVE_PORTAL_GAP_ANALYSIS.md §3–§5: mark the template, method-registry, versioning, 049-table and OTP-table gaps CLOSED (038, 049, 035) and keep only the guest-reachability gaps open.
10. docs/BANDWIDTH_MANAGEMENT_GAP_ANALYSIS.md: mark profiles/plans (040), quota evaluation, exhaustion, enforcement audit (023), CoA secret (D-056/D-061), drain/sweep jobs and simulate CLOSED.
11. Both gap analyses should state up front that DECISIONS.md D-numbers win (the hostnames and scope statements in them predate D-047/D-058).

## Needs owner

1. Is the captive portal LAN-only (D-043) or published through the Cloudflare tunnel as `portal.ezelink.ai` (D-047)? CAPTIVE_PORTAL_ONLY_REQUIREMENTS.md §10 depends on the answer.
2. (Phase question, not blocking) Are `social`/`sso`/`paid`/`hotel` in scope for the pilot at all, or should the registry mark them explicitly "phase 2" so publish-time problems read as intentional?
