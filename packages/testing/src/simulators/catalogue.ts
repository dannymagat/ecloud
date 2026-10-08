/**
 * L4 simulator catalogue and the SIMULATOR_RESULTS record format
 * (MULTI_VENDOR_INTEGRATION_PLAN.md §8.3, §4.1, §4.5 V2).
 *
 * Simulator evidence proves ECLOUD code behaviour against a simulated NAS. It is never hardware
 * compatibility evidence: it may only ever back `SIMULATOR_TESTED` on the three operation
 * capabilities (`redirectParse`, `authorizationHandoff`, `accountingNormalize`) of the two
 * first-party UAM adapters, never an enforcement capability, never `LAB_VALIDATED`, and never
 * Disconnect/CoA (D-006).
 */
import { createHash } from 'node:crypto';
import { OPERATION_CAPABILITIES, type OperationCapability } from '@ecloud/shared';

export const SIMULATOR_RESULTS_FORMAT = 'ecloud-simulator-results/v1';

export const SIMULATOR_SCOPE_STATEMENT =
  'Simulator evidence: ECLOUD code behaviour against a simulated NAS (fixtures derived from documented parameter lists). It is NOT hardware compatibility evidence, never LAB_VALIDATED, and never applies to an enforcement capability or to Disconnect/CoA (D-006).';

/** The two first-party UAM adapters the simulator covers (plan §8.3 AC2). */
export const SIM_ADAPTERS = ['openwifi-uspot-uam', 'coovachilli-uam'] as const;
export type SimAdapterKey = (typeof SIM_ADAPTERS)[number];

export type ScenarioId =
  | 'SIM-01'
  | 'SIM-02'
  | 'SIM-03'
  | 'SIM-04'
  | 'SIM-05'
  | 'SIM-06'
  | 'SIM-07'
  | 'SIM-08'
  | 'SIM-09'
  | 'SIM-10'
  | 'SIM-11'
  | 'SIM-12'
  | 'SIM-13'
  | 'SIM-14'
  | 'SIM-15'
  | 'SIM-16'
  | 'SIM-17'
  | 'SIM-18';

export interface ScenarioSpec {
  readonly id: ScenarioId;
  readonly title: string;
  /** `pure` runs in `npm test`; `db` needs the dev stack (describeIntegration). */
  readonly group: 'pure' | 'db';
  readonly adapters: readonly SimAdapterKey[];
}

const BOTH = SIM_ADAPTERS;

export const SIMULATOR_SCENARIOS: readonly ScenarioSpec[] = [
  {
    id: 'SIM-01',
    title: 'valid UAM redirect res=notyet with correct md',
    group: 'pure',
    adapters: BOTH,
  },
  { id: 'SIM-02', title: 'forged redirect: md wrong / missing', group: 'pure', adapters: BOTH },
  {
    id: 'SIM-03',
    title: 'tampered parameter after signing (mac, nasid, uamip)',
    group: 'pure',
    adapters: BOTH,
  },
  { id: 'SIM-04', title: 'unknown nasid / unregistered NAS', group: 'pure', adapters: BOTH },
  { id: 'SIM-05', title: 'cross-tenant NAS / credential', group: 'db', adapters: BOTH },
  {
    id: 'SIM-06',
    title: 'replay after consumption; credential reused after TTL',
    group: 'db',
    adapters: BOTH,
  },
  {
    id: 'SIM-07',
    title: 'public uamip; userurl open-redirect payloads',
    group: 'pure',
    adapters: BOTH,
  },
  {
    id: 'SIM-08',
    title: 'opaque value preservation (byte-for-byte raw query)',
    group: 'pure',
    adapters: BOTH,
  },
  {
    id: 'SIM-09',
    title: 'hand-off: PAP XOR encoding and CHAP reference vectors',
    group: 'pure',
    adapters: BOTH,
  },
  {
    id: 'SIM-10',
    title: 'accounting retransmit (identical Interim twice)',
    group: 'pure',
    adapters: BOTH,
  },
  { id: 'SIM-11', title: 'out-of-order Interim', group: 'pure', adapters: BOTH },
  {
    id: 'SIM-12',
    title: 'missing Stop: reaper closes, no double count',
    group: 'db',
    adapters: BOTH,
  },
  {
    id: 'SIM-13',
    title: 'Gigawords rollover (64-bit total)',
    group: 'pure',
    adapters: ['coovachilli-uam'],
  },
  {
    id: 'SIM-14',
    title: '32-bit wrap without Gigawords (uspot TIP)',
    group: 'pure',
    adapters: ['openwifi-uspot-uam'],
  },
  {
    id: 'SIM-15',
    title: 'unsupported policy: VLAN, burst, quota > 4 GiB on TIP',
    group: 'pure',
    adapters: BOTH,
  },
  {
    id: 'SIM-16',
    title: 'Disconnect without mandatory identification attribute',
    group: 'pure',
    adapters: BOTH,
  },
  {
    id: 'SIM-17',
    title: 'NAS reboot: Accounting-On / Accounting-Off',
    group: 'db',
    adapters: BOTH,
  },
  {
    id: 'SIM-18',
    title: 'multi-NAS roaming; no double count; no cross-tenant merge',
    group: 'db',
    adapters: BOTH,
  },
];

