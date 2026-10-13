-- 034: RadSec (RFC 6614) per-NAS opt-in.
--
-- RADIUS over UDP is safe only on a trusted network: the shared secret protects nothing but
-- User-Password (and only through an MD5 construction), while usernames, MAC addresses, NAS
-- identity and accounting travel in clear. Moving the server to a cloud host means NAS traffic
-- crosses the internet, so the transport has to carry its own authentication and encryption.
--
-- With RadSec the shared secret is meaningless -- FreeRADIUS requires the literal string
-- "radsec" for a `proto = tls` client -- and the source address is no longer a usable identity
-- either, because a remote NAS is behind NAT and a changing address. The NAS identity therefore
-- comes from the client certificate EZECLOUD issues: CN = nas_clients.id, verified by FreeRADIUS
-- against the EZECLOUD RadSec CA before the request reaches the API. That is a server-verified
-- fact, so it satisfies SECURITY_ARCHITECTURE.md §3.2 (only server-side facts select the tenant)
-- and is strictly stronger than the source address it replaces.
--
-- No identity column is needed: the certificate CN is the NAS id. What is needed is an explicit
-- per-NAS opt-in, so that issuing a certificate is a deliberate act and a NAS that has never been
-- enrolled for RadSec cannot be impersonated by a certificate issued for some other purpose, and
-- the serial of the ONE certificate currently enrolled: a request presenting any other serial is
-- refused (packages/shared/src/radsec.ts). Issuing a new certificate for a NAS therefore retires
-- the previous one at once. That is the revocation mechanism; no CRL is published.
--
-- Accounting goes to radius.radacct_raw through rlm_sql, not through the API, so the same
-- identity has to be stored there for the drainer: over RadSec packet_src_ip is a NAT address
-- that may equal another NAS's registered address, and attributing by it would book one
-- tenant's usage to another.
SET LOCAL lock_timeout = '5s';

ALTER TABLE nas_clients
  ADD COLUMN radsec_enabled boolean NOT NULL DEFAULT false,
  -- Serial of the certificate currently enrolled for this NAS, canonical lowercase hex. A
  -- presented certificate must carry exactly this serial; FreeRADIUS has already verified its
  -- chain. NULL until a certificate is issued, and an enrolled NAS without it is refused.
  ADD COLUMN radsec_cert_serial text,
  ADD COLUMN radsec_enrolled_at timestamptz;

COMMENT ON COLUMN nas_clients.radsec_enabled IS
  'RFC 6614: this NAS may authenticate over RadSec with a client certificate whose CN is this row''s id. Opt-in per NAS (migration 034).';
COMMENT ON COLUMN nas_clients.radsec_cert_serial IS
  'Serial of the one client certificate currently accepted for this NAS; any other serial is refused, so reissuing retires the previous certificate (migration 034).';
COMMENT ON COLUMN nas_clients.radsec_enrolled_at IS
  'When the current RadSec certificate was issued (migration 034).';

-- A NAS resolved over RadSec is looked up by id with this flag set, so the partial index keeps
-- that lookup cheap as the table grows.
CREATE INDEX nas_clients_radsec_enabled_idx
  ON nas_clients (id)
  WHERE radsec_enabled AND deleted_at IS NULL;

-- Accounting staging (FreeRADIUS queries.conf writes these: apply this migration BEFORE deploying
-- a FreeRADIUS image built from the same tree; the entrypoint refuses to start without them).
-- Set only for packets from the RadSec listener's `ecloud-radsec` client, from the verified
-- client certificate (policy.d/ecloud ecloud_tls_identity); NULL for every UDP packet.
ALTER TABLE radius.radacct_raw
  ADD COLUMN IF NOT EXISTS packet_tls_client_cn text NULL,
  ADD COLUMN IF NOT EXISTS packet_tls_client_serial text NULL;
