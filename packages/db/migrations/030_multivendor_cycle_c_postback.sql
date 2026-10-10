-- ECLOUD migration 030: multi-vendor Cycle C, external captive portal post-back engine
-- (DECISIONS.md D-044; docs/VENDOR_INTEGRATION_RESEARCH.md §2 F3, §3.4;
-- MULTI_VENDOR_INTEGRATION_PLAN.md §14).
--
-- Additive only (expand step; nothing is dropped, retyped or deleted):
--   1. adapter_types gains the engine key `external-portal-postback` and the NAS adapter CHECK is
--      widened to accept it (AP / controller redirects to the ECLOUD portal, the browser posts a
--      single-use portal credential back to the AP / controller, which sends RADIUS).
--   2. nas_clients.adapter_config (jsonb object, default '{}'): per-NAS adapter settings. For the
--      post-back adapter it holds the profile key (cambium-hotspot, aruba-ecp, cisco-webauth,
--      fortinet-ecp, ruckus-wispr, omada-external-portal, huawei-portal, postback-generic), the
--      login-target choice, extra allowed login hosts and, for the generic profile, the redirect
--      parameter names. Validated by the API (`parsePostbackNasConfig`, strict allow-list);
--      the database only guarantees an object of bounded size. Never holds a secret.
--
-- The numbering gap (029) is intentional: 029 belongs to a parallel cycle branch.
SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------------------------
-- 1. Engine adapter key (append-only list)
-- ---------------------------------------------------------------------------------------------
INSERT INTO adapter_types (key, name, verification_status) VALUES
  ('external-portal-postback', 'External captive portal post-back (Cambium, Aruba, Cisco, Fortinet, Ruckus, Omada, Huawei, generic)', 'unknown')
ON CONFLICT (key) DO NOTHING;

-- Rebuilt from the live definition plus the new key, so a key another migration added to the
-- CHECK is kept whichever of 029 / 030 runs first (order-safe, idempotent; the list is
-- append-only). The key pattern also accepts upper case, `_` and `.` so no future key is lost.
DO $$
DECLARE
  current_def text;
  keys text[];
BEGIN
  SELECT pg_get_constraintdef(c.oid) INTO current_def
    FROM pg_constraint c
   WHERE c.conname = 'ck_nas_clients_adapter_key' AND c.conrelid = 'public.nas_clients'::regclass;
  SELECT coalesce(array_agg(DISTINCT m[1]), '{}') INTO keys
    FROM regexp_matches(coalesce(current_def, ''), '''([A-Za-z0-9_.-]+)''', 'g') AS m;
  keys := array(SELECT DISTINCT unnest(keys || ARRAY[
    'openwifi-hostapd-radius', 'openwifi-uspot-uam', 'uspot-upstream-uam', 'coovachilli-uam',
    'generic-radius-8021x', 'external-portal-postback'
  ]) ORDER BY 1);
  ALTER TABLE nas_clients DROP CONSTRAINT IF EXISTS ck_nas_clients_adapter_key;
  EXECUTE format(
    'ALTER TABLE nas_clients ADD CONSTRAINT ck_nas_clients_adapter_key CHECK (adapter_key IS NULL OR adapter_key IN (%s))',
    (SELECT string_agg(quote_literal(k), ', ') FROM unnest(keys) AS k)
  );
END
$$;

-- ---------------------------------------------------------------------------------------------
-- 2. nas_clients.adapter_config
-- ---------------------------------------------------------------------------------------------
ALTER TABLE nas_clients
  ADD COLUMN IF NOT EXISTS adapter_config jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE nas_clients
  ADD CONSTRAINT ck_nas_clients_adapter_config CHECK (
    jsonb_typeof(adapter_config) = 'object' AND octet_length(adapter_config::text) <= 8192
  );

COMMENT ON COLUMN nas_clients.adapter_config IS
  'Migration 030 (Cycle C): per-NAS adapter settings (post-back profile, login hosts, generic parameter names). No secrets.';
