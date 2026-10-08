import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ScopedPermissions } from '../../api/types';
import type { TopReport, UsageReport } from '../../lib/accounting';
import { adminMe, orgScope, ORG_A } from '../../test/fixtures';
import { mockFetch, renderRoutes, type MockRoute } from '../../test/utils';
import { UsagePage } from './UsagePage';

const USER = '01900000-0000-7000-8000-0000000000e1';
const base = `/api/v1/orgs/${ORG_A}`;
const routes = [{ path: '/orgs/:orgId/usage', element: <UsagePage /> }];

const openapi = (available: boolean) => ({
  openapi: '3.1.0',
  paths: available
    ? {
        '/api/v1/orgs/{orgId}/usage': { get: {} },
        '/api/v1/orgs/{orgId}/usage/top': { get: {} },
        '/api/v1/orgs/{orgId}/usage/export': { post: {} },
      }
    : {},
});

const counters = (total: number) => ({
  bytes_in: total / 4,
  bytes_out: (total * 3) / 4,
  bytes_total: total,
  session_count: 3,
  session_time_s: 3600,
});

const ORG_USAGE: UsageReport = {
  subject_type: 'organization',
  subject_id: null,
  label: null,
  period: 'daily',
  timezone: 'Asia/Dubai',
  series: [],
  total: counters(4 * 1024 ** 3),
  current: {
    period_start: '2026-10-08',
    period_end: '2026-10-09T00:00:00+04:00',
    ...counters(1024 ** 3),
  },
  quota: null,
  current_unavailable_reason: null,
  label_basis: 'site-local calendar dates (Asia/Dubai)',
  measured_at: '2026-10-08T09:11:30Z',
  last_accounting_at: '2026-10-08T09:10:00Z',
  freshness_s: 90,
  expected_lag_s: 305,
};

const TOP: TopReport = {
  subject_type: 'user',
  period: 'daily',
  period_start: null,
  label_basis: 'site-local dates; each site its own current day',
  data: [
    {
      rank: 1,
      subject_id: USER,
      label: 'alice',
      period_start: '2026-10-08',
      last_accounting_at: '2026-10-08T09:10:00Z',
      ...counters(2 * 1024 ** 3),
    },
  ],
  measured_at: '2026-10-08T09:11:30Z',
  last_accounting_at: '2026-10-08T09:10:00Z',
  freshness_s: 90,
  expected_lag_s: 305,
};

const USER_USAGE: UsageReport = {
  ...ORG_USAGE,
  subject_type: 'user',
  subject_id: USER,
  label: 'alice',
  series: [{ period_start: '2026-10-08', period_end: null, ...counters(2 * 1024 ** 3) }],
  quota: {
    policy_id: 'pol-1',
    policy_name: 'Standard',
    policy_source: 'open_session',
    periods: [
      {
        period: 'daily',
        limit_bytes: 4 * 1024 ** 3,
        used_bytes: 2 * 1024 ** 3,
        remaining_bytes: 2 * 1024 ** 3,
        exceeded: false,
        period_start: '2026-10-08',
        period_end: '2026-10-09T00:00:00+04:00',
      },
    ],
  },
};

