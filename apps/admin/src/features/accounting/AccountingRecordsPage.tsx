/**
 * Accounting record browser (P8-B): raw accounting records in a required, bounded time window
 * (≤ 31 days, partition-friendly), optional filters the connected API declares, cursor paging,
 * and CSV export. Export is shown only with `accounting:export` (Read-only lacks it, Q75) and
 * never while impersonating (D-027); the API remains the authority and audits the export.
 */
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { buildUrl, downloadFile, request, saveBlob } from '../../api/client';
import type { Page } from '../../api/types';
import { DataTable } from '../../components/DataTable';
import { ProblemAlert } from '../../components/ProblemAlert';
import { Button, Card, Notice, PageHeader, Spinner, TextField } from '../../components/ui';
import { Unavailable } from '../../components/Unavailable';
import { RequireOrgPermission } from '../../layout/guards';
import {
  ACCOUNTING_EXPORT_PATH,
  ACCOUNTING_RECORDS_PATH,
  canExport,
  exportFileName,
  MAX_RECORD_RANGE_DAYS,
  validateRange,
  type AccountingRecordRow,
} from '../../lib/accounting';
import { hasOperation, hasParameter, useApiDocument } from '../../lib/apiDoc';
import { useAuth } from '../../lib/auth';
import {
  display,
  formatBytes,
  formatDateTime,
  formatDuration,
  isoToLocalInput,
  localInputToIso,
} from '../../lib/format';
import { useOrgId } from '../../lib/org';
import { useCursorList } from '../../lib/queries';

const OPTIONAL_FILTERS = [
  { name: 'username', label: 'User name' },
  { name: 'calling_station_id', label: 'Client MAC' },
  { name: 'nas_ip', label: 'NAS IP' },
  { name: 'acct_session_id', label: 'Acct-Session-Id' },
  { name: 'session_id', label: 'Session id' },
  { name: 'status_type', label: 'Record type' },
] as const;

function defaultWindow(): { from: string; to: string } {
  const to = new Date();
  const from = new Date(to.getTime() - 24 * 3600 * 1000);
  return { from: isoToLocalInput(from.toISOString()), to: isoToLocalInput(to.toISOString()) };
}

function ExportButton({
  orgId,
  query,
}: {
  orgId: string;
  query: { from: string; to: string } & Record<string, string | undefined>;
}) {
  const doc = useApiDocument();
  const method = hasOperation(doc.data, 'post', ACCOUNTING_EXPORT_PATH)
    ? 'post'
    : hasOperation(doc.data, 'get', ACCOUNTING_EXPORT_PATH)
      ? 'get'
      : null;
  const run = useMutation({
    mutationFn: async () => {
      const url =
        method === 'get'
          ? buildUrl(ACCOUNTING_EXPORT_PATH, { orgId }, query)
          : buildUrl(ACCOUNTING_EXPORT_PATH, { orgId }, undefined);
      const { blob, filename } = await downloadFile(method!, url, {
        body: method === 'post' ? query : undefined,
      });
      saveBlob(blob, filename ?? exportFileName('accounting', query.from, query.to));
    },
  });
  if (method === null) {
    return (
      <span title="Not available in this API version">
        <Button size="sm" disabled>
          Export CSV
        </Button>
      </span>
    );
  }
  return (
    <span className="inline-flex flex-col items-end gap-1">
      <Button size="sm" busy={run.isPending} onClick={() => run.mutate()}>
        Export CSV
      </Button>
      {run.error ? <ProblemAlert error={run.error} /> : null}
      {run.isSuccess ? <span className="text-xs text-subtle">Export downloaded.</span> : null}
    </span>
  );
}

