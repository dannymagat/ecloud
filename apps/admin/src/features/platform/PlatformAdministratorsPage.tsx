import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { buildUrl, request } from '../../api/client';
import type { Page, Row } from '../../api/types';
import { DataTable } from '../../components/DataTable';
import { Unavailable } from '../../components/Unavailable';
import { Badge, Button, Card, PageHeader, Spinner } from '../../components/ui';
import { RequirePlatformPermission } from '../../layout/guards';
import { hasOperation, useApiDocument } from '../../lib/apiDoc';
import { useAuth } from '../../lib/auth';
import { display, formatDateTime, str } from '../../lib/format';
import { canPlatform } from '../../lib/permissions';
import { useCursorList } from '../../lib/queries';
import { MFA_RESET_PATH, MfaResetDialog } from './MfaResetDialog';

export const PLATFORM_ADMINS_PATH = '/api/v1/platform/administrators';
export const MFA_RESET_PERMISSION = 'administrator:mfa_reset';

function AdminList({ resetAvailable }: { resetAvailable: boolean }) {
  const { me } = useAuth();
  const qc = useQueryClient();
  const [target, setTarget] = useState<Row | null>(null);
  const list = useCursorList<Row>(['platform', 'administrators'], (cursor, signal) =>
    request<Page<Row>>('get', buildUrl(PLATFORM_ADMINS_PATH, undefined, { limit: 50, cursor }), {
      signal,
    }),
  );
  const mayReset = resetAvailable && canPlatform(me, MFA_RESET_PERMISSION);
  const reason = !resetAvailable
    ? `The API does not provide ${MFA_RESET_PATH} yet.`
    : `Requires ${MFA_RESET_PERMISSION} at platform scope.`;
  return (
    <Card>
      <DataTable
        caption="Platform administrators"
        rows={list.rows}
        rowKey={(r) => r.id}
        loading={list.isPending}
        error={list.error}
        hasMore={list.hasNextPage}
        loadingMore={list.isFetchingNextPage}
        onLoadMore={() => void list.fetchNextPage()}
        columns={[
          { key: 'email', header: 'Email' },
          { key: 'display_name', header: 'Name' },
          {
            key: 'status',
            header: 'Status',
            render: (r) => (
              <Badge tone={r.status === 'active' ? 'success' : 'warning'}>
                {display(r.status)}
              </Badge>
            ),
          },
          {
            key: 'mfa',
            header: 'MFA',
            render: (r) => display(r.mfa_enrolled ?? (r.mfa as Row | undefined)?.enrolled),
          },
          {
            key: 'last_login_at',
            header: 'Last login',
            render: (r) => formatDateTime(r.last_login_at),
          },
          {
            key: 'actions',
            header: 'Actions',
            render: (r) => (
              <span title={mayReset ? undefined : reason}>
                <Button
                  size="sm"
                  variant="danger"
                  disabled={!mayReset || r.id === (me?.kind === 'admin' ? me.administrator.id : '')}
                  onClick={() => setTarget(r)}
                >
                  Reset MFA
                </Button>
              </span>
            ),
          },
        ]}
      />
      {target ? (
        <MfaResetDialog
          administrator={{ id: target.id, email: str(target.email ?? target.id) }}
          onClose={() => setTarget(null)}
          onDone={() => void qc.invalidateQueries({ queryKey: ['platform', 'administrators'] })}
        />
      ) : null}
    </Card>
  );
}

function Screen() {
  const doc = useApiDocument();
  return (
    <div>
      <PageHeader
        title="Platform administrators"
        description="Accounts with platform bindings. MFA is mandatory for them only when ADMIN_MFA_MODE=required (D-046)."
      />
      {doc.isPending ? (
        <Spinner label="Loading…" />
      ) : hasOperation(doc.data, 'get', PLATFORM_ADMINS_PATH) ? (
        <AdminList resetAvailable={hasOperation(doc.data, 'post', MFA_RESET_PATH)} />
      ) : (
        <Unavailable endpoint={`GET ${PLATFORM_ADMINS_PATH}`} />
      )}
    </div>
  );
}

export function PlatformAdministratorsPage() {
  return (
    <RequirePlatformPermission anyOf={['administrator:read']}>
      <Screen />
    </RequirePlatformPermission>
  );
}
