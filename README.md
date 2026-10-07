# Cloud Bandwidth Management Platform — Agentic Project

## Mission
Design, build, validate, and deploy a centralized cloud platform for bandwidth management, captive portal access, AAA/RADIUS, policy administration, accounting, session management, database services, and HTTP/HTTPS APIs.

The system MUST be based on verified capabilities of the target infrastructure. Unknown facts must never be invented.

## Primary Goal
Provide centralized administration for organizations/sites, users, network devices, authentication, authorization, accounting, captive portals, bandwidth policies, active sessions, usage, reporting, security, and audit history.

## Non-Negotiable Rule
If a required fact cannot be verified from source code, configuration, documentation, a running service, or a real device, mark it `REQUIRES_CLARIFICATION` and ask the owner before implementing a dependency on it.

## Agentic Operating Model
The project is controlled by an Orchestrator Agent. Specialist agents investigate and implement bounded workstreams. No specialist may silently redefine architecture.

See:
- [GOAL.md](GOAL.md)
- [ORCHESTRATOR.md](ORCHESTRATOR.md)
- [AGENTS.md](AGENTS.md)
- [ARCHITECTURE.md](ARCHITECTURE.md)
- [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md)
- [DECISIONS.md](DECISIONS.md)
- [SECURITY.md](SECURITY.md)
- [TEST_PLAN.md](TEST_PLAN.md)
- [STATUS.md](STATUS.md)

## Definition of Done
The project is complete only when a real client can connect through a supported network device, authenticate through the intended access flow, receive the correct authorized policy, access the network, generate validated accounting records, appear in administrator session/usage views, and be managed securely without relying on fabricated or unverified integrations.

## Repository layout & developer quick start

Phase 3 turns this repository into an npm-workspaces TypeScript monorepo (Node 22, ESM, Vitest,
Express 5, PostgreSQL 16, Redis 7). Governance documents stay at the root; code lives in:

```
apps/        api · worker · portal
packages/    shared · db · policy-engine · adapters · testing
infra/       compose (DEV ONLY stack) · freeradius (M6)
docs/        DEVELOPMENT.md and other developer guides
```

```bash
nvm use && npm install
npm run build && npm run lint && npm test   # must be green before handing work back
npm run dev:stack                           # optional: local PostgreSQL 16 + Redis 7
```

Full instructions, conventions and the no-secrets rule: [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).
