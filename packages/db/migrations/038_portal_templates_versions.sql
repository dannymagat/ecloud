-- 038: captive-portal templates, the full login-method registry, and immutable published
-- versions (CAPTIVE_PORTAL_ONLY_REQUIREMENTS.md §3, §4, §8; gap analysis §3).
--
-- Three changes, all additive, all with defaults that reproduce today's behaviour.
--
-- 1. template_key
--    A template is page composition and starting content; it is NOT an authentication method
--    (§3: "A template must not hardcode a single authentication method"). So this is one text
--    column beside auth_methods, not a replacement for it. Existing rows become
--    'branded_multi_login', the required default template, because that is literally what they
--    are: a branded page offering whichever methods the operator enabled.
--
-- 2. auth_methods CHECK widened
--    Migration 006 allowed five values. The requirement names eleven methods. The CHECK grows to
--    cover them so a portal row can record an enabled method before its adapter ships; what a
--    guest is actually OFFERED is decided at runtime by the method registry in
--    @ecloud/shared/portal-methods, which refuses any method whose provider configuration is
--    absent. A row saying 'sms_otp' with no SMS provider shows the guest nothing and shows the
--    administrator why - that is §5's requirement, and it needs the value to be storable first.
--
--    'idp' from migration 006 is kept and not renamed: it is in production rows and in the OTP
--    design (035). The new values are additions beside it.
--
-- 3. portal_versions + published_version_id
--    Today the portal runtime reads live captive_portals and portal_themes rows, so a guest can
--    land on a half-saved edit and a rollback means reversing fields by hand (gap analysis §3.1).
--
--    A version row holds the whole resolved public configuration as one jsonb snapshot: theme
--    colours, strings, logo reference, enabled methods and their order, template, terms text and
--    version, registration fields. The runtime reads the snapshot. Publishing is therefore a
--    single UPDATE of published_version_id - atomic by definition, no partial state reachable,
--    and rollback is pointing the same column at an older row. Drafts are untouched, so §8's
--    "rollback without discarding drafts" holds for free.
--
--    Snapshots are immutable: the application role gets INSERT and SELECT only. An in-progress
--    guest journey keeps the version id it started with (the flow record carries it), so a
--    publish mid-journey cannot change the page under a guest's feet.
--
--    The snapshot deliberately contains NO secret: no UAM secret, no provider client secret, no
--    SMTP credential. Those stay in captive_portals.uam_secret_ref and
--    identity_providers.client_secret_ref and are read server-side per request. A snapshot is
--    public configuration and is served to a guest's browser.

SET LOCAL lock_timeout = '5s';

-- --------------------------------------------------------------------------------------------
-- 1 + 2: template and the widened method registry
-- --------------------------------------------------------------------------------------------

