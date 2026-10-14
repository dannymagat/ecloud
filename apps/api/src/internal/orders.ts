/**
 * Order fulfilment decisions for paid access plans (migration 045, requirement §14).
 *
 * Pure: no database, no provider, no network. The caller supplies the order, the plan and the
 * verified event; this decides whether fulfilment may happen and what entitlement window it
 * creates. Keeping it pure is what makes the dangerous cases testable without a payment
 * processor, and there is no payment processor — none is chosen, and none is assumed here.
 *
 * The rule this module exists to enforce is §14's: "Never mark a payment, PMS posting or access
 * upgrade successful based solely on a frontend redirect." The schema already makes a paid order
 * without a verified event impossible (ck_orders_paid_needs_event). This is the second line:
 * every path to an entitlement goes through `fulfilmentDecision`, which refuses without one.
 *
 * Why both: the constraint stops the database holding a lie, and this stops the application
 * trying to write one and failing somewhere less legible. A redirect handler that calls this
 * gets a refusal with a reason, not a constraint violation at commit time.
 */
import type { ActivationTrigger } from '@ecloud/db';

export interface OrderFacts {
  readonly id: string;
  readonly status: 'pending' | 'paid' | 'fulfilled' | 'failed' | 'cancelled';
  readonly amount_minor: number;
  readonly currency: string;
  /** Set only by a verified provider event. */
  readonly paid_event_id: string | null;
  /** Set once fulfilment created an entitlement. */
  readonly assignment_id: string | null;
  readonly user_id: string | null;
}

export interface PlanFacts {
  readonly id: string;
  readonly enabled: boolean;
  readonly plan_type: 'free' | 'paid';
  readonly price_minor: number | null;
  readonly currency: string | null;
  readonly validity_duration_s: number | null;
  readonly activation_trigger: ActivationTrigger;
}

export type FulfilmentRefusal =
  | 'not_paid'
  | 'no_verified_event'
  | 'already_fulfilled'
  | 'order_closed'
  | 'no_subject'
  | 'plan_disabled'
  | 'amount_mismatch';

export type FulfilmentDecision =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: FulfilmentRefusal; readonly detail: string };

/**
 * May this order be turned into an entitlement?
 *
 * `already_fulfilled` is a refusal rather than an error: a provider retry reaching this twice is
 * normal and the correct response is to do nothing, not to fail loudly. The caller distinguishes
 * it from the others when deciding what to tell the provider.
 */
export function fulfilmentDecision(order: OrderFacts, plan: PlanFacts): FulfilmentDecision {
  if (order.status === 'fulfilled' || order.assignment_id !== null)
    return {
      ok: false,
      reason: 'already_fulfilled',
      detail: `order ${order.id} already has entitlement ${order.assignment_id ?? 'unknown'}`,
    };
  if (order.status === 'failed' || order.status === 'cancelled')
    return { ok: false, reason: 'order_closed', detail: `order ${order.id} is ${order.status}` };
  // The §14 rule. Checked before `status`, so a caller that set `paid` by some other route is
  // refused here with the reason that explains it rather than with a vaguer one.
  if (order.paid_event_id === null)
    return {
      ok: false,
      reason: 'no_verified_event',
      detail:
        'an order is fulfilled only against a verified provider event; a redirect or a success page is not one',
    };
  if (order.status !== 'paid')
    return { ok: false, reason: 'not_paid', detail: `order ${order.id} is ${order.status}` };
  if (order.user_id === null)
    return {
      ok: false,
      reason: 'no_subject',
      detail: 'the buyer is not identified, so there is nobody to grant the entitlement to',
    };
  if (!plan.enabled)
    return {
      ok: false,
      reason: 'plan_disabled',
      // Deliberately a refusal and not a silent grant: the money is taken, and a human has to
      // decide between refunding and re-enabling. Granting access to a withdrawn plan is not
      // ours to choose.
      detail: `plan ${plan.id} was disabled after the order was placed; refund or re-enable`,
    };
  // A paid plan whose price moved between order and fulfilment must not fulfil at the new
  // figure. The order captured what was agreed; a mismatch means something is wrong upstream.
  if (
    plan.plan_type === 'paid' &&
    plan.price_minor !== null &&
    (plan.price_minor !== order.amount_minor || plan.currency !== order.currency)
  )
    return {
      ok: false,
      reason: 'amount_mismatch',
      detail: `order was ${String(order.amount_minor)} ${order.currency}, plan is now ${String(plan.price_minor)} ${plan.currency ?? '???'}`,
    };
  return { ok: true };
}

export interface EntitlementWindow {
  readonly effective_from: Date;
  /** Null when the plan has no relative validity: the policy's own window governs. */
  readonly effective_until: Date | null;
  /** True when the window starts on first login rather than now (§4 activation trigger). */
  readonly deferred: boolean;
}

/**
 * The entitlement window an order creates.
 *
 * §9 insists validity, session duration, online time and idle timeout stay distinct; this is
 * validity, and only validity. `creation` and `purchase` both start now — they differ in WHEN
 * the order exists, not in how the window is measured — while `first_login` defers, which is
 * the one that needs the activation timestamp the requirement calls for.
 *
 * A deferred window is expressed as an assignment with no end, and the end is written when the
 * first session starts. Modelling it as "starts at an unknown future time" would make every
 * query that asks "is this entitlement live" answer wrongly in the meantime.
 */
export function entitlementWindow(
  plan: PlanFacts,
  now: Date,
  firstLoginAt: Date | null = null,
): EntitlementWindow {
  const deferred = plan.activation_trigger === 'first_login' && firstLoginAt === null;
  if (plan.validity_duration_s === null)
    return { effective_from: now, effective_until: null, deferred };
  if (deferred) {
    // Entitled from now so the guest can log in at all; the clock starts when they do.
    return { effective_from: now, effective_until: null, deferred: true };
  }
  const start = plan.activation_trigger === 'first_login' ? (firstLoginAt ?? now) : now;
  return {
    effective_from: start,
    effective_until: new Date(start.getTime() + plan.validity_duration_s * 1000),
    deferred: false,
  };
}
