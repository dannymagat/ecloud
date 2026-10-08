-- ECLOUD migration 015: every NAS records its engine adapter (DECISIONS.md D-035).
-- `adapter_types` is reconciled to the @ecloud/adapters keys (POLICY_ENGINE.md, D-012):
--   openwifi-hostapd-radius, openwifi-uspot-uam, uspot-upstream-uam, coovachilli-uam,
--   openwifi-config.
-- 011 is never edited (applied checksums are immutable): this migration widens the key CHECK,
-- inserts the engine keys and adds `nas_clients.adapter_key` (FK + CHECK to the four NAS-facing
-- engine adapters; `openwifi-config` configures SSIDs through the EZE controller and is never a
-- RADIUS client).
--
-- Backfill of existing NAS rows (only mappings the Phase 3 AAA path already used):
--   coovachilli -> coovachilli-uam, uspot -> uspot-upstream-uam.
-- `openwifi_ucentral` (hostapd-RADIUS vs TIP uspot is ambiguous) and `generic_radius` (no
-- adapter) stay NULL: such a NAS keeps answering with Auth-Type + Class only and no Disconnect
-- until an operator sets `adapter_key` (the API requires it on create). Capability flags of the
-- new rows stay NULL / 'unknown' (D-028, D-034): evidence lives in packages/adapters.
-- Legacy keys that no row references any more are removed so a fresh database holds exactly the
-- engine catalogue; still-referenced legacy keys are kept (FK RESTRICT) and reported by the API.
SET LOCAL lock_timeout = '5s';

ALTER TABLE adapter_types DROP CONSTRAINT ck_adapter_types_key;
ALTER TABLE adapter_types ADD CONSTRAINT ck_adapter_types_key
  CHECK (key ~ '^[a-z][a-z0-9_-]{1,63}$');

INSERT INTO adapter_types (key, name, verification_status) VALUES
  ('openwifi-hostapd-radius', 'OpenWiFi hostapd RADIUS (802.1X / MAC auth)', 'unknown'),
  ('openwifi-uspot-uam',      'OpenWiFi TIP uspot captive portal (UAM)',     'unknown'),
  ('uspot-upstream-uam',      'OpenWrt upstream uspot captive portal (UAM)', 'unknown'),
  ('coovachilli-uam',         'CoovaChilli captive portal (UAM)',            'unknown'),
  ('openwifi-config',         'OpenWiFi SSID configuration via EZE controller', 'unknown')
ON CONFLICT (key) DO NOTHING;

ALTER TABLE nas_clients ADD COLUMN adapter_key text NULL;
ALTER TABLE nas_clients ADD CONSTRAINT fk_nas_clients_adapter_key FOREIGN KEY (adapter_key)
  REFERENCES adapter_types (key) ON DELETE RESTRICT;
ALTER TABLE nas_clients ADD CONSTRAINT ck_nas_clients_adapter_key CHECK (
  adapter_key IS NULL OR adapter_key IN (
    'openwifi-hostapd-radius', 'openwifi-uspot-uam', 'uspot-upstream-uam', 'coovachilli-uam'
  )
);

UPDATE nas_clients SET adapter_key = 'coovachilli-uam', adapter_type_key = 'coovachilli-uam'
 WHERE adapter_type_key = 'coovachilli';
UPDATE nas_clients SET adapter_key = 'uspot-upstream-uam', adapter_type_key = 'uspot-upstream-uam'
 WHERE adapter_type_key = 'uspot';
UPDATE network_devices SET adapter_type_key = 'coovachilli-uam' WHERE adapter_type_key = 'coovachilli';
UPDATE network_devices SET adapter_type_key = 'uspot-upstream-uam' WHERE adapter_type_key = 'uspot';

-- From now on the catalogue reference and the engine key agree whenever the engine key is set.
ALTER TABLE nas_clients ADD CONSTRAINT ck_nas_clients_adapter_key_matches_type
  CHECK (adapter_key IS NULL OR adapter_type_key = adapter_key);

DELETE FROM adapter_types t
 WHERE t.key IN ('openwifi_ucentral', 'uspot', 'coovachilli', 'generic_radius')
   AND NOT EXISTS (SELECT 1 FROM nas_clients n WHERE n.adapter_type_key = t.key)
   AND NOT EXISTS (SELECT 1 FROM network_devices d WHERE d.adapter_type_key = t.key);
