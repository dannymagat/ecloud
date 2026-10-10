import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { adminMe, orgScope, ORG_A } from '../../test/fixtures';
import { mockFetch, renderRoutes, type MockRoute } from '../../test/utils';
import type { SessionDetail, SessionRow } from '../../lib/accounting';
import { SessionDetailPage } from './SessionDetailPage';
import { SessionsPage } from './SessionsPage';

const SESSION = '01900000-0000-7000-8000-000000000061';
const SITE = '01900000-0000-7000-8000-0000000000c1';
const base = `/api/v1/orgs/${ORG_A}`;
const routes = [
  { path: '/orgs/:orgId/sessions', element: <SessionsPage /> },
  { path: '/orgs/:orgId/sessions/:sessionId', element: <SessionDetailPage /> },
];

const p = (name: string, extra: Record<string, unknown> = {}) => ({ name, in: 'query', ...extra });

/** OpenAPI document of the P8-A API (`full`) or of the Phase 7 API (no new filters/endpoints). */
const openapi = (full: boolean) => ({
  openapi: '3.1.0',
  paths: {
    '/api/v1/orgs/{orgId}/sessions': {
      get: {
        parameters: [
          p('limit'),
          p('cursor'),
          p('status', {
            schema: { enum: ['authorized', 'active', 'stopped', 'stale', 'expired'] },
          }),
          p('site_id'),
          p('nas_client_id'),
          p('user_id'),
          ...(full ? [p('open'), p('mac'), p('username'), p('from'), p('to')] : []),
        ],
      },
    },
    ...(full
      ? {
          '/api/v1/orgs/{orgId}/sessions/{id}/disconnect': { post: {} },
          '/api/v1/orgs/{orgId}/sessions/{id}/reauthorize': { post: {} },
        }
      : {}),
  },
});

const ROW: SessionRow = {
  id: SESSION,
  status: 'active',
  site_id: SITE,
  site_name: 'Lobby',
  nas_client_id: 'nas-1',
  nas_name: 'AP-1',
  adapter_key: 'openwifi-uspot-uam',
  username_raw: 'alice',
  mac: 'aa:bb:cc:dd:ee:ff',
  framed_ip: '10.0.0.5',
  policy_name: 'Standard',
  started_at: '2026-10-08T09:00:00Z',
  last_interim_at: '2026-10-08T09:10:00Z',
  stopped_at: null,
  coa_supported: null,
  bytes_total: 11534336,
  session_time_s: 600,
  input_octets: 1048576,
  output_octets: 10485760,
  last_accounting_at: '2026-10-08T09:10:00Z',
  freshness_s: 90,
  expected_lag_s: 305,
};

const AUTHORIZED: SessionRow = {
  ...ROW,
  id: '01900000-0000-7000-8000-000000000062',
  status: 'authorized',
  username_raw: 'bob',
  last_accounting_at: null,
  freshness_s: null,
};

const REASON =
  'Disconnect requests are not sent: the CoA/Disconnect dispatcher is disabled (ECLOUD_COA_ENABLED=false, D-006).';

