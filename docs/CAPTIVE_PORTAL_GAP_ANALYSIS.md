# Captive Portal — Audit and Gap Analysis

Audited: 2026-10-14. Branch `feature/universal-aaa`. Scope: `CAPTIVE_PORTAL_ONLY_REQUIREMENTS.md`.

Method: read the portal service, the internal portal API, the portal-admin API, the admin designer,
the captive-portal migrations and the shared theme contract. Every "Working" row below names the
file that implements it. Nothing here is inferred from a visible page.

## 1. What the deployed portal actually is

A **server-rendered Express 5 service** (`apps/portal`, 1,107 lines in `src/index.ts`) with no
client-side JavaScript except one nonce'd auto-submit on vendor hand-off pages. It renders 11 page
bodies from a single template set (`apps/portal/src/pages.ts`), and it holds no database
connection: every decision is an HTTP call to the API's internal listener
(`apps/api/src/internal/portal.ts`, 1,333 lines) over `PortalApi` (`apps/portal/src/api-client.ts`).

Journey state lives in Redis as a **portal flow** keyed by a signed, expiring token
(`apps/portal/src/state.ts`), bound to NAS + client MAC + gateway session id. The browser holds
only the token in the URL and a CSRF nonce cookie.

Authorization is **never** decided by the portal. The API's identity broker
(`apps/api/src/internal/portal-identity.ts`, `portal-credential.ts`) converts an identity proof
into a short-lived single-use RADIUS credential (`pc-<hex>`, 90 s, bound to nasid+mac+sessionid);
FreeRADIUS authenticates that credential and the existing policy engine attaches the policy. The
portal then hands the browser to the gateway. `Connected` is shown only after the gateway's own
`res=success` callback or a vendor-API authorize confirmation — not after a form post.

Gateway adapters in production paths today: uspot UAM, CoovaChilli UAM, MikroTik Hotspot,
post-back controllers (UniFi / Omada / Mist / Cambium) and Meraki cloud splash.

## 2. Feature status matrix

