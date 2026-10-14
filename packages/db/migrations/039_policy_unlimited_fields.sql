-- 039: "unlimited" as a state of its own (BANDWIDTH_MANAGEMENT_REQUIREMENTS.md §10, gap
-- analysis §2.7).
--
-- The engine has had two states per field: a value, or NULL meaning "inherit from the next
-- layer". There has been no way to say "no cap here", so a lower, more specific layer could
-- raise a parent's limit but never remove it. A guest group capped at 10 Mbit/s could not
-- contain one unmetered account without writing a number large enough to pretend.
--
-- The requirement is explicit that zero must not be overloaded to mean this, and it is right:
-- `download_rate_kbps = 0` is already refused by ck_policies_rates_positive, and a sentinel like
-- -1 would have to be understood by the validator, the translator, every adapter and every
-- report. So the state lives beside the values rather than inside them: a policy lists the
-- fields it declares unlimited, exactly as `users.auth_methods` lists what it allows.
--
-- What it means in resolution: a layer that declares a field unlimited WINS that field, the same
-- way a layer that sets a value wins it. The merge stops falling through, and the field resolves
-- to no cap. Precedence is unchanged - this adds a kind of answer, not a new ordering.
--
-- What it does NOT mean: escaping an aggregate limit. Per-session caps are overridable by a more
-- specific layer today (a user policy with a bigger number already beats a site policy with a
-- smaller one), and "unlimited" is the same decision stated honestly. Shared pools are a
-- different mechanism with a different enforcement point, and when they land they bind
-- regardless of what any member policy declares.
--
-- The list is bounded to fields where "no cap" is a meaningful answer. `vlan_id` has no unlimited
-- state; `quota_direction` and `quota_exhaustion_action` are modifiers, not limits; `valid_from`
-- is a start, not a cap. `valid_until` and `schedule_id` are included because "never expires" and
-- "no time restriction" are exactly the thing an operator needs to say about one account inside a
-- restricted group.

SET LOCAL lock_timeout = '5s';

ALTER TABLE policies
  ADD COLUMN unlimited_fields text[] NOT NULL DEFAULT '{}';

ALTER TABLE policies
  ADD CONSTRAINT ck_policies_unlimited_fields CHECK (
    unlimited_fields <@ ARRAY[
      'download_rate_kbps',
      'upload_rate_kbps',
      'burst_download_kbps',
      'burst_upload_kbps',
      'burst_duration_s',
      'quota_daily_bytes',
      'quota_weekly_bytes',
      'quota_monthly_bytes',
      'quota_total_bytes',
      'online_time_daily_s',
      'online_time_weekly_s',
      'online_time_monthly_s',
      'online_time_total_s',
      'session_timeout_s',
      'idle_timeout_s',
      'max_concurrent_sessions',
      'max_devices',
      'valid_until',
      'schedule_id'
    ]::text[]
  );

COMMENT ON COLUMN policies.unlimited_fields IS
  'Fields this policy declares to have no cap (migration 039). A declared field wins the merge exactly as a set value does, so a more specific layer can lift a parent per-session cap rather than only raise it. It does not escape an aggregate pool, which is enforced elsewhere.';