ALTER TABLE captive_portals
  ADD COLUMN template_key text NOT NULL DEFAULT 'branded_multi_login',
  -- Display order of the enabled methods (§4.6, §7). Entries not in auth_methods are ignored;
  -- enabled methods missing from the order fall to the end in registry order, so an operator who
  -- never touches ordering still gets a sensible page.
  ADD COLUMN method_order text[] NOT NULL DEFAULT '{}',
  -- Which SSIDs this portal serves, for the §8 resolution chain. Empty = every SSID at the site
  -- (today's behaviour). Matched case-insensitively against the gateway-reported SSID.
  ADD COLUMN ssids text[] NOT NULL DEFAULT '{}',
  -- Registration form definition (§7): an array of @ecloud/shared RegistrationField. Draft state;
  -- the published copy is inside the snapshot. Field semantics and the marketing-consent rule
  -- (§13: never preselected, never required for basic access) are enforced by the API schema,
  -- not here, because they are about meaning rather than shape.
  ADD COLUMN registration_fields jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Languages the guest may choose (§7, §12). The first entry is the default. Empty = English
  -- only, which is what every existing portal offers today.
  ADD COLUMN locales text[] NOT NULL DEFAULT '{}';

-- Per-element length cannot be asserted inline: a CHECK constraint may not contain a subquery,
-- and iterating an array needs one. It goes in a function instead, which a CHECK may call.
-- plpgsql rather than SQL so the planner cannot inline the body back into the constraint and
-- reintroduce the subquery.
CREATE OR REPLACE FUNCTION portal_ssids_valid(p_ssids text[]) RETURNS boolean
  LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE
  AS $$
  DECLARE s text;
  BEGIN
    IF cardinality(p_ssids) > 32 THEN RETURN false; END IF;
    FOREACH s IN ARRAY p_ssids LOOP
      IF s IS NULL OR length(s) NOT BETWEEN 1 AND 32 THEN RETURN false; END IF;
    END LOOP;
    RETURN true;
  END
  $$;

COMMENT ON FUNCTION portal_ssids_valid(text[]) IS
  'captive_portals.ssids shape check: at most 32 entries, each 1-32 characters, none NULL. A function because a CHECK constraint may not contain the subquery that iterating an array requires.';

ALTER TABLE captive_portals
  ADD CONSTRAINT ck_captive_portals_template_key CHECK (
    template_key IN (
      'quick_connect',
      'verified_guest',
      'account_access',
      'voucher_paid',
      'hotel_resident',
      'branded_multi_login'
    )
  ),
  ADD CONSTRAINT ck_captive_portals_ssids CHECK (portal_ssids_valid(ssids));

ALTER TABLE captive_portals DROP CONSTRAINT ck_captive_portals_auth_methods;
ALTER TABLE captive_portals
  ADD CONSTRAINT ck_captive_portals_auth_methods CHECK (
    auth_methods <@ ARRAY[
      'password',          -- 006: subscriber username + password
      'mac',               -- 006: device recognition, AAA-side
      'voucher',           -- 006: voucher code
      'idp',               -- 006 + 035: an identity_providers row (email OTP today)
      'click_through',     -- 006: accept terms
      'email_otp',         -- code to a mailbox
      'sms_otp',           -- code to a phone number
      'registration',      -- form, optionally with a separate verification
      'social',            -- OAuth/OIDC consumer provider
      'sso',               -- enterprise OIDC/SAML
      'sponsor',           -- employee approves a visitor
      'hotel',             -- room + surname or booking code against a trusted source
      'paid'               -- plan selection and payment
    ]::text[]
  ),
  -- method_order may only name methods that exist in the registry; it need not be complete.
  ADD CONSTRAINT ck_captive_portals_method_order CHECK (
    method_order <@ ARRAY[
      'password', 'mac', 'voucher', 'idp', 'click_through', 'email_otp', 'sms_otp',
      'registration', 'social', 'sso', 'sponsor', 'hotel', 'paid'
    ]::text[]
  );

COMMENT ON COLUMN captive_portals.template_key IS
  'Page composition and starting content (§4). Independent of auth_methods: any template may offer any configured method.';
COMMENT ON COLUMN captive_portals.method_order IS
  'Display order of enabled methods. Unlisted enabled methods follow in registry order.';
COMMENT ON COLUMN captive_portals.ssids IS
  'SSIDs this portal serves; empty means every SSID at the site. Part of the §8 resolution chain.';

-- --------------------------------------------------------------------------------------------
-- 3: immutable published versions
-- --------------------------------------------------------------------------------------------

CREATE TABLE portal_versions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid NOT NULL,
  captive_portal_id uuid NOT NULL,
  -- Monotonic per portal; the next version is max+1, taken under the portal's row lock.
  version           integer NOT NULL,
  -- The whole resolved public configuration. Shape: @ecloud/shared PortalSnapshot. No secrets.
  snapshot          jsonb NOT NULL,
  -- Who published it (§8: "version, timestamp and administrator identity"). Kept even if the
  -- administrator is later deleted, so the audit trail survives: no FK, the id is evidence.
  published_by      uuid,
  published_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_portal_versions_organization_id FOREIGN KEY (organization_id)
    REFERENCES organizations (id) ON DELETE CASCADE,
  CONSTRAINT fk_portal_versions_portal FOREIGN KEY (organization_id, captive_portal_id)
    REFERENCES captive_portals (organization_id, id) ON DELETE CASCADE,
  CONSTRAINT ck_portal_versions_version CHECK (version >= 1),
  -- A snapshot is served to guests; cap it so a runaway terms document cannot become the page.
  CONSTRAINT ck_portal_versions_snapshot_size CHECK (pg_column_size(snapshot) <= 262144)
);
CREATE UNIQUE INDEX uq_portal_versions_portal_version
  ON portal_versions (captive_portal_id, version);