| Feature | Existing code/service evidence | Status | Required changes | External dependency |
| --- | --- | --- | --- | --- |
| **Public portal routes** | `apps/portal/src/index.ts:340-985` — `/healthz`, `/portal.css`, `/a/:assetId`, `/uam/uspot`, `/uam/chilli`, `/hotspot/mikrotik`, `/pb/:profile`, `/meraki/:nasid`, `/guest/s/:site`, `/ext/omada`, `/ext/mist`, `/f/:token[/login|/voucher|/click|/status|/logout]` | Working | Add method pages for each new login method | — |
| **Page states** | `pages.ts:75-137` — landing, login, voucher, terms, success, error, expired, status, logout, handoff, connected | Partial | 14 further states required by §6 (OTP entry/cooldown/expired, sponsor pending/rejected/expired, plan selection, payment ×5, quota reached, device limit, suspended, logout-failed retry) | — |
| **Gateway discovery / redirect parsing** | `internal/portal.ts:614` `POST /redirects`; `packages/adapters/src/vendor/uam.ts` verifies `md=` = `MD5(url + uamsecret)` over the raw query bytes | Working | — | — |
| **Trusted tenant/site/NAS resolution** | `internal/nas-lookup.ts:227` `findNasByIdentity` (nasid + `called` AP MAC), `decideNasIdentity:139`; tenant comes from the NAS row, never from a query parameter | Working | — | — |
| **Portal resolution precedence** | `internal/portal.ts:197` `pickPortal` — pinned by `adapter_config.nas_client_id`, else the single unpinned portal for (site, portal_type); anything ambiguous fails closed | Partial | §8 wants an explicit documented chain incl. SSID and a tenant default | — |
| **Replay / expiry / open-redirect defence** | `internal/portal.ts` single-use login tokens (`login-token-store.ts`), flow TTL, `isNasHandoff`/`isPostbackHandoff`/`isMerakiHandoff`/`isMistGrantUrl` origin allow-lists in `apps/portal/src/index.ts:89-205`, per-page CSP `form-action` | Working | — | — |
| **CSRF / cookies** | `state.ts:52` HMAC CSRF bound to flow id + cookie nonce; `serializeCookie` `HttpOnly; SameSite=Lax`, `Secure` when configured | Working | — | — |
| **Rate limiting / lockout** | `internal/portal.ts:306-330` per-IP, per-site, per-(method,nas,mac) and per-account counters in Redis; fail2ban jail `infra/vps/fail2ban/filter.d/ecloud-portal.conf` | Working | Reuse for OTP request limits | — |
| **Login method: username/password** | `portal-identity.ts` Argon2id with dummy-hash timing floor, status/site/validity checks, generic errors, verify outside the DB transaction | Working | Password visibility toggle (§4.3) needs script or a CSS-only control; recovery flow absent | — |
| **Login method: voucher** | `internal/portal.ts` `verifyVoucherCode` → `routes/vouchers.ts` HMAC lookup, atomic redemption, D-037 limits | Working | Expose distinct invalid/expired/used/revoked states (today one generic rejection) | — |
| **Login method: click-through / terms** | `pages.ts` `terms` body; immutable `portal_terms_versions` (migration 021); acceptance recorded in `portal_login_attempts` | Working | Record acceptance timestamp + version against the device, not only the attempt row | — |
| **Login method: MAC auth** | `captive_portals.auth_methods` CHECK allows `'mac'` (migration 006); AAA side exists for MAC auth | Partial | Portal never offers or implements it; needs device-registration lifecycle + revocation | — |
| **Login method: email OTP** | `apps/api/src/internal/otp.ts` (issue/verify, peppered HMAC hashes, attempts, single use), `apps/api/src/mail.ts` (nodemailer), migration `035_otp_codes.sql` with RLS | Partial — core built, **not wired** | No portal pages, no `identify` method, no admin configuration; `grep otp apps/api/src/internal/portal.ts` returns nothing | SMTP credentials |
| **Login method: SMS OTP** | `otp_codes.channel` CHECK already allows `'sms'`; `normalizeIdentifier` handles E.164 | Missing | Provider adapter + country-code input + the shared OTP pages | SMS gateway account |
| **Login method: social (OAuth/OIDC)** | `identity_providers` table (migration 004) with `type` CHECK and `client_secret_ref`; `captive_portals.identity_provider_ids`; designer renders a **disabled** "Social login" checkbox (`PortalDesignerPage.tsx:280`) | Missing | OIDC/OAuth adapter, PKCE + state + nonce validation, callback route, walled-garden entries, captive-browser fallback | Google/Facebook/Apple app registrations |
| **Login method: enterprise SSO** | Same `identity_providers` table | Missing | SAML/OIDC adapter + group mapping | Customer IdP metadata |
| **Login method: registration form** | None | Missing | Form definition model, validation, consent, data minimisation | — |
| **Login method: sponsor approval** | None | Missing | Request model, scoped approver permissions, expiry, audited decisions, approval UI | Mail delivery |
| **Login method: hotel / PMS** | None | Missing | Guest-validation adapter interface; room+surname must match a trusted source | PMS vendor and credentials |
| **Payment / plan selection** | None. No payment provider anywhere in the tree | Missing | Checkout handoff + verified server-side callback + idempotent fulfilment | Payment provider account |
| **Templates (six)** | None. No template concept; `template_key` in the tree belongs to `roles` (migration 002) | Missing | Template model driving default methods, default strings and which content blocks render | — |
| **Theme / branding** | migration 006 `portal_themes` (colors, strings, logo, custom_css, version); `packages/shared/src/portal-theme.ts` — 7 colour tokens, 9 string keys, `#rrggbb` only, WCAG 4.5:1 `contrastIssues`, `localeDirection` | Partial | Background image, font choice, button/card style, favicon, method ordering | — |
| **Branding editor** | `apps/admin/src/features/portals/PortalDesignerPage.tsx` (848 lines) — colours with contrast hints, logo upload, English texts, method toggles, NAS pin, UAM URL, terms publishing, preview with page + language selectors | Partial | Editor fields for everything added above; draft/publish/restore controls | — |
| **Preview isolation** | `portal-admin/routes.ts:862-898` `POST /portal-previews` → short-lived same-origin token; `preview.ts` calls `renderPreview` from `@ecloud/portal`; CSP `default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox`; sample data only, forms have no `action` | Working | Extend `PORTAL_PREVIEW_PAGES` (8 today) to the new states | — |
| **Asset uploads** | migration 021 `portal_assets` — PNG/JPEG/WebP only, ≤5 MiB, sha256, `storage_key` CHECK pins the object to `org/{id}/{purpose}/{id}` so a row cannot point into another tenant's prefix; INSERT/DELETE only, no UPDATE | Working | Allow a `background` purpose | — |
| **Draft / publish / immutable version / rollback** | None. The portal runtime reads the live `captive_portals` and `portal_themes` rows, so an admin edit is visible to guests immediately and half-saved states are reachable | Missing | `portal_versions` snapshot table + a published pointer; runtime reads the snapshot | — |
| **Localisation** | `apps/portal/src/i18n.ts:73` — `CATALOGUES = { en: EN }`; RTL-ready via `dir` + logical CSS; theme strings resolve per locale (`resolvePortalStrings`) | Partial | No second catalogue, and the runtime pins `DEFAULT_LOCALE` (`index.ts:231`) — the guest cannot pick a language | Arabic translation |
| **Accessibility** | `pages.ts` — labels on every input, `role="alert"` errors, `role="status"` notices, skip link, `<time datetime>`, focusable terms box; `styles.ts` + contrast validation | Working | Verify new pages; reduced-motion; no device testing done | Device/browser lab |
| **Connected / status page** | `index.ts:928` `/f/:token/status` → `internal/portal.ts:1276` — session start, bytes in+out, duration; logout form | Partial | Plan, validity, expiry, remaining quota, configured max speed, device/concurrent-session allowance, reduced-speed state. The data exists (`packages/policy-engine`, migrations 036/037) but no portal-facing read interface | — |
| **Logout** | `index.ts:958` POST → `internal/portal.ts:1313` → gateway `/logoff`; refuses any URL outside the NAS origin | Working | Report a pending/failed disconnect distinctly instead of showing `expired` | — |
| **Status-page authorisation** | Status is reachable only through the signed flow token bound to NAS+MAC+session; no user-id in the URL | Working | — | — |
| **Analytics** | migration 006 `portal_login_attempts` (monthly partitions, 90-day retention, result accept/reject/error, only a 2–3 char code prefix, never the code); `apps/portal/src/metrics.ts` Prometheus `logins{method,result}` + HTTP metrics | Partial | Impressions, method selections, funnel steps, authorization-vs-connection as separate events, provider latency, handoff failures | — |
| **Admin authorisation / tenant isolation** | `portal-admin/routes.ts` behind the permission catalogue; RLS on every portal table (migrations 010, 021, 035) with `app.current_org` | Working | — | — |
| **Secret handling** | UAM secrets sealed with HKDF envelope (`sealUamSecret`, `internal/portal.ts:97`); `SECRET_PLACEHOLDER` in API responses; OTP pepper outside the DB; logger redaction tests | Working | — | — |
| **Walled garden** | `captive_portals.walled_garden text[]` (migration 006) rendered into device config | Partial | Entries for each new provider (OTP mail, OAuth hosts, payment) and a check against over-broad wildcards | — |
| **802.1X / RADIUS onboarding** | `docs/AAA_*`, RadSec (migration 034) | Working (separate concern) | Keep out of the login-method list; link from admin docs | — |

