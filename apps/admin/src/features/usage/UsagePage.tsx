/**
 * Usage dashboards (P8-B) over the P8-A usage endpoints:
 *  - organization totals for the current day / month (site time zone, Q65) and overall;
 *  - top-N users, client devices or sites by traffic (`/usage/top`);
 *  - one subject's usage series, total and quota position against its effective policy
 *    (`/usage?subject_type&subject_id`), opened from the ranking.
 * Every figure shows its accounting freshness (spec §6). Polled every 30 s (Q73). Usage CSV
 * export needs `report:export` and is hidden while impersonating (Q75, D-027).
 */
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { buildUrl, downloadFile, request, saveBlob } from '../../api/client';
import { DataTable } from '../../components/DataTable';
import { FreshnessLine } from '../../components/Freshness';
import { ProblemAlert } from '../../components/ProblemAlert';
import {
  Button,
  Card,
  cx,
  Notice,
  PageHeader,
  SelectField,
  Spinner,
  TextField,
} from '../../components/ui';
import { ApiError } from '../../api/problem';
import { Unavailable } from '../../components/Unavailable';
import { RequireOrgPermission } from '../../layout/guards';
import {
  canExport,
  POLL_INTERVAL_MS,
  quotaPercent,
  SUBJECT_LABEL,
  TOP_SUBJECTS,
  totalBytes,
  USAGE_EXPORT_PATH,
  USAGE_PATH,
  USAGE_PERIOD_LABEL,
  USAGE_PERIODS,
  USAGE_TOP_PATH,
  type QuotaPeriod,
  type QuotaPosition,
  type TopReport,
  type TopSubject,
  type UsageCounters,
  type UsagePeriod,
  type UsageReport,
} from '../../lib/accounting';
import { hasOperation, useApiDocument } from '../../lib/apiDoc';
import { useAuth } from '../../lib/auth';
import { display, formatBytes, formatDateTime, formatDuration } from '../../lib/format';
import { useOrgId } from '../../lib/org';
import { can } from '../../lib/permissions';

export const TOP_N_OPTIONS = [10, 25, 50] as const;

/** `period_start` query value: monthly inputs give `YYYY-MM`, the API wants day 01. */
export function topPeriodStart(period: UsagePeriod, value: string): string | undefined {
  if (period === 'total' || value === '') return undefined;
  return period === 'monthly' && /^\d{4}-\d{2}$/.test(value) ? `${value}-01` : value;
}

const QUOTA_PERIOD_LABEL: Record<string, string> = {
  daily: 'Daily quota',
  monthly: 'Monthly quota',
  total: 'Total quota',
};

export function QuotaBar({ quota }: { quota: QuotaPeriod }) {
  const pct = quotaPercent(quota);
  const exceeded = quota.exceeded || (pct !== null && pct >= 100);
  const label = QUOTA_PERIOD_LABEL[quota.period] ?? `${quota.period} quota`;
  return (
    <div className="space-y-0.5" data-quota-period={quota.period}>
      <div className="flex justify-between gap-2 text-xs">
        <span>{label}</span>
        <span className={exceeded ? 'font-semibold text-danger' : undefined}>
          {exceeded ? 'Exceeded' : `${formatBytes(quota.remaining_bytes)} left`}
        </span>
      </div>
      <div
        role="meter"
        aria-label={`${label} used`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct ?? 0}
        aria-valuetext={`${formatBytes(quota.used_bytes)} of ${formatBytes(quota.limit_bytes)}`}
        className="h-1.5 w-full overflow-hidden rounded bg-muted"
      >
        <div
          className={cx('h-full', exceeded ? 'bg-danger' : 'bg-primary')}
          style={{ width: `${pct ?? 0}%` }}
        />
      </div>
      <p className="text-xs text-subtle">
        {formatBytes(quota.used_bytes)} of {formatBytes(quota.limit_bytes)}
        {quota.period_end ? ` · resets ${formatDateTime(quota.period_end)}` : ''}
      </p>
    </div>
  );
}

export function QuotaPanel({ quota }: { quota: QuotaPosition | null }) {
  if (quota === null || quota.periods.length === 0) {
    return <p className="text-sm text-subtle">No quota applies under the effective policy.</p>;
  }
  return (
    <div className="space-y-3">
      <p className="text-xs text-subtle">
        Policy {display(quota.policy_name ?? quota.policy_id)} (
        {quota.policy_source === 'open_session' ? 'current session' : 'most recent session'}).
        Quotas are enforced by ECLOUD at authorization and from accounting, not by the device.
      </p>
      {quota.periods.map((q) => (
        <QuotaBar key={q.period} quota={q} />
      ))}
    </div>
  );
}

