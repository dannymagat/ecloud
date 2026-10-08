/**
 * Evidence levels of the five engine adapters (MULTI_VENDOR_INTEGRATION_PLAN.md §4.2, §8.1 AC4).
 * Additive to capabilities.test.ts (whose expected values are unchanged).
 */
import { describe, expect, it } from 'vitest';
import { EVIDENCE_LEVELS, POLICY_FIELDS, isEvidenceLevel } from '@ecloud/shared';
import type { AdapterCapabilities, AdapterFlag } from '@ecloud/policy-engine';
import { listCapabilities } from './registry.js';

function flags(caps: AdapterCapabilities): [string, AdapterFlag][] {
  return [
    ...POLICY_FIELDS.map((f): [string, AdapterFlag] => [`fields.${f}`, caps.fields[f]]),
    ['disconnect', caps.disconnect],
    ['coaChange', caps.coaChange],
    ['macAuth', caps.macAuth],
    ...Object.entries(caps.attributes).map(([n, a]): [string, AdapterFlag] => [
      `attributes.${n}`,
      a,
    ]),
  ];
}

const all = listCapabilities().flatMap((c) =>
  flags(c).map(([name, f]) => ({ key: c.key, name, f })),
);

/** Back-fill table: verified cell → V-row(s) of PHASE2_VALIDATION.md (plan §4.2, V10). */
const BACKFILL: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> = {
  'openwifi-uspot-uam': {
    'fields.download_rate_kbps': ['V-052', 'V-053'],
    'fields.upload_rate_kbps': ['V-052', 'V-053'],
    'fields.quota_daily_bytes': ['V-054'],
    'fields.quota_monthly_bytes': ['V-054'],
    'fields.quota_total_bytes': ['V-054'],
    'fields.session_timeout_s': ['V-050'],
    'fields.idle_timeout_s': ['V-050'],
    macAuth: ['V-061'],
    'attributes.WISPr-Bandwidth-Max-Down': ['V-052', 'V-053'],
    'attributes.WISPr-Bandwidth-Max-Up': ['V-052', 'V-053'],
    'attributes.ChilliSpot-Bandwidth-Max-Down': ['V-052', 'V-053'],
    'attributes.ChilliSpot-Bandwidth-Max-Up': ['V-052', 'V-053'],
    'attributes.ChilliSpot-Max-Total-Octets': ['V-054'],
    'attributes.Session-Timeout': ['V-050'],
    'attributes.Idle-Timeout': ['V-050'],
    'attributes.Acct-Interim-Interval': ['V-051'],
    'attributes.Class': ['V-056'],
  },
  'uspot-upstream-uam': {
    'fields.download_rate_kbps': ['V-053'],
    'fields.upload_rate_kbps': ['V-053'],
    'fields.quota_daily_bytes': ['V-054'],
    'fields.quota_monthly_bytes': ['V-054'],
    'fields.quota_total_bytes': ['V-054'],
    'fields.session_timeout_s': ['V-050'],
    'fields.idle_timeout_s': ['V-050'],
    macAuth: ['V-147'],
    'attributes.WISPr-Bandwidth-Max-Down': ['V-053'],
    'attributes.WISPr-Bandwidth-Max-Up': ['V-053'],
    'attributes.ChilliSpot-Bandwidth-Max-Down': ['V-053'],
    'attributes.ChilliSpot-Bandwidth-Max-Up': ['V-053'],
    'attributes.ChilliSpot-Max-Total-Octets': ['V-054'],
    'attributes.ChilliSpot-Max-Total-Gigawords': ['V-054'],
    'attributes.ChilliSpot-Max-Input-Octets': ['V-054'],
    'attributes.ChilliSpot-Max-Input-Gigawords': ['V-054'],
    'attributes.ChilliSpot-Max-Output-Octets': ['V-054'],
    'attributes.ChilliSpot-Max-Output-Gigawords': ['V-054'],
    'attributes.Session-Timeout': ['V-050'],
    'attributes.Idle-Timeout': ['V-050'],
    'attributes.Acct-Interim-Interval': ['V-146'],
    'attributes.Class': ['V-056'],
  },
  'coovachilli-uam': {
    'fields.download_rate_kbps': ['V-073'],
    'fields.upload_rate_kbps': ['V-073'],
    'fields.quota_daily_bytes': ['V-073'],
    'fields.quota_monthly_bytes': ['V-073'],
    'fields.quota_total_bytes': ['V-073'],
    'fields.session_timeout_s': ['V-073'],
    'fields.idle_timeout_s': ['V-073'],
    macAuth: ['V-148'],
    'attributes.WISPr-Bandwidth-Max-Down': ['V-073'],
    'attributes.WISPr-Bandwidth-Max-Up': ['V-073'],
    'attributes.CoovaChilli-Bandwidth-Max-Down': ['V-073'],
    'attributes.CoovaChilli-Bandwidth-Max-Up': ['V-073'],
    'attributes.CoovaChilli-Max-Total-Octets': ['V-073'],
    'attributes.CoovaChilli-Max-Total-Gigawords': ['V-073'],
    'attributes.CoovaChilli-Max-Input-Octets': ['V-073'],
    'attributes.CoovaChilli-Max-Input-Gigawords': ['V-073'],
    'attributes.CoovaChilli-Max-Output-Octets': ['V-073'],
    'attributes.CoovaChilli-Max-Output-Gigawords': ['V-073'],
    'attributes.Session-Timeout': ['V-073'],
    'attributes.WISPr-Session-Terminate-Time': ['V-073'],
    'attributes.Idle-Timeout': ['V-073'],
    'attributes.Acct-Interim-Interval': ['V-073'],
    'attributes.Class': ['V-073'],
    'attributes.CoovaChilli-Session-State': ['V-074'],
    'attributes.WISPr-Redirection-URL': ['V-073'],
  },
  'openwifi-config': {
    'fields.download_rate_kbps': ['V-001'],
    'fields.upload_rate_kbps': ['V-001'],
    'fields.session_timeout_s': ['no dedicated V-row'],
    'fields.idle_timeout_s': ['V-006'],
    macAuth: ['V-012'],
  },
  'openwifi-hostapd-radius': {},
};

