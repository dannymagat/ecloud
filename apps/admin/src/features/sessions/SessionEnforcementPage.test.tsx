import { screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { adminMe, orgScope, ORG_A } from '../../test/fixtures';
import { mockFetch, renderRoutes, type MockRoute } from '../../test/utils';
import type { SessionEnforcementView } from '../../lib/enforcement';
import { SessionEnforcementPage } from './SessionEnforcementPage';

const SESSION = '01900000-0000-7000-8000-000000000051';
const base = `/api/v1/orgs/${ORG_A}`;
const routes = [{ path: '/orgs/:orgId/sessions/:sessionId', element: <SessionEnforcementPage /> }];

const openapi = (withEndpoint: boolean) => ({
  openapi: '3.1.0',
  paths: withEndpoint ? { '/api/v1/orgs/{orgId}/sessions/{id}/enforcement': { get: {} } } : {},
});

const VIEW: SessionEnforcementView = {
  session_id: SESSION,
  status: 'active',
  site_id: 'site-1',
  nas_client_id: 'nas-1',
  adapter_key: 'openwifi-uspot-uam',
  adapter_version: '0.1.0',
  snapshot: {
    policy_id: 'pol-1',
    policy_version: 4,
    hash: 'abc123',
    authorized_at: '2026-10-08T09:00:00Z',
    effective: { download_rate_kbps: 20000 },
  },
  attributes_sent: [
    {
      name: 'WISPr-Bandwidth-Max-Down',
      value: 20_000_000,
      field: 'download_rate_kbps',
      status: 'REQUIRES_DEVICE_TEST',
      evidence_level: 'VERIFIED_FROM_SOURCE',
      device_enforced: false,
    },
  ],
  fields: [
    {
      field: 'download_rate_kbps',
      value: 20000,
      set: true,
      status: 'REQUIRES_DEVICE_TEST',
      evidence: 'uspot code references WISPr',
      evidence_level: 'VERIFIED_FROM_SOURCE',
      device_enforced: false,
      mechanism: 'radius',
      attributes: ['WISPr-Bandwidth-Max-Down'],
      amber: true,
    },
    {
      field: 'quota_daily_bytes',
      value: '1000000000',
      set: true,
      status: 'ECLOUD_SIDE_ONLY',
      evidence: 'drainer',
      evidence_level: null,
      device_enforced: false,
      mechanism: 'ecloud_side',
      attributes: [],
      // a payload that forgot the flag is still flagged from its status
      amber: false,
    },
    {
      field: 'session_timeout_s',
      value: 1800,
      set: true,
      status: 'VERIFIED_SUPPORTED',
      evidence: 'source',
      evidence_level: 'VERIFIED_FROM_SOURCE',
      // contradictory payload: source evidence can never be device-enforced (V12)
      device_enforced: true,
      mechanism: 'radius',
      attributes: ['Session-Timeout'],
      amber: false,
    },
    {
      field: 'vlan_id',
      value: null,
      set: false,
      status: 'REQUIRES_DEVICE_TEST',
      evidence: '',
      evidence_level: null,
      device_enforced: false,
      mechanism: 'not_set',
      attributes: [],
      amber: false,
    },
  ],
  unenforceable: [],
  session_timeout: { value_s: 1800, sent: true, expected_reauth_by: '2026-10-08T09:30:00Z' },
  strategy_evidence: {
    coa_change: {
      status: 'REQUIRES_DEVICE_TEST',
      evidence_level: 'VERIFIED_FROM_SOURCE',
      device_enforced: false,
    },
    disconnect: { status: 'REQUIRES_DEVICE_TEST', evidence_level: null, device_enforced: false },
    dispatcher_enabled: false,
    strategy: 'next_reauth',
  },
  pending_change: {
    id: 'e1',
    change_id: 'c1',
    trigger: 'policy_update',
    strategy: 'next_reauth',
    state: 'pending',
    reason: 'coaChange not lab validated; applies at next Access-Request',
    policy_id: 'pol-1',
    expected_apply_by: '2026-10-08T09:30:00Z',
    created_at: '2026-10-08T09:05:00Z',
    resolved_at: null,
  },
  history: [],
  counter_anomalies: [],
};

function api(withEndpoint: boolean): MockRoute[] {
  return [
    { method: 'GET', path: '/api/v1/auth/me', body: adminMe([orgScope(ORG_A, ['session:read'])]) },
    { method: 'GET', path: '/api/v1/openapi.json', body: openapi(withEndpoint) },
    { method: 'GET', path: `${base}/sessions/${SESSION}/enforcement`, body: VIEW },
  ];
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('SessionEnforcementPage', () => {
  it('shows snapshot, attributes sent, amber flags, pending strategy; never device-enforced from source evidence', async () => {
    mockFetch(api(true));
    renderRoutes(routes, `/orgs/${ORG_A}/sessions/${SESSION}`);

    const fields = await screen.findByRole('table', { name: 'Policy fields and enforcement' });
    const rows = within(fields).getAllByRole('row').slice(1);
    // only set fields are listed
    expect(rows).toHaveLength(3);
    const byField = (label: string) => rows.find((r) => r.textContent?.includes(label))!;
    expect(
      byField('Download rate').querySelector('[data-amber-flag]')?.getAttribute('data-amber-flag'),
    ).toBe('REQUIRES_DEVICE_TEST');
    expect(
      byField('Daily quota').querySelector('[data-amber-flag]')?.getAttribute('data-amber-flag'),
    ).toBe('ECLOUD_SIDE_ONLY');
    const timeout = byField('Session timeout');
    expect(timeout.querySelector('[data-amber-flag]')).toBeNull();
    expect(within(timeout).getAllByRole('cell')[3]).toHaveTextContent('No');
    expect(document.querySelector('[data-device-enforced="true"]')).toBeNull();

    const sent = screen.getByRole('table', { name: 'RADIUS reply attributes sent' });
    expect(within(sent).getByText('WISPr-Bandwidth-Max-Down')).toBeInTheDocument();
    expect(within(sent).getByText('20000000')).toBeInTheDocument();
    expect(screen.getByText(/2 amber-flagged/)).toBeInTheDocument();
    expect(screen.getAllByText('At next re-authentication').length).toBeGreaterThan(0);
    expect(screen.getByText(/disabled \(default, D-006\)/)).toBeInTheDocument();
    expect(screen.getByText(/coaChange not lab validated/)).toBeInTheDocument();
  });

  it('says the endpoint is not available against an API without it', async () => {
    const calls = mockFetch(api(false));
    renderRoutes(routes, `/orgs/${ORG_A}/sessions/${SESSION}`);
    expect(await screen.findByText('Not available in this API version')).toBeInTheDocument();
    expect(calls.some((c) => c.url.includes('/enforcement'))).toBe(false);
  });
});
