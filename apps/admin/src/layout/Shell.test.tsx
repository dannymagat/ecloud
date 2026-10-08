import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { adminMe, orgScope, ORG_A } from '../test/fixtures';
import { mockFetch, renderRoutes } from '../test/utils';
import { RequireAuth } from './guards';
import { Shell } from './Shell';

const routes = [
  {
    element: <RequireAuth />,
    children: [
      {
        element: <Shell />,
        children: [
          { path: '/orgs/:orgId/:page', element: <p>Org page</p> },
          { path: '/', element: <p>Home</p> },
        ],
      },
    ],
  },
  { path: '/login', element: <p>Login screen</p> },
];

afterEach(() => vi.unstubAllGlobals());

describe('app shell', () => {
  it('renders only permitted navigation for the current organization', async () => {
    mockFetch([
      {
        method: 'GET',
        path: '/api/v1/auth/me',
        body: adminMe([orgScope(ORG_A, ['user:read', 'voucher:read'])]),
      },
      { method: 'GET', path: `/api/v1/orgs/${ORG_A}`, body: { id: ORG_A, name: 'Acme Hotels' } },
    ]);
    renderRoutes(routes, `/orgs/${ORG_A}/users`);
    const nav = await screen.findByRole('navigation', { name: 'Primary' });
    await waitFor(() =>
      expect(within(nav).getByRole('link', { name: 'Users' })).toBeInTheDocument(),
    );
    const links = within(nav)
      .getAllByRole('link')
      .map((a) => a.textContent);
    expect(links).toEqual(['Dashboard', 'Users', 'Vouchers']);
    expect(within(nav).queryByText('Platform')).not.toBeInTheDocument();
  });

  it('shows the impersonation banner with countdown and stops impersonation', async () => {
    const expires = new Date(Date.now() + 10 * 60_000).toISOString();
    const calls = mockFetch([
      {
        method: 'GET',
        path: '/api/v1/auth/me',
        once: true,
        body: adminMe([orgScope(ORG_A, ['site:read'])], {
          impersonation: { organization_id: ORG_A, reason: 'Ticket #42', expires_at: expires },
        }),
      },
      { method: 'GET', path: '/api/v1/auth/me', body: adminMe([orgScope(ORG_A, ['site:read'])]) },
      { method: 'DELETE', path: '/api/v1/platform/support/impersonate', status: 204 },
    ]);
    const user = userEvent.setup();
    renderRoutes(routes, `/orgs/${ORG_A}/sites`);
    const banner = await screen.findByRole('region', { name: 'Impersonation active' });
    expect(banner).toHaveTextContent('Ticket #42');
    expect(banner).toHaveTextContent(/Ends in (9|10):\d\d/);
    await user.click(within(banner).getByRole('button', { name: /stop impersonation/i }));
    await waitFor(() =>
      expect(
        screen.queryByRole('region', { name: 'Impersonation active' }),
      ).not.toBeInTheDocument(),
    );
    const del = calls.find((c) => c.method === 'DELETE');
    expect(del?.headers['X-Requested-With']).toBe('XMLHttpRequest');
  });

  it('redirects to login when there is no session', async () => {
    mockFetch([
      {
        method: 'GET',
        path: '/api/v1/auth/me',
        status: 401,
        body: { type: 't', title: 'Unauthorized', status: 401 },
      },
    ]);
    renderRoutes(routes, `/orgs/${ORG_A}/sites`);
    expect(await screen.findByText('Login screen')).toBeInTheDocument();
  });
});
