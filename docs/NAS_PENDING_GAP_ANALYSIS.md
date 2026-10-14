# NAS Pending List and Adoption — gap analysis (management surface half)

Audited 2026-10-14 against `NAS_PENDING_ADOPTION_REQUIREMENTS.md` §3.

**Scope of this document.** §3 asks for an audit of ten areas. This covers the ones in the portal
and admin-surface lane: the management API, permissions, the existing NAS and access-point admin
interface, and what the portal already records when resolution fails. The RADIUS listener,
unknown-client handling, Access-Request processing, policy precedence and accounting paths are
being audited in parallel by the session that owns AAA; this document does not duplicate or
pre-empt that half, and the two together answer §3.

Nothing here changes behaviour. No migration was created and no migration number requested.

## 1. Required table

| Area | Existing flow and evidence | Gap | Proposed change | Compatibility impact |
| --- | --- | --- | --- | --- |
| NAS registration | `apps/api/src/routes/resources.ts:581` — `nas_clients` CRUD at `/api/v1/orgs/{orgId}/nas` via the shared `crudRoutes` helper. The admin wizard (`AddAccessPointWizard.tsx`, 648 lines) posts there, then to `/access-points`. | No adoption concept. A `nas_clients` row is created complete and immediately eligible; there is no state between "does not exist" and "fully usable". | Derive adoption from existing facts (§5: "Pending may be a derived view"), not a new status column. See §3 below. | Additive. Existing rows read as adopted. |
| Administrative status | `nas_clients.status` CHECK `('active','disabled')` (migration 003), plus `deleted_at` soft delete. | §5 needs four user-facing states: Pending, Active, Disabled, **Blocked**. `Blocked` has no representation, and §5 requires it to override automatic activation and survive a policy being restored. | Add `blocked` to the status CHECK rather than a parallel column, so one field remains the administrative truth and existing `status` readers keep working. Needs a migration number. | One CHECK widened. Every existing reader treats unknown values as not-active already; verify that claim before relying on it. |
| Trust verification | **Already exists and is the right shape.** `nas_access_points.verified_at` + `verification_source` CHECK `('radius-called-station','controller-inventory')` (migration 028), with the design note that a row "serves MAC-only lookups only after the NAS itself proved the AP". Surfaced by `GET /orgs/:orgId/access-points/overview`. | Applies to access points, not to the NAS record itself. §4 wants transport source address, reported NAS-IP-Address, reported NAS-Identifier and trusted client identity kept distinct. | Reuse this exact verified/unverified vocabulary for §5's Verified/Unverified rather than inventing a second one. The precedent, the CHECK values and the admin display already exist. | None. Pure reuse. |
| Pending reasons | None. | §5 names six reasons, requires **all** applicable reasons retained with a stable primary display reason. | Compute the set; store nothing. The inputs (adoption facts, `status`, site/org validity, policy resolution) are all already readable in one query. | None if derived. |
| Policy resolution input | `packages/policy-engine/src/resolve.ts` rejects with `no_policy` today. **The owner's 2026-10-14 ruling changes this**: an unassigned NAS now resolves a platform default plan (10/10 Mbps, one day). | §5 expects `NO_POLICY` to put a NAS in Pending with access **Denied**. After the ruling it will not, because resolution no longer returns "no policy" for an unassigned NAS. | Keep `NO_POLICY` as a reason but note it is reachable only when the platform default itself is missing or disabled. **This is a documented divergence, not a reconciliation** — see §4. | Changes what Pending means versus the written specification. |
| Unknown-source discovery | Nothing is persisted. `apps/api/src/internal/nas-lookup.ts:154` returns `{ok:false, reason:'unknown_nas'}`; `apps/api/src/internal/portal.ts:834` answers `{refused:'unknown_nas'}`; `logPortalSecurityEvent` (`security-events.ts:34`) writes a log line. Failures are observable in logs only. | §6 wants rate-limited discovery rows for unknown or unauthenticated sources, Unverified, restricted to platform administrators. There is no table and no row. | A bounded discovery table with retention and per-source rate limiting. **Whether the listener can safely expose an unknown client's identifiers at all is the AAA half's finding, not mine** — §6 explicitly permits "document that discovery is unavailable at that layer". Do not design the table until that answer lands. | New table. Blocked on the AAA audit. |
| Management UI | `apps/admin/src/features/access-points/` — `AccessPointsPage.tsx` (248), `AccessPointsTable.tsx` (279), `AddAccessPointWizard.tsx` (648), `SetupProgressCard.tsx` (141), `RadiusSecretBox.tsx` (257). The overview endpoint already returns per-AP `verified_at` / `verification_source`. | No Pending view, no Pending reason column, no adopt action, no filtering by trust state or reason. | Extend the existing table with a state column and a reason badge; add a Pending filter. §6's field set maps almost entirely onto what the overview endpoint already returns. | Reuses the existing page. No new route needed for the list itself. |
| Management API | `GET /orgs/:orgId/access-points/overview` (`nas:read`), `POST /orgs/:orgId/nas/:id/secret/reveal` (`nas:secret:reveal`, MFA step-up), `GET .../nas/:id/mikrotik-script` and `.../mikrotik-login-html` (`nas:read`), `POST /platform/access-points/release` and `.../confirm-inventory` (`organization:update`, platform-scoped). | No adopt-and-assign endpoint (§7's nine steps), no Pending query. | Add Pending as a filter on the overview endpoint rather than a new list endpoint — it already joins the right tables and enforces site scope. Adopt-and-assign is a new transactional endpoint. | Additive. |
| Permissions | `packages/shared/src/permissions.ts:103` — resource `nas`, `minScope: 'site'`, actions `read`, `create`, `update`, `delete`, `secret:rotate`, `secret:reveal`. | §11 wants management actions with permissions. Adoption is not `nas:update`: it assigns ownership and a policy and triggers provisioning. §6 also needs unverified cross-tenant observations restricted to platform administrators. | A distinct `nas:adopt` action, and discovery reads gated at platform scope. | Additive to the catalogue; the role templates at `permissions.ts:407` and `:438` grant `nas:read` only, so no role silently gains adoption. |
| Concurrency | `crudRoutes` uses the existing transactional helpers; the publish path I built for portals uses `forUpdate()` row locks and version pinning. | §7 requires idempotent repeat adoption and no duplicate or inconsistent state under concurrent administrators. | Reuse the `forUpdate()` + unique-index pattern already proven by migration 041's partial unique index, rather than a new mechanism. | None. |
| Provisioning truth | §7 step 9: activate only after provisioning succeeds, and "do not report Active just because a database update succeeded". | Nothing currently distinguishes "row written" from "device configured". | The portal side has the same rule and the same answer: `is_platform_default` publishes in the same transaction so no half-state is reachable. Adoption needs a Pending/Provisioning state for the window where the row exists but the client config has not reloaded. | Additive state. |

## 2. Where a request can first be observed, and where it becomes trustworthy

§3 asks for this explicitly. From the portal side:

- **First observation** is the gateway redirect arriving at the portal (`/uam/*`, `/pb/*`,
  `/meraki/*`, `/hotspot/mikrotik`). At that moment nothing is trusted: the query carries a
  reported `nasid`, and a guest-controlled browser delivered it.
- **It becomes trustworthy** at `findNasByIdentity` (`nas-lookup.ts:227`) combined with the UAM
  `md` signature check, which proves the redirect was built by a device holding the NAS's shared
  secret. For the three UAM adapters with `requireSecret: true` that is a real proof; for the
  others, trust comes from the vendor's own token or the authenticated controller session.
- **It can be denied safely** at the portal before any credential is issued, and again at AAA when
  the credential is presented. §8's warning about applying a rule "only in the UI or captive
  portal while direct RADIUS requests bypass it" is the important one: the portal is not an
  enforcement point and must not be treated as one. Any eligibility rule has to live in the AAA
  authorize path, with the portal only *reflecting* it.

**Limitation, as §3 requires naming.** The portal never sees a NAS the listener rejects. A NAS
with no `nas_clients` row produces no redirect we can attribute, because the UAM signature cannot
be verified without a secret. So portal-side discovery can only ever show NAS rows that already
exist. Discovery of genuinely unknown clients is a listener question, and that is the AAA half's.

## 3. Pending as a derived view

§5's "Pending may be a derived view rather than a destructive change to an adopted record" plus
"a policy loss must not erase adoption history" rules out a written status column. Proposed
derivation, computed from facts that already exist or are added as facts rather than as states:

```
Blocked      if status = 'blocked'
Disabled     else if status = 'disabled' or deleted_at is not null
Pending      else if any reason applies:
               NOT_ADOPTED          adoption facts incomplete
               OWNERSHIP_UNRESOLVED org/site missing or invalid
               NO_POLICY            no policy resolves (see §4 — now rare)
               POLICY_DISABLED      resolved policy is disabled
               POLICY_UNAVAILABLE   policy service failed to answer
               IDENTITY_CONFLICT    identifier claimed by more than one record
Active       otherwise
```

Primary display reason is the first match in that fixed order, which gives §5's "stable primary
display reason" without a stored choice. All matching reasons are returned alongside it.

`Blocked` and `Disabled` precede every Pending reason, which satisfies §5's "Blocked and Disabled
must override any automatic activation" and "restoring a policy must never silently unblock or
re-enable a NAS" — restoring a policy changes a Pending reason, never the administrative state.

## 4. Where the implementation will differ from the specification, by decision

Recorded here rather than quietly reconciled, because the owner chose it and the report should
name it.

The owner ruled on 2026-10-14 that any NAS with nothing assigned receives a default accept —
a click-through captive portal and a 10/10 Mbps one-day plan. `NAS_PENDING_ADOPTION_REQUIREMENTS.md`
§5 says such a NAS is Pending with new access **Denied**, §7 says "do not accidentally treat an
unrestricted global fallback as valid assignment", and §8 says "no default acceptance or automatic
adoption may bypass these conditions".

Consequence: **`NO_POLICY` will almost never fire.** Policy resolution returns the platform default
instead of nothing, so the Pending state the specification is built around is unreachable by its
own main route. `NO_POLICY` remains meaningful only when the platform default itself is missing or
disabled. The other five reasons are unaffected and the Pending List remains worth building.

The mitigation is visibility, and it is now load-bearing rather than cosmetic: the
`is_platform_default` badge, the `?is_platform_default=true` filter, the
`portal_platform_default_served` log line and the `platformDefaultPortal` flag carried to AAA are
the only signals that a given access point is serving anonymous access by configuration gap rather
than by choice. Given generous default limits, no guest will ever complain and nothing else will
surface it. See `docs/CAPTIVE_PORTAL_GAP_ANALYSIS.md` §7 for that side.

## 5. Implementation sequence (management-surface half)

1. This audit. **Done.**
2. Pending derivation as a pure function with unit tests, in the shape of §3 above. No schema.
3. `blocked` added to the `nas_clients.status` CHECK; `nas:adopt` added to the permission
   catalogue. One migration, number to be requested at write time.
4. Pending state and reasons on the existing access-points overview endpoint, plus a filter.
5. Pending column, reason badge and filter in `AccessPointsTable.tsx`, reusing the
   verified/unverified display already there.
6. Adopt-and-assign endpoint and wizard (§7), transactional and idempotent.
7. Discovery of unknown sources (§6) — **blocked** on the AAA half's finding about whether the
   listener can expose unknown-client identifiers safely.

Steps 2–6 do not depend on the AAA audit. Step 7 does, and §6 explicitly allows documenting that
discovery is unavailable at that layer if the listener rejects unknown clients first.
