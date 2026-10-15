-- 049: registration submissions, terms acceptance, device registration, and theme layout.
-- CAPTIVE_PORTAL_ONLY_REQUIREMENTS.md §5 (Accept Terms, MAC authentication, Registration form),
-- §6 (background and approved fonts), §13 (consent and retention).
--
-- Stage 4 of docs/CAPTIVE_PORTAL_GAP_ANALYSIS.md §4. Stage 3 made the published template reach a
-- guest; this adds the four things the portal must RECORD, and the two theme attributes that had
-- nowhere to live.
--
-- WHY THREE TABLES RATHER THAN ONE EVENT LOG. They have different lifetimes and different
-- privacy weight, and merging them would force the strictest rule on all of them:
--
--   * portal_registrations holds the guest's own personal data (name, email, phone as the
--     operator defined the form). Highest privacy weight, so it is the one that is partitioned
--     and purged on a schedule. 12 months by default (owner's decision, 2026-10-15), per
--     organization, because §13 requires retention to be CONFIGURED rather than assumed.
--   * terms_acceptances is evidence that a specific version was accepted. §5 asks for "terms
--     version, acceptance timestamp": it must OUTLIVE the registration data, because the
--     question it answers ("did this device accept v3?") is asked long after the form data
--     should be gone. Deduplicated per device per version, so it grows with devices rather than
--     with logins.
--   * device_registrations is current configuration, not history. Revocation is a column and not
--     a delete, because §5 asks for a "registration lifecycle, revocation", and a deleted row
--     cannot say that someone revoked it deliberately.

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------------------------
-- Registration submissions (§5 "Registration form", §13)
-- ---------------------------------------------------------------------------------------------
--
-- `fields` holds what the guest typed, against the form the operator defined
-- (`captive_portals.registration_fields`). `consents` is SEPARATE and not merged into `fields`,
-- because §13 requires required access terms to be distinguishable from optional marketing
-- consent — a reader asking "did they agree to marketing?" must not have to know which of an
-- operator's arbitrary field keys happened to be a consent box.
--
-- `portal_version_id` records WHICH published form was shown. Without it a stored submission
-- cannot be read back reliably: the operator may have changed the form since, and a value under
-- the key `field_3` would then be interpreted against a definition the guest never saw.
CREATE SEQUENCE portal_registrations_id_seq AS bigint;
CREATE TABLE portal_registrations (
  id                bigint NOT NULL DEFAULT nextval('portal_registrations_id_seq'),
  organization_id   uuid NOT NULL,
  captive_portal_id uuid NOT NULL,
  portal_version_id uuid,
  nas_client_id     uuid,
  mac               macaddr,
  locale            text NOT NULL DEFAULT 'en',
  fields            jsonb NOT NULL DEFAULT '{}'::jsonb,
  consents          jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at),
  CONSTRAINT ck_portal_registrations_fields CHECK (jsonb_typeof(fields) = 'object'),
  CONSTRAINT ck_portal_registrations_consents CHECK (jsonb_typeof(consents) = 'object')
) PARTITION BY RANGE (created_at);
ALTER SEQUENCE portal_registrations_id_seq OWNED BY portal_registrations.id;
CREATE INDEX brin_portal_registrations_created ON portal_registrations USING brin (created_at);
CREATE INDEX idx_portal_registrations_org_time
  ON portal_registrations (organization_id, created_at);
CREATE INDEX idx_portal_registrations_org_portal
  ON portal_registrations (organization_id, captive_portal_id, created_at);
CREATE TABLE portal_registrations_default PARTITION OF portal_registrations DEFAULT;
-- ORDER MATTERS. `enable_tenant_rls` walks `pg_inherits`, so it protects the partitions that
-- exist WHEN IT RUNS, and `ensure_month_partitions` only protects what it creates if the parent
-- already has RLS. Enabling afterwards — as the first draft of this migration did — leaves the
-- default partition and every monthly partition readable across tenants, which the
-- `relrowsecurity` assertion in packages/db/src/integration.test.ts caught.
SELECT enable_tenant_rls('portal_registrations'::regclass);
SELECT ensure_month_partitions('portal_registrations'::regclass, 2);
-- The helper's policy is USING-only, which does not constrain INSERT. These three tables are all
-- written by the application, so each gets a WITH CHECK as well (the shape `orders` uses in 045).
-- On the parent only: an INSERT routed through a partitioned table is checked against the
-- partitioned table's own policy.
ALTER POLICY tenant_isolation ON portal_registrations
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

