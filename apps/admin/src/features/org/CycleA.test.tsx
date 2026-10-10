import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ADAPTER_KEYS, ADAPTER_LABELS } from '../../lib/adapterStatus';
import { ORG_GROUPS } from '../../lib/nav';
import { adminMe, orgScope, ORG_A } from '../../test/fixtures';
import { mockFetch, renderRoutes } from '../../test/utils';
import { API_KINDS, ControllersPage, credentialFields } from './ControllersPage';

const base = `/api/v1/orgs/${ORG_A}`;
const CTRL = '01900000-0000-7000-8000-0000000000d1';

afterEach(() => vi.unstubAllGlobals());

describe('Cycle A admin screens', () => {
  it('the NAS adapter dropdown offers the generic 802.1X / MAC-auth adapter', () => {
    expect(ADAPTER_KEYS).toContain('generic-radius-8021x');
    expect(ADAPTER_LABELS['generic-radius-8021x']).toMatch(/802\.1X/);
  });

  it('navigation lists access points and controllers under Network', () => {
    const network = ORG_GROUPS.find((g) => g.key === 'network');
    expect(network?.items.map((i) => i.path)).toEqual(
      expect.arrayContaining(['access-points', 'controllers']),
    );
  });

  it('the API credential secret is a write-only password field; every API kind is offered', () => {
    const secret = credentialFields.find((f) => f.name === 'secret');
    expect(secret).toMatchObject({ type: 'password', required: true });
    expect(API_KINDS.map((k) => k.value)).toEqual([
      'unifi-network',
      'omada-controller',
      'mist',
      'ruckus-nbi',
      'ruckus-one',
      'meraki-dashboard',
    ]);
  });

  // The access point screen moved to features/access-points (D-045 Access Points page) and is
  // covered by AccessPointsPage.test.tsx.

  it('controller API credential: shows metadata only and posts a set/rotate with a key', async () => {
    const calls = mockFetch([
      {
        method: 'GET',
        path: '/api/v1/auth/me',
        body: adminMe([orgScope(ORG_A, ['controller:read', 'controller:secret:rotate'])]),
      },
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
              base_url: 'https://10.0.0.5/',
              site_id: null,
            },
          ],
          next_cursor: null,
        },
      },
      {
        method: 'GET',
        path: `${base}/controllers/${CTRL}/api-credential`,
        body: {
          controller_id: CTRL,
          api_kind: 'unifi-network',
          base_url: 'https://10.0.0.5/',
          username: null,
          external_org_id: null,
          external_site_id: 'default',
          has_secret: true,
          rotated_at: '2026-10-10T00:00:00.000Z',
          updated_at: '2026-10-10T00:00:00.000Z',
        },
      },
      {
        method: 'POST',
        path: `${base}/controllers/${CTRL}/api-credential`,
        body: {
          controller_id: CTRL,
          api_kind: 'unifi-network',
          base_url: 'https://10.0.0.5/',
          username: null,
          external_org_id: null,
          external_site_id: 'default',
          has_secret: true,
          rotated_at: '2026-10-10T01:00:00.000Z',
          updated_at: '2026-10-10T01:00:00.000Z',
        },
      },
    ]);
    renderRoutes(
      [{ path: '/orgs/:orgId/controllers', element: <ControllersPage /> }],
      `/orgs/${ORG_A}/controllers`,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'API credential' }));
    expect(await screen.findByText('stored')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/Secret/), { target: { value: 'test-api-key' } });
    fireEvent.click(screen.getByRole('button', { name: 'Rotate credential' }));
    await waitFor(() =>
      expect(
        calls.some(
          (c) => c.method === 'POST' && c.url.endsWith(`/controllers/${CTRL}/api-credential`),
        ),
      ).toBe(true),
    );
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.body).toMatchObject({
      api_kind: 'unifi-network',
      secret: 'test-api-key',
      external_site_id: 'default',
    });
    const headers = Object.fromEntries(
      Object.entries(post.headers).map(([k, v]) => [k.toLowerCase(), v]),
    );
    expect(headers['idempotency-key']).toBeTruthy();
  });
});
