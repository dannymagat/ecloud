import * as shared from '@ecloud/shared';
import { describe, expect, it } from 'vitest';
import { MAC_ADDRESS_RULE, canonicalUnicastMac } from './mac';

describe('client MAC rule mirrors @ecloud/shared', () => {
  it.each([
    'AA-BB-CC-DD-EE-FF',
    'aa:bb:cc:dd:ee:f0',
    '02aa.bbcc.ddee',
    '02AABBCCDDEE',
    '01:00:5e:00:00:01',
    'ff:ff:ff:ff:ff:ff',
    '00:00:00:00:00:00',
    'aa:bb-cc:dd:ee:ff',
    'mac aabbccddeeff',
    '',
  ])('%s', (value) => {
    expect(canonicalUnicastMac(value)).toBe(shared.canonicalUnicastMac(value));
  });
  it('same rule text', () => expect(MAC_ADDRESS_RULE).toBe(shared.MAC_ADDRESS_RULE));
});
