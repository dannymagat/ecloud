/**
 * Pure analysis of iperf3 samples against the policy expectation. Every function returns a
 * PROPOSED verdict with the numbers behind it; none can produce a final PASS.
 *
 * Rules (stated so a reviewer can re-check them by hand):
 *  - DT-04 throughput: measured = receiver-side average (`end.sum_received`, falling back to
 *    the median 1 s sample). |measured − expected| / expected ≤ tolerance → PROPOSED_PASS;
 *    faster than expected + tolerance → PROPOSED_FAIL (not shaped to the policy; check the DT-01
 *    dictionary result before a human records FAIL); slower than expected − tolerance →
 *    INCONCLUSIVE (link/client bottleneck cannot be told apart from over-shaping).
 *  - Cut-off detection: the first sample from which every remaining sample is below the
 *    activity threshold (max(8 kbit/s, 5 % of the 90th-percentile sample)), preceded by at
 *    least one active sample; if iperf3 stopped with an error while still active, the cut-off is
 *    the end of the last sample.
 *  - DT-05 Session-Timeout: cut-off time since login within ±tolerance → PROPOSED_PASS; earlier
 *    → PROPOSED_FAIL; no cut-off although the run outlasted expected + tolerance →
 *    PROPOSED_FAIL; run too short to tell → INCONCLUSIVE.
 *  - DT-05 idle probe: reachable (no error and an active sample) must equal the expectation.
 *  - DT-06 quota: bytes transferred before the cut-off vs the quota; overshoot allowed up to
 *    poll_interval × pre-cut-off rate (uspot polls every 10 s); a cut more than
 *    early_tolerance % before the quota → INCONCLUSIVE (earlier usage or another cause); no cut
 *    after more than quota + allowance → PROPOSED_FAIL.
 */
import type {
  Finding,
  IdleProbeCase,
  Iperf3Run,
  ProposedVerdict,
  QuotaCase,
  Sample,
  SessionTimeoutCase,
} from './types.js';

export const MIN_ACTIVE_BPS = 8_000;

function sorted(values: readonly number[]): number[] {
  return [...values].sort((a, b) => a - b);
}

export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const s = sorted(values);
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[idx] ?? null;
}

export function median(values: readonly number[]): number | null {
  return percentile(values, 50);
}

function round(n: number, digits = 1): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

export function activityThreshold(samples: readonly Sample[]): number {
  const p90 = percentile(
    samples.map((s) => s.bits_per_second),
    90,
  );
  return Math.max(MIN_ACTIVE_BPS, (p90 ?? 0) * 0.05);
}

/** Index of the first sample of the trailing inactive run, or null when traffic never stopped. */
export function cutoffIndex(samples: readonly Sample[]): number | null {
  const threshold = activityThreshold(samples);
  let i = samples.length;
  while (i > 0 && (samples[i - 1]?.bits_per_second ?? 0) < threshold) i--;
  if (i === samples.length || i === 0) return null;
  return i;
}

/** Seconds since the start of the run at which traffic stopped, or null. */
export function cutoffSeconds(run: Iperf3Run): number | null {
  const idx = cutoffIndex(run.samples);
  if (idx !== null) return run.samples[idx]?.start_s ?? null;
  const last = run.samples.at(-1);
  if (run.error !== null && last !== undefined && last.bits_per_second >= MIN_ACTIVE_BPS) {
    return last.end_s;
  }
  return null;
}

export function combine(verdicts: readonly ProposedVerdict[]): ProposedVerdict {
  if (verdicts.length === 0) return 'INCONCLUSIVE';
  if (verdicts.includes('PROPOSED_FAIL')) return 'PROPOSED_FAIL';
  if (verdicts.includes('INCONCLUSIVE')) return 'INCONCLUSIVE';
  return 'PROPOSED_PASS';
}

export function throughputFinding(
  run: Iperf3Run,
  expectedKbps: number,
  tolerancePct: number,
): Finding {
  const check = `${run.direction === 'down' ? 'download' : 'upload'} rate`;
  const expected = `${expectedKbps} kbit/s ±${tolerancePct} %`;
  const bps =
    run.receiver_bits_per_second ?? median(run.samples.map((s) => s.bits_per_second)) ?? null;
  if (bps === null || (run.error !== null && run.samples.length === 0)) {
    return {
      check,
      expected,
      measured: 'no measurement',
      proposed: 'INCONCLUSIVE',
      note: run.error ?? 'iperf3 reported no samples',
    };
  }
  const kbps = bps / 1000;
  const deviation = ((kbps - expectedKbps) / expectedKbps) * 100;
  const measured = `${round(kbps)} kbit/s (${deviation >= 0 ? '+' : ''}${round(deviation)} %)`;
  if (Math.abs(deviation) <= tolerancePct) {
    return {
      check,
      expected,
      measured,
      proposed: 'PROPOSED_PASS',
      note:
        run.error === null
          ? 'within tolerance'
          : `within tolerance, but iperf3 reported: ${run.error}`,
    };
  }
  if (deviation > tolerancePct) {
    return {
      check,
      expected,
      measured,
      proposed: 'PROPOSED_FAIL',
      note: 'faster than the policy: not shaped to the configured rate (check the DT-01 dictionary result before recording FAIL)',
    };
  }
  return {
    check,
    expected,
    measured,
    proposed: 'INCONCLUSIVE',
    note: 'slower than the policy: a link/client bottleneck cannot be told apart from over-shaping; rerun with an unshaped baseline',
  };
}

