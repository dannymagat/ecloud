/**
 * Enforcement strategy for a change that affects a live session (POLICY_ENGINE.md §5.3,
 * AAA_ARCHITECTURE.md §6, DECISIONS.md D-006 / D-028 V12, QUESTIONS.md Q44).
 *
 * The strategy is chosen from the session NAS adapter's EVIDENCE, never from its design claim:
 *   - `coa_change`        only when CoA attribute change is VERIFIED_SUPPORTED **and** device
 *                         enforced (LAB/PRODUCTION evidence with a DT reference) **and** the CoA
 *                         dispatcher is enabled;
 *   - `disconnect_reauth` likewise for Disconnect (the client re-authenticates into the new policy);
 *   - `next_reauth`       otherwise: the change applies at the session's next Access-Request,
 *                         bounded by the emitted Session-Timeout (capped per Q44);
 *   - `none`              the session's NAS has no engine adapter: nothing EZECLOUD sends can
 *                         carry the change (state `unsupported`).
 * Pure; no I/O.
 */
import type { AdapterFieldStatus, EvidenceLevel } from '@ecloud/shared';

export const ENFORCEMENT_STRATEGIES = [
  'coa_change',
  'disconnect_reauth',
  'next_reauth',
  'none',
] as const;
export type EnforcementStrategy = (typeof ENFORCEMENT_STRATEGIES)[number];

export const ENFORCEMENT_STATES = ['pending', 'applied', 'unsupported', 'superseded'] as const;
export type EnforcementState = (typeof ENFORCEMENT_STATES)[number];

/** Q44 default: Session-Timeout cap when no lab-validated CoA exists (policy-change latency). */
export const DEFAULT_SESSION_TIMEOUT_CAP_S = 1800;

/**
 * Adapters where a Session-Timeout is a VISIBLE LOGOUT rather than a silent re-authentication.
 *
 * The Q44 cap trades session length for policy-change latency: with `next_reauth` a change reaches
 * a live session only at its next Access-Request, so capping Session-Timeout bounds the wait. That
 * trade is sound when re-authentication is invisible — 802.1X and MAC-auth clients re-auth without
 * the user noticing, so the cap costs nothing a guest can see.
 *
 * On a UAM captive-portal gateway it is not invisible. uspot has no silent re-auth: when
 * Session-Timeout expires the client is deauthorised and the next HTTP request lands back on the
 * login page. Observed on the pilot AP1832 (profile 141) on 2026-10-15: login at 08:16:15Z,
 * portal again at 08:46:15Z, exactly 1800 s later, against a policy promising a one-day validity.
 *
 * So for these adapters the cap is removed and the policy's own session timeout is emitted. The
 * cost is real and is NOT hidden: a policy or quota change for a uspot session now applies only at
 * the guest's next login, which may be a day away. Interim accounting still reports usage, so
 * exhaustion is DETECTED on schedule — it simply cannot be ENFORCED mid-session until this
 * adapter has a device-validated CoA or Disconnect, at which point `chooseEnforcementStrategy`
 * stops returning `next_reauth` here and the question disappears.
 *
 * `ezecloud-uam` is the same shape and deliberately NOT listed: CoovaChilli does expose a CoA
 * path (`coaport`, `chilli_query`), nobody has observed the logout on it, and adding an adapter to
 * this list on reasoning alone is how a capability claim becomes a fiction. Add it when someone
 * observes it.
 */
export const NO_SILENT_REAUTH_ADAPTERS: readonly string[] = Object.freeze([
  'ezeap-uam',
  'uspot-upstream-uam',
]);

/**
 * The Session-Timeout cap to apply, or null for no cap.
 *
 * Null for every strategy but `next_reauth` (the others carry the change themselves, so nothing
 * needs bounding), and null for an adapter in {@link NO_SILENT_REAUTH_ADAPTERS}, where the cap
 * would log a guest out rather than quietly re-authenticate them.
 */
export function sessionTimeoutCapFor(input: {
  readonly adapterKey: string | null;
  readonly strategy: EnforcementStrategy;
  readonly configuredCapS: number;
}): number | null {
  if (input.strategy !== 'next_reauth') return null;
  if (input.adapterKey !== null && NO_SILENT_REAUTH_ADAPTERS.includes(input.adapterKey)) {
    return null;
  }
  return input.configuredCapS;
}

