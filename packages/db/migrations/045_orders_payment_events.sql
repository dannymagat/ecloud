-- 045: the fulfilment spine for paid access plans
-- (BANDWIDTH_MANAGEMENT_REQUIREMENTS.md §14, gap analysis §2.11).
--
-- NO PAYMENT PROVIDER IS CHOSEN AND NONE IS ASSUMED. `provider` is free text and there is no
-- adapter, no HTTP route and no credential anywhere in this change. Picking a processor is the
-- owner's commercial decision with tax, contractual and compliance consequences, and inventing
-- one here would be exactly the kind of fabricated integration CLAUDE.md forbids. What this
-- migration builds is the half that every provider choice needs identically, and that is
-- hardest to retrofit safely: an order, a verified event, and an idempotent link between them.
--
-- §14's one unambiguous rule is "Never mark a payment, PMS posting or access upgrade successful
-- based solely on a frontend redirect." That is not a guideline here, it is the schema:
--
--   an order cannot reach `paid` without pointing at a row in `payment_events`
--
-- enforced by ck_orders_paid_needs_event. A redirect handler has no verified event to point at,
-- so it physically cannot mark an order paid however the code is written later. The usual
-- version of this bug - a success page that grants access because the URL said `?status=ok` -
-- is unreachable rather than merely discouraged.
--
-- Idempotency is likewise structural. Providers retry webhooks, and a retry that fulfils twice
-- gives a guest two entitlements for one payment:
--   uq_payment_events_provider_event  one row per provider event, so a replay collides
--   uq_orders_fulfilment              one assignment per order, so a double fulfil collides
-- Both are unique indexes rather than application checks, because an application check under
-- concurrency is a race and these are exactly the paths a retry storm hits.
--
-- NOT IN THIS MIGRATION, and not pretended: recurring subscriptions and renewals, refunds and
-- reversals, invoices and receipts, tax, and PMS room-charge posting. Each needs a provider
-- decision or a vendor contract first, and a half-modelled refund is worse than none.

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------------------------
-- payment_events (T) — what the provider told us, after we verified it
-- ---------------------------------------------------------------------------------------------
-- Only verified events are stored. An unverified callback is noise at best and forged at worst,
-- and keeping it in the same table as the real ones invites a later query that forgets to
-- filter. `payload` is the provider's own body, kept for reconciliation; it must never contain a
-- card number, which is why hosted checkout is the only shape this platform should support.
CREATE TABLE payment_events (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid NOT NULL,
  -- Free text until the owner chooses. No enum, because an enum here would be a guess.
  provider          text NOT NULL,
  -- The provider's own event id: the idempotency key a retry repeats.
  provider_event_id text NOT NULL,
  event_type        text NOT NULL,
  amount_minor      integer,
  currency          text,
  payload           jsonb NOT NULL DEFAULT '{}'::jsonb,
  received_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_payment_events_organization_id FOREIGN KEY (organization_id)
    REFERENCES organizations (id) ON DELETE CASCADE,
  CONSTRAINT ck_payment_events_provider CHECK (length(btrim(provider)) BETWEEN 1 AND 64),
  CONSTRAINT ck_payment_events_provider_event_id
    CHECK (length(btrim(provider_event_id)) BETWEEN 1 AND 200),
  CONSTRAINT ck_payment_events_currency CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
  CONSTRAINT ck_payment_events_amount CHECK (amount_minor IS NULL OR amount_minor >= 0)
);
-- A webhook retry collides here rather than being handled twice.
CREATE UNIQUE INDEX uq_payment_events_provider_event
  ON payment_events (provider, provider_event_id);
CREATE INDEX idx_payment_events_org_received ON payment_events (organization_id, received_at DESC);

COMMENT ON TABLE payment_events IS
  'Verified provider events only (migration 045). An unverified callback is never stored: keeping it here would invite a later query that forgets to filter.';

