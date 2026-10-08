/**
 * Runs one DT case (DT-04 / DT-05 / DT-06) and assembles the measurement result + the
 * PHASE2_VALIDATION.md §5.4 results-row draft. The verdict is always PENDING_HUMAN_SIGNOFF.
 */
import {
  combine,
  idleProbeFinding,
  quotaFinding,
  sessionTimeoutFinding,
  throughputFinding,
} from './analyze.js';
import { runIperf3, type CommandRunner } from './iperf3.js';
import {
  DT_IDS,
  HARNESS_VERSION,
  PROFILE_FORMAT,
  RESULT_FORMAT,
  type DeviceProfile,
  type DtId,
  type Finding,
  type Iperf3Run,
  type MeasurementResult,
  type QuotaCase,
  type ThroughputCase,
  type TimerCase,
} from './types.js';

/** Ledger rows and decisions each DT resolves / unblocks (PHASE2_VALIDATION.md §5.2). */
export const DT_LEDGER: Record<DtId, { ledger: string; decision: string }> = {
  'DT-04': {
    ledger: 'V-052, V-053, V-063',
    decision: 'D-003 per-client enforcement, PE Q8, D-012',
  },
  'DT-05': {
    ledger: 'V-050, V-051, V-005, V-007',
    decision: 'adapter rule "never set acct-interval", PE D3, AAA T-A15',
  },
  'DT-06': {
    ledger: 'V-054',
    decision: 'PE D3 drain-time sizing, quota adapter width (32 vs 64 bit)',
  },
};

const MANUAL: Record<DtId, readonly string[]> = {
  'DT-04': ['tc_class_rate_for_client_mac', 'family_precedence_observed', 'pcap_file'],
  'DT-05': [
    'acct_terminate_cause',
    'acct_interim_spacing_s',
    'uspot_acct_interval_uci',
    'pcap_file',
  ],
  'DT-06': [
    'acct_terminate_cause',
    'stop_acct_input_octets',
    'stop_acct_output_octets',
    'pcap_file',
  ],
};

export const SIGNOFF_INSTRUCTIONS =
  'The harness never marks PASS. A human reviews the samples, the pcap and the manual observations, then records PASS / FAIL / PARTIAL in PHASE2_VALIDATION.md §5.4 (and only then may a registry cell be promoted, rule V12).';

export interface MeasureOptions {
  readonly dt: DtId;
  readonly caseId: string;
  readonly profile: DeviceProfile;
  readonly mode: 'dry-run' | 'live';
  /** iperf3 command prefix (real binary, or `node fake-iperf3.mjs` in dry-run). */
  readonly command: readonly string[];
  /** DT-05 Session-Timeout: seconds already elapsed since the portal login. */
  readonly loginOffsetS?: number;
  readonly runner?: CommandRunner;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => Date;
}

function fail(message: string): never {
  throw new Error(message);
}

/** Structural check of a profile (no secrets: there is no field for one). */
export function validateProfile(value: unknown): DeviceProfile {
  const p = value as Partial<DeviceProfile> | null;
  if (p === null || typeof p !== 'object') fail('profile: not an object');
  if (p.format !== PROFILE_FORMAT) fail(`profile: format must be "${PROFILE_FORMAT}"`);
  const lab = p.lab;
  if (!lab || typeof lab !== 'object') fail('profile: lab missing');
  for (const k of [
    'tester',
    'ezeap_model',
    'firmware',
    'schema_version',
    'uspot_variant',
  ] as const) {
    if (typeof lab[k] !== 'string' || lab[k].trim() === '') fail(`profile: lab.${k} missing`);
  }
  if (!['uam', 'dot1x', 'mac', 'chilli'].includes(lab.nas_path))
    fail('profile: lab.nas_path invalid');
  const i = p.iperf3;
  if (!i || typeof i.server !== 'string' || i.server === '') fail('profile: iperf3.server missing');
  if (!Number.isInteger(i.port) || i.port < 1 || i.port > 65535)
    fail('profile: iperf3.port invalid');
  if (!(i.duration_s >= 5 && i.duration_s <= 600)) fail('profile: iperf3.duration_s out of 5..600');
  if (!(i.omit_s >= 0 && i.omit_s < i.duration_s)) fail('profile: iperf3.omit_s invalid');
  if (!p.cases || typeof p.cases !== 'object') fail('profile: cases missing');
  const ids = new Set<string>();
  for (const dt of DT_IDS) {
    for (const c of p.cases[dt] ?? []) {
      if (typeof c.id !== 'string' || c.id === '') fail(`profile: ${dt} case without id`);
      if (ids.has(`${dt}/${c.id}`)) fail(`profile: duplicate case ${dt}/${c.id}`);
      ids.add(`${dt}/${c.id}`);
    }
  }
  for (const c of p.cases['DT-04'] ?? []) {
    if (c.expected_down_kbps === null && c.expected_up_kbps === null)
      fail(`profile: DT-04/${c.id} has no expected rate`);
    if (!(c.tolerance_pct > 0 && c.tolerance_pct <= 50)) fail(`profile: DT-04/${c.id} tolerance`);
  }
  for (const c of p.cases['DT-05'] ?? []) {
    if (c.kind === 'session_timeout') {
      if (!(c.max_duration_s > c.expected_s + c.tolerance_s))
        fail(`profile: DT-05/${c.id} max_duration_s must exceed expected_s + tolerance_s`);
    } else if (c.kind === 'idle_probe') {
      if (c.expect_reachable !== c.idle_wait_s < c.idle_timeout_s)
        fail(`profile: DT-05/${c.id} expect_reachable contradicts idle_wait_s vs idle_timeout_s`);
    } else fail(`profile: DT-05 case kind invalid`);
  }
  for (const c of p.cases['DT-06'] ?? []) {
    if (!(c.quota_bytes > 0)) fail(`profile: DT-06/${c.id} quota_bytes`);
    if (!(c.poll_interval_s > 0)) fail(`profile: DT-06/${c.id} poll_interval_s`);
  }
  return p as DeviceProfile;
}

