/**
 * Permission-driven navigation (ADMIN_UI_ARCHITECTURE.md §2, D-021). Each entry names the
 * permission(s) that reveal it; there is no role-name logic anywhere in the UI.
 */
import {
  Activity,
  Building,
  Cpu,
  FileStack,
  KeyRound,
  LayoutDashboard,
  Link2,
  MapPin,
  Router,
  ScrollText,
  Server,
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

export const ORG_NAV: readonly NavItem[] = [
  {
    path: 'dashboard',
    label: 'Dashboard',
    icon: LayoutDashboard,
    anyOf: ['organization:read', 'site:read', 'session:read', 'nas:read', 'user:read'],
  },
  { path: 'sites', label: 'Sites', icon: MapPin, anyOf: ['site:read'] },
  {
    path: 'network-devices',
    label: 'Network devices',
    icon: Router,
    anyOf: ['network_device:read'],
  },
  { path: 'nas', label: 'NAS clients', icon: Server, anyOf: ['nas:read'] },
  { path: 'users', label: 'Users', icon: Users, anyOf: ['user:read'] },
  { path: 'user-groups', label: 'User groups', icon: UsersRound, anyOf: ['user_group:read'] },
  {
    path: 'client-devices',
    label: 'Client devices',
    icon: Smartphone,
    anyOf: ['client_device:read'],
  },
  { path: 'vouchers', label: 'Vouchers', icon: Ticket, anyOf: ['voucher:read'] },
  { path: 'policies', label: 'Policies', icon: ShieldCheck, anyOf: ['policy:read'] },
  {
    path: 'policy-assignments',
    label: 'Policy assignments',
    icon: Link2,
    anyOf: ['policy_assignment:read'],
  },
  {
    path: 'portals',
    label: 'Captive portals',
    icon: Wifi,
    anyOf: ['captive_portal:read'],
  },
  { path: 'sessions', label: 'Sessions', icon: Activity, anyOf: ['session:read'] },
  { path: 'audit-log', label: 'Audit log', icon: ScrollText, anyOf: ['audit_log:read'] },
  { path: 'administrators', label: 'Administrators', icon: UserCog, anyOf: ['administrator:read'] },
  { path: 'api-keys', label: 'API keys', icon: KeyRound, anyOf: ['api_key:read'] },
];

export const PLATFORM_NAV: readonly NavItem[] = [
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

export function visibleOrgNav(me: Me | null, organizationId: string): NavItem[] {
  return ORG_NAV.filter((item) => canAny(me, item.anyOf, { organizationId, anySite: true }));
}

export function visiblePlatformNav(me: Me | null): NavItem[] {
  return PLATFORM_NAV.filter((item) => item.anyOf.some((p) => canPlatform(me, p)));
}