-- ---------------------------------------------------------------------------------------------
-- Terms acceptance (§5 "Accept Terms")
-- ---------------------------------------------------------------------------------------------
--
-- One row per device per portal per VERSION. Re-accepting the same version touches `accepted_at`
-- rather than inserting again, so this table is bounded by devices and not by sign-ins; a new
-- version produces a new row, which is what makes "who has accepted v4?" answerable.
--
-- `mac` is nullable and `subscriber_id` is nullable, but at least one must be present: an
-- acceptance attributable to nobody is not evidence of anything.
CREATE TABLE terms_acceptances (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid NOT NULL,
  captive_portal_id uuid NOT NULL,
  terms_version     text NOT NULL,
  mac               macaddr,
  subscriber_id     uuid,
  locale            text NOT NULL DEFAULT 'en',
  accepted_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_terms_acceptances_organization_id FOREIGN KEY (organization_id)
    REFERENCES organizations (id) ON DELETE CASCADE,
  CONSTRAINT fk_terms_acceptances_portal FOREIGN KEY (captive_portal_id)
    REFERENCES captive_portals (id) ON DELETE CASCADE,
  CONSTRAINT ck_terms_acceptances_subject CHECK (mac IS NOT NULL OR subscriber_id IS NOT NULL)
);
-- Two partial uniques rather than one over both columns: NULLs do not conflict in a unique index,
-- so a single index on (portal, version, mac, subscriber_id) would happily store the same
-- device twice whenever one of the two subject columns was null.
CREATE UNIQUE INDEX uq_terms_acceptances_mac
  ON terms_acceptances (captive_portal_id, terms_version, mac)
  WHERE mac IS NOT NULL;
CREATE UNIQUE INDEX uq_terms_acceptances_subscriber
  ON terms_acceptances (captive_portal_id, terms_version, subscriber_id)
  WHERE subscriber_id IS NOT NULL;
CREATE INDEX idx_terms_acceptances_org_time ON terms_acceptances (organization_id, accepted_at);

-- ---------------------------------------------------------------------------------------------
-- Device registration (§5 "MAC authentication")
-- ---------------------------------------------------------------------------------------------
--
-- Both sources, per the owner's decision (2026-10-15): a guest may register the device they are
-- on ("remember this device"), and an administrator may add or revoke one.
--
-- `source` is kept even though `registered_by` implies it: a guest registration has no
-- administrator, so the distinction would otherwise be "registered_by IS NULL", which is also
-- what a deleted administrator looks like after `ON DELETE SET NULL`. One column that says which
-- cannot become ambiguous later.
CREATE TABLE device_registrations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  site_id         uuid,
  mac             macaddr NOT NULL,
  label           text,
  source          text NOT NULL,
  registered_by   uuid,
  subscriber_id   uuid,
  expires_at      timestamptz,
  revoked_at      timestamptz,
  revoked_by      uuid,
  revoke_reason   text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_device_registrations_organization_id FOREIGN KEY (organization_id)
    REFERENCES organizations (id) ON DELETE CASCADE,
  CONSTRAINT fk_device_registrations_site FOREIGN KEY (site_id)
    REFERENCES sites (id) ON DELETE SET NULL,
  CONSTRAINT fk_device_registrations_registered_by FOREIGN KEY (registered_by)
    REFERENCES administrators (id) ON DELETE SET NULL,
  CONSTRAINT fk_device_registrations_revoked_by FOREIGN KEY (revoked_by)
    REFERENCES administrators (id) ON DELETE SET NULL,
  CONSTRAINT ck_device_registrations_source CHECK (source IN ('guest', 'admin')),
  -- Both directions, so a revoked row always says who/why and an active row never claims to.
  CONSTRAINT ck_device_registrations_revocation CHECK (
    (revoked_at IS NULL AND revoked_by IS NULL AND revoke_reason IS NULL)
    OR (revoked_at IS NOT NULL AND revoke_reason IS NOT NULL)
  )
);
-- A MAC can hold at most one ACTIVE registration per organization. Partial, so revoking a device
-- and registering it again later is allowed and keeps the earlier decision on the record.
CREATE UNIQUE INDEX uq_device_registrations_active_mac
  ON device_registrations (organization_id, mac)
  WHERE revoked_at IS NULL;
