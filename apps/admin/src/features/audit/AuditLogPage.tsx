import { api } from '../../api/client';
import type { Page, Row } from '../../api/types';
import { PageHeader } from '../../components/ui';
import { RequireOrgPermission } from '../../layout/guards';
import { useOrgId } from '../../lib/org';
import { AuditLogView } from './AuditLogView';

function Screen() {
  const orgId = useOrgId();
  return (
    <div>
      <PageHeader
        title="Audit log"
        description="Every change in this organization, including actions taken by support while impersonating."
      />
      <AuditLogView
        queryKey={['org', orgId, 'audit-log']}
        fetchPage={(cursor, f, signal) =>
          api('get', '/api/v1/orgs/{orgId}/audit-log', {
            params: { orgId },
            query: { limit: 50, cursor, action: f.action, from: f.from, to: f.to },
            signal,
          }) as Promise<Page<Row>>
        }
      />
    </div>
  );
}

export function AuditLogPage() {
  return (
    <RequireOrgPermission permission="audit_log:read">
      <Screen />
    </RequireOrgPermission>
  );
}
