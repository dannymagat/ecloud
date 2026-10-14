-- 042: group and site aggregate limits (BANDWIDTH_MANAGEMENT_REQUIREMENTS.md §7, gap analysis
-- §2.4).
--
-- READ THIS BEFORE USING THE COLUMNS BELOW. The infographic's headline example — "each guest up
-- to 10 Mbps, all guests share a 100 Mbps pool" — CANNOT BE ENFORCED by any gateway integrated
-- with this platform. A shared bandwidth pool needs a parent queue or a controller bandwidth
-- group at the enforcement point, and none of the nine adapters in packages/adapters declares
-- one. RADIUS has no attribute for it: `WISPr-Bandwidth-Max-Down` is per session by
-- construction, and sending it to N members caps each of them at the pool figure rather than
-- all of them within it.
--
-- The requirement anticipates this exactly. §7: "Do not label independent gateway caps as a
-- single global shared pool." §15: "Expose unsupported scope honestly." So this migration
-- models the pool, records it, measures consumption against it and displays the result — and
-- the enforcement status of the rate pool is UNSUPPORTED on the present fleet, stated in the
-- capability matrix rather than buried here.
--
-- What IS enforceable today, and is enforced:
--   shared data allowance      the drainer already advances a counter per subject; adding a
--                              'user_group' subject makes a group quota work exactly as a user
--                              quota does — deny at the next Access-Request, Disconnect where
--                              the adapter's evidence allows it.
--   max simultaneous members   counted at authorize time from `sessions`, like the per-user
--                              concurrency cap that already works.
--
-- What is NOT, and is recorded as not:
--   aggregate rate pool        no enforcement point. Observable only: the measured total is
--                              reported beside the configured pool so an operator can see
--                              it being exceeded, which is worth having and is not the same
--                              as enforcing it.
--
-- The distinction between a per-member default and an aggregate is the one §7 insists on and
-- the one most easily lost: per-member settings already exist as a policy assigned to the group
-- (resolution layer 4). Nothing here duplicates them. These columns are only ever about the
-- group or site as a whole.

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------------------------
-- usage_counters: a group is a subject whose usage can be counted
-- ---------------------------------------------------------------------------------------------
ALTER TABLE usage_counters DROP CONSTRAINT ck_usage_counters_subject_type;
ALTER TABLE usage_counters ADD CONSTRAINT ck_usage_counters_subject_type
  CHECK (subject_type IN ('user', 'client_device', 'voucher', 'site', 'user_group'));

COMMENT ON COLUMN usage_counters.subject_type IS
  'Whose usage this row counts: a user, one of their devices, a voucher, a whole site (024) or a user group (042). A group row is the shared allowance of §7, distinct from each member''s own row.';

-- ---------------------------------------------------------------------------------------------
-- user_groups: the aggregate limits of §7
-- ---------------------------------------------------------------------------------------------
ALTER TABLE user_groups
  -- Observable only: no integrated gateway can enforce a shared rate pool. Kept because an
  -- operator who has sold a 100 Mbps pool needs to see when it is exceeded, and because the day
  -- an adapter gains a parent queue this is the column it reads.
  ADD COLUMN aggregate_download_kbps integer,
  ADD COLUMN aggregate_upload_kbps   integer,
  -- Enforceable: counted from usage_counters at authorize time.
  ADD COLUMN shared_quota_daily_bytes   bigint,
  ADD COLUMN shared_quota_weekly_bytes  bigint,
  ADD COLUMN shared_quota_monthly_bytes bigint,
  ADD COLUMN shared_quota_total_bytes   bigint,
  -- Enforceable: counted from `sessions` at authorize time. Two numbers, not one, because
  -- "40 people" and "60 devices" are different promises and §7 asks for the semantics to be
  -- labelled rather than guessed.
  ADD COLUMN max_active_members  integer,
  ADD COLUMN max_active_sessions integer,
  -- §7 "explicit enforcement scope". `site` means the limits apply within each site separately;
  -- `tenant` means across the organization. Nothing else is offered, because a "coordinated
  -- gateway set" has no representation here and inventing one would promise coordination that
  -- does not exist.
  ADD COLUMN aggregate_scope text NOT NULL DEFAULT 'tenant';

