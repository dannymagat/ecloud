-- 046: NAS adoption and the Blocked state (NAS_PENDING_ADOPTION_REQUIREMENTS.md §5).
--
-- §5 names four user-facing states — Pending, Active, Disabled, Blocked — of which only Active is
-- eligible for new access authorization. Three of them already have a representation:
-- `status = 'active'`, `status = 'disabled'`, and Pending, which is DERIVED rather than stored
-- (`@ecloud/shared` `nasEligibility`) because §5 asks for "a derived view rather than a
-- destructive change to an adopted record" and because "a policy loss must not erase adoption
-- history". This migration adds what is genuinely missing: Blocked, its reason, and the adoption
-- fact that Pending is partly derived from.
--
-- WHY `status = 'blocked'` RATHER THAN AN `is_blocked` BOOLEAN. The alternative was considered and
-- rejected. A separate boolean makes `status = 'active'` with `is_blocked = true` representable
-- and meaningless, so every reader has to consult both columns, and the reader that forgets one
-- grants access. That is the exact shape of a defect that reached four separate call sites in the
-- captive-portal resolver this week: a security-relevant condition a caller could forget. One
-- column cannot contradict itself.
--
-- The compatibility claim was verified rather than assumed, because it is the part that would
-- quietly grant access if it were wrong. Every reader of `nas_clients.status` in `apps/` and
-- `packages/` is a POSITIVE comparison (`= 'active'`); a search for the negative forms
-- (`!== 'disabled'`, `<> 'disabled'`, `NOT ... 'disabled'`) finds none, in TypeScript or SQL. So a
-- new value is treated as not-active by every existing path and fails closed everywhere, with no
-- reader to update. Had one reader been written as "anything except disabled", the same value
-- would have granted access at that call site.

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------------------------
-- Blocked, and why
-- ---------------------------------------------------------------------------------------------

ALTER TABLE nas_clients DROP CONSTRAINT ck_nas_clients_status;
ALTER TABLE nas_clients
  ADD CONSTRAINT ck_nas_clients_status CHECK (status IN ('active', 'disabled', 'blocked'));

-- `status` carries the state; it cannot carry why, and §5 wants the reason displayed. This is a
-- genuine second field rather than a second representation of the same state — but the same
-- discipline applies, so the CHECK stops the pair drifting: a reason without the state it
-- explains, or a blocked NAS whose reason was left behind by an unblock, are both unrepresentable.
ALTER TABLE nas_clients ADD COLUMN block_reason text;
ALTER TABLE nas_clients
  ADD CONSTRAINT ck_nas_clients_block_reason CHECK (
    (status = 'blocked' AND block_reason IS NOT NULL AND length(btrim(block_reason)) BETWEEN 1 AND 500)
    OR (status <> 'blocked' AND block_reason IS NULL)
  );

COMMENT ON COLUMN nas_clients.block_reason IS
  'Why this NAS is blocked (§5). Required when status = ''blocked'' and NULL otherwise, so the pair cannot drift. Shown in authorized administrative views only; never in a public rejection message (§8).';

-- ---------------------------------------------------------------------------------------------
-- Adoption
-- ---------------------------------------------------------------------------------------------

-- §5 asks for adoption and administrative status to be stored separately where practical, and
-- this is why: a NAS can be adopted and disabled, or unadopted and enabled, and collapsing them
-- would lose the adoption history §5 requires be preserved across a policy loss.
--
-- DEFAULT true is the whole compatibility story. Every NAS that exists today was created by an
-- administrator through `/nas`, which is adoption by any reasonable reading, so they are all
-- adopted and this migration is invisible to them. Only records created by a future discovery
-- path start unadopted, and that path does not exist yet.
ALTER TABLE nas_clients ADD COLUMN is_adopted boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN nas_clients.is_adopted IS
  'Adoption complete (§5). Separate from status so a policy loss cannot erase adoption history. DEFAULT true: every NAS created through the admin API is adopted, so existing rows are unaffected.';

CREATE INDEX idx_nas_clients_pending
  ON nas_clients (organization_id, site_id)
  WHERE deleted_at IS NULL AND (is_adopted = false OR status = 'blocked');

COMMENT ON INDEX idx_nas_clients_pending IS
  'Supports the Pending list. Partial, so it costs nothing for the ordinary adopted-and-active rows that are the overwhelming majority. It covers only the two Pending inputs that live on this table; the policy-derived reasons are resolved per row.';
