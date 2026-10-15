-- 048: split the 047 secret-version trigger into one function per table.
--
-- 047 guarded two tables with a single PL/pgSQL function and a `TG_TABLE_NAME` test:
--
--   IF TG_TABLE_NAME = 'nas_clients' AND NEW.secret_version < OLD.secret_version THEN ...
--   IF TG_TABLE_NAME = 'captive_portals' AND NEW.uam_secret_version < OLD.uam_secret_version THEN ...
--
-- That does not work, and it fails in the worst available direction. PL/pgSQL resolves `NEW.<field>`
-- in order to evaluate the expression, so the `TG_TABLE_NAME` guard never gets the chance to
-- short-circuit: on `captive_portals` the first IF died on `secret_version`, and on `nas_clients`
-- the second died on `uam_secret_version`. Each table was broken by the branch written for the
-- other one. The symptom was not a rejected rollback — it was EVERY update to both tables failing:
-- portal publish, portal rollback, UAM secret rotation, every NAS edit and the NAS secret rotation.
--
-- Reproduced on ecloud_test by EZECLOUD1 on 2026-10-15, before 047 reached any server; vps-local
-- never ran it. 047 is left exactly as applied rather than edited, because applied migrations are
-- immutable here and rewriting it would have put every local database into checksum drift.
--
-- The short-circuit intuition from other languages does not hold for record field resolution, and
-- the shared function is precisely what made the original read as safe. One function per table
-- removes the possibility rather than the symptom: each references only a field its own table has.

SET LOCAL lock_timeout = '5s';

DROP TRIGGER IF EXISTS trg_nas_clients_secret_version ON nas_clients;
DROP TRIGGER IF EXISTS trg_captive_portals_uam_secret_version ON captive_portals;
DROP FUNCTION IF EXISTS trg_secret_version_no_decrease();

CREATE OR REPLACE FUNCTION trg_nas_clients_secret_version_no_decrease() RETURNS trigger AS $$
BEGIN
  IF NEW.secret_version < OLD.secret_version THEN
    RAISE EXCEPTION 'nas_clients.secret_version must not decrease (% -> %)',
      OLD.secret_version, NEW.secret_version;
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION trg_captive_portals_uam_secret_version_no_decrease() RETURNS trigger AS $$
BEGIN
  IF NEW.uam_secret_version < OLD.uam_secret_version THEN
    RAISE EXCEPTION 'captive_portals.uam_secret_version must not decrease (% -> %)',
      OLD.uam_secret_version, NEW.uam_secret_version;
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

-- `UPDATE OF <column>` narrows the firing to statements that actually name the version column, so
-- an ordinary NAS edit or portal publish never enters the function. A statement that lowers the
-- version has to name the column, so nothing escapes the check.
CREATE TRIGGER trg_nas_clients_secret_version
  BEFORE UPDATE OF secret_version ON nas_clients
  FOR EACH ROW EXECUTE FUNCTION trg_nas_clients_secret_version_no_decrease();
CREATE TRIGGER trg_captive_portals_uam_secret_version
  BEFORE UPDATE OF uam_secret_version ON captive_portals
  FOR EACH ROW EXECUTE FUNCTION trg_captive_portals_uam_secret_version_no_decrease();
