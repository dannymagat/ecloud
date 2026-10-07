# Product Goal and Requirements

## Goal
Create a production-grade cloud bandwidth management platform with:

- Administrator management and RBAC
- Organization/site management
- Network device/NAS management
- Subscriber/user management
- Central policy management
- AAA/RADIUS
- Captive portal
- Session management
- Accounting and usage records
- Database
- HTTP/HTTPS server and API
- Reporting/dashboard
- Audit logging
- Backup/recovery and observability

## Policy Management
Administrators must be able to define and assign policies. Candidate controls, only where supported, include download/upload rates, quotas, validity, session timeout, idle timeout, concurrent sessions, schedules, VLAN assignment, and group/site policy.

The cloud platform owns policy intent. The enforcement point MUST be verified before implementation. It may be a gateway/router, AP, or another supported network component.

## Captive Portal
Support configurable login/error/success/expired/logout experiences and site-specific branding. Authentication mechanisms must be selected only after verifying the target access architecture.

## AAA
Implement standards-based AAA using verified authentication methods and verified RADIUS attributes. Vendor-specific attributes MUST NOT be guessed.

Accounting should capture available Start, Interim-Update, and Stop events plus supported session/user/device/traffic attributes.

## Multi-Site / Multi-Tenant
The architecture must support multiple sites. True tenant isolation is required only if the owner confirms a multi-customer SaaS requirement.

## Constraints
- No invented IP addresses, credentials, APIs, schemas, ports, device capabilities, RADIUS VSAs, or topology.
- Prefer reuse of safe existing infrastructure.
- Avoid unnecessary infrastructure complexity.
- Production secrets never belong in source control.
- Major architecture changes require an explicit decision record.
