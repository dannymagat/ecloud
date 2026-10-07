-- ECLOUD migration 013: session MFA assurance (SECURITY_ARCHITECTURE.md §6.2).
-- `mfa_verified_at` is set when the session was created by a TOTP / recovery-code login, or when
-- the administrator confirms TOTP enrolment inside the session. The API grants no permissions to
-- a session of an administrator who requires MFA (mfa_enforced or any platform binding) while
-- this is NULL. Existing sessions stay NULL: such administrators simply log in again.
SET LOCAL lock_timeout = '5s';

ALTER TABLE admin_sessions ADD COLUMN mfa_verified_at timestamptz NULL;