function Tiles({ counters, title }: { counters: UsageCounters | null; title: string }) {
  if (counters === null) return <p className="text-sm text-subtle">No usage recorded.</p>;
  const tiles = [
    { label: 'Total traffic', value: formatBytes(totalBytes(counters)) },
    { label: 'Downloaded', value: formatBytes(counters.bytes_out) },
    { label: 'Uploaded', value: formatBytes(counters.bytes_in) },
    { label: 'Sessions', value: display(counters.session_count) },
    { label: 'Online time', value: formatDuration(counters.session_time_s) },
  ];
  return (
    <div>
      <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-subtle">{title}</h3>
      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-5" aria-label={title}>
        {tiles.map((t) => (
          <div key={t.label} className="rounded-md border border-border p-2">
            <dt className="text-xs text-subtle">{t.label}</dt>
            <dd className="text-base font-semibold tabular-nums">{t.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

export function LabelBasis({ basis }: { basis: string | null | undefined }) {
  return basis ? <p className="text-xs text-subtle">Period labels: {basis}</p> : null;
}

/** The current day / month, or why there is none (sites in several time zones). */
export function CurrentTiles({ report, period }: { report: UsageReport; period: UsagePeriod }) {
  const name = period === 'daily' ? 'day' : 'month';
  if (report.current === null) {
    return (
      <Notice tone="info" title={`Current ${name} not available`}>
        {report.current_unavailable_reason ?? 'No usage recorded in the current period.'}
      </Notice>
    );
  }
  return (
    <Tiles
      counters={report.current}
      title={`Current ${name} (from ${display(report.current.period_start)}, ${report.timezone})`}
    />
  );
}

function useUsage(
  orgId: string,
  query: { subject_type: string; subject_id?: string; period: UsagePeriod } | null,
) {
  return useQuery({
    queryKey: ['org', orgId, 'usage', query],
    enabled: query !== null,
    // Explicit parameter type keeps TanStack Query's data inference intact; stop polling on error.
    refetchInterval: (q: { state: { status: string } }) =>
      q.state.status === 'error' ? false : POLL_INTERVAL_MS,
    queryFn: ({ signal }) =>
      request<UsageReport>('get', buildUrl(USAGE_PATH, { orgId }, query ?? undefined), {
        signal,
        pathTemplate: USAGE_PATH,
      }),
  });
}

function OrganizationCard({ orgId, period }: { orgId: string; period: UsagePeriod }) {
  const { me } = useAuth();
  const orgLevel = can(me, 'accounting:read', { organizationId: orgId });
  const usage = useUsage(orgId, orgLevel ? { subject_type: 'organization', period } : null);
  return (
    <Card title="Organization">
      {!orgLevel ? (
        <p className="text-sm text-subtle">
          Organization totals need accounting:read on the whole organization.
        </p>
      ) : usage.isPending ? (
        <Spinner label="Loading organization usage…" />
      ) : usage.error ? (
        <ProblemAlert error={usage.error} />
      ) : (
        <div className="space-y-3">
          <FreshnessLine freshness={usage.data} />
          {period !== 'total' ? <CurrentTiles report={usage.data} period={period} /> : null}
          <Tiles counters={usage.data.total} title="All buckets in range" />
          <p className="text-xs text-subtle">
            Time zone: {usage.data.timezone === 'mixed' ? 'each site its own' : usage.data.timezone}
          </p>
          <LabelBasis basis={usage.data.label_basis} />
        </div>
      )}
    </Card>
  );
}

interface Selection {
  subject_type: TopSubject;
  subject_id: string;
  label: string;
}

function SubjectCard({
  orgId,
  selection,
  period,
  onClose,
}: {
  orgId: string;
  selection: Selection;
  period: UsagePeriod;
  onClose: () => void;
}) {
  const usage = useUsage(orgId, {
    subject_type: selection.subject_type,
    subject_id: selection.subject_id,
    period,
  });
  return (
    <Card
      title={`${selection.label} · ${SUBJECT_LABEL[selection.subject_type].replace(/s$/, '')}`}
      actions={
        <Button size="sm" variant="ghost" onClick={onClose}>
          Close
        </Button>
      }
    >
      {usage.isPending ? (
        <Spinner label="Loading usage…" />
      ) : usage.error ? (
        <ProblemAlert error={usage.error} />
      ) : (
        <div className="space-y-4">
          <FreshnessLine freshness={usage.data} />
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-[2fr_1fr]">
            <div className="space-y-3">
              {period !== 'total' ? <CurrentTiles report={usage.data} period={period} /> : null}
              <Tiles counters={usage.data.total} title="All buckets in range" />
              <LabelBasis basis={usage.data.label_basis} />
            </div>
            {selection.subject_type !== 'site' ? (
              <div>
                <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-subtle">
                  Quota position
                </h3>
                <QuotaPanel quota={usage.data.quota} />
              </div>
            ) : null}
          </div>
          {period !== 'total' ? (
            <DataTable
              caption="Usage by period"
              rows={[...usage.data.series].reverse()}
              rowKey={(b) => b.period_start}
              emptyTitle="No usage in this range"
              columns={[
                { key: 'period_start', header: 'Period' },
                { key: 'total', header: 'Total', render: (b) => formatBytes(totalBytes(b)) },
                { key: 'bytes_out', header: 'Down', render: (b) => formatBytes(b.bytes_out) },
                { key: 'bytes_in', header: 'Up', render: (b) => formatBytes(b.bytes_in) },
                { key: 'session_count', header: 'Sessions' },
                {
                  key: 'session_time_s',
                  header: 'Online time',
                  render: (b) => formatDuration(b.session_time_s),
                },
              ]}
            />
          ) : null}
        </div>
      )}
    </Card>
  );
}

function UsageExportButton({
  orgId,
  subject,
  period,
}: {
  orgId: string;
  subject: TopSubject;
  period: UsagePeriod;
}) {
  const doc = useApiDocument();
  const available = hasOperation(doc.data, 'post', USAGE_EXPORT_PATH);
  const run = useMutation({
    mutationFn: async () => {
      const { blob, filename } = await downloadFile(
        'post',
        buildUrl(USAGE_EXPORT_PATH, { orgId }, undefined),
        { body: { subject_type: subject, period } },
      );
      saveBlob(blob, filename ?? `usage-${subject}-${period}.csv`);
    },
  });
  return (
    <span className="inline-flex flex-col items-end gap-1">
      <span title={available ? undefined : 'Not available in this API version'}>
        <Button size="sm" disabled={!available} busy={run.isPending} onClick={() => run.mutate()}>
          Export CSV
        </Button>
      </span>
      {run.error ? <ProblemAlert error={run.error} /> : null}
    </span>
  );
}

function UsageScreen() {
  const orgId = useOrgId();
  const { me } = useAuth();
  const doc = useApiDocument();
  const [subject, setSubject] = useState<TopSubject>('user');
  const [period, setPeriod] = useState<UsagePeriod>('daily');
  const [limit, setLimit] = useState<number>(10);
  /** `YYYY-MM-DD` (daily) or `YYYY-MM` (monthly); empty = the current period. */
  const [periodStart, setPeriodStart] = useState('');
  const [selection, setSelection] = useState<Selection | null>(null);
  const usageAvailable = hasOperation(doc.data, 'get', USAGE_PATH);
  const topAvailable = hasOperation(doc.data, 'get', USAGE_TOP_PATH);
  const top = useQuery({
    queryKey: ['org', orgId, 'usage-top', subject, period, limit, periodStart],
    enabled: topAvailable,
    // Explicit parameter type keeps TanStack Query's data inference intact; stop polling on error.
    refetchInterval: (q: { state: { status: string } }) =>
      q.state.status === 'error' ? false : POLL_INTERVAL_MS,
    queryFn: ({ signal }) =>
      request<TopReport>(
        'get',
        buildUrl(
          USAGE_TOP_PATH,
          { orgId },
          {
            subject_type: subject,
            period,
            limit,
            period_start: topPeriodStart(period, periodStart),
          },
        ),
        { signal, pathTemplate: USAGE_TOP_PATH },
      ),
  });
  const showExport = canExport(me, 'report:export', { organizationId: orgId, anySite: true });
  const needsPeriod =
    top.error instanceof ApiError &&
    top.error.status === 400 &&
    periodStart === '' &&
    subject !== 'site' &&
    period !== 'total';

  return (
    <div>
      <PageHeader
        title="Usage"
        description="Traffic from RADIUS accounting. Days and months follow the site's time zone; quota positions are measured against the effective policy."
      />
      {doc.isPending ? (
        <Spinner label="Loading…" />
      ) : !usageAvailable && !topAvailable ? (
        <Unavailable endpoint={`GET ${USAGE_PATH}`} />
      ) : (
        <div className="space-y-4">
          <div className="w-56">
            <SelectField
              label="Period"
              value={period}
              onChange={(e) => {
                setPeriod(e.target.value as UsagePeriod);
                setPeriodStart('');
              }}
              options={USAGE_PERIODS.map((p) => ({ value: p, label: USAGE_PERIOD_LABEL[p] }))}
            />
          </div>
          {usageAvailable ? (
            <OrganizationCard orgId={orgId} period={period} />
          ) : (
            <Unavailable endpoint={`GET ${USAGE_PATH}`} />
          )}
          {selection && usageAvailable ? (
            <SubjectCard
              orgId={orgId}
              selection={selection}
              period={period}
              onClose={() => setSelection(null)}
            />
          ) : null}
          <Card
            title={`Top ${limit} by traffic`}
            actions={
              showExport ? (
                <UsageExportButton orgId={orgId} subject={subject} period={period} />
              ) : null
            }
          >
            {!topAvailable ? (
              <Unavailable endpoint={`GET ${USAGE_TOP_PATH}`} />
            ) : (
              <>
                <div className="mb-3 flex flex-wrap items-end gap-3">
                  <div role="tablist" aria-label="Rank" className="flex flex-wrap gap-1">
                    {TOP_SUBJECTS.map((s) => (
                      <button
                        key={s}
                        type="button"
                        role="tab"
                        aria-selected={subject === s}
                        onClick={() => setSubject(s)}
                        className={cx(
                          'rounded-md border px-3 py-1.5 text-sm',
                          subject === s
                            ? 'border-primary bg-primary text-primary-fg'
                            : 'border-border bg-surface hover:bg-muted',
                        )}
                      >
                        {SUBJECT_LABEL[s]}
                      </button>
                    ))}
                  </div>
                  {period !== 'total' ? (
                    <div className="w-44">
                      <TextField
                        label={period === 'daily' ? 'Day' : 'Month'}
                        type={period === 'daily' ? 'date' : 'month'}
                        value={periodStart}
                        hint="Empty: the current period"
                        onChange={(e) => setPeriodStart(e.target.value)}
                      />
                    </div>
                  ) : null}
                  <div className="w-32">
                    <SelectField
                      label="Show"
                      value={String(limit)}
                      onChange={(e) => setLimit(Number(e.target.value))}
                      options={TOP_N_OPTIONS.map((n) => ({ value: String(n), label: `Top ${n}` }))}
                    />
                  </div>
                </div>
                {top.data ? (
                  <div className="mb-3 space-y-1">
                    <FreshnessLine freshness={top.data} />
                    <LabelBasis basis={top.data.label_basis} />
                  </div>
                ) : null}
                {needsPeriod ? (
                  <Notice tone="warning" title="Choose the period to rank">
                    Your sites are in several time zones, so there is no single current{' '}
                    {period === 'daily' ? 'day' : 'month'} for{' '}
                    {SUBJECT_LABEL[subject].toLowerCase()}. Pick the{' '}
                    {period === 'daily' ? 'day' : 'month'} above.
                  </Notice>
                ) : (
                  <DataTable
                    caption={`Top ${SUBJECT_LABEL[subject].toLowerCase()} by traffic`}
                    rows={top.data?.data ?? []}
                    rowKey={(r) => r.subject_id}
                    loading={top.isPending}
                    error={top.error}
                    emptyTitle="No usage recorded for this period"
                    columns={[
                      { key: 'rank', header: '#' },
                      {
                        key: 'label',
                        header: SUBJECT_LABEL[subject],
                        render: (r) =>
                          usageAvailable ? (
                            <button
                              type="button"
                              className="text-primary hover:underline"
                              onClick={() =>
                                setSelection({
                                  subject_type: subject,
                                  subject_id: r.subject_id,
                                  label: display(r.label ?? r.subject_id),
                                })
                              }
                            >
                              {display(r.label ?? r.subject_id)}
                            </button>
                          ) : (
                            display(r.label ?? r.subject_id)
                          ),
                      },
                      { key: 'total', header: 'Total', render: (r) => formatBytes(totalBytes(r)) },
                      { key: 'bytes_out', header: 'Down', render: (r) => formatBytes(r.bytes_out) },
                      { key: 'bytes_in', header: 'Up', render: (r) => formatBytes(r.bytes_in) },
                      { key: 'session_count', header: 'Sessions' },
                      {
                        key: 'session_time_s',
                        header: 'Online time',
                        render: (r) => formatDuration(r.session_time_s),
                      },
                      { key: 'period_start', header: 'Period (site-local)' },
                      {
                        key: 'last_accounting_at',
                        header: 'Last accounting',
                        render: (r) => formatDateTime(r.last_accounting_at),
                      },
                    ]}
                  />
                )}
              </>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}

export function UsagePage() {
  return (
    <RequireOrgPermission permission="accounting:read">
      <UsageScreen />
    </RequireOrgPermission>
  );
}
