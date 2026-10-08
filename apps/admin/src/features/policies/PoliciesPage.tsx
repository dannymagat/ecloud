import { Link } from 'react-router';
import { Badge } from '../../components/ui';
import { formatDateTime, str } from '../../lib/format';
import { ResourcePage, type ResourceConfig } from '../resource/ResourcePage';
import { POLICY_FORM_FIELDS } from './policyFields';

const kbps = (v: unknown) => (typeof v === 'number' ? `${v} kbps` : '—');

export function PoliciesPage() {
  const config: ResourceConfig = {
    title: 'Policies',
    singular: 'Policy',
    description:
      'Bandwidth and access intent. The editor shows, per adapter, whether each field is device-enforced, ECLOUD-side, unverified or unsupported.',
    path: '/api/v1/orgs/{orgId}/policies',
    permissions: { read: 'policy:read', delete: 'policy:delete' },
    columns: [
      {
        key: 'name',
        header: 'Name',
        render: (r) => (
          <Link to={r.id} className="font-medium text-primary hover:underline">
            {str(r.name ?? r.id)}
          </Link>
        ),
      },
      { key: 'scope_type', header: 'Scope' },
      {
        key: 'status',
        header: 'Status',
        render: (r) => (
          <Badge tone={r.status === 'active' ? 'success' : 'neutral'}>{str(r.status ?? '—')}</Badge>
        ),
      },
      { key: 'download_rate_kbps', header: 'Down', render: (r) => kbps(r.download_rate_kbps) },
      { key: 'upload_rate_kbps', header: 'Up', render: (r) => kbps(r.upload_rate_kbps) },
      { key: 'priority', header: 'Priority' },
      { key: 'version', header: 'Version' },
      { key: 'updated_at', header: 'Updated', render: (r) => formatDateTime(r.updated_at) },
    ],
    fields: POLICY_FORM_FIELDS,
    editFields: [],
    headerActions: () => (
      <Link
        to="new"
        className="inline-flex items-center rounded-md bg-primary px-3.5 py-2 text-sm font-medium text-primary-fg hover:bg-primary/90"
      >
        New policy
      </Link>
    ),
  };
  return <ResourcePage config={config} />;
}
