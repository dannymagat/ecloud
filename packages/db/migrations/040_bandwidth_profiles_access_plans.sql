-- 040: reusable bandwidth profiles and access plans
-- (BANDWIDTH_MANAGEMENT_REQUIREMENTS.md §4 and §8, gap analysis §2.1 and §2.5).
--
-- The requirement is explicit at §3: "Do not combine authentication identity, a bandwidth
-- profile and a billing product into one inflexible entity." Today `policies` is all three at
-- once for anyone selling access — it holds the speeds, it is what a voucher batch points at,
-- and it is the only thing an operator can name. This migration separates the three concerns
-- without touching the one that is load-bearing:
--
--   bandwidth_profiles   speeds, reusable. "Guest 10/2" written once, referenced everywhere.
--   policies             the enforcement intent. UNCHANGED as a concept; the AAA path, the
--                        resolution layers and every adapter see exactly what they saw before.
--   access_plans         the commercial and presentational wrapper: code, price, order,
--                        eligibility, activation. Points at one policy.
--
-- Nothing in the authorize path reads access_plans. That is deliberate: a billing table must not
-- be able to break authentication. A plan resolves to its policy, and the policy engine carries
-- on as the single source of enforcement truth.
--
-- A policy with a profile may not also set its own rates. The alternative — profile as a default
-- that policy columns override — needs a precedence rule inside what is already a seven-layer
-- precedence system, and "which number won" would become a two-stage question. One answer per
-- field: either the profile supplies the rates or the policy does.

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------------------------
-- bandwidth_profiles (T) — §8 "maintain reusable speed presets"
-- ---------------------------------------------------------------------------------------------
-- Rates are kbit/s and sizes are seconds, the units the policy engine already uses end to end
-- (POLICY_ENGINE.md §1). §8 asks for bit/s storage; kbit/s is this platform's existing
-- convention, is unambiguous, and converting the whole engine to bit/s would be a rewrite of the
-- translation layer for no behavioural gain. Recorded as a deviation rather than silently.
CREATE TABLE bandwidth_profiles (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL,
  name                text NOT NULL,
  description         text NOT NULL DEFAULT '',
  download_rate_kbps  integer,
  upload_rate_kbps    integer,
  burst_download_kbps integer,
  burst_upload_kbps   integer,
  burst_duration_s    integer,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  deleted_at          timestamptz,
  CONSTRAINT fk_bandwidth_profiles_organization_id FOREIGN KEY (organization_id)
    REFERENCES organizations (id) ON DELETE CASCADE,
  CONSTRAINT ck_bandwidth_profiles_name CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  CONSTRAINT ck_bandwidth_profiles_rates_positive CHECK (
    (download_rate_kbps  IS NULL OR download_rate_kbps  > 0) AND
    (upload_rate_kbps    IS NULL OR upload_rate_kbps    > 0) AND
    (burst_download_kbps IS NULL OR burst_download_kbps > 0) AND
    (burst_upload_kbps   IS NULL OR burst_upload_kbps   > 0) AND
    (burst_duration_s    IS NULL OR burst_duration_s    > 0)
  ),
  -- A profile that sets nothing is not a preset, it is a name. The engine would resolve every
  -- field to inherit and the operator would believe a speed had been applied.
  CONSTRAINT ck_bandwidth_profiles_not_empty CHECK (
    download_rate_kbps IS NOT NULL OR upload_rate_kbps IS NOT NULL
  )
);
CREATE UNIQUE INDEX uq_bandwidth_profiles_org_name
  ON bandwidth_profiles (organization_id, lower(name)) WHERE deleted_at IS NULL;
CREATE TRIGGER trg_bandwidth_profiles_updated_at BEFORE UPDATE ON bandwidth_profiles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE bandwidth_profiles IS
  'Reusable speed presets (migration 040). Rates are kbit/s from the client perspective: download is to the client.';

-- ---------------------------------------------------------------------------------------------
-- policies.bandwidth_profile_id — the policy takes its rates from a profile, or sets its own
-- ---------------------------------------------------------------------------------------------
ALTER TABLE policies
  ADD COLUMN bandwidth_profile_id uuid,
  ADD CONSTRAINT fk_policies_bandwidth_profile_id FOREIGN KEY (bandwidth_profile_id)
    REFERENCES bandwidth_profiles (id) ON DELETE RESTRICT;

-- One answer per field. RESTRICT above for the same reason: deleting a profile that policies
-- reference would silently remove a rate limit from live sessions at their next authorization.
ALTER TABLE policies
  ADD CONSTRAINT ck_policies_profile_or_own_rates CHECK (
    bandwidth_profile_id IS NULL OR (
      download_rate_kbps  IS NULL AND
      upload_rate_kbps    IS NULL AND
      burst_download_kbps IS NULL AND
      burst_upload_kbps   IS NULL AND
      burst_duration_s    IS NULL
    )
  );

CREATE INDEX idx_policies_bandwidth_profile ON policies (bandwidth_profile_id)
  WHERE bandwidth_profile_id IS NOT NULL;

COMMENT ON COLUMN policies.bandwidth_profile_id IS
  'When set, the profile supplies every rate field and the policy may not set its own (migration 040). Resolution is unchanged: the rates are read from the profile before the engine sees them.';

