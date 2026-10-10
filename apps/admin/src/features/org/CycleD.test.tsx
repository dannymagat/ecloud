import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ADAPTER_KEYS, ADAPTER_LABELS } from '../../lib/adapterStatus';
import { adminMe, orgScope, ORG_A } from '../../test/fixtures';
import { mockFetch, renderRoutes } from '../../test/utils';
import { ControllersPage, credentialBody, credentialFields } from './ControllersPage';

const base = `/api/v1/orgs/${ORG_A}`;
const CTRL = '01900000-0000-7000-8000-0000000000d4';

afterEach(() => vi.unstubAllGlobals());

const meta = {
  controller_id: CTRL,
  api_kind: 'unifi-network',
  base_url: 'https://10.0.0.5/proxy/network/integration',
  username: null,
  external_org_id: null,
  external_site_id: 'site-id-1',
  has_secret: true,
  rotated_at: '2026-10-10T00:00:00.000Z',
  updated_at: '2026-10-10T00:00:00.000Z',
  tls_trust: 'fingerprint',
  tls_fingerprint_sha256: 'AB:CD',
  settings: { unifi_site_name: 'default' },
  last_test_at: null,
  last_test_result: null,
  inventory_checked_at: null,
  inventory_result: null,
  inventory_matched: null,
};

function routes(permissions: string[]) {
  return mockFetch([
    { method: 'GET', path: '/api/v1/auth/me', body: adminMe([orgScope(ORG_A, permissions)]) },
    {
      method: 'GET',
      path: `${base}/controllers`,
      body: {
        data: [
          {
            id: CTRL,
            name: 'UniFi',
            vendor_key: 'ubiquiti-unifi',
            kind: 'on_premises',
            base_url: meta.base_url,
            site_id: null,
          },
        ],
        next_cursor: null,
      },
    },
    { method: 'GET', path: `${base}/controllers/${CTRL}/api-credential`, body: meta },
    {
      method: 'POST',
      path: `${base}/controllers/${CTRL}/api-credential/test`,
      body: {
        ok: false,
        code: 'tls_pin_mismatch',
        contacted: true,
        detail: 'controller TLS certificate does not match the pinned fingerprint',
        tested_at: '2026-10-10T01:00:00.000Z',
      },
    },
  ]);
}

describe('Cycle D admin: controller API settings and Test connection', () => {
  it('offers the controller-API NAS adapters with an honest accounting label', () => {
    for (const k of ['unifi-external-portal', 'omada-api', 'mist-guest-portal'] as const) {
      expect(ADAPTER_KEYS).toContain(k);
    }
    expect(ADAPTER_LABELS['unifi-external-portal']).toMatch(/no RADIUS accounting/);
  });

  it('has per-adapter + TLS pin fields and nests adapter settings under `settings`', () => {
    const names = credentialFields.map((f) => f.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'unifi_site_name',
        'omada_controller_id',
        'mist_portal_host',
        'mist_wlan_ids',
        'tls_fingerprint_sha256',
        'tls_ca_pem',
      ]),
    );
    expect(names).not.toContain('insecure');
    expect(
      credentialBody({ api_kind: 'mist', secret: 's', mist_wlan_ids: ['a'], tls_ca_pem: 'x' }),
    ).toEqual({
      api_kind: 'mist',
      secret: 's',
      tls_ca_pem: 'x',
      settings: { mist_wlan_ids: ['a'] },
    });
  });

  it('Test connection posts to the test endpoint and shows the outcome code', async () => {
    const calls = routes(['controller:read', 'controller:update', 'controller:secret:rotate']);
    renderRoutes(
      [{ path: '/orgs/:orgId/controllers', element: <ControllersPage /> }],
      `/orgs/${ORG_A}/controllers`,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'API credential' }));
    expect(await screen.findByText(/TLS: fingerprint/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));
    expect(await screen.findByText('tls_pin_mismatch')).toBeInTheDocument();
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/api-credential/test'))).toBe(
        true,
      ),
    );
  });

  it('hides Test connection without controller:update', async () => {
    routes(['controller:read', 'controller:secret:rotate']);
    renderRoutes(
      [{ path: '/orgs/:orgId/controllers', element: <ControllersPage /> }],
      `/orgs/${ORG_A}/controllers`,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'API credential' }));
    expect(await screen.findByText(/TLS: fingerprint/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Test connection' })).toBeNull();
  });
});
