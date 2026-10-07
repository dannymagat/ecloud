# Security Requirements

## Baseline
- TLS for web/API traffic in production.
- Strong password hashing using an appropriate maintained password-hashing algorithm.
- RBAC and least privilege.
- Secure administrator sessions/tokens.
- CSRF protection where applicable.
- Strict input/schema validation.
- Parameterized database access/ORM safety.
- Brute-force and abuse controls.
- Secrets outside source control.
- Protect RADIUS shared secrets.
- Restrict database exposure.
- Minimal public ports.
- Audit privileged actions.
- Dependency and patch management.
- Backup encryption/access controls as appropriate.
- Log rotation and retention.

## Threat Model Must Cover
- Admin account takeover
- Subscriber credential attacks
- Portal spoofing/phishing exposure
- RADIUS client impersonation
- Stolen/shared RADIUS secrets
- API abuse
- Injection
- Privilege escalation
- Cross-tenant/site data exposure
- Session hijacking
- Replay where relevant
- Unauthorized policy modification
- Accounting tampering
- Denial of service
- Exposed databases/internal services

## Production Gate
Security Agent must review all externally reachable services and authentication/authorization paths before production acceptance.
