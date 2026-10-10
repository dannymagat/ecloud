-- ECLOUD migration 028: multi-vendor Cycle A foundation (DECISIONS.md D-044;
-- docs/VENDOR_INTEGRATION_RESEARCH.md §3 "contract gaps"; MULTI_VENDOR_INTEGRATION_PLAN.md).
--
-- Additive only (expand step; nothing is dropped, retyped or deleted):
--   1. adapter_types gains the engine key `generic-radius-8021x` and the NAS adapter CHECK is
--      widened to accept it (vendor-neutral 802.1X / MAC-auth NAS, no portal).
--   2. nas_access_points (T): access points behind a NAS, identified by AP MAC. Third-party
--      portals (Cisco, Aruba, Omada, UniFi, Mist, ...) name the AP by MAC in the redirect, and a
--      controller / gateway NAS fronts many APs, so this is a child table of nas_clients rather
--      than a column. The MAC is GLOBALLY unique among live rows: the portal resolves an AP
--      before any tenant is known, so the same MAC registered by two organizations would be
--      ambiguous. The second registration is refused (generic 409, platform release for
--      squatting). A row is a hint next to `nasid`; it serves MAC-only lookups only once
--      verified (`verified_at`).
--   3. vendor_api_credentials (T): one sealed controller-API credential per controller
--      (UniFi Network API key, Omada operator, Mist API token / WLAN secret, Ruckus NBI,
--      Meraki Dashboard key). `secret_ref` is an Envelope-sealed value (`enc:v1.…`, purpose
--      ecloud:vendor-api:secret:v1); no API response returns it; `base_url` is never fetched in
--      Cycle A (plan OQ-17 rules bind any later fetcher). The older opaque
--      controllers.credential_secret_ref stays untouched (contract step later, if ever).
SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------------------------
-- 1. Engine adapter key
-- ---------------------------------------------------------------------------------------------
INSERT INTO adapter_types (key, name, verification_status) VALUES
  ('generic-radius-8021x', 'Generic RADIUS NAS: 802.1X / MAC authentication (any vendor)', 'unknown')
ON CONFLICT (key) DO NOTHING;

ALTER TABLE nas_clients DROP CONSTRAINT ck_nas_clients_adapter_key;
ALTER TABLE nas_clients ADD CONSTRAINT ck_nas_clients_adapter_key CHECK (
  adapter_key IS NULL OR adapter_key IN (
    'openwifi-hostapd-radius', 'openwifi-uspot-uam', 'uspot-upstream-uam', 'coovachilli-uam',
    'generic-radius-8021x'
  )
);

-- ---------------------------------------------------------------------------------------------
-- 2. nas_access_points (T)
-- ---------------------------------------------------------------------------------------------
-- Composite-FK target: an access point always lives in the organization AND site of its NAS
-- (ON UPDATE CASCADE follows a NAS that moves to another site of the same organization).
CREATE UNIQUE INDEX uq_nas_clients_org_site_id ON nas_clients (organization_id, site_id, id);

CREATE TABLE nas_access_points (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  site_id         uuid NOT NULL,
  nas_client_id   uuid NOT NULL,
  mac             macaddr NOT NULL,
  name            text,
  status          text NOT NULL DEFAULT 'active',
  -- Review M1b: MACs are visible over the air and registration is first-come, so a row serves
  -- MAC-only lookups only after the NAS itself proved the AP (authenticated RADIUS packet with
  -- this MAC in Called-Station-Id; later a controller-inventory match). Reset when mac / NAS change.
  verified_at          timestamptz,
  verification_source  text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz,
  CONSTRAINT fk_nas_access_points_organization_id FOREIGN KEY (organization_id)
    REFERENCES organizations (id) ON DELETE CASCADE,
  CONSTRAINT fk_nas_access_points_nas FOREIGN KEY (organization_id, site_id, nas_client_id)
    REFERENCES nas_clients (organization_id, site_id, id) ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT ck_nas_access_points_name CHECK (name IS NULL OR length(btrim(name)) BETWEEN 1 AND 200),
  CONSTRAINT ck_nas_access_points_status CHECK (status IN ('active', 'disabled')),
  CONSTRAINT ck_nas_access_points_verification CHECK (
    (verified_at IS NULL) = (verification_source IS NULL)
    AND (verification_source IS NULL
         OR verification_source IN ('radius-called-station', 'controller-inventory'))
  ),
  -- one individual device: not all-zero, I/G (group) bit of the first octet clear
  -- (macaddr text output is lowercase `aa:bb:cc:dd:ee:ff`; the 2nd hex digit carries bit 0).
  CONSTRAINT ck_nas_access_points_mac_unicast CHECK (
    mac <> '00:00:00:00:00:00'::macaddr
    AND substr(mac::text, 2, 1) IN ('0', '2', '4', '6', '8', 'a', 'c', 'e')
  )
);
-- Global uniqueness of live AP MACs (see header): the portal-side lookup runs before a tenant
-- is known and must never see two candidates.
CREATE UNIQUE INDEX uq_nas_access_points_mac ON nas_access_points (mac) WHERE deleted_at IS NULL;
CREATE INDEX idx_nas_access_points_org_nas ON nas_access_points (organization_id, nas_client_id);
CREATE INDEX idx_nas_access_points_org_site ON nas_access_points (organization_id, site_id);
CREATE TRIGGER trg_nas_access_points_updated_at BEFORE UPDATE ON nas_access_points
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

