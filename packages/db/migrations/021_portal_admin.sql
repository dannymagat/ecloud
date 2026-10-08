-- ECLOUD migration 021: captive-portal administration (Phase 6 cycle P6-B).
-- Additive only: two tenant tables (portal_assets, portal_terms_versions) and one unique index on
-- captive_portals so terms versions can carry a same-tenant composite foreign key.
--
-- portal_assets: metadata of branding objects kept in @ecloud/storage (D-026). The bytes live in
--   object storage under `org/{organization_id}/{purpose}/{id}`; the CHECK below pins the key to
--   exactly that prefix so a row can never point into another tenant's prefix (MULTITENANCY G1).
-- portal_terms_versions: immutable, versioned click-through / terms text per captive portal
--   (INSERT + SELECT only for ecloud_app; a portal's current version is captive_portals.terms_version).
SET LOCAL lock_timeout = '5s';

CREATE TABLE portal_assets (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid NOT NULL,
  purpose           text NOT NULL DEFAULT 'branding',
  storage_key       text NOT NULL,
  content_type      text NOT NULL,
  byte_size         integer NOT NULL,
  sha256            text NOT NULL,
  original_filename text,
  created_by        uuid,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_portal_assets_organization_id FOREIGN KEY (organization_id)
    REFERENCES organizations (id) ON DELETE CASCADE,
  CONSTRAINT ck_portal_assets_purpose CHECK (purpose IN ('branding')),
  CONSTRAINT ck_portal_assets_content_type CHECK (content_type IN ('image/png', 'image/jpeg', 'image/webp')),
  CONSTRAINT ck_portal_assets_byte_size CHECK (byte_size BETWEEN 1 AND 5242880),
  CONSTRAINT ck_portal_assets_sha256 CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT ck_portal_assets_storage_key CHECK (
    storage_key = 'org/' || organization_id::text || '/' || purpose || '/' || id::text
  ),
  CONSTRAINT ck_portal_assets_original_filename CHECK (
    original_filename IS NULL OR length(original_filename) BETWEEN 1 AND 255
  )
);
CREATE UNIQUE INDEX uq_portal_assets_org_id ON portal_assets (organization_id, id);
CREATE INDEX idx_portal_assets_org_created ON portal_assets (organization_id, created_at);

SELECT enable_tenant_rls('portal_assets'::regclass);

CREATE UNIQUE INDEX uq_captive_portals_org_id ON captive_portals (organization_id, id);

CREATE TABLE portal_terms_versions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid NOT NULL,
  captive_portal_id uuid NOT NULL,
  version           integer NOT NULL,
  locale            text NOT NULL DEFAULT 'en',
  body              text NOT NULL,
  created_by        uuid,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_portal_terms_versions_organization_id FOREIGN KEY (organization_id)
    REFERENCES organizations (id) ON DELETE CASCADE,
  CONSTRAINT fk_portal_terms_versions_portal FOREIGN KEY (organization_id, captive_portal_id)
    REFERENCES captive_portals (organization_id, id) ON DELETE CASCADE,
  CONSTRAINT ck_portal_terms_versions_version CHECK (version >= 1),
  CONSTRAINT ck_portal_terms_versions_locale CHECK (locale ~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$'),
  CONSTRAINT ck_portal_terms_versions_body CHECK (length(body) BETWEEN 1 AND 20000)
);
CREATE UNIQUE INDEX uq_portal_terms_versions_portal_version_locale
  ON portal_terms_versions (captive_portal_id, version, locale);
CREATE INDEX idx_portal_terms_versions_org_portal
  ON portal_terms_versions (organization_id, captive_portal_id, version);

SELECT enable_tenant_rls('portal_terms_versions'::regclass);

-- ---------------------------------------------------------------------------------------------
-- Privileges: assets follow the default tenant-table grants (rows are deleted with their object);
-- terms versions are immutable for the application role (a change is a new version).
-- ---------------------------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ecloud_app') THEN
    RAISE NOTICE 'role ecloud_app does not exist: portal administration grants skipped';
    RETURN;
  END IF;
  EXECUTE 'GRANT SELECT, INSERT, DELETE ON TABLE portal_assets TO ecloud_app';
  EXECUTE 'REVOKE UPDATE, TRUNCATE ON TABLE portal_assets FROM ecloud_app';
  EXECUTE 'GRANT SELECT, INSERT ON TABLE portal_terms_versions TO ecloud_app';
  EXECUTE 'REVOKE UPDATE, DELETE, TRUNCATE ON TABLE portal_terms_versions FROM ecloud_app';
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ecloud_radius') THEN
    RETURN;
  END IF;
  EXECUTE 'REVOKE ALL ON TABLE portal_assets, portal_terms_versions FROM ecloud_radius';
END
$$;
