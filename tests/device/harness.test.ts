/**
 * Device measurement harness (Phase 7 P7-B AC1) — DRY RUN ONLY: every test drives the fake
 * iperf3 (tests/device/fake-iperf3.mjs); nothing here talks to a network device.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { cutoffIndex, throughputFinding } from './harness/analyze.js';
import { iperf3Args, parseIperf3Json } from './harness/iperf3.js';
import { validateProfile } from './harness/measure.js';
import type { Iperf3Run, Sample } from './harness/types.js';
import { LIVE_ENV, UsageError, main } from './run.js';

const PROFILE = join(import.meta.dirname, 'profiles', 'lab.example.json');
const OUT = mkdtempSync(join(tmpdir(), 'ecloud-device-harness-'));
const quiet = { write: () => undefined, env: {} as NodeJS.ProcessEnv };

afterAll(() => {
  rmSync(OUT, { recursive: true, force: true });
});

function run(dt: string, kase: string, extra: string[] = []) {
  return main(['--profile', PROFILE, '--dt', dt, '--case', kase, '--out', OUT, ...extra], quiet);
}

describe('dry run (fake iperf3): measured values + proposed verdict, never PASS', () => {
  it('DT-04 shaped as configured → PROPOSED_PASS, still pending human sign-off, not evidence', async () => {
    const r = await run('DT-04', 'u2');
    expect(r.mode).toBe('dry-run');
    expect(r.evidence_usable).toBe(false);
    expect(r.runs.map((x) => x.direction)).toEqual(['up', 'down']);
    expect(r.runs[1]?.argv).toContain('-R');
    expect(r.runs[0]?.samples).toHaveLength(20); // -O 2 omitted intervals excluded
    expect(r.findings.map((f) => f.proposed)).toEqual(['PROPOSED_PASS', 'PROPOSED_PASS']);
    expect(r.proposed_verdict).toBe('PROPOSED_PASS');
    expect(r.verdict).toBe('PENDING_HUMAN_SIGNOFF');
    expect(r.signoff).toMatchObject({ required: true, signed_by: null, final_result: null });
    expect(r.results_row_draft).toMatch(/^\| DT-04 \|/);
    expect(r.results_row_draft).toContain('DRY RUN (fake iperf3) — NOT EVIDENCE');
    expect(r.results_row_draft).toContain('**PENDING HUMAN SIGN-OFF** (harness proposes: PASS)');
    expect(r.results_row_draft).toContain('V-052, V-053, V-063');
    expect(r.results_row_draft.split(' | ')).toHaveLength(11); // §5.4 has 11 columns

    const files = readdirSync(OUT).filter((f) => f.startsWith('DT-04_u2_'));
    expect(files.some((f) => f.endsWith('_dry-run.json'))).toBe(true);
    expect(files.some((f) => f.endsWith('_dry-run.row.md'))).toBe(true);
    const json = JSON.parse(
      readFileSync(
        join(
          OUT,
          files.find((f) => f.endsWith('.json'))!,
        ),
        'utf8',
      ),
    ) as { verdict: string };
    expect(json.verdict).toBe('PENDING_HUMAN_SIGNOFF');
  });

  it('DT-04 unshaped → PROPOSED_FAIL; slower than policy → INCONCLUSIVE; unreachable → INCONCLUSIVE', async () => {
    const fast = await run('DT-04', 'u2', [
      '--fake-scenario',
      '{"down_kbps":50000,"up_kbps":1000}',
    ]);
    expect(fast.findings.map((f) => f.proposed)).toEqual(['PROPOSED_PASS', 'PROPOSED_FAIL']);
    expect(fast.proposed_verdict).toBe('PROPOSED_FAIL');
    const slow = await run('DT-04', 'u20', [
      '--fake-scenario',
      '{"down_kbps":9000,"up_kbps":10000}',
    ]);
    expect(slow.proposed_verdict).toBe('INCONCLUSIVE');
    const down = await run('DT-04', 'u5', ['--fake-scenario', '{"unreachable":true}']);
    expect(down.proposed_verdict).toBe('INCONCLUSIVE');
    expect(down.findings[0]?.note).toMatch(/Connection refused/);
    expect(down.verdict).toBe('PENDING_HUMAN_SIGNOFF');
  });

  it('DT-05 Session-Timeout: cut at 120 s after login → PROPOSED_PASS; early cut / no cut → PROPOSED_FAIL', async () => {
    const ok = await run('DT-05', 'session-timeout-120', ['--login-offset-s', '7']);
    expect(ok.runs[0]?.argv).toEqual(expect.arrayContaining(['-t', '193', '-R']));
    expect(ok.findings[0]).toMatchObject({ proposed: 'PROPOSED_PASS' });
    expect(ok.findings[0]?.measured).toMatch(/^cut at 120 s after login/);
    const early = await run('DT-05', 'session-timeout-120', [
      '--login-offset-s',
      '7',
      '--fake-scenario',
      '{"down_kbps":5000,"cutoff_after_s":53}',
    ]);
    expect(early.findings[0]).toMatchObject({ proposed: 'PROPOSED_FAIL' });
    const never = await run('DT-05', 'session-timeout-120', [
      '--login-offset-s',
      '7',
      '--fake-scenario',
      '{"down_kbps":5000}',
    ]);
    expect(never.findings[0]).toMatchObject({ proposed: 'PROPOSED_FAIL' });
    expect(never.findings[0]?.measured).toMatch(/no cut-off/);
  });

  it('DT-05 needs the login offset for Session-Timeout; idle probes compare reachability', async () => {
    await expect(run('DT-05', 'session-timeout-120')).rejects.toThrow(/--login-offset-s/);
    expect((await run('DT-05', 'idle-60-before')).proposed_verdict).toBe('PROPOSED_PASS');
    expect((await run('DT-05', 'idle-60-after')).proposed_verdict).toBe('PROPOSED_PASS');
    const notCut = await run('DT-05', 'idle-60-after', ['--fake-scenario', '{"down_kbps":5000}']);
    expect(notCut.proposed_verdict).toBe('PROPOSED_FAIL');
    expect(notCut.manual_observations).toHaveProperty('acct_terminate_cause', null);
  });

  it('DT-06 quota: cut at the quota → PROPOSED_PASS; overshoot past one poll → FAIL; no cut → FAIL', async () => {
    const ok = await run('DT-06', 'quota-50MB');
    expect(ok.findings[0]).toMatchObject({ proposed: 'PROPOSED_PASS' });
    expect(ok.findings[0]?.measured).toMatch(/^cut after 52428800 bytes/);
    // 20 Mbit/s = 2.5 MB/s; allowance 10 s = 25 MB; a 30 MB overshoot is too much
    const over = await run('DT-06', 'quota-50MB', [
      '--fake-scenario',
      '{"down_kbps":20000,"cutoff_after_bytes":52428800,"overshoot_bytes":30000000}',
    ]);
    expect(over.findings[0]).toMatchObject({ proposed: 'PROPOSED_FAIL' });
    const none = await run('DT-06', 'quota-50MB', ['--fake-scenario', '{"down_kbps":20000}']);
    expect(none.findings[0]).toMatchObject({ proposed: 'PROPOSED_FAIL' });
    const early = await run('DT-06', 'quota-50MB', [
      '--fake-scenario',
      '{"down_kbps":20000,"cutoff_after_bytes":30000000}',
    ]);
    expect(early.findings[0]).toMatchObject({ proposed: 'INCONCLUSIVE' });
  });
});

describe('refusals and safety', () => {
  it.each([['--pass'], ['--verdict=PASS'], ['--sign-off'], ['--signed-by', 'me'], ['--mark-pass']])(
    'refuses %s: the harness never sets a verdict',
    async (...flag) => {
      await expect(run('DT-04', 'u2', flag)).rejects.toThrow(UsageError);
      await expect(run('DT-04', 'u2', flag)).rejects.toThrow(/never sets a verdict/);
    },
  );

  it(`--live needs ${LIVE_ENV}=1; live-only and dry-run-only options are exclusive`, async () => {
    await expect(run('DT-04', 'u2', ['--live'])).rejects.toThrow(new RegExp(LIVE_ENV));
    await expect(run('DT-04', 'u2', ['--iperf3', '/usr/bin/iperf3'])).rejects.toThrow(/live only/);
    await expect(run('DT-04', 'u2', ['--live', '--dry-run'])).rejects.toThrow(/exclusive/);
    await expect(run('DT-04', 'nope')).rejects.toThrow(/no DT-04 case "nope"/);
    await expect(run('DT-99', 'u2')).rejects.toThrow(/--dt must be one of/);
  });

  it('the example profile is valid and contradictory profiles are rejected', () => {
    const profile = JSON.parse(readFileSync(PROFILE, 'utf8')) as Record<string, unknown>;
    expect(() => validateProfile(profile)).not.toThrow();
    const bad = structuredClone(profile) as { cases: { 'DT-05': { expect_reachable: boolean }[] } };
    bad.cases['DT-05'][1]!.expect_reachable = false;
    expect(() => validateProfile(bad)).toThrow(/contradicts/);
    expect(() => validateProfile({ ...profile, format: 'x' })).toThrow(/format/);
    // no field can carry a secret: the profile format has none
    expect(JSON.stringify(profile)).not.toMatch(/secret|password|token/i);
  });
});

describe('iperf3 parsing and analysis units', () => {
  it('builds argv (-R = download) and parses -J output, skipping omitted intervals', () => {
    expect(
      iperf3Args({ server: 'h', port: 5201, direction: 'down', duration_s: 20, omit_s: 2 }),
    ).toEqual(['-c', 'h', '-p', '5201', '-J', '-i', '1', '-t', '20', '-O', '2', '-R']);
    const parsed = parseIperf3Json(
      JSON.stringify({
        intervals: [
          { sum: { start: 0, end: 1, bytes: 1, bits_per_second: 8, omitted: true } },
          { sum: { start: 0, end: 1, bytes: 250_000, bits_per_second: 2_000_000, omitted: false } },
        ],
        end: {
          sum_received: { bits_per_second: 2_000_000 },
          sum_sent: { bits_per_second: 2_100_000 },
        },
      }),
    );
    expect(parsed.samples).toHaveLength(1);
    expect(parsed.receiver_bits_per_second).toBe(2_000_000);
    expect(parseIperf3Json('iperf3: error').error).toMatch(/not JSON/);
  });

  it('cut-off needs prior activity; tolerance boundary is inclusive', () => {
    const s = (bps: number[]): Sample[] =>
      bps.map((b, i) => ({ start_s: i, end_s: i + 1, bytes: b / 8, bits_per_second: b }));
    expect(cutoffIndex(s([0, 0, 0]))).toBeNull();
    expect(cutoffIndex(s([5e6, 5e6, 5e6]))).toBeNull();
    expect(cutoffIndex(s([5e6, 5e6, 0, 0]))).toBe(2);
    const runOf = (bps: number): Iperf3Run => ({
      direction: 'down',
      argv: [],
      exit_code: 0,
      error: null,
      samples: s([bps]),
      receiver_bits_per_second: bps,
      sender_bits_per_second: bps,
    });
    expect(throughputFinding(runOf(2_200_000), 2000, 10).proposed).toBe('PROPOSED_PASS');
    expect(throughputFinding(runOf(2_200_001), 2000, 10).proposed).toBe('PROPOSED_FAIL');
    expect(throughputFinding(runOf(1_799_999), 2000, 10).proposed).toBe('INCONCLUSIVE');
  });
});
