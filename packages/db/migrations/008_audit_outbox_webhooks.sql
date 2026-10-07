-- ECLOUD migration 008: audit log, outbox, webhooks (DATABASE_DESIGN.md §3.1/§3.5, API_ARCHITECTURE.md "Outbox pattern").
SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------------------------
-- audit_logs (A) — organization_id NULL = platform-level action; 24-month retention (D-025)
-- ---------------------------------------------------------------------------------------------
CREATE SEQUENCE audit_logs_id_seq AS bigint;
CREATE TABLE audit_logs (
  id              bigint NOT NULL DEFAULT nextval('audit_logs_id_seq'),
  organization_id uuid,
  actor_type      text NOT NULL,
  actor_id        uuid,
  impersonator_id uuid,
  action          text NOT NULL,
  target_type     text,
  target_id       uuid,
  before          jsonb,
  after           jsonb,
  ip              inet,
  request_id      text,
  user_agent      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at),
  CONSTRAINT ck_audit_logs_actor_type CHECK (actor_type IN ('administrator', 'api_key', 'subscriber', 'system')),
  CONSTRAINT ck_audit_logs_action CHECK (action ~ '^[a-z][a-z0-9_]*(:[a-z][a-z0-9_]*)+$')
) PARTITION BY RANGE (created_at);
ALTER SEQUENCE audit_logs_id_seq OWNED BY audit_logs.id;
CREATE INDEX brin_audit_logs_created ON audit_logs USING brin (created_at);
CREATE INDEX idx_audit_logs_org_time ON audit_logs (organization_id, created_at DESC);
CREATE INDEX idx_audit_logs_actor_time ON audit_logs (actor_id, created_at DESC);
CREATE INDEX idx_audit_logs_target ON audit_logs (target_type, target_id);
CREATE TABLE audit_logs_default PARTITION OF audit_logs DEFAULT;
SELECT ensure_month_partitions('audit_logs'::regclass, 2);

-- ---------------------------------------------------------------------------------------------
-- outbox — written in the same transaction as the domain change; drained by the worker
-- (FOR UPDATE SKIP LOCKED) which sets published_at. Not append-only (published_at is updated).
-- ---------------------------------------------------------------------------------------------
CREATE TABLE outbox (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id uuid,
  event           text NOT NULL,
  payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
  request_id      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  published_at    timestamptz,
  CONSTRAINT ck_outbox_event CHECK (event ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$')
);
CREATE INDEX idx_outbox_unpublished ON outbox (id) WHERE published_at IS NULL;
CREATE INDEX idx_outbox_org_time ON outbox (organization_id, created_at);

-- ---------------------------------------------------------------------------------------------
-- webhooks (T) / webhook_deliveries (T, A) — 30-day retention for deliveries
-- ---------------------------------------------------------------------------------------------
CREATE TABLE webhooks (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL,
  name               text NOT NULL,
  url                text NOT NULL,
  events             text[] NOT NULL,
  signing_secret_ref text,
  enabled            boolean NOT NULL DEFAULT true,
  failure_count      integer NOT NULL DEFAULT 0,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_webhooks_organization_id FOREIGN KEY (organization_id)
    REFERENCES organizations (id) ON DELETE CASCADE,
  CONSTRAINT ck_webhooks_url CHECK (url ~ '^https?://'),
  CONSTRAINT ck_webhooks_events CHECK (cardinality(events) >= 1),
  CONSTRAINT ck_webhooks_failure_count CHECK (failure_count >= 0)
);
CREATE UNIQUE INDEX uq_webhooks_org_url ON webhooks (organization_id, url);
CREATE TRIGGER trg_webhooks_updated_at BEFORE UPDATE ON webhooks
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE SEQUENCE webhook_deliveries_id_seq AS bigint;
CREATE TABLE webhook_deliveries (
  id              bigint NOT NULL DEFAULT nextval('webhook_deliveries_id_seq'),
  organization_id uuid NOT NULL,
  webhook_id      uuid NOT NULL,
  event           text NOT NULL,
  payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
  status          text NOT NULL,
  http_status     integer,
  attempt         integer NOT NULL DEFAULT 1,
  error           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at),
  CONSTRAINT fk_webhook_deliveries_webhook_id FOREIGN KEY (webhook_id)
    REFERENCES webhooks (id) ON DELETE CASCADE,
  CONSTRAINT ck_webhook_deliveries_status CHECK (status IN ('success', 'failed', 'timeout')),
  CONSTRAINT ck_webhook_deliveries_attempt CHECK (attempt >= 1)
) PARTITION BY RANGE (created_at);
ALTER SEQUENCE webhook_deliveries_id_seq OWNED BY webhook_deliveries.id;
CREATE INDEX brin_webhook_deliveries_created ON webhook_deliveries USING brin (created_at);
CREATE INDEX idx_webhook_deliveries_org_webhook_time ON webhook_deliveries (organization_id, webhook_id, created_at DESC);
CREATE TABLE webhook_deliveries_default PARTITION OF webhook_deliveries DEFAULT;
SELECT ensure_month_partitions('webhook_deliveries'::regclass, 2);
