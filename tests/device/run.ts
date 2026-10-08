/**
 * Device measurement harness CLI (Phase 7 P7-B AC1) — DT-04 / DT-05 / DT-06 of
 * PHASE2_VALIDATION.md §5.2 with iperf3. NOT run in CI against devices: the vitest suite only
 * exercises the dry run (fake iperf3).
 *
 *   # dry run (default): fake iperf3, output marked "NOT EVIDENCE"
 *   npx tsx tests/device/run.ts --profile tests/device/profiles/lab.example.json --dt DT-04 --case u2
 *
 *   # live, in the lab only, on a client logged in through the portal as the case's test user:
 *   ECLOUD_DEVICE_HARNESS_LIVE=1 npx tsx tests/device/run.ts --live --profile <lab.json> \
 *     --dt DT-05 --case session-timeout-120 --login-offset-s 7
 *
 * One invocation = one case (the operator logs in as the case's user between cases). Output:
 * `<out>/<DT>_<case>_<UTC stamp>[_dry-run].json` (samples, findings, proposed verdict) and a
 * `.row.md` with the PHASE2_VALIDATION.md §5.4 results-row draft. The verdict is always
 * PENDING_HUMAN_SIGNOFF: there is no option to mark PASS, and options that try are refused.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import type { CommandRunner } from './harness/iperf3.js';
import { findCase, measure, resultsRowDraft, validateProfile } from './harness/measure.js';
import {
  DT_IDS,
  type DtId,
  type MeasurementResult,
  type QuotaCase,
  type ThroughputCase,
  type TimerCase,
} from './harness/types.js';

export const ROOT = resolve(import.meta.dirname, '..', '..');
export const FAKE_IPERF3 = join(import.meta.dirname, 'fake-iperf3.mjs');
export const LIVE_ENV = 'ECLOUD_DEVICE_HARNESS_LIVE';

/** Options that would let a script decide the verdict: refused outright. */
const VERDICT_FLAGS =
  /^--?(pass|fail|verdict|sign-?off|signed-by|mark-pass|final-result|result)(=|$)/i;

export class UsageError extends Error {}

/** Fake behaviour that honours the expectation exactly (a dry run proposes PASS). */
export function defaultFakeScenario(
  dt: DtId,
  c: ThroughputCase | TimerCase | QuotaCase,
  loginOffsetS: number,
): Record<string, unknown> {
  if (dt === 'DT-04') {
    const t = c as ThroughputCase;
    return { down_kbps: t.expected_down_kbps ?? 50_000, up_kbps: t.expected_up_kbps ?? 50_000 };
  }
  if (dt === 'DT-05') {
    const t = c as TimerCase;
    return t.kind === 'session_timeout'
      ? { down_kbps: 5_000, cutoff_after_s: t.expected_s - loginOffsetS, cut_error: true }
      : { down_kbps: 5_000, unreachable: !t.expect_reachable };
  }
  const t = c as QuotaCase;
  return { down_kbps: 20_000, up_kbps: 20_000, cutoff_after_bytes: t.quota_bytes };
}

export interface MainDeps {
  readonly env?: NodeJS.ProcessEnv;
  readonly runner?: CommandRunner;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => Date;
  readonly write?: (s: string) => void;
}

