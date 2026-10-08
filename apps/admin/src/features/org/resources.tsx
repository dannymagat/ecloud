/** Configurations for the organization resource screens built on ResourcePage. */
import { Badge } from '../../components/ui';
import { display, formatDateTime, str } from '../../lib/format';
import type { FieldDef } from '../resource/form';
import { ResourcePage, type ResourceConfig } from '../resource/ResourcePage';

const siteSelect = (required = false): FieldDef => ({
  name: 'site_id',
  label: 'Site',
  type: 'select',
  required,
  nullable: !required,
  optionsFrom: { path: '/api/v1/orgs/{orgId}/sites', label: (r) => str(r.name ?? r.id) },
});

const statusBadge = (value: unknown) => (
  <Badge tone={value === 'active' ? 'success' : value === undefined ? 'neutral' : 'warning'}>
    {display(value)}
  </Badge>
);

export const sitesConfig: ResourceConfig = {
  title: 'Sites',
  singular: 'Site',
  description: 'Physical locations. Schedules and reports use each site’s IANA time zone.',
  path: '/api/v1/orgs/{orgId}/sites',
  permissions: {
    read: 'site:read',
    create: 'site:create',
    update: 'site:update',
    delete: 'site:delete',
  },
  columns: [
    { key: 'name', header: 'Name' },
    { key: 'slug', header: 'Slug' },
    { key: 'timezone', header: 'Time zone' },
    { key: 'address', header: 'Address' },
    { key: 'status', header: 'Status', render: (r) => statusBadge(r.status) },
  ],
  fields: [
    { name: 'name', label: 'Name', type: 'text', required: true },
    {
      name: 'slug',
      label: 'Slug',
      type: 'text',
      required: true,
      createOnly: true,
      hint: 'Lowercase letters, digits and dashes.',
    },
    {
      name: 'timezone',
      label: 'Time zone',
      type: 'text',
      defaultValue: 'UTC',
      hint: 'IANA name, e.g. Asia/Dubai.',
    },
    { name: 'address', label: 'Address', type: 'textarea', nullable: true },
  ],
};

export const networkDevicesConfig: ResourceConfig = {
  title: 'Network devices',
  singular: 'Network device',
  description: 'Managed access points and gateways (inventory).',
  path: '/api/v1/orgs/{orgId}/network-devices',
  permissions: {
    read: 'network_device:read',
    create: 'network_device:create',
    update: 'network_device:update',
    delete: 'network_device:delete',
  },
  columns: [
    { key: 'serial', header: 'Serial' },
    { key: 'mac', header: 'MAC' },
    { key: 'model', header: 'Model' },
    { key: 'firmware', header: 'Firmware' },
    { key: 'mode', header: 'Mode' },
    { key: 'mgmt_status', header: 'Management' },
    { key: 'last_seen_at', header: 'Last seen', render: (r) => formatDateTime(r.last_seen_at) },
  ],
  fields: [
    siteSelect(true),
    { name: 'serial', label: 'Serial', type: 'text', required: true, createOnly: true },
    { name: 'mac', label: 'MAC', type: 'text', nullable: true, placeholder: 'aa:bb:cc:dd:ee:ff' },
    { name: 'model', label: 'Model', type: 'text', nullable: true },
    { name: 'firmware', label: 'Firmware', type: 'text', nullable: true },
    {
      name: 'mode',
      label: 'Mode',
      type: 'select',
      options: [
        { value: 'bridge', label: 'Bridge' },
        { value: 'routed', label: 'Routed' },
        { value: 'unknown', label: 'Unknown' },
      ],
    },
  ],
};

export const userGroupsConfig: ResourceConfig = {
  title: 'User groups',
  singular: 'User group',
  path: '/api/v1/orgs/{orgId}/user-groups',
  permissions: {
    read: 'user_group:read',
    create: 'user_group:create',
    update: 'user_group:update',
    delete: 'user_group:delete',
  },
  columns: [
    { key: 'name', header: 'Name' },
    { key: 'description', header: 'Description', className: 'px-3 py-2' },
    { key: 'is_default', header: 'Default' },
    { key: 'created_at', header: 'Created', render: (r) => formatDateTime(r.created_at) },
  ],
  fields: [
    { name: 'name', label: 'Name', type: 'text', required: true },
    { name: 'description', label: 'Description', type: 'textarea' },
    siteSelect(false),
    { name: 'is_default', label: 'Default group for new users', type: 'checkbox' },
  ],
};

export const clientDevicesConfig: ResourceConfig = {
  title: 'Client devices',
  singular: 'Client device',
  description: 'Subscriber devices by MAC address (MAC authentication allow list and blocks).',
  path: '/api/v1/orgs/{orgId}/client-devices',
  permissions: {
    read: 'client_device:read',
    create: 'client_device:create',
    update: 'client_device:update',
    delete: 'client_device:delete',
  },
  columns: [
    { key: 'mac', header: 'MAC' },
    { key: 'name', header: 'Name' },
    { key: 'device_type', header: 'Type' },
    { key: 'mac_auth_enabled', header: 'MAC auth' },
    {
      key: 'blocked',
      header: 'Blocked',
      render: (r) => (r.blocked === true ? <Badge tone="danger">Blocked</Badge> : 'No'),
    },
    { key: 'last_seen_at', header: 'Last seen', render: (r) => formatDateTime(r.last_seen_at) },
  ],
  fields: [
    {
      name: 'mac',
      label: 'MAC',
      type: 'text',
      required: true,
      createOnly: true,
      placeholder: 'aa:bb:cc:dd:ee:ff',
    },
    {
      name: 'user_id',
      label: 'User',
      type: 'select',
      nullable: true,
      optionsFrom: { path: '/api/v1/orgs/{orgId}/users', label: (r) => str(r.username ?? r.id) },
    },
    { name: 'name', label: 'Name', type: 'text', nullable: true },
    { name: 'device_type', label: 'Device type', type: 'text', nullable: true },
    { name: 'mac_auth_enabled', label: 'Allow MAC authentication', type: 'checkbox' },
    { name: 'blocked', label: 'Blocked', type: 'checkbox' },
  ],
};

