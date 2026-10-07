# tests/e2e — end-to-end layer (Phase 6 placeholder)

Status: **structure only**. The Playwright suites described in `PHASE2_VALIDATION.md` §6.6 and
`TEST_PLAN.md` land in Phase 6 together with `apps/portal` and the admin SPA. Today this folder
holds one smoke test:

| File | What it checks | Runs when |
|---|---|---|
| `api-healthz.test.ts` | `node apps/api/dist/main.js` starts and `GET /healthz` answers `200 {"status":"ok"}` | `apps/api/dist/main.js` exists (`npm run build`) **and** the integration env is reachable (`ECLOUD_TEST_DATABASE_URL`); otherwise skipped with the reason |

## Planned layout (Phase 6)

```
tests/e2e/
  playwright.config.ts        # projects: desktop-chromium, iphone-13 (webkit), pixel-7 (chromium)
  fixtures/                   # fake-nas (uspot-T style /logon, /logoff + radclient), mock OIDC
  portal/*.spec.ts            # password / voucher / click-through / social login, res=success|reject|logoff,
                              # ?lang= + RTL, page weight < 50 KB, axe-core WCAG 2.2 AA, CSP report
  admin/*.spec.ts             # login + TOTP, scope switcher, policy editor enforceability preview,
                              # Disconnect disabled when coa != VERIFIED_*, impersonation banner
```

Rules carried over from the Phase 2 plan:

- Device-derived fixtures (UAM query strings, Access-Request attribute sets) come from the
  recorded device tests (DT-03/DT-11/DT-15) under `test/fixtures/device/<model>/<firmware>/`;
  they are never hand-written. Until those exist, e2e flows run only against `fake-nas` and
  prove **nothing** about a real device (real CNA behaviour = DT-11).
- e2e never marks a device test (DT-01…DT-24) as passed; see `docs/TESTING.md`.
