/**
 * Migration 045: order fulfilment.
 *
 * The test that matters is the one asserting a refusal: an order that was never backed by a
 * verified provider event cannot become an entitlement, however its status column was set.
 * That is §14's rule, and the usual way it is broken is a success page that grants access
 * because the redirect said so.
 */
import { describe, expect, it } from 'vitest';
import {
  entitlementWindow,
  fulfilmentDecision,
  type OrderFacts,
  type PlanFacts,
} from './orders.js';

const NOW = new Date('2026-10-14T10:00:00Z');

const PLAN: PlanFacts = {
  id: 'plan-1',
  enabled: true,
  plan_type: 'paid',
  price_minor: 2500,
  currency: 'AED',
  validity_duration_s: 86_400,
  activation_trigger: 'purchase',
};

const PAID: OrderFacts = {
  id: 'ord-1',
  status: 'paid',
  amount_minor: 2500,
  currency: 'AED',
  paid_event_id: 'evt-1',
  assignment_id: null,
  user_id: 'user-1',
};

describe('a redirect cannot buy access (§14)', () => {
  it('refuses an order marked paid with no verified event', () => {
    const forged = { ...PAID, paid_event_id: null };
    const d = fulfilmentDecision(forged, PLAN);
    expect(d.ok).toBe(false);
    expect(d.ok === false && d.reason).toBe('no_verified_event');
    expect(d.ok === false && d.detail).toContain('redirect');
  });

  it('refuses a pending order with no event, naming the missing event rather than the status', () => {
    const d = fulfilmentDecision({ ...PAID, status: 'pending', paid_event_id: null }, PLAN);
    expect(d.ok === false && d.reason).toBe('no_verified_event');
  });

  it('refuses an order that has an event but was never moved to paid', () => {
    const d = fulfilmentDecision({ ...PAID, status: 'pending' }, PLAN);
    expect(d.ok === false && d.reason).toBe('not_paid');
  });

  it('fulfils a genuinely paid order', () => {
    expect(fulfilmentDecision(PAID, PLAN).ok).toBe(true);
  });
});

describe('idempotency and closed orders', () => {
  it('treats a retry of an already fulfilled order as a refusal, not an error', () => {
    const d = fulfilmentDecision({ ...PAID, status: 'fulfilled', assignment_id: 'as-1' }, PLAN);
    expect(d.ok === false && d.reason).toBe('already_fulfilled');
  });

  it('refuses when an assignment exists even if the status lags behind', () => {
    const d = fulfilmentDecision({ ...PAID, assignment_id: 'as-1' }, PLAN);
    expect(d.ok === false && d.reason).toBe('already_fulfilled');
  });

  it.each(['failed', 'cancelled'] as const)('refuses a %s order', (status) => {
    expect(fulfilmentDecision({ ...PAID, status }, PLAN).ok === false).toBe(true);
  });
});

describe('refusals that protect the customer', () => {
  it('refuses rather than granting a plan disabled after the money was taken', () => {
    const d = fulfilmentDecision(PAID, { ...PLAN, enabled: false });
    expect(d.ok === false && d.reason).toBe('plan_disabled');
    // The decision is a human's: refund or re-enable. Not ours to pick silently.
    expect(d.ok === false && d.detail).toContain('refund or re-enable');
  });

  it('refuses when the price moved between order and fulfilment', () => {
    const d = fulfilmentDecision(PAID, { ...PLAN, price_minor: 3000 });
    expect(d.ok === false && d.reason).toBe('amount_mismatch');
  });

  it('refuses when the currency changed, not only the figure', () => {
    const d = fulfilmentDecision(PAID, { ...PLAN, currency: 'USD' });
    expect(d.ok === false && d.reason).toBe('amount_mismatch');
  });

  it('refuses when nobody is identified to receive the entitlement', () => {
    const d = fulfilmentDecision({ ...PAID, user_id: null }, PLAN);
    expect(d.ok === false && d.reason).toBe('no_subject');
  });
});

describe('entitlement window (§4 activation trigger, §9 validity)', () => {
  it('starts now for a purchase trigger and ends after the validity duration', () => {
    const w = entitlementWindow(PLAN, NOW);
    expect(w.effective_from).toEqual(NOW);
    expect(w.effective_until?.toISOString()).toBe('2026-10-15T10:00:00.000Z');
    expect(w.deferred).toBe(false);
  });

  it('treats creation the same way: both start now, they differ in when the order exists', () => {
    const w = entitlementWindow({ ...PLAN, activation_trigger: 'creation' }, NOW);
    expect(w.effective_until?.toISOString()).toBe('2026-10-15T10:00:00.000Z');
  });

  it('defers a first-login plan with no login yet, and leaves the end open', () => {
    const w = entitlementWindow({ ...PLAN, activation_trigger: 'first_login' }, NOW);
    expect(w.deferred).toBe(true);
    // Entitled from now so the guest can log in at all; the clock starts when they do.
    expect(w.effective_from).toEqual(NOW);
    expect(w.effective_until).toBeNull();
  });

  it('measures a first-login plan from the login once it has happened', () => {
    const login = new Date('2026-10-20T08:00:00Z');
    const w = entitlementWindow({ ...PLAN, activation_trigger: 'first_login' }, NOW, login);
    expect(w.effective_from).toEqual(login);
    expect(w.effective_until?.toISOString()).toBe('2026-10-21T08:00:00.000Z');
    expect(w.deferred).toBe(false);
  });

  it('leaves the end open when the plan has no relative validity: the policy window governs', () => {
    const w = entitlementWindow({ ...PLAN, validity_duration_s: null }, NOW);
    expect(w.effective_until).toBeNull();
  });
});
