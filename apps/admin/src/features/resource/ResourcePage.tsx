/**
 * Generic organization resource screen: cursor-paginated list, create / edit / delete dialogs,
 * permission-gated actions, problem+json errors, optional secret-shown-once after create.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import { buildUrl, newIdempotencyKey, request } from '../../api/client';
import { problemOf, type Problem } from '../../api/problem';
import type { Page, Row } from '../../api/types';
import { DataTable, type Column } from '../../components/DataTable';
import { Dialog } from '../../components/Dialog';
import { ProblemAlert } from '../../components/ProblemAlert';
import { SecretOnce } from '../../components/SecretOnce';
import { Button, Card, Notice, PageHeader } from '../../components/ui';
import { useAuth } from '../../lib/auth';
import { useOrgId } from '../../lib/org';
import { can } from '../../lib/permissions';
import { useCursorList } from '../../lib/queries';
import { SITE_PARAM, siteParam, useSiteName } from '../../lib/sites';
import { RequireOrgPermission } from '../../layout/guards';
import { toBody, type FieldDef, type FormValues } from './form';
import type { OrgCollectionPath } from './paths';
import { ResourceForm } from './ResourceForm';
import { str } from '../../lib/format';

export interface ResourceConfig {
  title: string;
  singular: string;
  description?: ReactNode;
  path: OrgCollectionPath;
  permissions: { read: string; create?: string; update?: string; delete?: string };
  columns: Column<Row>[];
  fields: FieldDef[];
  /** Fields editable via PATCH (defaults to all non-createOnly fields). */
  editFields?: FieldDef[];
  /** Response key holding a value shown once after create (e.g. `secret`, `key`, `token`). */
  secretOnCreate?: { key: string; title: string; description?: string };
  query?: Record<string, string>;
  /**
   * The list endpoint accepts `site_id`: a `?site_id=` in the page URL (dashboard tiles, the
   * top-bar site chip) filters the list to that site.
   */
  siteFilter?: boolean;
  rowActions?: (row: Row, ctx: { orgId: string; refresh: () => void }) => ReactNode;
  headerActions?: (ctx: { orgId: string; refresh: () => void }) => ReactNode;
  emptyHint?: ReactNode;
}

export function ResourcePage({
  config,
  embedded = false,
}: {
  config: ResourceConfig;
  embedded?: boolean;
}) {
  return (
    <RequireOrgPermission permission={config.permissions.read}>
      <ResourceScreen config={config} embedded={embedded} />
    </RequireOrgPermission>
  );
}

