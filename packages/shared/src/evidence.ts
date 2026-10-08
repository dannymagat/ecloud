/**
 * Evidence model (MULTI_VENDOR_INTEGRATION_PLAN.md §4). Orthogonal to the four-state status of
 * D-028: the status says WHAT an adapter claims, the evidence level says HOW that claim is
 * backed. Approved design is not verified device capability (D-034): only `LAB_VALIDATED` and
 * `PRODUCTION_VALIDATED` evidence may ever be presented as device-enforced (rule V12, R-39).
 */
import type { AdapterFieldStatus } from './adapter-status.js';

/** Weakest → strongest (plan §4.1). */
export const EVIDENCE_LEVELS = [
  'DOCUMENTED',
  'VERIFIED_FROM_SOURCE',
  'SIMULATOR_TESTED',
  'LAB_VALIDATED',
  'PRODUCTION_VALIDATED',
] as const;

export type EvidenceLevel = (typeof EVIDENCE_LEVELS)[number];

export function isEvidenceLevel(value: unknown): value is EvidenceLevel {
  return typeof value === 'string' && (EVIDENCE_LEVELS as readonly string[]).includes(value);
}

/** Evidence levels that prove behaviour on a real device (plan §4.4, V12). */
export const DEVICE_EVIDENCE_LEVELS: readonly EvidenceLevel[] = [
  'LAB_VALIDATED',
  'PRODUCTION_VALIDATED',
];

/** Registry row / vendor lifecycle (plan §4.3). */
export const LIFECYCLES = [
  'planned',
  'researched',
  'implemented',
  'lab-validated',
  'production-validated',
] as const;

export type Lifecycle = (typeof LIFECYCLES)[number];

export function isLifecycle(value: unknown): value is Lifecycle {
  return typeof value === 'string' && (LIFECYCLES as readonly string[]).includes(value);
}

/**
 * Research state of a registry cell: the four D-028 statuses plus `UNKNOWN`, which exists only
 * on `planned`/`researched` registry rows (never an adapter field status, R-05).
 */
export type ResearchStatus = AdapterFieldStatus | 'UNKNOWN';

export const EVIDENCE_REF_KINDS = [
  'doc-section',
  'source',
  'url',
  'device-test',
  'simulator',
] as const;

export type EvidenceRefKind = (typeof EVIDENCE_REF_KINDS)[number];

export interface EvidenceRef {
  readonly kind: EvidenceRefKind;
  /** e.g. "CAPTIVE_PORTAL_ARCHITECTURE.md §3.4", "V-052: uspot.uc l.179-204", "DT-01". */
  readonly ref: string;
  /** Required for vendor facts taken from vendor or third-party documentation. */
  readonly url?: string;
  /** Firmware / source version the evidence covers (e.g. "coova-chilli master"). */
  readonly appliesTo?: string;
}

/**
 * Operation capabilities (ECLOUD's own adapter code paths). `SIMULATOR_TESTED` is allowed only
 * on these, never on an enforcement capability (rule V2).
 */
export const OPERATION_CAPABILITIES = [
  'redirectParse',
  'authorizationHandoff',
  'accountingNormalize',
] as const;

export type OperationCapability = (typeof OPERATION_CAPABILITIES)[number];

/**
 * Rule V12: device-enforced only when the status is VERIFIED_SUPPORTED **and** the evidence is
 * lab or production validated. Unknown input is never device-enforced.
 */
export function isDeviceEnforced(status: unknown, evidenceLevel: unknown): boolean {
  return (
    status === 'VERIFIED_SUPPORTED' &&
    isEvidenceLevel(evidenceLevel) &&
    DEVICE_EVIDENCE_LEVELS.includes(evidenceLevel)
  );
}
