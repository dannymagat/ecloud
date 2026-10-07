-- DEV ONLY. Executed once by the postgres:16 image on first start of an empty data volume
-- (docker-entrypoint-initdb.d), connected to $POSTGRES_DB as the $POSTGRES_USER superuser.
-- Passwords come from the container environment (docker-compose.dev.yml), never from git.
--
-- Roles (DATABASE_DESIGN.md §8, MULTITENANCY.md §2):
--   ecloud_app       NOSUPERUSER, NOBYPASSRLS  -> api/portal, Row-Level Security enforced
--   ecloud_platform  BYPASSRLS                 -> worker and migrations (DATABASE_URL_PLATFORM)
--   ecloud_radius    NOBYPASSRLS, INSERT-only  -> FreeRADIUS rlm_sql accounting (radius schema;
--                                                grants are applied by migration 010 when the role exists)
\set ON_ERROR_STOP on
\getenv app_password ECLOUD_APP_PASSWORD
\getenv platform_password ECLOUD_PLATFORM_PASSWORD
\getenv radius_password RADIUS_SQL_PASSWORD

CREATE ROLE ecloud_app
    LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS
    PASSWORD :'app_password';

CREATE ROLE ecloud_platform
    LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT BYPASSRLS
    PASSWORD :'platform_password';

CREATE ROLE ecloud_radius
    LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS
    PASSWORD :'radius_password';

GRANT CONNECT, TEMPORARY ON DATABASE :"DBNAME" TO ecloud_app, ecloud_platform;
GRANT CONNECT ON DATABASE :"DBNAME" TO ecloud_radius;
-- Migrations create the `radius` schema, so the platform role needs CREATE on the database.
GRANT CREATE ON DATABASE :"DBNAME" TO ecloud_platform;

-- The platform role owns application objects (migrations run as ecloud_platform).
GRANT ALL ON SCHEMA public TO ecloud_platform;
GRANT USAGE ON SCHEMA public TO ecloud_app;

-- Objects created later by ecloud_platform become usable by ecloud_app (RLS still applies).
ALTER DEFAULT PRIVILEGES FOR ROLE ecloud_platform IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ecloud_app;
ALTER DEFAULT PRIVILEGES FOR ROLE ecloud_platform IN SCHEMA public
    GRANT USAGE, SELECT ON SEQUENCES TO ecloud_app;
ALTER DEFAULT PRIVILEGES FOR ROLE ecloud_platform IN SCHEMA public
    GRANT EXECUTE ON FUNCTIONS TO ecloud_app;

-- Separate test database for integration tests (ECLOUD_TEST_DATABASE_URL).
CREATE DATABASE ecloud_test OWNER ecloud_platform;
GRANT CONNECT, TEMPORARY ON DATABASE ecloud_test TO ecloud_app;
GRANT CONNECT ON DATABASE ecloud_test TO ecloud_radius;
