-- ECLOUD migration 001: shared functions (DATABASE_DESIGN.md §1, §5, §8).
--
-- No extensions are created on purpose: gen_random_uuid() is core PostgreSQL since 13, and
-- citext is replaced by lower() unique indexes so the runner only needs CREATE on the
-- schema, never on the database (ecloud_platform has no CREATE on the dev database).
SET LOCAL lock_timeout = '5s';

-- Maintains updated_at on every mutable table (one shared trigger function).
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END
$$;

-- Attached BEFORE UPDATE OR DELETE on append-only tables (DATABASE_DESIGN.md §3.5):
-- rows are never modified by the application; retention drops partitions.
CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'table %.% is append-only: % is not allowed', TG_TABLE_SCHEMA, TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END
$$;

-- Enables + forces Row-Level Security on a tenant-scoped table and creates the standard
-- `tenant_isolation` policy (organization_id must equal the transaction-local GUC
-- app.current_org; unset GUC => no rows, fail closed). Partitions do not inherit policies
-- when addressed directly, so existing partitions are covered too. Idempotent.
CREATE OR REPLACE FUNCTION enable_tenant_rls(p_table regclass)
RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  v_rel regclass;
BEGIN
  FOR v_rel IN
    SELECT p_table
    UNION ALL
    SELECT inhrelid::regclass FROM pg_inherits WHERE inhparent = p_table
  LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', v_rel);
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', v_rel);
    IF NOT EXISTS (
      SELECT 1 FROM pg_policy WHERE polrelid = v_rel AND polname = 'tenant_isolation'
    ) THEN
      EXECUTE format(
        $p$CREATE POLICY tenant_isolation ON %s
             USING (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid)$p$,
        v_rel
      );
    END IF;
  END LOOP;
END
$$;

-- Creates the monthly RANGE partitions of p_table for the current UTC month and the next
-- p_months_ahead months (name: <table>_yYYYYmMM, bounds in UTC). New partitions of an
-- RLS-protected parent get the same protection. Idempotent; returns the partitions it
-- created. Called from migrations and from the CLI `ensure-partitions`.
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
      RETURN NEXT format('%s.%s', v_schema, v_part);
    END IF;
  END LOOP;
END
$$;