const TARGET_TYPES = [
  { value: 'user', label: 'User' },
  { value: 'user_group', label: 'User group' },
  { value: 'site', label: 'Site' },
  { value: 'client_device', label: 'Client device' },
  { value: 'voucher_batch', label: 'Voucher batch' },
];

export const policyAssignmentsConfig: ResourceConfig = {
  title: 'Policy assignments',
  singular: 'Policy assignment',
  description:
    'Bind a policy to a scope (user, group, site, device, voucher batch) with a priority and an effective window. Higher-precedence scopes win per POLICY_ENGINE.md; use the policy simulator to check the result.',
  path: '/api/v1/orgs/{orgId}/policy-assignments',
  permissions: {
    read: 'policy_assignment:read',
    create: 'policy_assignment:create',
    delete: 'policy_assignment:delete',
  },
  columns: [
    {
      key: 'policy_id',
      header: 'Policy',
      render: (r) => <code className="text-xs">{str(r.policy_id)}</code>,
    },
    { key: 'target_type', header: 'Scope' },
    {
      key: 'target',
      header: 'Target',
      render: (r) => (
        <code className="text-xs">
          {str(
            r.user_id ??
              r.user_group_id ??
              r.site_id ??
              r.client_device_id ??
              r.voucher_batch_id ??
              '—',
          )}
        </code>
      ),
    },
    { key: 'priority', header: 'Priority' },
    { key: 'effective_from', header: 'From', render: (r) => formatDateTime(r.effective_from) },
    { key: 'effective_until', header: 'Until', render: (r) => formatDateTime(r.effective_until) },
    { key: 'note', header: 'Note' },
  ],
  fields: [
    {
      name: 'policy_id',
      label: 'Policy',
      type: 'select',
      required: true,
      optionsFrom: {
        path: '/api/v1/orgs/{orgId}/policies',
        label: (r) => `${str(r.name)} (v${str(r.version ?? 1)})`,
      },
    },
    {
      name: 'target_type',
      label: 'Scope type',
      type: 'select',
      required: true,
      options: TARGET_TYPES,
    },
    {
      name: 'target_id',
      label: 'Target id',
      type: 'text',
      required: true,
      hint: 'Id of the user, group, site, device or voucher batch.',
    },
    {
      name: 'priority',
      label: 'Priority',
      type: 'number',
      hint: 'Higher wins within the same scope.',
    },
    { name: 'effective_from', label: 'Effective from', type: 'datetime', hint: 'Defaults to now.' },
    { name: 'effective_until', label: 'Effective until', type: 'datetime' },
    { name: 'note', label: 'Note', type: 'textarea' },
  ],
};

export const apiKeysConfig: ResourceConfig = {
  title: 'API keys',
  singular: 'API key',
  description: 'Integration keys bound to one role and scope. The key is shown once at creation.',
  path: '/api/v1/orgs/{orgId}/api-keys',
  permissions: { read: 'api_key:read', create: 'api_key:create', delete: 'api_key:revoke' },
  columns: [
    { key: 'name', header: 'Name' },
    {
      key: 'key_prefix',
      header: 'Prefix',
      render: (r) => <code className="text-xs">{display(r.key_prefix)}</code>,
    },
    { key: 'scope_type', header: 'Scope' },
    { key: 'last_used_at', header: 'Last used', render: (r) => formatDateTime(r.last_used_at) },
    { key: 'expires_at', header: 'Expires', render: (r) => formatDateTime(r.expires_at) },
    {
      key: 'revoked_at',
      header: 'State',
      render: (r) =>
        r.revoked_at ? <Badge tone="danger">Revoked</Badge> : <Badge tone="success">Active</Badge>,
    },
  ],
  fields: [
    { name: 'name', label: 'Name', type: 'text', required: true },
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
    {
      name: 'scope_type',
      label: 'Scope',
      type: 'select',
      required: true,
      options: [
        { value: 'organization', label: 'Organization' },
        { value: 'site', label: 'Site' },
      ],
    },
    siteSelect(false),
    {
      name: 'allowed_cidrs',
      label: 'Allowed CIDRs',
      type: 'list',
      hint: 'Comma-separated, e.g. 203.0.113.0/24. Empty = any.',
    },
    { name: 'expires_at', label: 'Expires at', type: 'datetime' },
  ],
  secretOnCreate: {
    key: 'key',
    title: 'API key',
    description:
      'Use as `Authorization: Bearer <key>`. It is shown once; revoke and recreate if lost.',
  },
};

export const SitesPage = () => <ResourcePage config={sitesConfig} />;
export const NetworkDevicesPage = () => <ResourcePage config={networkDevicesConfig} />;
export const UserGroupsPage = () => <ResourcePage config={userGroupsConfig} />;
export const ClientDevicesPage = () => <ResourcePage config={clientDevicesConfig} />;
export const PolicyAssignmentsPage = () => <ResourcePage config={policyAssignmentsConfig} />;
export const ApiKeysPage = () => <ResourcePage config={apiKeysConfig} />;
