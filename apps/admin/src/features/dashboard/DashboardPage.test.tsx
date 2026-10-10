import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ScopedPermissions } from '../../api/types';
import {
  FORBIDDEN_DEVICE_WORDS,
  type AuthSeries,
  type OrgDashboard,
  type UsageSeries,
} from '../../lib/dashboard';
import { adminMe, orgScope, ORG_A } from '../../test/fixtures';
import { mockFetch, renderRoutes, type MockRoute } from '../../test/utils';
import { DashboardPage, SiteDashboardPage } from './DashboardPage';

const SITE = '01900000-0000-7000-8000-0000000000c1';
const NAS1 = '01900000-0000-7000-8000-0000000000d1';
const NAS2 = '01900000-0000-7000-8000-0000000000d2';
const base = `/api/v1/orgs/${ORG_A}`;
const routes = [
  { path: '/orgs/:orgId/dashboard', element: <DashboardPage /> },
  { path: '/orgs/:orgId/sites/:siteId/dashboard', element: <SiteDashboardPage /> },
];

const openapi = (available: boolean) => ({
  openapi: '3.1.0',
  paths: available
    ? {
        '/api/v1/orgs/{orgId}/dashboard': { get: {} },
        '/api/v1/orgs/{orgId}/dashboard/series/auth': { get: {} },
        '/api/v1/orgs/{orgId}/dashboard/series/usage': { get: {} },
      }
    : {},
});

const counters = (total: number) => ({
  bytes_in: total / 4,
  bytes_out: (total * 3) / 4,
  bytes_total: total,
  session_count: 7,
  session_time_s: 3600,
});

const DASH: OrgDashboard = {
  organization_id: ORG_A,
  site_id: null,
  sites: [{ id: SITE, name: 'Marina Hotel', timezone: 'Asia/Dubai' }],
  timezone: 'Asia/Dubai',
  window: { key: '24h', from: '2026-10-07T10:00:00Z', to: '2026-10-08T10:00:00Z' },
  sessions: {
    open: 12,
    authorized: 2,
    active: 10,
    started_today: 31,
    started_today_basis: "since each site's local midnight",
    open_users: 9,
    open_devices: 11,
    open_distinct_basis: 'distinct subscribers and MACs of the open sessions',
  },
  users: {
    active_window_days: 30,
    active: 1284,
    active_basis: 'distinct subscribers with a session in the last 30 days or still open',
    new_today: 17,
    new_today_basis: "created since their site's local midnight",
  },
  usage: {
    today: counters(2 * 1024 ** 3),
    month: counters(40 * 1024 ** 3),
    label_basis: 'site-local calendar dates (Asia/Dubai)',
    source: 'usage_counters (site rows, migration 024)',
    measured_at: '2026-10-08T10:00:00Z',
    last_accounting_at: '2026-10-08T09:58:00Z',
    freshness_s: 120,
    expected_lag_s: 605,
  },
  auth: {
    radius: {
      total: 200,
      accept: 180,
      reject: 20,
      challenge: 0,
      error: 0,
      by_method: [{ method: 'pap', total: 200, accept: 180, reject: 20, challenge: 0, error: 0 }],
    },
    portal: {
      total: 40,
      accept: 30,
      reject: 10,
      error: 0,
      lockouts: 2,
      by_method: [{ method: 'voucher', total: 40, accept: 30, reject: 10, error: 0, lockouts: 2 }],
    },
    top_reject_reasons: [
      { source: 'radius', reason: 'quota_exceeded', count: 12 },
      { source: 'portal', reason: 'invalid_code', count: 8 },
    ],
  },
  enforcement: { pending: 3, overdue: 1, oldest_pending_at: '2026-10-08T08:00:00Z' },
  anomalies: { count: 2, estimated_lost_bytes: 1024 ** 2 },
  nas_activity: {
    thresholds: { active_within_s: 1200, quiet_within_s: 86400 },
    definition: 'observed activity only',
    counts: { registered: 2, active: 1, quiet: 0, silent: 0, never: 1 },
    data: [
      {
        nas_client_id: NAS1,
        name: 'Lobby AP',
        site_id: SITE,
        site_name: 'Marina Hotel',
        nas_ip: '10.0.0.2',
        adapter_type_key: 'openwifi',
        admin_status: 'active',
        activity: 'active',
        last_auth_request_at: '2026-10-08T09:59:00Z',
        last_accounting_at: '2026-10-08T09:58:00Z',
        last_activity_at: '2026-10-08T09:59:00Z',
        open_sessions: 12,
      },
      {
        nas_client_id: NAS2,
        name: 'Pool AP',
        site_id: SITE,
        site_name: 'Marina Hotel',
        nas_ip: '10.0.0.3',
        adapter_type_key: 'openwifi',
        admin_status: 'active',
        activity: 'never',
        last_auth_request_at: null,
        last_accounting_at: null,
        last_activity_at: null,
        open_sessions: 0,
      },
    ],
    truncated: false,
  },
  network_devices: { registered: 4, online_status_known: 0, note: 'not observed' },
  measured_at: '2026-10-08T10:00:00Z',
};

