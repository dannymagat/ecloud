# Bandwidth Management — audit and gap analysis

Source requirement: `BANDWIDTH_MANAGEMENT_REQUIREMENTS.md` (owner, 2026-10-14), with
`docs/bandwidth-management-infographic.png` inspected and found consistent with it.

Audit date: 2026-10-14. Branch `feature/universal-aaa`. Every row below cites code; nothing is
inferred from documentation or from a UI control. Claims are separated into three evidence
classes, as §2 of the requirement demands:

| Class | Meaning |
|---|---|
| **CODE** | The code path exists and was read during this audit |
| **TESTED** | Covered by the automated suite (`vitest`, 1568 passing at the last full run) |
| **LIVE** | Observed against real hardware (Cisco AP1832 + OpenWrt uspot, 2026-10-14 05:27:58Z) |

A fourth state, **UNVERIFIED**, is used where code exists but neither a test nor a device run
confirms the behaviour.

---

## 1. What this platform actually is

Discovered from code, not assumed:

- **Monorepo**, npm workspaces, TypeScript / Node 22: `apps/{api,worker,portal,admin}`,
  `packages/{shared,db,policy-engine,adapters,storage,testing,vendor-api}`.
- **API**: Express 5, zod → OpenAPI 3.1, `apps/api/src/routes/*.ts` (27 modules).
- **Database**: PostgreSQL 16, Kysely, 35 forward-only migrations
  (`packages/db/migrations/001..035`), 48 application tables, RLS **ENABLE + FORCE** with a
  `tenant_isolation` policy on 40 of them (`packages/db/src/tables.ts:TENANT_SCOPED_TABLES`).
- **AAA**: FreeRADIUS 3.2.10 calling back into the API over `/internal/aaa/*`; accounting lands
  in `radius.radacct_raw` and is drained by the worker (`apps/worker/src/accounting/drain.ts`).
- **Policy engine**: a pure package, `packages/policy-engine/src/` — resolution (`resolve.ts`),
  RADIUS translation (`translate.ts`), controller-API translation (`api-limits.ts`), enforcement
  strategy (`enforcement.ts`), schedules (`schedule.ts`), validation (`intent.ts`).
- **Captive portal**: separate process holding no database credentials
  (`apps/portal/src/`), decisions made by the API over `/internal/portal/*`.
- **Gateways**: nine adapters (`packages/adapters/src/adapters/`), each carrying a per-field
  capability record with a four-state status and an evidence level.

