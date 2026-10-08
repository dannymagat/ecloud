import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { adminMe, orgScope, ORG_A } from '../../test/fixtures';
import { mockFetch, renderRoutes, type MockRoute } from '../../test/utils';
import { PortalDesignerPage } from './PortalDesignerPage';

const PORTAL_ID = '01900000-0000-7000-8000-000000000001';
const THEME_ID = '01900000-0000-7000-8000-0000000000e1';
const ASSET_ID = '01900000-0000-7000-8000-0000000000a1';
const base = `/api/v1/orgs/${ORG_A}`;

const routes = [{ path: '/orgs/:orgId/portals/:portalId', element: <PortalDesignerPage /> }];

const FULL = [
  'captive_portal:read',
  'captive_portal:update',
  'portal_theme:read',
  'portal_theme:create',
  'portal_theme:update',
  'portal_asset:read',
  'portal_asset:create',
  'captive_portal:secret:rotate',
];
const READ_ONLY = ['captive_portal:read', 'portal_theme:read', 'portal_asset:read'];

function api(permissions: string[]): MockRoute[] {
  return [
    { method: 'GET', path: '/api/v1/auth/me', body: adminMe([orgScope(ORG_A, permissions)]) },
    {
      method: 'GET',
      path: `${base}/captive-portals/${PORTAL_ID}`,
      body: {
        id: PORTAL_ID,
        site_id: 'site-1',
        name: 'Lobby',
        public_slug: 'lobby',
        portal_type: 'uspot',
        theme_id: THEME_ID,
        auth_methods: ['password'],
        social_login: 'not_configured',
      },
    },
    {
      method: 'GET',
      path: `${base}/portal-themes`,
      body: {
        data: [
          {
            id: THEME_ID,
            name: 'Brand',
            colors: { brand: '#0b6bcb' },
            strings: { en: { welcome_title: 'Hello' } },
            logo_asset_id: null,
            version: 3,
          },
        ],
        next_cursor: null,
      },
    },
    {
      method: 'GET',
      path: `${base}/captive-portals/${PORTAL_ID}/terms`,
      body: {
        current_version: '1',
        data: [{ id: 't', version: 1, locale: 'en', body: 'Be nice.', created_at: '' }],
      },
    },
    {
      method: 'POST',
      path: `${base}/portal-previews`,
      status: 201,
      body: { preview_url: `${base}/portal-previews/${'x'.repeat(32)}`, expires_in: 300 },
    },
    { method: 'PATCH', path: `${base}/captive-portals/${PORTAL_ID}`, body: { id: PORTAL_ID } },
    {
      method: 'POST',
      path: `${base}/portal-assets`,
      status: 201,
      body: { id: ASSET_ID, content_type: 'image/png', byte_size: 8 },
    },
    { method: 'PATCH', path: `${base}/portal-themes/${THEME_ID}`, body: { id: THEME_ID } },
    {
      method: 'POST',
      path: `${base}/captive-portals/${PORTAL_ID}/rotate-uam-secret`,
      body: {
        id: PORTAL_ID,
        uam_secret: 'example-uam-secret',
        uam_secret_configured: true,
      },
    },
  ];
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('PortalDesignerPage', () => {
  it('assigns login methods, uploads a logo and renders the preview in a sandboxed frame', async () => {
    const calls = mockFetch(api(FULL));
    const user = userEvent.setup();
    renderRoutes(routes, `/orgs/${ORG_A}/portals/${PORTAL_ID}`);

    expect(await screen.findByText(/Portal designer: Lobby/)).toBeInTheDocument();
    const frame = await screen.findByTitle('Portal page preview');
    expect(frame).toHaveAttribute('sandbox', '');
    expect(frame.getAttribute('src')).toMatch(/\/portal-previews\/x{32}$/);
    const firstPreview = calls.find((c) => c.url === `${base}/portal-previews`);
    expect(firstPreview?.body).toMatchObject({
      page: 'landing',
      locale: 'en',
      captive_portal_id: PORTAL_ID,
      theme_id: THEME_ID,
    });

    // social login is shown, but never configurable
    expect(screen.getByText('not configured')).toBeInTheDocument();
    expect(screen.getByLabelText('Social login')).toBeDisabled();

    await user.click(screen.getByLabelText('Voucher'));
    await user.click(screen.getByRole('button', { name: 'Save portal' }));
    await waitFor(() =>
      expect(
        calls.find((c) => c.method === 'PATCH' && c.url.includes('captive-portals'))?.body,
      ).toEqual({
        theme_id: THEME_ID,
        auth_methods: ['password', 'voucher'],
      }),
    );

    const png = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'logo.png', {
      type: 'image/png',
    });
    await user.upload(screen.getByLabelText('Upload logo'), png);
    await waitFor(() =>
      expect(calls.some((c) => c.url.startsWith(`${base}/portal-assets`))).toBe(true),
    );
    const uploadCall = calls.find((c) => c.url.startsWith(`${base}/portal-assets`));
    expect(uploadCall?.url).toBe(`${base}/portal-assets?filename=logo.png`);
    expect(uploadCall?.headers['Content-Type']).toBe('image/png');
    expect(uploadCall?.headers['X-Requested-With']).toBe('XMLHttpRequest');
    expect(await screen.findByAltText('Current logo')).toHaveAttribute(
      'src',
      `${base}/portal-assets/${ASSET_ID}/content`,
    );

    await user.click(screen.getByRole('button', { name: 'Save theme' }));
    await waitFor(() =>
      expect(
        calls.find((c) => c.method === 'PATCH' && c.url.includes('portal-themes'))?.body,
      ).toMatchObject({
        name: 'Brand',
        logo_asset_id: ASSET_ID,
      }),
    );
  });

  it('pins a NAS of the site and sets the UAM server URL', async () => {
    const NAS_ID = '01900000-0000-7000-8000-0000000000b1';
    const calls = mockFetch([
      {
        method: 'GET',
        path: `${base}/nas`,
        body: { data: [{ id: NAS_ID, name: 'AP 1', nas_ip: '10.0.0.2' }], next_cursor: null },
      },
      ...api([...FULL, 'nas:read']),
    ]);
    const user = userEvent.setup();
    renderRoutes(routes, `/orgs/${ORG_A}/portals/${PORTAL_ID}`);
    const pin = await screen.findByLabelText('NAS (pin)');
    await screen.findByRole('option', { name: 'AP 1 (10.0.0.2)' });
    await user.selectOptions(pin, NAS_ID);
    await user.type(
      screen.getByLabelText('UAM server URL'),
      'https://portal.example.test/uam/uspot/',
    );
    await user.click(screen.getByRole('button', { name: 'Save portal' }));
    await waitFor(() =>
      expect(
        calls.find((c) => c.method === 'PATCH' && c.url.includes('captive-portals'))?.body,
      ).toMatchObject({
        nas_client_id: NAS_ID,
        uam_server_url: 'https://portal.example.test/uam/uspot/',
      }),
    );
    expect(calls.find((c) => c.url.startsWith(`${base}/nas`))?.url).toContain('site_id=site-1');
  });

  it('generates the UAM secret and shows it once', async () => {
    const calls = mockFetch(api(FULL));
    const user = userEvent.setup();
    renderRoutes(routes, `/orgs/${ORG_A}/portals/${PORTAL_ID}`);
    expect(await screen.findByText('not set')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Generate UAM secret' }));
    await user.click(await screen.findByRole('button', { name: 'Generate secret' }));
    expect(await screen.findByText(/example-uam-secret/)).toBeInTheDocument();
    const call = calls.find((c) => c.url.endsWith('/rotate-uam-secret'));
    expect(call?.method).toBe('POST');
    expect(call?.headers['Idempotency-Key']).toMatch(/[0-9a-f-]{36}/);
  });

  it('warns about low contrast and blocks saving the theme', async () => {
    mockFetch(api(FULL));
    const user = userEvent.setup();
    renderRoutes(routes, `/orgs/${ORG_A}/portals/${PORTAL_ID}`);
    const text = await screen.findByLabelText('Text');
    await user.clear(text);
    await user.type(text, '#dddddd');
    const warning = await screen.findByRole('note');
    expect(within(warning).getByText(/Contrast below WCAG AA/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save theme' })).toBeDisabled();
  });

  it('is read-only for principals without update permissions (e.g. operators)', async () => {
    mockFetch(api(READ_ONLY));
    renderRoutes(routes, `/orgs/${ORG_A}/portals/${PORTAL_ID}`);
    expect(await screen.findByText(/Portal designer: Lobby/)).toBeInTheDocument();
    expect(await screen.findByTitle('Portal page preview')).toBeInTheDocument();
    expect(screen.getByLabelText('Voucher')).toBeDisabled();
    expect(screen.getByLabelText(/Theme name/)).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save portal' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save theme' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Upload logo')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Publish new version' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /UAM secret/ })).not.toBeInTheDocument();
  });
});
