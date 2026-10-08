/**
 * Captive portals per site (ADMIN_UI_ARCHITECTURE.md §3 "Captive portal designer"): one portal
 * per site network; the designer (theme, logo, texts, login methods, terms, preview) opens from
 * each row.
 */
import { Link } from 'react-router';
import { Badge } from '../../components/ui';
import { formatDateTime, str } from '../../lib/format';
import type { FieldDef } from '../resource/form';
import { ResourcePage, type ResourceConfig } from '../resource/ResourcePage';

export const LOGIN_METHOD_LABELS: Record<string, string> = {
  password: 'Username / password',
  voucher: 'Voucher',
  click_through: 'Click-through (terms)',
};

export function PortalsPage() {
  const shared: FieldDef[] = [
    { name: 'name', label: 'Name', type: 'text', required: true },
    {
      name: 'portal_type',
      label: 'Hotspot type',
      type: 'select',
      required: true,
      options: [
        { value: 'uspot', label: 'uspot (OpenWrt / TIP)' },
        { value: 'coovachilli', label: 'CoovaChilli' },
        { value: 'external', label: 'External' },
      ],
    },
    {
      name: 'network_ref',
      label: 'Network reference',
      type: 'text',
      required: true,
      hint: 'SSID or interface name on the site NAS (unique per site).',
    },
    {
      name: 'theme_id',
      label: 'Theme',
      type: 'select',
      nullable: true,
      optionsFrom: {
        path: '/api/v1/orgs/{orgId}/portal-themes',
        label: (r) => str(r.name ?? r.id),
      },
    },
    {
      name: 'redirect_url',
      label: 'Redirect after login',
      type: 'text',
      nullable: true,
      placeholder: 'https://example.com/welcome',
    },
    {
      name: 'walled_garden',
      label: 'Walled garden hosts',
      type: 'list',
      hint: 'Comma-separated host names reachable before login (e.g. example.com, *.cdn.example).',
    },
  ];
  const fields: FieldDef[] = [
    {
      name: 'site_id',
      label: 'Site',
      type: 'select',
      required: true,
      createOnly: true,
      optionsFrom: { path: '/api/v1/orgs/{orgId}/sites', label: (r) => str(r.name ?? r.id) },
    },
    {
      name: 'public_slug',
      label: 'Public slug',
      type: 'text',
      required: true,
      hint: 'Lower-case letters, digits and dashes; identifies the portal URL.',
    },
    ...shared,
  ];
  const editFields: FieldDef[] = [
    { name: 'public_slug', label: 'Public slug', type: 'text', required: true },
    ...shared,
    {
      name: 'status',
      label: 'Status',
      type: 'select',
      required: true,
      options: [
        { value: 'active', label: 'Active' },
        { value: 'disabled', label: 'Disabled' },
      ],
    },
  ];

  const config: ResourceConfig = {
    title: 'Captive portals',
    singular: 'captive portal',
    description:
      'Guest login pages per site network. Open the designer to set the theme, logo, texts, login methods and terms.',
    path: '/api/v1/orgs/{orgId}/captive-portals',
    permissions: {
      read: 'captive_portal:read',
      create: 'captive_portal:create',
      update: 'captive_portal:update',
      delete: 'captive_portal:delete',
    },
    columns: [
      { key: 'name', header: 'Name' },
      {
        key: 'public_slug',
        header: 'Slug',
        render: (r) => <code className="text-xs">{str(r.public_slug)}</code>,
      },
      { key: 'portal_type', header: 'Type' },
      {
        key: 'auth_methods',
        header: 'Login methods',
        render: (r) =>
          Array.isArray(r.auth_methods)
            ? (r.auth_methods as string[]).map((m) => LOGIN_METHOD_LABELS[m] ?? m).join(', ')
            : '—',
      },
      {
        key: 'status',
        header: 'Status',
        render: (r) => (
          <Badge tone={r.status === 'active' ? 'success' : 'neutral'}>{str(r.status ?? '—')}</Badge>
        ),
      },
      { key: 'updated_at', header: 'Updated', render: (r) => formatDateTime(r.updated_at) },
    ],
    fields,
    editFields,
    rowActions: (row) => (
      <Link
        to={row.id}
        className="rounded-md border border-border px-2.5 py-1 text-xs font-medium hover:bg-muted"
      >
        Designer
      </Link>
    ),
  };
  return <ResourcePage config={config} />;
}
