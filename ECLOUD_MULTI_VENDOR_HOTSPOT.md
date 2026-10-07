# ECLOUD Multi-Vendor Hotspot, Captive Portal and RADIUS Integration Specification

This document extends the approved ECLOUD architecture with a multi-vendor hotspot integration roadmap. It is subordinate to CLAUDE.md, DECISIONS.md, STATUS.md, PHASE2_VALIDATION.md, POLICY_ENGINE.md, MULTITENANCY.md, AAA_ARCHITECTURE.md, CAPTIVE_PORTAL_ARCHITECTURE.md, NETWORK_INTEGRATION.md and SECURITY_ARCHITECTURE.md. Where this document conflicts with an approved ECLOUD decision, the approved decision register wins. A vendor adapter is never considered supported until its required real-device validation passes.

## Prompt

You are working on ECLOUD, EzeLink's multi-tenant cloud bandwidth management and hotspot platform. Extend ECLOUD so third-party hardware can use its captive portal, AAA/RADIUS, accounting, policy engine and vendor-specific enforcement adapters. Preserve the approved EZEAP/TIP OpenWiFi + uSpot + CoovaChilli architecture as the first-party path. Cambium is the first new third-party integration. Social WiFi may be studied as a functional reference for hardware onboarding patterns, but ECLOUD must use its own architecture, implementation, security model and branding.

### 0. ECLOUD governance and non-negotiable decisions

- ECLOUD is multi-tenant: Platform → Organization → Site → Device/NAS → subscriber/client/session/policy. Tenant isolation applies to API, database, cache, workers, credentials, accounting and audit data.
- Canonical permissions use `resource:action`. Authorization must not depend on hard-coded role names.
- Canonical policy specificity is `temporary > client_device > user > voucher_batch > user_group > site > organization default`, with approved field-level fall-through.
- The cloud VPS is a control/AAA plane, not the subscriber packet-path shaper. Enforcement occurs only through a verified AP/controller/gateway mechanism.
- Policy intent is vendor-neutral. Every adapter must declare each capability as `VERIFIED_SUPPORTED`, `REQUIRES_DEVICE_TEST`, `UNSUPPORTED`, or `ECLOUD_SIDE_ONLY`.
- D-006 CoA/Disconnect remains `REQUIRES_DEVICE_TEST`; architecture approval is not device evidence.
- Pilot RADIUS transport is WireGuard tunnel-only by default. Do not expose UDP 1812/1813/3799 broadly to the public Internet. RadSec is a fallback only where endpoint support is verified.
- Admin app: `ecloud.ezelink.ai`; integration API: `api.ecloud.ezelink.ai`; captive portal: `portal.ecloud.ezelink.ai`. DNS changes remain deployment-gated.
- Server deployment root is `/opt/ecloud`; native Caddy remains the shared edge and existing `q-mira.com` must be preserved.
- Secrets must never be committed. Use secret references/environment injection and per-NAS credentials.
- The current VPS is development/pilot only. No VPS hardening, package installation, DNS change, Caddy change, WireGuard configuration, RADIUS exposure or application deployment is authorized solely by this document.

### 1. Discover before implementation

Read CLAUDE.md, AGENTS.md, DECISIONS.md, STATUS.md, QUESTIONS.md, PHASE2_VALIDATION.md, POLICY_ENGINE.md, MULTITENANCY.md, AAA_ARCHITECTURE.md, CAPTIVE_PORTAL_ARCHITECTURE.md, NETWORK_INTEGRATION.md, SECURITY_ARCHITECTURE.md, DATABASE_DESIGN.md, API_ARCHITECTURE.md, DEPLOYMENT_ARCHITECTURE.md, and the existing repository/deployment configuration before changing code. Inspect existing identity, tenancy, RBAC, sites, devices, SSIDs, portal, policy, RADIUS, CoovaChilli/uspot and TIP/uCentral components. Reuse ECLOUD tenant identity, RBAC, policy resolution, session/accounting and portal services rather than creating a competing identity or policy system. Identify whether hotspot services belong inside EZECONTROL or an existing companion service with authenticated APIs.

Produce a concise discovery report, architecture proposal, compatibility matrix and phased implementation plan. Distinguish observed facts, proposed defaults and unresolved items. Continue with reversible foundation work using reasonable documented defaults. Ask only for information that truly blocks dependent work. Do not modify a remote server or deploy unless the session has authorized that target and deployment.

