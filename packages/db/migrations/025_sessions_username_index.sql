-- ECLOUD migration 025: session list `username` filter (Phase 8 P8-A review fix 4). Additive only.
-- Migration 024 is already applied in dev, so the index lands in its own file. Partial: rows
-- without a username can never match the filter.
SET LOCAL lock_timeout = '5s';

CREATE INDEX idx_sessions_org_username_started
  ON sessions (organization_id, username_raw, started_at DESC) WHERE username_raw IS NOT NULL;
