-- ECLOUD migration 026: dashboard & reports (Phase 9 P9-A). Additive only.
--
-- 1. usage_hourly (T): per-site usage per site-local hour, maintained by the accounting drainer
--    (one more upsert per accounting delta, next to the usage_counters rows). It backs the hourly
--    usage chart, which usage_counters (daily / monthly / total) cannot answer, and keeps the
--    chart query a PK range read instead of a window-function scan of accounting_records.
--    `hour_start` is the instant the site-local hour began (whole-hour offsets: a UTC hour;
--    :30 / :45 offsets: the matching UTC half / quarter hour). No backfill: hours before this
--    migration read as zero (documented in API_ARCHITECTURE.md "P9-A").
-- 2. portal_login_attempts.triggered_lockout: true on the failed identify attempt that activated
--    a portal lock (per device, per account or the site-wide voucher cap). Lock state itself
--    lives in Redis and has no history; this column makes "lockouts" countable. Adding a column
--    with a constant default to the partitioned parent is a catalog-only change (PostgreSQL 11+).
-- 3. Read indexes for the dashboard: open sessions per site / NAS, the newest auth request and
--    accounting record per NAS, auth outcomes of a site's NAS over time, anomalies over time.
--    The indexes on the partitioned auth_events / accounting_records cannot be built
--    CONCURRENTLY (PostgreSQL limitation for partitioned parents); pilot volumes make the short
--    lock acceptable (same note as migration 024).
SET LOCAL lock_timeout = '5s';

CREATE TABLE usage_hourly (
  organization_id uuid NOT NULL,
  site_id         uuid NOT NULL,
  hour_start      timestamptz NOT NULL,
  bytes_in        bigint NOT NULL DEFAULT 0,
  bytes_out       bigint NOT NULL DEFAULT 0,
  session_count   integer NOT NULL DEFAULT 0,
  session_time_s  bigint NOT NULL DEFAULT 0,
  last_record_id  bigint,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, site_id, hour_start),
  CONSTRAINT fk_usage_hourly_organization_id FOREIGN KEY (organization_id)
    REFERENCES organizations (id) ON DELETE CASCADE,
  CONSTRAINT fk_usage_hourly_site_id FOREIGN KEY (site_id)
    REFERENCES sites (id) ON DELETE RESTRICT,
  CONSTRAINT ck_usage_hourly_non_negative CHECK (
    bytes_in >= 0 AND bytes_out >= 0 AND session_count >= 0 AND session_time_s >= 0
  ),
  -- whole minutes only (every IANA offset in use is a whole number of minutes)
  CONSTRAINT ck_usage_hourly_hour_start CHECK (
    date_trunc('minute', hour_start) = hour_start
  )
);
CREATE INDEX idx_usage_hourly_org_hour ON usage_hourly (organization_id, hour_start);
CREATE TRIGGER trg_usage_hourly_updated_at BEFORE UPDATE ON usage_hourly
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
SELECT enable_tenant_rls('usage_hourly'::regclass);

ALTER TABLE portal_login_attempts
  ADD COLUMN triggered_lockout boolean NOT NULL DEFAULT false;

CREATE INDEX idx_sessions_open_org_site_nas
  ON sessions (organization_id, site_id, nas_client_id) WHERE status IN ('authorized', 'active');

CREATE INDEX idx_auth_events_org_nas_time
  ON auth_events (organization_id, nas_client_id, created_at);

CREATE INDEX idx_accounting_org_nas_received
  ON accounting_records (organization_id, nas_ip, received_at);

CREATE INDEX idx_accounting_anomalies_org_created
  ON accounting_anomalies (organization_id, created_at);

-- Grants: the API reads the rollup under RLS; the drainer writes it through the platform role.
-- Restated explicitly so the chain is independent of who ran 010's ALTER DEFAULT PRIVILEGES.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ecloud_app') THEN
    RAISE NOTICE 'role ecloud_app does not exist: usage_hourly grants skipped';
    RETURN;
  END IF;
  EXECUTE 'GRANT SELECT, INSERT, UPDATE ON TABLE usage_hourly TO ecloud_app';
END
$$;
