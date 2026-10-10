import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PageHeader } from '../components/ui';
import { adminMe, orgScope, ORG_A, ORG_B, platformScope } from '../test/fixtures';
import { mockFetch, renderRoutes, type MockRoute } from '../test/utils';
import { RequireAuth } from './guards';
import { Shell } from './Shell';
import { NAV_STATE_KEY } from './Sidebar';

const SITE = '01900000-0000-7000-8000-0000000000c1';
const SESSION = '01900000-0000-7000-8000-0000000000e1';

const routes = [
  {
    element: <RequireAuth />,
    children: [
      {
        element: <Shell />,
        children: [
          {
            path: '/orgs/:orgId/sites/:siteId/dashboard',
            element: <PageHeader title="Site page" />,
          },
          {
            path: '/orgs/:orgId/sessions/:sessionId',
            element: <PageHeader title="Session detail" />,
          },
          { path: '/orgs/:orgId/:page', element: <PageHeader title="Org page" /> },
          { path: '/platform/:page', element: <PageHeader title="Organizations" /> },
          { path: '/', element: <p>Home</p> },
        ],
      },
    ],
  },
  { path: '/login', element: <p>Login screen</p> },
];

/** Accessible name without the decorative (aria-hidden) parts. */
function accessibleName(el: HTMLElement): string {
  const label = el.getAttribute('aria-label');
  if (label) return label;
  const copy = el.cloneNode(true) as HTMLElement;
  copy.querySelectorAll('[aria-hidden="true"]').forEach((n) => n.remove());
  return (copy.textContent ?? '').trim();
}

/** Labels of the sidebar group buttons (the ones with aria-expanded). */
function groupButtons(nav: HTMLElement): string[] {
  return within(nav)
    .getAllByRole('button')
    .filter((b) => b.hasAttribute('aria-expanded'))
    .map(accessibleName);
}

const ALL_ORG = [
  'site:read',
  'nas:read',
  'controller:read',
  'network_device:read',
  'session:read',
  'user:read',
  'user_group:read',
  'client_device:read',
  'voucher:read',
  'policy:read',
  'policy_assignment:read',
  'policy:preview',
  'captive_portal:read',
  'accounting:read',
  'report:read',
  'administrator:read',
  'api_key:read',
  'audit_log:read',
];

function orgMocks(permissions: string[] = ALL_ORG, extra: MockRoute[] = []): MockRoute[] {
  return [
    { method: 'GET', path: '/api/v1/auth/me', body: adminMe([orgScope(ORG_A, permissions)]) },
    { method: 'GET', path: `/api/v1/orgs/${ORG_A}`, body: { id: ORG_A, name: 'Acme Hotels' } },
    {
      method: 'GET',
      path: `/api/v1/orgs/${ORG_A}/sites`,
      body: { data: [{ id: SITE, name: 'Marina Hotel' }], next_cursor: null },
    },
    ...extra,
  ];
}

beforeEach(() => localStorage.clear());
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
      .map((a) => accessibleName(a));
    expect(links).toEqual(['Dashboard', 'Users', 'Vouchers']);
    // only the Clients group has a permitted entry; the other groups are hidden entirely
    expect(groupButtons(nav)).toEqual(['Clients']);
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