## 3. Honest summary

Working and verified by code: the hard parts. Gateway handoff, trusted context, replay defence,
tenant isolation, the identity-broker indirection that keeps social providers out of RADIUS, the
preview sandbox, asset-prefix pinning, rate limiting, and a genuinely accessible page set.

Missing: almost everything the requirement calls *product surface*. There is no template concept,
no publish/rollback, and only three of eleven login methods. The portal is a well-built single
template with three methods, not a configurable six-template system.

The two that matter most structurally, because everything else depends on them:

1. **No published version.** The runtime reads live rows. A guest can land mid-edit. Rollback
   means manually reversing fields. Every new editable field makes this worse, so the version
   snapshot has to land before the editor grows.
2. **No template or method registry.** `PORTAL_METHODS` is a hard-coded three-element tuple in two
   places and `PortalMethod` is a closed union in `pages.ts:54`. Adding a method today means
   editing the portal renderer, the portal routes, the API identify handler, the DB CHECK and the
   admin page. That is the cost to drive down first.

## 4. Implementation sequence

Stage order follows §16 of the requirement. Each stage keeps the product working and ships tests.

| Stage | Content | Blocked by |
| --- | --- | --- |
| 1 | This audit — **done** | — |
| 2 | Method registry + template model + published-version snapshot — **done**, see §6 | — |
| 3 | Template-driven rendering for all six templates; editor fields for background, fonts, method order, language; extended preview states | — |
| 4 | Registration form definitions; voucher state detail; terms acceptance record; MAC device registration | — |
| 5 | Email OTP wired end to end (core already exists) | SMTP credentials to verify delivery |
| 6 | Connected-page quota/expiry/device-limit read interface; logout pending/failed states | — |
| 7 | Social/OIDC adapter | Provider app registrations |
| 8 | Sponsor approval | Mail delivery |
| 9 | SMS OTP | SMS gateway |
| 10 | Hotel/PMS adapter; payment adapter — interfaces and disabled-until-configured pages only | PMS and payment accounts |
| 11 | Funnel analytics, migration validation, release documentation | — |

