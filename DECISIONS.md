# Architecture Decision Register

Use this file as the source of truth for material decisions.

| ID | Decision | Status | Evidence / Question |
|---|---|---|---|
| D-001 | Target server OS/environment | REQUIRES_CLARIFICATION | Inspect target server or owner confirms. |
| D-002 | Network devices/AP/gateway models and software | REQUIRES_CLARIFICATION | Required for integration design. |
| D-003 | Traffic enforcement point | REQUIRES_CLARIFICATION | Must establish actual client data path. |
| D-004 | AAA implementation / FreeRADIUS or alternative | OPEN | Evaluate existing environment and requirements first. |
| D-005 | Captive portal integration mechanism | REQUIRES_CLARIFICATION | Depends on gateway/AP capabilities. |
| D-006 | RADIUS CoA / Disconnect support | UNVERIFIED | Must test/document device support. |
| D-007 | Single organization vs multi-tenant SaaS | REQUIRES_CLARIFICATION | Changes isolation/schema/RBAC. |
| D-008 | Database engine | OPEN | Inspect existing stack and operational requirements. |
| D-009 | Native services vs containers | OPEN | Infrastructure agent to recommend after discovery. |
| D-010 | Public/private connectivity model for sites | REQUIRES_CLARIFICATION | Needed for AAA/API/security architecture. |

## Decision Template
### D-XXX — Title
- Status: PROPOSED / APPROVED / REJECTED / SUPERSEDED
- Context:
- Verified evidence:
- Options considered:
- Decision:
- Rationale:
- Security/operational impact:
- Rollback implications:
