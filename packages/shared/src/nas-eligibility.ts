/**
 * NAS eligibility: the Pending/Active/Disabled/Blocked state and its reasons
 * (NAS_PENDING_ADOPTION_REQUIREMENTS.md §5, §6, §10).
 *
 * **Pending is derived, never stored.** §5 says "Pending may be a derived view rather than a
 * destructive change to an adopted record" and "a policy loss must not erase adoption history",
 * which together rule out a status column somebody writes: losing a policy would have to clear
 * the adoption facts to be visible, and then restoring the policy could not tell an adopted NAS
 * from one that was never adopted. So this is a pure function over facts that already exist —
 * adoption, administrative status, ownership, identifier uniqueness and policy resolution — and
 * the state is recomputed on every read.
 *
 * It is in `@ecloud/shared` because three places need the same answer: the API computes it, the
 * admin table renders it, and the reason labels have to match between them. A second
 * implementation of a rule like this is how the portal picker acquired the same defect on four
 * separate paths.
 *
 * Browser-safe: no Node imports.
 */

// ---------------------------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------------------------

/** §5's four user-facing states. Only `active` is eligible for ordinary access checks. */
export const NAS_STATES = ['blocked', 'disabled', 'pending', 'active'] as const;
export type NasState = (typeof NAS_STATES)[number];

/**
 * Whether a NAS in this state may receive NEW access authorization. §5 gives `Denied` for every
 * state but Active, and Active is explicitly "not an unconditional Access-Accept" — user
 * credentials, quotas and schedules still apply after this.
 */
export function allowsNewAccess(state: NasState): boolean {
  return state === 'active';
}

// ---------------------------------------------------------------------------------------------
// Reasons
// ---------------------------------------------------------------------------------------------

/**
 * §5's Pending reasons, in the order a primary display reason is chosen from.
 *
 * The order is fixed so "choose a stable primary display reason" (§5) needs no stored choice: the
 * first match wins and the same facts always produce the same primary. It runs most-fundamental
 * first — an unadopted NAS has no meaningful policy question, so saying NOT_ADOPTED is more use
 * to an operator than saying NO_POLICY about a device that was never adopted.
 */
export const NAS_PENDING_REASONS = [
  'NOT_ADOPTED',
  'IDENTITY_CONFLICT',
  'OWNERSHIP_UNRESOLVED',
  'POLICY_UNAVAILABLE',
  'POLICY_DISABLED',
  'NO_POLICY',
] as const;
export type NasPendingReason = (typeof NAS_PENDING_REASONS)[number];

export const NAS_PENDING_REASON_LABEL: Readonly<Record<NasPendingReason, string>> = Object.freeze({
  NOT_ADOPTED: 'Not adopted',
  IDENTITY_CONFLICT: 'Identifier conflict',
  OWNERSHIP_UNRESOLVED: 'Ownership unresolved',
  POLICY_UNAVAILABLE: 'Policy service unavailable',
  POLICY_DISABLED: 'Policy disabled',
  NO_POLICY: 'No applicable policy',
});

/**
 * Signals that do NOT deny access but that an operator has to be able to see and enumerate.
 *
 * Kept apart from {@link NasPendingReason} deliberately. A NAS running on a platform default is
 * working — the owner's 2026-10-14 ruling made that the intended behaviour — so putting it in the
 * Pending reasons would both deny access the owner asked to allow and make a working device read
 * as broken. But it still has to be visible: a platform default grants network access the
 * operator did not choose, and with generous default limits nobody will ever complain, so the
 * badge and the filter are the only signals that exist. Mixing a non-denying item into a list
 * whose entire purpose is "why access is denied" is the kind of conflation that produced four
 * defects in the portal picker, so these are their own field.
 */
export const NAS_ADVISORIES = ['ON_PLATFORM_DEFAULT_POLICY', 'ON_PLATFORM_DEFAULT_PORTAL'] as const;
export type NasAdvisory = (typeof NAS_ADVISORIES)[number];

export const NAS_ADVISORY_LABEL: Readonly<Record<NasAdvisory, string>> = Object.freeze({
  ON_PLATFORM_DEFAULT_POLICY: 'Platform default policy — no policy was assigned',
  ON_PLATFORM_DEFAULT_PORTAL: 'Platform default portal — anonymous access, no portal configured',
});

// ---------------------------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------------------------

