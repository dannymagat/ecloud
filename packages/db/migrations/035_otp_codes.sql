-- 035: one-time codes for captive-portal email OTP (docs/PORTAL_LOGIN_METHODS_DESIGN.md §4.1).
--
-- The guest types an address, receives a code, types it back. The verified address becomes the
-- subject: a `users` row with identity_provider_id pointing at a `local` identity provider and
-- external_subject = the address, which the uq_users_idp_subject index already enforces. No
-- change to users or captive_portals is needed — migration 004 anticipated this shape, and the
-- portal's auth_methods constraint already allows 'idp'.
--
-- The code is never stored in clear. An attacker with database read access must not be able to
-- complete a login, so the row holds a salted hash and the verifier re-hashes what the guest
-- typed. The pepper lives outside the database (OTP_PEPPER), so a dump alone is not enough.
--
-- Every column here exists to bound abuse, because this endpoint sends mail on request:
--   attempts      a code dies after a few wrong guesses, so it cannot be brute-forced
--   consumed_at   single use; a replayed code is refused even inside its TTL
--   expires_at    short TTL, so a leaked mailbox is only useful briefly
--   requested_ip  per-source rate limiting, and evidence when a site is being used as a relay
-- The per-identifier and per-site request limits themselves live in Redis (the existing portal
-- limiter), not here; this table is the record, not the gate.

SET LOCAL lock_timeout = '5s';

CREATE TABLE otp_codes (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      uuid NOT NULL,
  site_id              uuid,
  identity_provider_id uuid NOT NULL,
  captive_portal_id    uuid,
  -- 'email' now; 'sms' reuses this table when the SMS provider lands (design §4.4).
  channel              text NOT NULL,
  -- Normalised: lower-cased address, or E.164 number. Never a display form.
  identifier           text NOT NULL,
  -- HMAC-SHA-256(code, OTP_PEPPER) as lowercase hex. Never the code itself.
  code_hash            text NOT NULL,
  attempts             integer NOT NULL DEFAULT 0,
  max_attempts         integer NOT NULL DEFAULT 5,
  expires_at           timestamptz NOT NULL,
  consumed_at          timestamptz,
  requested_ip         inet,
  created_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_otp_codes_organization_id FOREIGN KEY (organization_id)
    REFERENCES organizations (id) ON DELETE CASCADE,
  CONSTRAINT fk_otp_codes_site_id FOREIGN KEY (site_id)
    REFERENCES sites (id) ON DELETE CASCADE,
  CONSTRAINT fk_otp_codes_identity_provider_id FOREIGN KEY (identity_provider_id)
    REFERENCES identity_providers (id) ON DELETE CASCADE,
  CONSTRAINT fk_otp_codes_captive_portal_id FOREIGN KEY (captive_portal_id)
    REFERENCES captive_portals (id) ON DELETE SET NULL,
  CONSTRAINT ck_otp_codes_channel CHECK (channel IN ('email', 'sms')),
  CONSTRAINT ck_otp_codes_identifier CHECK (length(identifier) BETWEEN 3 AND 320),
  CONSTRAINT ck_otp_codes_attempts CHECK (attempts >= 0 AND attempts <= max_attempts),
  CONSTRAINT ck_otp_codes_max_attempts CHECK (max_attempts BETWEEN 1 AND 10)
);

-- The verify path looks up the newest live code for an identifier within one provider.
CREATE INDEX idx_otp_codes_lookup
  ON otp_codes (identity_provider_id, identifier, created_at DESC)
  WHERE consumed_at IS NULL;

-- Retention sweep (the worker's existing reaper pattern): expired and consumed rows are evidence
-- for a short window only, then they are rubbish holding personal data.
CREATE INDEX idx_otp_codes_expiry ON otp_codes (expires_at);

COMMENT ON TABLE otp_codes IS
  'Captive-portal one-time codes (migration 035). Stores a peppered hash, never the code.';
COMMENT ON COLUMN otp_codes.code_hash IS
  'HMAC-SHA-256(code, OTP_PEPPER) lowercase hex; the pepper lives outside the database so a dump alone cannot complete a login.';
COMMENT ON COLUMN otp_codes.attempts IS
  'Wrong guesses against this code; at max_attempts the code is dead (migration 035).';

ALTER TABLE otp_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE otp_codes FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON otp_codes
  USING (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON otp_codes TO ecloud_app;
