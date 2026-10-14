-- 043: the platform default policy, for a NAS nobody has configured yet.
--
-- Owner request, relayed 2026-10-14: "create a default policy ... to be able to support all nas
-- even if not yet assign to a real profile or site. for not yet adopted nas." Scope decided by
-- the owner: ANY NAS with nothing assigned, not only not-yet-adopted ones — one rule, no
-- adoption state to get wrong, and it cannot fail in the case where a NAS is adopted before its
-- site has a policy. He accepted the consequence, which is that a misconfigured live site falls
-- back rather than failing closed.
--
-- Today such a NAS resolves to nothing and the authorize path rejects with `no_policy`. This
-- gives the engine something to fall back to, with the same tri-state discipline as migration
-- 039: a real assignment wins, absence inherits the platform default, and the default is a ROW
-- so it can be inspected and changed rather than a literal compiled into the engine.
--
-- THE VISIBILITY IS THE POINT, NOT A NICETY.
--
-- The owner chose generous limits (10/10 Mbit/s for a day) over the modest ones that were
-- offered. Modest limits would have made a forgotten access point self-announcing: a guest
-- complains, somebody looks, the NAS gets assigned. At comfortable limits nobody complains and
-- nothing surfaces, so the only remaining control is that an operator can SEE the state. Hence
-- `sessions.platform_default`: "which of my access points are serving the anonymous default
-- right now" is one predicate, not an audit.
--
-- It is recorded on the session at authorize time rather than derived later, for the same reason
-- the portal flag is: the default row can be edited or disabled while a session runs, and the
-- question is what was true when access was granted. A derived answer would quietly rewrite
-- history.
--
-- This migration does NOT create the default row. Creating it is a production change with the
-- owner's numbers in it and goes through the same gate as everything else; the feature is inert
-- until he authorises that. A migration that seeded live limits would be deciding for him.

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------------------------
-- platform_default_policy (P) — singleton, no organization_id, no RLS
-- ---------------------------------------------------------------------------------------------
-- A platform table because it answers for every tenant, including one whose own default has
-- never been created. `id` is pinned to a single value so there is exactly one row and no
-- ambiguity about which default is in force; the CHECK is the whole singleton mechanism.
CREATE TABLE platform_default_policy (
  id                      boolean PRIMARY KEY DEFAULT true,
  -- The off switch. Disabling it restores the previous behaviour — an unassigned NAS rejects
  -- with `no_policy` — without deleting the configured limits, so it can be turned back on.
  enabled                 boolean NOT NULL DEFAULT false,
  description             text NOT NULL DEFAULT '',
  download_rate_kbps      integer,
  upload_rate_kbps        integer,
  session_timeout_s       integer,
  idle_timeout_s          integer,
  quota_daily_bytes       bigint,
  quota_total_bytes       bigint,
  online_time_total_s     integer,
  max_concurrent_sessions integer,
  max_devices             integer,
  updated_at              timestamptz NOT NULL DEFAULT now(),
  updated_by              uuid,
  CONSTRAINT ck_platform_default_policy_singleton CHECK (id),
  CONSTRAINT ck_platform_default_policy_positive CHECK (
    (download_rate_kbps      IS NULL OR download_rate_kbps      > 0) AND
    (upload_rate_kbps        IS NULL OR upload_rate_kbps        > 0) AND
    (session_timeout_s       IS NULL OR session_timeout_s       >= 60) AND
    (idle_timeout_s          IS NULL OR idle_timeout_s          >= 60) AND
    (quota_daily_bytes       IS NULL OR quota_daily_bytes       > 0) AND
    (quota_total_bytes       IS NULL OR quota_total_bytes       > 0) AND
    (online_time_total_s     IS NULL OR online_time_total_s     >= 60) AND
    (max_concurrent_sessions IS NULL OR max_concurrent_sessions > 0) AND
    (max_devices             IS NULL OR max_devices             > 0)
  ),
  -- Enabling a default that grants nothing would hand every unassigned NAS uncapped access,
  -- which is the opposite of a safe fallback. At least one limit must be set to turn it on.
  CONSTRAINT ck_platform_default_policy_enabled_has_limits CHECK (
    NOT enabled OR (
      download_rate_kbps IS NOT NULL OR upload_rate_kbps IS NOT NULL OR
      session_timeout_s IS NOT NULL OR quota_daily_bytes IS NOT NULL OR
      quota_total_bytes IS NOT NULL OR online_time_total_s IS NOT NULL
    )
  )
);

COMMENT ON TABLE platform_default_policy IS
  'Singleton fallback applied when a NAS has no applicable policy at any layer (migration 043). Disabled by default; enabling it and setting its limits is a production change. Not tenant-scoped: it answers for organizations that have no default of their own.';
COMMENT ON COLUMN platform_default_policy.enabled IS
  'Off switch. Disabled restores the previous behaviour (an unassigned NAS rejects with no_policy) without losing the configured limits.';

GRANT SELECT ON platform_default_policy TO ecloud_app;

-- ---------------------------------------------------------------------------------------------
-- sessions.platform_default — the enumeration the fallback is only safe with
-- ---------------------------------------------------------------------------------------------
ALTER TABLE sessions
  ADD COLUMN platform_default boolean NOT NULL DEFAULT false;

-- Partial, because the interesting set is small and the question is always about live sessions:
--   SELECT n.name, s.site_id, count(*)
--     FROM sessions s JOIN nas_clients n ON n.id = s.nas_client_id
--    WHERE s.platform_default AND s.status = 'active'
--    GROUP BY 1, 2;
CREATE INDEX idx_sessions_platform_default
  ON sessions (organization_id, status) WHERE platform_default;

COMMENT ON COLUMN sessions.platform_default IS
  'This session was authorized against the platform default rather than a policy anyone chose (migration 043). Recorded at authorize time, not derived: the default row can change while the session runs and the question is what was true when access was granted.';
