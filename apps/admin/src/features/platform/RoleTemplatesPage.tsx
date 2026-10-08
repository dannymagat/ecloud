import { buildUrl, request } from '../../api/client';
import type { Page, Row } from '../../api/types';
import { DataTable } from '../../components/DataTable';
import { Unavailable } from '../../components/Unavailable';
import { Card, PageHeader, Spinner } from '../../components/ui';
import { RequirePlatformPermission } from '../../layout/guards';
import { hasOperation, useApiDocument } from '../../lib/apiDoc';
import { display, str } from '../../lib/format';
import { useCursorList } from '../../lib/queries';

export const ROLE_TEMPLATES_PATH = '/api/v1/platform/role-templates';

function TemplateList() {
  const list = useCursorList<Row>(['platform', 'role-templates'], async (cursor, signal) => {
    const res = await request<Page<Row> | Row[]>(
      'get',
      buildUrl(ROLE_TEMPLATES_PATH, undefined, { cursor }),
      { signal },
    );
    return Array.isArray(res) ? { data: res, next_cursor: null } : res;
  });
  return (
    <Card>
      <DataTable
        caption="Role templates"
        rows={list.rows}
        rowKey={(r) => str(r.id ?? r.key)}
        loading={list.isPending}
        error={list.error}
        hasMore={list.hasNextPage}
        onLoadMore={() => void list.fetchNextPage()}
        columns={[
          { key: 'name', header: 'Name' },
          {
            key: 'key',
            header: 'Key',
            render: (r) => <code className="text-xs">{display(r.key)}</code>,
          },
          { key: 'scope', header: 'Scope', render: (r) => display(r.scope ?? r.scope_type) },
          {
            key: 'version',
            header: 'Version',
            render: (r) => display(r.version ?? r.template_version),
          },
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
                  <p className="mt-1 max-w-xl font-mono text-xs">{r.permissions.join(' ')}</p>
                </details>
              ) : (
                '—'
              ),
          },
        ]}
      />
    </Card>
  );
}

function Screen() {
  const doc = useApiDocument();
  return (
    <div>
      <PageHeader
        title="Role templates"
        description="Platform-defined permission sets that organizations bind or copy."
      />
      {doc.isPending ? (
        <Spinner label="Loading…" />
      ) : hasOperation(doc.data, 'get', ROLE_TEMPLATES_PATH) ? (
        <TemplateList />
      ) : (
        <Unavailable endpoint={`GET ${ROLE_TEMPLATES_PATH}`}>
          <p className="mt-1">
            Organization screens list the templates under Administrators → Roles.
          </p>
        </Unavailable>
      )}
    </div>
  );
}

export function RoleTemplatesPage() {
  return (
    <RequirePlatformPermission anyOf={['role:read', 'platform:role_template:manage']}>
      <Screen />
    </RequirePlatformPermission>
  );
}