-- ---------------------------------------------------------------------------------------------
-- access_plans (T) — §4. The commercial wrapper, never read by the authorize path.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE access_plans (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       uuid NOT NULL,
  site_id               uuid,
  policy_id             uuid NOT NULL,
  name                  text NOT NULL,
  -- §4 "short code": what an operator types and a receipt prints. Not a credential.
  code                  text,
  description           text NOT NULL DEFAULT '',
  -- §4 enabled/disabled, which is NOT policies.status: `retired` there is permanent and
  -- immutable, and an operator needs to take a plan off sale for a week and put it back.
  enabled               boolean NOT NULL DEFAULT true,
  is_default            boolean NOT NULL DEFAULT false,
  plan_type             text NOT NULL DEFAULT 'free',
  -- Minor units (cents, fils, …) so no plan is priced in floating point.
  price_minor           integer,
  currency              text,
  display_order         integer NOT NULL DEFAULT 0,
  -- §4 "eligible authentication methods". Empty = every method the portal offers.
  eligible_auth_methods text[] NOT NULL DEFAULT '{}',
  -- §4 validity duration, relative, counted from the activation trigger. Absolute windows stay
  -- on the policy (valid_from / valid_until); this is "24 hours from whenever it starts".
  validity_duration_s   integer,
  activation_trigger    text NOT NULL DEFAULT 'creation',
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  deleted_at            timestamptz,
  CONSTRAINT fk_access_plans_organization_id FOREIGN KEY (organization_id)
    REFERENCES organizations (id) ON DELETE CASCADE,
  CONSTRAINT fk_access_plans_site_id FOREIGN KEY (site_id)
    REFERENCES sites (id) ON DELETE CASCADE,
  -- RESTRICT: a plan without an enforcement intent is a product that cannot be delivered.
  CONSTRAINT fk_access_plans_policy_id FOREIGN KEY (policy_id)
    REFERENCES policies (id) ON DELETE RESTRICT,
  CONSTRAINT ck_access_plans_name CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  CONSTRAINT ck_access_plans_code CHECK (code IS NULL OR code ~ '^[A-Za-z0-9_-]{1,32}$'),
  CONSTRAINT ck_access_plans_plan_type CHECK (plan_type IN ('free', 'paid')),
  CONSTRAINT ck_access_plans_activation_trigger CHECK (
    activation_trigger IN ('creation', 'purchase', 'first_login')
  ),
  CONSTRAINT ck_access_plans_validity CHECK (validity_duration_s IS NULL OR validity_duration_s > 0),
  CONSTRAINT ck_access_plans_auth_methods CHECK (
    eligible_auth_methods <@ ARRAY[
      'password', 'voucher', 'click_through', 'email_otp', 'sms_otp', 'idp', 'mac'
    ]::text[]
  ),
  -- §14 "never mark a payment successful based on a redirect" begins here: a paid plan that
  -- cannot state its price is not sellable, and a free plan with a price is a contradiction.
  CONSTRAINT ck_access_plans_price CHECK (
    (plan_type = 'paid' AND price_minor IS NOT NULL AND price_minor > 0
       AND currency IS NOT NULL AND currency ~ '^[A-Z]{3}$')
    OR
    (plan_type = 'free' AND price_minor IS NULL AND currency IS NULL)
  ),
  -- 'purchase' only means something once money is involved.
  CONSTRAINT ck_access_plans_purchase_trigger CHECK (
    activation_trigger <> 'purchase' OR plan_type = 'paid'
  )
);
CREATE UNIQUE INDEX uq_access_plans_org_name
  ON access_plans (organization_id, lower(name)) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX uq_access_plans_org_code
  ON access_plans (organization_id, lower(code)) WHERE code IS NOT NULL AND deleted_at IS NULL;
-- One default per scope: per site where a site is named, one org-wide otherwise.
CREATE UNIQUE INDEX uq_access_plans_site_default
  ON access_plans (organization_id, site_id) WHERE is_default AND site_id IS NOT NULL AND deleted_at IS NULL;
CREATE UNIQUE INDEX uq_access_plans_org_default
  ON access_plans (organization_id) WHERE is_default AND site_id IS NULL AND deleted_at IS NULL;
CREATE INDEX idx_access_plans_org_order ON access_plans (organization_id, display_order);
CREATE TRIGGER trg_access_plans_updated_at BEFORE UPDATE ON access_plans
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE access_plans IS
  'Commercial and presentational wrapper over one policy (migration 040). Never read by the authorize path: a billing table must not be able to break authentication.';
COMMENT ON COLUMN access_plans.enabled IS
  'Off sale, reversibly. Distinct from policies.status, where retired is permanent and immutable.';
COMMENT ON COLUMN access_plans.validity_duration_s IS
  'Relative validity counted from activation_trigger. Absolute windows remain policies.valid_from / valid_until.';

ALTER TABLE bandwidth_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE bandwidth_profiles FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON bandwidth_profiles
  USING (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

ALTER TABLE access_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE access_plans FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON access_plans
  USING (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON bandwidth_profiles TO ecloud_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON access_plans TO ecloud_app;