/** How policy resolution answered for this NAS. */
export type NasPolicyFact =
  /** A policy an operator assigned, directly or by inheritance. */
  | 'assigned'
  /** Resolved, but by the platform default layer rather than an assignment (resolve.ts layer 7). */
  | 'platform_default'
  /** Nothing resolved. */
  | 'missing'
  /** Something resolved but it is disabled. */
  | 'disabled'
  /** Resolution itself failed — §10 requires denying by default and showing the real failure. */
  | 'unavailable';

/**
 * The facts the state is derived from. Facts, not states: nothing here is itself a decision, so
 * the caller cannot accidentally pre-compute the answer and hand it back.
 */
export interface NasEligibilityFacts {
  /** §5: adoption complete. False for a discovered-but-unadopted record. */
  readonly adoptionComplete: boolean;
  /** `nas_clients.status` verbatim. An unrecognised value is treated as not usable. */
  readonly status: string;
  /** `nas_clients.deleted_at IS NOT NULL`. */
  readonly deleted: boolean;
  /** Tenant and site resolve and are valid (§5 OWNERSHIP_UNRESOLVED, §10 tenant removed). */
  readonly ownershipValid: boolean;
  /** The reported identifier is claimed by more than one record in its proper scope (§4). */
  readonly identifierConflict: boolean;
  readonly policy: NasPolicyFact;
  /** The portal serving this NAS is a platform default (`captive_portals.is_platform_default`). */
  readonly onPlatformDefaultPortal: boolean;
}

export interface NasEligibility {
  readonly state: NasState;
  /** True only for `active`; mirrors {@link allowsNewAccess} for callers holding the result. */
  readonly allowsNewAccess: boolean;
  /**
   * Every applicable Pending reason, in {@link NAS_PENDING_REASONS} order. §5: "If several
   * reasons apply, retain all relevant reasons and choose a stable primary display reason."
   * Non-empty only when `state` is `pending`.
   */
  readonly reasons: readonly NasPendingReason[];
  /** `reasons[0]`, or null when the NAS is not Pending. */
  readonly primaryReason: NasPendingReason | null;
  /** Visible but non-denying signals; independent of `state`. */
  readonly advisories: readonly NasAdvisory[];
}

// ---------------------------------------------------------------------------------------------
// Derivation
// ---------------------------------------------------------------------------------------------

function pendingReasons(facts: NasEligibilityFacts): NasPendingReason[] {
  const applies: Readonly<Record<NasPendingReason, boolean>> = {
    NOT_ADOPTED: !facts.adoptionComplete,
    IDENTITY_CONFLICT: facts.identifierConflict,
    OWNERSHIP_UNRESOLVED: !facts.ownershipValid,
    POLICY_UNAVAILABLE: facts.policy === 'unavailable',
    POLICY_DISABLED: facts.policy === 'disabled',
    NO_POLICY: facts.policy === 'missing',
  };
  return NAS_PENDING_REASONS.filter((reason) => applies[reason]);
}

function advisories(facts: NasEligibilityFacts): NasAdvisory[] {
  const out: NasAdvisory[] = [];
  if (facts.policy === 'platform_default') out.push('ON_PLATFORM_DEFAULT_POLICY');
  if (facts.onPlatformDefaultPortal) out.push('ON_PLATFORM_DEFAULT_PORTAL');
  return out;
}

/**
 * The NAS's eligibility state and its reasons.
 *
 * Precedence, and why it is this way round: `blocked` and `disabled` are checked BEFORE any
 * Pending reason because §5 requires that they "override any automatic activation" and that
 * "restoring a policy must never silently unblock or re-enable a NAS". With administrative state
 * first, restoring a policy changes which reasons apply and never touches the state, so a blocked
 * NAS stays blocked however its policy changes.
 *
 * An unrecognised `status` is treated as `disabled` rather than passed through or ignored. A NAS
 * whose administrative state this build does not understand must not receive access on the
 * strength of not being understood — and `blocked` is exactly such a value until the migration
 * that adds it to the CHECK has run everywhere, so this path is live rather than defensive.
 */
export function nasEligibility(facts: NasEligibilityFacts): NasEligibility {
  const advisory = advisories(facts);
  const settle = (state: NasState, reasons: readonly NasPendingReason[] = []): NasEligibility => ({
    state,
    allowsNewAccess: allowsNewAccess(state),
    reasons,
    primaryReason: reasons[0] ?? null,
    advisories: advisory,
  });

  if (facts.status === 'blocked') return settle('blocked');
  if (facts.deleted || facts.status !== 'active') return settle('disabled');
  const reasons = pendingReasons(facts);
  return reasons.length > 0 ? settle('pending', reasons) : settle('active');
}
