-- ECLOUD migration 011: adapter_types seed (DATABASE_DESIGN.md §3.2, §9 "Seed data").
-- Keys are the four named in DATABASE_DESIGN.md §3.2. Capability flags stay NULL and the
-- verification status is 'unknown' on purpose: nothing is marked verified until the adapters
-- package publishes evidence-backed declarations (D-028, D-034). The permission catalogue and
-- role templates are NOT seeded here; `ecloud-db seed` generates them from @ecloud/shared.
SET LOCAL lock_timeout = '5s';

INSERT INTO adapter_types (key, name, verification_status) VALUES
  ('openwifi_ucentral', 'OpenWiFi / uCentral (hostapd)', 'unknown'),
  ('uspot',             'OpenWrt uspot captive portal',   'unknown'),
  ('coovachilli',       'CoovaChilli',                    'unknown'),
  ('generic_radius',    'Generic RADIUS NAS',             'unknown')
ON CONFLICT (key) DO NOTHING;
