-- ECLOUD migration 005: policy intent model and vouchers (DATABASE_DESIGN.md §3.4, §3.6).
-- Policies store INTENT only; device attributes live in policy_translations (what was emitted).
SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------------------------
-- schedules (T)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE schedules (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  name            text NOT NULL,
  timezone        text NOT NULL,
  rules           jsonb NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_schedules_organization_id FOREIGN KEY (organization_id)
    REFERENCES organizations (id) ON DELETE CASCADE,
  CONSTRAINT ck_schedules_rules_is_array CHECK (jsonb_typeof(rules) = 'array')
);
CREATE UNIQUE INDEX uq_schedules_org_name ON schedules (organization_id, lower(name));
CREATE TRIGGER trg_schedules_updated_at BEFORE UPDATE ON schedules
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------------------------
-- policies (T) — every D-028 policy type is modelled; enforcement is staged in the adapters
-- ---------------------------------------------------------------------------------------------
CREATE TABLE policies (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id         uuid NOT NULL,
  site_id                 uuid,
  name                    text NOT NULL,
  description             text NOT NULL DEFAULT '',
  scope_type              text NOT NULL,
  download_rate_kbps      integer,
  upload_rate_kbps        integer,
  burst_download_kbps     integer,
  burst_upload_kbps       integer,
  burst_duration_s        integer,
  quota_daily_bytes       bigint,
  quota_monthly_bytes     bigint,
  quota_total_bytes       bigint,
  session_timeout_s       integer,
  idle_timeout_s          integer,
  max_concurrent_sessions integer,
  max_devices             integer,
  valid_from              timestamptz,
  valid_until             timestamptz,
  vlan_id                 integer,
  schedule_id             uuid,
  priority                integer NOT NULL DEFAULT 100,
  is_default              boolean NOT NULL DEFAULT false,
  status                  text NOT NULL DEFAULT 'draft',
  version                 integer NOT NULL DEFAULT 1,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  deleted_at              timestamptz,
  CONSTRAINT fk_policies_organization_id FOREIGN KEY (organization_id)
    REFERENCES organizations (id) ON DELETE CASCADE,
  CONSTRAINT fk_policies_site_id FOREIGN KEY (site_id)
    REFERENCES sites (id) ON DELETE RESTRICT,
  CONSTRAINT fk_policies_schedule_id FOREIGN KEY (schedule_id)
    REFERENCES schedules (id) ON DELETE RESTRICT,
  CONSTRAINT ck_policies_scope_type CHECK (scope_type IN ('user', 'group', 'site', 'temporary')),
  CONSTRAINT ck_policies_status CHECK (status IN ('draft', 'active', 'retired')),
  CONSTRAINT ck_policies_vlan_id CHECK (vlan_id IS NULL OR vlan_id BETWEEN 1 AND 4094),
  CONSTRAINT ck_policies_rates_positive CHECK (
    (download_rate_kbps      IS NULL OR download_rate_kbps      > 0) AND
    (upload_rate_kbps        IS NULL OR upload_rate_kbps        > 0) AND
    (burst_download_kbps     IS NULL OR burst_download_kbps     > 0) AND
    (burst_upload_kbps       IS NULL OR burst_upload_kbps       > 0) AND
    (burst_duration_s        IS NULL OR burst_duration_s        > 0) AND
    (quota_daily_bytes       IS NULL OR quota_daily_bytes       > 0) AND
    (quota_monthly_bytes     IS NULL OR quota_monthly_bytes     > 0) AND
    (quota_total_bytes       IS NULL OR quota_total_bytes       > 0) AND
    (session_timeout_s       IS NULL OR session_timeout_s       > 0) AND
    (idle_timeout_s          IS NULL OR idle_timeout_s          > 0) AND
    (max_concurrent_sessions IS NULL OR max_concurrent_sessions > 0) AND
    (max_devices             IS NULL OR max_devices             > 0)
  ),
  CONSTRAINT ck_policies_validity CHECK (valid_from IS NULL OR valid_until IS NULL OR valid_until > valid_from),
  CONSTRAINT ck_policies_version CHECK (version >= 1)
);
CREATE UNIQUE INDEX uq_policies_org_name ON policies (organization_id, lower(name)) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX uq_policies_org_default ON policies (organization_id) WHERE is_default AND deleted_at IS NULL;
CREATE INDEX idx_policies_org_status ON policies (organization_id, status);
CREATE TRIGGER trg_policies_updated_at BEFORE UPDATE ON policies
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------------------------
-- voucher_batches / vouchers (T) — codes are hashed (HMAC-SHA-256 with a server pepper)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE voucher_batches (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  site_id         uuid,
  name            text NOT NULL,
  policy_id       uuid,
  count           integer NOT NULL,
  code_format     text NOT NULL DEFAULT 'alnum-8',
  valid_from      timestamptz,
  valid_until     timestamptz,
  duration_s      integer,
  max_uses        integer NOT NULL DEFAULT 1,
  max_devices     integer NOT NULL DEFAULT 1,
  created_by      uuid,
  exported_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_voucher_batches_organization_id FOREIGN KEY (organization_id)
    REFERENCES organizations (id) ON DELETE CASCADE,
  CONSTRAINT fk_voucher_batches_site_id FOREIGN KEY (site_id)
    REFERENCES sites (id) ON DELETE RESTRICT,
  CONSTRAINT fk_voucher_batches_policy_id FOREIGN KEY (policy_id)
    REFERENCES policies (id) ON DELETE RESTRICT,
  CONSTRAINT fk_voucher_batches_created_by FOREIGN KEY (created_by)
    REFERENCES administrators (id) ON DELETE SET NULL,
  CONSTRAINT ck_voucher_batches_count CHECK (count BETWEEN 1 AND 100000),
  CONSTRAINT ck_voucher_batches_limits CHECK (max_uses > 0 AND max_devices > 0 AND (duration_s IS NULL OR duration_s > 0)),
  CONSTRAINT ck_voucher_batches_validity CHECK (valid_from IS NULL OR valid_until IS NULL OR valid_until > valid_from)
);
CREATE UNIQUE INDEX uq_voucher_batches_org_name ON voucher_batches (organization_id, lower(name));
CREATE INDEX idx_voucher_batches_org_site ON voucher_batches (organization_id, site_id);
CREATE TRIGGER trg_voucher_batches_updated_at BEFORE UPDATE ON voucher_batches
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE vouchers (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  batch_id        uuid NOT NULL,
  code_hash       text NOT NULL,
  code_hint       text,
  code_enc        text,
  status          text NOT NULL DEFAULT 'unused',
  activated_at    timestamptz,
  expires_at      timestamptz,
  use_count       integer NOT NULL DEFAULT 0,
  bound_user_id   uuid,
  revoked_by      uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz,
  CONSTRAINT fk_vouchers_organization_id FOREIGN KEY (organization_id)
    REFERENCES organizations (id) ON DELETE CASCADE,
  CONSTRAINT fk_vouchers_batch_id FOREIGN KEY (batch_id)
    REFERENCES voucher_batches (id) ON DELETE CASCADE,
  CONSTRAINT fk_vouchers_bound_user_id FOREIGN KEY (bound_user_id)
    REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_vouchers_revoked_by FOREIGN KEY (revoked_by)
    REFERENCES administrators (id) ON DELETE SET NULL,
  CONSTRAINT ck_vouchers_status CHECK (status IN ('unused', 'active', 'exhausted', 'expired', 'revoked')),
  CONSTRAINT ck_vouchers_use_count CHECK (use_count >= 0)
);
-- global: a code presented on any portal resolves to exactly one tenant (MULTITENANCY.md §3.2)
CREATE UNIQUE INDEX uq_vouchers_code_hash ON vouchers (code_hash);
CREATE INDEX idx_vouchers_org_batch_status ON vouchers (organization_id, batch_id, status);
CREATE TRIGGER trg_vouchers_updated_at BEFORE UPDATE ON vouchers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------------------------
-- policy_assignments (T) — real FK columns instead of a polymorphic target_id
-- ---------------------------------------------------------------------------------------------
CREATE TABLE policy_assignments (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL,
  policy_id        uuid NOT NULL,
  target_type      text NOT NULL,
  user_id          uuid,
  user_group_id    uuid,
  site_id          uuid,
  client_device_id uuid,
  voucher_batch_id uuid,
  effective_from   timestamptz NOT NULL DEFAULT now(),
  effective_until  timestamptz,
  priority         integer NOT NULL DEFAULT 100,
  created_by       uuid,
  note             text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_policy_assignments_organization_id FOREIGN KEY (organization_id)
    REFERENCES organizations (id) ON DELETE CASCADE,
  CONSTRAINT fk_policy_assignments_policy_id FOREIGN KEY (policy_id)
    REFERENCES policies (id) ON DELETE CASCADE,
  CONSTRAINT fk_policy_assignments_user_id FOREIGN KEY (user_id)
    REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_policy_assignments_user_group_id FOREIGN KEY (user_group_id)
    REFERENCES user_groups (id) ON DELETE CASCADE,
  CONSTRAINT fk_policy_assignments_site_id FOREIGN KEY (site_id)
    REFERENCES sites (id) ON DELETE CASCADE,
  CONSTRAINT fk_policy_assignments_client_device_id FOREIGN KEY (client_device_id)
    REFERENCES client_devices (id) ON DELETE CASCADE,
  CONSTRAINT fk_policy_assignments_voucher_batch_id FOREIGN KEY (voucher_batch_id)
    REFERENCES voucher_batches (id) ON DELETE CASCADE,
  CONSTRAINT fk_policy_assignments_created_by FOREIGN KEY (created_by)
    REFERENCES administrators (id) ON DELETE SET NULL,
  CONSTRAINT ck_policy_assignments_target_type CHECK (
    target_type IN ('user', 'user_group', 'site', 'client_device', 'voucher_batch')
  ),
  CONSTRAINT ck_policy_assignments_one_target CHECK (
    (target_type = 'user'          AND user_id IS NOT NULL AND user_group_id IS NULL     AND site_id IS NULL     AND client_device_id IS NULL     AND voucher_batch_id IS NULL) OR
    (target_type = 'user_group'    AND user_id IS NULL     AND user_group_id IS NOT NULL AND site_id IS NULL     AND client_device_id IS NULL     AND voucher_batch_id IS NULL) OR
    (target_type = 'site'          AND user_id IS NULL     AND user_group_id IS NULL     AND site_id IS NOT NULL AND client_device_id IS NULL     AND voucher_batch_id IS NULL) OR
    (target_type = 'client_device' AND user_id IS NULL     AND user_group_id IS NULL     AND site_id IS NULL     AND client_device_id IS NOT NULL AND voucher_batch_id IS NULL) OR
    (target_type = 'voucher_batch' AND user_id IS NULL     AND user_group_id IS NULL     AND site_id IS NULL     AND client_device_id IS NULL     AND voucher_batch_id IS NOT NULL)
  ),
  CONSTRAINT ck_policy_assignments_window CHECK (effective_until IS NULL OR effective_until > effective_from)
);
CREATE UNIQUE INDEX uq_policy_assignments_active ON policy_assignments (
  policy_id, target_type,
  coalesce(user_id,          '00000000-0000-0000-0000-000000000000'::uuid),
  coalesce(user_group_id,    '00000000-0000-0000-0000-000000000000'::uuid),
  coalesce(site_id,          '00000000-0000-0000-0000-000000000000'::uuid),
  coalesce(client_device_id, '00000000-0000-0000-0000-000000000000'::uuid),
  coalesce(voucher_batch_id, '00000000-0000-0000-0000-000000000000'::uuid)
) WHERE effective_until IS NULL;
-- §7: one partial index per target column. now() is not IMMUTABLE, so the predicate is
-- "open-ended" only; the engine filters effective_until > now() at query time.
CREATE INDEX idx_policy_assignments_org_user ON policy_assignments (organization_id, user_id) WHERE effective_until IS NULL;
CREATE INDEX idx_policy_assignments_org_group ON policy_assignments (organization_id, user_group_id) WHERE effective_until IS NULL;
CREATE INDEX idx_policy_assignments_org_site ON policy_assignments (organization_id, site_id) WHERE effective_until IS NULL;
CREATE INDEX idx_policy_assignments_org_device ON policy_assignments (organization_id, client_device_id) WHERE effective_until IS NULL;
CREATE INDEX idx_policy_assignments_org_batch ON policy_assignments (organization_id, voucher_batch_id) WHERE effective_until IS NULL;
CREATE INDEX idx_policy_assignments_org_policy ON policy_assignments (organization_id, policy_id);
CREATE TRIGGER trg_policy_assignments_updated_at BEFORE UPDATE ON policy_assignments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------------------------
-- policy_translations (T, A) — what each adapter emitted for a resolved intent; monthly partitions
-- PG16 does not allow identity columns on partitioned tables: explicit sequence instead.
-- ---------------------------------------------------------------------------------------------
CREATE SEQUENCE policy_translations_id_seq AS bigint;
CREATE TABLE policy_translations (
  id               bigint NOT NULL DEFAULT nextval('policy_translations_id_seq'),
  organization_id  uuid NOT NULL,
  policy_id        uuid,
  policy_version   integer NOT NULL,
  adapter_type_key text NOT NULL,
  adapter_version  text,
  nas_client_id    uuid,
  session_id       uuid,
  trigger          text NOT NULL,
  input_snapshot   jsonb NOT NULL DEFAULT '{}'::jsonb,
  emitted          jsonb NOT NULL DEFAULT '{}'::jsonb,
  unsupported      jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at),
  CONSTRAINT fk_policy_translations_policy_id FOREIGN KEY (policy_id)
    REFERENCES policies (id) ON DELETE SET NULL,
  CONSTRAINT ck_policy_translations_trigger CHECK (trigger IN ('authorize', 'coa', 'preview', 'config_push'))
) PARTITION BY RANGE (created_at);
ALTER SEQUENCE policy_translations_id_seq OWNED BY policy_translations.id;
CREATE INDEX brin_policy_translations_created ON policy_translations USING brin (created_at);
CREATE INDEX idx_policy_translations_session ON policy_translations (session_id);
CREATE INDEX idx_policy_translations_org_policy_time ON policy_translations (organization_id, policy_id, created_at);
CREATE TABLE policy_translations_default PARTITION OF policy_translations DEFAULT;
SELECT ensure_month_partitions('policy_translations'::regclass, 2);
