# Captive portal login methods — design

Status: **PROPOSED**, nothing built. Written 2026-10-14 at the owner's request ("social media and
all other latest login methods"). No migrations and no runtime code exist for anything below
except where marked IMPLEMENTED.

---

## 1. What exists today

**Implemented and working:** three methods, `PORTAL_LOGIN_METHODS` in
`packages/shared/src/portal-theme.ts:69`.

| Method | Behaviour |
|---|---|
| `password` | Username + password against the subscriber's Argon2id hash |
| `voucher` | Voucher code, with use counting, expiry, per-site brute-force cap |
| `click_through` | Accept terms and connect, no credential |

A portal row's `auth_methods` column chooses which of the three its splash offers.

**Schema groundwork that already anticipates the rest** (migration 004, 006, 010). This is why the
work below is additive rather than a redesign:

```
identity_providers (id, organization_id, type, name, config jsonb,
                    client_secret_ref, enabled, …)
  ck type IN ('local','oidc','google','facebook','saml','sms_otp','radius_proxy')
  uq (organization_id, lower(name))

users.identity_provider_id   FK -> identity_providers, ON DELETE RESTRICT
users.external_subject       ck: set only when identity_provider_id is set
users.email, users.phone
users.origin                 ck IN ('admin','portal_signup','voucher','idp')
users.auth_methods           ck <@ ARRAY['password','mac','voucher','idp']
  uq_users_idp_subject (identity_provider_id, external_subject)

captive_portals.identity_provider_ids uuid[]   -- per-portal provider selection
```

**What is missing is the entire runtime.** Nothing reads `identity_providers`: no API route, no
admin UI, no portal code path. `idp` in a user's `auth_methods` currently resolves to nothing.

---

## 2. Constraints that shape every option

### 2.1 The embedded-webview problem (decides whether social login is pleasant)

A captive portal normally opens in the OS Captive Network Assistant, an embedded webview.
**Google refuses OAuth in embedded webviews** (`disallowed_useragent`), and has done since 2016.
Facebook and Apple are less consistent but have both broken in CNA webviews across OS versions.

This is not something EZECLOUD can fix; it is the provider's policy. The options are:

- **Hand-off to the real browser.** The splash shows "continue in your browser", the guest leaves
  the CNA, completes sign-in in Safari/Chrome, and is redirected back. Works, costs a step, and
  loses some guests.
- **Rely on the portal being reachable by name over the internet.** Since the move to
  `https://portal.ezelink.ai` this is true here, which makes the browser hand-off viable; it would
  not have been while the portal was LAN-only on `192.168.203.196:444`.

Any social-login estimate that ignores this is wrong. Budget UX work for the hand-off, not just
the OAuth client.

### 2.2 Walled garden

A captive guest can only reach what the AP permits before authentication. **Every provider adds
domains to every portal's walled garden**, and to the AP/controller profile. Non-exhaustive:

| Provider | Needs at least |
|---|---|
| Google | `accounts.google.com`, `oauth2.googleapis.com`, `www.googleapis.com`, `ssl.gstatic.com` |
| Facebook | `www.facebook.com`, `m.facebook.com`, `graph.facebook.com`, `static.xx.fbcdn.net` |
| Apple | `appleid.apple.com`, `appleid.cdn-apple.com` |
| Microsoft/Entra | `login.microsoftonline.com`, `login.live.com` |

Provider domain sets change without notice; this is ongoing maintenance, not a one-off.

### 2.3 Accounts, contracts and costs the owner must supply

I cannot create any of these.

| Method | Owner must provide | Recurring cost |
|---|---|---|
| Email OTP | SMTP host, credentials, from-address | none |
| Google | Google Cloud project, OAuth client ID + secret, redirect URI | none |
| Facebook | Meta app, app ID + secret, app review for public use | none |
| Apple | Apple Developer Program membership (paid), Services ID, key, domain verification | annual fee |
| Microsoft/Entra, Okta, generic OIDC | tenant/app registration, client ID + secret | none |
| SMS OTP | SMS gateway account, API credentials, sender ID | **per message** |
| Paid subscriptions | Payment processor account (e.g. Stripe), tax configuration | per transaction |

### 2.4 Portal process constraints

The portal holds **no database credentials** and never sees a UAM secret or subscriber password at
rest; every decision is made by the API over `/internal/portal/*`. All new methods must follow
that: the portal renders and forwards, the API decides. OIDC client secrets are sealed in
`identity_providers.client_secret_ref` using the existing envelope, never in `config`.

Portal pages are served with a strict CSP and **no page JavaScript** (a script nonce is issued only
for the handoff auto-submit page). So:

- OTP entry is a plain form post — fine.
- OIDC is a top-level redirect to the provider and back — fine; CSP `form-action` does not restrict
  navigation, only form targets.
- Anything requiring an in-page SDK (Facebook JS SDK, Google One Tap) is **not available**. Use the
  server-side OAuth code flow for every provider.

### 2.5 Abuse and cost control

Email and especially SMS OTP are spend and spam vectors; vouchers already have a per-site
brute-force cap, and OTP needs the same discipline: per-identifier and per-site rate limits, a
single-use code with a short TTL, an attempt cap per code, and for SMS a per-site daily spend
ceiling. Without those, a day's SMS budget is one script away from being someone else's.

