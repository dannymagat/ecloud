-- ECLOUD migration 010: Row-Level Security, append-only enforcement, role grants
-- (DATABASE_DESIGN.md §3.5, §8; MULTITENANCY.md §2). Design of record: packages/db/README.md.
--
-- Roles (created out-of-band, never here: the migration role has no CREATEROLE):
--   ecloud_platform  owner of every object, BYPASSRLS  -> worker, migrations, platform admin
--   ecloud_app       NOBYPASSRLS                        -> api/portal; every query runs inside
--                    a transaction that did SET LOCAL app.current_org = '<org uuid>'
--   ecloud_radius    FreeRADIUS rlm_sql; sees ONLY the radius schema (insert-only staging)
-- Grants are applied only when the role exists so the chain also runs on a plain PG16 in CI.
SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------------------------
-- 1. Tenant isolation: ENABLE + FORCE RLS and the standard policy on every tenant-scoped table
--    (including existing partitions of the partitioned ones).
-- ---------------------------------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'sites', 'invitations', 'role_bindings', 'api_keys',
    'network_devices', 'nas_clients', 'wireguard_peers',
    'identity_providers', 'user_groups', 'users', 'client_devices',
    'schedules', 'policies', 'voucher_batches', 'vouchers', 'policy_assignments', 'policy_translations',
    'portal_themes', 'captive_portals', 'portal_login_attempts',
    'sessions', 'accounting_records', 'auth_events', 'session_actions', 'usage_counters',
    'audit_logs', 'outbox', 'webhooks', 'webhook_deliveries'
  ] LOOP
    PERFORM enable_tenant_rls(t::regclass);
  END LOOP;
END
$$;

-- roles: a tenant reads the platform templates (organization_id IS NULL) and its own roles, but
-- may only write its own rows. Templates are written exclusively through the platform role.
ALTER TABLE roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE roles FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON roles
  USING (
    organization_id IS NULL
    OR organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid
  )
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

-- role_permissions has no tenant key: it follows its role.
ALTER TABLE role_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE role_permissions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON role_permissions
  USING (EXISTS (
    SELECT 1 FROM roles r
     WHERE r.id = role_permissions.role_id
       AND (r.organization_id IS NULL
            OR r.organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM roles r
     WHERE r.id = role_permissions.role_id
       AND r.organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid
  ));

-- ---------------------------------------------------------------------------------------------
-- 2. Append-only tables: BEFORE UPDATE OR DELETE raises (triggers on a partitioned parent are
--    cloned to every current and future partition).
-- ---------------------------------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'accounting_records', 'auth_events', 'audit_logs', 'portal_login_attempts',
    'policy_translations', 'webhook_deliveries'
  ] LOOP
    EXECUTE format(
      'CREATE TRIGGER trg_%s_append_only BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION forbid_mutation()',
      t, t
    );
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------------------------
-- 3. Privileges of ecloud_app (RLS-enforced application role)
-- ---------------------------------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ecloud_app') THEN
    RAISE NOTICE 'role ecloud_app does not exist: application grants skipped';
    RETURN;
  END IF;

  EXECUTE 'GRANT USAGE ON SCHEMA public TO ecloud_app';
  EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ecloud_app';
  EXECUTE 'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ecloud_app';

  -- runner bookkeeping and catalogues are read-only (or invisible) for the application
  EXECUTE 'REVOKE ALL ON TABLE schema_migrations FROM ecloud_app';
  EXECUTE 'REVOKE INSERT, UPDATE, DELETE ON TABLE permissions, adapter_types FROM ecloud_app';

  -- append-only: INSERT + SELECT only (the trigger above is the second lock)
  FOREACH t IN ARRAY ARRAY[
    'accounting_records', 'auth_events', 'audit_logs', 'portal_login_attempts',
    'policy_translations', 'webhook_deliveries'
  ] LOOP
    EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON TABLE %I FROM ecloud_app', t);
  END LOOP;

  -- tables created by later migrations (as the migration role) inherit the same defaults;
  -- append-only tables added later must REVOKE explicitly, as above.
  EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ecloud_app', current_user);
  EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ecloud_app', current_user);
  EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO ecloud_app', current_user);
END
$$;

-- DDL helpers are for the platform role only (owner keeps EXECUTE implicitly).
REVOKE EXECUTE ON FUNCTION ensure_month_partitions(regclass, integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION enable_tenant_rls(regclass) FROM PUBLIC;

-- ---------------------------------------------------------------------------------------------
-- 4. Privileges of ecloud_radius (FreeRADIUS). Nothing in public; insert-only staging.
-- ---------------------------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ecloud_radius') THEN
    RAISE NOTICE 'role ecloud_radius does not exist: FreeRADIUS grants skipped';
    RETURN;
  END IF;
  EXECUTE 'GRANT USAGE ON SCHEMA radius TO ecloud_radius';
  EXECUTE 'GRANT INSERT ON TABLE radius.radacct_raw, radius.radpostauth_raw TO ecloud_radius';
  EXECUTE 'GRANT SELECT ON TABLE radius.nas_v TO ecloud_radius';
  EXECUTE 'REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ecloud_radius';
END
$$;
