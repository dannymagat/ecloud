/**
 * Access points behind a NAS (Cycle A, D-044; migration 028). Third-party portals identify the
 * AP by MAC, so an AP MAC registered here selects its NAS (and so the organization). A MAC can
 * be registered once across ALL organizations; the API answers 409 for a MAC already in use.
 */
import { Badge } from '../../components/ui';
import { display, formatDateTime, str } from '../../lib/format';
import type { FieldDef } from '../resource/form';
import { ResourcePage, type ResourceConfig } from '../resource/ResourcePage';

const fields: FieldDef[] = [
  {
    name: 'nas_client_id',
    label: 'NAS client',
    type: 'select',
    required: true,
    optionsFrom: {
      path: '/api/v1/orgs/{orgId}/nas',
      label: (r) => `${str(r.name ?? r.id)} (${str(r.nas_ip ?? '')})`,
    },
    hint: 'The RADIUS client (controller, gateway or the AP itself) this AP sits behind; the site follows the NAS.',
  },
  {
    name: 'mac',
    label: 'AP MAC address',
    type: 'text',
    required: true,
    placeholder: 'aa:bb:cc:dd:ee:ff',
    hint: 'Unicast MAC as the vendor sends it in the portal redirect (aa:bb:cc:dd:ee:ff, AA-BB-CC-DD-EE-FF, aabb.ccdd.eeff or aabbccddeeff); stored as aa:bb:cc:dd:ee:ff.',
  },
  { name: 'name', label: 'Name', type: 'text', nullable: true },
];

export const accessPointsConfig: ResourceConfig = {
  title: 'Access points',
  singular: 'Access point',
  description:
    'APs identified by MAC behind a NAS client. Portal redirects that name an unregistered, disabled or conflicting AP are refused (fail closed).',
  path: '/api/v1/orgs/{orgId}/access-points',
  siteFilter: true,
  permissions: {
    read: 'nas:read',
    create: 'nas:create',
    update: 'nas:update',
    delete: 'nas:delete',
  },
  columns: [
    { key: 'mac', header: 'MAC', render: (r) => <code className="text-xs">{display(r.mac)}</code> },
    { key: 'name', header: 'Name' },
    {
      key: 'nas_client_id',
      header: 'NAS',
      render: (r) => <code className="text-xs">{display(r.nas_client_id)}</code>,
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
  editFields: [
    ...fields,
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
  ],
};

export const AccessPointsPage = () => <ResourcePage config={accessPointsConfig} />;
