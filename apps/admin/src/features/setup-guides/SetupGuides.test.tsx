import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { adminMe, orgScope, ORG_A } from '../../test/fixtures';
import { mockFetch, renderRoutes, type MockRoute } from '../../test/utils';
import { NasPage, nasCreatePreset } from '../org/NasPage';
import { SetupGuidesPage } from './SetupGuidesPage';
import type { Catalogue, CatalogueEntry, VendorGuide } from './types';
import { addNasHref } from './types';
import { VendorGuidePage } from './VendorGuidePage';

const base = `/api/v1/orgs/${ORG_A}`;
// RFC 5737 / example values: test fixtures, not deployment facts.
const PORTAL = 'https://portal.example.test:8444';
const RADIUS = '192.0.2.53';

const entry = (
  vendor_key: string,
  display_name: string,
  family: CatalogueEntry['family'],
  family_label: string,
  status: CatalogueEntry['status'] = 'documented',
  extra: Partial<CatalogueEntry> = {},
): CatalogueEntry => ({
  vendor_key,
  display_name,
  product_line: `${display_name} product line`,
  adapter_key: 'external-portal-postback',
  profile: null,
  family,
  family_label,
  status,
  status_label:
    status === 'documented'
      ? 'Documented, not yet device-tested'
      : status === 'generic_profile'
        ? 'Via generic profile: needs a captured redirect'
        : 'Tested on device',
  lifecycle: 'implemented',
  ...extra,
});

const CATALOGUE: Catalogue = {
  data: [
    entry('cambium', 'Cambium Networks', 'external-portal', 'External portal', 'documented', {
      profile: 'cambium-hotspot',
    }),
    entry('mikrotik', 'MikroTik', 'router-hotspot', 'Router hotspot', 'documented', {
      adapter_key: 'mikrotik-hotspot',
    }),
    entry('ubiquiti-unifi', 'Ubiquiti UniFi', 'controller-api', 'Controller API', 'documented', {
      adapter_key: 'unifi-external-portal',
    }),
    entry('zyxel', 'Zyxel', 'external-portal', 'External portal', 'generic_profile', {
      profile: 'postback-generic',
    }),
  ],
  families: [
    { key: 'external-portal', label: 'External portal' },
    { key: 'router-hotspot', label: 'Router hotspot' },
    { key: 'controller-api', label: 'Controller API' },
  ],
};

const CAMBIUM: VendorGuide = {
  ...CATALOGUE.data[0]!,
  site: null,
  portal_url: `${PORTAL}/pb/cambium-hotspot/<NAS_IDENTIFIER>/`,
  walled_garden: ['portal.example.test:8444'],
  radius: { address: RADIUS, auth_port: 1812, acct_port: 1813, coa_port: 3799 },
  preflight: ['cnPilot E-series AP or cnMaestro with Guest Access (External Hotspot).'],
  vendor_notes: [],
  steps: [
    {
      id: 'cambium-portal-mode',
      title: 'Guest Access: send guests to an external hotspot',
      setting: 'Guest Access > Portal Mode',
      value: 'External Hotspot',
      evidence: ['C1'],
      secret: false,
    },
    {
      id: 'radius-auth',
      title: 'RADIUS authentication server (PAP)',
      setting: 'RADIUS auth server {address, port, shared secret}',
      value: `${RADIUS}, 1812, <RADIUS_SECRET>`,
      evidence: ['C1'],
      secret: true,
    },
  ],
  warnings: [
    { code: 'not_device_tested', message: 'Built from vendor documentation only.' },
    { code: 'http_postback_cleartext', message: 'Credential posted over http:// in clear text.' },
    { code: 'lab_mode_attributes', message: 'Lab mode: leave device-test attributes off.' },
  ],
  secret_note: 'Secrets are never shown in a guide.',
  add_nas: { adapter_key: 'external-portal-postback', profile: 'cambium-hotspot' },
  meraki: null,
};

const ME = adminMe([orgScope(ORG_A, ['nas:read', 'nas:create', 'site:read'])]);

function routes(extra: MockRoute[] = []): MockRoute[] {
  return [
    { method: 'GET', path: '/api/v1/auth/me', body: ME },
    { method: 'GET', path: `${base}/setup-guides`, body: CATALOGUE },
    { method: 'GET', path: `${base}/setup-guides/cambium`, body: CAMBIUM },
    ...extra,
  ];
}

const PAGES = [
  { path: '/orgs/:orgId/setup-guides', element: <SetupGuidesPage /> },
  { path: '/orgs/:orgId/setup-guides/:vendorKey', element: <VendorGuidePage /> },
  { path: '/orgs/:orgId/nas', element: <NasPage /> },
];

afterEach(() => vi.unstubAllGlobals());

