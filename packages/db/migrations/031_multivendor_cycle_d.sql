-- ECLOUD migration 031: multi-vendor Cycle D (DECISIONS.md D-044; MULTI_VENDOR_INTEGRATION_PLAN.md
-- §14; docs/VENDOR_INTEGRATION_RESEARCH.md §3.6–§3.9).
--
-- Additive only (expand step):
--   1. Engine adapter keys for the controller-API / signed-grant vendors: `unifi-external-portal`,
--      `omada-api`, `mist-guest-portal`. The NAS adapter CHECK is REBUILT AS A UNION of whatever
--      list it has when this migration runs plus these keys, so parallel cycles that widened it in
--      029 / 030 keep their keys whatever the merge order.
--   2. vendor_api_credentials gains non-secret connection settings: a pinned TLS trust anchor
--      (`tls_ca_pem`, a certificate, never a key) or a pinned SHA-256 leaf fingerprint for
--      on-prem self-signed controllers (there is no "insecure" option), per-adapter `settings`
--      (Omada CONTROLLER_ID, Mist portal host / WLAN ids, UniFi site name), and the outcome of the
--      last "Test connection" / inventory run (codes only, no vendor text).
--   3. vendor_api_sessions (T): "API-authorised sessions". UniFi / Omada (API mode) / Mist send
--      NO RADIUS accounting, so these rows are NOT `sessions`: they record what ECLOUD asked the
--      controller to grant (duration, limits, per-field status) and say where usage comes from
--      (`usage_source` = 'unknown' | 'ecloud_side'). There are deliberately no octet / packet
--      columns: ECLOUD does not have that data and must not appear to.
SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------------------------
-- 1. Engine adapter keys
-- ---------------------------------------------------------------------------------------------
INSERT INTO adapter_types (key, name, verification_status) VALUES
  ('unifi-external-portal', 'UniFi Network external portal (controller API authorisation)', 'unknown'),
  ('omada-api', 'Omada Controller external portal (hotspot operator API, no RADIUS)', 'unknown'),
  ('mist-guest-portal', 'Juniper Mist external guest portal (signed authorize URL)', 'unknown')
ON CONFLICT (key) DO NOTHING;

DO $$
DECLARE
  current_def text;
  keys text[];
BEGIN
  SELECT pg_get_constraintdef(oid) INTO current_def
    FROM pg_constraint
   WHERE conname = 'ck_nas_clients_adapter_key' AND conrelid = 'nas_clients'::regclass;
  keys := ARRAY['unifi-external-portal', 'omada-api', 'mist-guest-portal'];
  IF current_def IS NOT NULL THEN
    keys := keys || ARRAY(SELECT (regexp_matches(current_def, '''([a-z0-9-]+)''', 'g'))[1]);
    EXECUTE 'ALTER TABLE nas_clients DROP CONSTRAINT ck_nas_clients_adapter_key';
  END IF;
  SELECT array_agg(DISTINCT k ORDER BY k) INTO keys FROM unnest(keys) AS k;
  EXECUTE format(
    'ALTER TABLE nas_clients ADD CONSTRAINT ck_nas_clients_adapter_key CHECK (adapter_key IS NULL OR adapter_key IN (%s))',
    (SELECT string_agg(quote_literal(k), ', ') FROM unnest(keys) AS k)
  );
END
$$;

-- ---------------------------------------------------------------------------------------------
-- 2. vendor_api_credentials: TLS pinning, per-adapter settings, last test / inventory outcome
-- ---------------------------------------------------------------------------------------------
ALTER TABLE vendor_api_credentials
  ADD COLUMN tls_ca_pem              text,
  ADD COLUMN tls_fingerprint_sha256  text,
  ADD COLUMN settings                jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN last_test_at            timestamptz,
  ADD COLUMN last_test_result        text,
  ADD COLUMN inventory_checked_at    timestamptz,
  ADD COLUMN inventory_result        text,
  ADD COLUMN inventory_matched       integer;

ALTER TABLE vendor_api_credentials
  ADD CONSTRAINT ck_vendor_api_credentials_tls_ca_pem CHECK (
    tls_ca_pem IS NULL OR (
      tls_ca_pem LIKE '-----BEGIN CERTIFICATE-----%'
      AND strpos(tls_ca_pem, 'PRIVATE KEY') = 0
      AND length(tls_ca_pem) <= 16384
    )
  ),
  ADD CONSTRAINT ck_vendor_api_credentials_tls_fingerprint CHECK (
    tls_fingerprint_sha256 IS NULL OR tls_fingerprint_sha256 ~ '^([0-9A-F]{2}:){31}[0-9A-F]{2}$'
  ),
  ADD CONSTRAINT ck_vendor_api_credentials_settings CHECK (
    jsonb_typeof(settings) = 'object' AND length(settings::text) <= 8192
  ),
  -- codes only (VendorApiError codes / 'ok'); never vendor-supplied text
  ADD CONSTRAINT ck_vendor_api_credentials_last_test_result CHECK (
    last_test_result IS NULL OR last_test_result ~ '^[a-z_]{2,40}$'
  ),
  ADD CONSTRAINT ck_vendor_api_credentials_inventory_result CHECK (
    inventory_result IS NULL OR inventory_result ~ '^[a-z_]{2,40}$'
  ),
  ADD CONSTRAINT ck_vendor_api_credentials_inventory_matched CHECK (
    inventory_matched IS NULL OR inventory_matched >= 0
  );

