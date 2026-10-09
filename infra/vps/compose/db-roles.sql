-- ECLOUD pilot database roles (DRAFT, NOT APPLIED). Run by the one-shot `db-roles` service of
-- compose.pilot.yaml on EVERY deploy: idempotent, and re-applying the role passwords is how a
-- rotated password file takes effect (docs/SECRETS_MANAGEMENT.md R7).
-- Differences from the DEV-only infra/compose/postgres-init/01_roles.sql: no ecloud_test
-- database, CREATE ROLE only when missing, passwords always (re)set from the secret files.
-- Roles: DATABASE_DESIGN.md §8, MULTITENANCY.md §2, SECURITY_ARCHITECTURE.md §3.1.
\set ON_ERROR_STOP on
\set QUIET on
\getenv app_password ECLOUD_APP_PASSWORD
\getenv platform_password ECLOUD_PLATFORM_PASSWORD
\getenv radius_password RADIUS_SQL_PASSWORD
\getenv dbname POSTGRES_DB

SELECT 'CREATE ROLE ecloud_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS'
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ecloud_app') \gexec
SELECT 'CREATE ROLE ecloud_platform LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT BYPASSRLS'
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ecloud_platform') \gexec
SELECT 'CREATE ROLE ecloud_radius LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS'
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ecloud_radius') \gexec
-- Backup (scripts/backup/backup.sh, BACKUP_PG_USER): read-only. BYPASSRLS is required because
-- pg_dump refuses FORCE RLS tables otherwise; pg_read_all_data (INHERIT) grants SELECT only.
-- No password: it is used only over the container-local socket (`docker exec`), never TCP.
SELECT 'CREATE ROLE ecloud_backup LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT BYPASSRLS'
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ecloud_backup') \gexec

-- Attributes are re-asserted too, so a manual drift (e.g. BYPASSRLS on ecloud_app) is undone.
ALTER ROLE ecloud_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS PASSWORD :'app_password';
ALTER ROLE ecloud_platform LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT BYPASSRLS PASSWORD :'platform_password';
ALTER ROLE ecloud_radius LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS PASSWORD :'radius_password';
ALTER ROLE ecloud_backup LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT BYPASSRLS PASSWORD NULL;
GRANT pg_read_all_data TO ecloud_backup;

REVOKE ALL ON DATABASE :"dbname" FROM PUBLIC;
GRANT CONNECT, TEMPORARY ON DATABASE :"dbname" TO ecloud_app, ecloud_platform;
GRANT CONNECT ON DATABASE :"dbname" TO ecloud_radius, ecloud_backup;
GRANT CREATE ON DATABASE :"dbname" TO ecloud_platform;
GRANT ALL ON SCHEMA public TO ecloud_platform;
GRANT USAGE ON SCHEMA public TO ecloud_app;
ALTER DEFAULT PRIVILEGES FOR ROLE ecloud_platform IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ecloud_app;
ALTER DEFAULT PRIVILEGES FOR ROLE ecloud_platform IN SCHEMA public
    GRANT USAGE, SELECT ON SEQUENCES TO ecloud_app;
ALTER DEFAULT PRIVILEGES FOR ROLE ecloud_platform IN SCHEMA public
    GRANT EXECUTE ON FUNCTIONS TO ecloud_app;
