import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient } from '../../App';
import { AuthProvider } from '../../lib/auth';
import { adminMe, orgScope, ORG_A } from '../../test/fixtures';
import { mockFetch, renderRoutes, type MockRoute } from '../../test/utils';
import { AdministratorsPage } from '../admins/AdministratorsPage';
import type { Catalogue, CatalogueEntry, VendorGuide } from '../setup-guides/types';
import { AccessPointsPage } from './AccessPointsPage';
import { nasFields, validateMacRows } from './AddAccessPointWizard';
import type { Overview } from './data';
import { REVEAL_SECONDS } from './RadiusSecretBox';
import { EMPTY_TEXT } from './AccessPointsTable';

const base = `/api/v1/orgs/${ORG_A}`;
const NAS1 = '01900000-0000-7000-8000-0000000000e1';
const NAS2 = '01900000-0000-7000-8000-0000000000e2';
const SITE = '01900000-0000-7000-8000-0000000000f1';
// Test values (RFC 5737 / example.test): not deployment facts.
const SECRET = 'test-revealed-radius-secret-value';

const ALL = [
  'nas:read',
  'nas:create',
  'nas:update',
  'nas:delete',
  'nas:secret:rotate',
  'nas:secret:reveal',
  'administrator:invite',
  'policy:read',
  'site:read',
];

const entry = (
  vendor_key: string,
  display_name: string,
  adapter_key: string,
  profile: string | null = null,
): CatalogueEntry => ({
  vendor_key,
  display_name,
  product_line: `${display_name} line`,
  adapter_key,
  profile,
  family: 'external-portal',
  family_label: 'External portal',
  status: 'documented',
  status_label: 'Documented, not yet device-tested',
  lifecycle: null,
});

const CATALOGUE: Catalogue = {
  data: [
    entry('mikrotik', 'MikroTik', 'mikrotik-hotspot'),
    entry('aruba', 'HPE Aruba', 'external-portal-postback', 'aruba-ecp'),
    entry('grandstream', 'Grandstream', 'external-portal-postback', 'postback-generic'),
  ],
  families: [{ key: 'external-portal', label: 'External portal' }],
};

const steps = (n: number): Overview['progress'] => ({
  steps: [
    { key: 'nas_added', label: 'NAS added', done: n > 0 },
    { key: 'radius_secret', label: 'RADIUS secret configured', done: n > 1 },
    { key: 'ap_registered', label: 'AP MAC registered', done: n > 2 },
    { key: 'radius_seen', label: 'First RADIUS request seen', done: n > 3 },
    { key: 'guest_login', label: 'First successful guest login', done: n > 4 },
  ],
  completed: n,
  total: 5,
});

const nas = (id: string, name: string, adapter_key: string, vendor_key: string | null) => ({
  id,
  name,
  site_id: SITE,
  site_name: 'Lobby site',
  adapter_key,
  vendor_key,
  vendor_name: vendor_key === 'mikrotik' ? 'MikroTik' : vendor_key === 'aruba' ? 'HPE Aruba' : null,
  nas_ip: '10.0.0.2',
  status: 'active',
  has_secret: true,
  activity: 'quiet' as const,
  last_activity_at: null,
  access_points: 1,
});

const OVERVIEW: Overview = {
  progress: steps(3),
  support_email: 'support@example.test',
  activity_definition: 'Observed RADIUS activity only.',
  nas: [nas(NAS1, 'Aruba controller', 'external-portal-postback', 'aruba')],
  access_points: [
    {
      id: 'ap1',
      mac: '02:aa:bb:cc:dd:01',
      name: 'Lobby AP',
      status: 'active',
      site_id: SITE,
      nas_client_id: NAS1,
      nas_name: 'Aruba controller',
      adapter_key: 'external-portal-postback',
      vendor_key: 'aruba',
      vendor_name: 'HPE Aruba',
      verified: false,
      verified_at: null,
      verification_source: null,
      activity: 'quiet',
      created_at: '2026-10-10T08:00:00.000Z',
    },
  ],
  truncated: false,
};

const EMPTY: Overview = {
  ...OVERVIEW,
  progress: steps(0),
  support_email: null,
  nas: [],
  access_points: [],
};

