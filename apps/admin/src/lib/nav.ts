/**
 * Permission-driven navigation (ADMIN_UI_ARCHITECTURE.md §2, D-021). Each entry names the
 * permission(s) that reveal it; there is no role-name logic anywhere in the UI.
 */
import {
  Activity,
  BarChart3,
  Building,
  Database,
  Cpu,
  FileBarChart,
  FileStack,
  Gauge,
  KeyRound,
  LayoutDashboard,
  Link2,
  MapPin,
  Network,
  PanelsTopLeft,
  Router,
  ScrollText,
  Server,
  Shield,
  ShieldCheck,
  Smartphone,
  Ticket,
  UserCog,
  Users,
  UsersRound,
  Eye,
  Wifi,
  type LucideIcon,
} from 'lucide-react';
import type { Me } from '../api/types';
import { canAny, canPlatform } from './permissions';

export interface NavItem {
  /** Path segment below `/orgs/:orgId/` or `/platform/`. */
  path: string;
  label: string;
  icon: LucideIcon;
  /** Any of these permissions reveals the entry. */
  anyOf: readonly string[];
}

/** The organization dashboard: the one top-level entry outside a group. */
export const ORG_DASHBOARD: NavItem = {
  path: 'dashboard',
  label: 'Dashboard',
  icon: LayoutDashboard,
  anyOf: [
    'organization:read',
    'site:read',
    'session:read',
    'nas:read',
    'user:read',
    'accounting:read',
    'report:read',
  ],
};

export interface NavGroup {
  /** Stable key (persisted open/closed state). */
  key: string;
  label: string;
  icon: LucideIcon;
  items: readonly NavItem[];
}

/**
 * Sidebar groups (admin redesign cycle 1, EZECLOUD style). Every entry is an existing route;
 * detail pages (site dashboard, session detail, policy editor, portal designer) open from their
 * lists and appear in the breadcrumb only.
 */
export const ORG_GROUPS: readonly NavGroup[] = [
  {
    key: 'bandwidth',
    label: 'Bandwidth Management',
    icon: Gauge,
    items: [
      { path: 'policies', label: 'Policies', icon: ShieldCheck, anyOf: ['policy:read'] },
      {
        path: 'policy-assignments',
        label: 'Policy assignments',
        icon: Link2,
        anyOf: ['policy_assignment:read'],
      },
      {
        path: 'ssid-rate-limit-export',
        label: 'SSID rate-limit export',
        icon: FileStack,
        anyOf: ['policy:preview'],
      },
    ],
  },
  {
    key: 'network',
    label: 'Network',
    icon: Network,
    items: [
      { path: 'sites', label: 'Sites', icon: MapPin, anyOf: ['site:read'] },
      { path: 'nas', label: 'NAS clients (access points)', icon: Server, anyOf: ['nas:read'] },
      { path: 'access-points', label: 'Access points (AP MAC)', icon: Wifi, anyOf: ['nas:read'] },
      { path: 'controllers', label: 'Controllers', icon: Cpu, anyOf: ['controller:read'] },
      {
        path: 'network-devices',
        label: 'Network devices',
        icon: Router,
        anyOf: ['network_device:read'],
      },
    ],
  },
  {
    key: 'clients',
    label: 'Clients',
    icon: Users,
    items: [
      { path: 'sessions', label: 'Online sessions', icon: Activity, anyOf: ['session:read'] },
      { path: 'users', label: 'Users', icon: Users, anyOf: ['user:read'] },
      { path: 'user-groups', label: 'User groups', icon: UsersRound, anyOf: ['user_group:read'] },
      {
        path: 'client-devices',
        label: 'Client devices',
        icon: Smartphone,
        anyOf: ['client_device:read'],
      },
      { path: 'vouchers', label: 'Vouchers', icon: Ticket, anyOf: ['voucher:read'] },
    ],
  },
  {
    key: 'reports',
    label: 'Reports',
    icon: FileBarChart,
    items: [
      { path: 'usage', label: 'Usage', icon: BarChart3, anyOf: ['accounting:read'] },
      {
        path: 'accounting',
        label: 'Accounting records',
        icon: Database,
        anyOf: ['accounting:read'],
      },
      { path: 'reports', label: 'Reports', icon: FileBarChart, anyOf: ['report:read'] },
    ],
  },
  {
    key: 'login-page',
    label: 'Login Page',
    icon: PanelsTopLeft,
    items: [
      { path: 'portals', label: 'Captive portals', icon: Wifi, anyOf: ['captive_portal:read'] },
    ],
  },
  {
    key: 'management',
    label: 'Management',
    icon: UserCog,
    items: [
      {
        path: 'administrators',
        label: 'Administrators',
        icon: UserCog,
        anyOf: ['administrator:read'],
      },
      { path: 'api-keys', label: 'API keys', icon: KeyRound, anyOf: ['api_key:read'] },
      { path: 'audit-log', label: 'Audit log', icon: ScrollText, anyOf: ['audit_log:read'] },
    ],
  },
];

