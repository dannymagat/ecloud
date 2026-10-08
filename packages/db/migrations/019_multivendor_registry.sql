-- ECLOUD migration 019: multi-vendor registry mirror + hotspot controllers
-- (MULTI_VENDOR_INTEGRATION_PLAN.md §7, §8.2 "L3 — Data structures"; DECISIONS.md D-028, D-034).
--
-- Additive only: four platform tables that mirror the typed compatibility registry of
-- @ecloud/adapters (written exclusively by `ecloud-db seed`, read-only for ecloud_app, like
-- adapter_types), one tenant table `controllers` (ENABLE + FORCE RLS, policy tenant_isolation)
-- and new nullable / defaulted columns on nas_clients and network_devices. Nothing is dropped,
-- retyped or deleted. The registry rows are NOT inserted here: the typed registry is the single
-- source of truth and `seed` upserts it with a per-entry SHA-256 `registry_hash` check.
--
-- Controller credentials are never stored in clear: `credential_secret_ref` holds an
-- envelope-sealed value (`enc:v1.<iv>.<ct>.<tag>`, purpose ecloud:controller:credential:v1)
-- and no API response returns it. `base_url` is never fetched in M11 (plan OQ-17).
SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------------------------
-- vendors (P) — registry mirror
-- ---------------------------------------------------------------------------------------------
CREATE TABLE vendors (
  key           text PRIMARY KEY,
  name          text NOT NULL,
  lifecycle     text NOT NULL,
  roadmap_phase text NOT NULL,
  doc_links     jsonb NOT NULL DEFAULT '[]'::jsonb,
  notes         text,
  registry_hash text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_vendors_key CHECK (key ~ '^[a-z][a-z0-9-]{1,63}$'),
  CONSTRAINT ck_vendors_lifecycle CHECK (
    lifecycle IN ('planned', 'researched', 'implemented', 'lab-validated', 'production-validated')
  ),
  CONSTRAINT ck_vendors_roadmap_phase CHECK (
    roadmap_phase IN ('pilot', 'phase-a', 'phase-b', 'phase-c', 'legacy-candidate')
  ),
  CONSTRAINT ck_vendors_doc_links CHECK (jsonb_typeof(doc_links) = 'array'),
  CONSTRAINT ck_vendors_registry_hash CHECK (registry_hash ~ '^[0-9a-f]{64}$')
);
CREATE TRIGGER trg_vendors_updated_at BEFORE UPDATE ON vendors
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------------------------
-- hardware_models (P) — only models the registry names (never 'UNKNOWN')
-- ---------------------------------------------------------------------------------------------
CREATE TABLE hardware_models (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_key text NOT NULL,
  model      text NOT NULL,
  notes      text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_hardware_models_vendor_key FOREIGN KEY (vendor_key)
    REFERENCES vendors (key) ON DELETE RESTRICT,
  CONSTRAINT ck_hardware_models_model CHECK (btrim(model) <> '' AND model <> 'UNKNOWN')
);
CREATE UNIQUE INDEX uq_hardware_models_vendor_model ON hardware_models (vendor_key, lower(model));
-- target of the vendor-consistent composite FKs below
CREATE UNIQUE INDEX uq_hardware_models_vendor_id ON hardware_models (vendor_key, id);
CREATE TRIGGER trg_hardware_models_updated_at BEFORE UPDATE ON hardware_models
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------------------------
-- firmware_versions (P) — firmware / software version, optionally per model and controller
-- ---------------------------------------------------------------------------------------------
CREATE TABLE firmware_versions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_key         text NOT NULL,
  hardware_model_id  uuid,
  version            text NOT NULL,
  controller_product text,
  controller_version text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_firmware_versions_vendor_key FOREIGN KEY (vendor_key)
    REFERENCES vendors (key) ON DELETE RESTRICT,
  -- the model must belong to the same vendor
  CONSTRAINT fk_firmware_versions_hardware_model FOREIGN KEY (vendor_key, hardware_model_id)
    REFERENCES hardware_models (vendor_key, id) ON DELETE RESTRICT,
  CONSTRAINT ck_firmware_versions_version CHECK (btrim(version) <> '' AND version <> 'UNKNOWN')
);
CREATE UNIQUE INDEX uq_firmware_versions ON firmware_versions
  (vendor_key, hardware_model_id, lower(version), controller_product, controller_version)
  NULLS NOT DISTINCT;