ALTER TABLE user_groups
  ADD CONSTRAINT ck_user_groups_aggregate_scope
    CHECK (aggregate_scope IN ('tenant', 'site')),
  ADD CONSTRAINT ck_user_groups_aggregates_positive CHECK (
    (aggregate_download_kbps    IS NULL OR aggregate_download_kbps    > 0) AND
    (aggregate_upload_kbps      IS NULL OR aggregate_upload_kbps      > 0) AND
    (shared_quota_daily_bytes   IS NULL OR shared_quota_daily_bytes   > 0) AND
    (shared_quota_weekly_bytes  IS NULL OR shared_quota_weekly_bytes  > 0) AND
    (shared_quota_monthly_bytes IS NULL OR shared_quota_monthly_bytes > 0) AND
    (shared_quota_total_bytes   IS NULL OR shared_quota_total_bytes   > 0) AND
    (max_active_members         IS NULL OR max_active_members         > 0) AND
    (max_active_sessions        IS NULL OR max_active_sessions        > 0)
  ),
  -- The same ordering discipline as the per-policy quotas: a shorter period may not exceed a
  -- longer one.
  ADD CONSTRAINT ck_user_groups_shared_quota_order CHECK (
    (shared_quota_daily_bytes  IS NULL OR shared_quota_weekly_bytes  IS NULL
       OR shared_quota_daily_bytes  <= shared_quota_weekly_bytes) AND
    (shared_quota_weekly_bytes IS NULL OR shared_quota_monthly_bytes IS NULL
       OR shared_quota_weekly_bytes <= shared_quota_monthly_bytes) AND
    (shared_quota_monthly_bytes IS NULL OR shared_quota_total_bytes IS NULL
       OR shared_quota_monthly_bytes <= shared_quota_total_bytes)
  ),
  -- A device cannot hold fewer than one session, so a session ceiling below the member ceiling
  -- is unreachable and means the operator mislabelled one of them.
  ADD CONSTRAINT ck_user_groups_sessions_above_members CHECK (
    max_active_sessions IS NULL OR max_active_members IS NULL
      OR max_active_sessions >= max_active_members
  );

COMMENT ON COLUMN user_groups.aggregate_download_kbps IS
  'Shared download pool for the whole group, kbit/s. NOT ENFORCED: no integrated gateway has a parent queue or bandwidth group, so this is measured and displayed, never applied. See the capability matrix.';
COMMENT ON COLUMN user_groups.shared_quota_total_bytes IS
  'Data allowance shared by every member, distinct from each member''s own quota (§7). Enforced EZECLOUD-side from usage_counters, like a per-user quota.';
COMMENT ON COLUMN user_groups.max_active_members IS
  'Distinct members with at least one active session. max_active_sessions counts sessions instead; §7 asks for the semantics to be labelled rather than inferred.';
COMMENT ON COLUMN user_groups.aggregate_scope IS
  'Whether the aggregates apply across the organization (tenant) or within each site separately (site). A coordinated gateway set is not offered: nothing here could coordinate one.';

-- ---------------------------------------------------------------------------------------------
-- sites: the same aggregates one level up
-- ---------------------------------------------------------------------------------------------
-- A site pool has the same enforcement problem and one advantage: `usage_counters` has carried a
-- 'site' subject since migration 024, so the shared data allowance needs no new accounting at
-- all — only a limit to compare the existing counter against.
ALTER TABLE sites
  ADD COLUMN aggregate_download_kbps integer,
  ADD COLUMN aggregate_upload_kbps   integer,
  ADD COLUMN shared_quota_daily_bytes   bigint,
  ADD COLUMN shared_quota_monthly_bytes bigint,
  ADD COLUMN max_active_sessions integer;

ALTER TABLE sites
  ADD CONSTRAINT ck_sites_aggregates_positive CHECK (
    (aggregate_download_kbps    IS NULL OR aggregate_download_kbps    > 0) AND
    (aggregate_upload_kbps      IS NULL OR aggregate_upload_kbps      > 0) AND
    (shared_quota_daily_bytes   IS NULL OR shared_quota_daily_bytes   > 0) AND
    (shared_quota_monthly_bytes IS NULL OR shared_quota_monthly_bytes > 0) AND
    (max_active_sessions        IS NULL OR max_active_sessions        > 0)
  ),
  ADD CONSTRAINT ck_sites_shared_quota_order CHECK (
    shared_quota_daily_bytes IS NULL OR shared_quota_monthly_bytes IS NULL
      OR shared_quota_daily_bytes <= shared_quota_monthly_bytes
  );

COMMENT ON COLUMN sites.aggregate_download_kbps IS
  'Shared download pool for the site, kbit/s. NOT ENFORCED, for the same reason as the group pool: there is no enforcement point. Measured against the existing site usage counters and displayed.';