function ResourceScreen({ config, embedded }: { config: ResourceConfig; embedded: boolean }) {
  const orgId = useOrgId();
  const { me } = useAuth();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const siteId = config.siteFilter ? siteParam(params) : null;
  const siteName = useSiteName(me, orgId, siteId);
  const query = siteId ? { ...config.query, [SITE_PARAM]: siteId } : config.query;
  const key = ['org', orgId, config.path, query];
  const list = useCursorList<Row>(key, (cursor, signal) =>
    request<Page<Row>>('get', buildUrl(config.path, { orgId }, { limit: 50, cursor, ...query }), {
      signal,
      pathTemplate: config.path,
    }),
  );
  const refresh = () => void qc.invalidateQueries({ queryKey: ['org', orgId] });

  const target = { organizationId: orgId, anySite: true };
  const canCreate = config.permissions.create ? can(me, config.permissions.create, target) : false;
  const canUpdate = config.permissions.update ? can(me, config.permissions.update, target) : false;
  const canDelete = config.permissions.delete ? can(me, config.permissions.delete, target) : false;

  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Row | null>(null);
  const [deleting, setDeleting] = useState<Row | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [idemKey, setIdemKey] = useState(newIdempotencyKey);

  const itemUrl = (id: string) =>
    `${buildUrl(config.path, { orgId }, undefined)}/${encodeURIComponent(id)}`;

  const create = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      request<Row>('post', buildUrl(config.path, { orgId }, undefined), {
        body,
        idempotencyKey: idemKey,
        pathTemplate: config.path,
      }),
    onSuccess: (row) => {
      refresh();
      setIdemKey(newIdempotencyKey());
      const value = config.secretOnCreate ? row[config.secretOnCreate.key] : undefined;
      if (typeof value === 'string') setSecret(value);
      else setCreating(false);
    },
    onError: (e) => setProblem(problemOf(e)),
  });
  const update = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) =>
      request<Row>('patch', itemUrl(id), { body, pathTemplate: `${config.path}/{id}` }),
    onSuccess: () => {
      refresh();
      setEditing(null);
    },
    onError: (e) => setProblem(problemOf(e)),
  });
  const remove = useMutation({
    mutationFn: (id: string) =>
      request<void>('delete', itemUrl(id), { pathTemplate: `${config.path}/{id}` }),
    onSuccess: () => {
      refresh();
      setDeleting(null);
    },
  });

  const editFields = config.editFields ?? config.fields.filter((f) => !f.createOnly);
  const showActions = canUpdate || canDelete || config.rowActions !== undefined;
  const columns: Column<Row>[] = showActions
    ? [
        ...config.columns,
        {
          key: '__actions',
          header: 'Actions',
          render: (row) => (
            <div className="flex flex-wrap gap-1">
              {config.rowActions?.(row, { orgId, refresh })}
              {canUpdate && editFields.length > 0 ? (
                <Button
                  size="sm"
                  onClick={() => {
                    setProblem(null);
                    setEditing(row);
                  }}
                >
                  Edit
                </Button>
              ) : null}
              {canDelete ? (
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-danger"
                  onClick={() => setDeleting(row)}
                >
                  Delete
                </Button>
              ) : null}
            </div>
          ),
        },
      ]
    : config.columns;

  const headerActions = (
    <>
      {config.headerActions?.({ orgId, refresh })}
      {canCreate ? (
        <Button
          variant="primary"
          onClick={() => {
            setProblem(null);
            setSecret(null);
            setCreating(true);
          }}
        >
          New {config.singular.toLowerCase()}
        </Button>
      ) : null}
    </>
  );

  return (
    <div>
      {embedded ? null : (
        <PageHeader title={config.title} description={config.description} actions={headerActions} />
      )}
      <Card
        title={embedded ? config.title : undefined}
        actions={embedded ? headerActions : undefined}
      >
        {embedded && config.description ? (
          <p className="mb-3 text-sm text-subtle">{config.description}</p>
        ) : null}
        {siteId ? (
          <div className="mb-3" data-site-filter>
            <Notice tone="info">
              Showing {config.title.toLowerCase()} of {siteName ?? 'one site'} only.{' '}
              <button
                type="button"
                className="font-medium underline hover:no-underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
                onClick={() =>
                  setParams(
                    (prev) => {
                      const next = new URLSearchParams(prev);
                      next.delete(SITE_PARAM);
                      return next;
                    },
                    { replace: true },
                  )
                }
              >
                Show all sites
              </button>
            </Notice>
          </div>
        ) : null}
        <DataTable
          caption={config.title}
          columns={columns}
          rows={list.rows}
          rowKey={(r) => r.id}
          loading={list.isPending}
          error={list.error}
          emptyTitle={`No ${config.title.toLowerCase()} yet`}
          emptyHint={config.emptyHint}
          hasMore={list.hasNextPage}
          loadingMore={list.isFetchingNextPage}
          onLoadMore={() => void list.fetchNextPage()}
        />
      </Card>

      <Dialog
        open={creating}
        title={secret ? `${config.singular} created` : `New ${config.singular.toLowerCase()}`}
        onClose={() => {
          setCreating(false);
          setSecret(null);
        }}
        wide
      >
        {secret && config.secretOnCreate ? (
          <SecretOnce
            title={config.secretOnCreate.title}
            value={secret}
            description={config.secretOnCreate.description}
            onDone={() => {
              setSecret(null);
              setCreating(false);
            }}
          />
        ) : (
          <ResourceForm
            orgId={orgId}
            fields={config.fields}
            mode="create"
            submitLabel="Create"
            busy={create.isPending}
            problem={problem}
            onCancel={() => setCreating(false)}
            onSubmit={(values: FormValues) => {
              setProblem(null);
              create.mutate(toBody(config.fields, values, 'create'));
            }}
          />
        )}
      </Dialog>

      <Dialog
        open={editing !== null}
        title={`Edit ${config.singular.toLowerCase()}`}
        onClose={() => setEditing(null)}
        wide
      >
        {editing ? (
          <ResourceForm
            key={editing.id}
            orgId={orgId}
            fields={editFields}
            mode="edit"
            row={editing}
            submitLabel="Save"
            busy={update.isPending}
            problem={problem}
            onCancel={() => setEditing(null)}
            onSubmit={(values, original) => {
              setProblem(null);
              const body = toBody(editFields, values, 'edit', original);
              if (Object.keys(body).length === 0) setEditing(null);
              else update.mutate({ id: editing.id, body });
            }}
          />
        ) : null}
      </Dialog>

      <Dialog
        open={deleting !== null}
        title={`Delete ${config.singular.toLowerCase()}?`}
        onClose={() => setDeleting(null)}
      >
        <p className="text-sm">
          This removes{' '}
          <strong>{str(deleting?.name ?? deleting?.username ?? deleting?.id ?? '')}</strong>. This
          action is audited.
        </p>
        <div className="mt-3">
          <ProblemAlert error={remove.error} />
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button onClick={() => setDeleting(null)}>Cancel</Button>
          <Button
            variant="danger"
            busy={remove.isPending}
            onClick={() => deleting && remove.mutate(deleting.id)}
          >
            Delete
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
