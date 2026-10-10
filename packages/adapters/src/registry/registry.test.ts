/** Compatibility registry content (MULTI_VENDOR_INTEGRATION_PLAN.md §7, §8.1 AC4a/AC5/AC7). */
import { describe, expect, it } from 'vitest';
import { POLICY_FIELDS } from '@ecloud/shared';
import { ADAPTER_KEYS } from '@ecloud/policy-engine';
import { getAdapter, listCapabilities } from '../registry.js';
import { COMPATIBILITY_ROWS, getCompatibilityRow } from './compatibility.js';
import { FIELD_GROUP, presentCells } from './derive.js';
import { DT_RESULTS } from './dt-results.js';
import { CAPABILITY_GROUPS, type RegistryFact } from './types.js';
import { validateRegistry } from './validate.js';
import { ROADMAP_VENDORS, VENDORS } from './vendors.js';

const row = (key: string) => {
  const r = getCompatibilityRow(key);
  if (!r) throw new Error(`missing row ${key}`);
  return r;
};

describe('compatibility registry data', () => {
  it('passes the V1–V12 validator', () => {
    expect(
      validateRegistry({
        vendors: VENDORS,
        rows: COMPATIBILITY_ROWS,
        dtResults: DT_RESULTS,
        adapters: listCapabilities(),
      }),
    ).toEqual([]);
  });

  it('contains the first-party rows of §7.2 with the planned lifecycles and adapters', () => {
    expect(
      COMPATIBILITY_ROWS.filter((r) => r.adapterKey !== null).map((r) => [
        r.key,
        r.adapterKey,
        r.lifecycle,
      ]),
    ).toEqual([
      ['ezelink-eze-ap1832-r32912-tip-uspot', 'openwifi-uspot-uam', 'implemented'],
      ['ezelink-eze-ap1832-r32912-hostapd-radius', 'openwifi-hostapd-radius', 'implemented'],
      ['ezelink-eze-ap1832-r32912-ucentral-config', 'openwifi-config', 'implemented'],
      ['openwrt-uspot-upstream', 'uspot-upstream-uam', 'implemented'],
      ['coova-chilli-1.2.9-ezegate', 'coovachilli-uam', 'implemented'],
      ['coova-chilli-master', 'coovachilli-uam', 'implemented'],
      ['generic-radius-8021x', 'generic-radius-8021x', 'implemented'],
      ['mikrotik-routeros-hotspot', 'mikrotik-hotspot', 'implemented'],
      ['teltonika-rutos-hotspot', 'coovachilli-uam', 'implemented'],
      ['external-portal-postback', 'external-portal-postback', 'implemented'],
    ]);
    const tip = row('ezelink-eze-ap1832-r32912-tip-uspot');
    expect([tip.deploymentModes, tip.enforcementPoint, tip.sourceVersionMatchesDevice]).toEqual([
      ['native'],
      'ap',
      true,
    ]);
    const gw = row('coova-chilli-1.2.9-ezegate');
    expect([gw.deploymentModes, gw.enforcementPoint, gw.sourceVersionMatchesDevice]).toEqual([
      ['gateway'],
      'gateway',
      false,
    ]);
    for (const key of ADAPTER_KEYS)
      expect(COMPATIBILITY_ROWS.some((r) => r.adapterKey === key)).toBe(true);
  });

  it('implemented rows derive their cells from engine.capabilities() (no drift)', () => {
    for (const r of COMPATIBILITY_ROWS.filter((x) => x.adapterKey !== null)) {
      const caps = getAdapter(r.adapterKey ?? '').capabilities();
      for (const f of POLICY_FIELDS) {
        const c = r.capabilities[FIELD_GROUP[f]].find((x) => x.capability === f);
        expect(c, `${r.key}/${f}`).toBeDefined();
        expect(c?.engineStatus ?? c?.status).toBe(caps.fields[f].status);
        expect(c?.evidenceLevel).toBe(caps.fields[f].evidenceLevel);
      }
      const d = r.capabilities.disconnect;
      expect(d.find((x) => x.capability === 'disconnect')?.status).toBe(caps.disconnect.status);
      expect(d.find((x) => x.capability === 'coaChange')?.status).toBe(caps.coaChange.status);
    }
  });

  it('EZEGATE 1.2.9 presents every engine-verified cell as REQUIRES_DEVICE_TEST (V11); master row keeps them', () => {
    const gw = presentCells(row('coova-chilli-1.2.9-ezegate').capabilities);
    expect(gw.filter((c) => c.status === 'VERIFIED_SUPPORTED')).toEqual([]);
    const overridden = gw.filter((c) => c.engineStatus === 'VERIFIED_SUPPORTED');
    expect(overridden.map((c) => c.capability).sort()).toEqual(
      [
        'download_rate_kbps',
        'upload_rate_kbps',
        'quota_daily_bytes',
        'quota_monthly_bytes',
        'quota_total_bytes',
        'session_timeout_s',
        'idle_timeout_s',
        'macAuth',
      ].sort(),
    );
    for (const c of overridden) {
      expect(c.status).toBe('REQUIRES_DEVICE_TEST');
      expect(c.evidenceLevel).toBe('VERIFIED_FROM_SOURCE');
      expect(c.evidenceRefs.some((r) => r.appliesTo === 'coova-chilli master')).toBe(true);
    }
    const master = presentCells(row('coova-chilli-master').capabilities);
    expect(master.filter((c) => c.status === 'VERIFIED_SUPPORTED')).toHaveLength(8);
    // Engine declaration untouched by the override.
    expect(getAdapter('coovachilli-uam').capabilities().fields.download_rate_kbps.status).toBe(
      'VERIFIED_SUPPORTED',
    );
  });

  it('LAB_VALIDATED appears only for the DT-01 facts of EZE-AP1832 r32912; nothing PRODUCTION_VALIDATED', () => {
    const lab: string[] = [];
    for (const r of COMPATIBILITY_ROWS) {
      for (const f of r.identity)
        if (f.evidenceLevel === 'LAB_VALIDATED') lab.push(`${r.key}#${f.label ?? ''}`);
      for (const [k, f] of Object.entries(r.profile) as [string, RegistryFact][]) {
        expect(f.evidenceLevel).not.toBe('LAB_VALIDATED');
        expect(f.evidenceLevel, k).not.toBe('PRODUCTION_VALIDATED');
      }
      for (const g of CAPABILITY_GROUPS)
        for (const c of r.capabilities[g]) {
          expect(c.evidenceLevel).not.toBe('PRODUCTION_VALIDATED');
          if (c.evidenceLevel === 'LAB_VALIDATED') lab.push(`${r.key}/${c.capability}`);
        }
    }
    expect(lab.sort()).toEqual(
      [
        'ezelink-eze-ap1832-r32912-tip-uspot/apWireguardPeer',
        'ezelink-eze-ap1832-r32912-tip-uspot#sourceVersionMatchesDevice',
        ...[
          'ezelink-eze-ap1832-r32912-tip-uspot',
          'ezelink-eze-ap1832-r32912-hostapd-radius',
          'ezelink-eze-ap1832-r32912-ucentral-config',
        ].flatMap((k) => [
          `${k}#hardwareModel`,
          `${k}#firmware`,
          `${k}#ucentralSchema`,
          `${k}#uspotVariant`,
        ]),
      ].sort(),
    );
    const wg = row('ezelink-eze-ap1832-r32912-tip-uspot').capabilities.configuration.find(
      (c) => c.capability === 'apWireguardPeer',
    );
    expect([wg?.status, wg?.dtRefs]).toEqual(['UNSUPPORTED', ['DT-01']]);
  });

  it('no cell anywhere is presented as device-enforced today (V12)', () => {
    const enforced = COMPATIBILITY_ROWS.flatMap((r) => presentCells(r.capabilities)).filter(
      (c) => c.deviceEnforced,
    );
    expect(enforced).toEqual([]);
  });

  it('DT_RESULTS contains DT-01 only (identification PASS)', () => {
    expect(DT_RESULTS.map((d) => [d.id, d.result, d.rowKey])).toEqual([
      ['DT-01', 'PASS', 'ezelink-eze-ap1832-r32912-tip-uspot'],
    ]);
  });

  it('Cambium is researched only: no adapter, nothing verified, every stated fact cites a §7.3 URL', () => {
    const c = row('cambium-cnpilot-e-external-hotspot');
    expect([c.lifecycle, c.adapterKey, c.hardwareModel, c.firmware]).toEqual([
      'researched',
      null,
      'UNKNOWN',
      'UNKNOWN',
    ]);
    const urls = new Set(
      [...c.identity, ...(Object.values(c.profile) as RegistryFact[])]
        .flatMap((f) => f.evidenceRefs.map((r) => r.url))
        .filter(Boolean),
    );
    for (const u of urls)
      expect(u).toMatch(/^https:\/\/(community\.cambiumnetworks\.com|academy\.socialwifi\.com)\//);
    const cells = presentCells(c.capabilities);
    expect(cells.some((x) => x.status === 'VERIFIED_SUPPORTED')).toBe(false);
    expect(cells.find((x) => x.capability === 'disconnect')?.status).toBe('UNKNOWN');
    expect(cells.find((x) => x.capability === 'quota')?.status).toBe('UNKNOWN');
    expect(c.openItems.map((o) => o.id)).toEqual([
      'OQ-3',
      'OQ-4',
      'OQ-8',
      'OQ-10',
      'OQ-11',
      'OQ-12',
      'OQ-13',
    ]);
  });

  it('23 roadmap vendors; the 21 not promoted (Cycle B: mikrotik, teltonika; Cycle C: generic-postback) are planned with every capability UNKNOWN and no adapter', () => {
    expect(ROADMAP_VENDORS).toHaveLength(23);
    const planned = COMPATIBILITY_ROWS.filter((r) => r.lifecycle === 'planned');
    expect(planned).toHaveLength(21);
    expect(planned.map((r) => r.vendorKey)).not.toContain('mikrotik');
    expect(planned.map((r) => r.vendorKey)).not.toContain('teltonika');
    for (const r of planned) {
      expect(r.adapterKey).toBeNull();
      expect([r.hardwareModel, r.firmware, r.controller]).toEqual(['UNKNOWN', 'UNKNOWN', null]);
      for (const g of CAPABILITY_GROUPS)
        expect(r.capabilities[g].map((c) => c.status)).toEqual(['UNKNOWN']);
      expect((Object.values(r.profile) as RegistryFact[]).every((f) => f.value === 'UNKNOWN')).toBe(
        true,
      );
    }
    for (const v of VENDORS.filter((x) => x.lifecycle === 'planned'))
      expect(v.docLinks).toEqual([]);
  });

  it('third-party rows use engine adapters only where a cycle implemented them (Cycle B: mikrotik, teltonika; Cycle C: generic-postback)', () => {
    const keys = new Set(COMPATIBILITY_ROWS.map((r) => r.adapterKey).filter((k) => k !== null));
    expect([...keys].sort()).toEqual([...ADAPTER_KEYS].sort());
    for (const r of COMPATIBILITY_ROWS)
      if (
        ![
          'ezelink',
          'coova',
          'openwrt',
          'generic-radius',
          'mikrotik',
          'teltonika',
          'generic-postback',
        ].includes(r.vendorKey)
      )
        expect(r.adapterKey).toBeNull();
  });

  it('the generic 802.1X / MAC-auth row claims no device: nothing VERIFIED, no model/firmware', () => {
    const g = row('generic-radius-8021x');
    expect([g.vendorKey, g.hardwareModel, g.firmware, g.deploymentModes]).toEqual([
      'generic-radius',
      'UNKNOWN',
      'UNKNOWN',
      ['native'],
    ]);
    const cells = Object.values(g.capabilities).flat();
    expect(cells.length).toBeGreaterThan(0);
    expect(cells.filter((c) => c.status === 'VERIFIED_SUPPORTED')).toEqual([]);
    expect(cells.filter((c) => c.evidenceLevel === 'LAB_VALIDATED')).toEqual([]);
  });
});
