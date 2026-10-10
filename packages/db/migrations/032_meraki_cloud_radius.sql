-- ECLOUD migration 032: multi-vendor Cycle E, Cisco Meraki MR splash "Sign-on with my RADIUS
-- server" with cloud-sourced RADIUS (DECISIONS.md D-044; docs/VENDOR_INTEGRATION_RESEARCH.md
-- §3.5; MULTI_VENDOR_INTEGRATION_PLAN.md §13 Cycle E; SECURITY_ARCHITECTURE.md §3.5).
--
-- Meraki sends splash RADIUS from the Meraki Cloud (shared public addresses of every Meraki
-- customer), not from the site. FreeRADIUS picks a client by source address, so a Meraki NAS
-- cannot be a `nas_ip` client. Instead every Meraki NAS gets its OWN pair of UDP listener ports
-- whose client list (the Meraki source ranges) carries THAT NAS's secret and shortname
-- (= nas_clients.id): the packet is authenticated with a per-NAS secret, and the NAS-Identifier
-- must additionally equal the registered value (defence in depth, D-044).
--
-- Additive only (expand step; nothing is dropped, retyped or deleted). Merge-order safe and
-- idempotent (review F1): the adapter CHECK is rebuilt from the LIVE constraint definition (keys
-- added by migrations of other cycles are preserved), every other statement is IF [NOT] EXISTS.
--   1. adapter_types gains `meraki-splash`; the NAS adapter CHECK is widened to accept it.
--   2. nas_clients.nas_ip becomes NULL-able, but ONLY for `meraki-splash` rows (and is required
--      to be NULL for them): every other adapter keeps a mandatory source address.
--   3. nas_clients.cloud_radius_auth_port / cloud_radius_acct_port: the per-NAS listener pair
--      (allocated by the API from MERAKI_RADIUS_PORT_RANGE; globally unique among live rows).
--   4. nas_clients.das_host: the organization's Meraki dashboard host that receives RFC 5176
--      Disconnect-Request on UDP 3799 (Meraki doc "CoA Disconnect for Splash Sign-on": e.g.
--      n165.meraki.com). Only the documented `n<digits>.meraki.com` shape is accepted; other
--      dashboard domains are REQUIRES_CLARIFICATION.
--   5. A Meraki NAS carries a SERVER-GENERATED NAS-Identifier `ecloud-<16 hex>` (unguessable,
--      read-only; the tenant sets it as the custom NAS-ID in Meraki), unique among live Meraki
--      NAS; no other NAS may use that reserved shape (cross-adapter uniqueness without a trigger).
--   6. radius.radacct_raw.packet_client_shortname: the FreeRADIUS client shortname that matched
--      the accounting packet. For Meraki listeners this is the only trustworthy NAS identity
--      (the source address is shared by every Meraki customer).
SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------------------------
-- 1. Adapter key (CHECK rebuilt from the live definition: union, never a hard-coded list)
-- ---------------------------------------------------------------------------------------------
INSERT INTO adapter_types (key, name, verification_status) VALUES
  ('meraki-splash', 'Cisco Meraki MR splash: sign-on with RADIUS (cloud-sourced RADIUS)', 'unknown')
ON CONFLICT (key) DO NOTHING;

DO $$
DECLARE
  v_def  text;
  v_keys text[];
BEGIN
  SELECT pg_get_constraintdef(c.oid) INTO v_def
    FROM pg_constraint c
   WHERE c.conrelid = 'nas_clients'::regclass AND c.conname = 'ck_nas_clients_adapter_key';
  IF v_def IS NOT NULL THEN
    SELECT coalesce(array_agg(DISTINCT m[1] ORDER BY m[1]), ARRAY[]::text[]) INTO v_keys
      FROM regexp_matches(v_def, '''([A-Za-z0-9_-]+)''', 'g') AS m;
    IF 'meraki-splash' = ANY (v_keys) THEN
      RETURN; -- already present (re-run, or another cycle added it)
    END IF;
    EXECUTE 'ALTER TABLE nas_clients DROP CONSTRAINT ck_nas_clients_adapter_key';
  ELSE
    v_keys := ARRAY[]::text[];
  END IF;
  v_keys := array_append(v_keys, 'meraki-splash');
  EXECUTE format(
    'ALTER TABLE nas_clients ADD CONSTRAINT ck_nas_clients_adapter_key CHECK (adapter_key IS NULL OR adapter_key IN (%s))',
    (SELECT string_agg(quote_literal(k), ', ' ORDER BY k) FROM unnest(v_keys) AS k)
  );
