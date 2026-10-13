# Portal splash reference

`uspot-splash-reference.html` is a **visual reference only**, contributed from the EZEControl
side for the uspot captive-portal splash. It is NOT a page the portal can serve, and nothing
imports it.

The portal renders server-side through `apps/portal/src/pages.ts` (`renderPage`) with per-tenant
theme tokens (`portal_themes`, `resolvePortalColors` / `resolvePortalStrings`), i18n strings and
RTL handling. Three parts of this file are incompatible with that pipeline and were deliberately
not carried over:

- the Google Fonts `<link>` — blocked by the portal CSP (`default-src 'none'`, no `font-src`),
  and unreachable through a captive walled garden in any case;
- the inline `<script>` — ordinary portal pages are served without a `script-src`; a nonce is
  issued only for the handoff auto-submit page, so page JavaScript does not run;
- the Show/Hide password toggle, which depends on that script.

What the structure is good for, and what it needs before it can be built:

| Element | Status |
|---|---|
| "Connected to …" band | buildable now from `portal.name` / `portal.siteName`; the SSID is not in `FlowView` |
| username + password fields | already rendered by the `login` page body |
| one error band | already present (`errorLine` + `notice`); one generic message by design |
| terms checkbox | exists today as its own `terms` page for click-through, not on the login form |
| plan strip (down / up / minutes) | NOT buildable today — see below |
| footer with NAS id and session id | NOT buildable today — neither is in `FlowView` |

The plan strip is the piece worth most to a guest and the one that cannot simply be styled in:
the policy is resolved at AAA time, after the credential is presented, so at splash time the
portal does not know what the visitor will get. Showing the site default instead would print
numbers that differ from the ones actually applied. Carrying it properly means adding the
resolved-or-default policy to the flow view in the API, which is a feature with its own tests,
not a template change.
