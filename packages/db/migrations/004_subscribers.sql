-- ECLOUD migration 004: subscribers, devices, identity (DATABASE_DESIGN.md §3.3).
SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------------------------
-- identity_providers (T) — config holds no secrets; client_secret_ref points at the secret store
-- ---------------------------------------------------------------------------------------------
CREATE TABLE identity_providers (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid NOT NULL,
  type              text NOT NULL,
  name              text NOT NULL,
  config            jsonb NOT NULL DEFAULT '{}'::jsonb,
  client_secret_ref text,
  enabled           boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_identity_providers_organization_id FOREIGN KEY (organization_id)
    REFERENCES organizations (id) ON DELETE CASCADE,
  CONSTRAINT ck_identity_providers_type CHECK (
    type IN ('local', 'oidc', 'google', 'facebook', 'saml', 'sms_otp', 'radius_proxy')
  )
);
CREATE UNIQUE INDEX uq_identity_providers_org_name ON identity_providers (organization_id, lower(name));
CREATE TRIGGER trg_identity_providers_updated_at BEFORE UPDATE ON identity_providers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------------------------
-- user_groups (T) — single primary group per subscriber (Q6 default)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE user_groups (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  site_id         uuid,
  name            text NOT NULL,
  description     text NOT NULL DEFAULT '',
  is_default      boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_user_groups_organization_id FOREIGN KEY (organization_id)
    REFERENCES organizations (id) ON DELETE CASCADE,
  CONSTRAINT fk_user_groups_site_id FOREIGN KEY (site_id)
    REFERENCES sites (id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX uq_user_groups_org_name ON user_groups (organization_id, lower(name));
CREATE UNIQUE INDEX uq_user_groups_org_default ON user_groups (organization_id) WHERE is_default;
CREATE TRIGGER trg_user_groups_updated_at BEFORE UPDATE ON user_groups
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------------------------
-- users (T) — subscribers; username unique per organization (Q1 default)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE users (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      uuid NOT NULL,
  site_id              uuid,
  username             text NOT NULL,
  password_hash        text,
  auth_methods         text[] NOT NULL DEFAULT '{password}',
  user_group_id        uuid,
  identity_provider_id uuid,
  external_subject     text,
  display_name         text,
  email                text,
  phone                text,
  status               text NOT NULL DEFAULT 'active',
  valid_from           timestamptz,
  valid_until          timestamptz,
  max_devices          integer,
  origin               text NOT NULL DEFAULT 'admin',
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  deleted_at           timestamptz,
  CONSTRAINT fk_users_organization_id FOREIGN KEY (organization_id)
    REFERENCES organizations (id) ON DELETE CASCADE,
  CONSTRAINT fk_users_site_id FOREIGN KEY (site_id)
    REFERENCES sites (id) ON DELETE RESTRICT,
  CONSTRAINT fk_users_user_group_id FOREIGN KEY (user_group_id)
    REFERENCES user_groups (id) ON DELETE SET NULL,
  CONSTRAINT fk_users_identity_provider_id FOREIGN KEY (identity_provider_id)
    REFERENCES identity_providers (id) ON DELETE RESTRICT,
  CONSTRAINT ck_users_username CHECK (length(username) BETWEEN 1 AND 253 AND username !~ '\s'),
  CONSTRAINT ck_users_auth_methods CHECK (
    cardinality(auth_methods) >= 1 AND auth_methods <@ ARRAY['password', 'mac', 'voucher', 'idp']::text[]
  ),
  CONSTRAINT ck_users_status CHECK (status IN ('active', 'suspended', 'expired', 'disabled')),
  CONSTRAINT ck_users_origin CHECK (origin IN ('admin', 'portal_signup', 'voucher', 'idp')),
  CONSTRAINT ck_users_validity CHECK (valid_from IS NULL OR valid_until IS NULL OR valid_until > valid_from),
  CONSTRAINT ck_users_max_devices CHECK (max_devices IS NULL OR max_devices > 0),
  CONSTRAINT ck_users_external_subject CHECK (
    (identity_provider_id IS NULL AND external_subject IS NULL) OR identity_provider_id IS NOT NULL
  )
);
CREATE UNIQUE INDEX uq_users_org_username ON users (organization_id, lower(username)) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX uq_users_idp_subject ON users (identity_provider_id, external_subject)
  WHERE identity_provider_id IS NOT NULL AND external_subject IS NOT NULL;
CREATE INDEX idx_users_org_group ON users (organization_id, user_group_id);
CREATE INDEX idx_users_org_status_valid ON users (organization_id, status, valid_until);
CREATE TRIGGER trg_users_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------------------------
-- client_devices (T) — MAC unique per tenant (the same phone can visit two tenants' sites)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE client_devices (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL,
  user_id          uuid,
  mac              macaddr NOT NULL,
  name             text,
  device_type      text,
  first_seen_at    timestamptz,
  last_seen_at     timestamptz,
  mac_auth_enabled boolean NOT NULL DEFAULT false,
  blocked          boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz,
  CONSTRAINT fk_client_devices_organization_id FOREIGN KEY (organization_id)
    REFERENCES organizations (id) ON DELETE CASCADE,
  CONSTRAINT fk_client_devices_user_id FOREIGN KEY (user_id)
    REFERENCES users (id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX uq_client_devices_org_mac ON client_devices (organization_id, mac) WHERE deleted_at IS NULL;
CREATE INDEX idx_client_devices_org_user ON client_devices (organization_id, user_id);
CREATE INDEX idx_client_devices_mac ON client_devices (mac);
CREATE TRIGGER trg_client_devices_updated_at BEFORE UPDATE ON client_devices
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