const DETAIL: SessionDetail = {
  ...ROW,
  nas: {
    id: 'nas-1',
    name: 'AP-1',
    nas_ip: '100.64.0.2',
    adapter_key: 'openwifi-uspot-uam',
    coa_supported: null,
  },
  freshness: {
    measured_at: '2026-10-08T09:11:30Z',
    last_accounting_at: '2026-10-08T09:10:00Z',
    freshness_s: 900,
    expected_lag_s: 305,
  },
  timeline: [
    {
      id: 1,
      received_at: '2026-10-08T09:00:01Z',
      event_time: '2026-10-08T09:00:00Z',
      status_type: 'start',
      acct_session_id: 'A1',
      acct_unique_id: 'U1',
      calling_station_id: 'aa:bb:cc:dd:ee:ff',
      session_id: SESSION,
      terminate_cause: null,
      username: 'alice',
      nas_ip: '100.64.0.2',
      input_octets: 0,
      output_octets: 0,
      session_time_s: 0,
      delta_input_octets: null,
      delta_output_octets: null,
    },
    {
      id: 2,
      received_at: '2026-10-08T09:10:00Z',
      event_time: '2026-10-08T09:10:00Z',
      status_type: 'interim',
      acct_session_id: 'A1',
      acct_unique_id: 'U1',
      calling_station_id: 'aa:bb:cc:dd:ee:ff',
      session_id: SESSION,
      terminate_cause: null,
      username: 'alice',
      nas_ip: '100.64.0.2',
      input_octets: 1048576,
      output_octets: 10485760,
      session_time_s: 600,
      delta_input_octets: 1048576,
      delta_output_octets: 10485760,
    },
  ],
  timeline_truncated: false,
  anomalies: [
    {
      id: 'an1',
      kind: 'counter_wrap',
      counter: 'input',
      previous: '4294967000',
      observed: '100',
      estimated_lost_bytes: '396',
      applied: true,
      reason: '32-bit wrap',
      created_at: '2026-10-08T09:05:00Z',
    },
  ],
  enforcement: [
    {
      id: 'e1',
      trigger: 'policy_update',
      strategy: 'next_reauth',
      state: 'pending',
      reason: 'coaChange not lab validated; applies at next Access-Request',
      expected_apply_by: '2026-10-08T09:30:00Z',
      created_at: '2026-10-08T09:05:00Z',
      resolved_at: null,
    },
  ],
  session_actions: [],
  operations: {
    disconnect: {
      operation: 'disconnect',
      permission: 'session:disconnect',
      permitted: true,
      available: false,
      mode: null,
      device_enforced: false,
      code: 'dispatcher_disabled',
      reason: REASON,
      evidence: {
        status: 'REQUIRES_DEVICE_TEST',
        evidence_level: null,
        device_enforced: false,
        declaration: null,
      },
      dispatcher_enabled: false,
    },
    reauthorize: {
      operation: 'reauthorize',
      permission: 'session:coa',
      permitted: true,
      available: true,
      mode: 'lab',
      device_enforced: false,
      code: null,
      reason: 'Lab mode: CoA is sent although the adapter is not lab-validated.',
      evidence: {
        status: 'REQUIRES_DEVICE_TEST',
        evidence_level: 'VERIFIED_FROM_SOURCE',
        device_enforced: false,
        declaration: null,
      },
      dispatcher_enabled: true,
    },
  },
};