Stages 7–10 are externally blocked. They ship as configured-off adapters with the admin shown the
reason a method is unavailable, per §5 of the requirement; they are not silently enabled.

## 5. Not verified

- No live gateway test ran during this audit. The matrix reflects code, migrations and existing
  test suites, not a device session.
- No iOS/Android captive mini-browser test. `docs/` records the constraint; no run is recorded.
- Email OTP delivery is unverified: `createMailer` returns `null` without SMTP configuration.

## 6. Stage 2 as built

### Method registry — `packages/shared/src/portal-methods.ts`

`PortalMethod` was a closed three-value union in the renderer and `PORTAL_METHODS` a hard-coded
tuple in the API, so adding a method meant editing five places. A method is now a registry row
carrying its route segment, its external dependencies, whether it establishes verified identity,
and its overridable button label. All thirteen methods the requirement names are registered;
`methodAvailability` refuses any whose provider is unconfigured and returns the unmet
dependencies, which is what lets the designer tell an administrator *why* a method is unavailable
(§5) instead of silently hiding it.

`offeredMethods(enabled, order, capabilities)` is the single ordering rule: explicitly ordered
methods first, then the remaining enabled ones in registry order, with unavailable methods and
methods that have no guest page dropped. The landing page and `identify` both call it, so a method
the page does not offer cannot be submitted by a client that guesses the route.

Registry order runs click-through, password, voucher, then the rest: one tap before anything the
guest must know, receive or buy. **This changed existing behaviour** — a portal with no explicit
`method_order` previously rendered password first.

`verifiesIdentity` is false for `click_through`, `registration`, `voucher`, `paid`, `sponsor` and
`mac`, which is the §17 criterion that terms-only and form-only access is never presented as
verified identity.

### Templates

Six `PORTAL_TEMPLATES` entries, each with an audience, suggested methods and the methods a new
portal of that template starts with. Templates compose pages; they do not restrict methods, so any
template may offer any configured method (§3). A new portal starts with its template's
dependency-free methods only — never every method (§3) — and `hotel_resident` starts with none,
because §4.5 forbids granting access on a room number alone and hotel validation needs a trusted
source first. The default template is `branded_multi_login`.

### Published versions — migration 038, `apps/api/src/internal/portal-snapshot.ts`

`portal_versions` holds an immutable jsonb snapshot of the whole public configuration: template,
theme colours/strings/logo, enabled methods and their order, terms version, locales, registration
fields. `captive_portals.published_version_id` points at the one guests are served.

Consequences, all of which the requirement asks for:

- **Publishing is atomic** because it is one UPDATE of one column. No half-updated configuration
  is reachable by a guest (§8).
- **Rollback is a pointer move.** `POST /versions/{id}/restore` leaves both the history and the
  draft intact, which satisfies "rollback without discarding drafts or audit history" (§8).
- **The runtime reads the snapshot, never the draft.** An administrator editing the designer does
  not change what guests see until they publish.
- **`identify` checks the published method set**, so a method enabled only in the draft cannot be
  submitted.
- **Publishing is validated** (`publishProblems`). It is refused when no enabled method could be
  offered to a guest, when accept-terms is on with no published terms version, when the
  registration method is on with an empty form, when a marketing-consent field is marked required
  (§13), and when the default locale is not among the offered ones. §16's "do not silently publish
  incomplete templates" is enforced rather than documented.
