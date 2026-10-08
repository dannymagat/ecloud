import { describe, expect, it } from 'vitest';
import {
  PERMISSION_CATALOGUE,
  PERMISSION_KEYS,
  ROLE_TEMPLATES,
  ROLE_TEMPLATE_KEYS,
  getPermission,
  getRoleTemplate,
  isKnownPermission,
  isPermissionKey,
  normalizePermissionKey,
} from './permissions.js';

describe('isPermissionKey', () => {
  it('accepts canonical resource:action keys', () => {
    for (const key of ['organization:read', 'session:disconnect', 'platform:settings:update']) {
      expect(isPermissionKey(key)).toBe(true);
    }
  });

  it('rejects malformed keys', () => {
    for (const key of [
      '',
      'read',
      'Organization:Read',
      'org:',
      ':read',
      'a::b',
      'a:b ',
      'a.b',
      7,
    ]) {
      expect(isPermissionKey(key)).toBe(false);
    }
  });

  it('normalizes the precedent dotted form', () => {
    expect(normalizePermissionKey('device.read')).toBe('device:read');
    expect(normalizePermissionKey(' nas:update ')).toBe('nas:update');
    expect(normalizePermissionKey('bad key')).toBeUndefined();
  });
});

describe('PERMISSION_CATALOGUE', () => {
  it('contains unique, well-formed keys matching resource/action', () => {
    expect(new Set(PERMISSION_KEYS).size).toBe(PERMISSION_CATALOGUE.length);
    for (const p of PERMISSION_CATALOGUE) {
      expect(isPermissionKey(p.key)).toBe(true);
      expect(p.key).toBe(`${p.resource}:${p.action}`);
      expect(p.description.length).toBeGreaterThan(0);
    }
  });

  it('covers every resource of MULTITENANCY.md §4.2 with the documented action counts', () => {
    const counts = new Map<string, number>();
    for (const p of PERMISSION_CATALOGUE) counts.set(p.resource, (counts.get(p.resource) ?? 0) + 1);
    expect(Object.fromEntries(counts)).toEqual({
      organization: 6,
      site: 4,
      network_device: 5,
      nas: 5,
      wireguard_peer: 5,
      administrator: 7, // + mfa_reset (D-038)
      role: 4,
      user: 7,
      user_group: 4,
      client_device: 5,
      policy: 5,
      policy_assignment: 3,
      voucher: 5,
      session: 3,
      accounting: 2,
      report: 2,
      captive_portal: 4,
      portal_theme: 4,
      identity_provider: 4,
      api_key: 3,
      webhook: 4,
      audit_log: 2,
      tenant: 2,
      platform: 4,
    });
    expect(PERMISSION_CATALOGUE.length).toBeGreaterThanOrEqual(60);
  });

  it('marks platform-only keys and scope overrides as documented', () => {
    expect(getPermission('organization:create')).toMatchObject({
      minScope: 'platform',
      platformOnly: true,
    });
    expect(getPermission('organization:read')).toMatchObject({
      minScope: 'organization',
      platformOnly: false,
    });
    expect(getPermission('site:create')?.minScope).toBe('organization');
    // D-038: MFA reset is platform-only, held by platform_super_admin, never by tenant roles.
    expect(getPermission('administrator:mfa_reset')).toMatchObject({
      minScope: 'platform',
      platformOnly: true,
    });
    expect(getRoleTemplate('platform_super_admin').permissions).toContain(
      'administrator:mfa_reset',
    );
    expect(getRoleTemplate('org_admin').permissions).not.toContain('administrator:mfa_reset');
    expect(getRoleTemplate('platform_support').permissions).not.toContain(
      'administrator:mfa_reset',
    );
    expect(getPermission('site:read')?.minScope).toBe('site');
    for (const p of PERMISSION_CATALOGUE.filter((x) => x.platformOnly)) {
      expect(p.minScope).toBe('platform');
    }
    expect(
      PERMISSION_CATALOGUE.filter((p) => p.resource === 'tenant').every((p) => p.platformOnly),
    ).toBe(true);
    expect(isKnownPermission('voucher:reveal')).toBe(true);
    expect(isKnownPermission('voucher:fly')).toBe(false);
  });
});

describe('ROLE_TEMPLATES', () => {
  it('defines exactly the six owner roles with known permissions only', () => {
    expect(ROLE_TEMPLATES.map((t) => t.key)).toEqual([...ROLE_TEMPLATE_KEYS]);
    for (const template of ROLE_TEMPLATES) {
      expect(new Set(template.permissions).size).toBe(template.permissions.length);
      for (const key of template.permissions) expect(isKnownPermission(key)).toBe(true);
    }
  });

  it('platform_super_admin holds every key; org_admin holds every non-platform key', () => {
    expect([...getRoleTemplate('platform_super_admin').permissions].sort()).toEqual(
      [...PERMISSION_KEYS].sort(),
    );
    const orgAdmin = getRoleTemplate('org_admin');
    expect(orgAdmin.permissions.some((k) => getPermission(k)?.platformOnly)).toBe(false);
    expect(orgAdmin.permissions).toContain('organization:read');
    expect(orgAdmin.permissions).not.toContain('organization:create');
  });

  it('platform_support is read + support actions only', () => {
    const support = getRoleTemplate('platform_support');
    expect(support.permissions).toContain('tenant:impersonate');
    expect(support.permissions).toContain('session:disconnect');
    expect(support.permissions).toContain('audit_log:export');
    expect(support.permissions).toContain('platform:health:read');
    expect(support.permissions).not.toContain('nas:update');
    expect(support.permissions).not.toContain('policy:create');
  });

  it('site_admin, operator and read_only match §4.3', () => {
    const siteAdmin = getRoleTemplate('site_admin');
    expect(siteAdmin.permissions).toContain('session:coa');
    expect(siteAdmin.permissions).toContain('voucher:export');
    expect(siteAdmin.permissions).not.toContain('voucher:reveal');
    expect(siteAdmin.permissions).not.toContain('site:create');
    expect(siteAdmin.permissions).not.toContain('nas:update');

    const operator = getRoleTemplate('operator');
    expect(operator.permissions).toContain('user:password:reset');
    expect(operator.permissions).toContain('client_device:block');
    expect(operator.permissions).not.toContain('user:delete');
    expect(operator.permissions).not.toContain('voucher:revoke');

    const readOnly = getRoleTemplate('read_only');
    expect(readOnly.permissions.every((k) => getPermission(k)?.action === 'read')).toBe(true);
    expect(readOnly.permissions).not.toContain('voucher:reveal');
    expect(readOnly.permissions).not.toContain('audit_log:export');
    expect(readOnly.permissions.some((k) => getPermission(k)?.platformOnly)).toBe(false);
  });
});