export async function main(
  argv: readonly string[],
  deps: MainDeps = {},
): Promise<MeasurementResult> {
  const env = deps.env ?? process.env;
  const write = deps.write ?? ((s: string) => void process.stdout.write(s));
  const refused = argv.find((a) => VERDICT_FLAGS.test(a));
  if (refused !== undefined) {
    throw new UsageError(
      `${refused}: refused — the harness never sets a verdict. It writes measured values and a proposed verdict; a human records PASS/FAIL in PHASE2_VALIDATION.md §5.4.`,
    );
  }
  const { values } = parseArgs({
    args: [...argv],
    strict: true,
    options: {
      profile: { type: 'string' },
      dt: { type: 'string' },
      case: { type: 'string' },
      out: { type: 'string' },
      'login-offset-s': { type: 'string' },
      live: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      iperf3: { type: 'string' },
      'fake-scenario': { type: 'string' },
    },
  });
  if (!values.profile || !values.dt || !values.case) {
    throw new UsageError(
      'usage: run.ts --profile <file> --dt DT-04|DT-05|DT-06 --case <id> [--live] [--out <dir>]',
    );
  }
  if (!(DT_IDS as readonly string[]).includes(values.dt))
    throw new UsageError(`--dt must be one of ${DT_IDS.join(', ')}`);
  const dt = values.dt as DtId;
  if (values.live && values['dry-run']) throw new UsageError('--live and --dry-run are exclusive');
  const live = values.live === true;
  if (live && env[LIVE_ENV] !== '1') {
    throw new UsageError(
      `--live also needs ${LIVE_ENV}=1 in the environment (lab use only; never against production)`,
    );
  }
  if (live && values['fake-scenario'] !== undefined)
    throw new UsageError('--fake-scenario is dry-run only');
  if (!live && values.iperf3 !== undefined)
    throw new UsageError('--iperf3 is live only (dry run always uses the fake)');

  const profile = validateProfile(
    JSON.parse(readFileSync(resolve(values.profile), 'utf8')) as unknown,
  );
  const c = findCase(profile, dt, values.case);
  const loginOffsetS =
    values['login-offset-s'] === undefined ? undefined : Number(values['login-offset-s']);
  if (loginOffsetS !== undefined && !(Number.isFinite(loginOffsetS) && loginOffsetS >= 0)) {
    throw new UsageError('--login-offset-s must be a non-negative number of seconds');
  }
  if (dt === 'DT-05' && (c as TimerCase).kind === 'session_timeout') {
    const t = c as TimerCase & { max_duration_s: number };
    if (loginOffsetS === undefined)
      throw new UsageError('DT-05 session_timeout needs --login-offset-s');
    if (t.max_duration_s - loginOffsetS < 5)
      throw new UsageError('--login-offset-s leaves no time to measure');
  }

  const scenario =
    values['fake-scenario'] !== undefined
      ? (JSON.parse(values['fake-scenario']) as unknown)
      : defaultFakeScenario(dt, c, loginOffsetS ?? 0);
  const command = live
    ? [values.iperf3 ?? 'iperf3']
    : [process.execPath, FAKE_IPERF3, '--scenario', JSON.stringify(scenario)];

  const partial = await measure({
    dt,
    caseId: values.case,
    profile,
    mode: live ? 'live' : 'dry-run',
    command,
    ...(loginOffsetS !== undefined ? { loginOffsetS } : {}),
    ...(deps.runner ? { runner: deps.runner } : {}),
    // A dry run never waits for real idle timers.
    sleep: live ? deps.sleep : () => Promise.resolve(),
    ...(deps.now ? { now: deps.now } : {}),
  });

  const outDir = resolve(values.out ?? join(ROOT, 'var', 'device-results'));
  mkdirSync(outDir, { recursive: true });
  const stamp = partial.started_at.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const safeCase = values.case.replace(/[^A-Za-z0-9._-]/g, '_');
  const base = `${dt}_${safeCase}_${stamp}${live ? '' : '_dry-run'}`;
  const result: MeasurementResult = {
    ...partial,
    results_row_draft: resultsRowDraft(partial, `${base}.json`),
  };
  writeFileSync(join(outDir, `${base}.json`), `${JSON.stringify(result, null, 2)}\n`);
  writeFileSync(
    join(outDir, `${base}.row.md`),
    `<!-- Draft for PHASE2_VALIDATION.md §5.4. Review, fill the manual observations, set the Result yourself. -->\n${result.results_row_draft}\n`,
  );
  write(
    [
      `${dt} case ${values.case} (${result.mode}${live ? '' : ' — NOT EVIDENCE'})`,
      ...result.findings.map(
        (f) => `  ${f.check}: ${f.measured} | expected ${f.expected} → ${f.proposed}`,
      ),
      `  proposed verdict: ${result.proposed_verdict}; verdict: ${result.verdict}`,
      `  wrote ${join(outDir, `${base}.json`)}`,
      '',
    ].join('\n'),
  );
  return result;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = e instanceof UsageError ? 2 : 1;
  });
}