### 2. Scope and hardware roadmap

Preserve and complete the approved EZEAP/TIP OpenWiFi + uSpot + CoovaChilli path. Add Cambium as the first third-party adapter. Do not refactor the first-party path merely to make Cambium fit; both must implement the same vendor-neutral ECLOUD capability/adapter contracts.

Design the same adapter contract for the following roadmap candidates: MikroTik, Ubiquiti UniFi, TP-Link Omada, Aruba, Cisco including a separate Meraki variant, Ruckus, Grandstream, EnGenius, Fortinet, Huawei, Ruijie, Zyxel, Juniper Mist, Extreme Networks, Alcatel, DCN, DrayTek, OpenMesh, Tanaza and Teltonika. Aerohive and IgniteNet may be investigated as legacy candidates; do not assume current support.

Prioritize the existing EZEAP/TIP OpenWiFi + uSpot/CoovaChilli path for the pilot, then Cambium as the first third-party integration, then MikroTik, UniFi and Omada, followed by enterprise vendors based on available lab hardware and customer demand. Implement later vendors only when their actual protocol and required APIs have been researched; an adapter placeholder must not be presented as working support.

Support two deployment modes:
- Native hotspot: the AP/controller redirects guests and enforces authorization.
- Gateway hotspot: third-party APs bridge a guest VLAN to an EzeLink gateway, CoovaChilli or supported MikroTik hotspot that enforces access and policy. This provides guest Wi-Fi through the gateway; it does not imply native AP management.

Full radio management, firmware control and roaming optimization remain separate capabilities. Do not send uCentral configuration to Cambium or another vendor unless that exact device explicitly supports it.

### 3. Compatibility and adapter design

For each model/firmware/controller combination, record official documentation links, controller version, licensing, redirect protocol, authorization method, RADIUS authentication/accounting, accounting interval, disconnect/CoA, bandwidth attributes, quota enforcement, session timeout, IPv6 behavior, roaming/session continuity and cloud dependencies.

Track lifecycle states: planned, researched, implemented, lab-validated and production-validated. Missing information means unknown, not supported. Separately track captive portal, accounting, bandwidth, disconnect, monitoring and configuration capabilities.

Define a vendor-neutral adapter interface with operations equivalent to:
- discoverCapabilities(context)
- parseRedirect(request)
- validateContext(context)
- buildAuthorization(context, identity, policy)
- authorizeSession(context, credentialsOrToken)
- revokeSession(session)
- normalizeAccounting(packet)
- buildSetupGuide(site)
- healthCheck(site)

Allow browser-mediated form authorization and backend API authorization as distinct strategies. Do not force every vendor through the same REST or RADIUS login flow. Portal OAuth login authenticates a person; the adapter still has to authorize that person's network session.

Normalize tenant, site, vendor, controller, NAS identity, AP MAC, client MAC, SSID, client IP, opaque vendor context, session ID and policy reference. Keep original vendor parameters needed for the login handshake without exposing secrets in the browser. Preserve required opaque tokens byte-for-byte.

### 4. Cambium first integration

Research the installed Cambium model and firmware and current official documentation. Support cnPilot/enterprise External Hotspot with external RADIUS where validated. Setup must explain guest SSID/VLAN, External Hotspot mode, RADIUS access policy, external portal URL, AAA servers, shared secrets, accounting, timeouts, walled garden and compatible AP-side login settings.

Handle actual redirect parameters such as ga_ap_mac, ga_cmac, ga_ssid, ga_nas_id, ga_srvr and ga_Qv when present. Verify meaning and requirements on the target version. Treat all supplied fields as untrusted until validated against registered equipment and server-side context.

Implement the documented AP-side login handshake for the target firmware. Older documentation describes browser POST to an AP hotspot_login.cgi endpoint; verify the protocol, port, required fields and HTTPS behavior rather than hardcoding that example for all devices. The cloud backend cannot assume it can reach a private AP address. Test browser mixed-content/private-network restrictions and captive-browser behavior explicitly.

Make cnMaestro-mediated authentication a separate optional strategy. Verify EasyPass third-party login/logout endpoints, request schemas, authentication, licenses and on-premises availability for the chosen version. Never invent endpoint paths or payloads. Store controller base URLs and keys per tenant/site. Avoid a mandatory Cambium Cloud dependency; review current Cambium continuity guidance and support self-hosted cnMaestro where the selected integration is verified.

