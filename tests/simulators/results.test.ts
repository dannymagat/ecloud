/**
 * Registry check for the L4 simulator evidence (MULTI_VENDOR_INTEGRATION_PLAN.md §8.3 AC2,
 * §4.1, §4.5 V2): SIMULATOR_RESULTS.json may claim `SIMULATOR_TESTED` only on the three
 * operation capabilities of the two first-party UAM adapters, only when every scenario backing
 * the claim PASSed in that same recorded run, never LAB_VALIDATED, never Disconnect/CoA (D-006).
 * The registry promotion itself is the orchestrator's later step; this suite proves the promotion
 * the file proposes would pass the L2 validator, and that a bad one would not.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  COMPATIBILITY_ROWS,
  DT_RESULTS,
  VENDORS,
  listCapabilities,
  validateRegistry,
  violatedRules,
  type CompatibilityRow,
  type RegistryCell,
} from '@ecloud/adapters';
import { OPERATION_CAPABILITIES } from '@ecloud/shared';
import {
  SIMULATOR_SCENARIOS,
  SIMULATOR_SCOPE_STATEMENT,
  SIM_ADAPTERS,
  checkSimulatorResults,
  type SimulatorClaim,
  type SimulatorResultsFile,
} from '@ecloud/testing';

const DIR = import.meta.dirname;
const FILE = JSON.parse(
  readFileSync(join(DIR, 'SIMULATOR_RESULTS.json'), 'utf8'),
) as SimulatorResultsFile;

type MutableRow = CompatibilityRow & {
  capabilities: Record<keyof CompatibilityRow['capabilities'], RegistryCell[]>;
};

/** Applies claims to every implemented row of the claimed adapter (what the orchestrator would do). */
function promote(
  claims: readonly Pick<SimulatorClaim, 'adapterKey' | 'capability'>[],
  cell: (c: Pick<SimulatorClaim, 'adapterKey' | 'capability'>) => RegistryCell,
): MutableRow[] {
  const rows = structuredClone([...COMPATIBILITY_ROWS]) as MutableRow[];
  for (const c of claims) {
    for (const row of rows.filter((r) => r.adapterKey === c.adapterKey)) {
      const group = c.capability === 'accountingNormalize' ? 'accounting' : 'captivePortal';
      row.capabilities[group].push(cell(c));
    }
  }
  return rows;
}

function validate(rows: readonly CompatibilityRow[]) {
  return validateRegistry({
    vendors: structuredClone([...VENDORS]),
    rows,
    dtResults: structuredClone([...DT_RESULTS]),
    adapters: structuredClone(listCapabilities()),
  });
}

const simCell =
  (status: RegistryCell['status'] = 'ECLOUD_SIDE_ONLY') =>
  (c: Pick<SimulatorClaim, 'adapterKey' | 'capability'>): RegistryCell => ({
    capability: c.capability,
    status,
    evidenceLevel: 'SIMULATOR_TESTED',
    evidenceRefs: [{ kind: 'simulator', ref: `SIMULATOR_RESULTS.json ${c.capability}` }],
  });

