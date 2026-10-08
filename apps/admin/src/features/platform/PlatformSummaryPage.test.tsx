import { screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FORBIDDEN_DEVICE_WORDS, type PlatformDashboard } from '../../lib/dashboard';
import { adminMe, orgScope, ORG_A, platformScope } from '../../test/fixtures';
import { mockFetch, renderRoutes } from '../../test/utils';
import { PlatformSummaryPage } from './PlatformSummaryPage';

const routes = [{ path: '/platform/summary', element: <PlatformSummaryPage /> }];

const SUMMARY: PlatformDashboard = {
  measured_at: '2026-10-08T10:00:00Z',
  window: { from: '2026-10-07T10:00:00Z', to: '2026-10-08T10:00:00Z' },
  thresholds: { active_within_s: 1200, quiet_within_s: 86400 },
  unattributed: { radius_requests_24h: 5 },
  definition: 'Observed RADIUS activity per NAS.',
  data: [
    {
      organization_id: ORG_A,
      name: 'Acme Hotels',
      slug: 'acme',
      status: 'active',
      sites: 3,
      nas_registered: 4,
      nas_activity: { active: 2, quiet: 1, silent: 0, never: 1 },
      network_devices_registered: 6,
      open_sessions: 40,
      sessions_started_24h: 1234,
      radius_accept_24h: 1500,
      radius_reject_24h: 30,
      portal_attempts_24h: 200,
      portal_lockouts_24h: 1,
      enforcement_pending: 0,
      anomalies_24h: 0,
      nas_activity_truncated: false,
    },
  ],
  next_cursor: null,
};

const openapi = (available: boolean) => ({
  openapi: '3.1.0',
  paths: available ? { '/api/v1/platform/dashboard': { get: {} } } : {},
});

afterEach(() => vi.unstubAllGlobals());

describe('PlatformSummaryPage', () => {
  it('lists per-organization counts and observed NAS activity, without device-state words', async () => {
    const calls = mockFetch([
      {
        method: 'GET',
        path: '/api/v1/auth/me',
        body: adminMe([platformScope(['platform:health:read'])]),
      },
      { method: 'GET', path: '/api/v1/openapi.json', body: openapi(true) },
      { method: 'GET', path: '/api/v1/platform/dashboard', body: SUMMARY },
    ]);
    renderRoutes(routes, '/platform/summary');
    const table = await screen.findByRole('table', { name: 'Organization summary' });
    const row = within(table).getByRole('link', { name: 'Acme Hotels' }).closest('tr')!;
    expect(within(row).getByText('2 / 1 / 0 / 1')).toBeInTheDocument();
    expect(within(row).getByText('1,500 / 30')).toBeInTheDocument();
    expect(within(row).getByText('1,234')).toBeInTheDocument();
    expect(screen.getByText(/not attributable to any organization: 5/)).toBeInTheDocument();
    const url = new URL(calls.find((c) => c.url.includes('/platform/dashboard'))!.url, 'http://x');
    expect(url.searchParams.get('limit')).toBe('25');
    const text = document.body.textContent ?? '';
    for (const word of FORBIDDEN_DEVICE_WORDS) expect(text).not.toMatch(word);
  });

  it('requires platform:health:read on a platform binding', async () => {
    const calls = mockFetch([
      {
        method: 'GET',
        path: '/api/v1/auth/me',
        body: adminMe([orgScope(ORG_A, ['platform:health:read', 'report:read'])]),
      },
      { method: 'GET', path: '/api/v1/openapi.json', body: openapi(true) },
    ]);
    renderRoutes(routes, '/platform/summary');
    expect(await screen.findByText('Insufficient permission')).toBeInTheDocument();
    expect(calls.some((c) => c.url.includes('/platform/dashboard'))).toBe(false);
  });

  it('says when the API does not serve the platform summary', async () => {
    mockFetch([
      {
        method: 'GET',
        path: '/api/v1/auth/me',
        body: adminMe([platformScope(['platform:health:read'])]),
      },
      { method: 'GET', path: '/api/v1/openapi.json', body: openapi(false) },
    ]);
    renderRoutes(routes, '/platform/summary');
    expect(await screen.findByText('Not available in this API version')).toBeInTheDocument();
  });
});