/**
 * Scenarios that must all be `PASS` (for that adapter) before the operation capability may be
 * claimed `SIMULATOR_TESTED`. A scenario that does not list the adapter is ignored for it.
 * SIM-16 (Disconnect) backs no claim: Disconnect is an enforcement capability (D-006).
 */
export const CLAIM_REQUIREMENTS: Readonly<Record<OperationCapability, readonly ScenarioId[]>> = {
  redirectParse: ['SIM-01', 'SIM-02', 'SIM-03', 'SIM-04', 'SIM-05', 'SIM-06', 'SIM-07', 'SIM-08'],
  authorizationHandoff: ['SIM-05', 'SIM-06', 'SIM-07', 'SIM-08', 'SIM-09', 'SIM-15'],
  accountingNormalize: ['SIM-10', 'SIM-11', 'SIM-12', 'SIM-13', 'SIM-14', 'SIM-17', 'SIM-18'],
};

/**
 * PASS = every test of the scenario for this adapter passed. DEFECT = a test pinned with
 * `it.fails` and tagged `[DEFECT]` documents a code defect the scenario exposed. BLOCKED = a
 * required check cannot be written without a code change outside the simulator (`it.todo`).
 * FAIL = a test failed. NOT_RUN = skipped (e.g. no database).
 */
export type ScenarioResult = 'PASS' | 'FAIL' | 'DEFECT' | 'BLOCKED' | 'NOT_RUN';

export interface ScenarioRecord {
  readonly id: ScenarioId;
  readonly title: string;
  readonly group: 'pure' | 'db';
  readonly results: Readonly<Partial<Record<SimAdapterKey, ScenarioResult>>>;
  readonly tests: number;
  /** Titles of `[DEFECT]` / todo / failed tests (empty when PASS). */
  readonly findings: readonly string[];
}

export interface SimulatorClaim {
  readonly adapterKey: SimAdapterKey;
  readonly capability: OperationCapability;
  readonly evidenceLevel: 'SIMULATOR_TESTED';
  /**
   * Status the orchestrator should use when it adds the cell: rule V1 forbids
   * VERIFIED_SUPPORTED with SIMULATOR_TESTED, and the operation is ECLOUD's own code path.
   */
  readonly proposedStatus: 'ECLOUD_SIDE_ONLY';
  readonly scenarios: readonly ScenarioId[];
  readonly evidenceRefs: readonly { readonly kind: 'simulator'; readonly ref: string }[];
}

export interface WithheldClaim {
  readonly adapterKey: SimAdapterKey;
  readonly capability: OperationCapability;
  readonly blockingScenarios: readonly {
    readonly id: ScenarioId;
    readonly result: ScenarioResult;
  }[];
}

export interface SimulatorResultsFile {
  readonly format: typeof SIMULATOR_RESULTS_FORMAT;
  readonly scope: string;
  readonly generatedAt: string;
  readonly run: {
    /** Random id of the recording run; part of `outcomesHash`. */
    readonly runId: string;
    /** `scenarioOutcomesHash(runId, scenarios)`: binds the scenario results to that run. */
    readonly outcomesHash: string;
    readonly command: string;
    readonly integration: boolean;
    readonly passed: number;
    readonly failed: number;
    readonly skipped: number;
    readonly todo: number;
  };
  readonly scenarios: readonly ScenarioRecord[];
  readonly claims: readonly SimulatorClaim[];
  readonly withheld: readonly WithheldClaim[];
}

/**
 * SHA-256 over the run id and the canonical scenario outcomes (id, per-adapter results in
 * catalogue adapter order, test count, findings). Any edit of a result after recording, or a
 * results block copied from another run, changes the hash.
 */
export function scenarioOutcomesHash(runId: string, scenarios: readonly ScenarioRecord[]): string {
  const canonical = scenarios.map((s) => [
    s.id,
    SIM_ADAPTERS.map((a) => [a, s.results[a] ?? null]),
    s.tests,
    [...s.findings],
  ]);
  return createHash('sha256')
    .update(JSON.stringify([runId, canonical]))
    .digest('hex');
}

