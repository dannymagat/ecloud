-- 047: bind a sealed secret to the row it belongs to (task 10, findings S-1 and S-2 of
-- SECURITY_REVIEW_FLEET_DEFAULT.md; design in docs/AAA_SECRET_SEALING_V2_PROPOSAL.md).
--
-- THIS MIGRATION ADDS SCHEMA ONLY. It does not touch a single secret. The re-seal of existing
-- rows is a SEPARATE data migration over LIVE SECRETS and needs the owner's own word before it
-- runs anywhere near production; this file is safe to apply on its own and leaves every existing
-- `enc:v1.` value readable, because the deployed code reads both formats during the window.
--
-- WHAT WAS WRONG.
--
-- S-1: `apps/api/src/crypto.ts` and `apps/api/src/internal/portal.ts` both held the purpose label
-- `'ecloud:nas:secret:v1'`. The purpose is the HKDF `info` parameter, so the NAS RADIUS secret and
-- the portal UAM secret were sealed under a byte-identical key in an identical format, and a
-- ciphertext from one column decrypted happily in the other. `bootstrap/tenant.ts` builds
-- `nasEnvelope` and `uamEnvelope` from two differently-named constants holding the same string —
-- code that reads as though it separates two keys and does not.
--
-- S-2: the envelope never called `setAAD`. GCM authenticates the ciphertext and says nothing about
-- where it is stored, so within one purpose every sealed value was interchangeable with every
-- other: transplantable between rows, between tenants, and replayable from before a rotation.
--
-- WHAT THE VERSION COLUMNS ARE FOR, and it is the part a reader will otherwise mistake for
-- bookkeeping. AAD over organization, row id and column stops transplants, but it does NOT stop
-- rollback: the identity of a row is unchanged across a rotation, so an old ciphertext written
-- back into the same row still verifies. The monotonic version is the element that makes the
-- replay fail, which is why it is a column and a trigger rather than a comment.

SET LOCAL lock_timeout = '5s';

ALTER TABLE nas_clients
  ADD COLUMN secret_version integer NOT NULL DEFAULT 1;
ALTER TABLE captive_portals
  ADD COLUMN uam_secret_version integer NOT NULL DEFAULT 1;

COMMENT ON COLUMN nas_clients.secret_version IS
  'Monotonic counter bound into the v2 envelope AAD (migration 047). Incremented by a secret rotation, never by a re-seal: a re-seal preserves the plaintext, and bumping it would misreport a rotation that did not happen.';
COMMENT ON COLUMN captive_portals.uam_secret_version IS
  'As nas_clients.secret_version, for the UAM secret.';

-- Monotonicity is what makes the version an anti-rollback measure rather than a label. Enforced in
-- the database because the guarantee has to hold against every writer, including the direct SQL
-- this estate has seen three times this week.
CREATE OR REPLACE FUNCTION trg_secret_version_no_decrease() RETURNS trigger AS $$
BEGIN
  IF TG_TABLE_NAME = 'nas_clients' AND NEW.secret_version < OLD.secret_version THEN
    RAISE EXCEPTION 'secret_version must not decrease (% -> %)',
      OLD.secret_version, NEW.secret_version;
  END IF;
  IF TG_TABLE_NAME = 'captive_portals' AND NEW.uam_secret_version < OLD.uam_secret_version THEN
    RAISE EXCEPTION 'uam_secret_version must not decrease (% -> %)',
      OLD.uam_secret_version, NEW.uam_secret_version;
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_nas_clients_secret_version
  BEFORE UPDATE ON nas_clients
  FOR EACH ROW EXECUTE FUNCTION trg_secret_version_no_decrease();
CREATE TRIGGER trg_captive_portals_uam_secret_version
  BEFORE UPDATE ON captive_portals
  FOR EACH ROW EXECUTE FUNCTION trg_secret_version_no_decrease();

-- NO FORMAT CHECK HERE, and the reason is worth recording rather than discovering later.
--
-- `nas_clients.secret_ref` has no format constraint while `controllers.credential_secret_ref`
-- (019) and `vendor_api_credentials.secret_ref` (028) both do — the stricter tables holding the
-- less sensitive secret. Closing that was meant to ride along here.
--
-- It cannot, yet, and the obstacle is informative: 28 fixtures across 21 test files write
-- `secret_ref` values of the shape `env:ECLOUD_…`, `secret://test/…` and `enc:placeholder…`.
-- No production code parses any of those schemes — I grepped for a reader and there is none — so
-- those rows hold refs that nothing could ever open. They have never been a problem because no
-- test opens them, which is its own small finding.
--
-- Adding the CHECK today means editing 21 files, most in other sessions' lanes and several
-- mid-change, to fix a latent fixture problem that is not what this migration is about. The
-- tightening migration of the re-seal procedure (proposal §6 step 5) already has to narrow
-- `v[12]` to `v2` once production reports zero v1 rows; the format CHECK belongs in that same
-- statement, by which time the re-seal has normalised the real data and the fixture sweep is one
-- mechanical change made deliberately rather than as a side effect of a security fix.
