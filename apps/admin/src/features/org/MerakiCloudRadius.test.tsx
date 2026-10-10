import { fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ADAPTER_KEYS, ADAPTER_LABELS } from '../../lib/adapterStatus';
import { adminMe, orgScope, ORG_A } from '../../test/fixtures';
import { mockFetch, renderRoutes } from '../../test/utils';
import { merakiStatusTitle, type MerakiCloudRadiusStatus } from './MerakiCloudRadius';
import { NasPage } from './NasPage';

const base = `/api/v1/orgs/${ORG_A}`;
const NAS_ID = '01900000-0000-7000-8000-0000000000e9';

const OFF: MerakiCloudRadiusStatus = {
  enabled: false,
  state: 'disabled',
  message:
    'OFF (platform setting MERAKI_CLOUD_RADIUS_ENABLED=false). RADIUS from the Meraki Cloud cannot reach ECLOUD.',
  source_cidrs: [],
  port_range: null,
  das_port: 3799,
  radius_reachable_from_meraki: 'no',
};

afterEach(() => vi.unstubAllGlobals());

describe('Cycle E admin: Meraki cloud RADIUS', () => {
  it('offers the meraki-splash adapter', () => {
    expect(ADAPTER_KEYS).toContain('meraki-splash');
    expect(ADAPTER_LABELS['meraki-splash']).toMatch(/Meraki/);
  });

  it('never claims reachability: titles per state', () => {
    expect(merakiStatusTitle(OFF)).toMatch(/OFF/);
    expect(merakiStatusTitle({ ...OFF, enabled: true, state: 'enabled' })).toMatch(/not verified/);
    expect(
      merakiStatusTitle({ ...OFF, enabled: true, state: 'enabled_missing_source_cidrs' }),
    ).toMatch(/incomplete/);
  });

  it('NAS page shows the OFF state and a setup guide for Meraki NAS (no secret)', async () => {
    mockFetch([
      { method: 'GET', path: '/api/v1/auth/me', body: adminMe([orgScope(ORG_A, ['nas:read'])]) },
      { method: 'GET', path: `${base}/meraki/cloud-radius`, body: OFF },
      {
        method: 'GET',
        path: `${base}/nas`,
        body: {
          data: [
            {
              id: NAS_ID,
              name: 'Meraki lobby',
              nas_ip: null,
              nas_identifier: 'meraki-lobby',
              adapter_key: 'meraki-splash',
              status: 'active',
              site_id: null,
            },
          ],
          next_cursor: null,
        },
      },
      {
        method: 'GET',
        path: `${base}/nas/${NAS_ID}/setup-guide`,
        body: {
          nas_id: NAS_ID,
          adapter_key: 'meraki-splash',
          steps: [
            {
              id: 'splash-mode',
              title: 'Dashboard > Wireless > Configure > Access control',
              setting: 'Access control > Splash page',
              value: 'Sign-on with my RADIUS server',
              evidence: [],
            },
          ],
          warnings: [{ code: 'meraki_no_das_host', message: 'No Disconnect host registered.' }],
          meraki: OFF,
        },
      },
    ]);
    renderRoutes([{ path: '/orgs/:orgId/nas', element: <NasPage /> }], `/orgs/${ORG_A}/nas`);
    expect(await screen.findByText(/Meraki cloud RADIUS: OFF/)).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: 'Setup guide' }));
    expect(await screen.findByText('Sign-on with my RADIUS server')).toBeInTheDocument();
    expect(screen.getByText('No Disconnect host registered.')).toBeInTheDocument();
    expect(screen.getByText(/never shown here/)).toBeInTheDocument();
  });
});