---

## 3. Shared design

### 3.1 `identity_providers` runtime

One new API resource (CRUD, RLS-scoped, `identity_provider:*` permissions), one admin UI page, and
a per-portal selector writing `captive_portals.identity_provider_ids`. `config` holds non-secret
settings (issuer URL, client ID, scopes, sender id); the secret goes to `client_secret_ref`.

### 3.2 Flow integration

Extend the identify contract (`apps/portal/src/api-client.ts:46`) rather than adding a parallel
path. Today:

```
{ method: 'password' | 'voucher' | 'click_through', … }
```

Proposed additions:

```
{ method: 'otp_request', identifier: string, channel: 'email' | 'sms', provider_id }
{ method: 'otp_verify',  identifier: string, code: string, provider_id }
{ method: 'idp_callback', provider_id, code, state }        // OIDC authorization-code result
{ method: 'signup', … }                                      // self-registration
```

Each resolves to the same place the existing methods do: a subject, then a single-use `pc-<hex>`
credential and the NAS hand-off. **No change below the identity broker** — policy resolution,
RADIUS, accounting and CoA are untouched by any of this.

### 3.3 Subject linkage

An IdP login looks up `users` by `(identity_provider_id, external_subject)` — the unique index
already exists. First sign-in creates a user with `origin = 'idp'`, `auth_methods = ['idp']`, the
provider's subject, and email/display name when the provider supplies them. Account linking by
email is **deliberately not** proposed: matching a Google account to an existing local user by
email address alone is a well-known account-takeover path when the provider does not guarantee a
verified, non-reusable address.

---

## 4. Methods, in recommended build order

Effort is relative: S ≈ a day, M ≈ a few days, L ≈ a week or more, each including tests.

### 4.1 Email OTP + self-registration — **first**, M

No vendor, no app registration, no per-message cost, no webview problem. Builds the OTP core
(issue, verify, rate limit, single-use, TTL) that SMS later reuses, plus the self-registration
shape (`origin = 'portal_signup'`).

Needs: SMTP credentials. New: an `otp_codes` table (hashed code, identifier, provider, expiry,
attempt count), two identify methods, two portal pages, admin UI, mail transport.

### 4.2 Google sign-in (OIDC) — M

Generic OIDC client (authorization code + PKCE, `state`, `nonce`, issuer discovery), so
Microsoft/Entra, Okta and any compliant provider reuse it. Google is the configuration, not the
code. Includes the browser hand-off for CNA webviews, which is the fiddly part.

Needs: Google Cloud OAuth client, redirect URI on `portal.ezelink.ai`, walled-garden entries.

### 4.3 Facebook and Apple — M each, after Google

Both ride the OIDC/OAuth client from 4.2 with provider quirks: Facebook is OAuth2 with its own
userinfo shape rather than strict OIDC; Apple returns the user's name **only on first
authorisation** and requires a signed JWT client secret that expires and must be regenerated.
Apple also needs the paid Developer Program and domain verification.

### 4.4 SMS OTP — S once 4.1 exists

Mostly a provider adapter plus phone normalisation and spend control. The OTP core is already
built by then.

Needs: gateway account, credentials, sender ID, a per-site daily cap.

### 4.5 Sponsor approval — M

Guest requests access, a named sponsor (staff email) approves, access is granted for a window.
Needs email (4.1), an approval token flow, an expiry and audit trail, and an admin view of pending
requests. Common in corporate guest Wi-Fi, and the one method here with a human in the loop.

### 4.6 Paid subscriptions — L, and a different kind of risk

Payment processor integration, plans and prices, webhook handling, refunds, receipts, tax, and the
compliance that comes with taking money. Recommend Stripe Checkout (hosted) so card data never
touches EZECLOUD. Worth separating from this document entirely; it is a billing feature that
happens to gate Wi-Fi, not a login method.

### 4.7 Already in the schema but not planned here

`saml` and `radius_proxy` are in the type constraint. SAML is enterprise-IdP territory and much
heavier than OIDC; RADIUS proxy is an AAA feature, not a portal login method, and belongs with the
AAA work. Neither is proposed now.

---

## 5. What this does not change

Policy resolution, RADIUS attributes, accounting, CoA, the NAS hand-off and the single-use
credential are untouched. Every method above produces the same thing the existing three produce: a
verified subject that the identity broker turns into a `pc-<hex>` credential. That is the reason
these can be added one at a time without destabilising the AAA path.

---

## 6. Open questions for the owner

1. Which methods are actually wanted, and in what order? The list above is a recommendation, not a
   commitment.
2. Is the browser hand-off acceptable for social login, given some guests will drop at that step?
   If not, social login is worth less than it looks and OTP is the better investment.
3. Who owns the provider accounts — EZELINK centrally, or each tenant? This is a multi-tenant
   platform: per-tenant OAuth apps mean each customer registers their own and the walled garden
   differs per portal, while central apps mean every tenant's guests see EZELINK's consent screen.
   This decision changes the data model and should be made before 4.2 is built.
4. For SMS, what daily spend ceiling per site is acceptable?
