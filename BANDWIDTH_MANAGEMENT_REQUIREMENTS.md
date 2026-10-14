# Bandwidth Management Server — Requirements and Implementation Instructions

Status: Proposed requirements; existing capabilities must be audited.

## 1. Purpose and instructions for Claude Code

Act as a senior network engineer and full-stack developer. Study this existing project before changing it, then implement the requirements below in compatible, reviewable stages.

This document describes desired behaviour, not a claim that these features currently exist. Complete the audit, present a concise implementation sequence, and proceed with reversible implementation work. Do not stop after providing a proposal.

Follow applicable repository instructions, including AGENTS.md and CLAUDE.md. Reuse the current stack, naming conventions, integrations and design system. Do not introduce unrelated rewrites or replace working infrastructure without a documented technical need.

The optional visual reference is `docs/bandwidth-management-infographic.png`. If present, inspect it. This document is the detailed implementation specification; a missing infographic must not block the work.

### Operating boundaries

- Preserve existing users, plans, credentials, sessions and working integrations.
- Do not reset databases, terminate live sessions, change production network configurations or deploy to production without explicit authorization.
- Prepare and validate a concrete implementation before asking for deployment approval.
- Continue independent work when a provider credential or gateway dependency blocks one feature.
- Do not expose secrets, account credentials or personal data in logs or reports.
- Distinguish implemented, configured and verified capabilities.
- Do not claim completion for a visible setting that lacks backend enforcement.

## 2. Audit the existing project first

Inspect and trace:

1. Frontend pages, navigation, forms and components.
2. APIs, authorization, validation, background jobs and services.
3. Database entities, relationships, migrations and existing data compatibility.
4. Users, groups, subscriptions, plans, bandwidth profiles and vouchers.
5. Authentication providers, captive portals, RADIUS/AAA and accounting.
6. Gateways, NAS devices, traffic shaping, session updates and disconnect mechanisms.
7. Quotas, validity, schedules, billing, dashboards and reports.
8. Tenant boundaries, administrator roles, audit trails, deployment and backup procedures.

Identify technologies and capabilities from actual code and configuration. Do not assume which gateway, RADIUS implementation or portal software is deployed.

Produce a gap analysis with this structure:

| Feature | Existing evidence / file or service | Status | Required change | Enforcement dependency |
| --- | --- | --- | --- | --- |
| Example feature | Actual evidence | Working / Partial / Missing / Unsupported / Unverified | Concrete next step | Gateway, provider or service |

A frontend control is not evidence of functioning enforcement. Separate code inspection, automated verification and live network verification.

## 3. Core concepts

| Concept | Purpose |
| --- | --- |
| Authentication method | Determines how a person or device obtains access |
| Bandwidth profile | Reusable download/upload speed and optional traffic priority settings |
| Access plan | Combines profile, quota, time, device, access and optional pricing rules |
| User group | Assigns member defaults and optional aggregate limits |
| User override | Explicit individual exception to inherited settings |
| Effective policy | Resolved rules actually applicable to an account or session |
| Enforcement domain | Gateway or coordinated gateway set within which aggregate limits can be enforced |

Do not combine authentication identity, a bandwidth profile and a billing product into one inflexible entity. Adapt existing models rather than duplicating them.

## 4. Access plans

Support these plan fields where applicable:

- Name, description and short code.
- Enabled/disabled and default-plan status within a defined tenant/site scope.
- Free/paid type, price, currency and display order.
- Bandwidth profile and eligible authentication methods.
- Data, time, device and concurrency rules.
- Validity duration and activation trigger: creation, purchase or first successful login.
- Location, SSID, gateway and client VLAN applicability.
- Quota-exhaustion action and reduced-speed profile.
- Optional renewal, subscription and PMS references.

Validate incompatible combinations. Plan edits must have explicit behaviour for existing subscriptions and active sessions; show whether changes apply immediately, on reauthorization or on renewal.

