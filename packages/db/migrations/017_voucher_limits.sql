-- ECLOUD migration 017: voucher semantics (DECISIONS.md D-037).
-- `duration_s` allows re-login until the voucher expires; `max_uses` allows that many logins;
-- when both are set both limits apply. `max_uses` therefore becomes nullable (NULL = no count
-- limit) and at least one of the two limits must be present. The column DEFAULT 1 stays, so an
-- insert that names neither limit is a single-use voucher (the API passes NULL explicitly for
-- duration-only vouchers).
-- Backfill: until now `max_uses` (NOT NULL DEFAULT 1) was ignored for vouchers with a
-- duration; it is set to NULL for those batches so existing vouchers keep their behaviour.
SET LOCAL lock_timeout = '5s';

ALTER TABLE voucher_batches ALTER COLUMN max_uses DROP NOT NULL;
UPDATE voucher_batches SET max_uses = NULL WHERE duration_s IS NOT NULL;

ALTER TABLE voucher_batches DROP CONSTRAINT ck_voucher_batches_limits;
ALTER TABLE voucher_batches ADD CONSTRAINT ck_voucher_batches_limits CHECK (
  (max_uses IS NULL OR max_uses > 0) AND
  max_devices > 0 AND
  (duration_s IS NULL OR duration_s > 0) AND
  (duration_s IS NOT NULL OR max_uses IS NOT NULL)
);
