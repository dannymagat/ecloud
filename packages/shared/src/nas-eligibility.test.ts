import { describe, expect, it } from 'vitest';
import {
  NAS_ADVISORIES,
  NAS_ADVISORY_LABEL,
  NAS_PENDING_REASONS,
  NAS_PENDING_REASON_LABEL,
  allowsNewAccess,
  nasEligibility,
  type NasEligibilityFacts,
} from './nas-eligibility.js';

/** An adopted, owned, policied, conflict-free NAS on a portal somebody configured. */
const ACTIVE: NasEligibilityFacts = Object.freeze({
  adoptionComplete: true,
  status: 'active',
  deleted: false,
  ownershipValid: true,
  identifierConflict: false,
  policy: 'assigned',
  onPlatformDefaultPortal: false,
});

const facts = (over: Partial<NasEligibilityFacts> = {}): NasEligibilityFacts => ({
  ...ACTIVE,
  ...over,
});

describe('nasEligibility: the happy path', () => {
  it('is active, allows new access, and has no reasons', () => {
    expect(nasEligibility(ACTIVE)).toEqual({
      state: 'active',
      allowsNewAccess: true,
      reasons: [],
      primaryReason: null,
      advisories: [],
      policyEvaluated: true,
    });
  });
});

describe('nasEligibility: each Pending reason', () => {
  const cases: readonly (readonly [string, Partial<NasEligibilityFacts>, string])[] = [
    ['an unadopted record', { adoptionComplete: false }, 'NOT_ADOPTED'],
    ['a contested identifier', { identifierConflict: true }, 'IDENTITY_CONFLICT'],
    ['unresolved ownership', { ownershipValid: false }, 'OWNERSHIP_UNRESOLVED'],
    ['policy resolution failing', { policy: 'unavailable' }, 'POLICY_UNAVAILABLE'],
    ['a disabled policy', { policy: 'disabled' }, 'POLICY_DISABLED'],
    ['no applicable policy', { policy: 'missing' }, 'NO_POLICY'],
  ];

  for (const [name, over, reason] of cases) {
    it(`puts ${name} in Pending with ${reason}, and denies new access`, () => {
      const result = nasEligibility(facts(over));
      expect(result.state).toBe('pending');
      expect(result.allowsNewAccess).toBe(false);
      expect(result.reasons).toEqual([reason]);
      expect(result.primaryReason).toBe(reason);
    });
  }

  it('covers every declared reason, so a new one cannot be added without a case here', () => {
    expect(cases.map(([, , reason]) => reason).sort()).toEqual([...NAS_PENDING_REASONS].sort());
  });
});

describe('nasEligibility: several reasons at once', () => {
  it('retains all of them in registry order and picks the first as primary', () => {
    const result = nasEligibility(
      facts({ adoptionComplete: false, ownershipValid: false, policy: 'missing' }),
    );
    // §5: retain all relevant reasons, choose a stable primary display reason.
    expect(result.reasons).toEqual(['NOT_ADOPTED', 'OWNERSHIP_UNRESOLVED', 'NO_POLICY']);
    expect(result.primaryReason).toBe('NOT_ADOPTED');
  });

  it('is stable: the same facts in a different object order give the same primary', () => {
    const a = nasEligibility(facts({ policy: 'missing', identifierConflict: true }));
    const b = nasEligibility(facts({ identifierConflict: true, policy: 'missing' }));
    expect(a.reasons).toEqual(b.reasons);
    expect(a.primaryReason).toBe('IDENTITY_CONFLICT');
  });
});

describe('nasEligibility: administrative state wins', () => {
  it('reports blocked even when every Pending reason also applies', () => {
    const result = nasEligibility(
      facts({
        status: 'blocked',
        adoptionComplete: false,
        ownershipValid: false,
        identifierConflict: true,
        policy: 'unavailable',
      }),
    );
    expect(result.state).toBe('blocked');
    expect(result.allowsNewAccess).toBe(false);
    // Not Pending, so no Pending reasons: the administrative decision is the whole answer.
    expect(result.reasons).toEqual([]);
  });

  it('reports disabled for a disabled NAS, and for a deleted one', () => {
    expect(nasEligibility(facts({ status: 'disabled' })).state).toBe('disabled');
    expect(nasEligibility(facts({ deleted: true })).state).toBe('disabled');
  });

  it('keeps blocked ahead of deleted, so a blocked record does not read as merely disabled', () => {
    expect(nasEligibility(facts({ status: 'blocked', deleted: true })).state).toBe('blocked');
  });

  it('restoring a policy does not re-enable a blocked or disabled NAS', () => {
    // §5: "Restoring a policy must never silently unblock or re-enable a NAS." Administrative
    // state is checked first, so a policy change can only ever move the reasons.
    for (const status of ['blocked', 'disabled']) {
      const before = nasEligibility(facts({ status, policy: 'missing' }));
      const after = nasEligibility(facts({ status, policy: 'assigned' }));
      expect(after.state).toBe(before.state);
      expect(after.allowsNewAccess).toBe(false);
    }
  });

  it('treats an unrecognised status as disabled rather than granting access', () => {
    // `blocked` itself is unrecognised by the database CHECK until the migration adding it has
    // run everywhere, so this is a live path, not a defensive one. A state this build does not
    // understand must not yield access on the strength of not being understood.
    for (const status of ['quarantined', '', 'ACTIVE', 'retired']) {
      const result = nasEligibility(facts({ status }));
      expect(result.state, status).toBe('disabled');
      expect(result.allowsNewAccess, status).toBe(false);
    }
  });
});

