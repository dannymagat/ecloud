import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { adminMe, orgScope, ORG_A } from '../../test/fixtures';
import { mockFetch, renderRoutes, type MockRoute } from '../../test/utils';
import { RateLimitExportPage, fragmentDownloadUrl, ssidError } from './RateLimitExportPage';

const SITE = '01900000-0000-7000-8000-0000000005e1';
const base = `/api/v1/orgs/${ORG_A}`;
const exportPath = `${base}/sites/${SITE}/openwifi-config/rate-limit-fragment`;
const routes = [{ path: '/orgs/:orgId/ssid-rate-limit-export', element: <RateLimitExportPage /> }];

const FRAGMENT = {
  interfaces: [
    { ssids: [{ name: 'lab-uam', 'rate-limit': { 'egress-rate': 20, 'ingress-rate': 5 } }] },
  ],
};

const AVAILABLE = {
  available: true,
  mode: 'export_preview_only',
  pushed: false,
  site_id: SITE,
  ssid: 'lab-uam',
  reason: null,
  resolution: {
    decision: 'accept',
    reason_code: null,
    policy_id: 'pol-1',
    policy_version: 2,
    snapshot_hash: 'h',
  },
  fragment: FRAGMENT,
  changes: [
    {
      path: 'interfaces[].ssids[lab-uam].rate-limit.egress-rate',
      value: 20,
      field: 'download_rate_kbps',
      status: 'VERIFIED_SUPPORTED',
      evidence_level: 'VERIFIED_FROM_SOURCE',
      device_enforced: false,
      evidence: 'NETWORK_INTEGRATION.md §2',
    },
  ],
  omitted: [
    {
      field: 'idle_timeout_s',
      path: 'interfaces[].ssids[lab-uam].max-inactivity',
      reason: 'not a rate limit: outside the rate-limit export (P7-B scope)',
    },
  ],
  validation: {
    valid: true,
    schema_id: 'https://openwrt.org/ucentral.schema.json',
    schema_sha256: 'e1f1',
    errors: [],
  },
  device_enforced: false,
  warnings: ['Export/preview only: ECLOUD did not push this fragment to any controller.'],
  adapter: 'openwifi-config',
  adapter_version: '0.1.0',
};

function api(withEndpoint: boolean, body: unknown = AVAILABLE): MockRoute[] {
  return [
    {
      method: 'GET',
      path: '/api/v1/auth/me',
      body: adminMe([orgScope(ORG_A, ['policy:preview', 'site:read'])]),
    },
    {
      method: 'GET',
      path: '/api/v1/openapi.json',
      body: {
        paths: withEndpoint
          ? {
              '/api/v1/orgs/{orgId}/sites/{siteId}/openwifi-config/rate-limit-fragment': {
                get: {},
              },
            }
          : {},
      },
    },
    {
      method: 'GET',
      path: `${base}/sites`,
      body: { data: [{ id: SITE, name: 'Lab site' }], next_cursor: null },
    },
    { method: 'GET', path: exportPath, body },
  ];
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('RateLimitExportPage', () => {
  it('previews the schema-valid fragment, labels it export-only and offers the API download', async () => {
    const calls = mockFetch(api(true));
    const user = userEvent.setup();
    renderRoutes(routes, `/orgs/${ORG_A}/ssid-rate-limit-export`);

    await screen.findByRole('option', { name: 'Lab site' });
    await user.selectOptions(screen.getByLabelText('Site'), SITE);
    await user.type(screen.getByLabelText('SSID name'), 'lab-uam');
    await user.click(screen.getByRole('button', { name: 'Preview fragment' }));

    const json = await screen.findByTestId('fragment-json');
    expect(JSON.parse(json.textContent ?? '')).toEqual(FRAGMENT);
    expect(calls.find((c) => c.url.startsWith(exportPath))?.url).toBe(`${exportPath}?ssid=lab-uam`);
    expect(screen.getByText('Export / preview only — not pushed')).toBeInTheDocument();
    expect(screen.getByText('uCentral schema valid')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Download fragment' })).toHaveAttribute(
      'href',
      `${exportPath}?ssid=lab-uam&download=1`,
    );
    const table = screen.getByRole('table', { name: 'Fragment values' });
    const row = within(table).getAllByRole('row')[1]!;
    // source-verified only → not device-enforced, amber flagged
    expect(row).toHaveTextContent('No');
    expect(row.querySelector('[data-amber-flag]')).not.toBeNull();
    expect(document.querySelector('[data-device-enforced="true"]')).toBeNull();
    expect(screen.getByText(/did not push this fragment/)).toBeInTheDocument();
    expect(screen.getByText(/outside the rate-limit export/)).toBeInTheDocument();
  });

  it('shows the reason when no fragment is available', async () => {
    mockFetch(
      api(true, {
        ...AVAILABLE,
        available: false,
        fragment: null,
        changes: [],
        validation: null,
        warnings: [],
        reason: 'resolution rejected (no_policy): no fragment for a rejected policy',
      }),
    );
    const user = userEvent.setup();
    renderRoutes(routes, `/orgs/${ORG_A}/ssid-rate-limit-export`);
    await screen.findByRole('option', { name: 'Lab site' });
    await user.selectOptions(screen.getByLabelText('Site'), SITE);
    await user.type(screen.getByLabelText('SSID name'), 'lab-uam');
    await user.click(screen.getByRole('button', { name: 'Preview fragment' }));
    expect(await screen.findByText('No rate-limit fragment for this site')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Download fragment' })).toBeNull();
  });

  it('is explicit against an API without the export endpoint', async () => {
    mockFetch(api(false));
    renderRoutes(routes, `/orgs/${ORG_A}/ssid-rate-limit-export`);
    expect(await screen.findByText('Not available in this API version')).toBeInTheDocument();
  });

  it('helpers: SSID length rule and download URL', () => {
    expect(ssidError('x'.repeat(32))).toBeUndefined();
    expect(ssidError('x'.repeat(33))).toMatch(/at most 32/);
    expect(fragmentDownloadUrl(ORG_A, SITE, 'a b')).toBe(`${exportPath}?ssid=a+b&download=1`);
  });
});