/** Every organization entry, flat, in sidebar order. */
export const ORG_NAV: readonly NavItem[] = [ORG_DASHBOARD, ...ORG_GROUPS.flatMap((g) => g.items)];

export const PLATFORM_NAV: readonly NavItem[] = [
  {
    path: 'summary',
    label: 'Summary',
    icon: LayoutDashboard,
    anyOf: ['platform:health:read'],
  },
  { path: 'organizations', label: 'Organizations', icon: Building, anyOf: ['tenant:list'] },
  { path: 'administrators', label: 'Administrators', icon: UserCog, anyOf: ['administrator:read'] },
  {
    path: 'role-templates',
    label: 'Role templates',
    icon: FileStack,
    anyOf: ['role:read', 'platform:role_template:manage'],
  },
  { path: 'adapters', label: 'Adapters', icon: Cpu, anyOf: ['platform:health:read'] },
  { path: 'audit-log', label: 'Platform audit log', icon: ScrollText, anyOf: ['audit_log:read'] },
  { path: 'impersonate', label: 'Impersonation', icon: Eye, anyOf: ['tenant:impersonate'] },
];

export const PLATFORM_GROUP: NavGroup = {
  key: 'platform',
  label: 'Platform',
  icon: Shield,
  items: PLATFORM_NAV,
};

const orgItemVisible = (me: Me | null, organizationId: string) => (item: NavItem) =>
  canAny(me, item.anyOf, { organizationId, anySite: true });

export function visibleOrgNav(me: Me | null, organizationId: string): NavItem[] {
  return ORG_NAV.filter(orgItemVisible(me, organizationId));
}

export function visiblePlatformNav(me: Me | null): NavItem[] {
  return PLATFORM_NAV.filter((item) => item.anyOf.some((p) => canPlatform(me, p)));
}

/**
 * Organization groups with only the permitted entries; a group whose entries are all hidden is
 * itself hidden.
 */
export function visibleOrgGroups(me: Me | null, organizationId: string): NavGroup[] {
  const visible = orgItemVisible(me, organizationId);
  return ORG_GROUPS.map((g) => ({ ...g, items: g.items.filter(visible) })).filter(
    (g) => g.items.length > 0,
  );
}

/** The platform group with the permitted entries, or null when none is permitted. */
export function visiblePlatformGroup(me: Me | null): NavGroup | null {
  const items = visiblePlatformNav(me);
  return items.length > 0 ? { ...PLATFORM_GROUP, items } : null;
}

/** Key of the group holding the entry `segment` (first path segment below the base), if any. */
export function groupKeyOf(
  groups: readonly NavGroup[],
  segment: string | undefined,
): string | null {
  if (!segment) return null;
  return groups.find((g) => g.items.some((i) => i.path === segment))?.key ?? null;
}

/** Sidebar label of an entry (breadcrumbs), from the full catalogue (not permission-filtered). */
export function navLabel(area: 'org' | 'platform', segment: string): string | undefined {
  return (area === 'org' ? ORG_NAV : PLATFORM_NAV).find((i) => i.path === segment)?.label;
}
