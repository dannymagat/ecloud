/**
 * Simulation / dry-run (POLICY_ENGINE.md §6.4): resolve once, translate for every adapter the
 * caller passes, and return the per-field enforceability table the admin UI preview renders.
 */
import type { AdapterCapabilities } from './capabilities.js';
import { resolveEffectivePolicy, type ResolutionInput, type ResolutionResult } from './resolve.js';
import {
  translate,
  type EnforcementPlan,
  type FieldEnforceability,
  type TranslationContext,
} from './translate.js';

export interface SimulationInput {
  readonly resolution: ResolutionInput;
  readonly adapters: readonly AdapterCapabilities[];
  /** Translation context without `clip`/`controls`/`now` (taken from the resolution). */
  readonly translation?: Omit<TranslationContext, 'clip' | 'controls' | 'now'>;
}

export interface AdapterSimulation {
  readonly adapter: AdapterCapabilities['key'];
  readonly adapterVersion: string;
  readonly plan: EnforcementPlan | null;
  readonly fieldTable: readonly FieldEnforceability[];
}

export interface SimulationResult {
  readonly resolution: ResolutionResult;
  readonly perAdapter: readonly AdapterSimulation[];
  /** `capabilities_used` of §6.4 for each adapter. */
  readonly capabilitiesUsed: readonly string[];
}

export function simulate(input: SimulationInput): SimulationResult {
  const resolution = resolveEffectivePolicy({
    ...input.resolution,
    trigger: input.resolution.trigger ?? 'preview',
  });
  const perAdapter: AdapterSimulation[] = input.adapters.map((adapter) => {
    const plan = translate(resolution.effective, adapter, {
      ...(input.translation ?? {}),
      clip: resolution.clip,
      controls: resolution.controls,
      now: input.resolution.now,
    });
    return {
      adapter: adapter.key,
      adapterVersion: adapter.version,
      plan,
      fieldTable: plan.fieldTable,
    };
  });
  return {
    resolution,
    perAdapter,
    capabilitiesUsed: input.adapters.map((a) => `${a.key}@${a.version}`),
  };
}
