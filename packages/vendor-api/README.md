# @ecloud/vendor-api

Outbound calls to vendor hotspot controllers (multi-vendor Cycle D, D-044), behind one
SSRF-safe HTTPS client (`http.ts`):

- per-request DNS resolution with every answer re-checked against the controller-kind address
  policy (plan OQ-17), connection pinned to the checked address;
- TLS always verified: system roots, a pinned CA PEM, or a pinned SHA-256 leaf fingerprint
  (checked before any byte is written). No insecure mode;
- no redirects followed, one deadline per request, response size cap, per-controller token
  bucket, fixed error messages (no secrets in logs).

Clients: UniFi Network API (`unifi.ts`), Omada hotspot operator API 6.2.10+ (`omada.ts`), Mist
signed grant URL (`mist.ts`, no outbound call), Ruckus NBI (`ruckus.ts`, documented stub,
REQUIRES_CLARIFICATION). Redirect parsers for the three external-portal flows are in
`redirects.ts`. Sealed credentials are opened in-process only (`sealed.ts`, `credentials.ts`).

Nothing in this package is device-tested: every vendor behaviour is DOCUMENTED /
REQUIRES_DEVICE_TEST (docs/VENDOR_INTEGRATION_RESEARCH.md, MULTI_VENDOR_INTEGRATION_PLAN.md §16).
