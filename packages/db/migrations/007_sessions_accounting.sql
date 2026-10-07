-- ECLOUD migration 007: sessions, accounting, counters (DATABASE_DESIGN.md §3.5, §5, §7).
SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------------------------
-- sessions (T) — one row per RADIUS session, upserted by the worker on acct_unique_id
-- ---------------------------------------------------------------------------------------------
CREATE TABLE sessions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL,
  site_id            uuid NOT NULL,
  nas_client_id      uuid NOT NULL,
  network_device_id  uuid,
  user_id            uuid,
  client_device_id   uuid,
  voucher_id         uuid,
  policy_id          uuid,
  policy_version     integer,
  acct_session_id    text NOT NULL,
  acct_unique_id     text NOT NULL,
  username_raw       text,
  mac                macaddr,
  framed_ip          inet,
  nas_port_id        text,
  called_station_id  text,
  calling_station_id text,
  started_at         timestamptz NOT NULL,
  last_interim_at    timestamptz,
  stopped_at         timestamptz,
  input_octets       bigint NOT NULL DEFAULT 0,
  output_octets      bigint NOT NULL DEFAULT 0,
  session_time_s     bigint NOT NULL DEFAULT 0,
  status             text NOT NULL DEFAULT 'active',
  terminate_cause    text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_sessions_organization_id FOREIGN KEY (organization_id)
    REFERENCES organizations (id) ON DELETE CASCADE,
  CONSTRAINT fk_sessions_site_id FOREIGN KEY (site_id)
    REFERENCES sites (id) ON DELETE RESTRICT,
  CONSTRAINT fk_sessions_nas_client_id FOREIGN KEY (nas_client_id)
    REFERENCES nas_clients (id) ON DELETE RESTRICT,
  CONSTRAINT fk_sessions_network_device_id FOREIGN KEY (network_device_id)
    REFERENCES network_devices (id) ON DELETE SET NULL,
  CONSTRAINT fk_sessions_user_id FOREIGN KEY (user_id)
    REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_sessions_client_device_id FOREIGN KEY (client_device_id)
    REFERENCES client_devices (id) ON DELETE SET NULL,
  CONSTRAINT fk_sessions_voucher_id FOREIGN KEY (voucher_id)
    REFERENCES vouchers (id) ON DELETE SET NULL,
  CONSTRAINT fk_sessions_policy_id FOREIGN KEY (policy_id)
    REFERENCES policies (id) ON DELETE SET NULL,
  CONSTRAINT ck_sessions_status CHECK (status IN ('active', 'stopped', 'stale')),
  CONSTRAINT ck_sessions_counters CHECK (input_octets >= 0 AND output_octets >= 0 AND session_time_s >= 0)
);
CREATE UNIQUE INDEX uq_sessions_acct_unique_id ON sessions (acct_unique_id);
CREATE INDEX idx_sessions_active_nas ON sessions (organization_id, nas_client_id) WHERE status = 'active';
CREATE INDEX idx_sessions_active_user ON sessions (organization_id, user_id) WHERE status = 'active';
CREATE INDEX idx_sessions_active_mac ON sessions (mac) WHERE status = 'active';
CREATE INDEX idx_sessions_org_started ON sessions (organization_id, started_at DESC);
CREATE TRIGGER trg_sessions_updated_at BEFORE UPDATE ON sessions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------------------------
-- accounting_records (T, A) — normalised copy of every accounting packet; NO foreign keys
-- (the append path must never block on a lookup); organization_id NULL = unresolved tenant.
-- ---------------------------------------------------------------------------------------------
CREATE SEQUENCE accounting_records_id_seq AS bigint;
CREATE TABLE accounting_records (
  id                 bigint NOT NULL DEFAULT nextval('accounting_records_id_seq'),
  organization_id    uuid,
  session_id         uuid,
  acct_unique_id     text NOT NULL,
  acct_session_id    text NOT NULL,
  status_type        text NOT NULL,
  nas_ip             inet NOT NULL,
  nas_identifier     text,
  username           text,
  calling_station_id text,
  called_station_id  text,
  framed_ip          inet,
  event_time         timestamptz,
  received_at        timestamptz NOT NULL DEFAULT now(),
  input_octets       bigint,
  output_octets      bigint,
  session_time_s     bigint,
  terminate_cause    text,
  raw                jsonb,
  PRIMARY KEY (id, received_at),
  CONSTRAINT ck_accounting_records_status_type CHECK (
    status_type IN ('start', 'interim', 'stop', 'accounting_on', 'accounting_off')
  )
) PARTITION BY RANGE (received_at);
ALTER SEQUENCE accounting_records_id_seq OWNED BY accounting_records.id;
CREATE INDEX brin_accounting_received ON accounting_records USING brin (received_at);
CREATE INDEX idx_accounting_acct_unique ON accounting_records (acct_unique_id);
CREATE INDEX idx_accounting_org_time ON accounting_records (organization_id, received_at);
CREATE INDEX idx_accounting_username ON accounting_records (organization_id, username);
CREATE TABLE accounting_records_default PARTITION OF accounting_records DEFAULT;
SELECT ensure_month_partitions('accounting_records'::regclass, 2);