SELECT enable_tenant_rls('nas_access_points'::regclass);

-- ---------------------------------------------------------------------------------------------
-- 3. vendor_api_credentials (T)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE vendor_api_credentials (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid NOT NULL,
  controller_id     uuid NOT NULL,
  api_kind          text NOT NULL,
  base_url          text NOT NULL,
  username          text,
  secret_ref        text NOT NULL,
  external_org_id   text,
  external_site_id  text,
  rotated_at timestamptz NOT NULL DEFAULT now(),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_vendor_api_credentials_organization_id FOREIGN KEY (organization_id)
    REFERENCES organizations (id) ON DELETE CASCADE,
  -- same-organization controller (uq_controllers_org_id, migration 019)
  CONSTRAINT fk_vendor_api_credentials_controller FOREIGN KEY (organization_id, controller_id)
    REFERENCES controllers (organization_id, id) ON DELETE CASCADE,
  CONSTRAINT ck_vendor_api_credentials_api_kind CHECK (
    api_kind IN ('unifi-network', 'omada-controller', 'mist', 'ruckus-nbi', 'ruckus-one', 'meraki-dashboard')
  ),
  -- same shape rules as controllers.base_url (019 + 020); the API applies the SSRF guard
  CONSTRAINT ck_vendor_api_credentials_base_url CHECK (
    base_url ~ '^https://[^/?#@[:space:]]'
    AND base_url !~ '^https://[^/?#]*@'
    AND strpos(base_url, '#') = 0
    AND length(base_url) <= 2048
  ),
  CONSTRAINT ck_vendor_api_credentials_username CHECK (
    username IS NULL OR length(username) BETWEEN 1 AND 256
  ),
  CONSTRAINT ck_vendor_api_credentials_secret_ref CHECK (secret_ref ~ '^enc:v1\.'),
  CONSTRAINT ck_vendor_api_credentials_external_ids CHECK (
    (external_org_id IS NULL OR external_org_id ~ '^[A-Za-z0-9._:-]{1,128}$')
    AND (external_site_id IS NULL OR external_site_id ~ '^[A-Za-z0-9._:-]{1,128}$')
  )
);
CREATE UNIQUE INDEX uq_vendor_api_credentials_controller ON vendor_api_credentials (controller_id);
CREATE INDEX idx_vendor_api_credentials_org ON vendor_api_credentials (organization_id);
CREATE TRIGGER trg_vendor_api_credentials_updated_at BEFORE UPDATE ON vendor_api_credentials
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

SELECT enable_tenant_rls('vendor_api_credentials'::regclass);

-- ---------------------------------------------------------------------------------------------
-- Privileges (restated explicitly, independent of 010's default privileges)
-- ---------------------------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ecloud_app') THEN
    RAISE NOTICE 'role ecloud_app does not exist: Cycle A grants skipped';
    RETURN;
  END IF;
  EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE nas_access_points, vendor_api_credentials TO ecloud_app';
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ecloud_radius') THEN
    RETURN;
  END IF;
  EXECUTE 'REVOKE ALL ON TABLE nas_access_points, vendor_api_credentials FROM ecloud_radius';
END
$$;
