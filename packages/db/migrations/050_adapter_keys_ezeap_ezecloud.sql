-- 050: rename two engine adapter keys to the EzeLink product names (owner ruling 2026-10-16,
-- "B full rename"; DECISIONS D-077).
--
--   openwifi-uspot-uam  ->  ezeap-uam           (EZEAP access points, TIP uspot captive portal)
--   coovachilli-uam     ->  ezecloud-uam        (EZEGW gateways, CoovaChilli-based)
--
-- The adapter key is an identity, not a label: it is the PRIMARY KEY of `adapter_types`, the
-- target of four FOREIGN KEYs, enumerated by the `ck_nas_clients_adapter_key` CHECK, and copied
-- into other tables (`accounting_anomalies.adapter_key`, `vendor_api_sessions.adapter_key`,
-- and the append-only `policy_translations.adapter_type_key`). Renaming the PK in place is
-- impossible while rows point at it, so the migration inserts the new rows, repoints every reference, rebuilds the CHECK, and
-- only then deletes the old rows; the append-only `policy_translations` log is left as history.
-- Everything runs in the one transaction the runner opens.
--
-- Idempotent: a re-run on a migrated database is a no-op (every statement is conditional or
-- affects zero rows). The CHECK rebuild follows 030/031/032: read the current definition, swap
-- the two names, re-create; any other key already allowed stays allowed.
--
-- Deployment coupling: the code at this migration's commit knows only the NEW keys (plus a read
-- alias for the old spellings on inbound API/config values). Apply 050 and roll the api, worker
-- and portal images together; the old images refuse the new keys.

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------------------------
-- 1. New adapter_types rows (copy of the old rows under the new key; old rows stay until step 4)
-- ---------------------------------------------------------------------------------------------
INSERT INTO adapter_types
  (key, name, supports_coa, supports_rate_limit, supports_vlan, capabilities, verification_status,
   evidence_url, created_at, updated_at)
SELECT 'ezeap-uam', 'EZEAP captive portal (TIP uspot, UAM)', supports_coa, supports_rate_limit,
       supports_vlan, capabilities, verification_status, evidence_url, created_at, now()
  FROM adapter_types WHERE key = 'openwifi-uspot-uam'
ON CONFLICT (key) DO NOTHING;

INSERT INTO adapter_types
  (key, name, supports_coa, supports_rate_limit, supports_vlan, capabilities, verification_status,
   evidence_url, created_at, updated_at)
SELECT 'ezecloud-uam', 'EZEGW EZECLOUD gateway captive portal (UAM)', supports_coa,
       supports_rate_limit, supports_vlan, capabilities, verification_status, evidence_url,
       created_at, now()
  FROM adapter_types WHERE key = 'coovachilli-uam'
ON CONFLICT (key) DO NOTHING;

-- A fresh database that never ran the old seed still needs both rows.
INSERT INTO adapter_types (key, name, verification_status) VALUES
  ('ezeap-uam', 'EZEAP captive portal (TIP uspot, UAM)', 'unknown'),
  ('ezecloud-uam',    'EZEGW EZECLOUD gateway captive portal (UAM)', 'unknown')
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------------------------------
-- 2. Widen the nas_clients CHECK so the repoint in step 3 is allowed (old + new keys)
-- ---------------------------------------------------------------------------------------------
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
  keys := array(SELECT DISTINCT unnest(keys || ARRAY['ezeap-uam', 'ezecloud-uam']) ORDER BY 1);
  ALTER TABLE nas_clients DROP CONSTRAINT IF EXISTS ck_nas_clients_adapter_key;
  EXECUTE format(
    'ALTER TABLE nas_clients ADD CONSTRAINT ck_nas_clients_adapter_key CHECK (adapter_key IS NULL OR adapter_key IN (%s))',
    (SELECT string_agg(quote_literal(k), ', ') FROM unnest(keys) AS k)
  );
END
$$;

-- ---------------------------------------------------------------------------------------------
-- 3. Repoint every reference. nas_clients carries the key twice and
--    `ck_nas_clients_adapter_key_matches_type` requires them equal, so both move in one UPDATE.
-- ---------------------------------------------------------------------------------------------
UPDATE nas_clients
   SET adapter_key      = CASE adapter_key      WHEN 'openwifi-uspot-uam' THEN 'ezeap-uam'
                                                 WHEN 'coovachilli-uam'    THEN 'ezecloud-uam'
                                                 ELSE adapter_key END,
       adapter_type_key = CASE adapter_type_key WHEN 'openwifi-uspot-uam' THEN 'ezeap-uam'
                                                 WHEN 'coovachilli-uam'    THEN 'ezecloud-uam'
                                                 ELSE adapter_type_key END
 WHERE adapter_key IN ('openwifi-uspot-uam', 'coovachilli-uam')
    OR adapter_type_key IN ('openwifi-uspot-uam', 'coovachilli-uam');

UPDATE network_devices
   SET adapter_type_key = CASE adapter_type_key WHEN 'openwifi-uspot-uam' THEN 'ezeap-uam'
                                                 ELSE 'ezecloud-uam' END
 WHERE adapter_type_key IN ('openwifi-uspot-uam', 'coovachilli-uam');

UPDATE compatibility_entries
   SET adapter_key = CASE adapter_key WHEN 'openwifi-uspot-uam' THEN 'ezeap-uam'
                                      ELSE 'ezecloud-uam' END
 WHERE adapter_key IN ('openwifi-uspot-uam', 'coovachilli-uam');

-- History tables (no FK, text copies). `policy_translations` is append-only (010, forbid_mutation)
-- and records which adapter translated a policy at the time: it keeps the old spelling as
-- history, and nothing resolves an adapter from it. The two mutable copies below are rewritten
-- so filters use one spelling.
UPDATE accounting_anomalies
   SET adapter_key = CASE adapter_key WHEN 'openwifi-uspot-uam' THEN 'ezeap-uam'
                                      ELSE 'ezecloud-uam' END
 WHERE adapter_key IN ('openwifi-uspot-uam', 'coovachilli-uam');

UPDATE vendor_api_sessions
   SET adapter_key = CASE adapter_key WHEN 'openwifi-uspot-uam' THEN 'ezeap-uam'
                                      ELSE 'ezecloud-uam' END
 WHERE adapter_key IN ('openwifi-uspot-uam', 'coovachilli-uam');

-- ---------------------------------------------------------------------------------------------
-- 4. Retire the old keys: CHECK without them, then the rows (every FK now points elsewhere)
-- ---------------------------------------------------------------------------------------------
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
  keys := array(
    SELECT DISTINCT k FROM unnest(keys) AS k
     WHERE k NOT IN ('openwifi-uspot-uam', 'coovachilli-uam') ORDER BY 1
  );
  ALTER TABLE nas_clients DROP CONSTRAINT IF EXISTS ck_nas_clients_adapter_key;
  EXECUTE format(
    'ALTER TABLE nas_clients ADD CONSTRAINT ck_nas_clients_adapter_key CHECK (adapter_key IS NULL OR adapter_key IN (%s))',
    (SELECT string_agg(quote_literal(k), ', ') FROM unnest(keys) AS k)
  );
END
$$;

DELETE FROM adapter_types WHERE key IN ('openwifi-uspot-uam', 'coovachilli-uam');
