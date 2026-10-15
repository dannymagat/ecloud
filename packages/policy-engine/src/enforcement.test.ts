import { describe, expect, it } from 'vitest';
import { captive32, untested } from './adapters.fixture.js';
import { INTENT_COLUMNS } from './intent.js';
import {
  DEFAULT_SESSION_TIMEOUT_CAP_S,
  NO_SILENT_REAUTH_ADAPTERS,
  chooseEnforcementStrategy,
  expectedReauthBy,
  impactMessage,
  sessionTimeoutCapFor,
  type MechanismEvidence,
} from './enforcement.js';
import type { Clip, EffectivePolicy } from './resolve.js';
import { translate } from './translate.js';

const NOW = new Date('2026-10-08T06:00:00Z');
const verifiedLab: MechanismEvidence = {
  status: 'VERIFIED_SUPPORTED',
  evidenceLevel: 'LAB_VALIDATED',
  deviceEnforced: true,
};
const verifiedSource: MechanismEvidence = {
  status: 'VERIFIED_SUPPORTED',
  evidenceLevel: 'VERIFIED_FROM_SOURCE',
  deviceEnforced: false,
};
const rdt: MechanismEvidence = {
  status: 'REQUIRES_DEVICE_TEST',
  evidenceLevel: 'DOCUMENTED',
  deviceEnforced: false,
};

describe('chooseEnforcementStrategy (P7-A, D-006, D-028 V12)', () => {
  it('no engine adapter → none / unsupported', () => {
    expect(
      chooseEnforcementStrategy({
        adapterKey: null,
        coaChange: null,
        disconnect: null,
        dispatcherEnabled: true,
      }),
    ).toMatchObject({ strategy: 'none', state: 'unsupported' });
  });

  it('source-verified or device-test-pending mechanisms never drive a live change → next_reauth', () => {
    for (const dispatcherEnabled of [false, true]) {
      const d = chooseEnforcementStrategy({
        adapterKey: 'coovachilli-uam',
        coaChange: verifiedSource,
        disconnect: rdt,
        dispatcherEnabled,
      });
      expect(d).toMatchObject({ strategy: 'next_reauth', state: 'pending' });
      expect(d.reason).toContain('not lab-validated');
    }
  });

  it('lab-validated mechanisms are used only when the dispatcher is enabled', () => {
    const base = { adapterKey: 'coovachilli-uam', coaChange: verifiedLab, disconnect: verifiedLab };
    expect(chooseEnforcementStrategy({ ...base, dispatcherEnabled: false })).toMatchObject({
      strategy: 'next_reauth',
    });
    expect(chooseEnforcementStrategy({ ...base, dispatcherEnabled: false }).reason).toContain(
      'dispatcher disabled (D-006)',
    );
    expect(chooseEnforcementStrategy({ ...base, dispatcherEnabled: true }).strategy).toBe(
      'coa_change',
    );
    expect(
      chooseEnforcementStrategy({ ...base, coaChange: rdt, dispatcherEnabled: true }).strategy,
    ).toBe('disconnect_reauth');
  });

  it('device_enforced without VERIFIED_SUPPORTED status is not trusted', () => {
    expect(
      chooseEnforcementStrategy({
        adapterKey: 'x',
        coaChange: { ...rdt, deviceEnforced: true },
        disconnect: { ...rdt, deviceEnforced: true },
        dispatcherEnabled: true,
      }).strategy,
    ).toBe('next_reauth');
  });

  it('expectedReauthBy = start + Session-Timeout sent; null when none was sent', () => {
    expect(expectedReauthBy(NOW, 1800)).toEqual(new Date(NOW.getTime() + 1_800_000));
    expect(expectedReauthBy(NOW, null)).toBeNull();
    expect(expectedReauthBy(NOW, 0)).toBeNull();
  });

  it('impactMessage wording (admin preview)', () => {
    const counts = { coa_change: 0, disconnect_reauth: 0, next_reauth: 3, none: 1 };
    expect(impactMessage(4, counts, 1800)).toBe(
      '4 sessions affected; strategy 3 next_reauth, 1 none; next_reauth applies at next login, at most 30 min',
    );
    expect(impactMessage(0, { ...counts, next_reauth: 0, none: 0 }, 1800)).toBe(
      'No open session is affected',
    );
    expect(impactMessage(1, { ...counts, none: 0, next_reauth: 1 }, 0)).toContain(
      'no Session-Timeout cap configured',
    );
  });
});

