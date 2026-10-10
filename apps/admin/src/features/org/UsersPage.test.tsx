import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { adminMe, orgScope, ORG_A } from '../../test/fixtures';
import { mockFetch, renderRoutes } from '../../test/utils';
import { UsersPage } from './UsersPage';

const SITE = '01900000-0000-7000-8000-0000000000c1';
const base = `/api/v1/orgs/${ORG_A}`;
const routes = [{ path: '/orgs/:orgId/users', element: <UsersPage /> }];

afterEach(() => vi.unstubAllGlobals());

describe('UsersPage site filter', () => {
  it('filters the list by ?site_id= and offers to show all sites', async () => {
    const calls = mockFetch([
      {
        method: 'GET',
        path: '/api/v1/auth/me',
        body: adminMe([orgScope(ORG_A, ['user:read', 'site:read'])]),
      },
      {
        method: 'GET',
        path: `${base}/users`,
        body: { data: [{ id: 'u1', username: 'alice', site_id: SITE }], next_cursor: null },
      },
      {
        method: 'GET',
        path: `${base}/sites`,
        body: { data: [{ id: SITE, name: 'Marina Hotel' }], next_cursor: null },
      },
    ]);
    renderRoutes(routes, `/orgs/${ORG_A}/users?site_id=${SITE}`);
    expect(await screen.findByText(/Showing users of Marina Hotel only/)).toBeInTheDocument();
    const listCall = calls.find((c) => c.url.startsWith(`${base}/users?`))!;
    expect(new URL(listCall.url, 'http://x').searchParams.get('site_id')).toBe(SITE);

    fireEvent.click(screen.getByRole('button', { name: 'Show all sites' }));
    await waitFor(() => expect(screen.queryByText(/Showing users of/)).not.toBeInTheDocument());
    const last = calls.filter((c) => c.url.startsWith(`${base}/users?`)).at(-1)!;
    expect(new URL(last.url, 'http://x').searchParams.get('site_id')).toBeNull();
  });

  it('lists every site without a filter', async () => {
    const calls = mockFetch([
      { method: 'GET', path: '/api/v1/auth/me', body: adminMe([orgScope(ORG_A, ['user:read'])]) },
      { method: 'GET', path: `${base}/users`, body: { data: [], next_cursor: null } },
    ]);
    renderRoutes(routes, `/orgs/${ORG_A}/users`);
    await waitFor(() => expect(calls.some((c) => c.url.startsWith(`${base}/users?`))).toBe(true));
    const listCall = calls.find((c) => c.url.startsWith(`${base}/users?`))!;
    expect(new URL(listCall.url, 'http://x').searchParams.get('site_id')).toBeNull();
    expect(screen.queryByText(/Showing users of/)).not.toBeInTheDocument();
  });
});