Use short-lived credentials for RADIUS-based portal authorization. Mark internet access authorized only after a real adapter result, distinguishing authorization pending, accepted and confirmed where telemetry permits. Never treat successful social login as proof of network access.

### 5. Shared portal and identity

Provide a mobile-first branded portal per organization/site, including logo, colors, welcome text, terms, language and configurable landing page. Support English and Arabic with RTL layout. Keep portal asset dependencies small and compatible with iOS/Android captive browsers.

Implement click-through with terms, voucher login and local guest credentials first. Provide provider interfaces for email verification, SMS OTP and OAuth/social login. Implement individual providers only with verified current APIs and configured credentials. Include an external-browser continuation path where captive browsers cannot complete OAuth. Do not assume every social network offers a suitable login API.

Support voucher expiry, usage limits, device limits, repeat visitors, logout and session status. Randomized client MACs are session/device observations, not permanent person identities. Separate optional marketing consent from network terms; record timestamp, version, purpose and withdrawal. Add configurable retention, export and deletion with tenant isolation. Campaigns and CRM integrations are optional later modules, not blockers for the core hotspot.

### 6. RADIUS, policies and enforcement

Reuse existing RADIUS if suitable; otherwise use FreeRADIUS with a secure application integration. Implement Access-Request/Accept/Reject and accounting Start/Interim/Stop. Validate packet authenticity where applicable, register authorized NAS clients, reject unknown equipment and use strong per-site/NAS secrets where topology allows.

Design for many sites behind NAT: source IP alone is insufficient for tenant resolution. Use validated NAS identity plus authenticated transport/client configuration, and document shared-IP limitations. Prefer private site-to-server connectivity such as WireGuard when appropriate; support RadSec only on verified endpoints. Do not expose RADIUS broadly without source restrictions and documented transport protections.

Translate a canonical policy into verified vendor attributes or API actions. Policies include upload/download rate, session and idle timeout, expiry, schedule, data allowance and concurrent-device limit. Detect unsupported policy features and offer a gateway path or clear rejection. Never silently accept an unenforceable quota or bandwidth setting.

Use one deterministic policy resolver; preserve existing precedence if defined. Use the already-approved ECLOUD precedence: temporary > client_device > user > voucher_batch > user_group > site > organization default, with field-level fall-through as defined by POLICY_ENGINE.md. Do not change this precedence without a new owner-approved architecture decision.

Identify exactly where enforcement occurs: AP, controller or gateway. A portal/RADIUS server outside the packet path cannot itself shape client traffic. Test upload/download attribute direction and units per vendor. Separate supported login-time limits from live policy changes. Enable CoA/disconnect only after verification of hardware, firmware, addressing and acknowledgement; otherwise apply changes at the next login and show that limitation.

Normalize and deduplicate accounting records. Handle retransmissions, out-of-order events, missing Stop, device restart, stale sessions, multiple NAS sources, counter rollover and gigaword counters where supplied. Avoid double counting roaming sessions. Expose measured usage freshness; accounting-based quota detection has interval-related delay unless the enforcement point provides tighter control.

### 7. Security and operations

Enforce tenant isolation at API, database, worker, cache and credential levels. Use the approved ECLOUD permission catalogue with canonical resource:action naming and scoped role bindings. Do not authorize by hard-coded role names. Encrypt controller/RADIUS secrets at rest, redact logs and support rotation.

Use signed short-lived portal state, replay protection, rate limits, OTP/voucher abuse controls, safe input parsing and allowlisted callback/redirect destinations. Never use user-supplied ga_srvr or a controller URL as an arbitrary backend fetch target. Validate registered authorization destinations and prevent SSRF/open redirects. Do not expose long-lived API keys in client HTML.

Support HTTPS, minimum required pre-login domains, health checks, metrics, audit events, backups and restore. Document failure behavior for portal, RADIUS, controller and site-link outages. Use bounded retries and idempotent authorization; avoid accidental duplicate sessions. Decide fail-open/fail-closed per site explicitly with a conservative default, rather than silently enabling internet on authentication failure.

### 8. EZECONTROL dashboard