describe('translate: Q44 Session-Timeout cap (policy_change_cap)', () => {
  const emptyClip: Clip = {
    policy_session_timeout_s: null,
    window_end_s: null,
    validity_end_s: null,
    voucher_end_s: null,
    quota_reset_s: null,
    remaining_octets: null,
    remaining_period: null,
  remaining_time_s: null,
  remaining_time_period: null,
    drain_time_s: null,
    min_session_s: 300,
  };
  const blank = Object.fromEntries(
    INTENT_COLUMNS.map((k) => [k, null]),
  ) as unknown as EffectivePolicy['fields'];
  const eff: EffectivePolicy = {
    fields: { ...blank, session_timeout_s: 7200 },
    schedule: null,
    schedules: [],
    provenance: {},
    winner: null,
    concurrency_mode: null,
    critical_fields: [],
  unlimited: [],
  };

  it('caps a longer policy timeout and bounds an unbounded session', () => {
    const capped = translate(eff, captive32, {
      clip: { ...emptyClip, policy_session_timeout_s: 7200 },
      now: NOW,
      sessionTimeoutCapS: DEFAULT_SESSION_TIMEOUT_CAP_S,
    });
    expect(capped.sessionTimeout).toMatchObject({ value: 1800, boundBy: 'policy_change_cap' });
    expect(capped.radiusReplyAttributes.find((a) => a.name === 'Session-Timeout')?.value).toBe(
      1800,
    );

    const unbounded = translate({ ...eff, fields: blank }, captive32, {
      clip: emptyClip,
      now: NOW,
      sessionTimeoutCapS: 1800,
    });
    expect(unbounded.sessionTimeout).toMatchObject({ value: 1800, boundBy: 'policy_change_cap' });
  });

  it('a shorter bound wins; no cap when unset / 0; an unverified Session-Timeout attr is still flagged', () => {
    const shorter = translate(eff, captive32, {
      clip: { ...emptyClip, policy_session_timeout_s: 600 },
      now: NOW,
      sessionTimeoutCapS: 1800,
    });
    expect(shorter.sessionTimeout).toMatchObject({ value: 600, boundBy: 'policy' });
    for (const cap of [undefined, null, 0]) {
      expect(
        translate(eff, captive32, {
          clip: { ...emptyClip, policy_session_timeout_s: 7200 },
          now: NOW,
          sessionTimeoutCapS: cap,
        }).sessionTimeout.value,
      ).toBe(7200);
    }
    const flagged = translate(eff, untested, {
      clip: { ...emptyClip, policy_session_timeout_s: 7200 },
      now: NOW,
      sessionTimeoutCapS: 1800,
    });
    expect(flagged.radiusReplyAttributes.some((a) => a.name === 'Session-Timeout')).toBe(false);
  });
});

describe('sessionTimeoutCapFor (pilot observation 2026-10-15)', () => {
  const cap = DEFAULT_SESSION_TIMEOUT_CAP_S;

  it('caps a next_reauth session on an adapter that re-authenticates silently', () => {
    // The Q44 trade as designed: bound how long a policy change waits, at no cost a guest sees.
    expect(
      sessionTimeoutCapFor({
        adapterKey: 'openwifi-hostapd-radius',
        strategy: 'next_reauth',
        configuredCapS: cap,
      }),
    ).toBe(cap);
  });

  it('does not cap uspot, because there the cap is a logout rather than a re-auth', () => {
    // Observed on the pilot AP1832: login 08:16:15Z, portal again 08:46:15Z, exactly 1800 s, on a
    // policy promising one day. uspot has no silent re-auth, so Session-Timeout ends the session.
    for (const adapterKey of ['openwifi-uspot-uam', 'uspot-upstream-uam']) {
      expect(
        sessionTimeoutCapFor({ adapterKey, strategy: 'next_reauth', configuredCapS: cap }),
        adapterKey,
      ).toBeNull();
    }
  });

  it('never caps when the strategy carries the change itself', () => {
    // coa_change and disconnect_reauth reach a live session directly, so nothing needs bounding;
    // `none` means the NAS has no adapter and EZECLOUD sends it no attributes at all.
    for (const strategy of ['coa_change', 'disconnect_reauth', 'none'] as const) {
      expect(
        sessionTimeoutCapFor({
          adapterKey: 'openwifi-hostapd-radius',
          strategy,
          configuredCapS: cap,
        }),
        strategy,
      ).toBeNull();
      expect(
        sessionTimeoutCapFor({ adapterKey: 'openwifi-uspot-uam', strategy, configuredCapS: cap }),
        `uspot/${strategy}`,
      ).toBeNull();
    }
  });

  it('caps a null adapter key under next_reauth rather than exempting it', () => {
    // A null key is "no adapter we recognise", not "an adapter we know logs people out". Failing
    // towards the cap keeps policy-change latency bounded for anything unidentified.
    expect(
      sessionTimeoutCapFor({ adapterKey: null, strategy: 'next_reauth', configuredCapS: cap }),
    ).toBe(cap);
  });

  it('lists only adapters whose logout has actually been observed', () => {
    // coovachilli-uam is the same shape but exposes a CoA path and nobody has observed the logout
    // on it. Adding an adapter here on reasoning alone turns a capability claim into fiction,
    // which is what the evidence registry exists to prevent.
    expect([...NO_SILENT_REAUTH_ADAPTERS].sort()).toEqual([
      'openwifi-uspot-uam',
      'uspot-upstream-uam',
    ]);
  });
});