describe('Cycle F admin: setup-guide gallery', () => {
  it('renders a tile grid with self-hosted logos, family badges and status pills', async () => {
    mockFetch(routes());
    const view = renderRoutes(PAGES, `/orgs/${ORG_A}/setup-guides`);
    const grid = await screen.findByRole('list', { name: 'Vendors' });
    const tiles = within(grid).getAllByRole('link');
    expect(tiles).toHaveLength(4);
    expect(within(grid).getByText('Cambium Networks')).toBeInTheDocument();
    expect(within(grid).getAllByText('Documented, not yet device-tested')).toHaveLength(3);
    expect(
      within(grid).getByText('Via generic profile: needs a captured redirect'),
    ).toBeInTheDocument();
    expect(within(grid).queryByText('Tested on device')).toBeNull();
    // D-045: official logos, self-hosted only (a wordmark tile where no logo exists)
    const imgs = [...view.container.querySelectorAll('img')];
    expect(imgs.length).toBeGreaterThan(0);
    for (const img of imgs)
      expect(img.getAttribute('src')).toMatch(/^\/vendor-logos\/[a-z0-9-]+\.svg$/);
    expect(screen.getByText(/Logos are trademarks of their respective owners/)).toBeInTheDocument();
    expect(tiles[0]).toHaveAttribute('href', `/orgs/${ORG_A}/setup-guides/cambium`);
  });

  it('filters by integration family and by search text', async () => {
    mockFetch(routes());
    renderRoutes(PAGES, `/orgs/${ORG_A}/setup-guides`);
    const grid = await screen.findByRole('list', { name: 'Vendors' });
    const group = screen.getByRole('group', { name: 'Filter by integration family' });
    fireEvent.click(within(group).getByRole('button', { name: 'Controller API' }));
    expect(within(group).getByRole('button', { name: 'Controller API' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(within(grid).getAllByRole('link')).toHaveLength(1);
    expect(within(grid).getByText('Ubiquiti UniFi')).toBeInTheDocument();
    fireEvent.click(within(group).getByRole('button', { name: 'All' }));
    fireEvent.change(screen.getByLabelText('Search vendors'), { target: { value: 'mikro' } });
    const filtered = screen.getByRole('list', { name: 'Vendors' });
    expect(within(filtered).getAllByRole('link')).toHaveLength(1);
    expect(screen.getByRole('status')).toHaveTextContent('1 of 4 vendors');
    fireEvent.change(screen.getByLabelText('Search vendors'), { target: { value: 'nothing' } });
    expect(screen.getByText('No vendor matches')).toBeInTheDocument();
  });

  it('a tile opens the guide: numbered steps, warnings, ECLOUD values; secrets never shown', async () => {
    mockFetch(routes());
    renderRoutes(PAGES, `/orgs/${ORG_A}/setup-guides`);
    fireEvent.click(await screen.findByRole('link', { name: /^Cambium Networks/ }));
    expect(await screen.findByRole('heading', { name: 'Cambium Networks' })).toBeInTheDocument();
    const steps = screen.getByRole('list', { name: 'Setup steps' });
    expect(within(steps).getAllByRole('listitem')).toHaveLength(2);
    expect(within(steps).getByText('External Hotspot')).toBeInTheDocument();
    const warnings = screen.getByRole('list', { name: 'Warnings' });
    expect(within(warnings).getByText(/clear text/)).toBeInTheDocument();
    expect(within(warnings).getByText(/Lab mode/)).toBeInTheDocument();
    // the secret step has no copy button and points to the NAS secret shown once
    const secretStep = screen.getByTestId('step-radius-auth');
    expect(within(secretStep).queryByRole('button', { name: /Copy/ })).toBeNull();
    expect(within(secretStep).getByText(/shown once when you add the NAS/)).toBeInTheDocument();
    expect(screen.getByText(/your NAS secret is shown once/)).toBeInTheDocument();
    expect(screen.getByText(RADIUS)).toBeInTheDocument();
  });

  it('copy buttons copy the filled values', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    mockFetch(routes());
    renderRoutes(PAGES, `/orgs/${ORG_A}/setup-guides/cambium`);
    fireEvent.click(await screen.findByRole('button', { name: 'Copy Portal URL' }));
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(`${PORTAL}/pb/cambium-hotspot/<NAS_IDENTIFIER>/`),
    );
    expect(await screen.findByText('Portal URL copied to the clipboard.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Copy RADIUS server' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(RADIUS));
    fireEvent.click(screen.getByRole('button', { name: 'Copy Accounting port' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('1813'));
    fireEvent.click(screen.getByRole('button', { name: 'Copy Walled garden' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('portal.example.test:8444'));
    fireEvent.click(screen.getByRole('button', { name: 'Copy value of step 1' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('External Hotspot'));
    // never a secret
    for (const call of writeText.mock.calls as unknown as string[][]) {
      expect(call[0]).not.toContain('<RADIUS_SECRET>');
    }
  });

  it('"Add this access point" opens the NAS form with adapter and profile preselected', async () => {
    mockFetch(
      routes([
        { method: 'GET', path: `${base}/nas`, body: { data: [], next_cursor: null } },
        {
          method: 'GET',
          path: `${base}/meraki/cloud-radius`,
          status: 404,
          body: { type: 'about:blank', title: 'Not Found', status: 404 },
        },
        { method: 'GET', path: `${base}/sites`, body: { data: [], next_cursor: null } },
        { method: 'GET', path: `${base}/network-devices`, body: { data: [], next_cursor: null } },
      ]),
    );
    renderRoutes(PAGES, `/orgs/${ORG_A}/setup-guides/cambium`);
    fireEvent.click(await screen.findByRole('button', { name: 'Add this access point' }));
    const dialog = await screen.findByRole('dialog', { name: 'New nas client' });
    expect(within(dialog).getByLabelText(/^Adapter/)).toHaveValue('external-portal-postback');
    expect(within(dialog).getByLabelText(/Vendor profile/)).toHaveValue('cambium-hotspot');
    // the NAS page links back to the gallery
    expect(
      screen.getByRole('link', { name: 'How to configure your access points' }),
    ).toHaveAttribute('href', `/orgs/${ORG_A}/setup-guides`);
  });

  it('the "Any vendor" profile shows the portal URL from configuration, not a constant', async () => {
    mockFetch(
      routes([
        { method: 'GET', path: `${base}/nas`, body: { data: [], next_cursor: null } },
        {
          method: 'GET',
          path: `${base}/meraki/cloud-radius`,
          status: 404,
          body: { type: 'about:blank', title: 'Not Found', status: 404 },
        },
        { method: 'GET', path: `${base}/sites`, body: { data: [], next_cursor: null } },
        { method: 'GET', path: `${base}/network-devices`, body: { data: [], next_cursor: null } },
        {
          method: 'GET',
          path: `${base}/setup-guides/generic-portal`,
          body: {
            ...CAMBIUM,
            vendor_key: 'generic-portal',
            profile: 'postback-generic',
            portal_url: `${PORTAL}/pb/postback-generic/<NAS_IDENTIFIER>/`,
          },
        },
      ]),
    );
    const view = renderRoutes(
      PAGES,
      `/orgs/${ORG_A}/nas?new=1&adapter_key=external-portal-postback&profile=postback-generic`,
    );
    const dialog = await screen.findByRole('dialog', { name: 'New nas client' });
    expect(
      await within(dialog).findByText(`${PORTAL}/pb/postback-generic/<NAS_IDENTIFIER>/`),
    ).toBeInTheDocument();
    expect(view.container.ownerDocument.body.textContent).not.toContain(
      'portal.ezecloud.ezelink.ai',
    );
  });

  it('without nas:create the guide has no "Add this access point" button', async () => {
    mockFetch([
      {
        method: 'GET',
        path: '/api/v1/auth/me',
        body: adminMe([orgScope(ORG_A, ['nas:read'])]),
      },
      { method: 'GET', path: `${base}/setup-guides/cambium`, body: CAMBIUM },
    ]);
    renderRoutes(PAGES, `/orgs/${ORG_A}/setup-guides/cambium`);
    expect(await screen.findByRole('heading', { name: 'Cambium Networks' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add this access point' })).toBeNull();
  });

  it('without nas:read the gallery is not shown', async () => {
    mockFetch([
      { method: 'GET', path: '/api/v1/auth/me', body: adminMe([orgScope(ORG_A, ['user:read'])]) },
    ]);
    renderRoutes(PAGES, `/orgs/${ORG_A}/setup-guides`);
    expect(await screen.findByText(/nas:read/)).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Vendors' })).toBeNull();
  });

  it('preset parsing ignores unknown adapters and profiles', () => {
    expect(
      nasCreatePreset(
        new URLSearchParams(
          'new=1&adapter_key=external-portal-postback&profile=cambium-hotspot&site_id=01900000-0000-7000-8000-0000000000c1',
        ),
      ),
    ).toEqual({
      open: true,
      adapterKey: 'external-portal-postback',
      adapterConfig: '{"profile":"cambium-hotspot"}',
      siteId: '01900000-0000-7000-8000-0000000000c1',
    });
    expect(nasCreatePreset(new URLSearchParams('new=1&adapter_key=evil&profile=x'))).toEqual({
      open: true,
      adapterKey: null,
      adapterConfig: null,
      siteId: null,
    });
    // a valid adapter with a crafted profile: nothing is injected into adapter_config
    expect(
      nasCreatePreset(
        new URLSearchParams({
          new: '1',
          adapter_key: 'external-portal-postback',
          profile: 'cambium-hotspot","strict_login_hosts":false',
          site_id: '../x',
        }),
      ),
    ).toEqual({
      open: true,
      adapterKey: 'external-portal-postback',
      adapterConfig: null,
      siteId: null,
    });
    // a profile is only applied with the post-back adapter
    expect(
      nasCreatePreset(new URLSearchParams('adapter_key=mikrotik-hotspot&profile=cambium-hotspot'))
        .adapterConfig,
    ).toBeNull();
    expect(addNasHref(ORG_A, { adapter_key: 'mikrotik-hotspot', profile: null }, null)).toBe(
      `/orgs/${ORG_A}/nas?new=1&adapter_key=mikrotik-hotspot`,
    );
  });
});
