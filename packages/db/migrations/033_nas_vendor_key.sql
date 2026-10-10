-- ECLOUD migration 033: Access Points page (DECISIONS.md D-045). The vendor the administrator
-- picked when adding a NAS through the "Add Access Point" wizard, so the access-point table can
-- show that vendor (logo + name) even when several vendors share one adapter / post-back profile
-- (e.g. the long-tail vendors on `postback-generic`, or CoovaChilli vs Teltonika).
--
-- Additive only (expand step; nothing is dropped, retyped or deleted); idempotent.
--   nas_clients.vendor_key: a setup-guide gallery key (`@ecloud/adapters` GALLERY_ENTRIES, e.g.
--   `mikrotik`, `grandstream`); NULL = not chosen (the API then derives the vendor from the
--   adapter / profile). The API checks the key against the gallery and the NAS adapter; the
--   database only checks its shape. A display attribute: never used for identity or policy.
SET LOCAL lock_timeout = '5s';

ALTER TABLE nas_clients ADD COLUMN IF NOT EXISTS vendor_key text NULL;

ALTER TABLE nas_clients DROP CONSTRAINT IF EXISTS ck_nas_clients_vendor_key;
ALTER TABLE nas_clients ADD CONSTRAINT ck_nas_clients_vendor_key CHECK (
  vendor_key IS NULL OR vendor_key ~ '^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$'
);

COMMENT ON COLUMN nas_clients.vendor_key IS
  'Setup-guide gallery vendor chosen in the Add Access Point wizard (D-045); display only. NULL = derived from adapter_key / post-back profile.';