The last point matters for this requirement more than anything else in the repository: §8
("disable or explain unsupported settings rather than silently ignoring them") and §15 ("RADIUS
acceptance … does not prove bandwidth enforcement") are already the architecture here, not a gap.

---

## 2. Gap analysis

### 2.1 Access plans (requirement §4)

| Feature | Existing evidence / file or service | Status | Required change | Enforcement dependency |
| --- | --- | --- | --- | --- |
| Name, description | `policies.name`, `.description` (005_policy_vouchers.sql) | Working (TESTED) | — | — |
| Short code | none | Missing | `access_plans.code`, unique per org | none (presentation) |
| Enabled / disabled | `policies.status` draft/active/retired | Partial (TESTED) | `retired` is immutable and permanent; a reversible `enabled` flag is a different concept | none |
| Default plan in scope | `policies.is_default`, unique per org (`uq_policies_org_default`), rule 9 in `intent.ts:342` | Working (TESTED) | Scope is org-wide only; per-site default not expressible | none |
| Free/paid, price, currency, display order | none | Missing | `access_plans` table | payment provider (§14) |
| Bandwidth profile reference | rates are inline columns on `policies` | Missing | `bandwidth_profiles` table + FK | — |
| Eligible authentication methods | `captive_portals.auth_methods` is per-portal, not per-plan | Missing | `access_plans.eligible_auth_methods` | — |
| Data / time / device / concurrency rules | `policies.quota_*`, `session_timeout_s`, `idle_timeout_s`, `max_devices`, `max_concurrent_sessions` | Working (LIVE for timeouts and rates) | — | gateway per field |
| Validity duration | `policies.valid_from/valid_until` (absolute), `voucher_batches.duration_s` (relative) | Partial (TESTED) | A plan needs a relative duration independent of vouchers | — |
| Activation trigger (creation / purchase / first login) | vouchers only: `vouchers.activated_at`, `resolve.ts:evaluateVoucher` | Partial (TESTED) | Generalise first-use activation to any subscription | — |
| Location / SSID / gateway / VLAN applicability | `policies.site_id`, `policies.vlan_id`; SSID only via the rate-limit export page | Partial | Per-SSID and per-gateway plan applicability absent | gateway |
| Quota-exhaustion action | deny only (`resolve.ts:evaluateQuota` returns `reject`), or disconnect (`apps/worker/src/jobs/quota.ts`) | Partial (TESTED) | Add `reduce_speed` with a reduced-rate reference, and `require_renewal` | CoA or next reauthorization |
| Renewal / subscription / PMS references | none | Missing | optional module (§14) | external |

**Finding.** There is no "plan" entity. `policies` is an *enforcement intent*, correctly separated
from identity, and the requirement's §3 explicitly warns against folding a billing product into it.
The right shape is a thin `access_plans` row that references one policy and one bandwidth profile,
leaving the AAA path untouched.

### 2.2 Authentication (requirement §5)

| Method | Existing evidence | Status | Required change | Enforcement dependency |
| --- | --- | --- | --- | --- |
| Username / password | `PORTAL_LOGIN_METHODS` (`packages/shared/src/portal-theme.ts:69`), argon2id in `users.password_hash` | Working (LIVE) | — | — |
| Voucher | `vouchers` + `voucher_batches`, hashed codes, `use_count`, per-site brute-force cap (017_voucher_limits.sql) | Working (TESTED) | — | — |
| Accept terms | `click_through` method, `portal_terms_versions` records the accepted version | Working (TESTED) | — | — |
| MAC authentication | `client_devices.mac_auth_enabled`, `.blocked`; `users.auth_methods` accepts `mac` | Working (CODE/TESTED) | Expiry and an explicit allowlist/blocklist precedence are not modelled | NAS MAC-auth support |
| Email OTP | migration 035 + `apps/api/src/internal/otp.ts` + `apps/api/src/mail.ts` — **core only** | Partial | Identify methods `otp_request`/`otp_verify`, portal pages, admin wiring | SMTP credentials (owner) |
| SMS OTP | `otp_codes.channel` accepts `'sms'`; no provider adapter | Missing | provider adapter + spend ceiling | SMS gateway account |
| Social login (Google/Facebook/Apple) | `identity_providers` table exists (004/006) with the provider types; **no code reads it** | Missing | whole OIDC runtime | provider accounts, walled garden |
| Registration form | `users.origin = 'portal_signup'` is allowed; no form | Missing | configurable fields + consent | — |
| Enterprise SSO (SAML) | `identity_providers.type` allows `saml`; no code | Missing | out of current scope | IdP |
| 802.1X / RADIUS | adapter `generic-radius-8021x`, `openwifi-hostapd-radius` | Working (CODE) | EAP method matrix is not surfaced in the UI | NAS |

**Finding.** Three of ten methods are live. The schema anticipated the rest (this is why the work
is additive), but `identity_providers` has **no runtime at all**: no route, no admin page, no
portal path. Email OTP is half-built: the storage, the hashing, the rate-limit constants and the
mailer exist and are unit-tested; nothing calls them yet.

### 2.3 Per-user controls (requirement §6)

| Control | Existing evidence | Status | Required change | Enforcement dependency |
| --- | --- | --- | --- | --- |
| Max download / upload speed | `policies.download_rate_kbps/upload_rate_kbps` → `WISPr-Bandwidth-Max-Down/Up` | Working (LIVE: 10000000 bit/s observed on AP1832) | — | gateway |
| Limit scope: per device vs per account | data quota is **always per account** when a user is known (`apps/api/src/policy-data.ts:189-216` selects the `user` counter); the `client_device` counter is written but never read for quota | Partial (CODE) | Make the scope an explicit, displayed choice | — |
| Data allowance, combined | `quota_daily/monthly/total_bytes`, `resolve.ts:evaluateQuota` sums `bytes_in + bytes_out` | Working (TESTED) | — | accounting |
| Data allowance, upload-only or download-only | none — only the sum | Missing | a quota direction | accounting |
| Cumulative online-time allowance | `usage_counters.session_time_s` is accumulated (`drain.ts:936`) but **never read as a limit** | Missing | time-quota fields + evaluation | accounting |
| Max continuous session duration | `policies.session_timeout_s` → `Session-Timeout` | Working (LIVE: 1800 s observed, session closed on time) | — | gateway |
| Idle timeout | `policies.idle_timeout_s` → `Idle-Timeout` | Working (LIVE) | — | gateway |
| Reconnect cooldown | `policies.reconnect_cooldown_s`, evaluated in `resolve.ts` against the subject's last session end | Working (TESTED) | — | — |
| Max registered devices | `policies.max_devices`, `users.max_devices` | Working (TESTED) | — | — |
| Max simultaneous sessions | `policies.max_concurrent_sessions` + `concurrency_mode` reject/disconnect_oldest | Working (TESTED) | — | Disconnect for `disconnect_oldest` |
| Allowed access hours and days | `schedules` (IANA tz, day+HH:MM rules), `schedule.ts` | Working (TESTED) | — | — |
| Account / subscription expiry | `users.valid_from/valid_until`, `users.status` | Working (TESTED) | — | — |
| Individual overrides | `policies.scope_type = 'user'` + a `policy_assignments` row at layer 2 | Working (TESTED) | Present but policy-centric in the UI; no per-user override editor | — |
| Burst speed | `burst_download_kbps`, `burst_upload_kbps`, `burst_duration_s` | Working (CODE), per-adapter status | — | gateway (MikroTik only, today) |
| Priority, minimum reserved bandwidth | none | Missing | model + honest capability reporting | gateway queue support |

**Finding.** Account-wide sharing of the *data* allowance already works correctly (requirement
§6 last line) — several devices of one user draw down one counter. Account-wide sharing of
*speed* does not and largely cannot: `WISPr-Bandwidth-Max-*` is per session by construction.

### 2.4 Per-group controls (requirement §7)

| Control | Existing evidence | Status | Required change | Enforcement dependency |
| --- | --- | --- | --- | --- |
| Default per-member settings | a policy assigned to `target_type = 'user_group'`, layer 4 (`resolve.ts:LAYERS`) | Working (TESTED) | — | — |
| Group schedule and priority | same assignment carries `schedule_id` and `priority` | Working (TESTED) | — | — |
| Aggregate max download / upload (shared pool) | **none** — `user_groups` has only id/name/description/is_default/site_id | Missing | model + capability reporting | **coordinated gateway queue; not expressible in RADIUS** |
| Shared group data allowance | `usage_counters.subject_type` CHECK allows only `user`, `client_device`, `voucher`, `site` | Missing | add a group subject + evaluation | accounting |
| Max simultaneously active users / sessions | none at group level | Missing | model + authorize-time count | — |
| Explicit enforcement scope | the adapter capability model already carries per-field scope | Working (CODE) | extend to aggregates | — |
| Reserved capacity | none | Missing | out of scope until a gateway supports it | gateway |

**Finding — and this is the most important honest statement in this document.** The infographic's
headline example ("each guest up to 10 Mbps; all guests share a 100 Mbps pool") **cannot be
enforced by any gateway currently integrated**. A shared pool needs a parent queue or a controller
bandwidth group at the enforcement point. Of the nine adapters, none declares one. Modelling a
pool is cheap; enforcing it is not, and per requirement §7 ("do not label independent gateway caps
as a single global shared pool") and §15 ("expose unsupported scope honestly") the honest outcome
is to model it, display it, and mark its enforcement **UNSUPPORTED on the present fleet** — with
a per-site *observed* total so an operator can at least see when a pool is exceeded.

### 2.5 Bandwidth profiles and fairness (requirement §8)

| Control | Existing evidence | Status | Required change | Enforcement dependency |
| --- | --- | --- | --- | --- |
| Reusable speed presets | none — rates are inline on every policy | Missing | `bandwidth_profiles` | — |
| Client-perspective labelling | `translate.ts:329` documents rx/tx direction per vendor; admin shows "down/up" | Working (CODE) | — | — |
| Storage units | rates kbit/s, data bytes SI, durations seconds — stated at `intent.ts:3` | Working (TESTED) | Requirement asks for bit/s storage; kbit/s is the existing convention and is unambiguous — **documented deviation**, not a change | — |
| Max / priority / burst / reserved as separate concepts | max and burst separate; priority and reserved absent | Partial | add the two missing concepts | gateway |
| Fair sharing within a pool | none | Missing | depends on §7 | gateway |
| Capacity check of reservations | none | Missing | depends on §7 | gateway |
| Disable or explain unsupported settings | `EnforceabilityMatrix.tsx`, `capabilities.ts`, four-state field status | **Working (TESTED)** — exceeds the requirement | — | — |

### 2.6 Quotas, time and validity (requirement §9)

| Control | Existing evidence | Status | Required change | Enforcement dependency |
| --- | --- | --- | --- | --- |
| Counters in bytes, SI display | `usage_counters.bytes_in/out` bigint; `intent.ts:3` | Working (TESTED) | — | — |
| Upload-only / download-only quotas | none | Missing | quota direction | accounting |
| Daily / monthly / lifetime periods | `period_type IN ('daily','monthly','total')` (007:179) | Working (TESTED) | — | accounting |
| Weekly period | **not allowed by the CHECK constraint** | Missing | add `weekly` | accounting |
| Per-member vs shared group quota | per-member only | Missing | see §7 | accounting |
| Calendar vs rolling reset | calendar, in the site's IANA zone (`accounting/normalize.ts:36`) | Working (TESTED) | Document it; rolling not offered | — |
| Reset timezone / time / boundary | timezone yes (`sites.timezone`); reset hour and week-start not configurable | Partial | optional configuration | — |
| Validity vs session duration vs online time vs idle | three of four are distinct and enforced; online time is not enforced at all | Partial | add online-time quota | accounting |
| Concurrent-device online-time semantics | n/a until online time exists | Missing | define and display: sum of device-session time | accounting |
| Exhaustion actions | deny (authorize) and disconnect (worker, gated on adapter evidence) | Partial (TESTED) | reduce-speed and require-renewal | CoA / next reauth |
| Active-session update on reset or exhaustion | `apps/worker/src/jobs/quota.ts` + `session_enforcement` rows; strategy chosen from adapter evidence (`enforcement.ts`) | Working (TESTED) | — | CoA evidence |
| Reconnects must not reset allowances | counters are keyed `(subject, period, period_start)` and advanced by delta | Working (TESTED) | — | — |
| Persist across restarts | counters are in PostgreSQL; the drain is idempotent per record | Working (TESTED) | — | — |
| Duplicate / delayed / out-of-order / missing records | `accounting_anomalies` table, delta logic and `last_record_id` in `drain.ts` | Working (TESTED) | — | — |
| Document intervals, delay, overshoot | `resolve.ts:evaluateQuota` subtracts an *estimated* unreported-usage reserve; interim interval is NAS-authoritative (documented in `openwifi-uspot-uam.ts`) | Working (CODE, LIVE: 602 s interim observed) | — | NAS |
| Atomic first activation / redemption | voucher redemption is transactional with `forUpdate` | Working (TESTED) | Generalise once plans exist | — |

### 2.7 Policy resolution (requirement §10)

| Control | Existing evidence | Status | Required change | Enforcement dependency |
| --- | --- | --- | --- | --- |
| Deterministic precedence | seven layers, `resolve.ts:130` — temporary 0, client_device 1, user 2, voucher_batch 3, user_group 4, site 5, organization_default 6; ties broken by assignment priority, policy priority, layer, `effective_from`, then id | **Working (TESTED)** | Requirement §10 asks for default → plan/group → individual; the existing order is a superset and is *more* specific, not less | — |
| Field-level fall-through | `resolve.ts:merge` — first non-null wins per field, with provenance per field | Working (TESTED) | — | — |
| Several groups | a user has exactly one `user_group_id`; multi-group ambiguity cannot arise | Working (TESTED) | — | — |
| Aggregate limits survive overrides | no aggregates exist yet | Missing | see §7 | — |
| Disabled / blocked / expired remain denials | `users.status`, `client_devices.blocked`, validity windows, voucher state | Working (TESTED) | — | — |
| Schedules intersect | `resolve.ts` collects every applicable layer's schedule and requires all to permit; the window ends at the earliest of their ends (migration 044 work) | **Working (TESTED)** | — | — |
| Inherited vs unlimited vs disabled as distinct states | `null` means inherit; there is **no way to say "unlimited" at a lower layer**, so a child cannot escape a parent's cap even deliberately | Missing | tri-state | — |
| Effective policy with source, constraints, status | `GET /policies/simulate` returns `effective` + per-field `provenance` + full `trace`; `POST /policies/:id/impact-preview`; `ImpactPreview.tsx`, `PreviewPanel.tsx`, `EnforceabilityMatrix.tsx` | **Working (TESTED)** — exceeds the requirement | — | — |
| Unsupported combinations fail validation | 11 numbered rules in `intent.ts` with actionable messages | Working (TESTED) | — | — |

### 2.8 Users, devices, vouchers (requirement §11)

| Control | Existing evidence | Status |
| --- | --- | --- |
| Search / filter users, groups, sessions | admin `features/{sessions,usage,vouchers}` + cursor-paged list routes | Working (TESTED) |
| Assigned plans, effective policy, usage, devices, history | simulate + usage + sessions routes | Working (TESTED) |
| Suspend / reactivate, expiry, overrides | `users.status`, validity, user-scope policies | Working (TESTED) |
| MAC allowlist / blocklist precedence | `client_devices.blocked` exists; allowlist is implicit (registered = allowed); precedence is not documented or tested | Partial |
| Administrative changes recorded with reason | `audit_logs` (partitioned), `policy_assignments.note` | Working (TESTED) |
| Quick and bulk voucher creation | `routes/vouchers.ts`, `voucher_batches.count` | Working (TESTED) |
| Unpredictable codes, controlled export | hashed at rest (`code_hash`), `code_enc` sealed, `exported_at` | Working (TESTED) |
| Redemption state, revocation, expiry, history | `vouchers.status`, `revoked_by`, `use_count` | Working (TESTED) |
| Idempotent redemption | transactional with row lock | Working (TESTED) |

### 2.9 Network assignment (requirement §12)

| Control | Existing evidence | Status |
| --- | --- | --- |
| Tenant / site / gateway assignment | `organizations`, `sites`, `nas_clients`, `nas_access_points` | Working (TESTED) |
| Client VLAN policy | `policies.vlan_id` → `Tunnel-Type`/`Tunnel-Medium-Type`/`Tunnel-Private-Group-Id` (`translate.ts:606`) | Working (CODE) |
| SSID applicability | SSID appears in the rate-limit export and OpenWiFi config, not as a policy selector | Partial |
| Internet-only vs internal resources, isolation, filtering | not modelled | Missing — gateway-dependent |
| Uplink/native VLAN kept separate from client VLAN | `openwifi-config` adapter handles device config separately | Working (CODE) |
| Validate assignment against gateway capability | `capabilities.ts` + `EnforceabilityMatrix` | Working (TESTED) |
| Pre-authentication (walled garden) access | documented per provider in `PORTAL_LOGIN_METHODS_DESIGN.md §2.2`; not modelled as data | Partial |

### 2.10 Monitoring, reporting, administration (requirement §13)

| Control | Existing evidence | Status |
| --- | --- | --- |
| Online users, sessions, device count, gateway health | `GET /dashboard`, `sessions`, `access-points` | Working (TESTED) |
| Live or sampled rates with freshness | `usage_hourly` + `FRESHNESS_EXPLAINER` in the admin components; sources labelled (`dashboard.ts:490` names the source row) | Working (TESTED) |
| Consumption and remaining allowance | `GET /usage`, `/usage/top`, `/usage/export` | Working (TESTED) |
| Authentication failures, quota events, expiry alerts | `auth_events`, `portal_login_attempts`, quota breach events via outbox/webhooks | Working (TESTED) |
| Session history and reports with filters | `GET /reports`, `/reports/:key`, `/reports/:key/export` | Working (TESTED) |
| Effective policy, enforcement outcome, failed sync | `session_enforcement` + `GET /session-enforcement` | Working (TESTED) |
| RBAC, tenant isolation, audit logs | permissions/roles/role_bindings, FORCE RLS, partitioned `audit_logs` | Working (TESTED) |
| Backup / restore documented | `docs/RESTORE_DRILL.md`, `docs/FAILURE_DRILLS.md` | Working (documented) |
| Do not fabricate metrics | sources and freshness are labelled throughout | Working |

### 2.11 Commercial integrations (requirement §14)

No payment provider, no invoices, no subscriptions, no PMS. `grep` finds no Stripe, invoice or
room-charge code anywhere in `packages/` or `apps/`. **Missing in full**; correctly scoped as
optional modules.

---

## 3. Enforcement architecture, as actually built (requirement §15)

Path traced in code:

```
admin (apps/admin)
  → API route (apps/api/src/routes/policies.ts)        validation: intent.ts, 11 rules
  → policies / policy_assignments rows
  → NAS sends Access-Request to FreeRADIUS
  → FreeRADIUS rest module → POST /internal/aaa/authorize
  → policy-data.ts loads candidates + usage + active sessions
  → resolve.ts  (rank → merge → schedule → quota → concurrency → validity)
  → translate.ts  (per-adapter capability-gated attribute set)
  → Access-Accept with the attributes the adapter can actually enforce
  → NAS enforces; sends Accounting Start / Interim / Stop
  → radius.radacct_raw → worker drain.ts → sessions + usage_counters + accounting_anomalies
  → worker quota.ts re-evaluates → CoA/Disconnect (evidence-gated) or session_enforcement row
```

| Control | Evaluation point | Enforcement point | Usage source | Active-session update | Limitations |
| --- | --- | --- | --- | --- | --- |
| Download / upload rate | `resolve.ts` + `translate.ts` | NAS (WISPr attributes) | n/a | `next_reauth` by default; CoA only with lab evidence | per session, never per account |
| Burst | same | NAS | n/a | same | MikroTik only; REQUIRES_DEVICE_TEST elsewhere |
| Session timeout | `resolve.ts` | NAS `Session-Timeout` | n/a | capped at `AAA_SESSION_TIMEOUT_CAP_S` (Q44, default 1800 s) | NAS must honour it; LIVE-verified on uspot |
| Idle timeout | `resolve.ts` | NAS `Idle-Timeout` | n/a | next reauth | LIVE-verified |
| Data quota | `resolve.ts:evaluateQuota` (authorize) and `jobs/quota.ts` (continuous) | EZECLOUD denies at next auth; Disconnect when evidence allows | `usage_counters` from accounting | `session_enforcement` row when Disconnect is unavailable | overshoot bounded by the interim interval (NAS-authoritative, 600 s observed) |
| Concurrent sessions | `resolve.ts` | EZECLOUD reject, or Disconnect of the oldest | `sessions` | immediate on reject | `disconnect_oldest` needs Disconnect evidence |
| Max devices | `resolve.ts` | EZECLOUD reject | `client_devices` | n/a | — |
| Schedule | `schedule.ts` | EZECLOUD reject + Session-Timeout clipped to the window edge | n/a | next reauth | grace window configurable |
| VLAN | `translate.ts` | NAS tunnel attributes | n/a | next reauth | UNVERIFIED on the current fleet |
| Group aggregate pool | — | — | — | — | **not implemented, and not enforceable by any integrated gateway** |
| Online-time quota | — | — | counters exist, unused | — | **not implemented** |

Outage behaviour: the authorize path denies on failure rather than falling open; the worker retries
with a bounded attempt cap; accounting is drained from a durable table, so a worker outage delays
but does not lose usage. There is no accidental unlimited-access fallback.

---

## 4. Staged implementation plan

Each stage is a reviewable commit, keeps the suite green, and changes nothing on production.

| Stage | Content | Risk |
| --- | --- | --- |
| **1** | This audit (no code). | none |
| **2** | **Quota model completion.** Weekly period; quota direction (combined / upload / download); online-time quota per period; counters and evaluation; validation rules; display. **DONE** — migration 036, commit on `feature/universal-aaa`. | low — additive columns, same evaluation shape as existing quotas |
| **3** | **Exhaustion actions.** `quota_exhaustion_action` (deny / reduce_speed / require_renewal) with inline reduced rates; authorize honours it; enforcement strategy reused unchanged. **DONE** — migration 037. | medium — touches the authorize decision |
| **4** | **Tri-state values.** Explicit `unlimited` distinct from `inherit`, so a more specific layer can lift a higher-layer per-session cap; aggregate pools bind regardless (stage 6). **DONE** — migration 039. `disabled` is not a per-field state: it exists as `policies.status` and `users.status`, which are already distinct. | medium — touches `merge()` |
| **5** | **Bandwidth profiles + access plans.** Two additive tables, CRUD, policy→profile reference. **DONE (backend)** — migration 040. Admin pages and the §16 plan tabs are not built; the API is complete and the generic resource pages can drive it. | low |
| **6** | **Group and site aggregates.** **DONE** — migration 042. Shared data allowance and member/session ceilings are enforced EZECLOUD-side; the rate pool is observed and carries `enforcement: 'unsupported'` as data, not as a comment. Admin pages not built. | low (honesty-first) |
| **7** | **Access methods.** Finish email OTP (routes, portal pages, admin), then the `identity_providers` runtime and OIDC. | blocked on SMTP credentials for live delivery |
| **8** | **Operations gaps.** **PARTLY DONE** — migration 044. Reconnect cooldown and schedule intersection (§10) are built and tested. MAC precedence: `client_devices.blocked` is already enforced, but at **four separate call sites** (`internal/aaa.ts` ×2, `internal/portal-identity.ts`, `vendor-api/portal.ts`) with no shared predicate — the duplication is the risk, and three of those files are the portal session's lane. Per-site default: `access_plans` (040) already has per-site default indexes; `policies.is_default` remains org-wide. | low |
| **9** | **Optional commercial modules.** **PARTLY DONE** — migration 045 builds the provider-independent fulfilment spine: `orders`, `payment_events`, and §14's rule as a constraint (`paid` is unreachable without a verified event). **No payment provider is chosen and none is assumed** — no adapter, no route, no credential. Recurring subscriptions, refunds, invoices, tax and PMS posting are not modelled and need a provider or vendor decision first. | provider choice is REQUIRES_CLARIFICATION |

Stages 2–4 are the ones that make the per-user half of the infographic complete. Stage 6 is where
the platform must be honest rather than impressive.

---

## 5. What remains unverifiable without owner action

| Item | Blocked on |
| --- | --- |
| Email OTP live delivery | SMTP host, credentials and from-address |
| Social login, Enterprise SSO | provider accounts (Google Cloud, Meta, Apple Developer Program) |
| SMS OTP | SMS gateway account and a per-site spend ceiling |
| Payments, PMS | payment processor and PMS vendor decisions |
| VLAN assignment enforcement | a device test on hardware that supports it |
| Group shared pool enforcement | a gateway with parent-queue or controller bandwidth-group support |
| CoA-based live policy change | lab evidence on each adapter; currently `next_reauth` everywhere |
