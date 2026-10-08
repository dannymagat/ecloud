-- ECLOUD migration 018: lost-MFA-device recovery (DECISIONS.md D-038).
-- `mfa_reenrol_required` is set by POST /platform/administrators/{id}/mfa/reset (permission
-- `administrator:mfa_reset`, platform scope). While it is true every session of the
-- administrator holds no permissions until a new TOTP factor is confirmed (the same gate as
-- `mfa_enforced`, SECURITY_ARCHITECTURE.md §6.2); confirming enrolment clears it.
SET LOCAL lock_timeout = '5s';

ALTER TABLE administrators ADD COLUMN mfa_reenrol_required boolean NOT NULL DEFAULT false;
