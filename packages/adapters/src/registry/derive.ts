/**
 * Derivation of registry cells from the engine capability records (plan §7.1: "for implemented
 * rows the per-field cells are derived from engine.capabilities()") and the presentation rules
 * of §4.4 (V11 override, V12 deviceEnforced). The registry stores only row-specific extras;
 * engine declarations are never modified.
 */
import {
  POLICY_FIELDS,
  isDeviceEnforced,
  type EvidenceLevel,
  type EvidenceRef,
  type PolicyField,
  type ResearchStatus,
} from '@ecloud/shared';
import type { AdapterCapabilities, AdapterFlag } from '@ecloud/policy-engine';
import {
  CAPABILITY_GROUPS,
  type CapabilityGroup,
  type DeviceTestResult,
  type RegistryCell,
} from './types.js';

/** Capability group of every engine policy field (fields are enforcement capabilities). */
export const FIELD_GROUP: Readonly<Record<PolicyField, CapabilityGroup>> = Object.freeze({
  download_rate_kbps: 'bandwidth',
  upload_rate_kbps: 'bandwidth',
  burst_download_kbps: 'bandwidth',
  burst_upload_kbps: 'bandwidth',
  burst_duration_s: 'bandwidth',
  quota_daily_bytes: 'accounting',
  quota_monthly_bytes: 'accounting',
  quota_total_bytes: 'accounting',
  session_timeout_s: 'captivePortal',
  idle_timeout_s: 'captivePortal',
  max_concurrent_sessions: 'captivePortal',
  max_devices: 'captivePortal',
  valid_from: 'captivePortal',
  valid_until: 'captivePortal',
  voucher_validity: 'captivePortal',
  schedule_id: 'captivePortal',
  vlan_id: 'captivePortal',
});

export interface DeriveOptions {
  readonly rowKey: string;
  /** `false` ⇒ engine VERIFIED_SUPPORTED cells are presented REQUIRES_DEVICE_TEST (V11). */
  readonly sourceVersionMatchesDevice: boolean | null;
  /** Firmware the device runs, for the V11 note. */
  readonly deviceFirmware: string;
  readonly dtResults: readonly DeviceTestResult[];
  /** Row-specific cells added to the derived ones (e.g. DT-01's WireGuard finding). */
  readonly extraCells?: Partial<Record<CapabilityGroup, readonly RegistryCell[]>>;
}

function coveredByPass(
  rowKey: string,
  capability: string,
  dtResults: readonly DeviceTestResult[],
): string[] {
  return dtResults
    .filter((d) => d.rowKey === rowKey && d.result === 'PASS' && d.covers.includes(capability))
    .map((d) => d.id);
}

function sourceVersionOf(refs: readonly EvidenceRef[]): string {
  return refs.find((r) => r.kind === 'source' && r.appliesTo)?.appliesTo ?? 'analysed source';
}

function cellFrom(capability: string, flag: AdapterFlag, opts: DeriveOptions): RegistryCell {
  const refs = flag.evidenceRefs ?? [];
  const base = {
    capability,
    evidenceLevel: flag.evidenceLevel as EvidenceLevel | null,
    evidenceRefs: refs,
  };
  if (
    opts.sourceVersionMatchesDevice === false &&
    flag.status === 'VERIFIED_SUPPORTED' &&
    coveredByPass(opts.rowKey, capability, opts.dtResults).length === 0
  ) {
    return {
      ...base,
      status: 'REQUIRES_DEVICE_TEST',
      engineStatus: 'VERIFIED_SUPPORTED',
      note: `Verified in ${sourceVersionOf(refs)} source; this device runs ${opts.deviceFirmware} (V11: needs a device test before it is presented as verified).`,
    };
  }
  return flag.note
    ? { ...base, status: flag.status, note: flag.note }
    : { ...base, status: flag.status };
}

/** Per-group cells of an implemented row, derived from the engine record. */
export function deriveCells(
  caps: AdapterCapabilities,
  opts: DeriveOptions,
): Readonly<Record<CapabilityGroup, readonly RegistryCell[]>> {
  const out: Record<CapabilityGroup, RegistryCell[]> = {
    captivePortal: [],
    accounting: [],
    bandwidth: [],
    disconnect: [],
    monitoring: [],
    configuration: [],
  };
  for (const field of POLICY_FIELDS)
    out[FIELD_GROUP[field]].push(cellFrom(field, caps.fields[field], opts));
  out.captivePortal.push(cellFrom('macAuth', caps.macAuth, opts));
  out.disconnect.push(cellFrom('disconnect', caps.disconnect, opts));
  out.disconnect.push(cellFrom('coaChange', caps.coaChange, opts));
  for (const group of CAPABILITY_GROUPS) out[group].push(...(opts.extraCells?.[group] ?? []));
  return out;
}

/** Every group `UNKNOWN` (planned rows, plan §7.4). */
export function unknownCells(): Readonly<Record<CapabilityGroup, readonly RegistryCell[]>> {
  const cell = (group: CapabilityGroup): RegistryCell => ({
    capability: `${group}:*`,
    status: 'UNKNOWN',
    evidenceLevel: null,
    evidenceRefs: [],
  });
  return {
    captivePortal: [cell('captivePortal')],
    accounting: [cell('accounting')],
    bandwidth: [cell('bandwidth')],
    disconnect: [cell('disconnect')],
    monitoring: [cell('monitoring')],
    configuration: [cell('configuration')],
  };
}

export interface PresentedCell {
  readonly group: CapabilityGroup;
  readonly capability: string;
  readonly status: ResearchStatus;
  readonly engineStatus: ResearchStatus;
  readonly evidenceLevel: EvidenceLevel | null;
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly dtRefs: readonly string[];
  /** V12: true only for VERIFIED_SUPPORTED + LAB/PRODUCTION evidence with a DT reference. */
  readonly deviceEnforced: boolean;
  readonly note?: string;
}

export function presentCell(group: CapabilityGroup, cell: RegistryCell): PresentedCell {
  const dtRefs = cell.dtRefs ?? [];
  return {
    group,
    capability: cell.capability,
    status: cell.status,
    engineStatus: cell.engineStatus ?? cell.status,
    evidenceLevel: cell.evidenceLevel,
    evidenceRefs: cell.evidenceRefs,
    dtRefs,
    deviceEnforced: isDeviceEnforced(cell.status, cell.evidenceLevel) && dtRefs.length > 0,
    ...(cell.note ? { note: cell.note } : {}),
  };
}

export function presentCells(
  capabilities: Readonly<Record<CapabilityGroup, readonly RegistryCell[]>>,
): PresentedCell[] {
  return CAPABILITY_GROUPS.flatMap((g) => capabilities[g].map((c) => presentCell(g, c)));
}
