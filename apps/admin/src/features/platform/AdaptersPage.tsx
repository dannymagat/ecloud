/**
 * Adapter capability catalogue: four-state status (D-028) × evidence level
 * (MULTI_VENDOR_INTEGRATION_PLAN.md §4.4) of every policy field per adapter.
 */
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client';
import type { Row } from '../../api/types';
import { DataTable } from '../../components/DataTable';
import { ProblemAlert } from '../../components/ProblemAlert';
import { StatusBadge } from '../../components/StatusBadge';
import { Card, PageHeader, Spinner } from '../../components/ui';
import { RequirePlatformPermission } from '../../layout/guards';
import { POLICY_FIELDS } from '../../lib/adapterStatus';
import { display, str } from '../../lib/format';
import { EnforceabilityMatrix, toAdapterColumns } from '../policies/EnforceabilityMatrix';

const ACTIONS = [
  { key: 'disconnect', label: 'Disconnect (RFC 5176)' },
  { key: 'coa_change', label: 'CoA change' },
  { key: 'mac_auth', label: 'MAC authentication' },
] as const;

function Screen() {
  const q = useQuery({
    queryKey: ['platform', 'adapters'],
    queryFn: ({ signal }) => api('get', '/api/v1/platform/adapters', { signal }),
  });
  if (q.isPending) return <Spinner label="Loading adapters…" />;
  if (q.error) return <ProblemAlert error={q.error} />;
  const adapters = q.data.adapters as unknown as Row[];
  const types = ((q.data as Record<string, unknown>).adapter_types ?? []) as Row[];
  return (
    <div className="space-y-6">
      <PageHeader
        title="Adapters"
        description="What each NAS adapter can enforce. Verified (source) = mechanism confirmed in source code, expected but not device-tested; Lab validated = proven on a recorded device test. No adapter is lab validated yet. Hover a badge for its evidence."
      />
      <Card title="Policy fields">
        <EnforceabilityMatrix
          adapters={toAdapterColumns(adapters)}
          fields={POLICY_FIELDS}
          caption="Adapter field capabilities"
        />
      </Card>
      <Card title="Session actions">
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="min-w-full divide-y divide-border text-sm">
            <caption className="sr-only">Session action capabilities</caption>
            <thead className="bg-muted/60">
              <tr>
                <th
                  scope="col"
                  className="px-3 py-2 text-left text-xs font-semibold uppercase text-subtle"
                >
                  Action
                </th>
                {adapters.map((a) => (
                  <th
                    key={a.key as string}
                    scope="col"
                    className="px-3 py-2 text-left text-xs font-semibold text-subtle"
                  >
                    <code>{str(a.key)}</code>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {ACTIONS.map((action) => (
                <tr key={action.key}>
                  <th scope="row" className="whitespace-nowrap px-3 py-2 text-left font-medium">
                    {action.label}
                  </th>
                  {adapters.map((a) => {
                    const cap = a[action.key] as
                      { status?: unknown; evidence?: string; evidence_level?: unknown } | undefined;
                    return (
                      <td key={a.key as string} className="px-3 py-2">
                        <StatusBadge
                          status={cap?.status}
                          evidence={cap?.evidence}
                          evidenceLevel={cap?.evidence_level}
                        />
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      {types.length > 0 ? (
        <Card title="Adapter types (database)">
          <DataTable
            caption="Adapter types"
            rows={types}
            rowKey={(r) => str(r.key ?? r.id)}
            columns={[
              {
                key: 'key',
                header: 'Key',
                render: (r) => <code className="text-xs">{display(r.key)}</code>,
              },
              { key: 'name', header: 'Name' },
              {
                key: 'engine_adapter',
                header: 'Engine adapter',
                render: (r) => <code className="text-xs">{display(r.engine_adapter)}</code>,
              },
            ]}
          />
        </Card>
      ) : null}
    </div>
  );
}

export function AdaptersPage() {
  return (
    <RequirePlatformPermission anyOf={['platform:health:read']}>
      <Screen />
    </RequirePlatformPermission>
  );
}
