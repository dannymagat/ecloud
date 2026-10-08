import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, buildUrl, newIdempotencyKey, request, type RequestBody } from '../../api/client';
import { problemOf, type Problem } from '../../api/problem';
import type { Page, Row } from '../../api/types';
import { DataTable } from '../../components/DataTable';
import { Dialog } from '../../components/Dialog';
import { ProblemAlert } from '../../components/ProblemAlert';
import { Badge, Button, Card, PageHeader } from '../../components/ui';
import { RequireOrgPermission } from '../../layout/guards';
import { useAuth } from '../../lib/auth';
import { display, formatDateTime, formatDuration, str } from '../../lib/format';
import { useOrgId } from '../../lib/org';
import { can } from '../../lib/permissions';
import { useCursorList } from '../../lib/queries';
import { toBody, type FieldDef } from '../resource/form';
import { ResourceForm } from '../resource/ResourceForm';
import { VoucherCodes, type CreatedBatch } from './VoucherCodes';

const BATCH_FIELDS: FieldDef[] = [
  { name: 'name', label: 'Batch name', type: 'text', required: true },
  { name: 'count', label: 'Number of vouchers', type: 'number', required: true, min: 1, max: 1000 },
  { name: 'code_length', label: 'Code length', type: 'number', min: 6, max: 32 },
  {
    name: 'site_id',
    label: 'Site',
    type: 'select',
    optionsFrom: { path: '/api/v1/orgs/{orgId}/sites', label: (r) => str(r.name ?? r.id) },
  },
  {
    name: 'policy_id',
    label: 'Policy',
    type: 'select',
    optionsFrom: { path: '/api/v1/orgs/{orgId}/policies', label: (r) => str(r.name ?? r.id) },
  },
  { name: 'valid_from', label: 'Valid from', type: 'datetime' },
  { name: 'valid_until', label: 'Valid until', type: 'datetime' },
  {
    name: 'duration_s',
    label: 'Duration after first use (s)',
    type: 'number',
    min: 60,
    hint: 'D-037: re-login allowed until this duration expires.',
  },
  {
    name: 'max_uses',
    label: 'Max logins',
    type: 'number',
    min: 1,
    hint: 'D-037: both limits apply when both are set.',
  },
  { name: 'max_devices', label: 'Max devices', type: 'number', min: 1 },
];

type BatchBody = RequestBody<'/api/v1/orgs/{orgId}/voucher-batches', 'post'>;

function BatchVouchers({
  orgId,
  batch,
  onClose,
}: {
  orgId: string;
  batch: Row;
  onClose: () => void;
}) {
  const { me } = useAuth();
  const qc = useQueryClient();
  const key = ['org', orgId, 'voucher-batch', batch.id];
  const list = useCursorList<Row>(
    key,
    (cursor, signal) =>
      api('get', '/api/v1/orgs/{orgId}/voucher-batches/{id}/vouchers', {
        params: { orgId, id: batch.id },
        query: { limit: 100, cursor },
        signal,
      }) as Promise<Page<Row>>,
  );
  const revoke = useMutation({
    mutationFn: (id: string) =>
      api('post', '/api/v1/orgs/{orgId}/vouchers/{id}/revoke', { params: { orgId, id } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: key }),
  });
  const canRevoke = can(me, 'voucher:revoke', {
    organizationId: orgId,
    siteId: (batch.site_id as string) ?? null,
    anySite: true,
  });
  return (
    <Dialog open title={`Vouchers in “${str(batch.name)}”`} onClose={onClose} wide>
      <div className="space-y-3">
        <p className="text-xs text-subtle">Codes are stored hashed; only a hint is shown.</p>
        <ProblemAlert error={revoke.error} />
        <DataTable
          caption="Vouchers"
          rows={list.rows}
          rowKey={(r) => r.id}
          loading={list.isPending}
          error={list.error}
          hasMore={list.hasNextPage}
          loadingMore={list.isFetchingNextPage}
          onLoadMore={() => void list.fetchNextPage()}
          columns={[
            {
              key: 'code_hint',
              header: 'Hint',
              render: (r) => <code>{display(r.code_hint)}</code>,
            },
            {
              key: 'status',
              header: 'Status',
              render: (r) => (
                <Badge tone={r.status === 'revoked' ? 'danger' : 'neutral'}>
                  {display(r.status)}
                </Badge>
              ),
            },
            { key: 'use_count', header: 'Uses' },
            {
              key: 'activated_at',
              header: 'Activated',
              render: (r) => formatDateTime(r.activated_at),
            },
            { key: 'expires_at', header: 'Expires', render: (r) => formatDateTime(r.expires_at) },
            {
              key: 'actions',
              header: 'Actions',
              render: (r) =>
                canRevoke && r.status !== 'revoked' ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-danger"
                    busy={revoke.isPending && revoke.variables === r.id}
                    onClick={() => revoke.mutate(r.id)}
                  >
                    Revoke
                  </Button>
                ) : null,
            },
          ]}
        />
      </div>
    </Dialog>
  );
}

