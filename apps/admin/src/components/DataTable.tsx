import type { ReactNode } from 'react';
import { str } from '../lib/format';
import { ProblemAlert } from './ProblemAlert';
import { Button, EmptyState, Spinner } from './ui';

export interface Column<T> {
  key: string;
  header: string;
  render?: (row: T) => ReactNode;
  className?: string;
}

export interface DataTableProps<T> {
  caption: string;
  columns: readonly Column<T>[];
  rows: readonly T[];
  rowKey: (row: T, index: number) => string;
  loading?: boolean;
  error?: unknown;
  emptyTitle?: string;
  emptyHint?: ReactNode;
  hasMore?: boolean;
  loadingMore?: boolean;
  onLoadMore?: () => void;
}

function cell(value: unknown): ReactNode {
  if (value === null || value === undefined || value === '')
    return <span className="text-subtle">—</span>;
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'object') return <code className="text-xs">{JSON.stringify(value)}</code>;
  return str(value);
}

export function DataTable<T>({
  caption,
  columns,
  rows,
  rowKey,
  loading,
  error,
  emptyTitle = 'Nothing here yet',
  emptyHint,
  hasMore,
  loadingMore,
  onLoadMore,
}: DataTableProps<T>) {
  if (loading) return <Spinner label={`Loading ${caption.toLowerCase()}…`} />;
  if (error && rows.length === 0) return <ProblemAlert error={error} />;
  if (rows.length === 0) return <EmptyState title={emptyTitle}>{emptyHint}</EmptyState>;
  return (
    <div className="space-y-3">
      {error ? <ProblemAlert error={error} /> : null}
      <div className="relative overflow-x-auto rounded-md border border-border">
        <table className="min-w-full divide-y divide-border text-sm">
          <caption className="sr-only">{caption}</caption>
          <thead className="bg-muted/60">
            <tr>
              {columns.map((c) => (
                <th
                  key={c.key}
                  scope="col"
                  className="whitespace-nowrap px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-subtle"
                >
                  {c.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border bg-surface">
            {rows.map((row, index) => (
              <tr key={rowKey(row, index)} className="hover:bg-muted/40">
                {columns.map((c) => (
                  <td
                    key={c.key}
                    className={c.className ?? 'whitespace-nowrap px-3 py-2 align-top'}
                  >
                    {c.render ? c.render(row) : cell((row as Record<string, unknown>)[c.key])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {hasMore && onLoadMore ? (
        <Button size="sm" onClick={onLoadMore} busy={loadingMore}>
          Load more
        </Button>
      ) : null}
    </div>
  );
}