Add Hardware Integrations, Sites/APs/NAS, Portals, Authentication Providers, Vouchers, Policies, Active Sessions, Accounting, Analytics, Diagnostics and Audit views. Display compatible model/version and validation status. Distinguish registered APs from APs whose actual online status is known.

Provide a vendor-specific setup wizard with controller prerequisites, portal URL, AAA endpoints, secret setup, accounting, guest VLAN, walled garden, testing and rollback. Do not copy Social WiFi's IPs, secrets or old domain lists into our configuration. Show secrets only through controlled reveal/rotation workflows.

Diagnostics should distinguish portal reachability, redirect parsing, OTP/OAuth success, RADIUS rejection, adapter authorization failure, DHCP/DNS issues and missing accounting. Downloadable support bundles must redact personal information and secrets. Add monitoring/configuration only through separately verified vendor connectors.

### 9. Implementation phases and verification

ECLOUD Phase 3 foundation: implement the shared adapter/capability registry, simulator contracts and multi-vendor data structures without claiming hardware compatibility.
ECLOUD device validation: execute the existing PHASE2_VALIDATION.md EZEAP/uSpot/CoovaChilli tests and promote capabilities only from evidence.
Third-party Phase A: research and implement Cambium adapter + onboarding wizard, followed by real-device validation.
Third-party Phase B: MikroTik, UniFi and Omada, each gated by protocol research and real-device validation.
Third-party Phase C: additional enterprise adapters, optional marketing/CRM functions and production hardening.

Implement and test each available phase; report hardware-dependent work as pending instead of stopping all development. Mocks/simulators prove code behavior, not hardware compatibility.

Test unauthorized access blocked, correct tenant selection, successful and rejected authentication, voucher expiry, accounting totals, bandwidth where supported, timeout/logout, reboot recovery, duplicate packets, NAT, bridge/routing topology, guest isolation, iOS/Android browsers, required OAuth flow and supported roaming. Test tenant-crossing attempts, forged redirects, replay and secret leakage. Test IPv6 access enforcement or document/implement an explicit guest-VLAN IPv6 restriction until supported; avoid an IPv6 bypass.

### 10. Deliverables and completion report

Deliver working code, additive migrations, configuration examples with placeholders, local development setup, automated tests, adapter contract, architecture diagram, compatibility matrix, Cambium installation guide, gateway guide, operator runbook, lab test checklist and rollout/rollback plan. Match the repository's stack and conventions. If no stack exists, propose a minimal maintainable stack before implementing.

Finish with implemented behavior, tests run/results, device evidence, remaining integration gaps and exact commands to run locally. Do not claim all listed brands work. Do not deploy merely because code is complete. The pilot VPS deployment remains behind the explicit VPS deployment gate in the owner-approved Phase 3 authorization. Preserve q-mira.com and existing VPS workloads. Preserve existing EZECONTROL wireless profiles and current working portal services throughout.

Start by reconciling this specification against the approved ECLOUD governance artifacts. Produce a MULTI_VENDOR_INTEGRATION_PLAN.md and update the compatibility registry. Then proceed only with Phase 3 foundation work already authorized. Third-party device-facing implementation and validation must preserve all existing device-test evidence states and approval gates.

## Research references (checked 7 October 2026)

- Social WiFi live hardware integrations: https://socialwifi.com/hardware-integrations/
- Social WiFi Cambium cnMaestro setup: https://academy.socialwifi.com/en/hardware-and-installation/installation-guides/cambium-networks/cnmaestro/
- Social WiFi gateway approach/recommended devices: https://academy.socialwifi.com/en/hardware-and-installation/hardware-faqs/recommended-devices/
- Cambium external hotspot/RADIUS handshake: https://community.cambiumnetworks.com/t/guest-access-wlan-external-hotspot-with-radius-authentication/82858
- Cambium EasyPass third-party integration release notes: https://community.cambiumnetworks.com/t/cnmaestro-5-2-2-cloud-release-notes/106564
- Cambium enterprise continuity guidance: https://community.cambiumnetworks.com/t/guidance-for-cnmaestro-enterprise-customers-updated-24-sep-2026/108849

The live Social WiFi index listed Cambium plus 20 other integrations at retrieval. Search-index snapshots also mentioned Aerohive and IgniteNet; these are not included in the confirmed live list. All are roadmap references for EZECONTROL, not verified EZECONTROL compatibility.
