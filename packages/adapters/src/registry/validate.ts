/**
 * Registry / declaration validator — rules V1–V12 of MULTI_VENDOR_INTEGRATION_PLAN.md §4.5.
 * Pure; returns every violation (empty list = valid). Mirrored by the L3 seed check.
 */
import {
  LIFECYCLES,
  OPERATION_CAPABILITIES,
  POLICY_FIELDS,
  isDeviceEnforced,
  type EvidenceLevel,
  type EvidenceRef,
  type Lifecycle,
  type ResearchStatus,
} from '@ecloud/shared';
import { ADAPTER_KEYS, type AdapterCapabilities, type AdapterFlag } from '@ecloud/policy-engine';
import { presentCell, type PresentedCell } from './derive.js';
import {
  CAPABILITY_GROUPS,
  type CapabilityGroup,
  type CompatibilityRow,
  type DeviceTestResult,
  type RegistryCell,
  type RegistryFact,
  type VendorEntry,
} from './types.js';

export type RuleId =
  'V1' | 'V2' | 'V3' | 'V4' | 'V5' | 'V6' | 'V7' | 'V8' | 'V9' | 'V10' | 'V11' | 'V12';

export interface Violation {
  readonly rule: RuleId;
  /** e.g. `adapter:coovachilli-uam/fields.vlan_id` or `row:cambium-…/disconnect.coaChange`. */
  readonly subject: string;
  readonly message: string;
}

/** A single evidence-bearing claim, normalised from adapters, registry cells and facts. */
interface Claim {
  readonly subject: string;
  readonly capability: string;
  readonly status: ResearchStatus | null;
  readonly evidenceLevel: EvidenceLevel | null;
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly dtRefs: readonly string[];
  /** Registry row the claim belongs to (null for model-agnostic adapter declarations). */
  readonly row: CompatibilityRow | null;
}

const DEVICE_CLAIM_ACTIONS = new Set(['disconnect', 'coaChange']);
const OPERATIONS = new Set<string>(OPERATION_CAPABILITIES);

function hasSourceRef(refs: readonly EvidenceRef[]): boolean {
  return refs.some((r) => r.kind === 'source' && r.ref.trim().length > 0);
}

