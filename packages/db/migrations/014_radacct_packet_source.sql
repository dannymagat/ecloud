-- ECLOUD migration 014: authenticated transport source on accounting staging rows.
-- `nasipaddress` holds NAS-IP-Address as the NAS wrote it: any client FreeRADIUS accepts can put
-- another tenant's address there. `packet_src_ip` is the UDP source FreeRADIUS matched against
-- clients.conf (the shared secret), i.e. the only trustworthy NAS identity (AAA §3, MULTITENANCY
-- §3.3 A). The drainer resolves the NAS from this column only; rows without it (written before
-- this migration) stay unattributed (organization_id NULL) and never touch sessions or usage.
SET LOCAL lock_timeout = '5s';

ALTER TABLE radius.radacct_raw ADD COLUMN packet_src_ip inet NULL;
