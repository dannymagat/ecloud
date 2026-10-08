import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { EnforceabilityMatrix, toAdapterColumns } from '../features/policies/EnforceabilityMatrix';
import { ADAPTER_FIELD_STATUSES, presentStatus } from '../lib/adapterStatus';
import { disconnectGate } from '../lib/disconnect';
import { StatusBadge } from './StatusBadge';

describe('four-state enforceability badges (D-028)', () => {
  it.each(ADAPTER_FIELD_STATUSES)('%s renders its own state', (status) => {
    const { container } = render(<StatusBadge status={status} evidence="POLICY_ENGINE.md §3" />);
    const el = container.querySelector('[data-status]');
    expect(el?.getAttribute('data-status')).toBe(status);
    expect(el?.getAttribute('data-device-enforced')).toBe(
      status === 'VERIFIED_SUPPORTED' ? 'true' : 'false',
    );
  });

  it.each(['VERIFIED', 'verified_supported', 'SUPPORTED', '', null, undefined, 42])(
    'never renders %s as verified',
    (status) => {
      const { container } = render(<StatusBadge status={status} />);
      const el = container.querySelector('[data-status]');
      expect(el?.getAttribute('data-device-enforced')).toBe('false');
      expect(el?.getAttribute('data-status')).not.toBe('VERIFIED_SUPPORTED');
      expect(container).not.toHaveTextContent(/^✓/);
      expect(presentStatus(status).deviceEnforced).toBe(false);
    },
  );

  it('matrix shows Verified only in VERIFIED_SUPPORTED cells', () => {
    const adapters = toAdapterColumns([
      {
        adapter: 'coovachilli-uam',
        field_table: [
          {
            field: 'download_rate_kbps',
            status: 'REQUIRES_DEVICE_TEST',
            evidence: 'NETWORK_INTEGRATION.md §2',
            set: true,
          },
          {
            field: 'quota_daily_bytes',
            status: 'ECLOUD_SIDE_ONLY',
            evidence: 'POLICY_ENGINE.md §3',
            set: true,
          },
        ],
      },
      {
        key: 'openwifi-hostapd-radius',
        fields: [
          { field: 'download_rate_kbps', status: 'VERIFIED_SUPPORTED', evidence: 'test record' },
          { field: 'quota_daily_bytes', status: 'UNSUPPORTED', evidence: 'POLICY_ENGINE.md §3' },
        ],
      },
    ]);
    render(
      <EnforceabilityMatrix
        adapters={adapters}
        fields={['download_rate_kbps', 'quota_daily_bytes', 'vlan_id']}
      />,
    );
    const table = screen.getByRole('table');
    const verified = table.querySelectorAll('[data-device-enforced="true"]');
    expect(verified).toHaveLength(1);
    const rows = within(table).getAllByRole('row');
    // vlan_id is undeclared by both adapters → shown as not verified.
    const vlan = rows.find((r) => r.textContent?.includes('VLAN'));
    expect(vlan?.querySelectorAll('[data-device-enforced="true"]')).toHaveLength(0);
    expect(vlan?.querySelectorAll('[data-status="REQUIRES_DEVICE_TEST"]')).toHaveLength(2);
  });
});

describe('session Disconnect gating', () => {
  const base = { adapterKey: 'openwifi-uspot-uam', hasPermission: true, endpointAvailable: true };
  it('is disabled unless the adapter disconnect status is VERIFIED_SUPPORTED', () => {
    for (const status of [
      'REQUIRES_DEVICE_TEST',
      'UNSUPPORTED',
      'ECLOUD_SIDE_ONLY',
      undefined,
      'VERIFIED',
    ]) {
      const gate = disconnectGate({ ...base, status });
      expect(gate.enabled).toBe(false);
      expect(gate.reason.length).toBeGreaterThan(10);
    }
    expect(disconnectGate({ ...base, status: 'VERIFIED_SUPPORTED' }).enabled).toBe(true);
  });
  it('also requires the permission and an API endpoint', () => {
    expect(
      disconnectGate({ ...base, status: 'VERIFIED_SUPPORTED', hasPermission: false }).enabled,
    ).toBe(false);
    expect(
      disconnectGate({ ...base, status: 'VERIFIED_SUPPORTED', endpointAvailable: false }).enabled,
    ).toBe(false);
  });
});
