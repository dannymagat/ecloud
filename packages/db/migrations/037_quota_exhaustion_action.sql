-- 037: what happens when an allowance runs out (BANDWIDTH_MANAGEMENT_REQUIREMENTS.md §9
-- "Exhaustion and reset", gap analysis §2.1 and §2.6).
--
-- Until now there was one answer: deny. A guest who reached a daily quota at 10:00 was simply
-- refused until midnight, which is the right behaviour for a paid plan and the wrong one for
-- nearly every hotel, cafe and conference. The requirement names three actions, so the column
-- names three:
--
--   deny             the current behaviour, and still the default when no layer sets one
--   reduce_speed     access continues at reduced_*_rate_kbps instead of the policy rates
--   require_renewal  access is refused, but with a distinct reason so the portal can offer a
--                    renewal or upgrade rather than show a dead end
--
-- `reduce_speed` carries its reduced rates inline rather than pointing at another policy. A
-- policy reference would need a cycle guard (a reduced policy whose own reduced policy is the
-- first), a second resolution pass, and an answer to what a reduced policy's quota means. Two
-- integers answer the requirement exactly: "reduced-speed profile" is a speed, and when stage 5
-- introduces reusable bandwidth profiles these two columns become a reference to one.
--
-- The action applies to BOTH the data quotas and the online-time allowances (migration 036):
-- they are the same kind of promise to the guest and splitting the behaviour would be a
-- surprise. Account expiry, suspension and schedule windows are untouched - those are denials
-- about eligibility, not about an allowance, and reducing someone's speed because their account
-- expired would be wrong.

SET LOCAL lock_timeout = '5s';

ALTER TABLE policies
  ADD COLUMN quota_exhaustion_action  text,
  ADD COLUMN reduced_download_rate_kbps integer,
  ADD COLUMN reduced_upload_rate_kbps   integer;

ALTER TABLE policies
  ADD CONSTRAINT ck_policies_quota_exhaustion_action
    CHECK (quota_exhaustion_action IS NULL
           OR quota_exhaustion_action IN ('deny', 'reduce_speed', 'require_renewal')),
  ADD CONSTRAINT ck_policies_reduced_rates_positive CHECK (
    (reduced_download_rate_kbps IS NULL OR reduced_download_rate_kbps > 0) AND
    (reduced_upload_rate_kbps   IS NULL OR reduced_upload_rate_kbps   > 0)
  );

COMMENT ON COLUMN policies.quota_exhaustion_action IS
  'What an exhausted data or online-time allowance does: deny (default when no layer sets one), reduce_speed, or require_renewal. Does not apply to expiry, suspension or schedule denials.';
COMMENT ON COLUMN policies.reduced_download_rate_kbps IS
  'Rate used after an allowance is exhausted when quota_exhaustion_action = reduce_speed. Validation requires it to be at or below the policy rate: a "reduction" that raises the rate is a typo.';