function mocks(scopes: ScopedPermissions[], available = true, impersonating = false): MockRoute[] {
  return [
    {
      method: 'GET',
      path: '/api/v1/auth/me',
      body: adminMe(
        scopes,
        impersonating
          ? {
              impersonation: { organization_id: ORG_A, reason: 'ticket', expires_at: '2099-01-01' },
            }
          : {},
      ),
    },
    { method: 'GET', path: '/api/v1/openapi.json', body: openapi(available) },
    { method: 'GET', path: `${base}/usage/top`, body: TOP },
    { method: 'GET', path: new RegExp(`${base}/usage\\?.*subject_id=`), body: USER_USAGE },
    { method: 'GET', path: `${base}/usage`, body: ORG_USAGE },
  ];
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('UsagePage', () => {
  it('shows organization totals, top-N and a subject quota position with freshness', async () => {
    const calls = mockFetch(mocks([orgScope(ORG_A, ['accounting:read'])]));
    renderRoutes(routes, `/orgs/${ORG_A}/usage`);

    const today = await screen.findByLabelText(/Current day/);
    expect(within(today).getByText('1.0 GB')).toBeInTheDocument();
    expect(screen.getByText('Time zone: Asia/Dubai')).toBeInTheDocument();
    expect(screen.getAllByText('Last accounting 2 min ago').length).toBeGreaterThan(0);

    const top = await screen.findByRole('table', { name: 'Top users by traffic' });
    expect(within(top).getByText('2.0 GB')).toBeInTheDocument();
    const topCall = calls.find((c) => c.url.includes('/usage/top'))!;
    const q = new URL(topCall.url, 'http://x').searchParams;
    expect([q.get('subject_type'), q.get('period'), q.get('limit')]).toEqual([
      'user',
      'daily',
      '10',
    ]);

    fireEvent.click(within(top).getByRole('button', { name: 'alice' }));
    const meter = await screen.findByRole('meter', { name: 'Daily quota used' });
    expect(meter).toHaveAttribute('aria-valuenow', '50');
    expect(screen.getByText('2.0 GB left')).toBeInTheDocument();
    expect(screen.getByText(/not by the device/)).toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'Usage by period' })).toBeInTheDocument();

    // export hidden without report:export
    expect(screen.queryByRole('button', { name: 'Export CSV' })).toBeNull();
  });

  it('switches period and ranking subject', async () => {
    const calls = mockFetch(mocks([orgScope(ORG_A, ['accounting:read'])]));
    renderRoutes(routes, `/orgs/${ORG_A}/usage`);
    await screen.findByRole('table', { name: 'Top users by traffic' });
    fireEvent.change(screen.getByLabelText('Period'), { target: { value: 'monthly' } });
    fireEvent.click(screen.getByRole('tab', { name: 'Sites' }));
    await waitFor(() => {
      const last = calls.filter((c) => c.url.includes('/usage/top')).at(-1)!;
      const q = new URL(last.url, 'http://x').searchParams;
      expect([q.get('subject_type'), q.get('period')]).toEqual(['site', 'monthly']);
    });
  });

  it('shows Export CSV with report:export, never while impersonating', async () => {
    mockFetch(mocks([orgScope(ORG_A, ['accounting:read', 'report:export'])]));
    const view = renderRoutes(routes, `/orgs/${ORG_A}/usage`);
    expect(await screen.findByRole('button', { name: 'Export CSV' })).toBeEnabled();
    view.unmount();
    vi.unstubAllGlobals();

    mockFetch(mocks([orgScope(ORG_A, ['accounting:read', 'report:export'])], true, true));
    renderRoutes(routes, `/orgs/${ORG_A}/usage`);
    await screen.findByRole('table', { name: 'Top users by traffic' });
    expect(screen.queryByRole('button', { name: 'Export CSV' })).toBeNull();
  });

  it('shows labels basis, per-row period labels and an unavailable current period', async () => {
    const mixed: UsageReport = {
      ...ORG_USAGE,
      timezone: 'mixed',
      current: null,
      current_unavailable_reason: 'Sites span several time zones; each counts its own day.',
    };
    mockFetch([
      { method: 'GET', path: `${base}/usage`, body: mixed },
      ...mocks([orgScope(ORG_A, ['accounting:read'])]),
    ]);
    renderRoutes(routes, `/orgs/${ORG_A}/usage`);
    expect(await screen.findByText('Current day not available')).toBeInTheDocument();
    expect(screen.getByText(/Sites span several time zones; each counts/)).toBeInTheDocument();
    expect(screen.getByText('Time zone: each site its own')).toBeInTheDocument();
    expect(
      screen.getByText('Period labels: site-local calendar dates (Asia/Dubai)'),
    ).toBeInTheDocument();
    const top = await screen.findByRole('table', { name: 'Top users by traffic' });
    expect(within(top).getByText('2026-10-08')).toBeInTheDocument();
    expect(
      screen.getByText('Period labels: site-local dates; each site its own current day'),
    ).toBeInTheDocument();
  });

  it('asks for a period when the ranking needs one (sites in several time zones)', async () => {
    const calls = mockFetch([
      {
        method: 'GET',
        path: new RegExp(`${base}/usage/top\\?(?!.*period_start)`),
        status: 400,
        body: {
          type: 'about:blank',
          title: 'Bad Request',
          status: 400,
          detail: 'period_start required',
        },
      },
      ...mocks([orgScope(ORG_A, ['accounting:read'])]),
    ]);
    renderRoutes(routes, `/orgs/${ORG_A}/usage`);
    expect(await screen.findByText('Choose the period to rank')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/^Day/), { target: { value: '2026-10-07' } });
    expect(await screen.findByRole('table', { name: 'Top users by traffic' })).toBeInTheDocument();
    const last = calls.filter((c) => c.url.includes('/usage/top')).at(-1)!;
    expect(new URL(last.url, 'http://x').searchParams.get('period_start')).toBe('2026-10-07');
  });

  it('says the endpoint is not available against an API without it', async () => {
    const calls = mockFetch(mocks([orgScope(ORG_A, ['accounting:read'])], false));
    renderRoutes(routes, `/orgs/${ORG_A}/usage`);
    expect(await screen.findByText('Not available in this API version')).toBeInTheDocument();
    expect(calls.some((c) => c.url.includes('/usage'))).toBe(false);
  });

  it('requires accounting:read', async () => {
    mockFetch(mocks([orgScope(ORG_A, ['session:read'])]));
    renderRoutes(routes, `/orgs/${ORG_A}/usage`);
    expect(await screen.findByText('Insufficient permission')).toBeInTheDocument();
  });
});
