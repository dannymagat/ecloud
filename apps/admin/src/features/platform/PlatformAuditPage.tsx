import { buildUrl, request } from '../../api/client';
import type { Page, Row } from '../../api/types';
import { Unavailable } from '../../components/Unavailable';
import { PageHeader, Spinner } from '../../components/ui';
import { RequirePlatformPermission } from '../../layout/guards';
import { hasOperation, useApiDocument } from '../../lib/apiDoc';
import { AuditLogView } from '../audit/AuditLogView';

export const PLATFORM_AUDIT_PATH = '/api/v1/platform/audit-log';

function Screen() {
  const doc = useApiDocument();
  return (
    <div>
      <PageHeader
        title="Platform audit log"
        description="Platform-level events: organizations, impersonation, administrator security actions."
      />
      {doc.isPending ? (
        <Spinner label="Loading…" />
      ) : hasOperation(doc.data, 'get', PLATFORM_AUDIT_PATH) ? (
        <AuditLogView
          queryKey={['platform', 'audit-log']}
          fetchPage={(cursor, f, signal) =>
            request<Page<Row>>(
              'get',
              buildUrl(PLATFORM_AUDIT_PATH, undefined, {
                limit: 50,
                cursor,
                action: f.action,
                from: f.from,
                to: f.to,
              }),
              { signal },
            )
          }
        />
      ) : (
        <Unavailable endpoint={`GET ${PLATFORM_AUDIT_PATH}`} />
      )}
    </div>
  );
}

export function PlatformAuditPage() {
  return (
    <RequirePlatformPermission anyOf={['audit_log:read']}>
      <Screen />
    </RequirePlatformPermission>
  );
}
