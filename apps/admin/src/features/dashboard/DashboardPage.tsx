/**
 * Organization and site dashboards (P9-B) over the P9-A endpoints (`GET …/dashboard`,
 * `…/dashboard/series/auth`, `…/dashboard/series/usage`; `report:read`, filtered by the API to
 * the caller's sites): KPI tiles, authentication-outcome and traffic charts, the authentication
 * breakdown, enforcement / anomaly callouts and the NAS activity table. Polled every 30 s (Q73);
 * polling stops while a query is in error.
 *
 * Honesty: NAS status is ECLOUD's observation of RADIUS traffic, never device up/down state
 * (spec §8); registered network devices are shown with no observed state; usage figures carry
 * freshness and the period label basis (spec §6, Q65); enforcement counts are ECLOUD-side
 * pending records, not device confirmations (D-028 / V12).
 *
 * Without `report:read`, or against an API without the dashboard endpoint, the organization page
 * shows the earlier record-count tiles (first page of list endpoints) and says why.
 */
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { buildUrl, request } from '../../api/client';
import { ApiError } from '../../api/problem';
import type { Page, Row } from '../../api/types';
import { ColumnChart, type ChartPoint } from '../../components/ColumnChart';
import { DataTable } from '../../components/DataTable';
import { FreshnessLine } from '../../components/Freshness';
import { ProblemAlert } from '../../components/ProblemAlert';
import { Badge, Card, Notice, PageHeader, SelectField, Spinner } from '../../components/ui';
import { Unavailable } from '../../components/Unavailable';
import { Forbidden } from '../../layout/guards';
import { hasOperation, useApiDocument } from '../../lib/apiDoc';
import { useAuth } from '../../lib/auth';
import {
  AUTH_SERIES_PATH,
  axisLabel,
  byteTickUnit,
  bytesTotal,
  CHART_WINDOWS,
  chartRange,
  DASHBOARD_PATH,
  DASHBOARD_PERMISSION,
  DASHBOARD_WINDOW_LABEL,
  DASHBOARD_WINDOWS,
  formatCount,
  formatExact,
  formatPercent,
  isNasActivityStatus,
  NAS_ACTIVITY_EXPLAINER,
  NAS_ACTIVITY_LABEL,
  NAS_ACTIVITY_STATUSES,
  nasActivityDefinitions,
  nasActivityTone,
  num,
  pollUnlessError,
  USAGE_SERIES_PATH,
  type AuthSeries,
  type Counters,
  type DashboardWindow,
  type NasActivity,
  type OrgDashboard,
  type RejectReason,
  type SiteRef,
  type UsageSeries,
} from '../../lib/dashboard';
import { display, formatBytes, formatDateTime } from '../../lib/format';
import { useOrgId } from '../../lib/org';
import { can, type PermissionTarget } from '../../lib/permissions';
import type { OrgCollectionPath } from '../resource/paths';

const poll = pollUnlessError;

// ---------------------------------------------------------------------------------------------
// Fallback: record counts from list endpoints
// ---------------------------------------------------------------------------------------------

interface CountTileDef {
  label: string;
  path: OrgCollectionPath;
  permission: string;
  to: string;
  query?: Record<string, string>;
}

const COUNT_TILES: CountTileDef[] = [
  {
    label: 'Active sessions',
    path: '/api/v1/orgs/{orgId}/sessions',
    permission: 'session:read',
    to: 'sessions',
    query: { status: 'active' },
  },
  { label: 'Sites', path: '/api/v1/orgs/{orgId}/sites', permission: 'site:read', to: 'sites' },
  { label: 'NAS clients', path: '/api/v1/orgs/{orgId}/nas', permission: 'nas:read', to: 'nas' },
  { label: 'Users', path: '/api/v1/orgs/{orgId}/users', permission: 'user:read', to: 'users' },
  {
    label: 'Policies',
    path: '/api/v1/orgs/{orgId}/policies',
    permission: 'policy:read',
    to: 'policies',
  },
  {
    label: 'Voucher batches',
    path: '/api/v1/orgs/{orgId}/voucher-batches',
    permission: 'voucher:read',
    to: 'vouchers',
  },
];

