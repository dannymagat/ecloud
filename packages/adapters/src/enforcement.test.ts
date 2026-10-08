import { chooseEnforcementStrategy } from '@ecloud/policy-engine';
import { describe, expect, it } from 'vitest';
import { dynamicAuthorizationEvidence, fieldEvidence } from './enforcement.js';
import { listAdapters } from './registry.js';
import {
  DEFAULT_WRAP_MAX_BPS,
  counterWrap32Quirks,
  decideWrapCorrection,
  type AccountingAnomaly,
} from './vendor/accounting.js';

const TWO_POW_32 = 4_294_967_296;

describe('dynamic-authorization evidence (P7-A strategy input)', () => {
  it('no first-party adapter has a device-enforced CoA or Disconnect today → next_reauth everywhere', () => {
    for (const adapter of listAdapters()) {
      const key = adapter.capabilities().key;
      const evidence = dynamicAuthorizationEvidence(key);
      expect(evidence, key).not.toBeNull();
      expect(evidence?.coaChange.deviceEnforced, key).toBe(false);
      expect(evidence?.disconnect.deviceEnforced, key).toBe(false);
      for (const dispatcherEnabled of [false, true]) {
        expect(
          chooseEnforcementStrategy({
            adapterKey: key,
            coaChange: evidence?.coaChange ?? null,
            disconnect: evidence?.disconnect ?? null,
            dispatcherEnabled,
          }).strategy,
        ).toBe('next_reauth');
      }
    }
  });

  it('unknown / null adapter keys yield no evidence', () => {
    expect(dynamicAuthorizationEvidence(null)).toBeNull();
    expect(dynamicAuthorizationEvidence('no-such-adapter')).toBeNull();
  });

  it('field evidence is never device-enforced without a lab-validated DT', () => {
    const e = fieldEvidence('coovachilli-uam', 'download_rate_kbps', 'VERIFIED_SUPPORTED');
    expect(e.deviceEnforced).toBe(false);
    expect(e.evidenceLevel).not.toBe('LAB_VALIDATED');
  });
});

describe('decideWrapCorrection (rule W1–W4, closes SIM-14 finding)', () => {
  const flag = (prev: number, next: number, t0: number, t1: number): AccountingAnomaly => {
    const a = counterWrap32Quirks().detectAnomalies(
      { inputOctets: 0, outputOctets: prev, sessionTimeS: t0 },
      { inputOctets: 0, outputOctets: next, sessionTimeS: t1 },
    );
    expect(a).toHaveLength(1);
    return a[0] as AccountingAnomaly;
  };

  it('SIM-14 vector (2^32 − 100 → 500 over 300 s) is unambiguous: +600 bytes, exactly one wrap', () => {
    const d = decideWrapCorrection({
      anomaly: flag(TWO_POW_32 - 100, 500, 300, 600),
      elapsedS: 300,
      maxBps: DEFAULT_WRAP_MAX_BPS,
    });
    expect(d).toMatchObject({ apply: true, bytes: 600 });
    // at 1 Gbit/s, 300 s could also carry a further 2^32 bytes: the correction is a lower bound
    expect(d.multipleWrapsPossible).toBe(true);
    expect(
      decideWrapCorrection({
        anomaly: flag(TWO_POW_32 - 100, 500, 300, 600),
        elapsedS: 300,
        maxBps: 100_000_000,
      }).multipleWrapsPossible,
    ).toBe(false);
  });

  it('SIM-14 vector (both directions, 2^32−1 → 0 and 2^32−2 → 3 over 10 s) corrects 1 and 5 bytes', () => {
    const anomalies = counterWrap32Quirks().detectAnomalies(
      { inputOctets: TWO_POW_32 - 1, outputOctets: TWO_POW_32 - 2, sessionTimeS: 10 },
      { inputOctets: 0, outputOctets: 3, sessionTimeS: 20 },
    );
    expect(
      anomalies.map(
        (anomaly) =>
          decideWrapCorrection({ anomaly, elapsedS: 10, maxBps: DEFAULT_WRAP_MAX_BPS }).bytes,
      ),
    ).toEqual([1, 5]);
  });

  it('W2: a decrease from the lower half (likely a counter reset) is never corrected', () => {
    const d = decideWrapCorrection({
      anomaly: flag(1_000_000_000, 10, 300, 600),
      elapsedS: 300,
      maxBps: DEFAULT_WRAP_MAX_BPS,
    });
    expect(d).toMatchObject({ apply: false, bytes: 0 });
    expect(d.reason).toMatch(/^W2:/);
  });

  it('W3: an observed value still in the upper half is not a clean wrap', () => {
    const d = decideWrapCorrection({
      anomaly: flag(TWO_POW_32 - 10, 3_000_000_000, 300, 600),
      elapsedS: 300,
      maxBps: DEFAULT_WRAP_MAX_BPS,
    });
    expect(d.apply).toBe(false);
    expect(d.reason).toMatch(/^W3:/);
  });

  it('W4: one wrap needing more than the ceiling over the elapsed time is not corrected', () => {
    // 2^31 + 1000 bytes in 1 s ≈ 17 Gbit/s
    const d = decideWrapCorrection({
      anomaly: flag(2_147_483_648, 1000, 10, 11),
      elapsedS: 1,
      maxBps: DEFAULT_WRAP_MAX_BPS,
    });
    expect(d.apply).toBe(false);
    expect(d.reason).toMatch(/^W4:/);
  });

  it('W1: no correction without session time advancing', () => {
    const anomaly: AccountingAnomaly = {
      kind: 'counter_wrap_32bit',
      counter: 'outputOctets',
      previous: TWO_POW_32 - 1,
      observed: 1,
      estimatedLostBytes: 2,
      detail: 'synthetic',
    };
    expect(decideWrapCorrection({ anomaly, elapsedS: 0, maxBps: DEFAULT_WRAP_MAX_BPS }).apply).toBe(
      false,
    );
  });
});