-- ---------------------------------------------------------------------------------------------
-- auth_events (T, A) — Access-Accept/Reject log; 90-day retention
-- ---------------------------------------------------------------------------------------------
CREATE SEQUENCE auth_events_id_seq AS bigint;
CREATE TABLE auth_events (
  id                   bigint NOT NULL DEFAULT nextval('auth_events_id_seq'),
  organization_id      uuid,
  nas_client_id        uuid,
  username             text,
  calling_station_id   text,
  called_station_id    text,
  nas_ip               inet,
  result               text NOT NULL,
  reason               text,
  auth_method          text,
  identity_provider_id uuid,
  policy_id            uuid,
  reply_summary        jsonb,
  created_at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at),
  CONSTRAINT ck_auth_events_result CHECK (result IN ('accept', 'reject', 'challenge', 'error'))
) PARTITION BY RANGE (created_at);
ALTER SEQUENCE auth_events_id_seq OWNED BY auth_events.id;
CREATE INDEX brin_auth_events_created ON auth_events USING brin (created_at);
CREATE INDEX idx_auth_events_org_time ON auth_events (organization_id, created_at);
CREATE INDEX idx_auth_events_org_username ON auth_events (organization_id, username);
CREATE INDEX idx_auth_events_nas_time ON auth_events (nas_ip, created_at);
CREATE TABLE auth_events_default PARTITION OF auth_events DEFAULT;
SELECT ensure_month_partitions('auth_events'::regclass, 2);

-- ---------------------------------------------------------------------------------------------
-- session_actions (T) — CoA / Disconnect requests and their outcome
-- ---------------------------------------------------------------------------------------------
CREATE TABLE session_actions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  session_id      uuid NOT NULL,
  action          text NOT NULL,
  payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
  status          text NOT NULL DEFAULT 'pending',
  requested_by    uuid,
  request_id      text,
  error           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  completed_at    timestamptz,
  CONSTRAINT fk_session_actions_organization_id FOREIGN KEY (organization_id)
    REFERENCES organizations (id) ON DELETE CASCADE,
  CONSTRAINT fk_session_actions_session_id FOREIGN KEY (session_id)
    REFERENCES sessions (id) ON DELETE CASCADE,
  CONSTRAINT fk_session_actions_requested_by FOREIGN KEY (requested_by)
    REFERENCES administrators (id) ON DELETE SET NULL,
  CONSTRAINT ck_session_actions_action CHECK (action IN ('disconnect', 'coa_update')),
  CONSTRAINT ck_session_actions_status CHECK (status IN ('pending', 'sent', 'ack', 'nak', 'timeout', 'unsupported'))
);
CREATE INDEX idx_session_actions_org_session ON session_actions (organization_id, session_id);
CREATE INDEX idx_session_actions_pending ON session_actions (created_at) WHERE status = 'pending';

-- ---------------------------------------------------------------------------------------------
-- usage_counters (T) — daily / monthly / total per subject; quota check reads one PK row
-- ---------------------------------------------------------------------------------------------
CREATE TABLE usage_counters (
  organization_id uuid NOT NULL,
  subject_type    text NOT NULL,
  subject_id      uuid NOT NULL,
  period_type     text NOT NULL,
  period_start    date NOT NULL,
  bytes_in        bigint NOT NULL DEFAULT 0,
  bytes_out       bigint NOT NULL DEFAULT 0,
  session_count   integer NOT NULL DEFAULT 0,
  session_time_s  bigint NOT NULL DEFAULT 0,
  last_record_id  bigint,
  reconciled_at   timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (subject_type, subject_id, period_type, period_start),
  CONSTRAINT fk_usage_counters_organization_id FOREIGN KEY (organization_id)
    REFERENCES organizations (id) ON DELETE CASCADE,
  CONSTRAINT ck_usage_counters_subject_type CHECK (subject_type IN ('user', 'client_device', 'voucher')),
  CONSTRAINT ck_usage_counters_period_type CHECK (period_type IN ('daily', 'monthly', 'total')),
  CONSTRAINT ck_usage_counters_total_period CHECK (period_type <> 'total' OR period_start = DATE '1970-01-01'),
  CONSTRAINT ck_usage_counters_non_negative CHECK (bytes_in >= 0 AND bytes_out >= 0 AND session_count >= 0 AND session_time_s >= 0)
);
CREATE INDEX idx_usage_counters_org_period ON usage_counters (organization_id, period_type, period_start);
CREATE TRIGGER trg_usage_counters_updated_at BEFORE UPDATE ON usage_counters
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