- **A snapshot contains no secret.** UAM secrets and provider client secrets stay in their own
  columns and are read per request; a snapshot is served to a guest's browser.

`published_version_id IS NULL` means draft-only and serves guests nothing. The migration published
version 1 of every portal that already existed, so no live portal went dark; **a portal created
from now on must be published before it serves anyone**, which changes what "create a portal"
means for anything scripting the API.

### Other columns added by 038

`method_order`, `ssids` (the §8 resolution chain, empty = every SSID at the site),
`registration_fields` (draft form definition) and `locales` (first entry is the default).
`auth_methods` was widened from five values to the thirteen of the registry so a method can be
recorded before its adapter ships; what a guest is *offered* is still decided by availability.

`ck_captive_portals_ssids` calls an IMMUTABLE plpgsql function rather than containing an
expression, because a CHECK constraint may not contain the subquery that iterating an array
requires. plpgsql rather than SQL so the planner cannot inline the body and reintroduce the
subquery; the empty-array case returns true by explicit decision rather than by a NULL that would
pass the constraint by accident.

### Assignment precedence (§8)

Resolution is unchanged in behaviour and now documented. `pickPortal`
(`apps/api/src/internal/portal.ts`) resolves the portal for a NAS by: a portal pinned to that NAS
through `adapter_config.nas_client_id`; otherwise the single unpinned active portal for that
(site, portal_type). Anything ambiguous — two pinned, or two unpinned — fails closed and the guest
sees the generic error, never a guessed portal. Tenant and site always come from the NAS row
resolved by `findNasByIdentity`, never from a query parameter. The `ssids` column is stored and
validated but **not yet consulted**: wiring it into the chain is stage 3, because no current
adapter path reports an SSID that has been verified against the NAS record.

### Verification

- `packages/shared/src/portal-methods.test.ts` — 17 unit tests over the registry, availability,
  ordering and the template invariants.
- `apps/api/src/portal-admin/portal-admin.integration.test.ts` — three added integration tests:
  the full publish → edit-draft → republish → rollback cycle including that the draft survives;
  refusal with the named missing dependency for a portal whose only method is unconfigured; and a
  cross-portal restore answering 404.
- Whole suite after the change: 2161 passing, 22 skipped, 180 files, against `ecloud_test` and
  Redis. Unit-only: 1635 passing.
- `bash scripts/check-no-secrets.sh`: OK, 837 files.
- Migration applied to the **local dev databases only** (`ecloud` and `ecloud_test` in the dev
  stack). Nothing was applied to, or run against, the remote server.

Not verified: no gateway or device test ran. The published-snapshot path is exercised by the
simulator-based suites, which is evidence about the code and not about hardware.

## 7. Platform-default portal (owner request, migration 041)

Request: a NAS that exists but has nothing assigned should still serve a working portal with a
single Connect button, so bring-up works before anyone has built a site or a profile. Scope was
widened by the owner to **any** NAS with nothing assigned, not only not-yet-adopted ones.

### How it works

When `pickPortal` finds no configured portal for a (site, portal_type), the resolver creates a
click-through-only portal flagged `is_platform_default`, publishes it in the same transaction, and
serves it. `template_key` is `quick_connect`; `method_order` is an explicit `['click_through']`
rather than relying on the registry's fallback order, so the page keeps offering exactly one
button whatever is added to the registry later.

The guest journey is one tap. A portal offering only click-through renders the connect page
directly instead of a method list (§4.6 "one primary action"), and with no terms document
configured the acceptance checkbox is replaced by a hidden field — the "use this network
responsibly" line above the button is the acceptance. A configured terms document still requires a
ticked box, because acceptance of a specific document should be a deliberate act.

### Fail-closed rules

Each of these exists because the fallback grants network access with **no identity**, so a state
that looks like a working configuration must never be reachable by accident:

- **Ambiguity never falls back.** `pickPortal` returns `found` / `none` / `ambiguous`. Two
  configured portals matching one NAS is an operator misconfiguration: it shows the error page and
  logs `portal_resolution_ambiguous`. An earlier version conflated `none` and `ambiguous` through
  a `??`, which made that misconfiguration fail *open* onto an anonymous portal.
