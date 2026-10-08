/** Paginated audit events with filters; shared by the organization and platform screens. */
import { useState } from 'react';
import type { Page, Row } from '../../api/types';
import { DataTable } from '../../components/DataTable';
import { Badge, Card, TextField } from '../../components/ui';
import { formatDateTime, localInputToIso, str } from '../../lib/format';
import { useCursorList } from '../../lib/queries';

export interface AuditFilters {
  action?: string;
  from?: string;
  to?: string;
}

function Diff({ row }: { row: Row }) {
  if (!row.before && !row.after) return <span className="text-subtle">—</span>;
  return (
    <details>
      <summary className="cursor-pointer text-primary">Changes</summary>
      <pre className="mt-1 max-w-md overflow-x-auto whitespace-pre-wrap rounded bg-muted p-2 text-xs">
        {JSON.stringify({ before: row.before ?? null, after: row.after ?? null }, null, 2)}
      </pre>
    </details>
  );
}

export function AuditLogView({
  queryKey,
  fetchPage,
}: {
  queryKey: readonly unknown[];
  fetchPage: (
    cursor: string | undefined,
    filters: AuditFilters,
    signal: AbortSignal,
  ) => Promise<Page<Row>>;
}) {
  const [action, setAction] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const filters: AuditFilters = {
    action: action.trim() || undefined,
    from: localInputToIso(from) ?? undefined,
    to: localInputToIso(to) ?? undefined,
  };
  const list = useCursorList<Row>([...queryKey, filters], (cursor, signal) =>
    fetchPage(cursor, filters, signal),
  );
  return (
    <Card>
      <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <TextField
          label="Action"
          placeholder="e.g. nas:create"
          value={action}
          onChange={(e) => setAction(e.target.value)}
        />
        <TextField
          label="From"
          type="datetime-local"
          value={from}
          onChange={(e) => setFrom(e.target.value)}
        />
        <TextField
          label="To"
          type="datetime-local"
          value={to}
          onChange={(e) => setTo(e.target.value)}
        />
      </div>
      <DataTable
        caption="Audit events"
        rows={list.rows}
        rowKey={(r) => r.id}
        loading={list.isPending}
        error={list.error}
        emptyTitle="No audit events match"
        hasMore={list.hasNextPage}
        loadingMore={list.isFetchingNextPage}
        onLoadMore={() => void list.fetchNextPage()}
        columns={[
          { key: 'created_at', header: 'Time', render: (r) => formatDateTime(r.created_at) },
          {
            key: 'action',
            header: 'Action',
            render: (r) => <code className="text-xs">{str(r.action ?? '—')}</code>,
          },
          {
            key: 'actor',
            header: 'Actor',
            render: (r) => (
              <span className="text-xs">
                {str(r.actor_type ?? '')} <code>{str(r.actor_id ?? '—')}</code>
                {r.impersonator_id ? (
                  <Badge tone="warning" title={`Impersonated by ${str(r.impersonator_id)}`}>
                    impersonated
                  </Badge>
                ) : null}
              </span>
            ),
          },
          {
            key: 'target',
            header: 'Target',
            render: (r) => (
              <span className="text-xs">
                {str(r.target_type ?? '')} <code>{str(r.target_id ?? '—')}</code>
              </span>
            ),
          },
          { key: 'ip', header: 'IP' },
          {
            key: 'diff',
            header: 'Details',
            render: (r) => <Diff row={r} />,
            className: 'px-3 py-2 align-top',
          },
        ]}
      />
    </Card>
  );
}