CREATE INDEX idx_device_registrations_org_site ON device_registrations (organization_id, site_id);
CREATE TRIGGER trg_device_registrations_updated_at BEFORE UPDATE ON device_registrations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------------------------
-- Retention setting (§13 "Configure retention ... to registration, acceptance and session
-- records")
-- ---------------------------------------------------------------------------------------------
--
-- 12 months by default (owner, 2026-10-15). Bounded by a CHECK rather than left open: a value of
-- 0 would mean "purge everything immediately", which is indistinguishable from a misconfiguration
-- and would destroy the operator's data silently, and an unbounded value makes the stated
-- retention a fiction.
ALTER TABLE organizations
  ADD COLUMN registration_retention_months integer NOT NULL DEFAULT 12;
ALTER TABLE organizations
  ADD CONSTRAINT ck_organizations_registration_retention
  CHECK (registration_retention_months BETWEEN 1 AND 120);

-- ---------------------------------------------------------------------------------------------
-- Theme layout: background and approved fonts (§6)
-- ---------------------------------------------------------------------------------------------
--
-- One jsonb rather than two columns, because §6 lists further presentation attributes (overlays,
-- button styling, card layout) that will land here and each would otherwise be a migration.
--
-- The VALUES are constrained in application code, not here, and deliberately: a font is chosen
-- from an allowlist of self-contained stacks (the portal renders with no third-party assets, so
-- a webfont URL is not a thing an operator may supply) and a background is an uploaded asset id,
-- never a URL. A CHECK cannot express "one of the stacks this build ships" without being rewritten
-- by every migration that adds one, so the renderer validates and falls back instead — the same
-- rule `resolvePortalColors` already follows for colours.
ALTER TABLE portal_themes
  ADD COLUMN layout jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE portal_themes
  ADD CONSTRAINT ck_portal_themes_layout CHECK (jsonb_typeof(layout) = 'object');

-- ---------------------------------------------------------------------------------------------
-- Comments
-- ---------------------------------------------------------------------------------------------

COMMENT ON TABLE portal_registrations IS
  'Guest-submitted registration form values (migration 049). Personal data: partitioned monthly and purged per organizations.registration_retention_months (§13).';
COMMENT ON COLUMN portal_registrations.consents IS
  'Consent answers, kept out of `fields` so required terms and optional marketing consent stay distinguishable without knowing the operator''s field keys (§13).';
COMMENT ON COLUMN portal_registrations.portal_version_id IS
  'The published version whose form was shown. Without it a stored value cannot be interpreted after the operator edits the form.';
COMMENT ON TABLE terms_acceptances IS
  'Which device or subscriber accepted which terms version, and when (§5). Outlives registration data: the question is asked after the form values should be gone.';
COMMENT ON TABLE device_registrations IS
  'Registered device MACs (§5). `source` says whether the guest or an administrator registered it; revocation is recorded, never deleted.';
COMMENT ON COLUMN organizations.registration_retention_months IS
  'How long portal_registrations rows are kept. Default 12 (owner, 2026-10-15); §13 requires retention to be configured rather than assumed.';
COMMENT ON COLUMN portal_themes.layout IS
  'Presentation attributes beyond colours and strings (§6): font stack key, background asset id, overlay. Values validated by the renderer, which falls back like resolvePortalColors.';

-- The two non-partitioned tables, through the same helper so the policy name and shape match
-- every other tenant table, plus the WITH CHECK the helper omits.
SELECT enable_tenant_rls('terms_acceptances'::regclass);
ALTER POLICY tenant_isolation ON terms_acceptances
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

SELECT enable_tenant_rls('device_registrations'::regclass);
ALTER POLICY tenant_isolation ON device_registrations
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

GRANT SELECT, INSERT ON portal_registrations TO ecloud_app;
GRANT SELECT, INSERT, UPDATE ON terms_acceptances TO ecloud_app;
GRANT SELECT, INSERT, UPDATE ON device_registrations TO ecloud_app;