describe('evidence levels (plan §4.2)', () => {
  it('every declaration carries a valid evidenceLevel', () => {
    expect([...EVIDENCE_LEVELS]).toEqual([
      'DOCUMENTED',
      'VERIFIED_FROM_SOURCE',
      'SIMULATOR_TESTED',
      'LAB_VALIDATED',
      'PRODUCTION_VALIDATED',
    ]);
    for (const { key, name, f } of all)
      expect(isEvidenceLevel(f.evidenceLevel), `${key}/${name}`).toBe(true);
  });

  it('29 verified cells (25 fields + 4 macAuth) and 40 verified attributes, all VERIFIED_FROM_SOURCE', () => {
    const verified = all.filter((c) => c.f.status === 'VERIFIED_SUPPORTED');
    const cells = verified.filter((c) => !c.name.startsWith('attributes.'));
    const attrs = verified.filter((c) => c.name.startsWith('attributes.'));
    expect(cells).toHaveLength(29);
    expect(cells.filter((c) => c.name === 'macAuth')).toHaveLength(4);
    expect(attrs).toHaveLength(40);
    for (const c of verified)
      expect(c.f.evidenceLevel, `${c.key}/${c.name}`).toBe('VERIFIED_FROM_SOURCE');
  });

  it('every verified declaration is back-filled with the expected V-row source refs (V10)', () => {
    const verified = all.filter((c) => c.f.status === 'VERIFIED_SUPPORTED');
    const expected = Object.entries(BACKFILL).flatMap(([k, m]) =>
      Object.keys(m).map((n) => `${k}/${n}`),
    );
    expect(verified.map((c) => `${c.key}/${c.name}`).sort()).toEqual(expected.sort());
    for (const c of verified) {
      const refs = (c.f.evidenceRefs ?? []).filter((r) => r.kind === 'source');
      expect(refs.length, `${c.key}/${c.name}`).toBeGreaterThan(0);
      for (const r of refs) expect(r.appliesTo, `${c.key}/${c.name}`).toBeTruthy();
      const want = BACKFILL[c.key]?.[c.name] ?? [];
      for (const v of want)
        expect(
          refs.some((r) => r.ref.startsWith(v)),
          `${c.key}/${c.name} cites ${v}`,
        ).toBe(true);
    }
  });

  it('VERIFIED_FROM_SOURCE everywhere has a source ref; nothing in adapters is LAB/PRODUCTION/SIMULATOR', () => {
    for (const { key, name, f } of all) {
      if (f.evidenceLevel === 'VERIFIED_FROM_SOURCE')
        expect(
          (f.evidenceRefs ?? []).some((r) => r.kind === 'source'),
          `${key}/${name}`,
        ).toBe(true);
      expect(['LAB_VALIDATED', 'PRODUCTION_VALIDATED', 'SIMULATOR_TESTED']).not.toContain(
        f.evidenceLevel,
      );
    }
  });

  it('REQUIRES_DEVICE_TEST and ECLOUD_SIDE_ONLY declarations are DOCUMENTED (plan §4.2 defaults)', () => {
    for (const { key, name, f } of all)
      if (f.status === 'REQUIRES_DEVICE_TEST' || f.status === 'ECLOUD_SIDE_ONLY')
        expect(f.evidenceLevel, `${key}/${name}`).toBe('DOCUMENTED');
  });

  it('coova-chilli source evidence is scoped to upstream master (EZEGATE runs 1.2.9)', () => {
    for (const { key, f } of all)
      if (key === 'coovachilli-uam' && f.evidenceLevel === 'VERIFIED_FROM_SOURCE')
        for (const r of f.evidenceRefs ?? []) expect(r.appliesTo).toBe('coova-chilli master');
  });

  it('D-006: Disconnect / CoA are never VERIFIED_SUPPORTED', () => {
    for (const caps of listCapabilities()) {
      expect(caps.disconnect.status).not.toBe('VERIFIED_SUPPORTED');
      expect(caps.coaChange.status).not.toBe('VERIFIED_SUPPORTED');
    }
  });
});
