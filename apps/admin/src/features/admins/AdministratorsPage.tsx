/**
 * Organization administrators, role bindings, invitations and roles. Role names are shown as
 * labels only; what an administrator may do is decided by the permissions of the bound role.
 */
import { Badge, PageHeader } from '../../components/ui';
import { useAuth } from '../../lib/auth';
import { display, formatDateTime, str } from '../../lib/format';
import { useOrgId } from '../../lib/org';
import { can } from '../../lib/permissions';
import { ResourcePage, type ResourceConfig } from '../resource/ResourcePage';

const SCOPE_OPTIONS = [
  { value: 'organization', label: 'Organization' },
  { value: 'site', label: 'Site' },
];

const administratorsConfig: ResourceConfig = {
  title: 'Administrators',
  singular: 'Administrator',
  path: '/api/v1/orgs/{orgId}/administrators',
  permissions: { read: 'administrator:read' },
  columns: [
    { key: 'email', header: 'Email' },
    { key: 'display_name', header: 'Name' },
    {
      key: 'status',
      header: 'Status',
      render: (r) => (
        <Badge tone={r.status === 'active' ? 'success' : 'warning'}>{display(r.status)}</Badge>
      ),
    },
    { key: 'last_login_at', header: 'Last login', render: (r) => formatDateTime(r.last_login_at) },
  ],
  fields: [],
};

const bindingsConfig: ResourceConfig = {
  title: 'Role bindings',
  singular: 'Role binding',
  description:
    'Grant an administrator a role at organization or site scope (optionally until a date).',
  path: '/api/v1/orgs/{orgId}/role-bindings',
  permissions: {
    read: 'administrator:read',
    create: 'administrator:binding:create',
    delete: 'administrator:binding:delete',
  },
  columns: [
    {
      key: 'administrator_id',
      header: 'Administrator',
      render: (r) => display(r.administrator_email ?? r.email ?? r.administrator_id),
    },
    {
      key: 'role_id',
      header: 'Role',
      render: (r) => display(r.role_name ?? r.role_key ?? r.role_id),
    },
    { key: 'scope_type', header: 'Scope' },
    { key: 'site_id', header: 'Site', render: (r) => display(r.site_name ?? r.site_id) },
    { key: 'expires_at', header: 'Expires', render: (r) => formatDateTime(r.expires_at) },
  ],
  fields: [
    {
      name: 'administrator_id',
      label: 'Administrator',
      type: 'select',
      required: true,
      optionsFrom: {
        path: '/api/v1/orgs/{orgId}/administrators',
        label: (r) => str(r.email ?? r.id),
      },
    },
    {
      name: 'role_id',
      label: 'Role',
      type: 'select',
      required: true,
      optionsFrom: {
        path: '/api/v1/orgs/{orgId}/roles',
        label: (r) => str(r.name ?? r.key ?? r.id),
      },
    },
    { name: 'scope_type', label: 'Scope', type: 'select', required: true, options: SCOPE_OPTIONS },
    {
      name: 'site_id',
      label: 'Site (site scope only)',
      type: 'select',
      optionsFrom: { path: '/api/v1/orgs/{orgId}/sites', label: (r) => str(r.name ?? r.id) },
    },
    { name: 'expires_at', label: 'Expires at', type: 'datetime' },
  ],
};

const invitationsConfig: ResourceConfig = {
  title: 'Invitations',
  singular: 'Invitation',
  description:
    'Invite an administrator by email. No mail is sent yet: hand the one-time token over securely.',
  path: '/api/v1/orgs/{orgId}/invitations',
  permissions: { read: 'administrator:read', create: 'administrator:invite' },
  columns: [
    { key: 'email', header: 'Email' },
    { key: 'scope_type', header: 'Scope' },
    { key: 'expires_at', header: 'Expires', render: (r) => formatDateTime(r.expires_at) },
    { key: 'accepted_at', header: 'Accepted', render: (r) => formatDateTime(r.accepted_at) },
  ],
  fields: [
    { name: 'email', label: 'Email', type: 'email', required: true },
    {
      name: 'role_id',
      label: 'Role',
      type: 'select',
      required: true,
      optionsFrom: {
        path: '/api/v1/orgs/{orgId}/roles',
        label: (r) => str(r.name ?? r.key ?? r.id),
      },
    },
    { name: 'scope_type', label: 'Scope', type: 'select', required: true, options: SCOPE_OPTIONS },
    {
      name: 'site_id',
      label: 'Site (site scope only)',
      type: 'select',
      optionsFrom: { path: '/api/v1/orgs/{orgId}/sites', label: (r) => str(r.name ?? r.id) },
    },
  ],
  secretOnCreate: {
    key: 'token',
    title: 'Invitation token',
    description: 'Give this token to the invitee; it is shown once and expires.',
  },
};

const rolesConfig: ResourceConfig = {
  title: 'Roles',
  singular: 'Role',
  description:
    'Role templates (platform-defined) and organization roles with their permission sets.',
  path: '/api/v1/orgs/{orgId}/roles',
  permissions: { read: 'role:read' },
  columns: [
    { key: 'name', header: 'Name' },
    { key: 'key', header: 'Key', render: (r) => <code className="text-xs">{display(r.key)}</code> },
    { key: 'is_template', header: 'Template' },
    {
      key: 'permissions',
      header: 'Permissions',
      className: 'px-3 py-2',
      render: (r) =>
        Array.isArray(r.permissions) ? (
          <details>
            <summary className="cursor-pointer text-primary">
              {r.permissions.length} permissions
            </summary>
            <p className="mt-1 max-w-md font-mono text-xs">{r.permissions.join(' ')}</p>
          </details>
        ) : (
          '—'
        ),
    },
  ],
  fields: [],
};

export function AdministratorsPage() {
  const { me } = useAuth();
  const orgId = useOrgId();
  return (
    <div className="space-y-6">
      <PageHeader
        title="Administrators"
        description="Who can manage this organization, and with which role."
      />
      <ResourcePage config={administratorsConfig} embedded />
      <ResourcePage config={bindingsConfig} embedded />
      <ResourcePage config={invitationsConfig} embedded />
      {can(me, 'role:read', { organizationId: orgId }) ? (
        <ResourcePage config={rolesConfig} embedded />
      ) : null}
    </div>
  );
}
