-- ECLOUD migration 006: captive portal (DATABASE_DESIGN.md §3.6, MULTITENANCY.md §5 G1).
SET LOCAL lock_timeout = '5s';

CREATE TABLE portal_themes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  name            text NOT NULL,
  logo_asset_ref  text,
  colors          jsonb NOT NULL DEFAULT '{}'::jsonb,
  strings         jsonb NOT NULL DEFAULT '{}'::jsonb,
  custom_css      text,
  version         integer NOT NULL DEFAULT 1,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_portal_themes_organization_id FOREIGN KEY (organization_id)
    REFERENCES organizations (id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX uq_portal_themes_org_name ON portal_themes (organization_id, lower(name));
CREATE TRIGGER trg_portal_themes_updated_at BEFORE UPDATE ON portal_themes
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- public_slug is global: the portal URL identifies site -> tenant (guard G1)
CREATE TABLE captive_portals (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       uuid NOT NULL,
  site_id               uuid NOT NULL,
  name                  text NOT NULL,
  public_slug           text NOT NULL,
  portal_type           text NOT NULL,
  network_ref           text NOT NULL,
  theme_id              uuid,
  auth_methods          text[] NOT NULL DEFAULT '{}',
  identity_provider_ids uuid[] NOT NULL DEFAULT '{}',
  uam_secret_ref        text,
  redirect_url          text,
  terms_version         text,
  walled_garden         text[] NOT NULL DEFAULT '{}',
  adapter_config        jsonb NOT NULL DEFAULT '{}'::jsonb,
  status                text NOT NULL DEFAULT 'active',
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_captive_portals_organization_id FOREIGN KEY (organization_id)
    REFERENCES organizations (id) ON DELETE CASCADE,
  CONSTRAINT fk_captive_portals_site_id FOREIGN KEY (site_id)
    REFERENCES sites (id) ON DELETE CASCADE,
  CONSTRAINT fk_captive_portals_theme_id FOREIGN KEY (theme_id)
    REFERENCES portal_themes (id) ON DELETE SET NULL,
  CONSTRAINT ck_captive_portals_portal_type CHECK (portal_type IN ('uspot', 'coovachilli', 'external')),
  CONSTRAINT ck_captive_portals_status CHECK (status IN ('active', 'disabled')),
  CONSTRAINT ck_captive_portals_public_slug CHECK (public_slug ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$'),
  CONSTRAINT ck_captive_portals_auth_methods CHECK (
    auth_methods <@ ARRAY['password', 'mac', 'voucher', 'idp', 'click_through']::text[]
  )
);
CREATE UNIQUE INDEX uq_captive_portals_site_network ON captive_portals (site_id, network_ref);
CREATE UNIQUE INDEX uq_captive_portals_public_slug ON captive_portals (public_slug);
CREATE INDEX idx_captive_portals_org_site ON captive_portals (organization_id, site_id);
CREATE TRIGGER trg_captive_portals_updated_at BEFORE UPDATE ON captive_portals
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- portal_login_attempts (T, A): monthly partitions, 90-day retention
CREATE SEQUENCE portal_login_attempts_id_seq AS bigint;
CREATE TABLE portal_login_attempts (
  id                      bigint NOT NULL DEFAULT nextval('portal_login_attempts_id_seq'),
  organization_id         uuid NOT NULL,
  captive_portal_id       uuid NOT NULL,
  method                  text NOT NULL,
  username_or_code_prefix text,
  mac                     macaddr,
  client_ip               inet,
  result                  text NOT NULL,
  reason                  text,
  created_at              timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at),
  CONSTRAINT ck_portal_login_attempts_result CHECK (result IN ('accept', 'reject', 'error'))
) PARTITION BY RANGE (created_at);
ALTER SEQUENCE portal_login_attempts_id_seq OWNED BY portal_login_attempts.id;
CREATE INDEX brin_portal_login_attempts_created ON portal_login_attempts USING brin (created_at);
CREATE INDEX idx_portal_login_attempts_org_time ON portal_login_attempts (organization_id, created_at);
CREATE INDEX idx_portal_login_attempts_org_portal ON portal_login_attempts (organization_id, captive_portal_id, created_at);
CREATE TABLE portal_login_attempts_default PARTITION OF portal_login_attempts DEFAULT;
SELECT ensure_month_partitions('portal_login_attempts'::regclass, 2);