const zeroAuth = {
  radius_accept: 0,
  radius_reject: 0,
  radius_challenge: 0,
  radius_error: 0,
  portal_accept: 0,
  portal_reject: 0,
  portal_error: 0,
  portal_lockouts: 0,
};

const authSeries = (empty: boolean): AuthSeries => ({
  metric: 'auth_outcomes',
  granularity: 'hour',
  timezone: 'Asia/Dubai',
  site_id: null,
  from: '2026-10-07T10:00:00Z',
  to: '2026-10-08T10:00:00Z',
  label_basis: 'site-local hours (Asia/Dubai)',
  buckets: ['2026-10-08 12:00', '2026-10-08 13:00'].map((label, i) => ({
    bucket_start: `2026-10-08T0${8 + i}:00:00Z`,
    bucket_end: `2026-10-08T0${9 + i}:00:00Z`,
    label,
    ...zeroAuth,
    radius_accept: empty ? 0 : 90,
    radius_reject: empty ? 0 : 10,
  })),
  totals: { ...zeroAuth, radius_accept: empty ? 0 : 180, radius_reject: empty ? 0 : 20 },
  measured_at: '2026-10-08T10:00:00Z',
});

const USAGE_SERIES: UsageSeries = {
  metric: 'usage',
  granularity: 'hour',
  timezone: 'Asia/Dubai',
  site_id: null,
  from: '2026-10-07T10:00:00Z',
  to: '2026-10-08T10:00:00Z',
  label_basis: 'site-local hours (Asia/Dubai)',
  source: 'usage_hourly',
  data_since: '2026-10-08',
  buckets: [
    {
      bucket_start: '2026-10-08T08:00:00Z',
      bucket_end: '2026-10-08T09:00:00Z',
      label: '2026-10-08 12:00',
      ...counters(1024 ** 3),
    },
  ],
  totals: counters(1024 ** 3),
  measured_at: '2026-10-08T10:00:00Z',
  last_accounting_at: '2026-10-08T09:58:00Z',
  freshness_s: 120,
  expected_lag_s: 605,
};

function mocks(
  scopes: ScopedPermissions[],
  opts: { available?: boolean; dash?: unknown; dashStatus?: number; emptyAuth?: boolean } = {},
): MockRoute[] {
  return [
    { method: 'GET', path: '/api/v1/auth/me', body: adminMe(scopes) },
    { method: 'GET', path: '/api/v1/openapi.json', body: openapi(opts.available ?? true) },
    { method: 'GET', path: `${base}/dashboard/series/auth`, body: authSeries(!!opts.emptyAuth) },
    { method: 'GET', path: `${base}/dashboard/series/usage`, body: USAGE_SERIES },
    {
      method: 'GET',
      path: `${base}/dashboard`,
      status: opts.dashStatus,
      body: opts.dash ?? DASH,
    },
    {
      method: 'GET',
      path: `${base}/sites`,
      body: { data: [{ id: SITE, name: 'Marina Hotel' }], next_cursor: null },
    },
    {
      method: 'GET',
      path: `${base}/users`,
      body: { data: [{ id: 'u1' }, { id: 'u2' }], next_cursor: null },
    },
  ];
}

function expectNoDeviceStateWords() {
  const text = document.body.textContent ?? '';
  for (const word of FORBIDDEN_DEVICE_WORDS) expect(text).not.toMatch(word);
}

afterEach(() => vi.unstubAllGlobals());

