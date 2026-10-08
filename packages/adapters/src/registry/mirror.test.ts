import { describe, expect, it } from 'vitest';
import { COMPATIBILITY_ROWS } from './compatibility.js';
import {
  adapterCellEvidence,
  canonicalJson,
  deploymentModesForAdapter,
  registryEntryHash,
  registrySnapshotHash,
  REGISTRY_SNAPSHOT,
} from './mirror.js';
import { VENDORS } from './vendors.js';
import { listAdapters } from '../registry.js';
import { POLICY_FIELDS } from '@ecloud/shared';

describe('registry mirror helpers (plan §8.2)', () => {
  it('canonical JSON sorts keys, drops undefined and survives a jsonb-style round trip', () => {
    expect(canonicalJson({ b: 1, a: { d: undefined, c: [2, 1] } })).toBe('{"a":{"c":[2,1]},"b":1}');
    for (const entry of [...VENDORS, ...COMPATIBILITY_ROWS]) {
      const roundTripped = JSON.parse(JSON.stringify(entry)) as typeof entry;
      expect(registryEntryHash(roundTripped)).toBe(registryEntryHash(entry));
    }
  });

  it('snapshot hash is order independent and changes with any cell', () => {
    const h = registrySnapshotHash();
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(
      registrySnapshotHash({
        vendors: [...REGISTRY_SNAPSHOT.vendors].reverse(),
        rows: [...REGISTRY_SNAPSHOT.rows].reverse(),
      }),
    ).toBe(h);
    const [first, ...rest] = REGISTRY_SNAPSHOT.rows;
    if (first === undefined) throw new Error('empty registry');
    const tampered = { ...first, lifecycle: 'lab-validated' as const };
    expect(registrySnapshotHash({ vendors: VENDORS, rows: [tampered, ...rest] })).not.toBe(h);
  });

  it('deployment modes come from the registry rows of each engine adapter', () => {
    expect(deploymentModesForAdapter('coovachilli-uam')).toEqual(['gateway']);
    expect(deploymentModesForAdapter('openwifi-uspot-uam')).toEqual(['native']);
    expect(deploymentModesForAdapter('no-such-adapter')).toEqual([]);
  });

  it('every engine adapter cell has registry evidence and none is device-enforced today', () => {
    for (const adapter of listAdapters()) {
      const key = adapter.capabilities().key;
      for (const capability of [...POLICY_FIELDS, 'disconnect', 'coaChange', 'macAuth']) {
        const e = adapterCellEvidence(key, capability);
        expect(e, `${key} ${capability}`).toBeDefined();
        expect(e?.evidenceLevel, `${key} ${capability}`).not.toBeNull();
        expect(e?.deviceEnforced).toBe(false);
      }
    }
    expect(adapterCellEvidence('openwifi-uspot-uam', 'no-such-capability')).toBeUndefined();
  });
});
