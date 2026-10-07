# Implementation Plan

## Phase 0 — Project Baseline
- Inventory repository and current deployment.
- Establish source control and safe rollback.
- Create status/decision tracking.

**Exit:** baseline is reproducible and existing functionality is understood.

## Phase 1 — Discovery
Parallel agents inspect infrastructure, network topology/device capabilities, application/code, database, and security.

**Exit:** architecture-relevant facts are VERIFIED or explicitly unresolved.

## Phase 2 — Architecture & Decision Gate
Produce target architecture, enforcement model, ERD, service boundaries, API plan, AAA design, portal flow, deployment model, security model, and unresolved questions.

**Exit:** owner approves material architecture decisions.

## Phase 3 — Platform Foundation
Implement database/migrations, backend skeleton, configuration/secrets pattern, HTTPS/reverse proxy as applicable, health checks, admin authentication, and RBAC foundation.

## Phase 4 — Core Administration
Implement organizations/sites as required, devices/NAS, users/groups, policies, assignments, audit log, and admin UI.

## Phase 5 — AAA / RADIUS
Configure verified RADIUS clients and authentication/authorization/accounting path. Add only supported dictionaries/attributes.

**Exit:** test account authenticates and accounting records are validated.

## Phase 6 — Captive Portal
Implement the verified redirect/login/authorization flow, branding, errors, expiry, and logout behavior.

**Exit:** real client completes end-to-end login.

## Phase 7 — Bandwidth Policy Enforcement
Translate cloud policy to the verified enforcement mechanism. Test upload/download behavior and policy changes.

**Exit:** measured network behavior matches assigned policy within accepted tolerance.

## Phase 8 — Sessions & Accounting
Expose active sessions, usage, historical records, and supported disconnect/change operations.

## Phase 9 — Dashboard & Reports
Add operational status, usage, authentication outcomes, site/device health where observable, and reporting.

## Phase 10 — Hardening
Security review, dependency review, firewall, secrets, backup/restore, logging, monitoring, failure recovery, performance/load testing.

## Phase 11 — Production Acceptance
Execute full test matrix and rollback drill. Produce installation and operations documentation.