-- ---------------------------------------------------------------------------------------------
-- 2b. nas_access_points: controller-inventory is a CANDIDATE signal only (review F1)
-- ---------------------------------------------------------------------------------------------
-- A tenant controls both its credential and the server behind it, so a controller inventory
-- alone could "prove" a sniffed MAC of another tenant's AP. The inventory job therefore only
-- records that a pinned on-prem controller reported the MAC (`inventory_seen_at`,
-- `inventory_controller_id`); `verified_at` with source 'controller-inventory' is set only by a
-- platform confirmation (POST /api/v1/platform/access-points/confirm-inventory). Both the
-- candidate marker and inventory-sourced verification are reset by the API whenever the
-- controller URL / kind / vendor, its API credential (set, rotate, TLS pin, remove) or the
-- NAS's controller changes.
ALTER TABLE nas_access_points
  ADD COLUMN inventory_seen_at        timestamptz,
  ADD COLUMN inventory_controller_id  uuid;
ALTER TABLE nas_access_points
  ADD CONSTRAINT ck_nas_access_points_inventory_seen CHECK (
    (inventory_seen_at IS NULL) = (inventory_controller_id IS NULL)
  );

-- ---------------------------------------------------------------------------------------------
-- 3. vendor_api_sessions (T)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE vendor_api_sessions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid NOT NULL,
  site_id           uuid NOT NULL,
  nas_client_id     uuid NOT NULL,
  controller_id     uuid NOT NULL,
  adapter_key       text NOT NULL,
  api_kind          text NOT NULL,
  client_mac        macaddr NOT NULL,
  ap_mac            macaddr,
  identity_kind     text NOT NULL,
  user_id           uuid,
  voucher_id        uuid,
  status            text NOT NULL,
  -- Vendor object id of the client (UniFi client id); not secret.
  vendor_client_ref text,
  requested_at      timestamptz NOT NULL DEFAULT now(),
  authorized_at     timestamptz,
  -- ECLOUD's view: authorised_at + granted duration. The device may end it earlier.
  expires_at        timestamptz,
  granted_duration_s integer,
  -- What ECLOUD asked for (API body values) and the per-field D-028 status it reported.
  requested_limits  jsonb NOT NULL DEFAULT '{}'::jsonb,
  field_statuses    jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- No RADIUS accounting in API mode: usage is unknown (or ECLOUD-side when a future poller
  -- fills it). Never 'device'.
  usage_source      text NOT NULL DEFAULT 'unknown',
  accounting        text NOT NULL DEFAULT 'none',
  error_code        text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_vendor_api_sessions_organization_id FOREIGN KEY (organization_id)
    REFERENCES organizations (id) ON DELETE CASCADE,
  CONSTRAINT fk_vendor_api_sessions_nas FOREIGN KEY (organization_id, site_id, nas_client_id)
    REFERENCES nas_clients (organization_id, site_id, id) ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT fk_vendor_api_sessions_controller FOREIGN KEY (organization_id, controller_id)
    REFERENCES controllers (organization_id, id) ON DELETE CASCADE,
  CONSTRAINT ck_vendor_api_sessions_adapter_key CHECK (
    adapter_key IN ('unifi-external-portal', 'omada-api', 'mist-guest-portal')
  ),
  CONSTRAINT ck_vendor_api_sessions_api_kind CHECK (
    api_kind IN ('unifi-network', 'omada-controller', 'mist')
  ),
  CONSTRAINT ck_vendor_api_sessions_identity_kind CHECK (
    identity_kind IN ('user', 'voucher', 'click_through')
  ),
  CONSTRAINT ck_vendor_api_sessions_status CHECK (
    status IN ('pending', 'authorized', 'granted_url_issued', 'failed', 'expired')
  ),
  CONSTRAINT ck_vendor_api_sessions_usage_source CHECK (usage_source IN ('unknown', 'ecloud_side')),
  CONSTRAINT ck_vendor_api_sessions_accounting CHECK (accounting = 'none'),
  CONSTRAINT ck_vendor_api_sessions_error_code CHECK (
    error_code IS NULL OR error_code ~ '^[a-z_]{2,40}$'
  ),
  CONSTRAINT ck_vendor_api_sessions_vendor_client_ref CHECK (
    vendor_client_ref IS NULL OR vendor_client_ref ~ '^[A-Za-z0-9._:-]{1,128}$'
  ),
  CONSTRAINT ck_vendor_api_sessions_duration CHECK (
    granted_duration_s IS NULL OR granted_duration_s > 0
  ),
  CONSTRAINT ck_vendor_api_sessions_json CHECK (
    jsonb_typeof(requested_limits) = 'object' AND jsonb_typeof(field_statuses) = 'array'
  )
);
CREATE INDEX idx_vendor_api_sessions_org_mac ON vendor_api_sessions (organization_id, client_mac, requested_at DESC);
CREATE INDEX idx_vendor_api_sessions_org_site ON vendor_api_sessions (organization_id, site_id, requested_at DESC);
CREATE INDEX idx_vendor_api_sessions_expiry ON vendor_api_sessions (expires_at) WHERE status = 'authorized';
CREATE TRIGGER trg_vendor_api_sessions_updated_at BEFORE UPDATE ON vendor_api_sessions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

SELECT enable_tenant_rls('vendor_api_sessions'::regclass);

-- ---------------------------------------------------------------------------------------------
-- Privileges (restated explicitly)
-- ---------------------------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ecloud_app') THEN
    RAISE NOTICE 'role ecloud_app does not exist: Cycle D grants skipped';
    RETURN;
  END IF;
  EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE vendor_api_sessions TO ecloud_app';
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ecloud_radius') THEN
    RETURN;
  END IF;
  EXECUTE 'REVOKE ALL ON TABLE vendor_api_sessions FROM ecloud_radius';
END
$$;
