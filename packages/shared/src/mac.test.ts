import { describe, expect, it } from 'vitest';
import { canonicalMacStrict, canonicalUnicastMac, isUnicastMac } from './mac.js';

describe('canonicalMacStrict', () => {
  it.each([
    ['AA:BB:CC:DD:EE:FF', 'aa:bb:cc:dd:ee:ff'],
    ['aa-bb-cc-dd-ee-ff', 'aa:bb:cc:dd:ee:ff'],
    ['AABB.CCDD.EEFF', 'aa:bb:cc:dd:ee:ff'],
    ['aabbccddeeff', 'aa:bb:cc:dd:ee:ff'],
    ['  00:11:22:33:44:55 ', '00:11:22:33:44:55'],
  ])('%s -> %s', (input, expected) => {
    expect(canonicalMacStrict(input)).toBe(expected);
  });

  it.each([
    'aa:bb-cc:dd:ee:ff',
    'aa:bb:cc:dd:ee',
    'aa:bb:cc:dd:ee:ff:00',
    'gg:bb:cc:dd:ee:ff',
    'user-aabbccddeeff',
    'aabb.ccdd.eef',
    'aa:bb:cc:dd:ee:f',
    '',
  ])('refuses %s', (input) => {
    expect(canonicalMacStrict(input)).toBeNull();
  });

  it('refuses non-strings', () => {
    expect(canonicalMacStrict(null)).toBeNull();
    expect(canonicalMacStrict(undefined)).toBeNull();
  });
});

describe('isUnicastMac / canonicalUnicastMac', () => {
  it('accepts individual and locally administered addresses', () => {
    expect(isUnicastMac('00:11:22:33:44:55')).toBe(true);
    expect(isUnicastMac('02:11:22:33:44:55')).toBe(true);
  });
  it('refuses zero, broadcast and multicast', () => {
    expect(isUnicastMac('00:00:00:00:00:00')).toBe(false);
    expect(isUnicastMac('ff:ff:ff:ff:ff:ff')).toBe(false);
    expect(isUnicastMac('01:00:5e:00:00:01')).toBe(false);
    expect(canonicalUnicastMac('33-33-00-00-00-01')).toBeNull();
    expect(canonicalUnicastMac('AA-BB-CC-DD-EE-FF')).toBe('aa:bb:cc:dd:ee:ff');
  });
});
