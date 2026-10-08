-- ECLOUD migration 023: enforcement orchestration (Phase 7 P7-A). Additive only.
--
-- 1. session_enforcement (T): per-session enforcement state of a policy change or a runtime
--    breach (POLICY_ENGINE.md §5.2-5.3, AAA_ARCHITECTURE.md §14 proposal "sessions.enforcement_state
--    ... to replace the Redis enforcement pending hash"). One row per (session, change); at most
--    one `pending` row per session (a newer change supersedes it).
--      strategy : coa_change | disconnect_reauth | next_reauth | none   (chosen from adapter
--                 evidence; coa_change / disconnect_reauth only with LAB/PRODUCTION evidence, D-028 V12)
--      state    : pending | applied | unsupported | superseded
-- 2. accounting_anomalies (T): vendor-quirk anomalies seen by the accounting drainer (SIM-14:
--    32-bit counter wrap without Gigawords), with whether usage was corrected and why.
-- 3. sessions.input_wrap_offset / output_wrap_offset: bytes added to the raw 32-bit counters of
--    a session after an unambiguous wrap (sessions.input_octets = offset + raw counter).
SET LOCAL lock_timeout = '5s';

CREATE TABLE session_enforcement (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid NOT NULL,
  session_id        uuid NOT NULL,
  change_id         uuid NOT NULL,
  trigger           text NOT NULL,
  strategy          text NOT NULL,
  state             text NOT NULL DEFAULT 'pending',
  reason            text NOT NULL,
  policy_id         uuid,
  previous_hash     text,
  target_hash       text,
  detail            jsonb NOT NULL DEFAULT '{}'::jsonb,
  expected_apply_by timestamptz,
  created_by        uuid,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  resolved_at       timestamptz,
  CONSTRAINT fk_session_enforcement_organization_id FOREIGN KEY (organization_id)
    REFERENCES organizations (id) ON DELETE CASCADE,
  CONSTRAINT fk_session_enforcement_session_id FOREIGN KEY (session_id)
    REFERENCES sessions (id) ON DELETE CASCADE,
  CONSTRAINT fk_session_enforcement_policy_id FOREIGN KEY (policy_id)
    REFERENCES policies (id) ON DELETE SET NULL,
  CONSTRAINT fk_session_enforcement_created_by FOREIGN KEY (created_by)
    REFERENCES administrators (id) ON DELETE SET NULL,
  CONSTRAINT ck_session_enforcement_trigger CHECK (trigger IN (
    'policy_update', 'policy_delete', 'assignment_create', 'assignment_delete',
    'quota_breach', 'schedule_end', 'concurrency'
  )),
  CONSTRAINT ck_session_enforcement_strategy CHECK (
    strategy IN ('coa_change', 'disconnect_reauth', 'next_reauth', 'none')
  ),
  CONSTRAINT ck_session_enforcement_state CHECK (
    state IN ('pending', 'applied', 'unsupported', 'superseded')
  ),
  CONSTRAINT ck_session_enforcement_reason CHECK (length(reason) BETWEEN 1 AND 1000),
  CONSTRAINT ck_session_enforcement_resolved CHECK ((state = 'pending') = (resolved_at IS NULL))
);
CREATE UNIQUE INDEX uq_session_enforcement_pending ON session_enforcement (session_id)
  WHERE state = 'pending';
CREATE INDEX idx_session_enforcement_org_session ON session_enforcement (organization_id, session_id, created_at DESC);
CREATE INDEX idx_session_enforcement_org_state ON session_enforcement (organization_id, state, created_at DESC);
CREATE INDEX idx_session_enforcement_change ON session_enforcement (change_id);
CREATE TRIGGER trg_session_enforcement_updated_at BEFORE UPDATE ON session_enforcement
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
SELECT enable_tenant_rls('session_enforcement'::regclass);

CREATE TABLE accounting_anomalies (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      uuid NOT NULL,
  session_id           uuid NOT NULL,
  nas_client_id        uuid NOT NULL,
  adapter_key          text NOT NULL,
  kind                 text NOT NULL,
  counter              text NOT NULL,
  previous             bigint NOT NULL,
  observed             bigint NOT NULL,
  estimated_lost_bytes bigint NOT NULL,
  applied              boolean NOT NULL,
  reason               text NOT NULL,
  radacct_id           bigint NOT NULL,
  detail               jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_accounting_anomalies_organization_id FOREIGN KEY (organization_id)
    REFERENCES organizations (id) ON DELETE CASCADE,
  CONSTRAINT fk_accounting_anomalies_session_id FOREIGN KEY (session_id)
    REFERENCES sessions (id) ON DELETE CASCADE,
  CONSTRAINT ck_accounting_anomalies_kind CHECK (kind IN ('counter_wrap_32bit')),
  CONSTRAINT ck_accounting_anomalies_counter CHECK (counter IN ('inputOctets', 'outputOctets')),
  CONSTRAINT ck_accounting_anomalies_values CHECK (
    previous >= 0 AND observed >= 0 AND estimated_lost_bytes >= 0
  )
);
-- One anomaly row per (raw record, counter): a crash-retried drain must not double-correct.
CREATE UNIQUE INDEX uq_accounting_anomalies_record ON accounting_anomalies (radacct_id, counter);
CREATE INDEX idx_accounting_anomalies_org_session ON accounting_anomalies (organization_id, session_id, created_at DESC);
SELECT enable_tenant_rls('accounting_anomalies'::regclass);

ALTER TABLE sessions
  ADD COLUMN input_wrap_offset  bigint NOT NULL DEFAULT 0,
  ADD COLUMN output_wrap_offset bigint NOT NULL DEFAULT 0,
  ADD CONSTRAINT ck_sessions_wrap_offsets CHECK (input_wrap_offset >= 0 AND output_wrap_offset >= 0);

-- Grants: both tables follow the default tenant-table grants of migration 010 (ALTER DEFAULT
-- PRIVILEGES); restated explicitly so the chain is independent of who ran 010.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ecloud_app') THEN
    RAISE NOTICE 'role ecloud_app does not exist: enforcement grants skipped';
    RETURN;
  END IF;
  EXECUTE 'GRANT SELECT, INSERT, UPDATE ON TABLE session_enforcement TO ecloud_app';
  EXECUTE 'GRANT SELECT ON TABLE accounting_anomalies TO ecloud_app';
END
$$;
