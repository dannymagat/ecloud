import { getRoleTemplate } from '@ecloud/shared';
import { describe, expect, it } from 'vitest';
import type { Grant, Principal } from '../context.js';
import { assertPermissionKey, evaluate, holdsAll, permittedSites } from './authorize.js';

const ORG_A = '01900000-0000-7000-8000-00000000000a';
const ORG_B = '01900000-0000-7000-8000-00000000000b';
const SITE_A1 = '01900000-0000-7000-8000-0000000000a1';
const SITE_A2 = '01900000-0000-7000-8000-0000000000a2';

function grant(
  template: Parameters<typeof getRoleTemplate>[0],
  scopeType: Grant['scopeType'],
  organizationId: string | null = null,
  siteId: string | null = null,
): Grant {
  return {
    bindingId: `${template}-${scopeType}-${organizationId ?? ''}-${siteId ?? ''}`,
    roleId: template,
    scopeType,
    organizationId,
    siteId,
    permissions: new Set(getRoleTemplate(template).permissions),
  };
}

function admin(grants: Grant[], impersonating?: string): Principal {
  return {
    kind: 'admin',
    administratorId: 'admin',
    email: 'a@example.test',
    sessionId: 's',
    impersonation: impersonating
      ? {
          organizationId: impersonating,
          reason: 'ticket',
          expiresAt: new Date(Date.now() + 60_000),
        }
      : null,
    grants,
  };
}

describe('evaluate (MULTITENANCY.md §4.4)', () => {
  it('denies by default (no principal, no grant, unknown permission)', () => {
    expect(evaluate(null, 'site:read', { organizationId: ORG_A })).toBe(false);
    expect(evaluate(admin([]), 'site:read', { organizationId: ORG_A })).toBe(false);
    const orgAdmin = admin([grant('org_admin', 'organization', ORG_A)]);
    expect(evaluate(orgAdmin, 'site:fly', { organizationId: ORG_A })).toBe(false);
  });

  it('organization binding covers its organization and its sites only', () => {
    const p = admin([grant('org_admin', 'organization', ORG_A)]);
    expect(evaluate(p, 'site:update', { organizationId: ORG_A })).toBe(true);
    expect(evaluate(p, 'site:update', { organizationId: ORG_A, siteId: SITE_A1 })).toBe(true);
    expect(evaluate(p, 'site:update', { organizationId: ORG_B })).toBe(false);
  });

  it('site binding covers only that site (and any-site pre-checks)', () => {
    const p = admin([grant('site_admin', 'site', ORG_A, SITE_A1)]);
    expect(evaluate(p, 'user:create', { organizationId: ORG_A, siteId: SITE_A1 })).toBe(true);
    expect(evaluate(p, 'user:create', { organizationId: ORG_A, siteId: SITE_A2 })).toBe(false);
    expect(evaluate(p, 'user:create', { organizationId: ORG_A })).toBe(false);
    expect(evaluate(p, 'user:create', { organizationId: ORG_A, anySite: true })).toBe(true);
    expect(permittedSites(p, 'user:read', ORG_A)).toEqual([SITE_A1]);
    expect(permittedSites(p, 'user:read', ORG_B)).toEqual([]);
  });

  it('platform-only keys need a platform binding', () => {
    const fake: Grant = {
      ...grant('org_admin', 'organization', ORG_A),
      permissions: new Set(['tenant:list']),
    };
    expect(evaluate(admin([fake]), 'tenant:list', {})).toBe(false);
    const support = admin([grant('platform_support', 'platform')]);
    expect(evaluate(support, 'tenant:list', {})).toBe(true);
    expect(evaluate(support, 'site:read', { organizationId: ORG_B })).toBe(true);
    expect(evaluate(support, 'site:update', { organizationId: ORG_B })).toBe(false);
  });

  it('impersonation pins the target organization and disables platform keys', () => {
    const p = admin([grant('org_admin', 'organization', ORG_A)], ORG_A);
    expect(evaluate(p, 'site:update', { organizationId: ORG_A })).toBe(true);
    expect(evaluate(p, 'site:update', { organizationId: ORG_B })).toBe(false);
    expect(evaluate(p, 'tenant:list', {})).toBe(false);
    expect(permittedSites(p, 'site:read', ORG_B)).toEqual([]);
  });

  it('holdsAll prevents granting permissions the granter lacks', () => {
    const siteAdmin = admin([grant('site_admin', 'site', ORG_A, SITE_A1)]);
    const operator = getRoleTemplate('operator').permissions;
    const orgAdmin = getRoleTemplate('org_admin').permissions;
    expect(holdsAll(siteAdmin, ['user:read'], { organizationId: ORG_A, siteId: SITE_A1 })).toBe(
      true,
    );
    expect(holdsAll(siteAdmin, operator, { organizationId: ORG_A, siteId: SITE_A1 })).toBe(false);
    expect(holdsAll(siteAdmin, orgAdmin, { organizationId: ORG_A, siteId: SITE_A1 })).toBe(false);
  });

  it('route definitions refuse unknown permission keys at boot', () => {
    expect(() => assertPermissionKey('site:read')).not.toThrow();
    expect(() => assertPermissionKey('site:explode')).toThrow(/unknown permission key/);
  });
});
