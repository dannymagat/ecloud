// @vitest-environment node
import {
  ADAPTER_FIELD_STATUSES as SHARED_STATUSES,
  EVIDENCE_LEVELS as SHARED_EVIDENCE_LEVELS,
  POLICY_FIELDS as SHARED_FIELDS,
  PERMISSION_KEYS,
  isDeviceEnforced,
} from '@ecloud/shared';
import { describe, expect, it } from 'vitest';
import { adminMe, orgScope, ORG_A, ORG_B, platformScope } from '../test/fixtures';
import { MFA_RESET_PERMISSION } from '../features/platform/PlatformAdministratorsPage';
import {
  ADAPTER_FIELD_STATUSES,
  EVIDENCE_LEVELS,
  POLICY_FIELDS,
  presentStatus,
} from './adapterStatus';
import {
  groupKeyOf,
  navLabel,
  ORG_GROUPS,
  ORG_NAV,
  PLATFORM_NAV,
  visibleOrgGroups,
  visibleOrgNav,
  visiblePlatformGroup,
  visiblePlatformNav,
} from './nav';
import { can, canPlatform, organizationIdsOf } from './permissions';

describe('permission-driven navigation', () => {
  it('shows only entries whose permission is granted in that organization', () => {
    const me = adminMe([orgScope(ORG_A, ['site:read', 'nas:read'])]);
    expect(visibleOrgNav(me, ORG_A).map((i) => i.path)).toEqual([
      'dashboard',
      'sites',
      'nas',
      'access-points',
    ]);
    expect(visibleOrgNav(me, ORG_B)).toEqual([]);
    expect(visiblePlatformNav(me)).toEqual([]);
  });

  it('report:read reveals the dashboard and reports; platform:health:read the platform summary', () => {
    const me = adminMe([orgScope(ORG_A, ['report:read'])]);
    expect(visibleOrgNav(me, ORG_A).map((i) => i.path)).toEqual(['dashboard', 'reports']);
    const platform = adminMe([platformScope(['platform:health:read'])]);
    expect(visiblePlatformNav(platform).map((i) => i.path)).toEqual(['summary', 'adapters']);
  });

  it('never looks at role names: identical permissions give identical menus', () => {
    const a = adminMe([orgScope(ORG_A, ['session:read'])]);
    const b = adminMe([orgScope(ORG_A, ['session:read'])], {
      bindings: [
        {
          id: 'b',
          scope_type: 'organization',
          organization_id: ORG_A,
          site_id: null,
          expires_at: null,
          role_id: 'r',
          role_key: 'org_admin',
          role_name: 'Organization Admin',
        },
      ],
    });
    expect(visibleOrgNav(b, ORG_A)).toEqual(visibleOrgNav(a, ORG_A));
  });

  it('site bindings reveal org screens (lists are filtered server-side)', () => {
    const me = adminMe([
      { scope_type: 'site', organization_id: ORG_A, site_id: 's1', permissions: ['user:read'] },
    ]);
    expect(visibleOrgNav(me, ORG_A).map((i) => i.path)).toEqual(['dashboard', 'users']);
    expect(can(me, 'user:read', { organizationId: ORG_A })).toBe(false);
    expect(can(me, 'user:read', { organizationId: ORG_A, siteId: 's1' })).toBe(true);
  });

  it('platform bindings cover every organization and reveal the platform menu', () => {
    const me = adminMe([platformScope(['tenant:list', 'platform:health:read', 'site:read'])]);
    expect(visiblePlatformNav(me).map((i) => i.path)).toEqual([
      'summary',
      'organizations',
      'adapters',
    ]);
    expect(can(me, 'site:read', { organizationId: ORG_B })).toBe(true);
  });

  it('impersonation pins one organization and hides platform actions', () => {
    const me = adminMe([orgScope(ORG_A, ['site:read'])], {
      impersonation: {
        organization_id: ORG_A,
        reason: 'ticket 1',
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      },
    });
    expect(can(me, 'site:read', { organizationId: ORG_A })).toBe(true);
    expect(can(me, 'site:read', { organizationId: ORG_B })).toBe(false);
    expect(
      canPlatform(
        adminMe([platformScope(['tenant:list'])], { impersonation: me.impersonation }),
        'tenant:list',
      ),
    ).toBe(false);
    expect(organizationIdsOf(me)).toEqual([ORG_A]);
  });

  it('groups follow the approved sidebar; empty groups are hidden', () => {
    expect(ORG_GROUPS.map((g) => [g.label, g.items.map((i) => i.path)])).toEqual([
      ['Bandwidth Management', ['policies', 'policy-assignments', 'ssid-rate-limit-export']],
      ['Network', ['sites', 'nas', 'access-points', 'controllers', 'network-devices']],
      ['Clients', ['sessions', 'users', 'user-groups', 'client-devices', 'vouchers']],
      ['Reports', ['usage', 'accounting', 'reports']],
      ['Login Page', ['portals']],
      ['Management', ['administrators', 'api-keys', 'audit-log']],
    ]);
    const me = adminMe([orgScope(ORG_A, ['nas:read', 'accounting:read'])]);
    expect(visibleOrgGroups(me, ORG_A).map((g) => [g.key, g.items.map((i) => i.path)])).toEqual([
      ['network', ['nas', 'access-points']],
      ['reports', ['usage', 'accounting']],
    ]);
    expect(visibleOrgGroups(me, ORG_B)).toEqual([]);
    expect(visiblePlatformGroup(me)).toBeNull();
    expect(
      visiblePlatformGroup(adminMe([platformScope(['tenant:list'])]))?.items.map((i) => i.path),
    ).toEqual(['organizations']);
    expect(groupKeyOf(ORG_GROUPS, 'vouchers')).toBe('clients');
    expect(groupKeyOf(ORG_GROUPS, 'dashboard')).toBeNull();
    expect(navLabel('org', 'sessions')).toBe('Online sessions');
    expect(navLabel('platform', 'audit-log')).toBe('Platform audit log');
  });

  it('every organization route of the previous menu is still reachable (no entry lost)', () => {
    const previous = [
      'dashboard',
      'sites',
      'network-devices',
      'nas',
      // Cycle A (D-044)
      'access-points',
      'controllers',
      'users',
      'user-groups',
      'client-devices',
      'vouchers',
      'policies',
      'policy-assignments',
      'ssid-rate-limit-export',
      'portals',
      'sessions',
      'usage',
      'accounting',
      'reports',
      'audit-log',
      'administrators',
      'api-keys',
    ];
    expect(ORG_NAV.map((i) => i.path).sort()).toEqual([...previous].sort());
    expect(PLATFORM_NAV.map((i) => i.path)).toEqual([
      'summary',
      'organizations',
      'administrators',
      'role-templates',
      'adapters',
      'audit-log',
      'impersonate',
    ]);
  });

  it('every navigation permission exists in the shared catalogue (drift guard)', () => {
    const known = new Set<string>(PERMISSION_KEYS);
    for (const item of [...ORG_NAV, ...PLATFORM_NAV]) {
      for (const permission of item.anyOf) expect(known.has(permission), permission).toBe(true);
    }
    expect(known.has(MFA_RESET_PERMISSION)).toBe(true);
  });

  it('adapter status and policy field lists match packages/shared (drift guard)', () => {
    expect([...ADAPTER_FIELD_STATUSES]).toEqual([...SHARED_STATUSES]);
    expect([...POLICY_FIELDS]).toEqual([...SHARED_FIELDS]);
    expect([...EVIDENCE_LEVELS]).toEqual([...SHARED_EVIDENCE_LEVELS]);
  });

  it('admin deviceEnforced matches shared isDeviceEnforced (V12 drift guard)', () => {
    for (const status of [...ADAPTER_FIELD_STATUSES, 'UNKNOWN', 'VERIFIED'])
      for (const level of [...EVIDENCE_LEVELS, undefined, 'LAB']) {
        // With a device-test reference the admin rule equals the shared rule exactly.
        expect(
          presentStatus(status, level, { dtRefs: ['DT-04'] }).deviceEnforced,
          `${status}/${String(level)}`,
        ).toBe(isDeviceEnforced(status, level));
        // Without one, nothing is device-enforced.
        expect(presentStatus(status, level).deviceEnforced).toBe(false);
      }
  });
});