function mocks(
  perms: string[],
  { full = true, detail = DETAIL }: { full?: boolean; detail?: unknown } = {},
): MockRoute[] {
  return [
    { method: 'GET', path: '/api/v1/auth/me', body: adminMe([orgScope(ORG_A, perms)]) },
    { method: 'GET', path: '/api/v1/openapi.json', body: openapi(full) },
    {
      method: 'GET',
      path: `${base}/sessions`,
      body: { data: [ROW, AUTHORIZED], next_cursor: null, measured_at: '2026-10-08T09:11:30Z' },
    },
    { method: 'GET', path: `${base}/sessions/${SESSION}`, body: detail },
    { method: 'GET', path: `${base}/sites`, body: { data: [{ id: SITE, name: 'Lobby' }] } },
    { method: 'GET', path: `${base}/nas`, body: { data: [] } },
  ];
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('SessionsPage', () => {
  it('lists open sessions with state chips, freshness and disabled operations', async () => {
    const calls = mockFetch(mocks(['session:read', 'session:disconnect', 'site:read']));
    renderRoutes(routes, `/orgs/${ORG_A}/sessions`);

    const table = await screen.findByRole('table', { name: 'Sessions' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(2);
    // default chip "Open" → open=true
    expect(screen.getByRole('radio', { name: 'Open' })).toHaveAttribute('aria-checked', 'true');
    const listCall = calls.find((c) => c.url.startsWith(`${base}/sessions?`))!;
    expect(new URL(listCall.url, 'http://x').searchParams.get('open')).toBe('true');

    // freshness per open session
    expect(within(rows[0]!).getByText('Last accounting 2 min ago')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('No accounting received yet')).toBeInTheDocument();
    expect(screen.getAllByText(/can lag the real traffic/).length).toBeGreaterThan(0);

    // operations are visible but never enabled from the list (no per-row registry evidence)
    const disconnect = within(rows[0]!).getByRole('button', { name: 'Disconnect' });
    expect(disconnect).toBeDisabled();
    expect(within(rows[0]!).getByRole('button', { name: 'Re-authorize' })).toBeDisabled();
    expect(rows[0]!.querySelector('[data-operation="reauthorize"]')?.getAttribute('title')).toMatch(
      /session:coa/,
    );
    expect(rows[0]!.querySelector('[data-operation="disconnect"]')?.getAttribute('title')).toMatch(
      /lab-validated/,
    );
  });

  it('sends only the filters the API declares', async () => {
    const calls = mockFetch(mocks(['session:read', 'site:read']));
    renderRoutes(routes, `/orgs/${ORG_A}/sessions`);
    await screen.findByRole('table', { name: 'Sessions' });

    fireEvent.click(screen.getByRole('radio', { name: 'Stale' }));
    fireEvent.change(screen.getByLabelText('Client MAC'), {
      target: { value: 'AA-BB-CC-DD-EE-FF' },
    });
    fireEvent.change(screen.getByLabelText('User'), { target: { value: 'alice' } });
    await waitFor(() => {
      const last = new URL(
        calls.filter((c) => c.url.startsWith(`${base}/sessions?`)).at(-1)!.url,
        'http://x',
      );
      expect(last.searchParams.get('status')).toBe('stale');
      expect(last.searchParams.get('mac')).toBe('AA-BB-CC-DD-EE-FF');
      expect(last.searchParams.get('username')).toBe('alice');
      expect(last.searchParams.get('open')).toBeNull();
    });
  });

  it('takes the site filter from the URL (dashboard tiles, site chip) and clears it', async () => {
    const calls = mockFetch(mocks(['session:read', 'site:read']));
    renderRoutes(routes, `/orgs/${ORG_A}/sessions?site_id=${SITE}`);
    await screen.findByRole('table', { name: 'Sessions' });
    const listCall = calls.find((c) => c.url.startsWith(`${base}/sessions?`))!;
    expect(new URL(listCall.url, 'http://x').searchParams.get('site_id')).toBe(SITE);
    await waitFor(() => expect(screen.getByLabelText('Site')).toHaveValue(SITE));
    fireEvent.change(screen.getByLabelText('Site'), { target: { value: '' } });
    await waitFor(() => {
      const last = calls.filter((c) => c.url.startsWith(`${base}/sessions?`)).at(-1)!;
      expect(new URL(last.url, 'http://x').searchParams.get('site_id')).toBeNull();
    });
  });

  it('degrades against an API without the P8 filters', async () => {
    const calls = mockFetch(mocks(['session:read'], { full: false }));
    renderRoutes(routes, `/orgs/${ORG_A}/sessions`);
    await screen.findByRole('table', { name: 'Sessions' });
    expect(screen.getByLabelText('Client MAC')).toBeDisabled();
    expect(screen.getByLabelText('User')).toBeDisabled();
    const listCall = calls.find((c) => c.url.startsWith(`${base}/sessions?`))!;
    // "Open" falls back to status=active
    expect(new URL(listCall.url, 'http://x').searchParams.get('status')).toBe('active');
    expect(document.querySelector('[data-operation="disconnect"]')?.getAttribute('title')).toMatch(
      /session:disconnect/,
    );
  });
});

describe('SessionDetailPage', () => {
  it('shows timeline, anomalies, enforcement and freshness; operations disabled with the registry reason (V12)', async () => {
    mockFetch(mocks(['session:read', 'session:disconnect', 'session:coa']));
    renderRoutes(routes, `/orgs/${ORG_A}/sessions/${SESSION}`);

    const timeline = await screen.findByRole('table', { name: 'Accounting timeline' });
    expect(within(timeline).getAllByRole('row')).toHaveLength(3);
    expect(within(timeline).getByText('interim')).toBeInTheDocument();
    expect(within(timeline).getByText('1.0 MB / 10.0 MB')).toBeInTheDocument();

    const anomalies = screen.getByRole('table', { name: 'Accounting anomalies' });
    expect(within(anomalies).getByText('counter_wrap')).toBeInTheDocument();
    const enforcement = screen.getByRole('table', { name: 'Enforcement rows' });
    expect(within(enforcement).getByText('At next re-authentication')).toBeInTheDocument();

    // freshness from the nested `freshness` object (900 s vs 305 s expected lag → lagging)
    expect(screen.getByText('Last accounting 15 min ago (lagging)')).toBeInTheDocument();

    const disconnect = screen.getByRole('button', { name: 'Disconnect' });
    expect(disconnect).toBeDisabled();
    await waitFor(() =>
      expect(disconnect.closest('[data-operation]')).toHaveAttribute('title', REASON),
    );
    // lab mode: the API would accept it, the console still does not offer it
    const reauth = screen.getByRole('button', { name: 'Re-authorize' });
    expect(reauth).toBeDisabled();
    expect(reauth.closest('[data-operation]')?.getAttribute('title')).toMatch(
      /only for lab-validated adapters/,
    );
    expect(document.querySelector('[data-enabled="true"]')).toBeNull();
  });

  it('gates on the permission of the operation', async () => {
    mockFetch(mocks(['session:read', 'session:disconnect']));
    renderRoutes(routes, `/orgs/${ORG_A}/sessions/${SESSION}`);
    const reauth = await screen.findByRole('button', { name: 'Re-authorize' });
    await waitFor(() =>
      expect(reauth.closest('[data-operation]')?.getAttribute('title')).toMatch(/session:coa/),
    );
  });

  it('enables a lab-validated operation and reports the request as queued, not applied', async () => {
    const validated: SessionDetail = {
      ...DETAIL,
      operations: {
        ...DETAIL.operations,
        disconnect: {
          ...DETAIL.operations.disconnect,
          available: true,
          mode: 'validated',
          device_enforced: true,
          code: null,
          reason: 'Disconnect is lab-validated for this adapter (DT-07).',
          evidence: {
            status: 'VERIFIED_SUPPORTED',
            evidence_level: 'LAB_VALIDATED',
            device_enforced: true,
            declaration: null,
          },
        },
      },
    };
    const calls = mockFetch([
      {
        method: 'POST',
        path: `${base}/sessions/${SESSION}/disconnect`,
        status: 202,
        body: {
          session_action: { id: 'act-1', action: 'disconnect', status: 'pending' },
          deduplicated: false,
          mode: 'validated',
          device_enforced: true,
          message: 'queued',
        },
      },
      ...mocks(['session:read', 'session:disconnect'], { detail: validated }),
    ]);
    renderRoutes(routes, `/orgs/${ORG_A}/sessions/${SESSION}`);
    const button = await screen.findByRole('button', { name: 'Disconnect' });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: 'abuse report' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send disconnect request' }));
    expect(
      await screen.findByText(/Disconnect request queued \(action act-1\)/),
    ).toBeInTheDocument();
    expect(screen.getByText(/not a confirmation from the device/)).toBeInTheDocument();
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.body).toEqual({ reason: 'abuse report' });
    expect(post.headers['Idempotency-Key']).toBeTruthy();
  });

  it('shows a plain message when operation requests are rate limited (429)', async () => {
    const validated: SessionDetail = {
      ...DETAIL,
      operations: {
        ...DETAIL.operations,
        disconnect: {
          ...DETAIL.operations.disconnect,
          available: true,
          mode: 'validated',
          device_enforced: true,
          code: null,
          reason: 'Disconnect is lab-validated for this adapter (DT-07).',
          evidence: {
            status: 'VERIFIED_SUPPORTED',
            evidence_level: 'LAB_VALIDATED',
            device_enforced: true,
            declaration: null,
          },
        },
      },
    };
    mockFetch([
      {
        method: 'POST',
        path: `${base}/sessions/${SESSION}/disconnect`,
        status: 429,
        body: { type: 'about:blank', title: 'Too Many Requests', status: 429 },
      },
      ...mocks(['session:read', 'session:disconnect'], { detail: validated }),
    ]);
    renderRoutes(routes, `/orgs/${ORG_A}/sessions/${SESSION}`);
    const button = await screen.findByRole('button', { name: 'Disconnect' });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    fireEvent.click(screen.getByRole('button', { name: 'Send disconnect request' }));
    expect(await screen.findByText(/Too many attempts/)).toBeInTheDocument();
  });

  it('marks sections the API does not return as not available', async () => {
    const legacy = { ...ROW, session_actions: [] };
    mockFetch(mocks(['session:read'], { full: false, detail: legacy }));
    renderRoutes(routes, `/orgs/${ORG_A}/sessions/${SESSION}`);
    expect(await screen.findAllByText('Not available in this API version')).toHaveLength(3);
    expect(screen.getByRole('button', { name: 'Disconnect' })).toBeDisabled();
  });
});
