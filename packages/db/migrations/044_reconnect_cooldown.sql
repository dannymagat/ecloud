-- 044: reconnect cooldown (BANDWIDTH_MANAGEMENT_REQUIREMENTS.md §6, gap analysis §2.3).
--
-- §6 lists "idle timeout and reconnect cooldown" as separate controls and only the first
-- existed. Without the second, a session that ends — because its allowance ran out, because the
-- schedule window closed, because the idle timer fired — can be replaced immediately by
-- reconnecting, which is how a guest on a 30-minute voucher stays online all afternoon. The
-- idle timeout decides when a session ends; the cooldown decides how soon the next one may
-- begin, and nothing could express the second.
--
-- It is a per-subject wait, not a per-device one. Counting it per device would let a guest with
-- two phones alternate and never wait at all, which defeats the control entirely. The subject is
-- the same one the quotas are counted against, so "this account must wait" is consistent with
-- "this account has used its allowance".
--
-- Enforced EZECLOUD-side, at authorize time: the engine compares the subject's most recent
-- session end against the cooldown and refuses until it has passed. There is no NAS attribute
-- for it and none is invented — a gateway has no notion of "come back later", and the honest
-- place for a rule about re-authorization is the thing that answers Access-Requests.
--
-- No lower bound beyond one second, deliberately. A ten-second cooldown is a legitimate
-- anti-flap setting and a four-hour one is a legitimate commercial one; the engine's 60-second
-- floor applies to timers a NAS must honour, which this is not.

SET LOCAL lock_timeout = '5s';

ALTER TABLE policies
  ADD COLUMN reconnect_cooldown_s integer,
  ADD CONSTRAINT ck_policies_reconnect_cooldown
    CHECK (reconnect_cooldown_s IS NULL OR reconnect_cooldown_s > 0);

COMMENT ON COLUMN policies.reconnect_cooldown_s IS
  'Seconds a subject must wait after a session ends before a new one is authorized (migration 044). Per subject, not per device, so two phones cannot alternate around it. Enforced EZECLOUD-side at authorize time; no NAS attribute carries it.';

-- The cooldown asks "when did this subject's last session end", which is a reverse-chronological
-- lookup over stopped sessions. The existing indexes serve active ones.
CREATE INDEX idx_sessions_user_stopped ON sessions (user_id, stopped_at DESC)
  WHERE user_id IS NOT NULL AND stopped_at IS NOT NULL;
