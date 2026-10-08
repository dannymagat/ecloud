import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ScopedPermissions } from '../../api/types';
import {
  FORBIDDEN_DEVICE_WORDS,
  type ReportDefinition,
  type ReportResult,
} from '../../lib/dashboard';
import { adminMe, orgScope, ORG_A } from '../../test/fixtures';
import { mockFetch, renderRoutes, type MockRoute } from '../../test/utils';
import { ReportsPage } from './ReportsPage';

const SITE = '01900000-0000-7000-8000-0000000000c1';
const base = `/api/v1/orgs/${ORG_A}`;
const routes = [{ path: '/orgs/:orgId/reports', element: <ReportsPage /> }];

const openapi = (available: boolean) => ({
  openapi: '3.1.0',
  paths: available
    ? {
        '/api/v1/orgs/{orgId}/reports': { get: {} },
        '/api/v1/orgs/{orgId}/reports/{key}': { get: {} },
        '/api/v1/orgs/{orgId}/reports/{key}/export': { post: {} },
      }
    : {},
});

const DEFS: ReportDefinition[] = [
  {
    key: 'usage_by_site',
    title: 'Usage by site',
    description: 'Traffic per site and site-local period.',
    params: [
      { name: 'period', type: 'string', required: false, default: 'daily', description: '' },
      { name: 'from', type: 'date', required: false, default: null, description: '' },
      { name: 'to', type: 'date', required: false, default: null, description: '' },
      { name: 'site_id', type: 'uuid', required: false, default: null, description: '' },
    ],
    columns: [
      { key: 'site_name', label: 'Site', type: 'string', unit: null },
      { key: 'period_start', label: 'Period', type: 'date', unit: null },
      { key: 'bytes_total', label: 'Total', type: 'number', unit: 'bytes' },
      { key: 'session_count', label: 'Sessions', type: 'number', unit: null },
    ],
    export_permission: 'report:export',
  },
  {
    key: 'nas_activity',
    title: 'NAS activity',
    description: 'Observed RADIUS activity per NAS.',
    params: [
      { name: 'from', type: 'date', required: false, default: null, description: '' },
      { name: 'to', type: 'date', required: false, default: null, description: '' },
    ],
    columns: [
      { key: 'name', label: 'NAS', type: 'string', unit: null },
      { key: 'activity', label: 'Observed activity', type: 'string', unit: null },
    ],
    export_permission: 'report:export',
  },
];

const RESULT: ReportResult = {
  report: 'usage_by_site',
  title: 'Usage by site',
  params: { period: 'monthly', from: '2026-08-01', to: '2026-09-01' },
  timezone: 'Asia/Dubai',
  label_basis: 'site-local calendar months',
  columns: DEFS[0]!.columns,
  rows: [
    {
      site_name: 'Marina Hotel',
      period_start: '2026-09-01',
      bytes_total: 3 * 1024 ** 3,
      session_count: 12345,
    },
  ],
  row_count: 1,
  measured_at: '2026-10-08T10:00:00Z',
  notes: ['Site usage starts at migration 024 (no backfill).'],
  freshness: {
    measured_at: '2026-10-08T10:00:00Z',
    last_accounting_at: '2026-10-08T09:58:00Z',
    freshness_s: 120,
    expected_lag_s: 605,
  },
};

function mocks(
  scopes: ScopedPermissions[],
  opts: { available?: boolean; impersonating?: boolean; runStatus?: number } = {},
): MockRoute[] {
  return [
    {
      method: 'GET',
      path: '/api/v1/auth/me',
      body: adminMe(
        scopes,
        opts.impersonating
          ? { impersonation: { organization_id: ORG_A, reason: 't', expires_at: '2099-01-01' } }
          : {},
      ),
    },
    { method: 'GET', path: '/api/v1/openapi.json', body: openapi(opts.available ?? true) },
    { method: 'GET', path: `${base}/reports`, body: { data: DEFS } },
    {
      method: 'GET',
      path: new RegExp(`${base}/reports/usage_by_site`),
      status: opts.runStatus,
      body:
        opts.runStatus && opts.runStatus >= 400
          ? { type: 'about:blank', title: 'Too many rows', status: 422, detail: 'narrow the range' }
          : RESULT,
    },
    {
      method: 'GET',
      path: `${base}/sites`,
      body: { data: [{ id: SITE, name: 'Marina Hotel' }], next_cursor: null },
    },
  ];
}

afterEach(() => vi.unstubAllGlobals());

async function runMonthly() {
  fireEvent.change(await screen.findByLabelText('Period'), { target: { value: 'monthly' } });
  fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-08' } });
  fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-09' } });
  fireEvent.change(screen.getByLabelText('Site'), { target: { value: SITE } });
  fireEvent.click(screen.getByRole('button', { name: 'Run report' }));
}

