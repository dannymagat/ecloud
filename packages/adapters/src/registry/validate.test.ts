/**
 * Validator rules V1–V12 (MULTI_VENDOR_INTEGRATION_PLAN.md §4.5, §8.1 AC6): the real data
 * passes, and each rule has a deliberately bad fixture that fails with exactly that rule.
 */
import { describe, expect, it } from 'vitest';
import type { AdapterCapabilities } from '@ecloud/policy-engine';
import { listCapabilities } from '../registry.js';
import { COMPATIBILITY_ROWS } from './compatibility.js';
import { presentCell } from './derive.js';
import { DT_RESULTS } from './dt-results.js';
import type { CompatibilityRow, DeviceTestResult, RegistryCell, VendorEntry } from './types.js';
import { validateRegistry, violatedRules, type RegistryInput, type RuleId } from './validate.js';
import { VENDORS } from './vendors.js';

const clone = <T>(v: T): T => structuredClone(v);

function baseInput(): {
  vendors: VendorEntry[];
  rows: CompatibilityRow[];
  dtResults: DeviceTestResult[];
  adapters: AdapterCapabilities[];
} {
  return {
    vendors: clone([...VENDORS]),
    rows: clone([...COMPATIBILITY_ROWS]),
    dtResults: clone([...DT_RESULTS]),
    adapters: clone(listCapabilities()),
  };
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] extends object ? Mutable<T[K]> : T[K] };

function rowOf(input: ReturnType<typeof baseInput>, key: string): Mutable<CompatibilityRow> {
  const r = input.rows.find((x) => x.key === key);
  if (!r) throw new Error(key);
  return r as Mutable<CompatibilityRow>;
}

function adapterOf(input: ReturnType<typeof baseInput>, key: string): Mutable<AdapterCapabilities> {
  const a = input.adapters.find((x) => x.key === key);
  if (!a) throw new Error(key);
  return a as Mutable<AdapterCapabilities>;
}

function rules(input: RegistryInput): RuleId[] {
  return violatedRules(validateRegistry(input));
}

const TIP = 'ezelink-eze-ap1832-r32912-tip-uspot';
const HOSTAPD = 'ezelink-eze-ap1832-r32912-hostapd-radius';
const CAMBIUM = 'cambium-cnpilot-e-external-hotspot';

function cellOf(
  row: Mutable<CompatibilityRow>,
  group: keyof CompatibilityRow['capabilities'],
  capability: string,
): Mutable<RegistryCell> {
  const c = row.capabilities[group].find((x) => x.capability === capability);
  if (!c) throw new Error(capability);
  return c;
}

