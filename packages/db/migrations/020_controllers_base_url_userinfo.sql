-- ECLOUD migration 020: controllers.base_url must not carry userinfo (MULTI_VENDOR_INTEGRATION_PLAN.md
-- §8.2 "base_url: always https://, no userinfo, no fragment").
-- 019's ck_controllers_base_url only checks the first authority character, so
-- `https://user@host` slipped through at the database level (the API already refuses it).
-- Additive: a second CHECK; 019 is never edited (applied checksums are immutable).
SET LOCAL lock_timeout = '5s';

ALTER TABLE controllers ADD CONSTRAINT ck_controllers_base_url_no_userinfo
  CHECK (base_url !~ '^https://[^/?#]*@');
