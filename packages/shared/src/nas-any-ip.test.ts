import { describe, expect, it } from 'vitest';
import { isAnyIpAdapter, pickSharedIdentifierNas } from './nas-any-ip.js';

describe('any NAS IP (D-086)', () => {
  it('only the EZELINK adapters may have no address', () => {
    expect(isAnyIpAdapter('ezeap-uam')).toBe(true);
    expect(isAnyIpAdapter('ezecloud-uam')).toBe(true);
    expect(isAnyIpAdapter('mikrotik-hotspot')).toBe(false);
    expect(isAnyIpAdapter(null)).toBe(false);
  });
  it('rows sharing a NAS-Identifier resolve to the oldest when they are one site', () => {
    const a = { id: 'a', organization_id: 'o1', site_id: 's1' };
    const b = { id: 'b', organization_id: 'o1', site_id: 's1' };
    expect(pickSharedIdentifierNas([a, b])).toBe(a);
    expect(pickSharedIdentifierNas([])).toBeNull();
  });
  it('rows of different sites or organizations are ambiguous', () => {
    const a = { id: 'a', organization_id: 'o1', site_id: 's1' };
    expect(pickSharedIdentifierNas([a, { id: 'b', organization_id: 'o1', site_id: 's2' }])).toBeNull();
    expect(pickSharedIdentifierNas([a, { id: 'c', organization_id: 'o2', site_id: 's1' }])).toBeNull();
  });
});
