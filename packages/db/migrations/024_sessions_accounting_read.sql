-- ECLOUD migration 024: sessions & accounting read paths (Phase 8 P8-A). Additive only.
--
-- 1. usage_counters.subject_type gains 'site': the accounting drainer advances one site row per
--    accounting delta (daily / monthly in the site TZ per Q65, total), so per-site and
--    per-organization usage (sum of the site rows) and top-N sites read PK-indexed counters
--    instead of scanning accounting_records. No backfill: site rows start with the accounting
--    drained after this migration (documented in API_ARCHITECTURE.md "P8-A").
-- 2. Read indexes for the session list filters (site / user / client device / MAC over time),
--    the session accounting timeline (accounting_records by session_id, partition-local), top-N
--    usage per subject type and the open-action idempotency lookup of disconnect / reauthorize.
--
-- The indexes on the partitioned accounting_records cannot be built CONCURRENTLY (PostgreSQL
-- limitation for partitioned parents); pilot volumes make the short lock acceptable.
SET LOCAL lock_timeout = '5s';

ALTER TABLE usage_counters DROP CONSTRAINT ck_usage_counters_subject_type;
ALTER TABLE usage_counters ADD CONSTRAINT ck_usage_counters_subject_type
  CHECK (subject_type IN ('user', 'client_device', 'voucher', 'site'));

CREATE INDEX idx_usage_counters_org_subject_period
  ON usage_counters (organization_id, subject_type, period_type, period_start);

CREATE INDEX idx_sessions_org_site_started
  ON sessions (organization_id, site_id, started_at DESC);
CREATE INDEX idx_sessions_org_user_started
  ON sessions (organization_id, user_id, started_at DESC) WHERE user_id IS NOT NULL;
CREATE INDEX idx_sessions_org_device_started
  ON sessions (organization_id, client_device_id, started_at DESC) WHERE client_device_id IS NOT NULL;
CREATE INDEX idx_sessions_org_mac_started
  ON sessions (organization_id, mac, started_at DESC) WHERE mac IS NOT NULL;

CREATE INDEX idx_accounting_session_received
  ON accounting_records (session_id, received_at) WHERE session_id IS NOT NULL;

CREATE INDEX idx_session_actions_open
  ON session_actions (session_id, action) WHERE status IN ('pending', 'sent');
