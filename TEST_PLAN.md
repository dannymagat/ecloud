# Test & Acceptance Plan

## Unit / Component
Test policy rules, validation, RBAC, API authorization, database constraints, accounting parsing, portal states, and failure handling.

## Integration
Validate:
1. Admin creates user/policy.
2. Policy is assigned.
3. Client reaches captive portal using the real access device.
4. Credentials reach AAA correctly.
5. Authorization returns only supported attributes.
6. Network device grants access.
7. Bandwidth enforcement matches policy.
8. Accounting Start is stored if supported.
9. Interim updates reflect usage if supported.
10. Stop/termination is recorded if supported.
11. Session appears/disappears correctly.
12. Supported disconnect/policy-change operation works, if implemented.

## Negative Tests
- Wrong password/voucher
- Expired account
- Disabled account
- Unauthorized admin role
- Invalid policy
- Unknown RADIUS client
- Database unavailable
- AAA unavailable
- API unavailable
- Duplicate/replayed request where relevant
- Network device temporarily disconnected

## Security Tests
Authentication, authorization, IDOR/access control, injection, CSRF where applicable, rate limiting, secret leakage, TLS configuration, exposed ports, audit trail, and privilege boundaries.

## Recovery Tests
- Service restart
- Server restart
- Database backup and restore
- Application rollback
- Failed migration recovery

## Final Acceptance
Do not declare success from UI/API tests alone. A real supported client/device path must demonstrate authentication, authorization, actual bandwidth enforcement, and validated accounting/session behavior.
