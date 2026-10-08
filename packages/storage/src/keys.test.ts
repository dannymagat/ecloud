import { describe, expect, it } from 'vitest';
import { InvalidStorageKeyError } from './errors.js';
import {
  assertKeyInTenant,
  buildObjectKey,
  parseObjectKey,
  parseTenantPrefix,
  tenantPrefix,
} from './keys.js';

const ORG = '0190a6c1-7d2e-7c3b-9a10-2b3c4d5e6f70';
const OTHER = '0190a6c1-7d2e-7c3b-9a10-2b3c4d5e6f71';

describe('buildObjectKey', () => {
  it('builds org/{organizationId}/{purpose}/{id}', () => {
    expect(buildObjectKey({ organizationId: ORG, purpose: 'branding', id: 'logo-1.png' })).toBe(
      `org/${ORG}/branding/logo-1.png`,
    );
  });

  it.each([
    ['..'],
    ['.'],
    ['../x'],
    ['a/b'],
    ['a\\b'],
    ['/abs'],
    ['a\0b'],
    ['a..b'],
    ['.hidden'],
    ['-dash'],
    [''],
    ['a'.repeat(129)],
    ['spa ce'],
    ['%2e%2e'],
    ['ünicode'],
    ['line\nbreak'],
    ['Logo.png'],
    ['logo.PNG'],
  ])('rejects object id %j', (id) => {
    expect(() => buildObjectKey({ organizationId: ORG, purpose: 'branding', id })).toThrow(
      InvalidStorageKeyError,
    );
  });

  it.each([['not-a-uuid'], [ORG.toUpperCase()], [''], ['../' + ORG], [`${ORG}/x`]])(
    'rejects organization id %j',
    (organizationId) => {
      expect(() => buildObjectKey({ organizationId, purpose: 'branding', id: 'a.png' })).toThrow(
        InvalidStorageKeyError,
      );
    },
  );

  it('rejects unknown purposes', () => {
    expect(() =>
      // @ts-expect-error -- runtime guard for untyped callers
      buildObjectKey({ organizationId: ORG, purpose: 'backups', id: 'a' }),
    ).toThrow(InvalidStorageKeyError);
  });
});

describe('parseObjectKey', () => {
  it('splits a valid key', () => {
    expect(parseObjectKey(`org/${ORG}/branding/a.png`)).toEqual({
      key: `org/${ORG}/branding/a.png`,
      organizationId: ORG,
      purpose: 'branding',
      id: 'a.png',
    });
  });

  it.each([
    '',
    '/etc/passwd',
    '../../etc/passwd',
    `/org/${ORG}/branding/a.png`,
    `org/${ORG}/branding/../a.png`,
    `org/${ORG}/branding/a.png/`,
    `org/${ORG}//a.png`,
    `org/${ORG}/branding/sub/a.png`,
    `org/${ORG}/branding/a\0.png`,
    `org\\${ORG}\\branding\\a.png`,
    `C:/org/${ORG}/branding/a.png`,
    `tenant/${ORG}/branding/a.png`,
    `org/${ORG}/branding`,
    `org/${ORG}/branding/${'a'.repeat(600)}`,
  ])('rejects %j', (key) => {
    expect(() => parseObjectKey(key)).toThrow(InvalidStorageKeyError);
  });
});

describe('tenant prefixes', () => {
  it('builds tenant and tenant+purpose prefixes', () => {
    expect(tenantPrefix(ORG)).toBe(`org/${ORG}/`);
    expect(tenantPrefix(ORG, 'branding')).toBe(`org/${ORG}/branding/`);
  });

  it('parses valid prefixes', () => {
    expect(parseTenantPrefix(`org/${ORG}/`)).toEqual({
      prefix: `org/${ORG}/`,
      organizationId: ORG,
      purpose: undefined,
    });
    expect(parseTenantPrefix(`org/${ORG}/branding/`).purpose).toBe('branding');
  });

  it.each([
    '',
    'org/',
    'org',
    `org/${ORG}`,
    `org/${ORG}/branding`,
    `org/${ORG}/../`,
    `/org/${ORG}/`,
    `org/${ORG}/branding/a/`,
    `org/${ORG}/nope/`,
  ])('rejects prefix %j', (prefix) => {
    expect(() => parseTenantPrefix(prefix)).toThrow(InvalidStorageKeyError);
  });

  it('confines keys to their tenant', () => {
    const key = buildObjectKey({ organizationId: ORG, purpose: 'branding', id: 'a.png' });
    expect(assertKeyInTenant(key, ORG)).toBe(key);
    expect(() => assertKeyInTenant(key, OTHER)).toThrow(/outside the tenant prefix/);
    expect(() => assertKeyInTenant(`org/${OTHER}/branding/../../${ORG}/x`, ORG)).toThrow(
      InvalidStorageKeyError,
    );
  });
});