describe('registry validator (V1–V12)', () => {
  it('real registry and adapter declarations are valid', () => {
    expect(validateRegistry(baseInput())).toEqual([]);
  });

  it('V1: VERIFIED_SUPPORTED with DOCUMENTED evidence fails', () => {
    const input = baseInput();
    const f = adapterOf(input, 'coovachilli-uam').fields.download_rate_kbps;
    f.evidenceLevel = 'DOCUMENTED';
    expect(rules(input)).toEqual(['V1']);
  });

  it('V2: SIMULATOR_TESTED on an enforcement capability fails (operation capability passes)', () => {
    const input = baseInput();
    const cell = cellOf(rowOf(input, TIP), 'bandwidth', 'download_rate_kbps');
    cell.evidenceLevel = 'SIMULATOR_TESTED';
    cell.evidenceRefs = [{ kind: 'simulator', ref: 'SIM-01' }];
    expect(rules(input)).toContain('V2');

    const ok = baseInput();
    rowOf(ok, TIP).capabilities.captivePortal.push({
      capability: 'redirectParse',
      status: 'VERIFIED_SUPPORTED',
      evidenceLevel: 'SIMULATOR_TESTED',
      evidenceRefs: [{ kind: 'simulator', ref: 'SIM-01' }],
    });
    expect(rules(ok)).not.toContain('V2');
  });

  it('V3: LAB_VALIDATED without a matching DT PASS fails (missing ref, unknown DT, other firmware, adapter)', () => {
    const missing = baseInput();
    cellOf(rowOf(missing, TIP), 'configuration', 'apWireguardPeer').dtRefs = [];
    cellOf(rowOf(missing, TIP), 'configuration', 'apWireguardPeer').evidenceRefs = [];
    expect(rules(missing)).toEqual(['V3']);

    const unknown = baseInput();
    cellOf(rowOf(unknown, TIP), 'configuration', 'apWireguardPeer').dtRefs = ['DT-04'];
    expect(rules(unknown)).toContain('V3');

    const otherFw = baseInput();
    rowOf(otherFw, HOSTAPD).firmware = 'EZEAP 7 r40000';
    expect(rules(otherFw)).toContain('V3');

    const adapter = baseInput();
    adapterOf(adapter, 'openwifi-uspot-uam').fields.session_timeout_s.evidenceLevel =
      'LAB_VALIDATED';
    expect(rules(adapter)).toEqual(['V3']);
  });

  it('V3: a DT that does not cover the capability fails (TIP disconnect "validated" by DT-01)', () => {
    const input = baseInput();
    const d = cellOf(rowOf(input, TIP), 'disconnect', 'disconnect');
    d.status = 'VERIFIED_SUPPORTED';
    d.evidenceLevel = 'LAB_VALIDATED';
    d.dtRefs = ['DT-01'];
    expect(rules(input)).toEqual(['V3']);
  });

  it('V1: a non-UNKNOWN cell without an evidence level fails', () => {
    const input = baseInput();
    cellOf(rowOf(input, TIP), 'bandwidth', 'burst_duration_s').evidenceLevel = null;
    expect(rules(input)).toEqual(['V1']);
  });

  it('V4: lifecycle production-validated on a row or a vendor fails', () => {
    const row = baseInput();
    rowOf(row, TIP).lifecycle = 'production-validated';
    (row.vendors.find((v) => v.key === 'ezelink') as Mutable<VendorEntry>).lifecycle =
      'production-validated';
    expect(rules(row)).toContain('V4');
    const vendor = baseInput();
    (vendor.vendors.find((v) => v.key === 'mikrotik') as Mutable<VendorEntry>).lifecycle =
      'production-validated';
    expect(rules(vendor)).toContain('V4');
  });

  it('V8: a lab-validated row without a PASS device test recorded for it fails', () => {
    const input = baseInput();
    rowOf(input, HOSTAPD).lifecycle = 'lab-validated';
    (input.vendors.find((v) => v.key === 'ezelink') as Mutable<VendorEntry>).lifecycle =
      'lab-validated';
    expect(rules(input)).toEqual(['V8']);
  });

  it('V6: a planned row with a non-UNKNOWN cell fails', () => {
    const input = baseInput();
    const cell = rowOf(input, 'ubiquiti-unifi-planned').capabilities
      .bandwidth[0] as Mutable<RegistryCell>;
    cell.status = 'REQUIRES_DEVICE_TEST';
    cell.evidenceLevel = 'DOCUMENTED';
    expect(rules(input)).toEqual(['V6']);
  });

  it('V4: any PRODUCTION_VALIDATED fails', () => {
    const input = baseInput();
    rowOf(input, TIP).profile.licensing.evidenceLevel = 'PRODUCTION_VALIDATED';
    expect(rules(input)).toEqual(['V4']);
  });

  it('V5: Disconnect / CoA VERIFIED_SUPPORTED without LAB_VALIDATED fails (D-006)', () => {
    const input = baseInput();
    const d = adapterOf(input, 'coovachilli-uam').disconnect;
    d.status = 'VERIFIED_SUPPORTED';
    d.evidenceLevel = 'VERIFIED_FROM_SOURCE';
    d.evidenceRefs = [{ kind: 'source', ref: 'V-074', appliesTo: 'coova-chilli master' }];
    expect(rules(input)).toEqual(['V5']);
  });

  it('V6: a researched row with an adapter, a verified cell or a URL-less fact fails', () => {
    const adapter = baseInput();
    rowOf(adapter, CAMBIUM).adapterKey = 'coovachilli-uam';
    expect(rules(adapter)).toContain('V6');

    const verified = baseInput();
    const cell = cellOf(rowOf(verified, CAMBIUM), 'bandwidth', 'rateLimit');
    cell.status = 'VERIFIED_SUPPORTED';
    cell.evidenceLevel = 'VERIFIED_FROM_SOURCE';
    cell.evidenceRefs = [{ kind: 'source', ref: 'x', url: 'https://example.invalid/doc' }];
    expect(rules(verified)).toEqual(['V6']);

    const noUrl = baseInput();
    rowOf(noUrl, CAMBIUM).profile.licensing.evidenceRefs = [
      { kind: 'doc-section', ref: 'hearsay' },
    ];
    expect(rules(noUrl)).toEqual(['V6']);
  });

  it('V7: uCentral configuration on a non-uCentral row, or openwifi-config off uCentral, fails', () => {
    const input = baseInput();
    rowOf(input, 'coova-chilli-master').configurationKind = 'ucentral';
    expect(rules(input)).toEqual(['V7']);

    const cfg = baseInput();
    rowOf(cfg, 'ezelink-eze-ap1832-r32912-ucentral-config').configurationKind = 'vendor-ui';
    expect(rules(cfg)).toEqual(['V7']);
  });

  it('V8: a lab-validated row with source-only verified enforcement cells fails', () => {
    const input = baseInput();
    rowOf(input, TIP).lifecycle = 'lab-validated';
    const ezelink = input.vendors.find((v) => v.key === 'ezelink') as Mutable<VendorEntry>;
    ezelink.lifecycle = 'lab-validated';
    expect(rules(input)).toEqual(['V8']);
  });

  it('V9: duplicate keys, unknown adapter keys and uncovered engine adapters fail', () => {
    const dup = baseInput();
    dup.rows.push(clone(rowOf(dup, TIP)));
    expect(rules(dup)).toEqual(['V9']);

    const unknownAdapter = baseInput();
    rowOf(unknownAdapter, 'coova-chilli-master').adapterKey = 'cambium-hotspot';
    expect(rules(unknownAdapter)).toContain('V9');

    const uncovered = baseInput();
    uncovered.rows = uncovered.rows.filter((r) => r.adapterKey !== 'openwifi-hostapd-radius');
    expect(rules(uncovered)).toEqual(['V9']);
  });

  it('V10: VERIFIED_FROM_SOURCE with only a doc-section reference fails', () => {
    const input = baseInput();
    const f = adapterOf(input, 'openwifi-uspot-uam').fields.idle_timeout_s;
    f.evidenceRefs = [{ kind: 'doc-section', ref: 'CAPTIVE_PORTAL_ARCHITECTURE.md §3.4' }];
    expect(rules(input)).toEqual(['V10']);
  });

  it('V11: a source/device version mismatch row presenting VERIFIED_SUPPORTED fails', () => {
    const input = baseInput();
    const cell = cellOf(
      rowOf(input, 'coova-chilli-1.2.9-ezegate'),
      'bandwidth',
      'download_rate_kbps',
    );
    cell.status = 'VERIFIED_SUPPORTED';
    expect(rules(input)).toEqual(['V11']);

    const noAppliesTo = baseInput();
    const c2 = cellOf(
      rowOf(noAppliesTo, 'coova-chilli-1.2.9-ezegate'),
      'accounting',
      'quota_total_bytes',
    );
    c2.evidenceRefs = c2.evidenceRefs.map((r) => ({ kind: r.kind, ref: r.ref }));
    expect(rules(noAppliesTo)).toEqual(['V11']);
  });

  it('V12: a presentation that shows a source-verified cell as device-enforced fails', () => {
    const input: RegistryInput = {
      ...baseInput(),
      present: (group, cell) => ({
        ...presentCell(group, cell),
        deviceEnforced: cell.status === 'VERIFIED_SUPPORTED',
      }),
    };
    expect(rules(input)).toEqual(['V12']);
  });
});
