-- EZECLOUD migration 051: make the 049 privilege intent true, and keep partitions as narrow as
-- their parent for ecloud_app.
--
-- 049 GRANTs SELECT, INSERT on portal_registrations and SELECT, INSERT, UPDATE on
-- terms_acceptances / device_registrations, but 010's ALTER DEFAULT PRIVILEGES had already given
-- ecloud_app SELECT, INSERT, UPDATE, DELETE on every new table, so a GRANT could not narrow it:
-- the app role could rewrite or delete guest registrations, and delete terms acceptances and
-- device registrations (049: "revocation is recorded, never deleted"). RLS still confined that to
-- one tenant; this closes it. Purges and erasure requests run as the platform role (owner).
--
-- Partitions: a partition created by ensure_month_partitions() also got the default privileges,
-- so ecloud_app could UPDATE/DELETE a partition addressed directly even where the parent revokes
-- it. The append-only tables are still protected by forbid_mutation() on every partition;
-- portal_registrations has no such trigger (its rows must stay deletable for retention), so its
-- partitions need the same privileges as the parent. ensure_month_partitions() now mirrors the
-- parent's missing UPDATE / DELETE / TRUNCATE onto each partition it creates, and existing
-- partitions of every partitioned table are aligned once here.
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION ensure_month_partitions(p_table regclass, p_months_ahead integer DEFAULT 2)
RETURNS SETOF text
LANGUAGE plpgsql AS $$
DECLARE
  v_schema text;
  v_table  text;
  v_rls    boolean;
  v_from   date;
  v_to     date;
  v_part   text;
  v_priv   text;
  i        integer;
BEGIN
  IF p_months_ahead IS NULL OR p_months_ahead < 0 THEN
    RAISE EXCEPTION 'ensure_month_partitions: months_ahead must be >= 0 (got %)', p_months_ahead;
  END IF;
  SELECT n.nspname, c.relname, c.relrowsecurity INTO v_schema, v_table, v_rls
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE c.oid = p_table;
  IF NOT EXISTS (SELECT 1 FROM pg_partitioned_table WHERE partrelid = p_table) THEN
    RAISE EXCEPTION 'ensure_month_partitions: % is not a partitioned table', p_table;
  END IF;
  FOR i IN 0..p_months_ahead LOOP
    v_from := (date_trunc('month', now() AT TIME ZONE 'UTC') + make_interval(months => i))::date;
    v_to   := (v_from + interval '1 month')::date;
    v_part := format('%s_y%sm%s', v_table, to_char(v_from, 'YYYY'), to_char(v_from, 'MM'));
    IF to_regclass(format('%I.%I', v_schema, v_part)) IS NULL THEN
      EXECUTE format(
        'CREATE TABLE %I.%I PARTITION OF %I.%I FOR VALUES FROM (%L::timestamptz) TO (%L::timestamptz)',
        v_schema, v_part, v_schema, v_table,
        to_char(v_from, 'YYYY-MM-DD') || ' 00:00:00+00',
        to_char(v_to, 'YYYY-MM-DD') || ' 00:00:00+00'
      );
      IF v_rls THEN
        PERFORM enable_tenant_rls(p_table);
      END IF;
      -- 051: never give ecloud_app more on a partition than on its parent.
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ecloud_app') THEN
        FOREACH v_priv IN ARRAY ARRAY['UPDATE', 'DELETE', 'TRUNCATE'] LOOP
          IF NOT has_table_privilege('ecloud_app', p_table, v_priv) THEN
            EXECUTE format('REVOKE %s ON TABLE %I.%I FROM ecloud_app', v_priv, v_schema, v_part);
          END IF;
        END LOOP;
      END IF;
      RETURN NEXT format('%s.%s', v_schema, v_part);
    END IF;
  END LOOP;
END
$$;

DO $$
DECLARE
  r      record;
  v_priv text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ecloud_app') THEN
    RAISE NOTICE 'role ecloud_app does not exist: privilege alignment skipped';
    RETURN;
  END IF;

  REVOKE UPDATE, DELETE, TRUNCATE ON TABLE portal_registrations FROM ecloud_app;
  REVOKE DELETE, TRUNCATE ON TABLE terms_acceptances, device_registrations FROM ecloud_app;

  -- existing partitions (every partitioned table in public, incl. the DEFAULT partitions)
  FOR r IN
    SELECT i.inhparent AS parent, c.oid AS part, c.relname
      FROM pg_inherits i
      JOIN pg_class c ON c.oid = i.inhrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_partitioned_table p ON p.partrelid = i.inhparent
     WHERE n.nspname = 'public'
  LOOP
    FOREACH v_priv IN ARRAY ARRAY['UPDATE', 'DELETE', 'TRUNCATE'] LOOP
      IF NOT has_table_privilege('ecloud_app', r.parent, v_priv)
         AND has_table_privilege('ecloud_app', r.part, v_priv) THEN
        EXECUTE format('REVOKE %s ON TABLE public.%I FROM ecloud_app', v_priv, r.relname);
      END IF;
    END LOOP;
  END LOOP;
END
$$;
