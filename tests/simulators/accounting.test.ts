/**
 * L4 simulator — accounting normalisation (MULTI_VENDOR_INTEGRATION_PLAN.md §8.3 SIM-10, SIM-11,
 * SIM-13, SIM-14). Rows come from `SimAccountingSession` (`@ecloud/testing`), which applies the
 * FreeRADIUS `(Gigawords << 32) + Octets` fold and the per-adapter counter width (CoovaChilli
 * 64-bit via Gigawords, uspot TIP 32-bit only, PHASE2_VALIDATION V-054). The counter rule
 * applied between packets is the drainer's: `counterDelta(stored, incoming)` then
 * `maxCounters` (apps/worker/src/accounting/drain.ts).
 *
 * Simulator evidence: ECLOUD code behaviour only, NOT hardware compatibility. How the real TIP
 * firmware wraps its 32-bit counters is REQUIRES_DEVICE_TEST.
 */
import { describe, expect, it } from 'vitest';
import { counterDelta, maxCounters, type SessionCounters } from '@ecloud/adapters';
import {
  SimAccountingSession,
  TWO_POW_32,
  freeradiusFold,
  wireCounter,
  type SimPacket,
} from '@ecloud/testing';
import { NOW, TARGETS, type SimTarget } from './support.js';

const at = (s: number): Date => new Date(NOW.getTime() + s * 1000);

function session(t: SimTarget, width: 32 | 64): SimAccountingSession {
  return new SimAccountingSession(
    {
      acctSessionId: '5f3c2a1b0d9e8f70',
      acctUniqueId: `sim-uniq-${t.adapterKey}`,
      username: 'pc-sim-0001',
      callingStationId: 'AA-BB-CC-DD-EE-01',
      calledStationId: '00-11-22-33-44-55',
      nasIp: '192.0.2.10',
      nasIdentifier: t.nas.identifier ?? '',
    },
    width,
  );
}

/** Drainer counter rule over a packet stream; returns per-packet deltas and the final store. */
function drain(
  t: SimTarget,
  sim: SimAccountingSession,
  packets: readonly SimPacket[],
): { deltas: SessionCounters[]; stored: SessionCounters } {
  let stored: SessionCounters = { inputOctets: 0, outputOctets: 0, sessionTimeS: 0 };
  const deltas: SessionCounters[] = [];
  for (const p of packets) {
    const rec = t.adapter.normalizeAccounting(sim.row(p));
    const incoming = {
      inputOctets: rec.inputOctets,
      outputOctets: rec.outputOctets,
      sessionTimeS: rec.sessionTimeS,
    };
    deltas.push(counterDelta(stored, incoming));
    stored = maxCounters(stored, incoming);
  }
  return { deltas, stored };
}

const sum = (ds: readonly SessionCounters[], k: keyof SessionCounters): number =>
  ds.reduce((n, d) => n + d[k], 0);

for (const t of TARGETS) {
  const tag = `[${t.adapterKey}]`;
  const width = t.adapterKey === 'coovachilli-uam' ? 64 : 32;

  describe(`accounting ${tag}`, () => {
    it(`SIM-10 ${tag} identical Interim retransmitted → counterDelta 0, single increment`, () => {
      const interim: SimPacket = {
        status: 'Interim-Update',
        at: at(300),
        inputBytes: 1_048_576,
        outputBytes: 5_000_000,
        sessionTimeS: 300,
        interimS: 300,
      };
      const { deltas, stored } = drain(t, session(t, width), [
        { status: 'Start', at: at(0) },
        interim,
        interim,
      ]);
      expect(deltas[1]).toEqual({
        inputOctets: 1_048_576,
        outputOctets: 5_000_000,
        sessionTimeS: 300,
      });
      expect(deltas[2]).toEqual({ inputOctets: 0, outputOctets: 0, sessionTimeS: 0 });
      expect(stored).toEqual({
        inputOctets: 1_048_576,
        outputOctets: 5_000_000,
        sessionTimeS: 300,
      });
    });

    it(`SIM-11 ${tag} out-of-order Interim → no negative delta, counters = max`, () => {
      const { deltas, stored } = drain(t, session(t, width), [
        { status: 'Start', at: at(0) },
        {
          status: 'Interim-Update',
          at: at(600),
          inputBytes: 3_000,
          outputBytes: 9_000,
          sessionTimeS: 600,
        },
        // delayed older Interim arrives after the newer one
        {
          status: 'Interim-Update',
          at: at(610),
          inputBytes: 1_000,
          outputBytes: 4_000,
          sessionTimeS: 300,
        },
        {
          status: 'Stop',
          at: at(900),
          inputBytes: 5_000,
          outputBytes: 12_000,
          sessionTimeS: 900,
          terminateCause: 'User-Request',
        },
      ]);
      for (const d of deltas) for (const v of Object.values(d)) expect(v).toBeGreaterThanOrEqual(0);
      expect(deltas[2]).toEqual({ inputOctets: 0, outputOctets: 0, sessionTimeS: 0 });
      expect(stored).toEqual({ inputOctets: 5_000, outputOctets: 12_000, sessionTimeS: 900 });
      // Period usage = sum of deltas = final cumulative counters (nothing counted twice).
      expect(sum(deltas, 'inputOctets')).toBe(5_000);
      expect(sum(deltas, 'outputOctets')).toBe(12_000);
      const stop = t.adapter.normalizeAccounting(
        session(t, width).row({ status: 'Stop', at: at(900), terminateCause: 'User-Request' }),
      );
      expect(stop).toMatchObject({ statusType: 'stop', terminateCause: 'user_request' });
    });
  });
}