CREATE UNIQUE INDEX uq_firmware_versions_vendor_id ON firmware_versions (vendor_key, id);
CREATE TRIGGER trg_firmware_versions_updated_at BEFORE UPDATE ON firmware_versions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------------------------
-- compatibility_entries (P) — one row per registry CompatibilityRow; every column needed to
-- rebuild the typed row is stored so `seed` can prove DB == registry by hash.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE compatibility_entries (
  key                           text PRIMARY KEY,
  vendor_key                    text NOT NULL,
  hardware_model_id             uuid,
  firmware_version_id           uuid,
  hardware_model                text NOT NULL,
  firmware                      text NOT NULL,
  controller                    jsonb,
  lifecycle                     text NOT NULL,
  deployment_modes              text[] NOT NULL DEFAULT '{}',
  enforcement_point             text NOT NULL,
  adapter_key                   text,
  source_version_matches_device boolean,
  configuration_kind            text NOT NULL,
  identity                      jsonb NOT NULL DEFAULT '[]'::jsonb,
  profile                       jsonb NOT NULL,
  capabilities                  jsonb NOT NULL,
  open_items                    jsonb NOT NULL DEFAULT '[]'::jsonb,
  registry_hash                 text NOT NULL,
  created_at                    timestamptz NOT NULL DEFAULT now(),
  updated_at                    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_compatibility_entries_vendor_key FOREIGN KEY (vendor_key)
    REFERENCES vendors (key) ON DELETE RESTRICT,
  CONSTRAINT fk_compatibility_entries_hardware_model FOREIGN KEY (vendor_key, hardware_model_id)
    REFERENCES hardware_models (vendor_key, id) ON DELETE RESTRICT,
  CONSTRAINT fk_compatibility_entries_firmware_version FOREIGN KEY (vendor_key, firmware_version_id)
    REFERENCES firmware_versions (vendor_key, id) ON DELETE RESTRICT,
  CONSTRAINT fk_compatibility_entries_adapter_key FOREIGN KEY (adapter_key)
    REFERENCES adapter_types (key) ON DELETE RESTRICT,
  CONSTRAINT ck_compatibility_entries_key CHECK (key ~ '^[a-z0-9][a-z0-9.-]{1,127}$'),
  CONSTRAINT ck_compatibility_entries_lifecycle CHECK (
    lifecycle IN ('planned', 'researched', 'implemented', 'lab-validated', 'production-validated')
  ),
  CONSTRAINT ck_compatibility_entries_deployment_modes CHECK (
    deployment_modes <@ ARRAY['native', 'gateway']::text[]
  ),
  CONSTRAINT ck_compatibility_entries_enforcement_point CHECK (
    enforcement_point IN ('ap', 'controller', 'gateway', 'UNKNOWN')
  ),
  CONSTRAINT ck_compatibility_entries_configuration_kind CHECK (
    configuration_kind IN ('ucentral', 'coova-chilli-conf', 'vendor-ui', 'UNKNOWN')
  ),
  CONSTRAINT ck_compatibility_entries_controller CHECK (
    controller IS NULL OR jsonb_typeof(controller) = 'object'
  ),
  CONSTRAINT ck_compatibility_entries_json CHECK (
    jsonb_typeof(identity) = 'array' AND jsonb_typeof(profile) = 'object'
    AND jsonb_typeof(capabilities) = 'object' AND jsonb_typeof(open_items) = 'array'
  ),
  CONSTRAINT ck_compatibility_entries_registry_hash CHECK (registry_hash ~ '^[0-9a-f]{64}$')
);
CREATE INDEX idx_compatibility_entries_vendor ON compatibility_entries (vendor_key);
CREATE INDEX idx_compatibility_entries_adapter ON compatibility_entries (adapter_key)
  WHERE adapter_key IS NOT NULL;
CREATE TRIGGER trg_compatibility_entries_updated_at BEFORE UPDATE ON compatibility_entries
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------------------------
-- controllers (T) — vendor controllers a tenant registers (cnMaestro, ezecontroller, ...)
-- ---------------------------------------------------------------------------------------------
-- Composite-FK target so a tenant row can only reference a site of its own organization.
CREATE UNIQUE INDEX uq_sites_org_id ON sites (organization_id, id);

