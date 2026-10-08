/**
 * Compatibility-registry schema (MULTI_VENDOR_INTEGRATION_PLAN.md §7.1). Typed data, mirrored to
 * the database in L3. Names are binding; fields marked "additive" are L2 extensions needed to
 * evaluate rules V7/V11 and are documented in the plan's §8.1 implementation notes.
 */
import type {
  AdapterFieldStatus,
  EvidenceLevel,
  EvidenceRef,
  Lifecycle,
  ResearchStatus,
} from '@ecloud/shared';

export type DeploymentMode = 'native' | 'gateway';

export type RoadmapPhase = 'pilot' | 'phase-a' | 'phase-b' | 'phase-c' | 'legacy-candidate';

export interface VendorEntry {
  readonly key: string;
  readonly name: string;
  /** Vendor-level lifecycle = max of its rows (checked under V9). */
  readonly lifecycle: Lifecycle;
  readonly roadmapPhase: RoadmapPhase;
  readonly docLinks: readonly EvidenceRef[];
  readonly notes?: string;
}

export const CAPABILITY_GROUPS = [
  'captivePortal',
  'accounting',
  'bandwidth',
  'disconnect',
  'monitoring',
  'configuration',
] as const;

export type CapabilityGroup = (typeof CAPABILITY_GROUPS)[number];

export interface RegistryFact {
  /** Fact value, or the literal `'UNKNOWN'` (plan §7.1 `string | 'UNKNOWN'`). */
  readonly value: string;
  readonly evidenceLevel: EvidenceLevel | null;
  readonly evidenceRefs: readonly EvidenceRef[];
  /** Additive: names an identity fact (e.g. `ucentralSchema`) so rules V7/V3 can find it. */
  readonly label?: string;
}

export interface RegistryCell {
  readonly capability: string;
  readonly status: ResearchStatus;
  readonly evidenceLevel: EvidenceLevel | null;
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly dtRefs?: readonly string[];
  readonly note?: string;
  /**
   * Additive: the engine declaration's status when the registry presents a different one
   * (V11 override on rows whose source version does not match the device).
   */
  readonly engineStatus?: AdapterFieldStatus;
}

/** Additive (R-19 / V7): how the row's device is configured. */
export type ConfigurationKind = 'ucentral' | 'coova-chilli-conf' | 'vendor-ui' | 'UNKNOWN';

export interface CompatibilityProfile {
  readonly licensing: RegistryFact;
  readonly redirectProtocol: RegistryFact;
  readonly authorizationMethod: RegistryFact;
  readonly radiusAuth: RegistryFact;
  readonly radiusAccounting: RegistryFact;
  readonly accountingInterval: RegistryFact;
  readonly disconnectCoa: RegistryFact;
  readonly bandwidthAttributes: RegistryFact;
  readonly quotaEnforcement: RegistryFact;
  readonly sessionTimeout: RegistryFact;
  readonly ipv6Behaviour: RegistryFact;
  readonly roamingContinuity: RegistryFact;
  readonly cloudDependencies: RegistryFact;
  /** WireGuard / RadSec / plain. */
  readonly transport: RegistryFact;
}

export interface OpenItem {
  readonly id: string;
  readonly label: 'REQUIRES_CLARIFICATION' | 'REQUIRES_DEVICE_TEST';
  readonly text: string;
}

export interface CompatibilityRow {
  readonly key: string;
  readonly vendorKey: string;
  /** Model, or the literal `'UNKNOWN'` (plan §7.1 `string | 'UNKNOWN'`). */
  readonly hardwareModel: string;
  /** Firmware / software version, or the literal `'UNKNOWN'`. */
  readonly firmware: string;
  readonly controller: { readonly product: string; readonly version: string } | null;
  readonly lifecycle: Lifecycle;
  readonly deploymentModes: readonly DeploymentMode[];
  readonly enforcementPoint: 'ap' | 'controller' | 'gateway' | 'UNKNOWN';
  readonly adapterKey: string | null;
  /** false ⇒ V11 presentation override; null when no source evidence / no device. */
  readonly sourceVersionMatchesDevice: boolean | null;
  readonly identity: readonly RegistryFact[];
  readonly profile: CompatibilityProfile;
  readonly capabilities: Readonly<Record<CapabilityGroup, readonly RegistryCell[]>>;
  readonly configurationKind: ConfigurationKind;
  readonly openItems: readonly OpenItem[];
}

export interface DeviceTestResult {
  readonly id: string;
  readonly date: string;
  readonly result: 'PASS' | 'FAIL' | 'PARTIAL' | 'N-A';
  readonly rowKey: string;
  readonly scope: string;
  readonly evidenceFile: string;
  /** Additive: capability cells this result covers; `identity:*` = the row's identity facts (V3). */
  readonly covers: readonly string[];
}
