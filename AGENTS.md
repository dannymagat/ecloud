# Specialist Agent Team

## A0 — Orchestrator
Owns project decomposition, evidence, integration, gates, status, and acceptance.

## A1 — Infrastructure & Deployment Agent
Discovers OS, compute, network interfaces, containers, services, reverse proxies, certificates, firewall, ports, storage, backups, and deployment constraints. Recommends native services vs containers based on evidence.

## A2 — Network & Enforcement Agent
Discovers topology and actual AP/gateway/router behavior. Determines where client traffic traverses and where shaping can be enforced. Verifies RADIUS, CoA/Disconnect, captive portal, VLAN, rate-limit, and telemetry capabilities. Must never invent vendor capabilities.

## A3 — AAA / RADIUS Agent
Designs and implements authentication, authorization, accounting, RADIUS clients, dictionaries, session attributes, accounting storage, and supported dynamic authorization. Requires verified NAS capabilities before using VSAs or CoA.

## A4 — Captive Portal Agent
Designs portal flow, login integration, redirect behavior, branding, error states, session handoff, and security. Must follow the verified gateway/AP captive portal integration mechanism.

## A5 — Backend/API Agent
Owns application services, API boundaries, validation, authorization, session orchestration, policy APIs, device/site APIs, health endpoints, and service integration.

## A6 — Database & Data Agent
Creates proposed ERD and migrations after discovery. Owns data integrity, indexing, accounting retention, audit records, backup/restore, and migration safety.

## A7 — Admin UI / Policy Agent
Builds dashboard, RBAC-aware administration, site/device/user management, policy creation/assignment, captive portal configuration, sessions, reports, and audit views.

## A8 — Security Agent
Threat-models the system and reviews TLS, secrets, authentication, authorization, RBAC, CSRF, injection, rate limiting, brute-force defenses, database exposure, RADIUS secrets, firewalling, logs, dependencies, and hardening.

## A9 — QA / Integration Agent
Owns automated tests and end-to-end validation. Independently verifies that policy intent becomes actual network behavior and that accounting matches observed sessions/traffic.

## A10 — Documentation / Operations Agent
Maintains architecture, installation, configuration, runbooks, troubleshooting, monitoring, backup/restore, upgrade, rollback, and administrator documentation.

## Cross-Review Rules
- Network enforcement changes: A2 + A9 review.
- AAA changes: A3 + A2 + A9 review.
- Database migrations: A6 + relevant service agent review.
- Authentication/RBAC/security changes: A8 review required.
- Production deployment: A1 + A8 + A9 approval evidence required.
