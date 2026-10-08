-- ECLOUD migration 016: session lifecycle states (DECISIONS.md D-036).
--   authorized : inserted by /internal/aaa/authorize (Access-Accept sent, no accounting yet)
--   active     : promoted by the first Accounting-Start (or Interim) from the same NAS
--   expired    : an authorization that was never promoted within the worker TTL
--                (terminate_cause 'authorization_expired'); a late accounting packet revives it
-- Concurrency counting covers authorized + active, hence the partial indexes below.
SET LOCAL lock_timeout = '5s';

ALTER TABLE sessions DROP CONSTRAINT ck_sessions_status;
ALTER TABLE sessions ADD CONSTRAINT ck_sessions_status
  CHECK (status IN ('authorized', 'active', 'stopped', 'stale', 'expired'));

CREATE INDEX idx_sessions_open_user ON sessions (organization_id, user_id)
  WHERE status IN ('authorized', 'active');
CREATE INDEX idx_sessions_open_device ON sessions (organization_id, client_device_id)
  WHERE status IN ('authorized', 'active');
CREATE INDEX idx_sessions_authorized_started ON sessions (started_at)
  WHERE status = 'authorized';