export function findCase(
  profile: DeviceProfile,
  dt: DtId,
  id: string,
): ThroughputCase | TimerCase | QuotaCase {
  const list = (profile.cases[dt] ?? []) as readonly (ThroughputCase | TimerCase | QuotaCase)[];
  return list.find((c) => c.id === id) ?? fail(`no ${dt} case "${id}" in the profile`);
}

function md(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

export function resultsRowDraft(
  r: Omit<MeasurementResult, 'results_row_draft'>,
  file: string,
): string {
  const ledger = DT_LEDGER[r.dt];
  const proposed = r.proposed_verdict.replace('PROPOSED_', '');
  const prefix = r.mode === 'dry-run' ? 'DRY RUN (fake iperf3) — NOT EVIDENCE · ' : '';
  const observations = r.findings
    .map((f) => `${f.check}: ${f.measured} (expected ${f.expected}) → ${f.proposed}`)
    .join('; ');
  const cells = [
    r.dt,
    r.started_at.slice(0, 10),
    r.lab.tester,
    `${r.lab.ezeap_model} / ${r.lab.firmware} / ${r.lab.schema_version}`,
    r.lab.uspot_variant,
    r.lab.nas_path,
    `${prefix}**PENDING HUMAN SIGN-OFF** (harness proposes: ${proposed})`,
    `case ${r.case_id}: ${observations}`,
    `${file} (+ pcap: to attach)`,
    `${ledger.ledger} → (set by the signing human)`,
    ledger.decision,
  ];
  return `| ${cells.map(md).join(' | ')} |`;
}

export async function measure(
  o: MeasureOptions,
): Promise<Omit<MeasurementResult, 'results_row_draft'>> {
  const now = o.now ?? (() => new Date());
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const started = now();
  const c = findCase(o.profile, o.dt, o.caseId);
  const ip = o.profile.iperf3;
  const runs: Iperf3Run[] = [];
  const findings: Finding[] = [];
  const iperf = async (direction: 'down' | 'up', duration_s: number, omit_s: number) => {
    const run = await runIperf3(
      o.command,
      { server: ip.server, port: ip.port, direction, duration_s, omit_s },
      o.runner,
    );
    runs.push(run);
    return run;
  };

  if (o.dt === 'DT-04') {
    const t = c as ThroughputCase;
    if (t.expected_up_kbps !== null) {
      findings.push(
        throughputFinding(
          await iperf('up', ip.duration_s, ip.omit_s),
          t.expected_up_kbps,
          t.tolerance_pct,
        ),
      );
    }
    if (t.expected_down_kbps !== null) {
      findings.push(
        throughputFinding(
          await iperf('down', ip.duration_s, ip.omit_s),
          t.expected_down_kbps,
          t.tolerance_pct,
        ),
      );
    }
  } else if (o.dt === 'DT-05') {
    const t = c as TimerCase;
    if (t.kind === 'session_timeout') {
      if (o.loginOffsetS === undefined)
        fail('DT-05 session_timeout needs --login-offset-s (seconds since the portal login)');
      findings.push(
        sessionTimeoutFinding(
          t,
          await iperf('down', t.max_duration_s - o.loginOffsetS, 0),
          o.loginOffsetS,
        ),
      );
    } else {
      await sleep(t.idle_wait_s * 1000);
      findings.push(idleProbeFinding(t, await iperf('down', t.probe_s, 0)));
    }
  } else {
    const t = c as QuotaCase;
    findings.push(quotaFinding(t, await iperf(t.direction, t.duration_s, 0)));
  }

  return {
    format: RESULT_FORMAT,
    harness_version: HARNESS_VERSION,
    dt: o.dt,
    case_id: o.caseId,
    mode: o.mode,
    evidence_usable: o.mode === 'live',
    started_at: started.toISOString(),
    finished_at: now().toISOString(),
    lab: o.profile.lab,
    expectation: c,
    tool: { command: o.command },
    runs,
    findings,
    proposed_verdict: combine(findings.map((f) => f.proposed)),
    verdict: 'PENDING_HUMAN_SIGNOFF',
    signoff: {
      required: true,
      signed_by: null,
      signed_at: null,
      final_result: null,
      instructions: SIGNOFF_INSTRUCTIONS,
    },
    manual_observations: Object.fromEntries(MANUAL[o.dt].map((k) => [k, null])),
  };
}