export function sessionTimeoutFinding(
  c: SessionTimeoutCase,
  run: Iperf3Run,
  loginOffsetS: number,
): Finding {
  const check = 'Session-Timeout cut-off';
  const expected = `${c.expected_s} s ±${c.tolerance_s} s after login`;
  const cut = cutoffSeconds(run);
  const lastEnd = run.samples.at(-1)?.end_s ?? 0;
  if (cut === null) {
    const outlasted = loginOffsetS + lastEnd > c.expected_s + c.tolerance_s;
    return {
      check,
      expected,
      measured: `no cut-off within ${round(loginOffsetS + lastEnd)} s after login`,
      proposed: outlasted ? 'PROPOSED_FAIL' : 'INCONCLUSIVE',
      note: outlasted
        ? 'traffic kept flowing past the Session-Timeout'
        : `run too short to observe the timeout${run.error ? ` (iperf3: ${run.error})` : ''}`,
    };
  }
  const at = loginOffsetS + cut;
  const delta = at - c.expected_s;
  const measured = `cut at ${round(at)} s after login (${delta >= 0 ? '+' : ''}${round(delta)} s)`;
  if (Math.abs(delta) <= c.tolerance_s) {
    return {
      check,
      expected,
      measured,
      proposed: 'PROPOSED_PASS',
      note: 'confirm Acct-Terminate-Cause = Session-Timeout (5) in the pcap',
    };
  }
  return {
    check,
    expected,
    measured,
    proposed: 'PROPOSED_FAIL',
    note:
      delta < 0
        ? 'cut before the Session-Timeout: another cause (check Acct-Terminate-Cause)'
        : 'cut later than the Session-Timeout tolerance',
  };
}

export function idleProbeFinding(c: IdleProbeCase, run: Iperf3Run): Finding {
  const reachable =
    run.error === null && run.samples.some((s) => s.bits_per_second >= MIN_ACTIVE_BPS);
  const check = `Idle-Timeout probe after ${c.idle_wait_s} s idle`;
  const expected = c.expect_reachable ? 'reachable (session alive)' : 'unreachable (session cut)';
  const measured = reachable ? 'reachable' : `unreachable${run.error ? ` (${run.error})` : ''}`;
  return {
    check,
    expected,
    measured,
    proposed: reachable === c.expect_reachable ? 'PROPOSED_PASS' : 'PROPOSED_FAIL',
    note: c.expect_reachable
      ? 'the probe itself resets the idle timer: run the "after" probe on a fresh login'
      : 'an unreachable probe is not proof of the idle cut: confirm Acct-Terminate-Cause = Idle-Timeout (4) in the pcap',
  };
}

export function quotaFinding(c: QuotaCase, run: Iperf3Run): Finding {
  const check = 'Max-Total-Octets cut-off';
  const expected = `traffic stops after ${c.quota_bytes} bytes (+ ≤ ${c.poll_interval_s} s × rate)`;
  const idx = cutoffIndex(run.samples);
  const before = idx === null ? run.samples : run.samples.slice(0, idx);
  const bytes = before.reduce((sum, s) => sum + s.bytes, 0);
  const rateBytesPerS = (median(before.map((s) => s.bits_per_second)) ?? 0) / 8;
  const allowance = c.poll_interval_s * rateBytesPerS;
  if (idx === null) {
    return {
      check,
      expected,
      measured: `no cut-off; ${bytes} bytes transferred`,
      proposed: bytes > c.quota_bytes + allowance ? 'PROPOSED_FAIL' : 'INCONCLUSIVE',
      note:
        bytes > c.quota_bytes + allowance
          ? 'traffic continued past the quota and the poll allowance'
          : 'the run transferred less than quota + allowance: lengthen duration_s',
    };
  }
  const overshoot = bytes - c.quota_bytes;
  const measured = `cut after ${bytes} bytes (${overshoot >= 0 ? '+' : ''}${overshoot} vs quota; allowance ${Math.round(allowance)})`;
  if (bytes < c.quota_bytes * (1 - c.early_tolerance_pct / 100)) {
    return {
      check,
      expected,
      measured,
      proposed: 'INCONCLUSIVE',
      note: 'cut well before the quota: earlier usage (portal, DNS) or another cause; check Acct-Terminate-Cause and the Stop octets',
    };
  }
  if (overshoot > allowance) {
    return {
      check,
      expected,
      measured,
      proposed: 'PROPOSED_FAIL',
      note: 'overshoot larger than one poll interval at the measured rate',
    };
  }
  return {
    check,
    expected,
    measured,
    proposed: 'PROPOSED_PASS',
    note: 'confirm Acct-Terminate-Cause = Session-Timeout (5) and the Stop octets in the pcap',
  };
}
