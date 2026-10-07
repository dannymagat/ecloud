-- ECLOUD migration 003: network (DATABASE_DESIGN.md §3.2).
SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------------------------
-- adapter_types (P, seeded in 011). Capability flags stay NULL until verified (D-028, D-034).
-- ---------------------------------------------------------------------------------------------
CREATE TABLE adapter_types (
  key                 text PRIMARY KEY,
  name                text NOT NULL,
  supports_coa        boolean,
  supports_rate_limit boolean,
  supports_vlan       boolean,
  capabilities        jsonb,
  verification_status text NOT NULL DEFAULT 'unknown',
  evidence_url        text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_adapter_types_key CHECK (key ~ '^[a-z][a-z0-9_]{1,63}$'),
  CONSTRAINT ck_adapter_types_verification_status CHECK (
    verification_status IN ('verified_code', 'verified_docs', 'proposed', 'unknown', 'requires_device_test')
  )
);
CREATE TRIGGER trg_adapter_types_updated_at BEFORE UPDATE ON adapter_types
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------------------------
-- network_devices (T) — physical units; serial is globally unique (one tenant at a time)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE network_devices (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       uuid NOT NULL,
  site_id               uuid NOT NULL,
  serial                text NOT NULL,
  mac                   macaddr,
  model                 text,
  firmware              text,
  mode                  text NOT NULL DEFAULT 'unknown',
  adapter_type_key      text,
  mgmt_status           text NOT NULL DEFAULT 'unknown',
  last_seen_at          timestamptz,
  reported_capabilities jsonb,
  wireguard_peer_id     uuid,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  deleted_at            timestamptz,
  CONSTRAINT fk_network_devices_organization_id FOREIGN KEY (organization_id)
    REFERENCES organizations (id) ON DELETE CASCADE,
  CONSTRAINT fk_network_devices_site_id FOREIGN KEY (site_id)
    REFERENCES sites (id) ON DELETE RESTRICT,
  CONSTRAINT fk_network_devices_adapter_type_key FOREIGN KEY (adapter_type_key)
    REFERENCES adapter_types (key) ON DELETE RESTRICT,
  CONSTRAINT ck_network_devices_mode CHECK (mode IN ('bridge', 'routed', 'unknown')),
  CONSTRAINT ck_network_devices_mgmt_status CHECK (mgmt_status IN ('unknown', 'online', 'offline'))
);
CREATE UNIQUE INDEX uq_network_devices_serial ON network_devices (lower(serial)) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX uq_network_devices_mac ON network_devices (mac) WHERE mac IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX idx_network_devices_org_site ON network_devices (organization_id, site_id);
CREATE INDEX idx_network_devices_last_seen ON network_devices (organization_id, last_seen_at);
CREATE TRIGGER trg_network_devices_updated_at BEFORE UPDATE ON network_devices
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------------------------
-- wireguard_peers (T) — hub address plan is platform-wide (tunnel_ip / public_key global)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE wireguard_peers (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       uuid NOT NULL,
  site_id               uuid NOT NULL,
  network_device_id     uuid,
  name                  text NOT NULL,
  public_key            text NOT NULL,
  tunnel_ip             inet NOT NULL,
  allowed_ips           cidr[] NOT NULL,
  endpoint              text,
  preshared_key_ref     text,
  persistent_keepalive_s integer,
  last_handshake_at     timestamptz,
  status                text NOT NULL DEFAULT 'active',
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_wireguard_peers_organization_id FOREIGN KEY (organization_id)
    REFERENCES organizations (id) ON DELETE CASCADE,
  CONSTRAINT fk_wireguard_peers_site_id FOREIGN KEY (site_id)
    REFERENCES sites (id) ON DELETE RESTRICT,
  CONSTRAINT fk_wireguard_peers_network_device_id FOREIGN KEY (network_device_id)
    REFERENCES network_devices (id) ON DELETE SET NULL,
  CONSTRAINT ck_wireguard_peers_status CHECK (status IN ('active', 'disabled')),
  CONSTRAINT ck_wireguard_peers_keepalive CHECK (persistent_keepalive_s IS NULL OR persistent_keepalive_s BETWEEN 1 AND 65535)
);
CREATE UNIQUE INDEX uq_wireguard_peers_public_key ON wireguard_peers (public_key);
CREATE UNIQUE INDEX uq_wireguard_peers_tunnel_ip ON wireguard_peers (tunnel_ip);
CREATE INDEX idx_wireguard_peers_org_site ON wireguard_peers (organization_id, site_id);
CREATE TRIGGER trg_wireguard_peers_updated_at BEFORE UPDATE ON wireguard_peers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE network_devices
  ADD CONSTRAINT fk_network_devices_wireguard_peer_id FOREIGN KEY (wireguard_peer_id)
    REFERENCES wireguard_peers (id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------------------------
-- nas_clients (T) — RADIUS identifies a client by source IP: nas_ip is globally unique (Q3)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE nas_clients (
  id                            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id               uuid NOT NULL,
  site_id                       uuid NOT NULL,
  network_device_id             uuid,
  name                          text NOT NULL,
  nas_identifier                text,
  nas_ip                        inet NOT NULL,
  adapter_type_key              text NOT NULL,
  secret_ref                    text NOT NULL,
  coa_port                      integer,
  coa_supported                 boolean,
  require_message_authenticator boolean NOT NULL DEFAULT true,
  status                        text NOT NULL DEFAULT 'active',
  created_at                    timestamptz NOT NULL DEFAULT now(),
  updated_at                    timestamptz NOT NULL DEFAULT now(),
  deleted_at                    timestamptz,
  CONSTRAINT fk_nas_clients_organization_id FOREIGN KEY (organization_id)
    REFERENCES organizations (id) ON DELETE CASCADE,
  CONSTRAINT fk_nas_clients_site_id FOREIGN KEY (site_id)
    REFERENCES sites (id) ON DELETE RESTRICT,
  CONSTRAINT fk_nas_clients_network_device_id FOREIGN KEY (network_device_id)
    REFERENCES network_devices (id) ON DELETE SET NULL,
  CONSTRAINT fk_nas_clients_adapter_type_key FOREIGN KEY (adapter_type_key)
    REFERENCES adapter_types (key) ON DELETE RESTRICT,
  CONSTRAINT ck_nas_clients_status CHECK (status IN ('active', 'disabled')),
  CONSTRAINT ck_nas_clients_coa_port CHECK (coa_port IS NULL OR coa_port BETWEEN 1 AND 65535)
);
CREATE UNIQUE INDEX uq_nas_clients_ip ON nas_clients (nas_ip) WHERE deleted_at IS NULL;
CREATE INDEX idx_nas_clients_org_site ON nas_clients (organization_id, site_id);
CREATE INDEX idx_nas_clients_identifier ON nas_clients (nas_identifier) WHERE nas_identifier IS NOT NULL;
CREATE TRIGGER trg_nas_clients_updated_at BEFORE UPDATE ON nas_clients
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
