/**
 * Organization dashboard: resource counts and active sessions. The API has no aggregate
 * endpoint yet, so counts come from list endpoints (first page of up to 200 rows; "200+"
 * when more pages exist). Each tile renders only when its read permission is held.
 */
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { buildUrl, request } from '../../api/client';
import type { Page, Row } from '../../api/types';
import { DataTable } from '../../components/DataTable';
import { ProblemAlert } from '../../components/ProblemAlert';
import { Card, PageHeader, Spinner } from '../../components/ui';
import { useAuth } from '../../lib/auth';
import { formatBytes, formatDateTime } from '../../lib/format';
import { useOrgId } from '../../lib/org';
import { can } from '../../lib/permissions';
import type { OrgCollectionPath } from '../resource/paths';

interface Tile {
  label: string;
  path: OrgCollectionPath;
  permission: string;
  to: string;
  query?: Record<string, string>;
}

const TILES: Tile[] = [
  {
    label: 'Active sessions',
    path: '/api/v1/orgs/{orgId}/sessions',
    permission: 'session:read',
    to: 'sessions',
    query: { status: 'active' },
  },
  { label: 'Sites', path: '/api/v1/orgs/{orgId}/sites', permission: 'site:read', to: 'sites' },
  { label: 'NAS clients', path: '/api/v1/orgs/{orgId}/nas', permission: 'nas:read', to: 'nas' },
  {
    label: 'Network devices',
    path: '/api/v1/orgs/{orgId}/network-devices',
    permission: 'network_device:read',
    to: 'network-devices',
  },
  { label: 'Users', path: '/api/v1/orgs/{orgId}/users', permission: 'user:read', to: 'users' },
  {
    label: 'Policies',
    path: '/api/v1/orgs/{orgId}/policies',
    permission: 'policy:read',
    to: 'policies',
  },
  {
    label: 'Voucher batches',
    path: '/api/v1/orgs/{orgId}/voucher-batches',
    permission: 'voucher:read',
    to: 'vouchers',
  },
];

function CountTile({ orgId, tile }: { orgId: string; tile: Tile }) {
  const q = useQuery({
    queryKey: ['org', orgId, 'count', tile.path, tile.query],
    refetchInterval: tile.to === 'sessions' ? 30_000 : false,
    queryFn: ({ signal }) =>
      request<Page<Row>>('get', buildUrl(tile.path, { orgId }, { limit: 200, ...tile.query }), {
        signal,
        pathTemplate: tile.path,
      }),
  });
  const value = q.data ? `${q.data.data.length}${q.data.next_cursor ? '+' : ''}` : null;
  return (
    <Link
      to={`/orgs/${orgId}/${tile.to}`}
      className="block rounded-lg border border-border bg-surface p-4 shadow-sm hover:border-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
    >
      <p className="text-xs font-medium uppercase tracking-wide text-subtle">{tile.label}</p>
      <p className="mt-2 text-2xl font-semibold tabular-nums">
        {q.isPending ? (
          <Spinner small />
        ) : q.error ? (
          <span className="text-sm text-danger">error</span>
        ) : (
          value
        )}
      </p>
    </Link>
  );
}

export function DashboardPage() {
  const orgId = useOrgId();
  const { me } = useAuth();
  const target = { organizationId: orgId, anySite: true };
  const tiles = TILES.filter((t) => can(me, t.permission, target));
  const canSessions = can(me, 'session:read', target);
  const sessions = useQuery({
    queryKey: ['org', orgId, 'dashboard-sessions'],
    enabled: canSessions,
    refetchInterval: 30_000,
    queryFn: ({ signal }) =>
      request<Page<Row>>(
        'get',
        buildUrl('/api/v1/orgs/{orgId}/sessions', { orgId }, { limit: 10, status: 'active' }),
        { signal },
      ),
  });
  return (
    <div className="space-y-6">
      <PageHeader title="Dashboard" />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4">
        {tiles.map((t) => (
          <CountTile key={t.path} orgId={orgId} tile={t} />
        ))}
      </div>
      {canSessions ? (
        <Card
          title="Latest active sessions"
          actions={
            <Link className="text-sm text-primary hover:underline" to={`/orgs/${orgId}/sessions`}>
              All sessions
            </Link>
          }
        >
          {sessions.error ? (
            <ProblemAlert error={sessions.error} />
          ) : (
            <DataTable
              caption="Active sessions"
              rows={sessions.data?.data ?? []}
              rowKey={(r) => r.id}
              loading={sessions.isPending}
              emptyTitle="No active sessions"
              columns={[
                { key: 'username_raw', header: 'User' },
                { key: 'mac', header: 'MAC' },
                { key: 'nas_name', header: 'NAS' },
                {
                  key: 'started_at',
                  header: 'Started',
                  render: (r) => formatDateTime(r.started_at),
                },
                { key: 'input_octets', header: 'In', render: (r) => formatBytes(r.input_octets) },
                {
                  key: 'output_octets',
                  header: 'Out',
                  render: (r) => formatBytes(r.output_octets),
                },
              ]}
            />
          )}
        </Card>
      ) : null}
    </div>
  );
}