function VouchersScreen() {
  const orgId = useOrgId();
  const { me } = useAuth();
  const qc = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [created, setCreated] = useState<CreatedBatch | null>(null);
  const [viewing, setViewing] = useState<Row | null>(null);
  const [idemKey, setIdemKey] = useState(newIdempotencyKey);

  const list = useCursorList<Row>(['org', orgId, 'voucher-batches'], (cursor, signal) =>
    request<Page<Row>>(
      'get',
      buildUrl('/api/v1/orgs/{orgId}/voucher-batches', { orgId }, { limit: 50, cursor }),
      { signal },
    ),
  );
  const create = useMutation({
    mutationFn: (body: BatchBody) =>
      api('post', '/api/v1/orgs/{orgId}/voucher-batches', {
        params: { orgId },
        body,
        idempotencyKey: idemKey,
      }),
    onSuccess: (res) => {
      const r = res as Record<string, unknown>;
      setCreated({
        id: str(r.id),
        name: str(r.name ?? ''),
        codes: Array.isArray(r.codes) ? r.codes.map(String) : [],
        valid_until: (r.valid_until as string | null) ?? null,
        duration_s: (r.duration_s as number | null) ?? null,
        max_uses: (r.max_uses as number | null) ?? null,
      });
      setCreating(false);
      setIdemKey(newIdempotencyKey());
      void qc.invalidateQueries({ queryKey: ['org', orgId, 'voucher-batches'] });
    },
    onError: (e) => setProblem(problemOf(e)),
  });

  if (created) return <VoucherCodes batch={created} onDone={() => setCreated(null)} />;

  return (
    <div>
      <PageHeader
        title="Vouchers"
        description="Generate voucher batches. Codes are displayed once at creation for printing or distribution."
        actions={
          can(me, 'voucher:create', { organizationId: orgId, anySite: true }) ? (
            <Button
              variant="primary"
              onClick={() => {
                setProblem(null);
                setCreating(true);
              }}
            >
              New batch
            </Button>
          ) : null
        }
      />
      <Card>
        <DataTable
          caption="Voucher batches"
          rows={list.rows}
          rowKey={(r) => r.id}
          loading={list.isPending}
          error={list.error}
          emptyTitle="No voucher batches yet"
          hasMore={list.hasNextPage}
          loadingMore={list.isFetchingNextPage}
          onLoadMore={() => void list.fetchNextPage()}
          columns={[
            { key: 'name', header: 'Name' },
            { key: 'count', header: 'Count' },
            {
              key: 'duration_s',
              header: 'Duration',
              render: (r) => (r.duration_s ? formatDuration(r.duration_s) : '—'),
            },
            { key: 'max_uses', header: 'Max uses' },
            {
              key: 'valid_until',
              header: 'Valid until',
              render: (r) => formatDateTime(r.valid_until),
            },
            { key: 'created_at', header: 'Created', render: (r) => formatDateTime(r.created_at) },
            {
              key: 'actions',
              header: 'Actions',
              render: (r) => (
                <Button size="sm" onClick={() => setViewing(r)}>
                  Vouchers
                </Button>
              ),
            },
          ]}
        />
      </Card>
      <Dialog open={creating} title="New voucher batch" onClose={() => setCreating(false)} wide>
        <ResourceForm
          orgId={orgId}
          fields={BATCH_FIELDS}
          mode="create"
          submitLabel="Generate"
          busy={create.isPending}
          problem={problem}
          onCancel={() => setCreating(false)}
          onSubmit={(values) => {
            setProblem(null);
            create.mutate(toBody(BATCH_FIELDS, values, 'create') as BatchBody);
          }}
        />
      </Dialog>
      {viewing ? (
        <BatchVouchers orgId={orgId} batch={viewing} onClose={() => setViewing(null)} />
      ) : null}
    </div>
  );
}

export function VouchersPage() {
  return (
    <RequireOrgPermission permission="voucher:read">
      <VouchersScreen />
    </RequireOrgPermission>
  );
}