function hasUrl(refs: readonly EvidenceRef[]): boolean {
  return refs.some((r) => typeof r.url === 'string' && /^https:\/\//.test(r.url));
}

/**
 * Whether a device-test result covers a claim: cells by capability name; identity facts
 * (`identity.<label>`) by `identity:*` or their exact name.
 */
export function dtCovers(result: DeviceTestResult, capability: string): boolean {
  return (
    result.covers.includes(capability) ||
    (capability.startsWith('identity.') && result.covers.includes('identity:*'))
  );
}

function dtRefsOf(refs: readonly EvidenceRef[], explicit?: readonly string[]): string[] {
  return [...(explicit ?? []), ...refs.filter((r) => r.kind === 'device-test').map((r) => r.ref)];
}

// ------------------------------------------------------------------------------------------
// Per-claim rules (V1, V2, V3, V4, V5, V10)
// ------------------------------------------------------------------------------------------

function checkClaim(
  c: Claim,
  ctx: { rows: readonly CompatibilityRow[]; dtResults: readonly DeviceTestResult[] },
  out: Violation[],
): void {
  const push = (rule: RuleId, message: string): void => {
    out.push({ rule, subject: c.subject, message });
  };
  if (c.status !== null && c.status !== 'UNKNOWN' && c.evidenceLevel === null)
    push('V1', `${c.status} without an evidence level`);
  if (
    c.status === 'VERIFIED_SUPPORTED' &&
    c.evidenceLevel !== 'VERIFIED_FROM_SOURCE' &&
    c.evidenceLevel !== 'LAB_VALIDATED' &&
    c.evidenceLevel !== 'PRODUCTION_VALIDATED'
  )
    push('V1', `VERIFIED_SUPPORTED with evidence ${String(c.evidenceLevel)}`);

  if (c.evidenceLevel === 'SIMULATOR_TESTED' && !OPERATIONS.has(c.capability))
    push('V2', `SIMULATOR_TESTED on enforcement capability ${c.capability}`);

  if (c.evidenceLevel === 'LAB_VALIDATED') {
    if (!c.row) {
      push(
        'V3',
        'LAB_VALIDATED on a model-agnostic adapter declaration (needs a registry row + DT)',
      );
    } else {
      const refs = c.dtRefs;
      if (refs.length === 0) push('V3', 'LAB_VALIDATED without dtRefs');
      for (const id of refs) {
        const result = ctx.dtResults.find((d) => d.id === id);
        if (!result) {
          push('V3', `${id} is not in DT_RESULTS`);
          continue;
        }
        if (result.result !== 'PASS') push('V3', `${id} result is ${result.result}, not PASS`);
        if (!dtCovers(result, c.capability))
          push(
            'V3',
            `${id} does not cover ${c.capability} (covers: ${result.covers.join(', ') || 'nothing'})`,
          );
        const tested = ctx.rows.find((r) => r.key === result.rowKey);
        if (
          !tested ||
          tested.hardwareModel !== c.row.hardwareModel ||
          tested.firmware !== c.row.firmware
        )
          push('V3', `${id} was recorded for another model/firmware than ${c.row.key}`);
      }
    }
  }

  if (c.evidenceLevel === 'PRODUCTION_VALIDATED')
    push('V4', 'PRODUCTION_VALIDATED is not allowed until an owner-approved record type exists');

  if (
    DEVICE_CLAIM_ACTIONS.has(c.capability) &&
    c.status === 'VERIFIED_SUPPORTED' &&
    c.evidenceLevel !== 'LAB_VALIDATED'
  )
    push('V5', `${c.capability} VERIFIED_SUPPORTED requires LAB_VALIDATED evidence (D-006)`);

  if (c.evidenceLevel === 'VERIFIED_FROM_SOURCE' && !hasSourceRef(c.evidenceRefs))
    push('V10', 'VERIFIED_FROM_SOURCE without a `source` evidence reference');
}

// ------------------------------------------------------------------------------------------
// Claim extraction
// ------------------------------------------------------------------------------------------

function flagClaim(subject: string, capability: string, flag: AdapterFlag): Claim {
  const refs = flag.evidenceRefs ?? [];
  return {
    subject,
    capability,
    status: flag.status,
    evidenceLevel: flag.evidenceLevel,
    evidenceRefs: refs,
    dtRefs: dtRefsOf(refs),
    row: null,
  };
}

export function adapterClaims(caps: AdapterCapabilities): Claim[] {
  const base = `adapter:${caps.key}`;
  const out: Claim[] = [];
  for (const field of POLICY_FIELDS)
    out.push(flagClaim(`${base}/fields.${field}`, field, caps.fields[field]));
  out.push(flagClaim(`${base}/disconnect`, 'disconnect', caps.disconnect));
  out.push(flagClaim(`${base}/coaChange`, 'coaChange', caps.coaChange));
  out.push(flagClaim(`${base}/macAuth`, 'macAuth', caps.macAuth));
  for (const [name, a] of Object.entries(caps.attributes))
    out.push(flagClaim(`${base}/attributes.${name}`, name, a));
  return out;
}

function cellClaim(row: CompatibilityRow, group: CapabilityGroup, cell: RegistryCell): Claim {
  return {
    subject: `row:${row.key}/${group}.${cell.capability}`,
    capability: cell.capability,
    status: cell.status,
    evidenceLevel: cell.evidenceLevel,
    evidenceRefs: cell.evidenceRefs,
    dtRefs: dtRefsOf(cell.evidenceRefs, cell.dtRefs),
    row,
  };
}

function factClaim(row: CompatibilityRow, name: string, f: RegistryFact): Claim {
  return {
    subject: `row:${row.key}/${name}`,
    capability: name,
    status: null,
    evidenceLevel: f.evidenceLevel,
    evidenceRefs: f.evidenceRefs,
    dtRefs: dtRefsOf(f.evidenceRefs),
    row,
  };
}

function rowFacts(row: CompatibilityRow): [string, RegistryFact][] {
  return [
    ...row.identity.map((f, i): [string, RegistryFact] => [`identity.${f.label ?? String(i)}`, f]),
    ...(Object.entries(row.profile) as [string, RegistryFact][]).map(
      ([k, f]): [string, RegistryFact] => [`profile.${k}`, f],
    ),
  ];
}

// ------------------------------------------------------------------------------------------
// Public API
// ------------------------------------------------------------------------------------------

export interface RegistryInput {
  readonly vendors: readonly VendorEntry[];
  readonly rows: readonly CompatibilityRow[];
  readonly dtResults: readonly DeviceTestResult[];
  readonly adapters: readonly AdapterCapabilities[];
  /** Presentation under test (V12); defaults to the registry's own `presentCell`. */
  readonly present?: (group: CapabilityGroup, cell: RegistryCell) => PresentedCell;
}

const LIFECYCLE_RANK = new Map<Lifecycle, number>(LIFECYCLES.map((l, i) => [l, i]));

export function validateRegistry(input: RegistryInput): Violation[] {
  const out: Violation[] = [];
  const ctx = { rows: input.rows, dtResults: input.dtResults };
  const present = input.present ?? presentCell;

  // Adapter declarations: V1, V2, V3, V4, V5, V10.
  for (const caps of input.adapters) for (const c of adapterClaims(caps)) checkClaim(c, ctx, out);

  // V9: uniqueness, adapter keys, vendor references, coverage of engine adapters.
  const seen = new Set<string>();
  for (const row of input.rows) {
    if (seen.has(row.key))
      out.push({ rule: 'V9', subject: `row:${row.key}`, message: 'duplicate registry row key' });
    seen.add(row.key);
    if (row.adapterKey !== null && !(ADAPTER_KEYS as readonly string[]).includes(row.adapterKey))
      out.push({
        rule: 'V9',
        subject: `row:${row.key}`,
        message: `unknown adapterKey ${row.adapterKey}`,
      });
    if (!input.vendors.some((v) => v.key === row.vendorKey))
      out.push({
        rule: 'V9',
        subject: `row:${row.key}`,
        message: `unknown vendorKey ${row.vendorKey}`,
      });
  }
  const vendorKeys = new Set<string>();
  for (const v of input.vendors) {
    if (v.lifecycle === 'production-validated')
      out.push({
        rule: 'V4',
        subject: `vendor:${v.key}`,
        message: 'lifecycle production-validated is not allowed yet',
      });
    if (vendorKeys.has(v.key))
      out.push({ rule: 'V9', subject: `vendor:${v.key}`, message: 'duplicate vendor key' });
    vendorKeys.add(v.key);
    const ranks = input.rows
      .filter((r) => r.vendorKey === v.key)
      .map((r) => LIFECYCLE_RANK.get(r.lifecycle) ?? 0);
    if (ranks.length > 0 && LIFECYCLE_RANK.get(v.lifecycle) !== Math.max(...ranks))
      out.push({
        rule: 'V9',
        subject: `vendor:${v.key}`,
        message: `vendor lifecycle ${v.lifecycle} is not the maximum of its rows`,
      });
  }
  for (const key of ADAPTER_KEYS)
    // "implemented" or beyond (a lab-validated row is still an implemented row).
    if (
      !input.rows.some(
        (r) =>
          r.adapterKey === key &&
          (LIFECYCLE_RANK.get(r.lifecycle) ?? 0) >= (LIFECYCLE_RANK.get('implemented') ?? 2),
      )
    )
      out.push({
        rule: 'V9',
        subject: `adapter:${key}`,
        message: 'engine adapter has no implemented registry row',
      });

  for (const row of input.rows) {
    const cells = CAPABILITY_GROUPS.flatMap((g) => row.capabilities[g].map((c) => [g, c] as const));

    // V1–V5, V10 on cells and facts.
    for (const [g, c] of cells) checkClaim(cellClaim(row, g, c), ctx, out);
    for (const [name, f] of rowFacts(row)) checkClaim(factClaim(row, name, f), ctx, out);

    // V4: no production-validated rows until an owner-approved record type exists.
    if (row.lifecycle === 'production-validated')
      out.push({
        rule: 'V4',
        subject: `row:${row.key}`,
        message: 'lifecycle production-validated is not allowed yet',
      });

    // V6: planned/researched rows carry no adapter and no verified cell; planned rows hold only
    // UNKNOWN cells; researched cells/facts cite URLs.
    if (row.lifecycle === 'planned' || row.lifecycle === 'researched') {
      if (row.adapterKey !== null)
        out.push({
          rule: 'V6',
          subject: `row:${row.key}`,
          message: `${row.lifecycle} row with adapterKey`,
        });
      for (const [g, c] of cells) {
        if (c.status === 'VERIFIED_SUPPORTED')
          out.push({
            rule: 'V6',
            subject: `row:${row.key}/${g}.${c.capability}`,
            message: `VERIFIED_SUPPORTED on a ${row.lifecycle} row`,
          });
        if (row.lifecycle === 'planned' && c.status !== 'UNKNOWN')
          out.push({
            rule: 'V6',
            subject: `row:${row.key}/${g}.${c.capability}`,
            message: 'planned row with a researched or claimed cell',
          });
        if (row.lifecycle === 'researched' && c.status !== 'UNKNOWN' && !hasUrl(c.evidenceRefs))
          out.push({
            rule: 'V6',
            subject: `row:${row.key}/${g}.${c.capability}`,
            message: 'researched cell without a cited URL',
          });
      }
      if (row.lifecycle === 'researched')
        for (const [name, f] of rowFacts(row))
          if (f.value !== 'UNKNOWN' && !hasUrl(f.evidenceRefs))
            out.push({
              rule: 'V6',
              subject: `row:${row.key}/${name}`,
              message: 'researched fact without a cited URL',
            });
    }

    // V7: uCentral configuration only for uCentral firmware; openwifi-config only on such rows.
    const ucentralIdentity = row.identity.some(
      (f) => f.label === 'ucentralSchema' && f.value !== 'UNKNOWN',
    );
    if (row.configurationKind === 'ucentral' && !ucentralIdentity)
      out.push({
        rule: 'V7',
        subject: `row:${row.key}`,
        message: "configurationKind 'ucentral' without a uCentral firmware identity",
      });
    if (row.adapterKey === 'openwifi-config' && row.configurationKind !== 'ucentral')
      out.push({
        rule: 'V7',
        subject: `row:${row.key}`,
        message: 'openwifi-config targets a row that is not configured via uCentral',
      });

    // V8: lab-validated rows need LAB_VALIDATED (V3-valid) evidence on every verified enforcement cell.
    if (row.lifecycle === 'lab-validated' || row.lifecycle === 'production-validated') {
      if (!input.dtResults.some((d) => d.rowKey === row.key && d.result === 'PASS'))
        out.push({
          rule: 'V8',
          subject: `row:${row.key}`,
          message: `${row.lifecycle} row without a PASS device-test result recorded for it`,
        });
      for (const [g, c] of cells) {
        if (c.status !== 'VERIFIED_SUPPORTED' || OPERATIONS.has(c.capability)) continue;
        const claim = cellClaim(row, g, c);
        const v3: Violation[] = [];
        checkClaim(claim, ctx, v3);
        if (c.evidenceLevel !== 'LAB_VALIDATED' || v3.some((v) => v.rule === 'V3'))
          out.push({
            rule: 'V8',
            subject: claim.subject,
            message: `${row.lifecycle} row with a verified enforcement cell lacking valid lab evidence`,
          });
      }
    }

    // V11: source version differs from the device ⇒ nothing presented VERIFIED_SUPPORTED unless a DT covers it.
    if (row.sourceVersionMatchesDevice === false) {
      for (const [g, c] of cells) {
        const covered = input.dtResults.some(
          (d) => d.rowKey === row.key && d.result === 'PASS' && d.covers.includes(c.capability),
        );
        if (present(g, c).status === 'VERIFIED_SUPPORTED' && !covered)
          out.push({
            rule: 'V11',
            subject: `row:${row.key}/${g}.${c.capability}`,
            message:
              'presented VERIFIED_SUPPORTED although the source version does not match the device',
          });
        if (
          c.engineStatus === 'VERIFIED_SUPPORTED' &&
          !c.evidenceRefs.some((r) => r.kind === 'source' && typeof r.appliesTo === 'string')
        )
          out.push({
            rule: 'V11',
            subject: `row:${row.key}/${g}.${c.capability}`,
            message: 'overridden cell without `appliesTo` naming the source version',
          });
      }
    }

    // V12: deviceEnforced only for VERIFIED_SUPPORTED + LAB/PRODUCTION evidence.
    for (const [g, c] of cells) {
      const p = present(g, c);
      if (p.deviceEnforced && !isDeviceEnforced(p.status, p.evidenceLevel))
        out.push({
          rule: 'V12',
          subject: `row:${row.key}/${g}.${c.capability}`,
          message: `presented as device-enforced with ${p.status} / ${String(p.evidenceLevel)}`,
        });
    }
  }
  return out;
}

/** Helper for tests and the L3 seed check: rules violated, de-duplicated and sorted. */
export function violatedRules(violations: readonly Violation[]): RuleId[] {
  return [...new Set(violations.map((v) => v.rule))].sort(
    (a, b) => Number(a.slice(1)) - Number(b.slice(1)),
  );
}
