-- ECLOUD migration 029: multi-vendor Cycle B -- MikroTik RouterOS Hotspot + Teltonika RutOS
-- (DECISIONS.md D-044; docs/VENDOR_INTEGRATION_RESEARCH.md §3.2, §3.3; MULTI_VENDOR_INTEGRATION_PLAN.md §14).
--
-- Additive only (expand step; nothing is dropped, retyped or deleted) and idempotent (safe to
-- re-run; every step checks the live catalogue):
--   1. adapter_types gains the engine key `mikrotik-hotspot`; the NAS adapter CHECK is REBUILT
--      FROM ITS LIVE DEFINITION plus this key (keys added by other migrations, e.g. 030 on
--      another branch, are preserved whatever the merge order). Teltonika RutOS needs no key:
--      it runs on the existing `coovachilli-uam` adapter (registry row + setup guide only).
--   2. captive_portals.portal_type accepts `mikrotik` (portal entry `/hotspot/mikrotik/`), same
--      live-definition rebuild.
--   3. nas_clients.device_test_attributes (default false): lab opt-in per NAS. When true the AAA
--      layer also emits REQUIRES_DEVICE_TEST reply attributes (marked `experimental` in
--      policy_translations.emitted), so a device test (D-028 / D-034) can observe them. It never
--      changes a declared status: nothing becomes VERIFIED by this flag. Setting it needs the
--      platform permission `platform:adapter:manage` (API) and is audited `nas:lab_mode_changed`.
--   4. nas_clients.hotspot_address / hotspot_port (review F1): the NAS's own browser login address
--      (MikroTik: the HotSpot interface IP behind `$(link-login-only)`). A redirect whose login
--      target is any other host/port is refused, so the portal never posts a credential or CHAP
--      response to a host an attacker named. Unicast private IPv4 (RFC 1918 / RFC 6598) only;
--      REQUIRED for `mikrotik-hotspot`; generic enough for the post-back family (Cycle C).
SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------------------------
-- 1 + 2. Engine adapter key, captive portal type (CHECKs rebuilt from the live definition)
-- ---------------------------------------------------------------------------------------------
INSERT INTO adapter_types (key, name, verification_status) VALUES
  ('mikrotik-hotspot', 'MikroTik RouterOS Hotspot (ECLOUD external login page)', 'unknown')
ON CONFLICT (key) DO NOTHING;

DO $$
DECLARE
  spec record;
  def text;
  merged text[];
BEGIN
  -- (table, constraint, column, nullable column?, keys this migration adds)
  FOR spec IN
    SELECT * FROM (VALUES
      ('nas_clients', 'ck_nas_clients_adapter_key', 'adapter_key', true,
       ARRAY['mikrotik-hotspot']),
      ('captive_portals', 'ck_captive_portals_portal_type', 'portal_type', false,
       ARRAY['mikrotik'])
    ) AS t(tbl, con, col, nullable, added)
  LOOP
    SELECT pg_get_constraintdef(c.oid) INTO def
      FROM pg_constraint c
     WHERE c.conname = spec.con AND c.conrelid = to_regclass(spec.tbl);
    -- Quoted literals of the live CHECK (letters, digits, '_' and '-'), plus the new keys.
    SELECT array_agg(DISTINCT k ORDER BY k) INTO merged
      FROM (
        SELECT m[1] AS k
          FROM regexp_matches(coalesce(def, ''), '''([A-Za-z0-9_-]+)''', 'g') AS m
        UNION
        SELECT unnest(spec.added)
      ) keys;
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT IF EXISTS %I', spec.tbl, spec.con);
    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %I CHECK (%s%I IN (%s))',
      spec.tbl,
      spec.con,
      CASE WHEN spec.nullable THEN format('%I IS NULL OR ', spec.col) ELSE '' END,
      spec.col,
      (SELECT string_agg(quote_literal(k), ', ' ORDER BY k) FROM unnest(merged) AS k)
    );
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------------------------
-- 3. Lab opt-in: emit REQUIRES_DEVICE_TEST attributes for this NAS
-- ---------------------------------------------------------------------------------------------
ALTER TABLE nas_clients
  ADD COLUMN IF NOT EXISTS device_test_attributes boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN nas_clients.device_test_attributes IS
  'Lab opt-in (Cycle B, D-028/D-034): also emit REQUIRES_DEVICE_TEST reply attributes (experimental). Never marks anything VERIFIED. Platform permission platform:adapter:manage.';

-- ---------------------------------------------------------------------------------------------
-- 4. Browser login address of the NAS (review F1)
-- ---------------------------------------------------------------------------------------------
ALTER TABLE nas_clients
  ADD COLUMN IF NOT EXISTS hotspot_address inet NULL,
  ADD COLUMN IF NOT EXISTS hotspot_port integer NULL;

ALTER TABLE nas_clients DROP CONSTRAINT IF EXISTS ck_nas_clients_hotspot_address;
ALTER TABLE nas_clients ADD CONSTRAINT ck_nas_clients_hotspot_address CHECK (
  hotspot_address IS NULL OR (
    family(hotspot_address) = 4 AND masklen(hotspot_address) = 32 AND (
      hotspot_address << inet '10.0.0.0/8' OR hotspot_address << inet '172.16.0.0/12' OR
      hotspot_address << inet '192.168.0.0/16' OR hotspot_address << inet '100.64.0.0/10'
    )
  )
);
ALTER TABLE nas_clients DROP CONSTRAINT IF EXISTS ck_nas_clients_hotspot_port;
ALTER TABLE nas_clients ADD CONSTRAINT ck_nas_clients_hotspot_port CHECK (
  hotspot_port IS NULL OR (hotspot_port BETWEEN 1 AND 65535 AND hotspot_address IS NOT NULL)
);
-- A live MikroTik NAS without a login address could never complete a portal login (the portal
-- fails closed anyway); refuse such a row. No mikrotik-hotspot rows exist before this migration.
ALTER TABLE nas_clients DROP CONSTRAINT IF EXISTS ck_nas_clients_mikrotik_hotspot_address;
ALTER TABLE nas_clients ADD CONSTRAINT ck_nas_clients_mikrotik_hotspot_address CHECK (
  adapter_key IS DISTINCT FROM 'mikrotik-hotspot' OR deleted_at IS NOT NULL
  OR hotspot_address IS NOT NULL
);

COMMENT ON COLUMN nas_clients.hotspot_address IS
  'Browser login address of the NAS (MikroTik HotSpot interface IP); the only accepted host of $(link-login-only). Private unicast IPv4.';
