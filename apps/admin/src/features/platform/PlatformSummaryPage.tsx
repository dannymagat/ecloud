/**
 * Platform summary (P9-B) over `GET /api/v1/platform/dashboard` (`platform:health:read`, P9-A
 * contract §6): per-organization counts for platform administrators, no subscriber data. NAS
 * figures are ECLOUD's observed RADIUS activity per NAS (spec §8), never device up/down state.
 * Polled every 30 s (Q73), stopping on error.
 */
import { useState } from 'react';
import { Link } from 'react-router';
import { buildUrl, request } from '../../api/client';
import { DataTable } from '../../components/DataTable';
import { Card, PageHeader, SelectField, Spinner } from '../../components/ui';
import { Unavailable } from '../../components/Unavailable';
import { RequirePlatformPermission } from '../../layout/guards';
import { POLL_INTERVAL_MS } from '../../lib/accounting';
import { hasOperation, useApiDocument } from '../../lib/apiDoc';
import {
  formatExact,
  nasActivityDefinitions,
  NAS_ACTIVITY_EXPLAINER,
  PLATFORM_DASHBOARD_PATH,
  PLATFORM_DASHBOARD_PERMISSION,
  PLATFORM_STATUSES,
  type PlatformDashboard,
  type PlatformOrgRow,
} from '../../lib/dashboard';
import { formatDateTime } from '../../lib/format';
import { useCursorList } from '../../lib/queries';

function Screen() {
  const doc = useApiDocument();
  const available = hasOperation(doc.data, 'get', PLATFORM_DASHBOARD_PATH);
  const [status, setStatus] = useState('');
  const list = useCursorList<PlatformOrgRow>(
    ['platform', 'dashboard', status],
    (cursor, signal) =>
      request<PlatformDashboard>(
        'get',
        buildUrl(PLATFORM_DASHBOARD_PATH, undefined, {
          limit: 25,
          cursor,
          status: status || undefined,
        }),
        { signal, pathTemplate: PLATFORM_DASHBOARD_PATH },
      ),
    available,
    { refetchInterval: POLL_INTERVAL_MS },
  );
  // Every page repeats the window / thresholds; the first page's are shown.
  const meta = list.data?.pages[0] as PlatformDashboard | undefined;
  const defs = nasActivityDefinitions(meta?.thresholds);
  return (
    <div className="space-y-4">
      <PageHeader
        title="Platform summary"
        description="Per-organization counts observed by ECLOUD over the last 24 hours. No subscriber data is shown."
      />
      {doc.isPending ? (
        <Spinner label="Loading…" />
      ) : !available ? (
        <Unavailable endpoint={`GET ${PLATFORM_DASHBOARD_PATH}`} />
      ) : (
        <Card
          title="Organizations"
          actions={
            <div className="w-44">
              <SelectField
                label="Status"
                value={status}
                onChange={(e) => setStatus(e.target.value)}
                options={[
                  { value: '', label: 'All' },
                  ...PLATFORM_STATUSES.map((s) => ({ value: s, label: s })),
                ]}
              />
            </div>
          }
        >
          {meta ? (
            <div className="mb-3 space-y-1 text-xs text-subtle">
              <p>
                Measured {formatDateTime(meta.measured_at)} · window{' '}
                {formatDateTime(meta.window.from)} – {formatDateTime(meta.window.to)} · RADIUS
                requests not attributable to any organization:{' '}
                {formatExact(meta.unattributed.radius_requests_24h)}
              </p>
              <p>{NAS_ACTIVITY_EXPLAINER}</p>
              <p>
                Recent activity: {defs.active} Quiet: {defs.quiet} Silent: {defs.silent}
              </p>
            </div>
          ) : null}
          <DataTable<PlatformOrgRow>
            caption="Organization summary"
            rows={list.rows}
            rowKey={(r) => r.organization_id}
            loading={list.isPending}
            error={list.error}
            emptyTitle="No organizations"
            hasMore={list.hasNextPage}
            loadingMore={list.isFetchingNextPage}
            onLoadMore={() => void list.fetchNextPage()}
            columns={[
              {
                key: 'name',
                header: 'Organization',
                render: (r) => (
                  <Link
                    className="text-primary hover:underline"
                    to={`/orgs/${r.organization_id}/dashboard`}
                  >
                    {r.name}
                  </Link>
                ),
              },
              { key: 'status', header: 'Status' },
              { key: 'sites', header: 'Sites', render: (r) => formatExact(r.sites) },
              {
                key: 'nas',
                header: 'NAS registered',
                render: (r) => formatExact(r.nas_registered),
              },
              {
                key: 'nas_activity',
                header: 'NAS recent / quiet / silent / never',
                render: (r) =>
                  [
                    r.nas_activity.active,
                    r.nas_activity.quiet,
                    r.nas_activity.silent,
                    r.nas_activity.never,
                  ]
                    .map(formatExact)
                    .join(' / ') + (r.nas_activity_truncated ? ' (partial)' : ''),
              },
              {
                key: 'network_devices_registered',
                header: 'Network devices registered',
                render: (r) => formatExact(r.network_devices_registered),
              },
              {
                key: 'open_sessions',
                header: 'Open sessions',
                render: (r) => formatExact(r.open_sessions),
              },
              {
                key: 'sessions_started_24h',
                header: 'Sessions started',
                render: (r) => formatExact(r.sessions_started_24h),
              },
              {
                key: 'radius',
                header: 'RADIUS accept / reject',
                render: (r) =>
                  `${formatExact(r.radius_accept_24h)} / ${formatExact(r.radius_reject_24h)}`,
              },
              {
                key: 'portal',
                header: 'Portal attempts / lockouts',
                render: (r) =>
                  `${formatExact(r.portal_attempts_24h)} / ${formatExact(r.portal_lockouts_24h)}`,
              },
              {
                key: 'enforcement_pending',
                header: 'Policy changes pending',
                render: (r) => formatExact(r.enforcement_pending),
              },
              {
                key: 'anomalies_24h',
                header: 'Accounting anomalies',
                render: (r) => formatExact(r.anomalies_24h),
              },
            ]}
          />
        </Card>
      )}
    </div>
  );
}

export function PlatformSummaryPage() {
  return (
    <RequirePlatformPermission anyOf={[PLATFORM_DASHBOARD_PERMISSION]}>
      <Screen />
    </RequirePlatformPermission>
  );
}