const MIKROTIK_GUIDE: VendorGuide = {
  ...CATALOGUE.data[0]!,
  site: null,
  portal_url: 'https://portal.example.test/hotspot/mikrotik/',
  walled_garden: ['portal.example.test'],
  radius: { address: '192.0.2.53', auth_port: 1812, acct_port: 1813, coa_port: 3799 },
  preflight: [],
  vendor_notes: [],
  steps: [
    {
      id: 'radius-server',
      title: 'RADIUS server for the HotSpot service',
      setting: '/radius add',
      value: '192.0.2.53, <RADIUS_SECRET>',
      evidence: [],
      secret: true,
    },
    {
      id: 'walled-garden',
      title: 'Walled garden',
      setting: '/ip hotspot walled-garden add dst-host=',
      value: 'portal.example.test',
      evidence: [],
      secret: false,
    },
  ],
  warnings: [],
  secret_note: 'Secrets are never shown in a guide.',
  add_nas: { adapter_key: 'mikrotik-hotspot', profile: null },
  meraki: null,
};

function routes(overview: Overview, perms = ALL, extra: MockRoute[] = []): MockRoute[] {
  return [
    ...extra,
    { method: 'GET', path: '/api/v1/auth/me', body: adminMe([orgScope(ORG_A, perms)]) },
    { method: 'GET', path: `${base}/access-points/overview`, body: overview },
    { method: 'GET', path: `${base}/setup-guides`, body: CATALOGUE },
    { method: 'GET', path: `${base}/setup-guides/mikrotik`, body: MIKROTIK_GUIDE },
    {
      method: 'GET',
      path: `${base}/sites`,
      body: { data: [{ id: SITE, name: 'Lobby site' }], next_cursor: null },
    },
  ];
}

const PAGES = [
  { path: '/orgs/:orgId/access-points', element: <AccessPointsPage /> },
  { path: '/orgs/:orgId/access-points/setup-guides/:vendorKey', element: <p>Guide page</p> },
  { path: '/orgs/:orgId/access-points/setup-guides', element: <p>Gallery page</p> },
  { path: '/orgs/:orgId/administrators', element: <AdministratorsPage /> },
];

const writeText = vi.fn<(text: string) => Promise<void>>();