describe('grouped sidebar', () => {
  it('groups every permitted entry as in the approved menu, with platform separate', async () => {
    mockFetch([
      {
        method: 'GET',
        path: '/api/v1/auth/me',
        body: adminMe([
          orgScope(ORG_A, ALL_ORG),
          platformScope(['platform:health:read', 'tenant:list', 'tenant:impersonate']),
        ]),
      },
      {
        method: 'GET',
        path: '/api/v1/platform/organizations',
        body: { data: [], next_cursor: null },
      },
    ]);
    const user = userEvent.setup();
    renderRoutes(routes, `/orgs/${ORG_A}/dashboard`);
    const nav = await screen.findByRole('navigation', { name: 'Primary' });
    expect(within(nav).getByRole('link', { name: 'Dashboard' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(groupButtons(nav)).toEqual([
      'Bandwidth Management',
      'Network',
      'Clients',
      'Reports',
      'Login Page',
      'Management',
      'Platform',
    ]);
    // open every group and read the entries in order
    for (const b of within(nav).getAllByRole('button')) {
      if (b.getAttribute('aria-expanded') === 'false') await user.click(b);
    }
    const entries = within(nav)
      .getAllByRole('link')
      .map(accessibleName)
      .filter((n) => n !== 'EZECLOUD home');
    expect(entries).toEqual([
      'Dashboard',
      'Policies',
      'Policy assignments',
      'SSID rate-limit export',
      'Sites',
      'NAS clients (access points)',
      'Access Points',
      'Setup guides',
      'Controllers',
      'Network devices',
      'Online sessions',
      'Users',
      'User groups',
      'Client devices',
      'Vouchers',
      'Usage',
      'Accounting records',
      'Reports',
      'Captive portals',
      'Administrators',
      'API keys',
      'Audit log',
      'Summary',
      'Organizations',
      'Adapters',
      'Impersonation',
    ]);
    expect(within(nav).getByRole('link', { name: 'Online sessions' })).toHaveAttribute(
      'href',
      `/orgs/${ORG_A}/sessions`,
    );
    expect(within(nav).getByRole('link', { name: 'Impersonation' })).toHaveAttribute(
      'href',
      '/platform/impersonate',
    );
  });

  it('opens the group of the current route automatically and marks the entry', async () => {
    mockFetch(orgMocks());
    renderRoutes(routes, `/orgs/${ORG_A}/nas`);
    const nav = await screen.findByRole('navigation', { name: 'Primary' });
    expect(within(nav).getByRole('button', { name: 'Network' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    expect(within(nav).getByRole('button', { name: 'Clients' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    expect(within(nav).getByRole('link', { name: 'NAS clients (access points)' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    // entries of closed groups are not exposed
    expect(within(nav).queryByRole('link', { name: 'Users' })).not.toBeInTheDocument();
  });

  it('remembers open and closed groups per browser', async () => {
    mockFetch(orgMocks());
    const user = userEvent.setup();
    const first = renderRoutes(routes, `/orgs/${ORG_A}/dashboard`);
    const nav = await screen.findByRole('navigation', { name: 'Primary' });
    await user.click(within(nav).getByRole('button', { name: 'Reports' }));
    expect(within(nav).getByRole('link', { name: 'Usage' })).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem(NAV_STATE_KEY) ?? '{}')).toMatchObject({
      reports: true,
    });
    first.unmount();

    renderRoutes(routes, `/orgs/${ORG_A}/dashboard`);
    const again = await screen.findByRole('navigation', { name: 'Primary' });
    expect(within(again).getByRole('button', { name: 'Reports' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    expect(within(again).getByRole('button', { name: 'Network' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });

  it('works without storage (private mode): groups still toggle', async () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
      removeItem: () => undefined,
      clear: () => undefined,
    });
    mockFetch(orgMocks());
    const user = userEvent.setup();
    renderRoutes(routes, `/orgs/${ORG_A}/users`);
    const nav = await screen.findByRole('navigation', { name: 'Primary' });
    const network = within(nav).getByRole('button', { name: 'Network' });
    await user.click(network);
    expect(network).toHaveAttribute('aria-expanded', 'true');
  });

  it('groups are keyboard operable buttons tied to their lists', async () => {
    mockFetch(orgMocks());
    const user = userEvent.setup();
    renderRoutes(routes, `/orgs/${ORG_A}/dashboard`);
    const nav = await screen.findByRole('navigation', { name: 'Primary' });
    const mgmt = within(nav).getByRole('button', { name: 'Management' });
    const list = document.getElementById(mgmt.getAttribute('aria-controls') ?? '');
    expect(list).not.toBeNull();
    expect(list).not.toBeVisible();
    mgmt.focus();
    await user.keyboard('{Enter}');
    expect(mgmt).toHaveAttribute('aria-expanded', 'true');
    expect(list).toBeVisible();
    await user.tab();
    expect(within(nav).getByRole('link', { name: 'Administrators' })).toHaveFocus();
    mgmt.focus();
    await user.keyboard(' ');
    expect(mgmt).toHaveAttribute('aria-expanded', 'false');
  });

  it('hides a group whose entries are all hidden and keeps platform permission gating', async () => {
    mockFetch([
      {
        method: 'GET',
        path: '/api/v1/auth/me',
        body: adminMe([platformScope(['platform:health:read'])]),
      },
    ]);
    renderRoutes(routes, '/platform/summary');
    const nav = await screen.findByRole('navigation', { name: 'Primary' });
    expect(groupButtons(nav)).toEqual(['Platform']);
    expect(
      within(nav)
        .getAllByRole('link')
        .map(accessibleName)
        .filter((n) => n !== 'EZECLOUD home'),
    ).toEqual(['Summary', 'Adapters']);
  });

  it('opens as a modal drawer on narrow screens: inert page, Escape and overlay restore focus', async () => {
    mockFetch(orgMocks());
    const user = userEvent.setup();
    renderRoutes(routes, `/orgs/${ORG_A}/dashboard`);
    const toggle = await screen.findByRole('button', { name: 'Toggle navigation' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await user.click(toggle);
    const dialog = screen.getByRole('dialog', { name: 'Navigation menu' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(within(dialog).getByRole('navigation', { name: 'Primary' })).toBeInTheDocument();
    expect(document.getElementById('main')).toHaveAttribute('inert');
    expect(document.querySelector('header')).toHaveAttribute('inert');
    expect(screen.getByRole('button', { name: 'Close navigation' })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(document.getElementById('main')).not.toHaveAttribute('inert');
    await waitFor(() => expect(toggle).toHaveFocus());

    // the overlay closes it and returns focus to the toggle as well
    await user.click(toggle);
    const overlay = document.querySelector<HTMLElement>('.fixed.inset-0.bg-black\\/40')!;
    await user.click(overlay);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await waitFor(() => expect(toggle).toHaveFocus());
  });

  it('following a drawer link closes it and focuses the new page heading, not <body>', async () => {
    mockFetch(orgMocks());
    const user = userEvent.setup();
    renderRoutes(routes, `/orgs/${ORG_A}/dashboard`);
    await user.click(await screen.findByRole('button', { name: 'Toggle navigation' }));
    const dialog = screen.getByRole('dialog', { name: 'Navigation menu' });
    await user.click(within(dialog).getByRole('button', { name: 'Network' }));
    await user.click(within(dialog).getByRole('link', { name: 'Sites' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Org page' })).toHaveFocus());
  });
});

describe('top bar', () => {
  it('shows the wordmark, organization and site chips and the account menu', async () => {
    mockFetch(orgMocks(ALL_ORG, [{ method: 'POST', path: '/api/v1/auth/logout', status: 204 }]));
    const user = userEvent.setup();
    renderRoutes(routes, `/orgs/${ORG_A}/dashboard`);
    expect(await screen.findByRole('button', { name: 'Organization: Acme Hotels' })).toBeVisible();
    expect(screen.getAllByRole('link', { name: 'EZECLOUD home' })[0]).toHaveAttribute('href', '/');
    expect(screen.getByRole('button', { name: 'Site: All sites' })).toBeVisible();
    const account = screen.getByRole('button', { name: 'Account: operator@example.test' });
    await user.click(account);
    const panel = screen.getByRole('group', { name: 'Account' });
    expect(panel).toHaveTextContent('operator@example.test');
    await user.click(within(panel).getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByText('Login screen')).toBeInTheDocument();
  });

  it('switches organization from the organization chip, keeping the current screen', async () => {
    mockFetch([
      {
        method: 'GET',
        path: '/api/v1/auth/me',
        body: adminMe([orgScope(ORG_A, ['user:read']), orgScope(ORG_B, ['user:read'])]),
      },
      { method: 'GET', path: `/api/v1/orgs/${ORG_A}`, body: { id: ORG_A, name: 'Acme Hotels' } },
      { method: 'GET', path: `/api/v1/orgs/${ORG_B}`, body: { id: ORG_B, name: 'Beta Resorts' } },
    ]);
    const user = userEvent.setup();
    renderRoutes(routes, `/orgs/${ORG_A}/users`);
    const chip = await screen.findByRole('button', { name: 'Organization: Acme Hotels' });
    await user.click(chip);
    expect(chip).toHaveAttribute('aria-expanded', 'true');
    await user.keyboard('{Escape}');
    expect(chip).toHaveAttribute('aria-expanded', 'false');
    expect(chip).toHaveFocus();
    await user.click(chip);
    const panel = screen.getByRole('group', { name: 'Organizations' });
    expect(within(panel).getByRole('button', { name: 'Acme Hotels' })).toHaveAttribute(
      'aria-current',
      'true',
    );
    await user.click(within(panel).getByRole('button', { name: 'Beta Resorts' }));
    expect(
      await screen.findByRole('button', { name: 'Organization: Beta Resorts' }),
    ).toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: 'Primary' });
    expect(within(nav).getByRole('link', { name: 'Users' })).toHaveAttribute(
      'href',
      `/orgs/${ORG_B}/users`,
    );
  });

  it('site chip names the filtered site and its picker updates the filter or opens a site dashboard', async () => {
    mockFetch(orgMocks());
    const user = userEvent.setup();
    renderRoutes(routes, `/orgs/${ORG_A}/sessions?site_id=${SITE}`);
    const chip = await screen.findByRole('button', { name: 'Site: Marina Hotel' });
    await user.click(chip);
    await user.click(
      within(screen.getByRole('group', { name: 'Sites' })).getByRole('button', {
        name: 'All sites',
      }),
    );
    expect(await screen.findByRole('button', { name: 'Site: All sites' })).toBeInTheDocument();

    // From the dashboard a site opens that site's dashboard
    const nav = screen.getByRole('navigation', { name: 'Primary' });
    await user.click(within(nav).getByRole('link', { name: 'Dashboard' }));
    await user.click(screen.getByRole('button', { name: 'Site: All sites' }));
    await user.click(
      within(screen.getByRole('group', { name: 'Sites' })).getByRole('button', {
        name: 'Marina Hotel',
      }),
    );
    expect(await screen.findByRole('heading', { name: 'Site page' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Site: Marina Hotel' })).toBeInTheDocument();
  });

  it('chip popovers return focus to the trigger after a pick or an outside click', async () => {
    mockFetch(orgMocks());
    const user = userEvent.setup();
    renderRoutes(routes, `/orgs/${ORG_A}/sessions`);
    const chip = await screen.findByRole('button', { name: 'Site: All sites' });
    await user.click(chip);
    await user.click(
      within(screen.getByRole('group', { name: 'Sites' })).getByRole('button', {
        name: 'All sites',
      }),
    );
    expect(screen.queryByRole('group', { name: 'Sites' })).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: /^Site:/ })).toHaveFocus());

    await user.click(screen.getByRole('button', { name: /^Site:/ }));
    await user.click(document.body);
    expect(screen.queryByRole('group', { name: 'Sites' })).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: /^Site:/ })).toHaveFocus());

    // Tab out of the open panel closes it and leaves focus where it went
    await user.click(screen.getByRole('button', { name: /^Site:/ }));
    expect(screen.getByRole('group', { name: 'Sites' })).toBeInTheDocument();
    for (let i = 0; i < 6; i++) await user.tab();
    expect(screen.queryByRole('group', { name: 'Sites' })).not.toBeInTheDocument();
  });

  it('an invalid ?site_id= means All sites', async () => {
    mockFetch(orgMocks());
    renderRoutes(routes, `/orgs/${ORG_A}/sessions?site_id=not-a-uuid`);
    expect(await screen.findByRole('button', { name: 'Site: All sites' })).toBeInTheDocument();
  });

  it('impersonation pins the organization chip (no switcher)', async () => {
    mockFetch([
      {
        method: 'GET',
        path: '/api/v1/auth/me',
        body: adminMe([orgScope(ORG_A, ['user:read'])], {
          impersonation: {
            organization_id: ORG_A,
            reason: 'Ticket #7',
            expires_at: new Date(Date.now() + 600_000).toISOString(),
          },
        }),
      },
      { method: 'GET', path: `/api/v1/orgs/${ORG_A}`, body: { id: ORG_A, name: 'Acme Hotels' } },
    ]);
    renderRoutes(routes, `/orgs/${ORG_A}/users`);
    await screen.findByRole('region', { name: 'Impersonation active' });
    expect(await screen.findByTitle('Organization')).toHaveTextContent('Acme Hotels');
    expect(screen.queryByRole('button', { name: /^Organization:/ })).not.toBeInTheDocument();
  });
});

describe('breadcrumb', () => {
  it('shows home › organization › parent list › page on detail pages', async () => {
    mockFetch(orgMocks());
    renderRoutes(routes, `/orgs/${ORG_A}/sessions/${SESSION}`);
    const crumb = await screen.findByRole('navigation', { name: 'Breadcrumb' });
    await waitFor(() => expect(crumb).toHaveTextContent('Acme Hotels'));
    const links = within(crumb).getAllByRole('link');
    expect(links.map(accessibleName)).toEqual(['Home', 'Acme Hotels', 'Online sessions']);
    expect(links.map((a) => a.getAttribute('href'))).toEqual([
      '/',
      `/orgs/${ORG_A}/dashboard`,
      `/orgs/${ORG_A}/sessions`,
    ]);
    expect(within(crumb).getByText('Session detail')).toHaveAttribute('aria-current', 'page');
  });

  it('site dashboards sit under Sites; platform pages under Platform', async () => {
    mockFetch(orgMocks());
    const first = renderRoutes(routes, `/orgs/${ORG_A}/sites/${SITE}/dashboard`);
    const crumb = await screen.findByRole('navigation', { name: 'Breadcrumb' });
    expect(within(crumb).getByRole('link', { name: 'Sites' })).toHaveAttribute(
      'href',
      `/orgs/${ORG_A}/sites`,
    );
    first.unmount();
    mockFetch([
      {
        method: 'GET',
        path: '/api/v1/auth/me',
        body: adminMe([platformScope(['tenant:list'])]),
      },
      {
        method: 'GET',
        path: '/api/v1/platform/organizations',
        body: { data: [], next_cursor: null },
      },
    ]);
    renderRoutes(routes, '/platform/organizations');
    const platform = await screen.findByRole('navigation', { name: 'Breadcrumb' });
    expect(platform).toHaveTextContent(/Platform.*Organizations/);
  });
});
