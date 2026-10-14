-- 036: complete the quota model (BANDWIDTH_MANAGEMENT_REQUIREMENTS.md §9, gap analysis §2.6).
--
-- Three gaps, one migration, because they share the same evaluation site in the policy engine
-- and the same counter rows:
--
--   weekly period        `usage_counters.period_type` allowed daily / monthly / total only, so a
--                        "2 GB per week" plan could not be expressed at all.
--   quota direction      every quota was `bytes_in + bytes_out`. An upload-only or download-only
--                        allowance is a different product and a different number.
--   online-time quota    `usage_counters.session_time_s` has been accumulated since migration 007
--                        and never read. Connected time is the one allowance a guest notices and
--                        the only one this platform could not limit.
--
-- Time quotas are deliberately NOT a translated NAS attribute. There is no RADIUS attribute for
-- "you have 90 minutes left this month"; the enforcement is the Session-Timeout the engine
-- already emits, clipped to whatever the allowance leaves, plus denial at the next
-- Access-Request. That reuses a mechanism whose per-adapter status is already declared and
-- device-verified, instead of inventing a capability no gateway has.
--
-- Nothing here is NOT NULL and nothing has a default: every column is nullable so the engine's
-- field-level fall-through keeps working (null = inherit from the next policy layer). A default
-- of 'combined' on quota_direction would have written an explicit value into every existing row
-- and silently overridden a direction set at a lower layer.

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------------------------
-- usage_counters: the weekly bucket
-- ---------------------------------------------------------------------------------------------
-- period_start for 'weekly' is the Monday of the ISO week, in the site's timezone, exactly as
-- 'daily' is the local date and 'monthly' the local first-of-month. ISO weeks start on Monday;
-- a configurable week start belongs with the configurable reset hour and neither exists yet.
ALTER TABLE usage_counters DROP CONSTRAINT ck_usage_counters_period_type;
ALTER TABLE usage_counters ADD CONSTRAINT ck_usage_counters_period_type
  CHECK (period_type IN ('daily', 'weekly', 'monthly', 'total'));

COMMENT ON COLUMN usage_counters.period_start IS
  'Local period boundary in the site timezone: the date (daily), the ISO-week Monday (weekly), the first of the month (monthly), or 1970-01-01 (total).';

-- ---------------------------------------------------------------------------------------------
-- policies: weekly data quota, quota direction, online-time quotas
-- ---------------------------------------------------------------------------------------------
ALTER TABLE policies
  ADD COLUMN quota_weekly_bytes   bigint,
  ADD COLUMN quota_direction      text,
  ADD COLUMN online_time_daily_s   integer,
  ADD COLUMN online_time_weekly_s  integer,
  ADD COLUMN online_time_monthly_s integer,
  ADD COLUMN online_time_total_s   integer;

ALTER TABLE policies
  ADD CONSTRAINT ck_policies_quota_direction
    CHECK (quota_direction IS NULL OR quota_direction IN ('combined', 'upload', 'download')),
  ADD CONSTRAINT ck_policies_quota_weekly_positive
    CHECK (quota_weekly_bytes IS NULL OR quota_weekly_bytes > 0),
  ADD CONSTRAINT ck_policies_online_time_positive CHECK (
    (online_time_daily_s   IS NULL OR online_time_daily_s   > 0) AND
    (online_time_weekly_s  IS NULL OR online_time_weekly_s  > 0) AND
    (online_time_monthly_s IS NULL OR online_time_monthly_s > 0) AND
    (online_time_total_s   IS NULL OR online_time_total_s   > 0)
  );

COMMENT ON COLUMN policies.quota_direction IS
  'Which octets the data quotas count: combined (the default when no layer sets one), upload (Acct-Input-Octets) or download (Acct-Output-Octets), named from the client perspective as every other rate on this platform is. Merges like any other field; the most specific layer that sets one wins.';
COMMENT ON COLUMN policies.online_time_total_s IS
  'Cumulative connected seconds, distinct from valid_until (eligibility window) and session_timeout_s (one connection). Enforced by clipping Session-Timeout to the remainder and denying at the next Access-Request; no NAS attribute carries it.';
