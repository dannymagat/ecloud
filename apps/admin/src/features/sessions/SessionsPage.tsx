import { useQuery } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { Link } from 'react-router';
import { api, buildUrl, request } from '../../api/client';
import type { Page, Row } from '../../api/types';
import { DataTable } from '../../components/DataTable';
import { Badge, Button, Card, PageHeader, SelectField } from '../../components/ui';
import { RequireOrgPermission } from '../../layout/guards';
import { hasOperation, useApiDocument } from '../../lib/apiDoc';
import { useAuth } from '../../lib/auth';
import { disconnectGate, type DisconnectGate } from '../../lib/disconnect';
import { display, formatBytes, formatDateTime, formatDuration, str } from '../../lib/format';
import { useOrgId } from '../../lib/org';
import { can, canPlatform } from '../../lib/permissions';
import { useCursorList } from '../../lib/queries';

const DISCONNECT_PATH = '/api/v1/orgs/{orgId}/sessions/{id}/disconnect';

export function DisconnectButton({ gate }: { gate: DisconnectGate }) {
  const id = useId();
  return (
    <span className="inline-flex items-center gap-1" title={gate.reason}>
      <Button size="sm" variant="danger" disabled={!gate.enabled} aria-describedby={id}>
        Disconnect
      </Button>
      <span id={id} role="tooltip" className="sr-only">
        {gate.reason}
      </span>
    </span>
  );
}

function SessionsScreen() {
  const orgId = useOrgId();
  const { me } = useAuth();
  const [status, setStatus] = useState('active');
  const doc = useApiDocument();
  const list = useCursorList<Row>(['org', orgId, 'sessions', status], (cursor, signal) =>
    request<Page<Row>>(
      'get',
      buildUrl('/api/v1/orgs/{orgId}/sessions', { orgId }, { limit: 50, cursor, status }),
      { signal },
    ),
  );
  // Adapter of each NAS (D-035) and the adapters' disconnect status (platform catalogue).
  const nas = useQuery({
    queryKey: ['org', orgId, 'nas-adapters'],
    enabled: can(me, 'nas:read', { organizationId: orgId, anySite: true }),
    queryFn: ({ signal }) =>
      api('get', '/api/v1/orgs/{orgId}/nas', { params: { orgId }, query: { limit: 200 }, signal }),
  });
  const catalogue = useQuery({
    queryKey: ['platform', 'adapters'],
    enabled: canPlatform(me, 'platform:health:read'),
    queryFn: ({ signal }) => api('get', '/api/v1/platform/adapters', { signal }),
  });
  const adapterOfNas = new Map<string, string>();
  for (const n of (nas.data?.data ?? []) as Row[]) {
    const key = n.adapter_key ?? n.adapter_type_key;
    if (typeof key === 'string') adapterOfNas.set(n.id, key);
  }
  const disconnectCap = new Map<string, { status?: unknown; evidence_level?: unknown }>();
  for (const a of (catalogue.data?.adapters ?? []) as unknown as Row[]) {
    const d = a.disconnect as { status?: unknown; evidence_level?: unknown } | undefined;
    disconnectCap.set(str(a.key), d ?? {});
  }
  const endpointAvailable = hasOperation(doc.data, 'post', DISCONNECT_PATH);

  const gateFor = (row: Row): DisconnectGate => {
    const adapterKey =
      typeof row.nas_client_id === 'string' ? (adapterOfNas.get(row.nas_client_id) ?? null) : null;
    return disconnectGate({
      status: adapterKey ? disconnectCap.get(adapterKey)?.status : undefined,
      evidenceLevel: adapterKey ? disconnectCap.get(adapterKey)?.evidence_level : undefined,
      adapterKey,
      hasPermission: can(me, 'session:disconnect', {
        organizationId: orgId,
        siteId: (row.site_id as string) ?? null,
      }),
      endpointAvailable,
    });
  };

  return (
    <div>
      <PageHeader
        title="Sessions"
        description="RADIUS sessions reported by NAS accounting. Disconnect is offered only for adapters whose disconnect support is lab validated on a recorded device test."
      />
      <Card>
        <div className="mb-3 w-48">
          <SelectField
            label="Status"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            options={[
              { value: 'active', label: 'Active' },
              { value: 'stopped', label: 'Stopped' },
              { value: 'stale', label: 'Stale' },
            ]}
          />
        </div>
        <DataTable
          caption="Sessions"
          rows={list.rows}
          rowKey={(r) => r.id}
          loading={list.isPending}
          error={list.error}
          emptyTitle={`No ${status} sessions`}
          hasMore={list.hasNextPage}
          loadingMore={list.isFetchingNextPage}
          onLoadMore={() => void list.fetchNextPage()}
          columns={[
            { key: 'username_raw', header: 'User' },
            { key: 'mac', header: 'MAC' },
            { key: 'framed_ip', header: 'IP' },
            { key: 'nas_name', header: 'NAS' },
            { key: 'policy_name', header: 'Policy' },
            { key: 'started_at', header: 'Started', render: (r) => formatDateTime(r.started_at) },
            {
              key: 'session_time_s',
              header: 'Time',
              render: (r) => formatDuration(r.session_time_s),
            },
            { key: 'input_octets', header: 'In', render: (r) => formatBytes(r.input_octets) },
            { key: 'output_octets', header: 'Out', render: (r) => formatBytes(r.output_octets) },
            {
              key: 'status',
              header: 'Status',
              render: (r) => (
                <Badge tone={r.status === 'active' ? 'success' : 'neutral'}>
                  {display(r.status)}
                </Badge>
              ),
            },
            {
              key: 'actions',
              header: 'Actions',
              render: (r) => (
                <span className="inline-flex items-center gap-2">
                  <Link
                    to={`/orgs/${orgId}/sessions/${r.id}`}
                    className="text-xs text-primary hover:underline"
                  >
                    Enforcement
                  </Link>
                  <DisconnectButton gate={gateFor(r)} />
                </span>
              ),
            },
          ]}
        />
      </Card>
    </div>
  );
}

export function SessionsPage() {
  return (
    <RequireOrgPermission permission="session:read">
      <SessionsScreen />
    </RequireOrgPermission>
  );
}
