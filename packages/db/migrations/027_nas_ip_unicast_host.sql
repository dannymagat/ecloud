-- ECLOUD migration 027: nas_clients.nas_ip must be a single unicast host (F-P10-07 review).
-- Additive only. FreeRADIUS matches a NAS by the exact UDP source address; the clients renderer
-- and the API (`canonicalNasAddress`, packages/shared/src/net-guard.ts) already refuse networks,
-- unspecified, loopback, link-local, multicast / reserved and IPv4-mapped / -compatible IPv6.
-- This is the database backstop for writes that bypass the API.
--
-- `inet` keeps `::ffff:a.b.c.d` and `a.b.c.d` as different values, so uq_nas_clients_ip alone
-- would not stop a mapped duplicate from shadowing another tenant's NAS.
--
-- Only ACTIVE, non-deleted rows are constrained, so an existing bad row can still be disabled
-- or soft-deleted. NOT VALID: existing rows are not re-checked at migration time (none violate
-- in dev / ecloud_test; unknown databases must not fail the migration); the renderer skips any
-- such row and reports it. Every INSERT / UPDATE from now on is checked.
SET LOCAL lock_timeout = '5s';

ALTER TABLE nas_clients
  ADD CONSTRAINT ck_nas_clients_nas_ip_unicast_host CHECK (
    status <> 'active'
    OR deleted_at IS NOT NULL
    OR (
      family(nas_ip) = 4
      AND masklen(nas_ip) = 32
      AND NOT (
        nas_ip <<= inet '0.0.0.0/8'
        OR nas_ip <<= inet '127.0.0.0/8'
        OR nas_ip <<= inet '169.254.0.0/16'
        OR nas_ip <<= inet '224.0.0.0/3'
      )
    )
    OR (
      family(nas_ip) = 6
      AND masklen(nas_ip) = 128
      AND NOT (
        nas_ip <<= inet '::/96'
        OR nas_ip <<= inet '::ffff:0:0/96'
        OR nas_ip <<= inet 'fe80::/10'
        OR nas_ip <<= inet 'ff00::/8'
      )
    )
  ) NOT VALID;