function RecordsScreen() {
  const orgId = useOrgId();
  const { me } = useAuth();
  const doc = useApiDocument();
  const [from, setFrom] = useState(() => defaultWindow().from);
  const [to, setTo] = useState(() => defaultWindow().to);
  const [extra, setExtra] = useState<Record<string, string>>({});
  const available = hasOperation(doc.data, 'get', ACCOUNTING_RECORDS_PATH);

  const fromIso = localInputToIso(from);
  const toIso = localInputToIso(to);
  const rangeError = validateRange(fromIso, toIso);
  const filters: Record<string, string | undefined> = {};
  for (const f of OPTIONAL_FILTERS) {
    const v = extra[f.name]?.trim();
    if (v && hasParameter(doc.data, 'get', ACCOUNTING_RECORDS_PATH, f.name)) filters[f.name] = v;
  }
  const query = rangeError === null ? { from: fromIso!, to: toIso!, ...filters } : null;

  const list = useCursorList<AccountingRecordRow>(
    ['org', orgId, 'accounting-records', query],
    (cursor, signal) =>
      request<Page<AccountingRecordRow>>(
        'get',
        buildUrl(ACCOUNTING_RECORDS_PATH, { orgId }, { limit: 100, cursor, ...query }),
        { signal, pathTemplate: ACCOUNTING_RECORDS_PATH },
      ),
    available && query !== null,
  );
  const impersonating = me?.kind === 'admin' && me.impersonation !== null;
  const showExport = canExport(me, 'accounting:export', { organizationId: orgId, anySite: true });

  return (
    <div>
      <PageHeader
        title="Accounting records"
        description={`Raw RADIUS accounting records as received from NAS devices. Queries need a time window of at most ${MAX_RECORD_RANGE_DAYS} days.`}
        actions={
          available && showExport && query !== null ? (
            <ExportButton orgId={orgId} query={query} />
          ) : null
        }
      />
      {doc.isPending ? (
        <Spinner label="Loading…" />
      ) : !available ? (
        <Unavailable endpoint={`GET ${ACCOUNTING_RECORDS_PATH}`} />
      ) : (
        <Card>
          {impersonating ? (
            <div className="mb-3">
              <Notice tone="info">Exports are not available while impersonating.</Notice>
            </div>
          ) : null}
          <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <TextField
              label="From"
              type="datetime-local"
              required
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
            <TextField
              label="To"
              type="datetime-local"
              required
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
            {OPTIONAL_FILTERS.filter((f) =>
              hasParameter(doc.data, 'get', ACCOUNTING_RECORDS_PATH, f.name),
            ).map((f) => (
              <TextField
                key={f.name}
                label={f.label}
                value={extra[f.name] ?? ''}
                onChange={(e) => setExtra((x) => ({ ...x, [f.name]: e.target.value }))}
              />
            ))}
          </div>
          {rangeError ? (
            <Notice tone="warning" title="Choose a time window">
              {rangeError}
            </Notice>
          ) : (
            <DataTable
              caption="Accounting records"
              rows={list.rows}
              rowKey={(r) => `${r.id}:${r.received_at}`}
              loading={list.isPending}
              error={list.error}
              emptyTitle="No accounting records in this window"
              hasMore={list.hasNextPage}
              loadingMore={list.isFetchingNextPage}
              onLoadMore={() => void list.fetchNextPage()}
              columns={[
                {
                  key: 'received_at',
                  header: 'Received',
                  render: (r) => formatDateTime(r.received_at),
                },
                { key: 'status_type', header: 'Type' },
                { key: 'username', header: 'User' },
                { key: 'calling_station_id', header: 'Client MAC' },
                { key: 'framed_ip', header: 'IP' },
                {
                  key: 'nas',
                  header: 'NAS',
                  render: (r) => display(r.nas_identifier ?? r.nas_ip),
                },
                { key: 'acct_session_id', header: 'Acct-Session-Id' },
                {
                  key: 'session_time_s',
                  header: 'Session time',
                  render: (r) => formatDuration(r.session_time_s),
                },
                { key: 'input_octets', header: 'In', render: (r) => formatBytes(r.input_octets) },
                {
                  key: 'output_octets',
                  header: 'Out',
                  render: (r) => formatBytes(r.output_octets),
                },
                { key: 'terminate_cause', header: 'Cause' },
              ]}
            />
          )}
        </Card>
      )}
    </div>
  );
}

export function AccountingRecordsPage() {
  return (
    <RequireOrgPermission permission="accounting:read">
      <RecordsScreen />
    </RequireOrgPermission>
  );
}