function CountTile({ orgId, tile }: { orgId: string; tile: CountTileDef }) {
  const q = useQuery({
    queryKey: ['org', orgId, 'count', tile.path, tile.query],
    refetchInterval: tile.to === 'sessions' ? poll : false,
    queryFn: ({ signal }) =>
      request<Page<Row>>('get', buildUrl(tile.path, { orgId }, { limit: 200, ...tile.query }), {
        signal,
        pathTemplate: tile.path,
      }),
  });
  const value = q.data ? `${q.data.data.length}${q.data.next_cursor ? '+' : ''}` : null;
  return (
    <Link
      to={`/orgs/${orgId}/${tile.to}`}
      className="block rounded-lg border border-border bg-surface p-4 shadow-sm hover:border-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
    >
      <p className="text-xs font-medium text-subtle">{tile.label}</p>
      <p className="mt-2 text-2xl font-semibold">
        {q.isPending ? (
          <Spinner small />
        ) : q.error ? (
          <span className="text-sm text-danger">error</span>
        ) : (
          value
        )}
      </p>
    </Link>
  );
}

function RecordCounts({ orgId, notice }: { orgId: string; notice: ReactNode }) {
  const { me } = useAuth();
  const target = { organizationId: orgId, anySite: true };
  const tiles = COUNT_TILES.filter((t) => can(me, t.permission, target));
  return (
    <div className="space-y-3">
      {notice}
      {tiles.length > 0 ? (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
          {tiles.map((t) => (
            <CountTile key={t.path} orgId={orgId} tile={t} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// KPI tiles
// ---------------------------------------------------------------------------------------------

function Tile({ label, value, hint }: { label: string; value: string; hint?: ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-surface p-4 shadow-sm">
      <dt className="text-xs font-medium text-subtle">{label}</dt>
      <dd className="mt-1 text-2xl font-semibold">{value}</dd>
      {hint ? <dd className="mt-0.5 text-xs text-subtle">{hint}</dd> : null}
    </div>
  );
}

const usageValue = (c: Counters | null | undefined) => (c ? formatBytes(bytesTotal(c)) : '—');

function KpiTiles({ d }: { d: OrgDashboard }) {
  const r = d.auth.radius;
  const p = d.auth.portal;
  const windowText = DASHBOARD_WINDOW_LABEL[d.window.key] ?? d.window.key;
  return (
    <dl className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6" aria-label="Key figures">
      <Tile
        label="Open sessions"
        value={formatCount(d.sessions.open)}
        hint={`${formatCount(d.sessions.active)} with accounting · ${formatCount(d.sessions.authorized)} awaiting first accounting`}
      />
      <Tile
        label="Sessions started today"
        value={formatCount(d.sessions.started_today)}
        hint={d.sessions.started_today_basis}
      />
      <Tile
        label="Usage today"
        value={usageValue(d.usage.today)}
        hint={`${formatCount(d.usage.today?.session_count)} sessions`}
      />
      <Tile
        label="Usage this month"
        value={usageValue(d.usage.month)}
        hint={`${formatCount(d.usage.month?.session_count)} sessions`}
      />
      <Tile
        label="RADIUS accepts"
        value={formatCount(r.accept)}
        hint={`${formatPercent(num(r.accept), num(r.total))} of ${formatCount(r.total)} requests · ${formatCount(r.reject)} rejected · ${windowText}`}
      />
      <Tile
        label="Portal logins accepted"
        value={formatCount(p.accept)}
        hint={`of ${formatCount(p.total)} attempts · ${formatCount(p.lockouts)} lockouts · ${windowText}`}
      />
    </dl>
  );
}

// ---------------------------------------------------------------------------------------------
// Callouts
// ---------------------------------------------------------------------------------------------

function Callouts({ d, orgId }: { d: OrgDashboard; orgId: string }) {
  const pending = num(d.enforcement.pending);
  const overdue = num(d.enforcement.overdue);
  const anomalies = num(d.anomalies.count);
  if (pending === 0 && anomalies === 0) return null;
  return (
    <div className="grid gap-3 md:grid-cols-2">
      {pending > 0 ? (
        <div data-callout="enforcement">
          <Notice
            tone="warning"
            title={`${formatExact(pending)} policy changes not yet picked up by open sessions`}
          >
            {overdue > 0 ? `${formatExact(overdue)} are past their expected time. ` : ''}
            {d.enforcement.oldest_pending_at
              ? `Oldest recorded ${formatDateTime(d.enforcement.oldest_pending_at)}. `
              : ''}
            ECLOUD records these changes and they take effect when the session re-authorizes; this
            is an ECLOUD-side record, not a confirmation from the device.{' '}
            <Link className="text-primary hover:underline" to={`/orgs/${orgId}/sessions`}>
              Sessions
            </Link>
          </Notice>
        </div>
      ) : null}
      {anomalies > 0 ? (
        <div data-callout="anomalies">
          <Notice tone="warning" title={`${formatExact(anomalies)} accounting anomalies`}>
            Counter resets or out-of-order accounting in the dashboard window; an estimated{' '}
            {formatBytes(d.anomalies.estimated_lost_bytes)} may be missing from usage figures.
            Details are on each session.
          </Notice>
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Charts
// ---------------------------------------------------------------------------------------------

function SeriesNote({ timezone, basis }: { timezone: string; basis: string }) {
  return (
    <p className="mt-1 text-xs text-subtle">
      Buckets in{' '}
      {timezone === 'mixed'
        ? "each site's own time zone (window edges use UTC dates when sites span time zones)"
        : timezone}{' '}
      · {basis}
    </p>
  );
}

/** Hourly series across several time zones need a site (contract: 400). */
function needsSite(error: unknown): boolean {
  return error instanceof ApiError && error.status === 400;
}

function NeedsSiteNotice() {
  return (
    <Notice tone="info" title="Choose a site for hourly charts">
      The sites in this organization are in several time zones, so hours cannot be lined up. Pick a
      site above, or use a daily window.
    </Notice>
  );
}

interface ChartProps {
  orgId: string;
  siteId?: string;
  windowKey: string;
  timezone: string;
}

function chartWindow(key: string) {
  return CHART_WINDOWS.find((w) => w.key === key) ?? CHART_WINDOWS[0]!;
}

function AuthChart({ orgId, siteId, windowKey, timezone }: ChartProps) {
  const w = chartWindow(windowKey);
  const q = useQuery({
    queryKey: ['org', orgId, 'dashboard-series-auth', siteId ?? null, windowKey],
    refetchInterval: poll,
    placeholderData: keepPreviousData,
    queryFn: ({ signal }) =>
      request<AuthSeries>(
        'get',
        buildUrl(
          AUTH_SERIES_PATH,
          { orgId },
          { granularity: w.granularity, site_id: siteId, ...chartRange(w, timezone) },
        ),
        { signal, pathTemplate: AUTH_SERIES_PATH },
      ),
  });
  if (q.isPending) return <Spinner label="Loading authentication outcomes…" />;
  if (q.error) return needsSite(q.error) ? <NeedsSiteNotice /> : <ProblemAlert error={q.error} />;
  const points: ChartPoint[] = q.data.buckets.map((b) => ({
    key: b.bucket_start,
    label: axisLabel(b.label, q.data.granularity),
    title: b.label,
    values: { accept: num(b.radius_accept), reject: num(b.radius_reject) },
  }));
  const t = q.data.totals;
  return (
    <>
      <ColumnChart
        title={`RADIUS authentication outcomes per ${q.data.granularity}`}
        series={[
          { key: 'accept', label: 'Accepted', color: 'var(--viz-1)' },
          { key: 'reject', label: 'Rejected', color: 'var(--viz-2)' },
        ]}
        points={points}
        formatValue={(v) => formatExact(v)}
        yLabel="Requests"
        xLabel={q.data.granularity === 'hour' ? 'Hour (site time)' : 'Day (site time)'}
        emptyTitle="No RADIUS requests in this window"
        dimmed={q.isFetching && q.isPlaceholderData}
      />
      <p className="mt-2 text-xs text-subtle">
        Window totals: RADIUS {formatExact(t.radius_accept)} accepted,{' '}
        {formatExact(t.radius_reject)} rejected, {formatExact(t.radius_challenge)} challenged,{' '}
        {formatExact(t.radius_error)} errors · portal {formatExact(t.portal_accept)} accepted,{' '}
        {formatExact(t.portal_reject)} rejected, {formatExact(t.portal_lockouts)} lockouts. Chart
        totals cover whole hourly or daily buckets, so they can differ slightly from the rolling
        window in the tiles above.
      </p>
      <SeriesNote timezone={q.data.timezone} basis={q.data.label_basis} />
    </>
  );
}

function UsageChart({ orgId, siteId, windowKey, timezone }: ChartProps) {
  const w = chartWindow(windowKey);
  const q = useQuery({
    queryKey: ['org', orgId, 'dashboard-series-usage', siteId ?? null, windowKey],
    refetchInterval: poll,
    placeholderData: keepPreviousData,
    queryFn: ({ signal }) =>
      request<UsageSeries>(
        'get',
        buildUrl(
          USAGE_SERIES_PATH,
          { orgId },
          { granularity: w.granularity, site_id: siteId, ...chartRange(w, timezone) },
        ),
        { signal, pathTemplate: USAGE_SERIES_PATH },
      ),
  });
  if (q.isPending) return <Spinner label="Loading traffic…" />;
  if (q.error) return needsSite(q.error) ? <NeedsSiteNotice /> : <ProblemAlert error={q.error} />;
  const points: ChartPoint[] = q.data.buckets.map((b) => ({
    key: b.bucket_start,
    label: axisLabel(b.label, q.data.granularity),
    title: b.label,
    values: { down: num(b.bytes_out), up: num(b.bytes_in) },
  }));
  const max = Math.max(0, ...points.map((p) => (p.values.down ?? 0) + (p.values.up ?? 0)));
  return (
    <>
      <FreshnessLine freshness={q.data} />
      <ColumnChart
        title={`Traffic per ${q.data.granularity}`}
        series={[
          { key: 'down', label: 'Downloaded', color: 'var(--viz-1)' },
          { key: 'up', label: 'Uploaded', color: 'var(--viz-2)' },
        ]}
        points={points}
        formatValue={(v) => formatBytes(v)}
        tickUnit={byteTickUnit(max)}
        yLabel="Traffic"
        xLabel={q.data.granularity === 'hour' ? 'Hour (site time)' : 'Day (site time)'}
        emptyTitle="No traffic in this window"
        dimmed={q.isFetching && q.isPlaceholderData}
      />
      <p className="mt-2 text-xs text-subtle">
        Window total {formatBytes(bytesTotal(q.data.totals))}. Recorded from{' '}
        {display(q.data.data_since)} on (earlier periods read as zero).
      </p>
      <SeriesNote timezone={q.data.timezone} basis={q.data.label_basis} />
    </>
  );
}

function Charts({
  orgId,
  siteId,
  timezone,
  showAuth,
  showUsage,
}: {
  orgId: string;
  siteId?: string;
  timezone: string;
  showAuth: boolean;
  showUsage: boolean;
}) {
  // Several time zones and no site: hourly buckets are refused (400); start on a daily window.
  const [windowKey, setWindowKey] = useState(
    timezone === 'mixed' && !siteId ? '31d' : CHART_WINDOWS[0]!.key,
  );
  if (!showAuth && !showUsage) return null;
  return (
    <div className="space-y-3">
      <div className="w-64">
        <SelectField
          label="Chart window"
          value={windowKey}
          onChange={(e) => setWindowKey(e.target.value)}
          options={CHART_WINDOWS.map((w) => ({ value: w.key, label: w.label }))}
        />
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        {showAuth ? (
          <Card title="Authentication outcomes">
            <AuthChart orgId={orgId} siteId={siteId} windowKey={windowKey} timezone={timezone} />
          </Card>
        ) : null}
        {showUsage ? (
          <Card title="Traffic (RADIUS accounting)">
            <UsageChart orgId={orgId} siteId={siteId} windowKey={windowKey} timezone={timezone} />
          </Card>
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Authentication breakdown
// ---------------------------------------------------------------------------------------------

const SOURCE_LABEL: Record<string, string> = { radius: 'RADIUS', portal: 'Portal' };

function AuthBreakdown({ d }: { d: OrgDashboard }) {
  return (
    <div className="grid gap-4 xl:grid-cols-3">
      <Card title="Top reject reasons">
        <DataTable<RejectReason>
          caption="Top reject reasons"
          rows={d.auth.top_reject_reasons}
          rowKey={(r) => `${r.source}-${r.reason}`}
          emptyTitle="No rejections in this window"
          columns={[
            { key: 'reason', header: 'Reason', className: 'px-3 py-2 align-top break-words' },
            { key: 'source', header: 'Source', render: (r) => SOURCE_LABEL[r.source] ?? r.source },
            { key: 'count', header: 'Count', render: (r) => formatExact(r.count) },
          ]}
        />
      </Card>
      <Card title="RADIUS requests by method">
        <DataTable
          caption="RADIUS requests by method"
          rows={d.auth.radius.by_method}
          rowKey={(r) => display(r.method)}
          emptyTitle="No RADIUS requests in this window"
          columns={[
            { key: 'method', header: 'Method' },
            { key: 'accept', header: 'Accepted', render: (r) => formatExact(r.accept) },
            { key: 'reject', header: 'Rejected', render: (r) => formatExact(r.reject) },
            { key: 'total', header: 'Total', render: (r) => formatExact(r.total) },
          ]}
        />
      </Card>
      <Card title="Portal logins by method">
        <DataTable
          caption="Portal logins by method"
          rows={d.auth.portal.by_method}
          rowKey={(r) => r.method}
          emptyTitle="No portal logins in this window"
          columns={[
            { key: 'method', header: 'Method' },
            { key: 'accept', header: 'Accepted', render: (r) => formatExact(r.accept) },
            { key: 'reject', header: 'Rejected', render: (r) => formatExact(r.reject) },
            { key: 'lockouts', header: 'Lockouts', render: (r) => formatExact(r.lockouts) },
          ]}
        />
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// NAS activity
// ---------------------------------------------------------------------------------------------

export function NasActivityBadge({ status }: { status: unknown }) {
  const known = isNasActivityStatus(status);
  return (
    <span data-nas-activity={known ? status : 'unknown'}>
      <Badge tone={nasActivityTone(status)}>
        {known ? NAS_ACTIVITY_LABEL[status] : display(status)}
      </Badge>
    </span>
  );
}

function NasActivityCard({
  d,
  orgId,
  siteId,
}: {
  d: OrgDashboard;
  orgId: string;
  siteId?: string;
}) {
  const block = d.nas_activity;
  const defs = nasActivityDefinitions(block.thresholds);
  const c = block.counts;
  const siteColumn = {
    key: 'site',
    header: 'Site',
    render: (r: NasActivity) =>
      r.site_id ? (
        <Link
          className="text-primary hover:underline"
          to={`/orgs/${orgId}/sites/${r.site_id}/dashboard`}
        >
          {display(r.site_name ?? r.site_id)}
        </Link>
      ) : (
        display(r.site_name)
      ),
  };
  return (
    <Card title="NAS activity (last RADIUS / accounting activity)">
      <div className="space-y-3">
        <p className="text-sm text-subtle">{NAS_ACTIVITY_EXPLAINER}</p>
        <p className="text-sm" data-nas-counts>
          {formatExact(c.registered)} NAS registered · {formatExact(c.active)} recent activity ·{' '}
          {formatExact(c.quiet)} quiet · {formatExact(c.silent)} silent · {formatExact(c.never)} no
          activity seen
        </p>
        <p className="text-sm" data-network-devices>
          {formatExact(d.network_devices.registered)} network devices registered · device state
          observed by ECLOUD for {formatExact(d.network_devices.online_status_known)} (ECLOUD does
          not monitor access points)
        </p>
        <DataTable<NasActivity>
          caption="NAS activity"
          rows={block.data}
          rowKey={(r) => r.nas_client_id}
          emptyTitle="No NAS clients registered"
          columns={[
            { key: 'name', header: 'NAS', render: (r) => display(r.name ?? r.nas_ip) },
            ...(siteId ? [] : [siteColumn]),
            {
              key: 'activity',
              header: 'Observed activity',
              render: (r) => <NasActivityBadge status={r.activity} />,
            },
            {
              key: 'last_auth_request_at',
              header: 'Last RADIUS request',
              render: (r) => formatDateTime(r.last_auth_request_at),
            },
            {
              key: 'last_accounting_at',
              header: 'Last accounting',
              render: (r) => formatDateTime(r.last_accounting_at),
            },
            {
              key: 'open_sessions',
              header: 'Open sessions',
              render: (r) => formatExact(r.open_sessions),
            },
            {
              key: 'admin_status',
              header: 'Admin status',
              render: (r) => (r.admin_status === 'disabled' ? 'Disabled in ECLOUD' : 'Enabled'),
            },
          ]}
        />
        {block.truncated ? (
          <p className="text-xs text-subtle">
            Showing the first {block.data.length} NAS; the NAS activity report lists all of them.
          </p>
        ) : null}
        <dl
          className="grid gap-x-4 gap-y-1 text-xs sm:grid-cols-[auto_1fr]"
          aria-label="Observed activity definitions"
        >
          {NAS_ACTIVITY_STATUSES.map((k) => (
            <div key={k} className="contents">
              <dt>
                <NasActivityBadge status={k} />
              </dt>
              <dd className="text-subtle">{defs[k]}</dd>
            </div>
          ))}
        </dl>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------------------------

/** Organization / site switch: the site list when readable, else the sites the figures cover. */
function ScopePicker({
  orgId,
  siteId,
  covered,
}: {
  orgId: string;
  siteId?: string;
  covered: SiteRef[];
}) {
  const { me } = useAuth();
  const navigate = useNavigate();
  const canSites = can(me, 'site:read', { organizationId: orgId, anySite: true });
  const list = useQuery({
    queryKey: ['org', orgId, 'dashboard-site-list'],
    enabled: canSites,
    queryFn: ({ signal }) =>
      request<Page<Row>>('get', buildUrl('/api/v1/orgs/{orgId}/sites', { orgId }, { limit: 200 }), {
        signal,
      }),
  });
  const sites = list.data
    ? list.data.data.map((s) => ({ id: s.id, name: display(s.name ?? s.id) }))
    : covered.map((s) => ({ id: s.id, name: s.name }));
  if (sites.length === 0) return null;
  return (
    <div className="w-64">
      <SelectField
        label="Scope"
        value={siteId ?? ''}
        onChange={(e) =>
          void navigate(
            e.target.value
              ? `/orgs/${orgId}/sites/${e.target.value}/dashboard`
              : `/orgs/${orgId}/dashboard`,
          )
        }
        options={[
          { value: '', label: 'Whole organization' },
          ...sites.map((s) => ({ value: s.id, label: s.name })),
        ]}
      />
    </div>
  );
}

function DashboardView({ orgId, siteId }: { orgId: string; siteId?: string }) {
  const { me } = useAuth();
  const doc = useApiDocument();
  const target: PermissionTarget = siteId
    ? { organizationId: orgId, siteId }
    : { organizationId: orgId, anySite: true };
  const allowed = can(me, DASHBOARD_PERMISSION, target);
  const available = hasOperation(doc.data, 'get', DASHBOARD_PATH);
  const [windowKey, setWindowKey] = useState<DashboardWindow>('24h');
  const dash = useQuery({
    queryKey: ['org', orgId, 'dashboard', siteId ?? null, windowKey],
    enabled: allowed && available,
    refetchInterval: poll,
    placeholderData: keepPreviousData,
    queryFn: ({ signal }) =>
      request<OrgDashboard>(
        'get',
        buildUrl(DASHBOARD_PATH, { orgId }, { site_id: siteId, window: windowKey }),
        { signal, pathTemplate: DASHBOARD_PATH },
      ),
  });
  const siteName = siteId ? dash.data?.sites.find((s) => s.id === siteId)?.name : undefined;

  let body: ReactNode;
  if (!allowed) {
    body = siteId ? (
      <Forbidden permission={DASHBOARD_PERMISSION} />
    ) : (
      <RecordCounts
        orgId={orgId}
        notice={
          <Notice tone="info">
            The activity dashboard requires the {DASHBOARD_PERMISSION} permission. Showing the
            record counts you can see instead.
          </Notice>
        }
      />
    );
  } else if (doc.isPending) {
    body = <Spinner label="Loading…" />;
  } else if (!available) {
    body = siteId ? (
      <Unavailable endpoint={`GET ${DASHBOARD_PATH}`} />
    ) : (
      <RecordCounts
        orgId={orgId}
        notice={
          <Unavailable endpoint={`GET ${DASHBOARD_PATH}`}>
            <p className="mt-1">Showing record counts from the list screens instead.</p>
          </Unavailable>
        }
      />
    );
  } else if (dash.isPending) {
    body = <Spinner label="Loading dashboard…" />;
  } else if (dash.error) {
    body = <ProblemAlert error={dash.error} />;
  } else {
    const d = dash.data;
    body = (
      <div
        className={dash.isFetching && dash.isPlaceholderData ? 'space-y-4 opacity-60' : 'space-y-4'}
      >
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="space-y-1">
            <FreshnessLine freshness={d.usage} />
            <p className="text-xs text-subtle">
              Time zone: {d.timezone === 'mixed' ? 'each site its own' : d.timezone} · usage
              periods: {d.usage.label_basis}
            </p>
          </div>
          <div className="w-48">
            <SelectField
              label="Authentication window"
              value={windowKey}
              onChange={(e) => setWindowKey(e.target.value as DashboardWindow)}
              options={DASHBOARD_WINDOWS.map((w) => ({
                value: w,
                label: DASHBOARD_WINDOW_LABEL[w],
              }))}
            />
          </div>
        </div>
        <KpiTiles d={d} />
        <Callouts d={d} orgId={orgId} />
        <Charts
          key={`${d.timezone}-${siteId ?? ''}`}
          orgId={orgId}
          siteId={siteId}
          timezone={d.timezone}
          showAuth={hasOperation(doc.data, 'get', AUTH_SERIES_PATH)}
          showUsage={hasOperation(doc.data, 'get', USAGE_SERIES_PATH)}
        />
        <AuthBreakdown d={d} />
        <NasActivityCard d={d} orgId={orgId} siteId={siteId} />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title={siteId ? `Site dashboard${siteName ? ` · ${siteName}` : ''}` : 'Dashboard'}
        description="Sessions, usage and authentication outcomes as observed by ECLOUD from RADIUS, accounting and the captive portal. Days and months follow each site's time zone."
        actions={
          allowed && available ? (
            <ScopePicker orgId={orgId} siteId={siteId} covered={dash.data?.sites ?? []} />
          ) : null
        }
      />
      {body}
    </div>
  );
}

export function DashboardPage() {
  const orgId = useOrgId();
  return <DashboardView orgId={orgId} />;
}

export function SiteDashboardPage() {
  const orgId = useOrgId();
  const { siteId = '' } = useParams();
  return <DashboardView key={siteId} orgId={orgId} siteId={siteId} />;
}
