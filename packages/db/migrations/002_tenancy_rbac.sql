-- ECLOUD migration 002: tenancy, administration, RBAC (DATABASE_DESIGN.md §3.1, MULTITENANCY.md §4).
SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------------------------
-- organizations (P)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE organizations (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug                    text NOT NULL,
  name                    text NOT NULL,
  status                  text NOT NULL DEFAULT 'active',
  settings                jsonb NOT NULL DEFAULT '{}'::jsonb,
  max_sites               integer,
  max_devices             integer,
  max_users               integer,
  max_concurrent_sessions integer,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  deleted_at              timestamptz,
  CONSTRAINT ck_organizations_status CHECK (status IN ('active', 'suspended', 'archived')),
  CONSTRAINT ck_organizations_slug CHECK (slug ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$')
);
CREATE UNIQUE INDEX uq_organizations_slug ON organizations (lower(slug)) WHERE deleted_at IS NULL;
CREATE TRIGGER trg_organizations_updated_at BEFORE UPDATE ON organizations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------------------------
-- sites (T)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE sites (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  slug            text NOT NULL,
  name            text NOT NULL,
  timezone        text NOT NULL DEFAULT 'UTC',
  address         text,
  geo             point,
  status          text NOT NULL DEFAULT 'active',
  settings        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz,
  CONSTRAINT fk_sites_organization_id FOREIGN KEY (organization_id)
    REFERENCES organizations (id) ON DELETE RESTRICT,
  CONSTRAINT ck_sites_status CHECK (status IN ('active', 'suspended', 'archived'))
);
CREATE UNIQUE INDEX uq_sites_org_slug ON sites (organization_id, lower(slug)) WHERE deleted_at IS NULL;
CREATE INDEX idx_sites_org ON sites (organization_id);
CREATE TRIGGER trg_sites_updated_at BEFORE UPDATE ON sites
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------------------------
-- administrators (P) — one global account per email (MULTITENANCY.md §3.1, Q7)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE administrators (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL,
  display_name  text NOT NULL DEFAULT '',
  password_hash text,
  status        text NOT NULL DEFAULT 'invited',
  mfa_enforced  boolean NOT NULL DEFAULT false,
  last_login_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz,
  CONSTRAINT ck_administrators_status CHECK (status IN ('invited', 'active', 'disabled')),
  CONSTRAINT ck_administrators_email CHECK (email = lower(btrim(email)) AND position('@' IN email) > 1)
);
CREATE UNIQUE INDEX uq_administrators_email ON administrators (lower(email)) WHERE deleted_at IS NULL;
CREATE TRIGGER trg_administrators_updated_at BEFORE UPDATE ON administrators
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------------------------
-- admin_sessions (P) — opaque server-side session; impersonation recorded here (§4.5)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE admin_sessions (
  id                           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  administrator_id             uuid NOT NULL,
  token_hash                   text NOT NULL,
  ip                           inet,
  user_agent                   text,
  impersonating_organization_id uuid,
  impersonation_reason         text,
  expires_at                   timestamptz NOT NULL,
  last_seen_at                 timestamptz,
  revoked_at                   timestamptz,
  created_at                   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_admin_sessions_administrator_id FOREIGN KEY (administrator_id)
    REFERENCES administrators (id) ON DELETE CASCADE,
  CONSTRAINT fk_admin_sessions_impersonating_organization_id FOREIGN KEY (impersonating_organization_id)
    REFERENCES organizations (id) ON DELETE SET NULL,
  CONSTRAINT ck_admin_sessions_impersonation_reason CHECK (
    impersonating_organization_id IS NULL OR impersonation_reason IS NOT NULL
  )
);
CREATE UNIQUE INDEX uq_admin_sessions_token_hash ON admin_sessions (token_hash);
CREATE INDEX idx_admin_sessions_admin_active ON admin_sessions (administrator_id) WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------------------------------------
-- mfa_credentials (P) — TOTP (otplib). The TOTP secret must be recoverable to verify codes, so
-- it is stored encrypted with the server key (secret_enc), never in clear; recovery codes are
-- hashed (DATABASE_DESIGN.md §1 "Secrets").
-- ---------------------------------------------------------------------------------------------
CREATE TABLE mfa_credentials (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  administrator_id    uuid NOT NULL,
  type                text NOT NULL DEFAULT 'totp',
  label               text,
  secret_enc          text NOT NULL,
  recovery_codes_hash text[] NOT NULL DEFAULT '{}',
  verified_at         timestamptz,
  last_used_at        timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_mfa_credentials_administrator_id FOREIGN KEY (administrator_id)
    REFERENCES administrators (id) ON DELETE CASCADE,
  CONSTRAINT ck_mfa_credentials_type CHECK (type IN ('totp'))
);
CREATE UNIQUE INDEX uq_mfa_credentials_admin_type ON mfa_credentials (administrator_id, type);
CREATE TRIGGER trg_mfa_credentials_updated_at BEFORE UPDATE ON mfa_credentials
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------------------------
-- permissions (P, seeded by `ecloud-db seed` from @ecloud/shared PERMISSION_CATALOGUE)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE permissions (
  key              text PRIMARY KEY,
  resource         text NOT NULL,
  action           text NOT NULL,
  description      text NOT NULL DEFAULT '',
  min_scope        text NOT NULL,
  is_platform_only boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_permissions_key CHECK (key ~ '^[a-z][a-z0-9_]*(:[a-z][a-z0-9_]*)+$'),
  CONSTRAINT ck_permissions_min_scope CHECK (min_scope IN ('platform', 'organization', 'site'))
);
CREATE TRIGGER trg_permissions_updated_at BEFORE UPDATE ON permissions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------------------------
-- roles (P/T): organization_id NULL = platform role template (is_template = true)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE roles (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid,
  key              text NOT NULL,
  name             text NOT NULL,
  description      text NOT NULL DEFAULT '',
  is_template      boolean NOT NULL DEFAULT false,
  -- template this role was copied from (copy-on-write, MULTITENANCY.md §4.3)
  template_key     text,
  template_version integer NOT NULL DEFAULT 1,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_roles_organization_id FOREIGN KEY (organization_id)
    REFERENCES organizations (id) ON DELETE CASCADE,
  CONSTRAINT ck_roles_key CHECK (key ~ '^[a-z][a-z0-9_]{1,63}$'),
  CONSTRAINT ck_roles_template_is_platform CHECK (NOT is_template OR organization_id IS NULL)
);
CREATE UNIQUE INDEX uq_roles_platform_key ON roles (key) WHERE organization_id IS NULL;
CREATE UNIQUE INDEX uq_roles_org_key ON roles (organization_id, key) WHERE organization_id IS NOT NULL;
CREATE TRIGGER trg_roles_updated_at BEFORE UPDATE ON roles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE role_permissions (
  role_id        uuid NOT NULL,
  permission_key text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (role_id, permission_key),
  CONSTRAINT fk_role_permissions_role_id FOREIGN KEY (role_id)
    REFERENCES roles (id) ON DELETE CASCADE,
  CONSTRAINT fk_role_permissions_permission_key FOREIGN KEY (permission_key)
    REFERENCES permissions (key) ON DELETE RESTRICT
);

-- ---------------------------------------------------------------------------------------------
-- role_bindings (P/T)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE role_bindings (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  administrator_id uuid NOT NULL,
  role_id          uuid NOT NULL,
  scope_type       text NOT NULL,
  organization_id  uuid,
  site_id          uuid,
  granted_by       uuid,
  expires_at       timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_role_bindings_administrator_id FOREIGN KEY (administrator_id)
    REFERENCES administrators (id) ON DELETE CASCADE,
  CONSTRAINT fk_role_bindings_role_id FOREIGN KEY (role_id)
    REFERENCES roles (id) ON DELETE CASCADE,
  CONSTRAINT fk_role_bindings_organization_id FOREIGN KEY (organization_id)
    REFERENCES organizations (id) ON DELETE CASCADE,
  CONSTRAINT fk_role_bindings_site_id FOREIGN KEY (site_id)
    REFERENCES sites (id) ON DELETE CASCADE,
  CONSTRAINT fk_role_bindings_granted_by FOREIGN KEY (granted_by)
    REFERENCES administrators (id) ON DELETE SET NULL,
  CONSTRAINT ck_role_bindings_scope_type CHECK (scope_type IN ('platform', 'organization', 'site')),
  CONSTRAINT ck_role_bindings_scope CHECK (
    (scope_type = 'platform'     AND organization_id IS NULL     AND site_id IS NULL) OR
    (scope_type = 'organization' AND organization_id IS NOT NULL AND site_id IS NULL) OR
    (scope_type = 'site'         AND organization_id IS NOT NULL AND site_id IS NOT NULL)
  )
);
CREATE UNIQUE INDEX uq_role_bindings ON role_bindings (
  administrator_id, role_id, scope_type,
  coalesce(organization_id, '00000000-0000-0000-0000-000000000000'::uuid),
  coalesce(site_id,         '00000000-0000-0000-0000-000000000000'::uuid)
);
CREATE INDEX idx_role_bindings_admin ON role_bindings (administrator_id);
CREATE INDEX idx_role_bindings_org ON role_bindings (organization_id);

-- ---------------------------------------------------------------------------------------------
-- api_keys (P/T): prefix for lookup, SHA-256 hash for verification; scope via role + scope_type
-- ---------------------------------------------------------------------------------------------
CREATE TABLE api_keys (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid,
  created_by      uuid,
  name            text NOT NULL,
  key_prefix      text NOT NULL,
  key_hash        text NOT NULL,
  role_id         uuid NOT NULL,
  scope_type      text NOT NULL,
  site_id         uuid,
  allowed_cidrs   cidr[],
  last_used_at    timestamptz,
  expires_at      timestamptz,
  revoked_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_api_keys_organization_id FOREIGN KEY (organization_id)
    REFERENCES organizations (id) ON DELETE CASCADE,
  CONSTRAINT fk_api_keys_created_by FOREIGN KEY (created_by)
    REFERENCES administrators (id) ON DELETE SET NULL,
  CONSTRAINT fk_api_keys_role_id FOREIGN KEY (role_id)
    REFERENCES roles (id) ON DELETE RESTRICT,
  CONSTRAINT fk_api_keys_site_id FOREIGN KEY (site_id)
    REFERENCES sites (id) ON DELETE CASCADE,
  CONSTRAINT ck_api_keys_scope_type CHECK (scope_type IN ('platform', 'organization', 'site')),
  CONSTRAINT ck_api_keys_scope CHECK (
    (scope_type = 'platform'     AND organization_id IS NULL     AND site_id IS NULL) OR
    (scope_type = 'organization' AND organization_id IS NOT NULL AND site_id IS NULL) OR
    (scope_type = 'site'         AND organization_id IS NOT NULL AND site_id IS NOT NULL)
  ),
  CONSTRAINT ck_api_keys_prefix CHECK (key_prefix ~ '^eck_[A-Za-z0-9]{4,32}$')
);
CREATE UNIQUE INDEX uq_api_keys_prefix ON api_keys (key_prefix);
CREATE INDEX idx_api_keys_org ON api_keys (organization_id);
CREATE TRIGGER trg_api_keys_updated_at BEFORE UPDATE ON api_keys
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------------------------
-- invitations (T)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE invitations (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id           uuid NOT NULL,
  email                     text NOT NULL,
  role_id                   uuid NOT NULL,
  scope_type                text NOT NULL,
  site_id                   uuid,
  token_hash                text NOT NULL,
  invited_by                uuid,
  expires_at                timestamptz NOT NULL,
  accepted_at               timestamptz,
  accepted_administrator_id uuid,
  created_at                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_invitations_organization_id FOREIGN KEY (organization_id)
    REFERENCES organizations (id) ON DELETE CASCADE,
  CONSTRAINT fk_invitations_role_id FOREIGN KEY (role_id)
    REFERENCES roles (id) ON DELETE CASCADE,
  CONSTRAINT fk_invitations_site_id FOREIGN KEY (site_id)
    REFERENCES sites (id) ON DELETE CASCADE,
  CONSTRAINT fk_invitations_invited_by FOREIGN KEY (invited_by)
    REFERENCES administrators (id) ON DELETE SET NULL,
  CONSTRAINT fk_invitations_accepted_administrator_id FOREIGN KEY (accepted_administrator_id)
    REFERENCES administrators (id) ON DELETE SET NULL,
  CONSTRAINT ck_invitations_scope_type CHECK (scope_type IN ('organization', 'site')),
  CONSTRAINT ck_invitations_scope CHECK (
    (scope_type = 'organization' AND site_id IS NULL) OR (scope_type = 'site' AND site_id IS NOT NULL)
  ),
  CONSTRAINT ck_invitations_email CHECK (email = lower(btrim(email)) AND position('@' IN email) > 1)
);
CREATE UNIQUE INDEX uq_invitations_token_hash ON invitations (token_hash);
CREATE INDEX idx_invitations_org_email ON invitations (organization_id, lower(email));
