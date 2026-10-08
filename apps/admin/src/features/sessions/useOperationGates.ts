/**
 * Per-session Disconnect / Re-authorize gates from the session detail's `operations` registry
 * evidence (P8-A contract §2), the caller's permission on the session's site and the presence
 * of the POST endpoints in the live OpenAPI document.
 */
import {
  OPERATION_PERMISSION,
  operationGate,
  SESSION_DISCONNECT_PATH,
  SESSION_REAUTHORIZE_PATH,
  type OperationGate,
  type SessionDetail,
  type SessionRow,
  type SessionOperation,
} from '../../lib/accounting';
import { hasOperation, useApiDocument } from '../../lib/apiDoc';
import { useAuth } from '../../lib/auth';
import { can } from '../../lib/permissions';

export function useOperationGates(orgId: string) {
  const { me } = useAuth();
  const doc = useApiDocument();
  const endpoint: Record<SessionOperation, boolean> = {
    disconnect: hasOperation(doc.data, 'post', SESSION_DISCONNECT_PATH),
    reauthorize: hasOperation(doc.data, 'post', SESSION_REAUTHORIZE_PATH),
  };
  return (
    session: SessionRow & { operations?: SessionDetail['operations'] },
    operation: SessionOperation,
  ): OperationGate =>
    doc.isPending
      ? { enabled: false, reason: 'Checking which operations the API supports…' }
      : operationGate({
          operation,
          hasPermission: can(me, OPERATION_PERMISSION[operation], {
            organizationId: orgId,
            siteId: session.site_id ?? null,
          }),
          endpointAvailable: endpoint[operation],
          availability: session.operations?.[operation],
        });
}
