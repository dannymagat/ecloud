/**
 * Writes tests/simulators/SIMULATOR_RESULTS.json from a real Vitest run of the simulator suite
 * (MULTI_VENDOR_INTEGRATION_PLAN.md §8.3 AC2/AC4). Run from the repository root, with the dev
 * stack env exported so the DB-backed group runs too:
 *
 *   ECLOUD_TEST_DATABASE_URL=... npx tsx tests/simulators/record-results.ts
 *
 * Mapping: every test title starts with `SIM-NN`; `[adapter-key]` tags name the adapters it
 * covers (none = every adapter of the scenario); `[DEFECT]` marks an `it.fails` pin of a code
 * defect the scenario exposed; `it.todo` marks a BLOCKED check. The file is evidence for the
 * orchestrator's later registry promotion only — this script never edits the registry.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  SIMULATOR_RESULTS_FORMAT,
  SIMULATOR_SCENARIOS,
  SIMULATOR_SCOPE_STATEMENT,
  SIM_ADAPTERS,
  checkSimulatorResults,
  deriveClaims,
  scenarioOutcomesHash,
  type ScenarioRecord,
  type ScenarioResult,
  type SimAdapterKey,
  type SimulatorResultsFile,
} from '@ecloud/testing';

interface AssertionResult {
  readonly fullName: string;
  readonly title: string;
  readonly status: string;
  readonly failureMessages?: readonly string[];
}
interface JsonReport {
  readonly numPassedTests: number;
  readonly numFailedTests: number;
  readonly numPendingTests: number;
  readonly numTodoTests: number;
  readonly testResults: readonly { readonly assertionResults: readonly AssertionResult[] }[];
}

const ROOT = resolve(import.meta.dirname, '..', '..');
const OUT = join(ROOT, 'tests', 'simulators', 'SIMULATOR_RESULTS.json');
const COMMAND =
  'vitest run --project tests tests/simulators --exclude **/results.test.ts --reporter=json';

const RANK: Readonly<Record<ScenarioResult, number>> = {
  PASS: 0,
  NOT_RUN: 1,
  BLOCKED: 2,
  DEFECT: 3,
  FAIL: 4,
};

function outcome(a: AssertionResult): ScenarioResult {
  if (a.status === 'todo') return 'BLOCKED';
  if (a.status === 'skipped' || a.status === 'pending') return 'NOT_RUN';
  if (a.status !== 'passed') return 'FAIL';
  return a.title.includes('[DEFECT]') ? 'DEFECT' : 'PASS';
}

function main(): void {
  const dir = mkdtempSync(join(tmpdir(), 'ecloud-sim-'));
  const reportPath = join(dir, 'report.json');
  try {
    const run = spawnSync(
      'npx',
      [
        'vitest',
        'run',
        '--project',
        'tests',
        'tests/simulators',
        // The file check reads the previous results file; it is not a scenario.
        '--exclude',
        '**/results.test.ts',
        '--reporter=json',
        `--outputFile=${reportPath}`,
      ],
      { cwd: ROOT, env: process.env, stdio: ['ignore', 'ignore', 'inherit'] },
    );
    if (run.error) throw run.error;
    const report = JSON.parse(readFileSync(reportPath, 'utf8')) as JsonReport;
    const all = report.testResults.flatMap((f) => f.assertionResults);

    const scenarios: ScenarioRecord[] = SIMULATOR_SCENARIOS.map((spec) => {
      const tests = all.filter((a) => a.title.startsWith(`${spec.id} `));
      const results: Partial<Record<SimAdapterKey, ScenarioResult>> = {};
      const findings: string[] = [];
      for (const adapter of spec.adapters) {
        const mine = tests.filter((a) => {
          const tagged = SIM_ADAPTERS.filter((k) => a.title.includes(`[${k}]`));
          return tagged.length === 0 || tagged.includes(adapter);
        });
        let worst: ScenarioResult = mine.length === 0 ? 'NOT_RUN' : 'PASS';
        for (const a of mine) {
          const o = outcome(a);
          if (RANK[o] > RANK[worst]) worst = o;
        }
        results[adapter] = worst;
      }
      for (const a of tests) {
        const o = outcome(a);
        if (o !== 'PASS' && o !== 'NOT_RUN') findings.push(`${o}: ${a.title}`);
      }
      return {
        id: spec.id,
        title: spec.title,
        group: spec.group,
        results,
        tests: tests.length,
        findings: [...new Set(findings)].sort(),
      };
    });

    const { claims, withheld } = deriveClaims(scenarios);
    const runId = randomBytes(16).toString('hex');
    const file: SimulatorResultsFile = {
      format: SIMULATOR_RESULTS_FORMAT,
      scope: SIMULATOR_SCOPE_STATEMENT,
      generatedAt: new Date().toISOString(),
      run: {
        runId,
        outcomesHash: scenarioOutcomesHash(runId, scenarios),
        command: COMMAND,
        integration: (process.env.ECLOUD_TEST_DATABASE_URL ?? '').trim() !== '',
        passed: report.numPassedTests,
        failed: report.numFailedTests,
        skipped: report.numPendingTests,
        todo: report.numTodoTests,
      },
      scenarios,
      claims,
      withheld,
    };
    const problems = checkSimulatorResults(file);
    if (problems.length > 0) throw new Error(`results file invalid:\n${problems.join('\n')}`);
    writeFileSync(OUT, `${JSON.stringify(file, null, 2)}\n`);
    // Repository style (format:check covers this file).
    spawnSync('npx', ['prettier', '--write', OUT], { cwd: ROOT, stdio: 'ignore' });
    process.stdout.write(
      `${OUT}\n${scenarios.map((s) => `${s.id} ${JSON.stringify(s.results)}`).join('\n')}\nclaims: ${String(claims.length)}, withheld: ${String(withheld.length)}\n`,
    );
    if (report.numFailedTests > 0) process.exitCode = 1;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

main();