/** Evidence of one dynamic-authorization mechanism of an adapter. */
export interface MechanismEvidence {
  readonly status: AdapterFieldStatus;
  readonly evidenceLevel: EvidenceLevel | null;
  /** V12: VERIFIED_SUPPORTED + LAB/PRODUCTION evidence with a device-test reference. */
  readonly deviceEnforced: boolean;
}

export interface StrategyInput {
  /** Engine adapter key of the session's NAS; null = no (valid) adapter. */
  readonly adapterKey: string | null;
  readonly coaChange: MechanismEvidence | null;
  readonly disconnect: MechanismEvidence | null;
  /** ECLOUD_COA_ENABLED (D-006: false by default). */
  readonly dispatcherEnabled: boolean;
}

export interface StrategyDecision {
  readonly strategy: EnforcementStrategy;
  /** Initial state of the enforcement row. */
  readonly state: Extract<EnforcementState, 'pending' | 'unsupported'>;
  readonly reason: string;
}

function usable(m: MechanismEvidence | null, dispatcherEnabled: boolean): boolean {
  return (
    m !== null &&
    m.status === 'VERIFIED_SUPPORTED' &&
    m.deviceEnforced &&
    dispatcherEnabled === true
  );
}

function describe(name: string, m: MechanismEvidence | null): string {
  if (m === null) return `${name}: no declaration`;
  const level = m.evidenceLevel ?? 'no registry evidence';
  return `${name}: ${m.status}, ${level}${m.deviceEnforced ? ', device-enforced' : ', not lab-validated'}`;
}

export function chooseEnforcementStrategy(input: StrategyInput): StrategyDecision {
  if (input.adapterKey === null) {
    return {
      strategy: 'none',
      state: 'unsupported',
      reason:
        'NAS has no engine adapter (D-035): EZECLOUD sends no policy attributes to it, so no change can be applied',
    };
  }
  if (usable(input.coaChange, input.dispatcherEnabled)) {
    return {
      strategy: 'coa_change',
      state: 'pending',
      reason: `CoA attribute change is device-enforced on ${input.adapterKey} and the dispatcher is enabled`,
    };
  }
  if (usable(input.disconnect, input.dispatcherEnabled)) {
    return {
      strategy: 'disconnect_reauth',
      state: 'pending',
      reason: `Disconnect is device-enforced on ${input.adapterKey} and the dispatcher is enabled; the client re-authenticates into the new policy`,
    };
  }
  const why = [
    describe('CoA change', input.coaChange),
    describe('Disconnect', input.disconnect),
    input.dispatcherEnabled ? 'dispatcher enabled' : 'dispatcher disabled (D-006)',
  ].join('; ');
  return {
    strategy: 'next_reauth',
    state: 'pending',
    reason: `applies at the next Access-Request of the session (${why})`,
  };
}

/**
 * When a `next_reauth` change is expected to apply: the session start plus the Session-Timeout
 * that was sent to the NAS, if it was sent at all. Null when no Session-Timeout bounds the session
 * (the change then waits for the client to re-authenticate by itself).
 */
export function expectedReauthBy(startedAt: Date, sessionTimeoutSentS: number | null): Date | null {
  if (sessionTimeoutSentS === null || !Number.isFinite(sessionTimeoutSentS)) return null;
  if (sessionTimeoutSentS <= 0) return null;
  return new Date(startedAt.getTime() + sessionTimeoutSentS * 1000);
}

/** Admin wording of a preview (P7-B): "N sessions affected; strategy …; applies …". */
export function impactMessage(
  affected: number,
  byStrategy: Readonly<Record<EnforcementStrategy, number>>,
  capS: number,
): string {
  if (affected === 0) return 'No open session is affected';
  const parts = ENFORCEMENT_STRATEGIES.filter((s) => byStrategy[s] > 0).map(
    (s) => `${String(byStrategy[s])} ${s}`,
  );
  const latency =
    byStrategy.next_reauth > 0
      ? capS > 0
        ? `; next_reauth applies at next login, at most ${String(Math.round(capS / 60))} min`
        : '; next_reauth applies at next login (no Session-Timeout cap configured)'
      : '';
  return `${String(affected)} session${affected === 1 ? '' : 's'} affected; strategy ${parts.join(', ')}${latency}`;
}