CREATE UNIQUE INDEX uq_portal_versions_org_id ON portal_versions (organization_id, id);
CREATE INDEX idx_portal_versions_org_published
  ON portal_versions (organization_id, published_at DESC);

SELECT enable_tenant_rls('portal_versions'::regclass);

-- The pointer. NULL = never published: the portal serves nothing to guests and the administrator
-- sees "draft, not published". That is the safe default for a portal created but not finished,
-- and §16's "do not silently publish incomplete templates".
--
-- Existing portals are published automatically in the backfill below, because they are live and
-- serving guests today; a migration must not take them offline.
ALTER TABLE captive_portals ADD COLUMN published_version_id uuid;
ALTER TABLE captive_portals
  ADD CONSTRAINT fk_captive_portals_published_version
    FOREIGN KEY (organization_id, published_version_id)
    REFERENCES portal_versions (organization_id, id) ON DELETE SET NULL;

COMMENT ON COLUMN captive_portals.published_version_id IS
  'The immutable snapshot guests are served. NULL = draft only, never published. Publishing and rollback are an UPDATE of this column, which is why both are atomic.';

-- --------------------------------------------------------------------------------------------
-- Backfill: publish version 1 of every existing portal so no live portal goes dark.
--
-- The snapshot is built from the live rows exactly as the runtime reads them today, so the first
-- published version is behaviourally identical to the pre-migration behaviour. Theme strings are
-- copied verbatim; defaults are applied by the application (resolvePortalColors /
-- resolvePortalStrings), not frozen here, so a later default change still reaches old snapshots.
-- --------------------------------------------------------------------------------------------

WITH snapshots AS (
  INSERT INTO portal_versions (organization_id, captive_portal_id, version, snapshot, published_by)
  SELECT
    p.organization_id,
    p.id,
    1,
    jsonb_build_object(
      'template_key', p.template_key,
      'name', p.name,
      'methods', to_jsonb(p.auth_methods),
      'method_order', to_jsonb(p.method_order),
      'identity_provider_ids', to_jsonb(p.identity_provider_ids),
      'redirect_url', p.redirect_url,
      'terms_version', p.terms_version,
      'theme', CASE WHEN t.id IS NULL THEN 'null'::jsonb ELSE jsonb_build_object(
        'colors', t.colors,
        'strings', t.strings,
        'logo_asset_id', t.logo_asset_ref,
        'custom_css', t.custom_css
      ) END,
      'locales', CASE WHEN cardinality(p.locales) = 0
                      THEN jsonb_build_array('en') ELSE to_jsonb(p.locales) END,
      'default_locale', COALESCE(p.locales[1], 'en'),
      'registration_fields', p.registration_fields
    ),
    NULL
  FROM captive_portals p
  LEFT JOIN portal_themes t ON t.id = p.theme_id AND t.organization_id = p.organization_id
  RETURNING id, captive_portal_id
)
UPDATE captive_portals p
   SET published_version_id = s.id
  FROM snapshots s
 WHERE s.captive_portal_id = p.id;

-- --------------------------------------------------------------------------------------------
-- Privileges: snapshots are append-only for the application role (a change is a new version,
-- same rule migration 021 applies to terms versions). DELETE is allowed so a deleted portal's
-- versions can be cleaned up; the FK cascade needs it.
-- --------------------------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ecloud_app') THEN
    RAISE NOTICE 'role ecloud_app does not exist: portal version grants skipped';
    RETURN;
  END IF;
  EXECUTE 'GRANT SELECT, INSERT, DELETE ON TABLE portal_versions TO ecloud_app';
  EXECUTE 'REVOKE UPDATE, TRUNCATE ON TABLE portal_versions FROM ecloud_app';
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ecloud_radius') THEN
    RETURN;
  END IF;
  EXECUTE 'REVOKE ALL ON TABLE portal_versions FROM ecloud_radius';
END
$$;