describe('DashboardPage', () => {
  it('shows KPIs, freshness, callouts, charts and observed NAS activity without device-state wording', async () => {
    const calls = mockFetch(mocks([orgScope(ORG_A, ['report:read', 'site:read'])]));
    renderRoutes(routes, `/orgs/${ORG_A}/dashboard`);

    const kpis = await screen.findByLabelText('Key figures');
    expect(within(kpis).getByText('12')).toBeInTheDocument();
    expect(within(kpis).getByText('40.0 GB')).toBeInTheDocument();
    // "Sessions started today" and "Usage today" moved to the statistics tiles
    expect(within(kpis).queryByText('31')).not.toBeInTheDocument();
    expect(within(kpis).queryByText('2.0 GB')).not.toBeInTheDocument();
    expect(within(kpis).getByText(/90% of 200 requests/)).toBeInTheDocument();
    expect(screen.getAllByText('Last accounting 2 min ago').length).toBeGreaterThan(0);
    expect(screen.getByText(/usage periods: site-local calendar dates/)).toBeInTheDocument();

    expect(
      screen.getByText('3 policy changes not yet picked up by open sessions'),
    ).toBeInTheDocument();
    expect(screen.getByText(/not a confirmation from the device/)).toBeInTheDocument();
    expect(screen.getByText('2 accounting anomalies')).toBeInTheDocument();

    const nas = screen.getByRole('table', { name: 'NAS activity' });
    const lobby = within(nas).getByText('Lobby AP').closest('tr')!;
    expect(within(lobby).getByText('Recent activity')).toBeInTheDocument();
    expect(within(lobby).getByRole('link', { name: 'Marina Hotel' })).toHaveAttribute(
      'href',
      `/orgs/${ORG_A}/sites/${SITE}/dashboard`,
    );
    const pool = within(nas).getByText('Pool AP').closest('tr')!;
    expect(within(pool).getByText('No activity seen')).toBeInTheDocument();
    const defs = screen.getByLabelText('Observed activity definitions');
    expect(within(defs).getByText(/at most 20 min old/)).toBeInTheDocument();
    expect(screen.getByText(/2 NAS registered · 1 recent activity/)).toBeInTheDocument();
    expect(
      screen.getByText(/4 network devices registered · device state observed by ECLOUD for 0/),
    ).toBeInTheDocument();

    expect(screen.getByRole('table', { name: 'Top reject reasons' })).toHaveTextContent(
      'quota_exceeded',
    );

    const authChart = await screen.findByRole('figure', {
      name: 'RADIUS authentication outcomes per hour',
    });
    expect(within(authChart).getByRole('list', { name: 'Legend' })).toHaveTextContent(
      /Accepted.*Rejected/,
    );
    expect(
      within(authChart).getByRole('img', {
        name: '2026-10-08 12:00: Accepted 90, Rejected 10',
      }),
    ).toBeInTheDocument();
    fireEvent.focus(within(authChart).getAllByRole('img')[1]!);
    expect(within(authChart).getByRole('status')).toHaveTextContent('2026-10-08 13:00');
    expect(await screen.findByRole('figure', { name: 'Traffic per hour' })).toBeInTheDocument();
    expect(screen.getByText(/Recorded from 2026-10-08 on/)).toBeInTheDocument();

    const dashCall = calls.find((c) => c.url.split('?')[0] === `${base}/dashboard`)!;
    expect(new URL(dashCall.url, 'http://x').searchParams.get('window')).toBe('24h');
    const series = calls.find((c) => c.url.includes('/dashboard/series/auth'))!;
    expect(new URL(series.url, 'http://x').searchParams.get('granularity')).toBe('hour');

    expectNoDeviceStateWords();
  });

  it('shows the user and network statistics tiles linking to their screens', async () => {
    mockFetch(mocks([orgScope(ORG_A, ['report:read', 'site:read'])]));
    renderRoutes(routes, `/orgs/${ORG_A}/dashboard`);
    const users = await screen.findByRole('region', { name: 'User Statistics' });
    const network = screen.getByRole('region', { name: 'Network Statistics' });
    const tile = (region: HTMLElement, name: RegExp) => within(region).getByRole('link', { name });

    const expected: [HTMLElement, RegExp, string, string][] = [
      [users, /^Online Users: 9\. View sessions$/, 'sessions', '9'],
      [users, /^Active Users \(30 days\): 1,284\. View users$/, 'users', '1,284'],
      [users, /^New Users Today: 17\. View users$/, 'users', '17'],
      [users, /^Sessions Started Today: 31\. View report$/, 'reports', '31'],
      [network, /^Active NAS \(last 20 min\): 1\. View NAS$/, 'nas', '1'],
      [network, /^Silent NAS \(no RADIUS 24 h\): 1\. View NAS$/, 'nas', '1'],
      [network, /^Connected Devices: 11\. View devices$/, 'client-devices', '11'],
      [network, /^Data Today: 2\.0 GB\. View usage$/, 'usage', '2.0 GB'],
    ];
    for (const [region, name, path, value] of expected) {
      const link = tile(region, name);
      expect(link).toHaveAttribute('href', `/orgs/${ORG_A}/${path}`);
      // visible text: big number, label and the call to action (not colour alone)
      expect(link).toHaveTextContent(value);
      expect(link.getAttribute('aria-describedby')).toBeTruthy();
      expect(link.style.backgroundColor).toMatch(/^var\(--tile-/);
    }
    expect(within(users).getAllByRole('link')).toHaveLength(4);
    expect(within(network).getAllByRole('link')).toHaveLength(4);
    expect(screen.getByRole('link', { name: /^Online Users/ })).toHaveAccessibleDescription(
      'Distinct subscribers with an open session now.',
    );
    expectNoDeviceStateWords();
  });

  it('site dashboard tiles keep the site filter in their links', async () => {
    mockFetch(mocks([orgScope(ORG_A, ['report:read'])], { dash: { ...DASH, site_id: SITE } }));
    renderRoutes(routes, `/orgs/${ORG_A}/sites/${SITE}/dashboard`);
    await screen.findByRole('region', { name: 'User Statistics' });
    const href = (name: RegExp) => screen.getByRole('link', { name }).getAttribute('href');
    const q = `?site_id=${SITE}`;
    expect(href(/^Online Users/)).toBe(`/orgs/${ORG_A}/sessions${q}`);
    expect(href(/^Active Users/)).toBe(`/orgs/${ORG_A}/users${q}`);
    expect(href(/^New Users Today/)).toBe(`/orgs/${ORG_A}/users${q}`);
    expect(href(/^Sessions Started Today/)).toBe(`/orgs/${ORG_A}/reports${q}`);
    expect(href(/^Active NAS/)).toBe(`/orgs/${ORG_A}/nas${q}`);
    expect(href(/^Silent NAS/)).toBe(`/orgs/${ORG_A}/nas${q}`);
    expect(href(/^Data Today/)).toBe(`/orgs/${ORG_A}/usage${q}`);
    // the client-device list has no site filter in the API
    expect(href(/^Connected Devices/)).toBe(`/orgs/${ORG_A}/client-devices`);
  });

  it('shows "—" on tiles an older API does not provide, never a made-up 0', async () => {
    const { users: _omit, ...older } = DASH;
    void _omit;
    mockFetch(
      mocks([orgScope(ORG_A, ['report:read'])], {
        dash: {
          ...older,
          sessions: {
            open: 12,
            authorized: 2,
            active: 10,
            started_today: 31,
            started_today_basis: 'x',
          },
        },
      }),
    );
    renderRoutes(routes, `/orgs/${ORG_A}/dashboard`);
    expect(
      await screen.findByRole('link', { name: /^Active Users \(30 days\): —/ }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /^New Users Today: —/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /^Online Users: —/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /^Sessions Started Today: 31/ })).toBeInTheDocument();
  });

  it('switches the chart window to daily buckets with site-local date labels', async () => {
    const calls = mockFetch(mocks([orgScope(ORG_A, ['report:read'])]));
    renderRoutes(routes, `/orgs/${ORG_A}/dashboard`);
    fireEvent.change(await screen.findByLabelText('Chart window'), { target: { value: '13m' } });
    await waitFor(() =>
      expect(
        calls.some(
          (c) =>
            c.url.includes('/dashboard/series/usage') &&
            /granularity=day&from=\d{4}-\d{2}-\d{2}&to=\d{4}-\d{2}-\d{2}/.test(c.url),
        ),
      ).toBe(true),
    );
  });

  it('shows empty states for zero-filled series and an organization without NAS', async () => {
    mockFetch(
      mocks([orgScope(ORG_A, ['report:read'])], {
        emptyAuth: true,
        dash: {
          ...DASH,
          enforcement: { pending: 0, overdue: 0, oldest_pending_at: null },
          anomalies: { count: 0, estimated_lost_bytes: 0 },
          nas_activity: {
            ...DASH.nas_activity,
            counts: { registered: 0, active: 0, quiet: 0, silent: 0, never: 0 },
            data: [],
          },
          auth: {
            ...DASH.auth,
            top_reject_reasons: [],
            radius: { ...DASH.auth.radius, by_method: [] },
          },
        },
      }),
    );
    renderRoutes(routes, `/orgs/${ORG_A}/dashboard`);
    expect(await screen.findByText('No RADIUS requests in this window')).toBeInTheDocument();
    expect(screen.getByText('No NAS clients registered')).toBeInTheDocument();
    expect(screen.getByText('No rejections in this window')).toBeInTheDocument();
    expect(screen.queryByText(/policy changes not yet picked up/)).not.toBeInTheDocument();
    expect(screen.queryByText(/accounting anomalies/)).not.toBeInTheDocument();
    expectNoDeviceStateWords();
  });

  it('shows the API problem when the dashboard request fails', async () => {
    mockFetch(
      mocks([orgScope(ORG_A, ['report:read'])], {
        dashStatus: 503,
        dash: { type: 'about:blank', title: 'Service Unavailable', status: 503, detail: 'db down' },
      }),
    );
    renderRoutes(routes, `/orgs/${ORG_A}/dashboard`);
    expect(await screen.findByText(/db down/, undefined, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.queryByLabelText('Key figures')).not.toBeInTheDocument();
  }, 10_000);

  it('without report:read shows record counts and never calls the dashboard endpoint', async () => {
    const calls = mockFetch(mocks([orgScope(ORG_A, ['user:read'])]));
    renderRoutes(routes, `/orgs/${ORG_A}/dashboard`);
    expect(await screen.findByText(/requires the report:read permission/)).toBeInTheDocument();
    expect(await screen.findByText('2')).toBeInTheDocument();
    expect(calls.some((c) => c.url.includes('/dashboard'))).toBe(false);
  });

  it('falls back to record counts against an API without the dashboard endpoint', async () => {
    const calls = mockFetch(
      mocks([orgScope(ORG_A, ['report:read', 'user:read'])], { available: false }),
    );
    renderRoutes(routes, `/orgs/${ORG_A}/dashboard`);
    expect(await screen.findByText('Not available in this API version')).toBeInTheDocument();
    expect(await screen.findByText('2')).toBeInTheDocument();
    expect(calls.some((c) => c.url.includes('/dashboard'))).toBe(false);
  });

  it('site dashboard requests the site scope and is gated by the site binding', async () => {
    const calls = mockFetch(
      mocks(
        [
          {
            scope_type: 'site',
            organization_id: ORG_A,
            site_id: SITE,
            permissions: ['report:read'],
          },
        ],
        {
          dash: { ...DASH, site_id: SITE },
        },
      ),
    );
    renderRoutes(routes, `/orgs/${ORG_A}/sites/${SITE}/dashboard`);
    expect(
      await screen.findByRole('heading', { name: 'Site dashboard · Marina Hotel' }),
    ).toBeInTheDocument();
    const dashCall = calls.find((c) => c.url.split('?')[0] === `${base}/dashboard`)!;
    expect(new URL(dashCall.url, 'http://x').searchParams.get('site_id')).toBe(SITE);
    const nas = screen.getByRole('table', { name: 'NAS activity' });
    expect(within(nas).queryByText('Site')).not.toBeInTheDocument();
    expectNoDeviceStateWords();
  });

  it('site dashboard of another site is forbidden for a site-scoped admin', async () => {
    const calls = mockFetch(
      mocks([
        {
          scope_type: 'site',
          organization_id: ORG_A,
          site_id: 'other',
          permissions: ['report:read'],
        },
      ]),
    );
    renderRoutes(routes, `/orgs/${ORG_A}/sites/${SITE}/dashboard`);
    expect(await screen.findByText('Insufficient permission')).toBeInTheDocument();
    expect(calls.some((c) => c.url.includes('/dashboard'))).toBe(false);
  });
});