## 5. Authentication

| Method | Required behaviour |
| --- | --- |
| SMS OTP | Provider configuration, OTP expiry, retry limits and resend controls |
| Accept terms | Record accepted terms version and acceptance time |
| Username/password | Account authentication, secure password storage and lifecycle controls |
| MAC authentication | Registered device matching, expiry, revocation and blocklist checks |
| Social login | Supported OAuth/OIDC provider configuration and secure callback handling |
| Registration form | Configurable required fields, validation and consent |
| Voucher | Plan assignment, redemption limits, activation and expiry |
| Email OTP or magic link | Configured delivery provider, expiry and single-use verification |
| Enterprise SSO | Supported identity-provider integration and explicit group mapping |
| 802.1X/RADIUS | Supported EAP methods or certificates according to the deployed infrastructure |

Additional rules:

- A form or terms acceptance does not verify identity. Verification must be explicitly configured.
- MAC addresses can change or be spoofed; they are not strong user identity.
- Only show providers as operational when required configuration is present and verified.
- Clearly distinguish portal login methods from network-level authentication such as 802.1X.
- Protect OTPs, vouchers, callbacks and logins against replay and excessive attempts.
- Ensure device registration does not accidentally bypass suspension, expiry or quotas.

## 6. Per-user controls

- Maximum download and upload speeds.
- Limit scope: each device or the account aggregated across all devices.
- Upload, download or combined data allowance.
- Cumulative online-time allowance, separate from plan validity.
- Maximum continuous session duration.
- Idle timeout and reconnect cooldown.
- Maximum registered devices and maximum simultaneous sessions, as separate fields.
- Allowed access hours and days.
- Account/subscription expiry.
- Assigned network access and explicit individual overrides.
- Optional burst speed, priority and minimum reserved bandwidth where supported.

For account-wide limits, several devices must share one allowance rather than each receiving the full allocation.

## 7. Per-group controls

- Aggregate maximum download and upload bandwidth.
- Shared group data allowance.
- Maximum simultaneously active users and/or sessions with clearly labelled semantics.
- Default per-member bandwidth, quota, session and device settings.
- Group schedule, priority and access rules.
- Explicit enforcement scope: tenant, site or coordinated gateway set.
- Optional reserved capacity where supported and capacity-validated.

Example: a guest group has a 100 Mbps download pool and a 10 Mbps per-user maximum. One guest can receive up to 10 Mbps; all guests combined remain within 100 Mbps. The 100 Mbps pool is not a promise that every member receives 10 Mbps.

Do not label independent gateway caps as a single global shared pool.

## 8. Bandwidth profiles and fairness

- Maintain reusable speed presets and allow custom upload/download values.
- Label speeds from the client's perspective.
- Store bandwidth in bits per second; use explicitly defined decimal Kbps/Mbps display units.
- Keep maximum rate, priority, burst allowance and reserved minimum as separate concepts.
- Provide fair sharing within an aggregate pool when the enforcement mechanism supports it.
- Capacity-check reserved allocations against the parent link or pool.
- Disable or explain unsupported settings rather than silently ignoring them.

## 9. Quotas, time and validity

### Data accounting

- Store data counters in bytes and define decimal or binary display units explicitly.
- Support upload-only, download-only and combined quotas.
- Support daily, weekly, monthly and lifetime accounting periods.
- Distinguish a per-member quota from a shared group quota.
- Define calendar-based versus rolling reset periods explicitly.
- Configure reset timezone, time and weekly/monthly boundary where applicable.

### Time semantics

Keep these separate:

- Validity: elapsed wall-clock period during which access is eligible.
- Session duration: continuous time for one connection.
- Online-time quota: accumulated connected time.
- Idle timeout: inactivity period before the session ends.

For concurrent devices, explicitly define whether online time counts elapsed account time or the sum of device-session time. Display that choice.

### Exhaustion and reset