describe('ReportsPage', () => {
  it('runs a report with site-local period params, shows the table, notes and freshness', async () => {
    const calls = mockFetch(
      mocks([orgScope(ORG_A, ['report:read', 'report:export', 'site:read'])]),
    );
    renderRoutes(routes, `/orgs/${ORG_A}/reports`);
    await runMonthly();

    const table = await screen.findByRole('table', { name: 'Usage by site results' });
    expect(within(table).getByText('3.0 GB')).toBeInTheDocument();
    expect(within(table).getByText('12,345')).toBeInTheDocument();
    expect(screen.getByText('Period labels: site-local calendar months')).toBeInTheDocument();
    expect(screen.getByText(/no backfill/)).toBeInTheDocument();
    expect(screen.getByText('Last accounting 2 min ago')).toBeInTheDocument();

    const run = calls.find((c) => c.url.includes('/reports/usage_by_site'))!;
    const q = new URL(run.url, 'http://x').searchParams;
    expect(Object.fromEntries(q)).toEqual({
      period: 'monthly',
      from: '2026-08-01',
      to: '2026-09-01',
      site_id: SITE,
    });
  });

  it('exports CSV with the same params when report:export is held', async () => {
    const calls = mockFetch([
      {
        method: 'POST',
        path: `${base}/reports/usage_by_site/export`,
        body: 'site_name\nMarina Hotel\n',
      },
      ...mocks([orgScope(ORG_A, ['report:read', 'report:export', 'site:read'])]),
    ]);
    const createObjectURL = vi.fn(() => 'blob:x');
    Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() });
    renderRoutes(routes, `/orgs/${ORG_A}/reports`);
    await runMonthly();
    fireEvent.click(await screen.findByRole('button', { name: 'Export CSV' }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/export'))).toBe(true),
    );
    await waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(1));
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.body).toEqual({
      period: 'monthly',
      from: '2026-08-01',
      to: '2026-09-01',
      site_id: SITE,
    });
  });

  it('Read Only (report:read without report:export) sees reports but no export (Q75)', async () => {
    mockFetch(mocks([orgScope(ORG_A, ['report:read'])]));
    renderRoutes(routes, `/orgs/${ORG_A}/reports`);
    expect(
      await screen.findByText(/CSV export requires the report:export permission/),
    ).toBeInTheDocument();
    // No site:read: the site picker is not offered.
    expect(screen.queryByLabelText('Site')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Run report' }));
    expect(await screen.findByRole('table', { name: 'Usage by site results' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Export CSV' })).not.toBeInTheDocument();
  });

  it('hides export while impersonating (D-027)', async () => {
    mockFetch(mocks([orgScope(ORG_A, ['report:read', 'report:export'])], { impersonating: true }));
    renderRoutes(routes, `/orgs/${ORG_A}/reports`);
    expect(
      await screen.findByText('Exports are not available while impersonating.'),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Run report' }));
    await screen.findByRole('table', { name: 'Usage by site results' });
    expect(screen.queryByRole('button', { name: 'Export CSV' })).not.toBeInTheDocument();
  });

  it('shows the row-cap problem and validates the range before running', async () => {
    mockFetch(mocks([orgScope(ORG_A, ['report:read'])], { runStatus: 422 }));
    renderRoutes(routes, `/orgs/${ORG_A}/reports`);
    fireEvent.change(await screen.findByLabelText('From'), { target: { value: '2026-09-10' } });
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-09-01' } });
    expect(screen.getByRole('alert')).toHaveTextContent('"To" must not be before "From".');
    expect(screen.getByRole('button', { name: 'Run report' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-09-30' } });
    fireEvent.click(screen.getByRole('button', { name: 'Run report' }));
    expect(await screen.findByText(/narrow the range/)).toBeInTheDocument();
  });

  it('labels observed NAS activity without device-state wording', async () => {
    mockFetch([
      {
        method: 'GET',
        path: new RegExp(`${base}/reports/nas_activity`),
        body: {
          ...RESULT,
          report: 'nas_activity',
          title: 'NAS activity',
          columns: DEFS[1]!.columns,
          rows: [
            { name: 'Lobby AP', activity: 'silent' },
            { name: 'Pool AP', activity: 'never' },
          ],
          notes: [],
          freshness: null,
        },
      },
      ...mocks([orgScope(ORG_A, ['report:read'])]),
    ]);
    renderRoutes(routes, `/orgs/${ORG_A}/reports`);
    fireEvent.change(await screen.findByLabelText('Report'), { target: { value: 'nas_activity' } });
    fireEvent.click(screen.getByRole('button', { name: 'Run report' }));
    const table = await screen.findByRole('table', { name: 'NAS activity results' });
    expect(within(table).getByText('Silent')).toBeInTheDocument();
    expect(within(table).getByText('No activity seen')).toBeInTheDocument();
    const text = document.body.textContent ?? '';
    for (const word of FORBIDDEN_DEVICE_WORDS) expect(text).not.toMatch(word);
  });

  it('requires report:read and reports an API without the endpoints', async () => {
    mockFetch(mocks([orgScope(ORG_A, ['accounting:read'])]));
    const view = renderRoutes(routes, `/orgs/${ORG_A}/reports`);
    expect(await screen.findByText('Insufficient permission')).toBeInTheDocument();
    view.unmount();
    vi.unstubAllGlobals();
    mockFetch(mocks([orgScope(ORG_A, ['report:read'])], { available: false }));
    renderRoutes(routes, `/orgs/${ORG_A}/reports`);
    expect(await screen.findByText('Not available in this API version')).toBeInTheDocument();
  });
});
