-- 051: "any NAS IP" for the EZELINK adapters (owner decision D-086, 2026-10-21).
-- An ezeap-uam / ezecloud-uam NAS may have no nas_ip: FreeRADIUS admits its packets from any
-- source address through the dynamic-client lookup (static fleet secret, D-085) and the API
-- resolves the row by NAS-Identifier (packages/shared nas-any-ip.ts). Meraki stays NULL-only,
-- every other adapter still needs an address. ck_nas_clients_nas_ip_unicast_host passes NULL.
SET LOCAL lock_timeout = '5s';
ALTER TABLE nas_clients DROP CONSTRAINT IF EXISTS ck_nas_clients_nas_ip_by_adapter;
ALTER TABLE nas_clients ADD CONSTRAINT ck_nas_clients_nas_ip_by_adapter CHECK (
  CASE
    WHEN adapter_key = 'meraki-splash' THEN nas_ip IS NULL
    WHEN adapter_key IN ('ezeap-uam', 'ezecloud-uam') THEN true
    ELSE nas_ip IS NOT NULL
  END
);