- **A configured portal blocks the fallback, whatever its status.** Disabling a portal is how an
  operator takes a site's guest access offline; serving a fallback would turn "offline" into
  "open". The rule lives in one function, `configuredPortalExists`, and is applied on BOTH the
  creation path and the serving path. Applying it only on creation was a real fail-open: once a
  fallback row exists — and it does for any site that was ever unconfigured, i.e. every site
  during bring-up — `pickPortal` returns it directly and the creation path never runs, so
  disabling the real portal silently reopened the site as an anonymous portal. A *deleted*
  portal leaves no row and therefore no evidence, so a site whose portal was deleted does fall
  back; distinguishing that would need a tombstone and is a known limitation.
- **A disabled platform default stays disabled.** Both the lookup and the post-insert re-read
  filter on active status, and the partial unique index stops a second row being created beside
  the disabled one. This is the operator's only switch for turning the feature off per site.

### Visibility

The fallback is deliberately temporary and must look it. `is_platform_default` is exposed on the
portal API, filterable (`?is_platform_default=true`) so "which sites are serving the anonymous
default" is one request, and badged amber in the admin portals list as "Platform default — not
configured". The resolver logs `portal_platform_default_served` per resolution. The credential
carries `platformDefaultPortal` to the AAA side at issue time, so the session and auth event can
record that access was granted by a configuration gap rather than by a choice.

This matters more than it first appears: the owner chose generous fallback limits (10/10 Mbps for
a day), so a forgotten access point will not announce itself through a poor guest experience. The
badge and the flag are the only signals that exist.

The flag is not settable through the admin API — it is absent from `PortalCreate` and
`PortalUpdate`, so an operator cannot mint a fallback by hand or convert a real portal into one.
The resolver is its only writer.

### Known limitation

`openwifi-uspot-uam`, `uspot-upstream-uam` and `coovachilli-uam` declare `requireSecret: true`, so
an unsigned redirect is refused (SECURITY §5.2). A fallback portal has no UAM secret and cannot
obtain one, because the device's secret is not knowable from the portal side. **The fallback
therefore cannot complete a hand-off for those three families**; it serves MikroTik, Meraki and the
post-back families. Signature verification was not weakened to close this. Closing it properly
means recording a device's UAM secret on the NAS at provisioning time so a fallback portal can
adopt it, which is NAS-provisioning work and is recorded here as a dependency, not implemented.

Post-back profile resolution (`portal-postback.ts`) keeps its existing behaviour and does not
create a fallback; extending it is separate work. Both absence and ambiguity fail closed there.

### Deliberate divergence from NAS_PENDING_ADOPTION_REQUIREMENTS.md

`NAS_PENDING_ADOPTION_REQUIREMENTS.md` (added 2026-10-14) specifies the opposite of this feature,
and the difference is a decision rather than an oversight. Recorded here because an undocumented
override reads as a bug to whoever finds it next.

| That document says | This implementation does | Why |
| --- | --- | --- |
| §5: a NAS with no applicable policy is Pending, new access **Denied** | An unassigned NAS resolves a click-through portal and a platform default plan (10/10 Mbps, one day) | Owner decision, 2026-10-14, over the specification |
| §7: "Do not accidentally treat an unrestricted global fallback as valid assignment" | The fallback *is* a global default assignment | §7 prohibits doing it accidentally; this is recorded and visible |
| §8: "No default acceptance or automatic adoption may bypass these conditions" | Default acceptance for any NAS with nothing assigned | Same decision |

The owner was shown both readings, including a deny-by-default Pending state and an
"not yet configured" page that keeps the bring-up diagnostics without granting access, and chose
the permissive fallback.

Consequence for the Pending work: **Pending will not trigger on `NO_POLICY` the way §5 describes**,
because the policy-resolution input no longer returns "no policy" for an unassigned NAS — it
returns the platform default. The other Pending reasons (`NOT_ADOPTED`, `OWNERSHIP_UNRESOLVED`,
`POLICY_DISABLED`, `POLICY_UNAVAILABLE`, `IDENTITY_CONFLICT`) are unaffected. Any Pending List
built against §5 must be designed knowing `NO_POLICY` is now reachable only when the platform
default itself is missing or disabled.

The mitigation for the whole divergence is visibility, which is why the badge, the filter, the
`portal_platform_default_served` log line and the credential flag are requirements and not
decoration: they are the only thing between a forgotten access point and indefinite anonymous
access, given the generous default limits.