CREATE TABLE controllers (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       uuid NOT NULL,
  site_id               uuid,
  vendor_key            text NOT NULL,
  name                  text NOT NULL,
  kind                  text NOT NULL,
  base_url              text NOT NULL,
  credential_secret_ref text,
  status                text NOT NULL DEFAULT 'active',
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  deleted_at            timestamptz,
  CONSTRAINT fk_controllers_organization_id FOREIGN KEY (organization_id)
    REFERENCES organizations (id) ON DELETE CASCADE,
  -- same-organization check for site_id (MATCH SIMPLE: a NULL site_id is an org-wide controller)
  CONSTRAINT fk_controllers_site FOREIGN KEY (organization_id, site_id)
    REFERENCES sites (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_controllers_vendor_key FOREIGN KEY (vendor_key)
    REFERENCES vendors (key) ON DELETE RESTRICT,
  CONSTRAINT ck_controllers_name CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  CONSTRAINT ck_controllers_kind CHECK (kind IN ('cloud', 'on_premises', 'embedded')),
  CONSTRAINT ck_controllers_base_url CHECK (
    base_url ~ '^https://[^/?#@[:space:]]' AND length(base_url) <= 2048 AND strpos(base_url, '#') = 0
  ),
  CONSTRAINT ck_controllers_credential_secret_ref CHECK (
    credential_secret_ref IS NULL OR credential_secret_ref ~ '^enc:v1\.'
  ),
  CONSTRAINT ck_controllers_status CHECK (status IN ('active', 'disabled'))
);
CREATE UNIQUE INDEX uq_controllers_org_id ON controllers (organization_id, id);
CREATE UNIQUE INDEX uq_controllers_org_name ON controllers (organization_id, lower(name))
  WHERE deleted_at IS NULL;
CREATE INDEX idx_controllers_org_site ON controllers (organization_id, site_id);
CREATE TRIGGER trg_controllers_updated_at BEFORE UPDATE ON controllers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

SELECT enable_tenant_rls('controllers'::regclass);

-- ---------------------------------------------------------------------------------------------
-- nas_clients: deployment mode (native AP enforcement vs gateway) + optional controller
-- ---------------------------------------------------------------------------------------------
ALTER TABLE nas_clients ADD COLUMN deployment_mode text NOT NULL DEFAULT 'native';
ALTER TABLE nas_clients ADD CONSTRAINT ck_nas_clients_deployment_mode
  CHECK (deployment_mode IN ('native', 'gateway'));
-- Backfill: CoovaChilli is the gateway engine (plan §5, registry rows coova-chilli-*).
UPDATE nas_clients SET deployment_mode = 'gateway'
 WHERE adapter_key = 'coovachilli-uam' OR adapter_type_key IN ('coovachilli-uam', 'coovachilli');

ALTER TABLE nas_clients ADD COLUMN controller_id uuid;
ALTER TABLE nas_clients ADD CONSTRAINT fk_nas_clients_controller FOREIGN KEY (organization_id, controller_id)
  REFERENCES controllers (organization_id, id) ON DELETE RESTRICT;
CREATE INDEX idx_nas_clients_controller ON nas_clients (controller_id) WHERE controller_id IS NOT NULL;

-- ---------------------------------------------------------------------------------------------
-- network_devices: registry references, controller, managed flag (free-text model/firmware kept)
-- ---------------------------------------------------------------------------------------------
ALTER TABLE network_devices ADD COLUMN hardware_model_id uuid;
ALTER TABLE network_devices ADD CONSTRAINT fk_network_devices_hardware_model_id
  FOREIGN KEY (hardware_model_id) REFERENCES hardware_models (id) ON DELETE RESTRICT;
ALTER TABLE network_devices ADD COLUMN firmware_version_id uuid;
ALTER TABLE network_devices ADD CONSTRAINT fk_network_devices_firmware_version_id
  FOREIGN KEY (firmware_version_id) REFERENCES firmware_versions (id) ON DELETE RESTRICT;
ALTER TABLE network_devices ADD COLUMN controller_id uuid;
ALTER TABLE network_devices ADD CONSTRAINT fk_network_devices_controller FOREIGN KEY (organization_id, controller_id)
  REFERENCES controllers (organization_id, id) ON DELETE RESTRICT;
-- false for third-party APs behind a gateway (ECLOUD does not configure them)
ALTER TABLE network_devices ADD COLUMN managed boolean NOT NULL DEFAULT true;
CREATE INDEX idx_network_devices_controller ON network_devices (controller_id)
  WHERE controller_id IS NOT NULL;

-- ---------------------------------------------------------------------------------------------
-- Privileges: the registry mirror is read-only for the application role (like adapter_types);
-- controllers inherit the default tenant-table grants of migration 010.
-- ---------------------------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ecloud_app') THEN
    RAISE NOTICE 'role ecloud_app does not exist: registry grants skipped';
    RETURN;
  END IF;
  EXECUTE 'GRANT SELECT ON TABLE vendors, hardware_models, firmware_versions, compatibility_entries TO ecloud_app';
  EXECUTE 'REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE vendors, hardware_models, firmware_versions, compatibility_entries FROM ecloud_app';
  EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE controllers TO ecloud_app';
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ecloud_radius') THEN
    RETURN;
  END IF;
  EXECUTE 'REVOKE ALL ON TABLE vendors, hardware_models, firmware_versions, compatibility_entries, controllers FROM ecloud_radius';
END
$$;