describe('nasEligibility: platform defaults are visible without being denials', () => {
  it('stays active on a platform default policy and flags it', () => {
    const result = nasEligibility(facts({ policy: 'platform_default' }));
    // The owner's 2026-10-14 ruling makes this the intended behaviour, so it must not deny.
    expect(result.state).toBe('active');
    expect(result.allowsNewAccess).toBe(true);
    expect(result.reasons).toEqual([]);
    // But it must be enumerable, because nothing else will surface it.
    expect(result.advisories).toEqual(['ON_PLATFORM_DEFAULT_POLICY']);
  });

  it('stays active on a platform default portal and flags it', () => {
    const result = nasEligibility(facts({ onPlatformDefaultPortal: true }));
    expect(result.state).toBe('active');
    expect(result.advisories).toEqual(['ON_PLATFORM_DEFAULT_PORTAL']);
  });

  it('reports both defaults when both apply', () => {
    const result = nasEligibility(
      facts({ policy: 'platform_default', onPlatformDefaultPortal: true }),
    );
    expect(result.advisories).toEqual(['ON_PLATFORM_DEFAULT_POLICY', 'ON_PLATFORM_DEFAULT_PORTAL']);
  });

  it('never reports a platform default as a Pending reason', () => {
    const result = nasEligibility(
      facts({ policy: 'platform_default', onPlatformDefaultPortal: true }),
    );
    for (const advisory of result.advisories) {
      expect(NAS_PENDING_REASONS).not.toContain(advisory as never);
    }
  });

  it('keeps flagging the portal default while the NAS is Pending or blocked', () => {
    // The signal is about configuration, not about eligibility, so it survives every state —
    // otherwise an operator fixing a Pending reason would lose sight of the anonymous portal.
    for (const over of [{ adoptionComplete: false }, { status: 'blocked' }, { deleted: true }]) {
      const result = nasEligibility(facts({ ...over, onPlatformDefaultPortal: true }));
      expect(result.advisories).toContain('ON_PLATFORM_DEFAULT_PORTAL');
    }
  });
});

describe('labels and helpers', () => {
  it('labels every reason and every advisory', () => {
    for (const reason of NAS_PENDING_REASONS) {
      expect(NAS_PENDING_REASON_LABEL[reason]).toBeTruthy();
    }
    for (const advisory of NAS_ADVISORIES) {
      expect(NAS_ADVISORY_LABEL[advisory]).toBeTruthy();
    }
  });

  it('allows new access in the active state only', () => {
    expect(allowsNewAccess('active')).toBe(true);
    for (const state of ['pending', 'disabled', 'blocked'] as const) {
      expect(allowsNewAccess(state), state).toBe(false);
    }
  });
});

describe('an unevaluated policy says so instead of guessing', () => {
  it('contributes no Pending reason and marks the policy dimension unchecked', () => {
    const result = nasEligibility(facts({ policy: 'unevaluated' }));
    // Not Pending: marking every NAS Pending on no evidence would destroy trust in the list.
    // Not silently fine either — `policyEvaluated` is how the surface says which it is.
    expect(result.state).toBe('active');
    expect(result.reasons).toEqual([]);
    expect(result.policyEvaluated).toBe(false);
  });

  it('still reports the non-policy reasons it can evaluate', () => {
    const result = nasEligibility(facts({ policy: 'unevaluated', adoptionComplete: false }));
    expect(result.state).toBe('pending');
    expect(result.reasons).toEqual(['NOT_ADOPTED']);
    expect(result.policyEvaluated).toBe(false);
  });

  it('marks the policy evaluated for every other value', () => {
    for (const policy of [
      'assigned',
      'platform_default',
      'missing',
      'disabled',
      'unavailable',
    ] as const) {
      expect(nasEligibility(facts({ policy })).policyEvaluated, policy).toBe(true);
    }
  });

  it('raises no platform-default advisory, because that is also unknown', () => {
    expect(nasEligibility(facts({ policy: 'unevaluated' })).advisories).toEqual([]);
  });
});