-- ---------------------------------------------------------------------------------------------
-- orders (T) — someone intends to buy a plan, and possibly has
-- ---------------------------------------------------------------------------------------------
CREATE TABLE orders (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  site_id         uuid,
  access_plan_id  uuid NOT NULL,
  -- Null until the buyer is identified; a guest may pay before an account exists.
  user_id         uuid,
  status          text NOT NULL DEFAULT 'pending',
  -- Captured from the plan at order time. A later price change must not alter what was agreed.
  amount_minor    integer NOT NULL,
  currency        text NOT NULL,
  provider        text,
  -- The provider's reference for the attempt (checkout session, intent), not the event.
  provider_ref    text,
  -- The verified event that made this order paid. The whole §14 rule lives in this column.
  paid_event_id   uuid,
  paid_at         timestamptz,
  -- The entitlement fulfilment created, so a retry can see the work is already done.
  assignment_id   uuid,
  fulfilled_at    timestamptz,
  failure_reason  text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_orders_organization_id FOREIGN KEY (organization_id)
    REFERENCES organizations (id) ON DELETE CASCADE,
  CONSTRAINT fk_orders_site_id FOREIGN KEY (site_id)
    REFERENCES sites (id) ON DELETE SET NULL,
  CONSTRAINT fk_orders_access_plan_id FOREIGN KEY (access_plan_id)
    REFERENCES access_plans (id) ON DELETE RESTRICT,
  CONSTRAINT fk_orders_user_id FOREIGN KEY (user_id)
    REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_orders_paid_event_id FOREIGN KEY (paid_event_id)
    REFERENCES payment_events (id) ON DELETE RESTRICT,
  CONSTRAINT fk_orders_assignment_id FOREIGN KEY (assignment_id)
    REFERENCES policy_assignments (id) ON DELETE SET NULL,
  CONSTRAINT ck_orders_status CHECK (status IN ('pending', 'paid', 'fulfilled', 'failed', 'cancelled')),
  CONSTRAINT ck_orders_amount CHECK (amount_minor > 0),
  CONSTRAINT ck_orders_currency CHECK (currency ~ '^[A-Z]{3}$'),
  -- §14, as a constraint rather than a convention: no verified event, no paid order. A redirect
  -- handler has nothing to put here.
  CONSTRAINT ck_orders_paid_needs_event CHECK (
    status NOT IN ('paid', 'fulfilled') OR (paid_event_id IS NOT NULL AND paid_at IS NOT NULL)
  ),
  -- Fulfilment means an entitlement exists. A `fulfilled` order with no assignment would be a
  -- customer who paid and got nothing, recorded as success.
  CONSTRAINT ck_orders_fulfilled_needs_assignment CHECK (
    status <> 'fulfilled' OR (assignment_id IS NOT NULL AND fulfilled_at IS NOT NULL)
  ),
  CONSTRAINT ck_orders_failure_reason CHECK (
    failure_reason IS NULL OR length(failure_reason) <= 500
  )
);
-- One order per verified payment event: a retry that reaches fulfilment twice collides.
CREATE UNIQUE INDEX uq_orders_paid_event ON orders (paid_event_id)
  WHERE paid_event_id IS NOT NULL;
-- One entitlement per order, for the same reason.
CREATE UNIQUE INDEX uq_orders_fulfilment ON orders (assignment_id)
  WHERE assignment_id IS NOT NULL;
CREATE UNIQUE INDEX uq_orders_provider_ref ON orders (provider, provider_ref)
  WHERE provider IS NOT NULL AND provider_ref IS NOT NULL;
CREATE INDEX idx_orders_org_status ON orders (organization_id, status, created_at DESC);
CREATE INDEX idx_orders_user ON orders (user_id) WHERE user_id IS NOT NULL;
CREATE TRIGGER trg_orders_updated_at BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE orders IS
  'A purchase of an access plan (migration 045). Reaching `paid` requires a verified payment_events row: §14 "never mark a payment successful based solely on a frontend redirect", enforced by constraint rather than by convention.';
COMMENT ON COLUMN orders.amount_minor IS
  'Captured from the plan when the order was created. A later price change must not alter what was agreed.';
COMMENT ON COLUMN orders.paid_event_id IS
  'The verified provider event that made this order paid. A redirect handler has nothing to put here, which is the point.';

ALTER TABLE payment_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON payment_events
  USING (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON orders
  USING (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON payment_events TO ecloud_app;
GRANT SELECT, INSERT, UPDATE ON orders TO ecloud_app;
