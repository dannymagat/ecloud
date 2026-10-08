/**
 * Reports (P9-B) over the P9-A report endpoints: pick a report definition (`GET …/reports`), fill
 * its parameters (period, from / to as site-local labels, optional site), view the result table
 * (`GET …/reports/{key}`), and export CSV (`POST …/reports/{key}/export`) where permitted.
 * Reports run on demand (no polling). Export needs `report:export` (Read Only lacks it, Q75) and
 * is hidden while impersonating (D-027); the API refuses, rate-limits and audits regardless.
 */
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { buildUrl, downloadFile, request, saveBlob } from '../../api/client';
import type { Page, Row } from '../../api/types';
import { DataTable } from '../../components/DataTable';
import { FreshnessLine } from '../../components/Freshness';
import { ProblemAlert } from '../../components/ProblemAlert';
import {
  Button,
  Card,
  Notice,
  PageHeader,
  SelectField,
  Spinner,
  TextField,
} from '../../components/ui';
import { Unavailable } from '../../components/Unavailable';
import { RequireOrgPermission } from '../../layout/guards';
import { canExport } from '../../lib/accounting';
import { hasOperation, useApiDocument } from '../../lib/apiDoc';
import { useAuth } from '../../lib/auth';
import {
  buildReportParams,
  DASHBOARD_PERMISSION,
  formatExact,
  isNasActivityStatus,
  NAS_ACTIVITY_LABEL,
  REPORT_EXPORT_PATH,
  REPORT_EXPORT_PERMISSION,
  REPORT_PATH,
  REPORT_PERIODS,
  REPORTS_PATH,
  validateReportParams,
  type ReportColumn,
  type ReportDefinition,
  type ReportParam,
  type ReportResult,
} from '../../lib/dashboard';
import { display, formatBytes, formatDateTime, formatDuration } from '../../lib/format';
import { useOrgId } from '../../lib/org';
import { can } from '../../lib/permissions';

const PERIOD_LABEL: Record<string, string> = {
  daily: 'Day (site time)',
  monthly: 'Month (site time)',
};

export function renderReportCell(column: ReportColumn, value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (column.key === 'activity' && isNasActivityStatus(value)) return NAS_ACTIVITY_LABEL[value];
  if (column.type === 'datetime') return formatDateTime(value);
  if (column.type === 'number') {
    if (column.unit === 'bytes') return formatBytes(value);
    if (column.unit === 's' || column.unit === 'seconds') return formatDuration(value);
    return formatExact(value);
  }
  return display(value);
}

function stringDefault(param: ReportParam | undefined, fallback: string): string {
  return typeof param?.default === 'string' ? param.default : fallback;
}

interface Run {
  key: string;
  params: Record<string, string>;
}

function ExportButton({ orgId, run }: { orgId: string; run: Run }) {
  const m = useMutation({
    mutationFn: async () => {
      const { blob, filename } = await downloadFile(
        'post',
        buildUrl(REPORT_EXPORT_PATH, { orgId, key: run.key }, undefined),
        { body: run.params },
      );
      saveBlob(blob, filename ?? `${run.key}.csv`);
    },
  });
  return (
    <span className="inline-flex flex-col items-end gap-1">
      <Button size="sm" busy={m.isPending} onClick={() => m.mutate()}>
        Export CSV
      </Button>
      {m.error ? <ProblemAlert error={m.error} /> : null}
    </span>
  );
}