- Actions: reduce speed, deny/disconnect access or require renewal/upgrade.
- Define how active sessions are updated when a quota resets or is exhausted.
- Reconnects must not reset consumed allowances.
- Persist activation timestamps and counters across service/gateway restarts.
- Handle duplicate, delayed, out-of-order and missing accounting records.
- Document accounting intervals, enforcement delay and possible quota overshoot.
- Use atomic operations for first activation, voucher redemption and concurrent quota allocation.

## 10. Policy resolution

Resolve ordinary member settings in this order:

1. Applicable default plan.
2. Assigned plan and designated policy group's explicit member settings.
3. Explicit individual overrides.

Audit the current project and document any existing precedence before migrating it. Keep plan/group precedence deterministic and visible. Where an account belongs to several groups, use one explicit policy group or documented ordered precedence; do not accidentally merge conflicting policies.

Regardless of individual overrides:

- Applicable site and group aggregate limits remain enforced.
- Disabled accounts, blocks and expired access remain denial conditions.
- Restrictions from site, group and user schedules intersect by default.
- Multiple applicable aggregate pools must have explicit membership and enforcement semantics.

Use distinct states for inherited, unlimited and disabled behaviour. Do not overload the number zero. Unlimited at the user level does not remove parent caps.

Display the effective policy, source of each setting, aggregate constraints and enforcement status. Unsupported policy combinations must fail validation with an actionable explanation.

## 11. Users, devices and vouchers

### User management

- Search and filter users, subscribers, groups and sessions.
- View assigned plans, effective policies, usage, devices and session history.
- Suspend/reactivate accounts and manage expiry and individual overrides.
- Manage registered MAC addresses, allowlists and blocklists with clear precedence.
- Record administrative changes and reasons in the audit trail.

### Vouchers

- Quick single-voucher and bulk-voucher creation.
- Assigned plan, validity, activation trigger and device/concurrency allowance.
- Unique, sufficiently unpredictable codes and controlled export access.
- Redemption state, revocation, expiry and usage history.
- Idempotent redemption that does not activate the same entitlement twice.

## 12. Network assignment and access rules

- Tenant, site/location, SSID, gateway and client VLAN assignment.
- Internet-only access or explicitly permitted internal resources.
- Client isolation, firewall policy, domain/category filtering and application rules only where supported.
- Keep optional uplink/native VLAN configuration separate from per-client VLAN policy.
- Validate network assignments against gateway capabilities and available configuration.
- Define pre-authentication access needed for portal, OTP and identity-provider flows.

## 13. Monitoring, reporting and administration

- Online users, sessions, device count and gateway health.
- Live or sampled upload/download rates with freshness timestamps.
- User/group data consumption and remaining allowances.
- Authentication failures, quota events and expiry alerts.
- Session history and usage reports with relevant tenant/site/time filters.
- Effective policy, enforcement outcome and failed synchronization visibility.
- Role-based administrator access, tenant isolation and audit logs.
- Documented backup/restore and configuration recovery procedures.

Do not fabricate metrics. Distinguish historical counters from current rates and stale observations from live status.

## 14. Optional commercial integrations

Implement as optional modules when relevant to the current product:

- Paid plans, currency, renewals, subscriptions and invoices.
- Payment-provider integration with verified callbacks and idempotent fulfilment.
- Hotel PMS guest eligibility, room-charge posting and reconciliation.
- Provider configuration status and clear handling of failed external transactions.

Never mark a payment, PMS posting or access upgrade successful based solely on a frontend redirect.

## 15. Enforcement architecture

Trace and document the actual path:

Administrator configuration -> policy resolution -> authorization -> gateway enforcement -> accounting -> quota/session updates.

Use existing services and adapters. For each feature record:

| Control | Evaluation point | Enforcement point | Usage source | Active-session update | Limitations |
| --- | --- | --- | --- | --- | --- |
| Actual control | Service or component | Gateway or traffic shaper | Accounting or telemetry | Mechanism or unavailable | Verified constraints |