beforeEach(() => {
  writeText.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('Access Points page (D-045)', () => {
  it('renders the header actions, the setup card, the secret box, the table and the logo grid', async () => {
    mockFetch(routes(OVERVIEW));
    const view = renderRoutes(PAGES, `/orgs/${ORG_A}/access-points`);
    expect(await screen.findByRole('heading', { name: 'Access Points', level: 1 })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Add' })).toBeInTheDocument();
    // the setup guides are part of Access Points: a header button opens the gallery
    expect(screen.getByRole('link', { name: 'Setup guides' })).toHaveAttribute(
      'href',
      `/orgs/${ORG_A}/access-points/setup-guides`,
    );
    expect(screen.getByRole('link', { name: 'View all setup guides' })).toHaveAttribute(
      'href',
      `/orgs/${ORG_A}/access-points/setup-guides`,
    );
    expect(screen.getByRole('link', { name: 'Network Limits' })).toHaveAttribute(
      'href',
      `/orgs/${ORG_A}/policies`,
    );
    expect(
      screen.getByRole('button', { name: 'Download MikroTik installation script' }),
    ).toBeInTheDocument();

    // setup card with real progress
    const card = (await screen.findByRole('heading', { name: 'Configure Access Points' })).closest(
      'section',
    ) as HTMLElement;
    expect(within(card).getByText('3 of 5')).toBeInTheDocument();
    expect(within(card).getByRole('progressbar')).toHaveAttribute('aria-valuenow', '3');
    expect(within(card).getByText(/To use ECLOUD at your venue/)).toBeInTheDocument();
    expect(within(card).getByRole('link', { name: 'Invite a member' })).toHaveAttribute(
      'href',
      `/orgs/${ORG_A}/administrators?invite=1&invite_role=read_only`,
    );
    expect(within(card).getByRole('link', { name: 'contact us' })).toHaveAttribute(
      'href',
      'mailto:support@example.test',
    );
    expect(within(card).getByRole('link', { name: /Invite IT Staff/ })).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: /Add Access Point/ })).toBeInTheDocument();

    // RADIUS secret box: masked, reveal + rotate
    expect(screen.getByTestId('radius-secret-value')).toHaveTextContent('••••');
    expect(screen.getByRole('button', { name: /Reveal and copy/ })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Rotate secret' })).toBeInTheDocument();

    // table
    const table = screen.getByRole('table', { name: 'Access points' });
    expect(within(table).getByText('02:aa:bb:cc:dd:01')).toBeInTheDocument();
    expect(within(table).getByText('HPE Aruba')).toBeInTheDocument();
    expect(within(table).getByText('Unverified')).toBeInTheDocument();
    expect(within(table).getByText('NAS: Quiet')).toBeInTheDocument();
    expect(within(table).getByRole('link', { name: /Setup guide for/ })).toHaveAttribute(
      'href',
      `/orgs/${ORG_A}/access-points/setup-guides/aruba`,
    );
    for (const h of ['MAC address', 'Vendor', 'Name', 'Status', 'Date added', 'Actions']) {
      expect(within(table).getByRole('columnheader', { name: h })).toBeInTheDocument();
    }

    // vendor grid: logos self-hosted, tiles link to the guides, trademark notice
    const grid = await screen.findByRole('list', { name: 'Vendor setup guides' });
    expect(within(grid).getAllByRole('link')).toHaveLength(3);
    expect(within(grid).getByRole('link', { name: /MikroTik/ })).toHaveAttribute(
      'href',
      `/orgs/${ORG_A}/access-points/setup-guides/mikrotik`,
    );
    const srcs = [...view.container.querySelectorAll('img')].map((i) => i.getAttribute('src'));
    expect(srcs).toContain('/vendor-logos/mikrotik.svg');
    expect(srcs).toContain('/vendor-logos/aruba.svg');
    for (const src of srcs) expect(src).toMatch(/^\/vendor-logos\/[a-z0-9-]+\.svg$/);
    // no official SVG for Grandstream: a wordmark tile
    const grandstream = within(grid).getByTestId('vendor-grandstream');
    expect(within(grandstream).getAllByText('Grandstream')).toHaveLength(2);
    expect(grandstream.querySelector('img')).toBeNull();
    expect(
      screen.getAllByText(
        'Logos are trademarks of their respective owners and identify compatible hardware only.',
      ).length,
    ).toBeGreaterThan(0);
  });

  it('empty state: text and "Add Access Points"; no support link without PUBLIC_SUPPORT_EMAIL', async () => {
    mockFetch(routes(EMPTY));
    renderRoutes(PAGES, `/orgs/${ORG_A}/access-points`);
    expect(await screen.findByText(EMPTY_TEXT)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add Access Points' })).toBeInTheDocument();
    expect(screen.getByText('0 of 5')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'contact us' })).toBeNull();
    expect(screen.getByText(/Add an access point to get\s+one/)).toBeInTheDocument();
  });

  it('read-only administrators get no add / reveal / invite actions', async () => {
    mockFetch(routes(OVERVIEW, ['nas:read']));
    renderRoutes(PAGES, `/orgs/${ORG_A}/access-points`);
    await screen.findByText('3 of 5');
    expect(screen.queryByRole('button', { name: 'Add' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Reveal and copy/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Rotate secret' })).toBeNull();
    expect(screen.queryByRole('link', { name: /Invite IT Staff/ })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Network Limits' })).toBeNull();
    // the guides stay readable with nas:read
    expect(screen.getByRole('link', { name: 'Setup guides' })).toBeInTheDocument();
  });

  it('header order: Add · Setup guides · Network Limits · Download MikroTik script', async () => {
    mockFetch(routes(OVERVIEW));
    renderRoutes(PAGES, `/orgs/${ORG_A}/access-points`);
    await screen.findByText('3 of 5');
    const add = screen.getByRole('button', { name: 'Add' });
    const actions = add.parentElement as HTMLElement;
    expect([...actions.children].map((el) => (el.textContent ?? '').trim())).toEqual([
      'Add',
      'Setup guides',
      'Network Limits',
      'Download MikroTik installation script',
    ]);
    fireEvent.click(screen.getByRole('link', { name: 'Setup guides' }));
    expect(await screen.findByText('Gallery page')).toBeInTheDocument();
  });

  it('"?add=<vendor>" (Add this access point from a guide) opens the wizard on that vendor', async () => {
    mockFetch(routes(OVERVIEW));
    renderRoutes(PAGES, `/orgs/${ORG_A}/access-points?add=mikrotik`);
    const dialog = await screen.findByRole('dialog', { name: 'Add Access Point' });
    await waitFor(() =>
      expect(within(dialog).getByRole('button', { name: /MikroTik/ })).toHaveAttribute(
        'aria-pressed',
        'true',
      ),
    );
  });

  it('"?add=" is ignored without nas:create', async () => {
    mockFetch(routes(OVERVIEW, ['nas:read']));
    renderRoutes(PAGES, `/orgs/${ORG_A}/access-points?add=mikrotik`);
    await screen.findByText('3 of 5');
    expect(screen.queryByRole('dialog', { name: 'Add Access Point' })).toBeNull();
  });

  it('MikroTik script button opens the MikroTik setup guide when there is no MikroTik NAS', async () => {
    mockFetch(routes(OVERVIEW));
    renderRoutes(PAGES, `/orgs/${ORG_A}/access-points`);
    await screen.findByText('3 of 5');
    fireEvent.click(screen.getByRole('button', { name: 'Download MikroTik installation script' }));
    expect(await screen.findByText('Guide page')).toBeInTheDocument();
  });

  it('MikroTik script button offers the script and login.html downloads per MikroTik NAS', async () => {
    const withMikrotik: Overview = {
      ...OVERVIEW,
      nas: [...OVERVIEW.nas, nas(NAS2, 'Lobby router', 'mikrotik-hotspot', 'mikrotik')],
    };
    mockFetch(routes(withMikrotik));
    renderRoutes(PAGES, `/orgs/${ORG_A}/access-points`);
    await screen.findByText('3 of 5');
    fireEvent.click(screen.getByRole('button', { name: 'Download MikroTik installation script' }));
    const list = await screen.findByRole('list', { name: 'MikroTik NAS' });
    expect(within(list).getByText('Lobby router')).toBeInTheDocument();
    expect(within(list).getByRole('button', { name: /Script \(\.rsc\)/ })).toBeInTheDocument();
    expect(within(list).getByRole('button', { name: /login\.html/ })).toBeInTheDocument();
    expect(within(list).queryByText('Aruba controller')).toBeNull();
  });

  it('invite: opens the invitation form with the read-only role preselected', async () => {
    const ROLE = '01900000-0000-7000-8000-0000000000c1';
    mockFetch([
      {
        method: 'GET',
        path: '/api/v1/auth/me',
        body: adminMe([
          orgScope(ORG_A, ['administrator:read', 'administrator:invite', 'site:read']),
        ]),
      },
      {
        method: 'GET',
        path: `${base}/roles`,
        body: {
          data: [
            { id: 'r-op', key: 'operator', name: 'Operator / Support' },
            { id: ROLE, key: 'read_only', name: 'Read Only' },
          ],
          next_cursor: null,
        },
      },
      {
        method: 'GET',
        path: /\/(administrators|role-bindings|invitations|sites)$/,
        body: { data: [], next_cursor: null },
      },
    ]);
    renderRoutes(PAGES, `/orgs/${ORG_A}/administrators?invite=1&invite_role=read_only`);
    const dialog = await screen.findByRole('dialog');
    const role = within(dialog).getByLabelText<HTMLSelectElement>(/Role/);
    await waitFor(() => expect(role.value).toBe(ROLE));
    expect(within(dialog).getByLabelText<HTMLSelectElement>(/Scope/).value).toBe('organization');
  });
});

describe('RADIUS secret reveal', () => {
  function renderWithClient(qc: QueryClient) {
    const router = createMemoryRouter(PAGES, {
      initialEntries: [`/orgs/${ORG_A}/access-points`],
    });
    return render(
      <QueryClientProvider client={qc}>
        <AuthProvider>
          <RouterProvider router={router} />
        </AuthProvider>
      </QueryClientProvider>,
    );
  }

  it('asks for an MFA code, reveals + copies, keeps it out of the query cache, hides after 30 s', async () => {
    const calls = mockFetch(
      routes(OVERVIEW, ALL, [
        { method: 'POST', path: `${base}/nas/${NAS1}/secret/reveal`, body: { secret: SECRET } },
      ]),
    );
    const qc = createQueryClient();
    renderWithClient(qc);
    fireEvent.click(await screen.findByRole('button', { name: /Reveal and copy/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Confirm with your MFA code' });
    const submit = within(dialog).getByRole('button', { name: 'Reveal and copy' });
    expect(submit).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText(/MFA code/), { target: { value: '12a3456' } });
    expect(within(dialog).getByLabelText<HTMLInputElement>(/MFA code/).value).toBe('123456');

    vi.useFakeTimers({ shouldAdvanceTime: true });
    fireEvent.click(submit);
    await waitFor(() =>
      expect(screen.getByTestId('radius-secret-value')).toHaveTextContent(SECRET),
    );
    expect(screen.queryByRole('dialog')).toBeNull();
    const post = calls.find((c) => c.method === 'POST');
    expect(post?.body).toEqual({ code: '123456' });
    expect(writeText).toHaveBeenCalledWith(SECRET);
    expect(await screen.findByText(/Copied to the clipboard/)).toBeInTheDocument();

    // never in the TanStack caches
    const cached = JSON.stringify([
      qc
        .getQueryCache()
        .getAll()
        .map((q) => q.state.data),
      qc
        .getMutationCache()
        .getAll()
        .map((m) => m.state.data),
    ]);
    expect(cached).not.toContain(SECRET);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(REVEAL_SECONDS * 1000 + 100);
    });
    expect(screen.getByTestId('radius-secret-value')).not.toHaveTextContent(SECRET);
    expect(screen.getByTestId('radius-secret-value')).toHaveTextContent('••••');
  });

  it('D-046 (ADMIN_MFA_MODE=off): one confirmation click, no code field, empty body, 30 s auto-hide', async () => {
    const calls = mockFetch(
      routes(OVERVIEW, ALL, [
        {
          method: 'GET',
          path: '/api/v1/auth/me',
          body: adminMe([orgScope(ORG_A, ALL)], {
            mfa: { mode: 'off', enrolled: false, required: false, pending: false },
          }),
        },
        { method: 'POST', path: `${base}/nas/${NAS1}/secret/reveal`, body: { secret: SECRET } },
      ]),
    );
    const qc = createQueryClient();
    renderWithClient(qc);
    fireEvent.click(await screen.findByRole('button', { name: /Reveal and copy/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Reveal the RADIUS secret' });
    expect(within(dialog).queryByLabelText(/MFA code/)).toBeNull();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reveal and copy' }));
    await waitFor(() =>
      expect(screen.getByTestId('radius-secret-value')).toHaveTextContent(SECRET),
    );
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({});
    await act(async () => {
      await vi.advanceTimersByTimeAsync(REVEAL_SECONDS * 1000 + 100);
    });
    expect(screen.getByTestId('radius-secret-value')).not.toHaveTextContent(SECRET);
  });

  it('shows the API problem for a wrong code and keeps the secret hidden', async () => {
    mockFetch(
      routes(OVERVIEW, ALL, [
        {
          method: 'POST',
          path: `${base}/nas/${NAS1}/secret/reveal`,
          status: 403,
          body: {
            type: 'urn:ecloud:problem:mfa-code-invalid',
            title: 'Invalid MFA code',
            status: 403,
            detail: 'The MFA code is wrong or was already used. Enter a new code.',
          },
        },
      ]),
    );
    renderRoutes(PAGES, `/orgs/${ORG_A}/access-points`);
    fireEvent.click(await screen.findByRole('button', { name: /Reveal and copy/ }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(/MFA code/), { target: { value: '000000' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reveal and copy' }));
    expect(await within(dialog).findByText('Invalid MFA code')).toBeInTheDocument();
    expect(writeText).not.toHaveBeenCalled();
    expect(screen.getByTestId('radius-secret-value')).toHaveTextContent('••••');
  });

  it('offers a NAS selector when the organization has several NAS', async () => {
    const two: Overview = {
      ...OVERVIEW,
      nas: [...OVERVIEW.nas, nas(NAS2, 'Lobby router', 'mikrotik-hotspot', 'mikrotik')],
    };
    const calls = mockFetch(
      routes(two, ALL, [
        { method: 'POST', path: `${base}/nas/${NAS2}/secret/reveal`, body: { secret: SECRET } },
      ]),
    );
    renderRoutes(PAGES, `/orgs/${ORG_A}/access-points`);
    const select = await screen.findByLabelText<HTMLSelectElement>('NAS');
    expect([...select.options].map((o) => o.textContent)).toEqual([
      'Aruba controller (Lobby site)',
      'Lobby router (Lobby site)',
    ]);
    fireEvent.change(select, { target: { value: NAS2 } });
    fireEvent.click(screen.getByRole('button', { name: /Reveal and copy/ }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(/MFA code/), { target: { value: '654321' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reveal and copy' }));
    await waitFor(() =>
      expect(screen.getByTestId('radius-secret-value')).toHaveTextContent(SECRET),
    );
    expect(calls.some((c) => c.method === 'POST' && c.url.includes(NAS2))).toBe(true);
    // switching NAS hides the value at once
    fireEvent.change(select, { target: { value: NAS1 } });
    expect(screen.getByTestId('radius-secret-value')).not.toHaveTextContent(SECRET);
  });
});

describe('Add Access Point wizard', () => {
  it('NAS fields follow the vendor adapter (MikroTik hotspot, post-back profile, Meraki)', () => {
    const names = (a: string, p: string | null = null) => nasFields(a, null, p).map((f) => f.name);
    expect(names('mikrotik-hotspot')).toEqual([
      'name',
      'site_id',
      'nas_ip',
      'nas_identifier',
      'hotspot_address',
      'hotspot_port',
    ]);
    const postback = nasFields('external-portal-postback', null, 'postback-generic');
    expect(postback.find((f) => f.name === 'adapter_config')?.defaultValue).toBe(
      JSON.stringify({ profile: 'postback-generic' }),
    );
    expect(names('meraki-splash')).toEqual(['name', 'site_id', 'das_host']);
  });

  it('validates AP MAC rows like the API', () => {
    const out = validateMacRows([
      { key: 1, mac: '', name: '' },
      { key: 2, mac: '01:00:5e:00:00:01', name: '' },
      { key: 3, mac: 'AA-BB-CC-DD-EE-F0', name: 'ok' },
      { key: 4, mac: 'aabb.ccdd.eef0', name: 'dup' },
    ]);
    expect(out.map((r) => r.error === undefined)).toEqual([false, false, true, false]);
    expect(out[1]?.error).toMatch(/unicast MAC/);
    expect(out[3]?.error).toMatch(/twice/);
  });

  it('vendor → new NAS (secret once) → AP MACs → inline guide → done', async () => {
    const NEW_NAS = '01900000-0000-7000-8000-0000000000e9';
    const calls = mockFetch(
      routes(EMPTY, ALL, [
        {
          method: 'POST',
          path: `${base}/nas`,
          status: 201,
          body: { id: NEW_NAS, name: 'Lobby router', secret: 'shown-once-secret' }, // check-no-secrets: allow (test fixture)
        },
        {
          method: 'POST',
          path: `${base}/access-points`,
          status: 201,
          body: { id: 'ap-new', mac: '02:aa:bb:cc:dd:ee' },
        },
      ]),
    );
    renderRoutes(PAGES, `/orgs/${ORG_A}/access-points`);
    fireEvent.click(await screen.findByRole('button', { name: 'Add Access Points' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add Access Point' });
    const stepList = within(dialog).getByRole('list', { name: 'Wizard steps' });
    expect(within(stepList).getByText('Vendor').closest('li')).toHaveAttribute(
      'aria-current',
      'step',
    );

    // 1. vendor
    const next = () => within(dialog).getByRole('button', { name: /Next/ });
    expect(next()).toBeDisabled();
    const picker = await within(dialog).findByRole('list', { name: 'Choose a vendor' });
    fireEvent.click(within(picker).getByTestId('vendor-mikrotik'));
    expect(within(picker).getByTestId('vendor-mikrotik')).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(next());

    // 2. NAS: no MikroTik NAS yet → create form with MikroTik fields
    expect(await within(dialog).findByText(/RADIUS client \(NAS\) for MikroTik/)).toBeVisible();
    fireEvent.change(within(dialog).getByLabelText(/^Name/), { target: { value: 'Lobby router' } });
    const site = within(dialog).getByLabelText<HTMLSelectElement>(/^Site/);
    await waitFor(() => expect(site.options.length).toBeGreaterThan(1));
    fireEvent.change(site, { target: { value: SITE } });
    fireEvent.change(within(dialog).getByLabelText(/^NAS IP/), { target: { value: '10.0.0.9' } });
    fireEvent.change(within(dialog).getByLabelText(/^NAS-Identifier/), {
      target: { value: 'lobby-gw' },
    });
    fireEvent.change(within(dialog).getByLabelText(/^Hotspot address/), {
      target: { value: '10.5.50.1' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create NAS' }));
    expect(await within(dialog).findByText('shown-once-secret')).toBeInTheDocument();
    const nasPost = calls.find((c) => c.method === 'POST' && c.url.endsWith('/nas'));
    expect(nasPost?.body).toMatchObject({
      name: 'Lobby router',
      site_id: SITE,
      nas_ip: '10.0.0.9',
      nas_identifier: 'lobby-gw',
      hotspot_address: '10.5.50.1',
      adapter_key: 'mikrotik-hotspot',
      vendor_key: 'mikrotik',
    });
    expect(next()).toBeDisabled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'I have stored it' }));
    fireEvent.click(next());

    // 3. AP MACs: client-side validation, then POST
    const mac = await within(dialog).findByLabelText(/MAC address 1/);
    fireEvent.change(mac, { target: { value: 'ff:ff:ff:ff:ff:ff' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /Save and continue/ }));
    expect(await within(dialog).findByText(/Must be a unicast MAC address/)).toBeInTheDocument();
    fireEvent.change(mac, { target: { value: '02-AA-BB-CC-DD-EE' } });
    fireEvent.change(within(dialog).getByLabelText(/Name 1/), { target: { value: 'Lobby AP' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /Save and continue/ }));

    // 4. inline guide with copy buttons and the MikroTik script download
    expect((await within(dialog).findAllByText('Walled garden')).length).toBeGreaterThan(0);
    const apPost = calls.find((c) => c.method === 'POST' && c.url.endsWith('/access-points'));
    expect(apPost?.body).toEqual({
      nas_client_id: NEW_NAS,
      mac: '02:aa:bb:cc:dd:ee',
      name: 'Lobby AP',
    });
    expect(within(dialog).getAllByRole('button', { name: /^Copy/ }).length).toBeGreaterThan(0);
    expect(
      within(dialog).getByRole('button', { name: /Download MikroTik installation script/ }),
    ).toBeInTheDocument();
    expect(within(dialog).queryByText('shown-once-secret')).toBeNull();
    fireEvent.click(next());

    // 5. done
    expect(
      await within(dialog).findByText(/1 access point added behind Lobby router/),
    ).toBeVisible();
    expect(within(dialog).getByText(/unverified until ECLOUD receives/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('reuses an existing NAS of the vendor adapter', async () => {
    const calls = mockFetch(
      routes(OVERVIEW, ALL, [
        { method: 'POST', path: `${base}/access-points`, status: 201, body: { id: 'ap2' } },
      ]),
    );
    renderRoutes(PAGES, `/orgs/${ORG_A}/access-points`);
    fireEvent.click(await screen.findByRole('button', { name: 'Add' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add Access Point' });
    fireEvent.click(await within(dialog).findByTestId('vendor-aruba'));
    fireEvent.click(within(dialog).getByRole('button', { name: /Next/ }));
    const existing = await within(dialog).findByLabelText<HTMLSelectElement>('Existing NAS');
    expect(existing.value).toBe(NAS1);
    fireEvent.click(within(dialog).getByRole('button', { name: /Next/ }));
    fireEvent.change(await within(dialog).findByLabelText(/MAC address 1/), {
      target: { value: '02aabbccdd02' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: /Save and continue/ }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
        nas_client_id: NAS1,
        mac: '02:aa:bb:cc:dd:02',
      }),
    );
    expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/nas'))).toBe(false);
  });
});