/** Claims backed by the scenario results (all required scenarios PASS for the adapter). */
export function deriveClaims(scenarios: readonly ScenarioRecord[]): {
  claims: SimulatorClaim[];
  withheld: WithheldClaim[];
} {
  const claims: SimulatorClaim[] = [];
  const withheld: WithheldClaim[] = [];
  for (const adapterKey of SIM_ADAPTERS) {
    for (const capability of OPERATION_CAPABILITIES) {
      const required = CLAIM_REQUIREMENTS[capability].filter((id) =>
        SIMULATOR_SCENARIOS.find((s) => s.id === id)?.adapters.includes(adapterKey),
      );
      const blocking = required
        .map((id) => ({
          id,
          result: scenarios.find((s) => s.id === id)?.results[adapterKey] ?? 'NOT_RUN',
        }))
        .filter((r) => r.result !== 'PASS');
      if (blocking.length > 0) {
        withheld.push({ adapterKey, capability, blockingScenarios: blocking });
        continue;
      }
      claims.push({
        adapterKey,
        capability,
        evidenceLevel: 'SIMULATOR_TESTED',
        proposedStatus: 'ECLOUD_SIDE_ONLY',
        scenarios: required,
        evidenceRefs: required.map((id) => ({
          kind: 'simulator' as const,
          ref: `${id} (tests/simulators/SIMULATOR_RESULTS.json)`,
        })),
      });
    }
  }
  return { claims, withheld };
}

/**
 * Structural check of a results file: returns human-readable problems (empty = valid). Enforces
 * plan §8.3 AC2: claims only on operation capabilities of the two UAM adapters, only
 * `SIMULATOR_TESTED`, and only when every required scenario passed in the same file.
 */
export function checkSimulatorResults(file: SimulatorResultsFile): string[] {
  const problems: string[] = [];
  if (file.format !== SIMULATOR_RESULTS_FORMAT) problems.push(`format is ${String(file.format)}`);
  if (file.scope !== SIMULATOR_SCOPE_STATEMENT) problems.push('scope statement missing or altered');
  if (typeof file.run.runId !== 'string' || !/^[0-9a-f]{32}$/.test(file.run.runId))
    problems.push('run id missing or malformed');
  else if (file.run.outcomesHash !== scenarioOutcomesHash(file.run.runId, file.scenarios))
    problems.push('outcomes hash does not match the scenario results of this run');
  const ids = file.scenarios.map((s) => s.id);
  for (const spec of SIMULATOR_SCENARIOS) {
    const rec = file.scenarios.find((s) => s.id === spec.id);
    if (!rec) {
      problems.push(`${spec.id} missing`);
      continue;
    }
    for (const a of spec.adapters)
      if (rec.results[a] === undefined) problems.push(`${spec.id} has no result for ${a}`);
    for (const a of Object.keys(rec.results))
      if (!spec.adapters.includes(a as SimAdapterKey))
        problems.push(`${spec.id} reports adapter ${a} outside its scope`);
  }
  if (new Set(ids).size !== ids.length) problems.push('duplicate scenario ids');
  const ops = new Set<string>(OPERATION_CAPABILITIES);
  const seen = new Set<string>();
  for (const c of file.claims) {
    const subject = `${c.adapterKey}/${c.capability}`;
    if (seen.has(subject)) problems.push(`duplicate claim ${subject}`);
    seen.add(subject);
    if (!ops.has(c.capability)) problems.push(`claim on non-operation capability ${subject}`);
    if (!(SIM_ADAPTERS as readonly string[]).includes(c.adapterKey))
      problems.push(`claim on adapter outside the simulator scope ${subject}`);
    if (c.evidenceLevel !== 'SIMULATOR_TESTED')
      problems.push(`claim ${subject} has evidence ${String(c.evidenceLevel)}`);
    if (c.proposedStatus !== 'ECLOUD_SIDE_ONLY')
      problems.push(`claim ${subject} proposes status ${String(c.proposedStatus)}`);
    if (c.evidenceRefs.some((r) => r.kind !== 'simulator'))
      problems.push(`claim ${subject} cites non-simulator evidence`);
    const expected = deriveClaims(file.scenarios).claims.find(
      (d) => d.adapterKey === c.adapterKey && d.capability === c.capability,
    );
    if (!expected)
      problems.push(`claim ${subject} is not backed by PASS results for its scenarios`);
    else if (expected.scenarios.join() !== c.scenarios.join())
      problems.push(
        `claim ${subject} lists scenarios ${c.scenarios.join()} (expected ${expected.scenarios.join()})`,
      );
  }
  for (const d of deriveClaims(file.scenarios).claims) {
    if (!seen.has(`${d.adapterKey}/${d.capability}`))
      problems.push(`backed claim ${d.adapterKey}/${d.capability} missing from claims`);
  }
  return problems;
}