END
$$;

-- ---------------------------------------------------------------------------------------------
-- 2. nas_ip: NULL for Meraki only
-- ---------------------------------------------------------------------------------------------
ALTER TABLE nas_clients ALTER COLUMN nas_ip DROP NOT NULL;
ALTER TABLE nas_clients DROP CONSTRAINT IF EXISTS ck_nas_clients_nas_ip_by_adapter;
ALTER TABLE nas_clients ADD CONSTRAINT ck_nas_clients_nas_ip_by_adapter CHECK (
  CASE WHEN adapter_key = 'meraki-splash' THEN nas_ip IS NULL ELSE nas_ip IS NOT NULL END
);

-- ---------------------------------------------------------------------------------------------
-- 3.-5. Meraki columns
-- ---------------------------------------------------------------------------------------------
ALTER TABLE nas_clients ADD COLUMN IF NOT EXISTS cloud_radius_auth_port integer NULL;
ALTER TABLE nas_clients ADD COLUMN IF NOT EXISTS cloud_radius_acct_port integer NULL;
ALTER TABLE nas_clients ADD COLUMN IF NOT EXISTS das_host text NULL;

ALTER TABLE nas_clients DROP CONSTRAINT IF EXISTS ck_nas_clients_cloud_radius_ports;
ALTER TABLE nas_clients ADD CONSTRAINT ck_nas_clients_cloud_radius_ports CHECK (
  (cloud_radius_auth_port IS NULL AND cloud_radius_acct_port IS NULL)
  OR (
    adapter_key = 'meraki-splash'
    AND cloud_radius_auth_port BETWEEN 1024 AND 65534
    AND cloud_radius_auth_port % 2 = 0
    AND cloud_radius_acct_port = cloud_radius_auth_port + 1
  )
);
ALTER TABLE nas_clients DROP CONSTRAINT IF EXISTS ck_nas_clients_das_host;
ALTER TABLE nas_clients ADD CONSTRAINT ck_nas_clients_das_host CHECK (
  das_host IS NULL
  OR (adapter_key = 'meraki-splash' AND das_host ~ '^n[0-9]{1,6}\.meraki\.com$')
);
-- Meraki: exactly the server-generated shape (review F3).
ALTER TABLE nas_clients DROP CONSTRAINT IF EXISTS ck_nas_clients_meraki_identifier;
ALTER TABLE nas_clients ADD CONSTRAINT ck_nas_clients_meraki_identifier CHECK (
  adapter_key IS DISTINCT FROM 'meraki-splash'
  OR (nas_identifier IS NOT NULL AND nas_identifier ~ '^ecloud-[0-9a-f]{16}$')
);
-- Every other NAS: the reserved Meraki shape is refused, so a Meraki identifier can never equal a
-- non-Meraki one (cross-adapter uniqueness). NOT VALID: existing rows are not re-checked.
ALTER TABLE nas_clients DROP CONSTRAINT IF EXISTS ck_nas_clients_identifier_reserved;
ALTER TABLE nas_clients ADD CONSTRAINT ck_nas_clients_identifier_reserved CHECK (
  adapter_key = 'meraki-splash'
  OR nas_identifier IS NULL
  OR nas_identifier !~ '^ecloud-[0-9a-f]{16}$'
) NOT VALID;

CREATE UNIQUE INDEX IF NOT EXISTS uq_nas_clients_cloud_radius_auth_port
  ON nas_clients (cloud_radius_auth_port)
  WHERE deleted_at IS NULL AND cloud_radius_auth_port IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_nas_clients_meraki_identifier ON nas_clients (nas_identifier)
  WHERE deleted_at IS NULL AND adapter_key = 'meraki-splash';

-- ---------------------------------------------------------------------------------------------
-- 6. Accounting staging: matched client shortname (FreeRADIUS queries.conf writes it: apply this
--    migration BEFORE deploying a FreeRADIUS image built from the same tree; the entrypoint
--    refuses to start without the column, review F4)
-- ---------------------------------------------------------------------------------------------
ALTER TABLE radius.radacct_raw ADD COLUMN IF NOT EXISTS packet_client_shortname text NULL;