RADIUS acceptance or returned attributes alone do not prove bandwidth enforcement. Verify compatible gateway attributes, APIs or shaping rules. Identify whether session updates use reauthorization, supported CoA/Disconnect messages or another mechanism.

A true shared cap across gateways needs coordinated enforcement or a common enforcement point. Expose unsupported scope honestly.

Define behaviour for controller, accounting or provider outages. Document stale sessions, reconciliation, retry limits and whether existing/new access continues or is denied. Avoid an accidental unlimited-access fallback.

## 16. User interface

Adapt the existing navigation rather than duplicating working pages. Suggested modules:

Dashboard; Users; Groups; Access Plans; Bandwidth Profiles; Authentication; Vouchers; Network & Gateways; Reports; Billing; Settings.

Suggested plan tabs:

General; Authentication; Bandwidth; Quotas & Sessions; Devices; Schedule; Access Rules; Advanced.

Show units, scope, inheritance, effective values and capability limitations next to relevant fields. Keep technical provider details in administrator configuration rather than visitor login flows.

## 17. Implementation stages

1. **Audit and compatibility:** gap analysis, capability matrix, existing-data mapping and staged work plan.
2. **Policy foundation:** models, validation, deterministic resolution, versioned migrations and effective-policy display.
3. **Core management:** profiles, plans, groups, users and administrative permissions.
4. **Enforcement:** authorization, accounting, gateway adapters, shared limits and session updates.
5. **Access methods:** integrate and verify authentication methods, device registration and vouchers.
6. **Operations:** monitoring, alerts, reporting, audit history and optional commercial integrations.
7. **Release preparation:** regression checks, migration validation, rollback and deployment instructions.

Keep the project working between stages. Record completed and blocked work. Do not enable unverified production behaviour automatically.

## 18. Acceptance checks

Verify with meaningful automated tests and integration checks appropriate to the existing project:

- [ ] Existing users and subscriptions retain compatible behaviour after migration.
- [ ] Default, plan, group and individual settings resolve deterministically.
- [ ] Effective policy shows the source of settings and parent constraints.
- [ ] Individual speed limits and group aggregate caps both apply.
- [ ] Multi-gateway group caps match the advertised enforcement scope.
- [ ] Multiple devices share account-wide speed/data allowance when selected.
- [ ] Device registration and concurrent-session limits behave independently.
- [ ] Group quotas and individual quotas are both respected.
- [ ] Validity, online time, session duration and idle timeout remain distinct.
- [ ] First-use activation is atomic and survives reconnects/restarts.
- [ ] Reset boundaries follow the configured timezone and period.
- [ ] Exhaustion and reset update existing sessions as documented.
- [ ] Duplicate/delayed accounting does not double-count usage or reset quotas.
- [ ] Suspended, blocked and expired accounts cannot bypass restrictions.
- [ ] Authentication, OTP and voucher replay protections work.
- [ ] Unconfigured providers and unsupported gateway options are clearly identified.
- [ ] Tenant and administrator authorization boundaries are enforced.
- [ ] Metrics show real values, correct units and observation freshness.
- [ ] Optional payment/PMS callbacks are verified and idempotent when implemented.
- [ ] Migration and rollback procedures preserve data and are documented.

Separate results into automated tests, simulated integrations and actual live gateway checks. If live access or hardware is unavailable, state exactly what remains unverified.

## 19. Required completion report

Provide:

1. Audit findings and final feature-status matrix.
2. Implemented behaviour and changed files.
3. Migrations, compatibility decisions and defaults.
4. Test results and actual enforcement evidence.
5. Remaining unsupported, blocked or unverified features.
6. Required external configuration without revealing credentials.
7. Deployment steps, rollback procedure and production actions requiring authorization.

Begin by inspecting the repository, then produce the gap analysis and continue implementation within the operating boundaries above.