describe('SIMULATOR_RESULTS.json', () => {
  it('is structurally valid and labelled as code-behaviour evidence, not hardware compatibility', () => {
    expect(checkSimulatorResults(FILE)).toEqual([]);
    expect(FILE.scope).toBe(SIMULATOR_SCOPE_STATEMENT);
    expect(FILE.scope).toMatch(/NOT hardware compatibility/);
    expect(FILE.scenarios.map((s) => s.id)).toEqual(SIMULATOR_SCENARIOS.map((s) => s.id));
  });

  it('claims only SIMULATOR_TESTED on operation capabilities of the two UAM adapters, each backed by PASS results', () => {
    const ops = new Set<string>(OPERATION_CAPABILITIES);
    for (const c of FILE.claims) {
      expect(ops.has(c.capability), c.capability).toBe(true);
      expect(SIM_ADAPTERS).toContain(c.adapterKey);
      expect(c.evidenceLevel).toBe('SIMULATOR_TESTED');
      expect(c.scenarios.length).toBeGreaterThan(0);
      for (const id of c.scenarios) {
        const rec = FILE.scenarios.find((s) => s.id === id);
        expect(rec?.results[c.adapterKey], `${c.adapterKey}/${c.capability} ${id}`).toBe('PASS');
      }
    }
    const text = JSON.stringify(FILE.claims);
    expect(text).not.toMatch(/LAB_VALIDATED|PRODUCTION_VALIDATED|disconnect|coaChange/);
  });

  it('every scenario that is not PASS withholds the claims that depend on it', () => {
    for (const w of FILE.withheld) {
      expect(w.blockingScenarios.length).toBeGreaterThan(0);
      expect(
        FILE.claims.some((c) => c.adapterKey === w.adapterKey && c.capability === w.capability),
      ).toBe(false);
    }
    expect(FILE.claims.length + FILE.withheld.length).toBe(
      SIM_ADAPTERS.length * OPERATION_CAPABILITIES.length,
    );
  });

  it('every scenario id has at least one test in tests/simulators', () => {
    const sources = readdirSync(DIR)
      .filter((f) => f.endsWith('.test.ts') && f !== 'results.test.ts')
      .map((f) => readFileSync(join(DIR, f), 'utf8'))
      .join('\n');
    for (const s of SIMULATOR_SCENARIOS) expect(sources, s.id).toContain(`${s.id} `);
  });

  it('the checker rejects tampered files (enforcement claim, unbacked claim, wrong level)', () => {
    const base = structuredClone(FILE) as SimulatorResultsFile & { claims: SimulatorClaim[] };
    const any = FILE.claims[0];
    if (!any) return;
    const enforcement = structuredClone(base);
    enforcement.claims.push({ ...any, capability: 'download_rate_kbps' as never });
    expect(checkSimulatorResults(enforcement).join()).toMatch(/non-operation capability/);
    const lab = structuredClone(base);
    lab.claims[0] = { ...any, evidenceLevel: 'LAB_VALIDATED' as never };
    expect(checkSimulatorResults(lab).join()).toMatch(/evidence LAB_VALIDATED/);
    const unbacked = structuredClone(base) as unknown as {
      scenarios: { id: string; results: Record<string, string> }[];
    };
    const first = unbacked.scenarios.find((s) => s.id === any.scenarios[0]);
    if (first) first.results[any.adapterKey] = 'FAIL';
    expect(checkSimulatorResults(unbacked as unknown as SimulatorResultsFile).join()).toMatch(
      /not backed by PASS/,
    );
    // A result edited after recording (or results copied from another run) breaks the binding.
    expect(checkSimulatorResults(unbacked as unknown as SimulatorResultsFile).join()).toMatch(
      /outcomes hash does not match/,
    );
    const otherRun = structuredClone(base);
    (otherRun.run as { runId: string }).runId = '0'.repeat(32);
    expect(checkSimulatorResults(otherRun).join()).toMatch(/outcomes hash does not match/);
  });
});

describe('registry promotion proposed by the results file', () => {
  it('applying the claims keeps the registry valid (V1–V12)', () => {
    expect(validate(promote(FILE.claims, simCell()))).toEqual([]);
  });

  it('SIMULATOR_TESTED on an enforcement capability fails V2; VERIFIED_SUPPORTED + SIMULATOR_TESTED fails V1', () => {
    const enforcement = promote(
      [{ adapterKey: 'coovachilli-uam', capability: 'download_rate_kbps' as never }],
      simCell(),
    );
    expect(violatedRules(validate(enforcement))).toContain('V2');
    const verified = promote(
      [{ adapterKey: 'coovachilli-uam', capability: 'redirectParse' }],
      simCell('VERIFIED_SUPPORTED'),
    );
    expect(violatedRules(validate(verified))).toContain('V1');
  });

  it('the current registry and adapter declarations carry SIMULATOR_TESTED only where the file backs it', () => {
    for (const caps of listCapabilities()) {
      expect(JSON.stringify(caps)).not.toContain('SIMULATOR_TESTED');
    }
    for (const row of COMPATIBILITY_ROWS) {
      for (const cells of Object.values(row.capabilities)) {
        for (const cell of cells) {
          if (cell.evidenceLevel !== 'SIMULATOR_TESTED') continue;
          expect(
            FILE.claims.some(
              (c) => c.adapterKey === row.adapterKey && c.capability === cell.capability,
            ),
            `${row.key}/${cell.capability}`,
          ).toBe(true);
        }
      }
    }
  });
});