function ResultCard({
  orgId,
  run,
  definition,
  exportAllowed,
}: {
  orgId: string;
  run: Run;
  definition: ReportDefinition | undefined;
  exportAllowed: boolean;
}) {
  const q = useQuery({
    queryKey: ['org', orgId, 'report', run],
    queryFn: ({ signal }) =>
      request<ReportResult>('get', buildUrl(REPORT_PATH, { orgId, key: run.key }, run.params), {
        signal,
        pathTemplate: REPORT_PATH,
      }),
  });
  const title = q.data?.title ?? definition?.title ?? run.key;
  const columns = q.data?.columns ?? definition?.columns ?? [];
  return (
    <Card title={title} actions={exportAllowed ? <ExportButton orgId={orgId} run={run} /> : null}>
      {q.isPending ? (
        <Spinner label="Running report…" />
      ) : q.error ? (
        <ProblemAlert error={q.error} />
      ) : (
        <div className="space-y-3">
          {q.data.freshness ? <FreshnessLine freshness={q.data.freshness} /> : null}
          <p className="text-xs text-subtle" data-report-meta>
            {Object.entries(q.data.params)
              .filter(([, v]) => v !== null && v !== undefined && v !== '')
              .map(([k, v]) => `${k}: ${display(v)}`)
              .join(' · ')}
            {' · '}time zone {q.data.timezone === 'mixed' ? 'each site its own' : q.data.timezone}
            {' · '}
            {formatExact(q.data.row_count)} rows · measured {formatDateTime(q.data.measured_at)}
          </p>
          <p className="text-xs text-subtle">Period labels: {q.data.label_basis}</p>
          {q.data.notes.length > 0 ? (
            <ul className="list-disc pl-5 text-xs text-subtle">
              {q.data.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          ) : null}
          <DataTable<Record<string, unknown>>
            caption={`${title} results`}
            rows={q.data.rows}
            rowKey={(r, i) => `${i}:${JSON.stringify(r)}`}
            emptyTitle="No data for these parameters"
            columns={columns.map((c) => ({
              key: c.key,
              header: c.label || c.key,
              render: (r) => renderReportCell(c, r[c.key]),
            }))}
          />
        </div>
      )}
    </Card>
  );
}

function ParamField({
  param,
  value,
  period,
  sites,
  onChange,
}: {
  param: ReportParam;
  value: string;
  period: string;
  sites: { id: string; name: string }[] | null;
  onChange: (v: string) => void;
}) {
  const hint = param.description ?? undefined;
  if (param.name === 'period') {
    return (
      <div className="w-48">
        <SelectField
          label="Period"
          value={value || stringDefault(param, 'daily')}
          onChange={(e) => onChange(e.target.value)}
          options={REPORT_PERIODS.map((p) => ({ value: p, label: PERIOD_LABEL[p] ?? p }))}
        />
      </div>
    );
  }
  if (param.name === 'site_id') {
    if (!sites) return null;
    return (
      <div className="w-56">
        <SelectField
          label="Site"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          options={[
            { value: '', label: 'All permitted sites' },
            ...sites.map((s) => ({ value: s.id, label: s.name })),
          ]}
        />
      </div>
    );
  }
  if (param.name === 'from' || param.name === 'to') {
    return (
      <div className="w-44">
        <TextField
          label={param.name === 'from' ? 'From' : 'To'}
          type={period === 'monthly' ? 'month' : 'date'}
          value={value}
          required={param.required}
          hint={param.name === 'from' ? 'Empty: report default' : 'Inclusive'}
          onChange={(e) => onChange(e.target.value)}
        />
      </div>
    );
  }
  return (
    <div className="w-44">
      <TextField
        label={param.name}
        value={value}
        required={param.required}
        hint={hint}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

function ReportsScreen() {
  const orgId = useOrgId();
  const { me } = useAuth();
  const doc = useApiDocument();
  const listAvailable = hasOperation(doc.data, 'get', REPORTS_PATH);
  const runAvailable = hasOperation(doc.data, 'get', REPORT_PATH);
  const exportEndpoint = hasOperation(doc.data, 'post', REPORT_EXPORT_PATH);
  const definitions = useQuery({
    queryKey: ['org', orgId, 'report-definitions'],
    enabled: listAvailable,
    queryFn: ({ signal }) =>
      request<{ data: ReportDefinition[] }>('get', buildUrl(REPORTS_PATH, { orgId }, undefined), {
        signal,
        pathTemplate: REPORTS_PATH,
      }),
  });
  const canSites = can(me, 'site:read', { organizationId: orgId, anySite: true });
  const siteList = useQuery({
    queryKey: ['org', orgId, 'report-sites'],
    enabled: canSites,
    queryFn: ({ signal }) =>
      request<Page<Row>>('get', buildUrl('/api/v1/orgs/{orgId}/sites', { orgId }, { limit: 200 }), {
        signal,
      }),
  });
  const sites = siteList.data
    ? siteList.data.data.map((s) => ({ id: s.id, name: display(s.name ?? s.id) }))
    : null;
  const defs = definitions.data?.data ?? [];
  const [key, setKey] = useState('');
  const [values, setValues] = useState<Record<string, string>>({});
  const [run, setRun] = useState<Run | null>(null);
  const selected = defs.find((d) => d.key === key) ?? defs[0];
  const period =
    values.period ||
    stringDefault(
      selected?.params.find((p) => p.name === 'period'),
      '',
    );
  const error = selected ? validateReportParams(selected, values) : null;
  const impersonating = me?.kind === 'admin' && me.impersonation !== null;
  const exportAllowed =
    exportEndpoint &&
    canExport(me, REPORT_EXPORT_PERMISSION, { organizationId: orgId, anySite: true });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!selected || error) return;
    setRun({ key: selected.key, params: buildReportParams(selected, { ...values, period }) });
  };

  return (
    <div>
      <PageHeader
        title="Reports"
        description="On-demand reports from ECLOUD's RADIUS, accounting and captive-portal records. Days and months follow each site's time zone."
      />
      {doc.isPending ? (
        <Spinner label="Loading…" />
      ) : !listAvailable || !runAvailable ? (
        <Unavailable endpoint={`GET ${listAvailable ? REPORT_PATH : REPORTS_PATH}`} />
      ) : definitions.isPending ? (
        <Spinner label="Loading report definitions…" />
      ) : definitions.error ? (
        <ProblemAlert error={definitions.error} />
      ) : !selected ? (
        <Notice tone="info">No reports are defined.</Notice>
      ) : (
        <div className="space-y-4">
          <Card>
            <form className="flex flex-wrap items-end gap-3" onSubmit={onSubmit}>
              <div className="w-72">
                <SelectField
                  label="Report"
                  value={selected.key}
                  onChange={(e) => {
                    setKey(e.target.value);
                    setValues({});
                    setRun(null);
                  }}
                  options={defs.map((d) => ({ value: d.key, label: d.title }))}
                />
              </div>
              {selected.params.map((p) => (
                <ParamField
                  key={`${selected.key}-${p.name}`}
                  param={p}
                  value={values[p.name] ?? ''}
                  period={period}
                  sites={sites}
                  onChange={(v) =>
                    setValues((prev) =>
                      p.name === 'period'
                        ? { ...prev, period: v, from: '', to: '' }
                        : { ...prev, [p.name]: v },
                    )
                  }
                />
              ))}
              <Button type="submit" disabled={!!error}>
                Run report
              </Button>
            </form>
            {error ? (
              <p className="mt-2 text-sm text-danger" role="alert">
                {error}
              </p>
            ) : null}
            <p className="mt-2 text-xs text-subtle">{selected.description}</p>
            {impersonating ? (
              <div className="mt-3">
                <Notice tone="info">Exports are not available while impersonating.</Notice>
              </div>
            ) : exportEndpoint && !exportAllowed ? (
              <p className="mt-2 text-xs text-subtle">
                CSV export requires the {REPORT_EXPORT_PERMISSION} permission.
              </p>
            ) : null}
          </Card>
          {run ? (
            <ResultCard
              orgId={orgId}
              run={run}
              definition={defs.find((d) => d.key === run.key)}
              exportAllowed={exportAllowed}
            />
          ) : null}
        </div>
      )}
    </div>
  );
}

export function ReportsPage() {
  return (
    <RequireOrgPermission permission={DASHBOARD_PERMISSION}>
      <ReportsScreen />
    </RequireOrgPermission>
  );
}
