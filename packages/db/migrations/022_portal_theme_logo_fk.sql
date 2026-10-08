-- ECLOUD migration 022: same-tenant foreign key from portal_themes.logo_asset_ref to portal_assets
-- (P6-B review finding 3). Closes the race between "delete asset" and "assign it as a logo": the
-- API checks references first, the FK makes a concurrent assignment or deletion fail instead of
-- leaving a dangling logo, and the composite key forbids pointing at another tenant's asset.
--
-- logo_asset_ref was free text (006); it now holds a portal_assets.id, so the column becomes uuid.
-- Values that cannot reference an asset of the same organization (not a uuid, or no such asset)
-- are cleared first: they could never resolve to a logo, so no usable data is lost.
SET LOCAL lock_timeout = '5s';

UPDATE portal_themes t
   SET logo_asset_ref = NULL
 WHERE logo_asset_ref IS NOT NULL
   AND (
     logo_asset_ref !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
     OR NOT EXISTS (
       SELECT 1 FROM portal_assets a
        WHERE a.organization_id = t.organization_id AND a.id::text = lower(t.logo_asset_ref)
     )
   );

ALTER TABLE portal_themes
  ALTER COLUMN logo_asset_ref TYPE uuid USING logo_asset_ref::uuid;

ALTER TABLE portal_themes ADD CONSTRAINT fk_portal_themes_logo_asset
  FOREIGN KEY (organization_id, logo_asset_ref)
  REFERENCES portal_assets (organization_id, id) ON DELETE RESTRICT;

CREATE INDEX idx_portal_themes_logo_asset ON portal_themes (organization_id, logo_asset_ref)
  WHERE logo_asset_ref IS NOT NULL;
