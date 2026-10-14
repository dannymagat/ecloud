-- 041: the platform-default captive portal — a working connect page for a NAS nobody has
-- configured yet (owner request, 2026-10-14; CAPTIVE_PORTAL_ONLY_REQUIREMENTS.md §4.1).
--
-- The problem. A NAS row exists the moment it is provisioned, but a captive portal is something
-- an operator builds. Until they do, `pickPortal` (apps/api/src/internal/portal.ts) finds nothing
-- for that site and portal type and the guest on a freshly adopted access point gets the generic
-- error page. Bring-up therefore requires building a site, a portal and a policy before anyone
-- can confirm the radio even works.
--
-- The fix is one boolean. When resolution finds no portal, the resolver creates and publishes a
-- click-through-only portal for that (site, portal_type), flagged here, and serves it. One
-- Connect button, no identity, enough to prove the path end to end.
--
-- WHY A FLAG AND NOT A CONVENTION. The row could have been recognised by a reserved name or
-- `network_ref`, which needs no migration. A boolean is worth the migration for two reasons that
-- both outlive bring-up:
--
--   1. `pickPortal` must not count a default as a candidate. It resolves "the only unpinned
--      portal for this site and type" and fails closed on ambiguity, so without a column to
--      exclude, the mere existence of a default would make every real portal ambiguous and take
--      a working site offline. That is a correctness requirement, not a convenience.
--   2. A click-through portal gives network access with NO identity, so nothing a guest does is
--      attributable. For bringing up an access point that is the right trade. The danger is that
--      this state is indistinguishable from a deliberately configured open portal, so an access
--      point nobody got round to assigning can serve real customers on an anonymous portal for
--      months. An operator has to be able to SEE it, and answer "which of my portals are
--      fallbacks" with a query rather than by inspecting names. A convention cannot be indexed
--      or badged honestly; a column can.
--
-- The flag is deliberately NOT settable through the admin API: `PortalCreate` and `PortalUpdate`
-- do not carry it. An operator cannot mint a fallback by hand, and cannot quietly convert their
-- real portal into one. The resolver is the only writer, which is also what makes "it is always
-- published" structural rather than a step someone remembers.

SET LOCAL lock_timeout = '5s';

ALTER TABLE captive_portals
  ADD COLUMN is_platform_default boolean NOT NULL DEFAULT false;

-- At most one fallback per site and portal type. Partial, so it costs nothing for the ordinary
-- rows: a site with four real portals and no fallback has four rows outside this index.
--
-- This index is also the concurrency control. Two guests arriving on two unconfigured access
-- points of the same site at the same moment both try to create the fallback; the second insert
-- conflicts here and the resolver re-reads instead of inserting a duplicate. Without it the
-- site would end up with two defaults and `pickPortal`'s ambiguity rule would reject both.
CREATE UNIQUE INDEX uq_captive_portals_platform_default
  ON captive_portals (site_id, portal_type)
  WHERE is_platform_default;

CREATE INDEX idx_captive_portals_platform_default
  ON captive_portals (organization_id)
  WHERE is_platform_default;

COMMENT ON COLUMN captive_portals.is_platform_default IS
  'True for a portal the platform created because the site had none: click-through only, published at creation, visibly temporary. Excluded from pickPortal candidate resolution and not settable through the admin API; the portal resolver is its only writer.';
