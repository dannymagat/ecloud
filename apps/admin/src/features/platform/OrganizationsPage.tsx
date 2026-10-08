import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { api, newIdempotencyKey, type RequestBody } from '../../api/client';
import { problemOf, type Problem } from '../../api/problem';
import type { Row } from '../../api/types';
import { DataTable } from '../../components/DataTable';
import { Dialog } from '../../components/Dialog';
import { Badge, Button, Card, PageHeader } from '../../components/ui';
import { RequirePlatformPermission } from '../../layout/guards';
import { useAuth } from '../../lib/auth';
import { display, formatDateTime, str } from '../../lib/format';
import { canPlatform } from '../../lib/permissions';
import { toBody, type FieldDef } from '../resource/form';
import { ResourceForm } from '../resource/ResourceForm';
import { ImpersonateForm } from './ImpersonateForm';
import { usePlatformOrganizations } from './usePlatformOrgs';

const LIMIT_FIELDS: FieldDef[] = [
  { name: 'max_sites', label: 'Max sites', type: 'number', min: 0, nullable: true },
  { name: 'max_devices', label: 'Max devices', type: 'number', min: 0, nullable: true },
  { name: 'max_users', label: 'Max users', type: 'number', min: 0, nullable: true },
  {
    name: 'max_concurrent_sessions',
    label: 'Max concurrent sessions',
    type: 'number',
    min: 0,
    nullable: true,
  },
];

const CREATE_FIELDS: FieldDef[] = [
  { name: 'name', label: 'Name', type: 'text', required: true },
  {
    name: 'slug',
    label: 'Slug',
    type: 'text',
    required: true,
    hint: 'Lowercase letters, digits and dashes.',
  },
  ...LIMIT_FIELDS,
];

const EDIT_FIELDS: FieldDef[] = [
  { name: 'name', label: 'Name', type: 'text', required: true },
  {
    name: 'status',
    label: 'Status',
    type: 'select',
    required: true,
    options: [
      { value: 'active', label: 'Active' },
      { value: 'suspended', label: 'Suspended' },
      { value: 'archived', label: 'Archived' },
    ],
  },
  ...LIMIT_FIELDS,
];

function Screen() {
  const { me } = useAuth();
  const qc = useQueryClient();
  const list = usePlatformOrganizations();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Row | null>(null);
  const [impersonating, setImpersonating] = useState<Row | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [idemKey, setIdemKey] = useState(newIdempotencyKey);
  const refresh = () => void qc.invalidateQueries({ queryKey: ['platform', 'organizations'] });

  const create = useMutation({
    mutationFn: (body: RequestBody<'/api/v1/platform/organizations', 'post'>) =>
      api('post', '/api/v1/platform/organizations', { body, idempotencyKey: idemKey }),
    onSuccess: () => {
      refresh();
      setCreating(false);
      setIdemKey(newIdempotencyKey());
    },
    onError: (e) => setProblem(problemOf(e)),
  });
  const update = useMutation({
    mutationFn: ({
      id,
      body,
    }: {
      id: string;
      body: RequestBody<'/api/v1/platform/organizations/{id}', 'patch'>;
    }) => api('patch', '/api/v1/platform/organizations/{id}', { params: { id }, body }),
    onSuccess: () => {
      refresh();
      setEditing(null);
    },
    onError: (e) => setProblem(problemOf(e)),
  });

  const canCreate = canPlatform(me, 'organization:create');
  const canUpdate = canPlatform(me, 'organization:update');
  const canImpersonate = canPlatform(me, 'tenant:impersonate');
  const orgOptions = list.rows.map((r) => ({ id: r.id, name: str(r.name ?? r.id) }));

  return (
    <div>
      <PageHeader
        title="Organizations"
        description="Tenants of the platform."
        actions={
          canCreate ? (
            <Button
              variant="primary"
              onClick={() => {
                setProblem(null);
                setCreating(true);
              }}
            >
              New organization
            </Button>
          ) : null
        }
      />
      <Card>
        <DataTable
          caption="Organizations"
          rows={list.rows}
          rowKey={(r) => r.id}
          loading={list.isPending}
          error={list.error}
          emptyTitle="No organizations yet"
          hasMore={list.hasNextPage}
          loadingMore={list.isFetchingNextPage}
          onLoadMore={() => void list.fetchNextPage()}
          columns={[
            {
              key: 'name',
              header: 'Name',
              render: (r) => (
                <Link
                  to={`/orgs/${r.id}/dashboard`}
                  className="font-medium text-primary hover:underline"
                >
                  {display(r.name)}
                </Link>
              ),
            },
            { key: 'slug', header: 'Slug' },
            {
              key: 'status',
              header: 'Status',
              render: (r) => (
                <Badge tone={r.status === 'active' ? 'success' : 'warning'}>
                  {display(r.status)}
                </Badge>
              ),
            },
            { key: 'max_sites', header: 'Max sites' },
            { key: 'max_users', header: 'Max users' },
            { key: 'created_at', header: 'Created', render: (r) => formatDateTime(r.created_at) },
            {
              key: 'actions',
              header: 'Actions',
              render: (r) => (
                <div className="flex gap-1">
                  {canUpdate ? (
                    <Button
                      size="sm"
                      onClick={() => {
                        setProblem(null);
                        setEditing(r);
                      }}
                    >
                      Edit
                    </Button>
                  ) : null}
                  {canImpersonate && r.status === 'active' ? (
                    <Button size="sm" onClick={() => setImpersonating(r)}>
                      Impersonate
                    </Button>
                  ) : null}
                </div>
              ),
            },
          ]}
        />
      </Card>
      <Dialog open={creating} title="New organization" onClose={() => setCreating(false)} wide>
        <ResourceForm
          orgId=""
          fields={CREATE_FIELDS}
          mode="create"
          submitLabel="Create"
          busy={create.isPending}
          problem={problem}
          onCancel={() => setCreating(false)}
          onSubmit={(v) =>
            create.mutate(
              toBody(CREATE_FIELDS, v, 'create') as RequestBody<
                '/api/v1/platform/organizations',
                'post'
              >,
            )
          }
        />
      </Dialog>
      <Dialog
        open={editing !== null}
        title="Edit organization"
        onClose={() => setEditing(null)}
        wide
      >
        {editing ? (
          <ResourceForm
            key={editing.id}
            orgId=""
            fields={EDIT_FIELDS}
            mode="edit"
            row={editing}
            submitLabel="Save"
            busy={update.isPending}
            problem={problem}
            onCancel={() => setEditing(null)}
            onSubmit={(v, original) =>
              update.mutate({ id: editing.id, body: toBody(EDIT_FIELDS, v, 'edit', original) })
            }
          />
        ) : null}
      </Dialog>
      <Dialog
        open={impersonating !== null}
        title="Start impersonation"
        onClose={() => setImpersonating(null)}
      >
        {impersonating ? (
          <ImpersonateForm
            organizations={orgOptions}
            initialOrganizationId={impersonating.id}
            onCancel={() => setImpersonating(null)}
          />
        ) : null}
      </Dialog>
    </div>
  );
}

export function OrganizationsPage() {
  return (
    <RequirePlatformPermission anyOf={['tenant:list']}>
      <Screen />
    </RequirePlatformPermission>
  );
}
