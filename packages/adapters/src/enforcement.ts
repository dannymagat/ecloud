/**
 * Evidence inputs of `chooseEnforcementStrategy` (@ecloud/policy-engine) for an engine adapter
 * (Phase 7 P7-A). The status is the adapter's own declaration; the evidence level and
 * `deviceEnforced` come only from the compatibility registry rows of the adapter
 * (`adapterCellEvidence`, V12: LAB/PRODUCTION evidence with a DT reference, every row).
 */
import { isDeviceEnforced } from '@ecloud/shared';
import type { MechanismEvidence } from '@ecloud/policy-engine';
import { adapterCellEvidence } from './registry/index.js';
import { getAdapter, isAdapterKey } from './registry.js';

export interface DynamicAuthorizationEvidence {
  readonly coaChange: MechanismEvidence;
  readonly disconnect: MechanismEvidence;
}

function mechanism(
  adapterKey: string,
  capability: 'coaChange' | 'disconnect',
  status: MechanismEvidence['status'],
): MechanismEvidence {
  const e = adapterCellEvidence(adapterKey, capability);
  return {
    status,
    evidenceLevel: e?.evidenceLevel ?? null,
    deviceEnforced:
      e !== undefined && e.deviceEnforced && isDeviceEnforced(status, e.evidenceLevel),
  };
}

/** Null when `adapterKey` is not an engine adapter key. */
export function dynamicAuthorizationEvidence(
  adapterKey: string | null,
): DynamicAuthorizationEvidence | null {
  if (adapterKey === null || !isAdapterKey(adapterKey)) return null;
  const caps = getAdapter(adapterKey).capabilities();
  return {
    coaChange: mechanism(adapterKey, 'coaChange', caps.coaChange.status),
    disconnect: mechanism(adapterKey, 'disconnect', caps.disconnect.status),
  };
}

/** Evidence of one policy field of an adapter (status from the declaration, level from the registry). */
export function fieldEvidence(
  adapterKey: string,
  field: string,
  status: MechanismEvidence['status'],
): MechanismEvidence {
  const e = adapterCellEvidence(adapterKey, field);
  return {
    status,
    evidenceLevel: e?.evidenceLevel ?? null,
    deviceEnforced:
      e !== undefined && e.deviceEnforced && isDeviceEnforced(status, e.evidenceLevel),
  };
}
