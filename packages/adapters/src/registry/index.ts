/** Compatibility registry (MULTI_VENDOR_INTEGRATION_PLAN.md §7) and its validator (§4.5). */
export * from './types.js';
export { COMPATIBILITY_ROWS, getCompatibilityRow } from './compatibility.js';
export { VENDORS, ROADMAP_VENDORS, CAMBIUM_SOURCES } from './vendors.js';
export { DT_RESULTS } from './dt-results.js';
export {
  FIELD_GROUP,
  deriveCells,
  presentCell,
  presentCells,
  unknownCells,
  type DeriveOptions,
  type PresentedCell,
} from './derive.js';
export {
  adapterClaims,
  validateRegistry,
  violatedRules,
  type RegistryInput,
  type RuleId,
  type Violation,
} from './validate.js';
export {
  REGISTRY_SNAPSHOT,
  adapterCellEvidence,
  canonicalJson,
  deploymentModesForAdapter,
  registryEntryHash,
  registrySnapshotHash,
  type AdapterCellEvidence,
  type RegistrySnapshot,
} from './mirror.js';
