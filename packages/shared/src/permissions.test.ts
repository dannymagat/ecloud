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
      controller: 5, // migration 019 (MULTI_VENDOR_INTEGRATION_PLAN.md §8.2)
      compatibility: 1,
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
      captive_portal: 5, // + secret:rotate (P6-B)
      portal_theme: 4,
      portal_asset: 3, // migration 021 (P6-B)
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

describe('multi-vendor keys (MULTI_VENDOR_INTEGRATION_PLAN.md §8.2)', () => {
  it('adds controller:* and compatibility:read with the documented scopes', () => {
    expect(
      PERMISSION_CATALOGUE.filter((p) => p.resource === 'controller').map((p) => p.key),
    ).toEqual([
      'controller:read',
      'controller:create',
      'controller:update',
      'controller:delete',
      'controller:secret:rotate',
    ]);
    expect(getPermission('controller:read')).toMatchObject({
      minScope: 'site',
      platformOnly: false,
    });
    for (const key of ['controller:create', 'controller:update', 'controller:delete'] as const) {
      expect(getPermission(key)).toMatchObject({ minScope: 'organization', platformOnly: false });
    }
    expect(getPermission('controller:secret:rotate')).toMatchObject({
      minScope: 'organization',
      platformOnly: false,
    });
    expect(getPermission('compatibility:read')).toMatchObject({
      minScope: 'organization',
      platformOnly: false,
    });
  });

  it('grants them to the templates exactly as §8.2 lists', () => {
    const newKeys = [
      'controller:read',
      'controller:create',
      'controller:update',
      'controller:delete',
      'controller:secret:rotate',
      'compatibility:read',
    ];
    const held = (template: Parameters<typeof getRoleTemplate>[0]) =>
      newKeys.filter((k) => getRoleTemplate(template).permissions.includes(k as never));
    expect(held('platform_super_admin')).toEqual(newKeys);
    expect(held('org_admin')).toEqual(newKeys);
    for (const template of ['site_admin', 'operator', 'read_only', 'platform_support'] as const) {
      expect(held(template), template).toEqual(['controller:read', 'compatibility:read']);
    }
  });
});

describe('portal administration keys (Phase 6 P6-B, migration 021)', () => {
  const portalKeys = PERMISSION_CATALOGUE.filter((p) =>
    ['captive_portal', 'portal_theme', 'portal_asset'].includes(p.resource),
  ).map((p) => p.key);

  it('catalogues portal_asset:{read,create,delete} at organization scope', () => {
    expect(
      PERMISSION_CATALOGUE.filter((p) => p.resource === 'portal_asset').map((p) => p.key),
    ).toEqual(['portal_asset:read', 'portal_asset:create', 'portal_asset:delete']);
    for (const p of PERMISSION_CATALOGUE.filter((d) => d.resource === 'portal_asset')) {
      expect(p).toMatchObject({ minScope: 'organization', platformOnly: false });
    }
  });

  it('grants every portal key to org_admin and platform_super_admin', () => {
    expect(portalKeys).toHaveLength(12);
    for (const template of ['org_admin', 'platform_super_admin'] as const) {
      expect(getRoleTemplate(template).permissions, template).toEqual(
        expect.arrayContaining(portalKeys),
      );
    }
  });

  it('keeps operator, read_only and platform_support read-only on portals', () => {
    for (const template of ['operator', 'read_only', 'platform_support'] as const) {
      const held = portalKeys.filter((k) => getRoleTemplate(template).permissions.includes(k));
      expect(held, template).toEqual([
        'captive_portal:read',
        'portal_theme:read',
        'portal_asset:read',
      ]);
    }
  });

  it('reserves captive_portal:secret:rotate for org_admin and platform_super_admin', () => {
    expect(getPermission('captive_portal:secret:rotate')).toMatchObject({
      minScope: 'organization',
      platformOnly: false,
    });
    const holders = ROLE_TEMPLATES.filter((t) =>
      t.permissions.includes('captive_portal:secret:rotate'),
    ).map((t) => t.key);
    expect(holders.sort()).toEqual(['org_admin', 'platform_super_admin']);
  });

  it('leaves site_admin with captive_portal read/update only (themes/assets are organization-level)', () => {
    const held = portalKeys.filter((k) => getRoleTemplate('site_admin').permissions.includes(k));
    expect(held).toEqual(['captive_portal:read', 'captive_portal:update']);
  });
});