const coova = TARGETS.find((t) => t.adapterKey === 'coovachilli-uam');
const tip = TARGETS.find((t) => t.adapterKey === 'openwifi-uspot-uam');
if (!coova || !tip) throw new Error('simulator targets missing');

describe('counter width', () => {
  const before = TWO_POW_32 - 100;
  const after = TWO_POW_32 + 500;

  it('SIM-13 [coovachilli-uam] Gigawords rollover yields the correct 64-bit total', () => {
    // Wire view: Octets wraps to 500 while Gigawords goes 0 → 1 (CoovaChilli, V-073).
    expect(wireCounter(before, 64)).toEqual({ octets: TWO_POW_32 - 100, gigawords: 0 });
    expect(wireCounter(after, 64)).toEqual({ octets: 500, gigawords: 1 });
    expect(freeradiusFold(wireCounter(after, 64))).toBe(after);
    const sim = session(coova, 64);
    const { deltas, stored } = drain(coova, sim, [
      { status: 'Start', at: at(0) },
      {
        status: 'Interim-Update',
        at: at(300),
        inputBytes: 10,
        outputBytes: before,
        sessionTimeS: 300,
      },
      {
        status: 'Interim-Update',
        at: at(600),
        inputBytes: 20,
        outputBytes: after,
        sessionTimeS: 600,
      },
      {
        status: 'Interim-Update',
        at: at(900),
        inputBytes: 30,
        outputBytes: 3 * TWO_POW_32 + 7,
        sessionTimeS: 900,
      },
    ]);
    expect(deltas[2]?.outputOctets).toBe(600);
    expect(stored.outputOctets).toBe(3 * TWO_POW_32 + 7);
    expect(sum(deltas, 'outputOctets')).toBe(3 * TWO_POW_32 + 7);
    expect(Number.isSafeInteger(stored.outputOctets)).toBe(true);
  });

  it('SIM-14 [openwifi-uspot-uam] 32-bit wrap without Gigawords → no negative or huge delta', () => {
    expect(wireCounter(after, 32)).toEqual({ octets: 500, gigawords: null });
    const sim = session(tip, 32);
    const { deltas, stored } = drain(tip, sim, [
      { status: 'Start', at: at(0) },
      {
        status: 'Interim-Update',
        at: at(300),
        inputBytes: 10,
        outputBytes: before,
        sessionTimeS: 300,
      },
      {
        status: 'Interim-Update',
        at: at(600),
        inputBytes: 20,
        outputBytes: after,
        sessionTimeS: 600,
      },
    ]);
    for (const d of deltas) {
      expect(d.outputOctets).toBeGreaterThanOrEqual(0);
      expect(d.outputOctets).toBeLessThan(TWO_POW_32);
    }
    // The wrapped packet contributes nothing (monotonic rule) and the store keeps the pre-wrap
    // maximum: usage after a wrap is UNDER-counted until the 32-bit counter passes it again.
    expect(deltas[2]?.outputOctets).toBe(0);
    expect(stored.outputOctets).toBe(before);
    // Session time still advances (it does not wrap).
    expect(deltas[2]?.sessionTimeS).toBe(300);
  });

  it('SIM-14 [openwifi-uspot-uam] 32-bit wrap is flagged as an anomaly by the vendor quirks hook', () => {
    // Plan §8.3 SIM-14: the hook only reports; normalisation and the drainer counter rule are
    // unchanged (asserted above: wrapped packet delta 0, store keeps the pre-wrap maximum).
    const quirks = tip.adapter.accountingQuirks;
    expect(quirks).toBeDefined();
    if (!quirks) return;
    const sim = session(tip, 32);
    const packets: SimPacket[] = [
      { status: 'Start', at: at(0) },
      {
        status: 'Interim-Update',
        at: at(300),
        inputBytes: 10,
        outputBytes: before,
        sessionTimeS: 300,
      },
      {
        status: 'Interim-Update',
        at: at(600),
        inputBytes: 20,
        outputBytes: after,
        sessionTimeS: 600,
      },
    ];
    let stored: SessionCounters = { inputOctets: 0, outputOctets: 0, sessionTimeS: 0 };
    const flagged: {
      readonly packet: number;
      readonly kinds: string[];
      readonly lost: number[];
    }[] = [];
    packets.forEach((p, i) => {
      const rec = tip.adapter.normalizeAccounting(sim.row(p));
      const a = quirks.detectAnomalies(stored, rec);
      if (a.length > 0)
        flagged.push({
          packet: i,
          kinds: a.map((x) => `${x.kind}:${x.counter}`),
          lost: a.map((x) => x.estimatedLostBytes),
        });
      stored = maxCounters(stored, rec);
    });
    // Only the wrapped Interim is flagged; the lost bytes are exactly the bytes the wrap hid
    // (true total `after` − stored `before`).
    expect(flagged).toEqual([
      { packet: 2, kinds: ['counter_wrap_32bit:outputOctets'], lost: [after - before] },
    ]);
    // CoovaChilli reports 64-bit totals via Gigawords (SIM-13): no quirks hook.
    expect(coova.adapter.accountingQuirks).toBeUndefined();
  });
});
