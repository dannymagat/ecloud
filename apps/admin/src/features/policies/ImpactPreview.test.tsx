import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { adminMe, orgScope, ORG_A } from '../../test/fixtures';
import { mockFetch, withProviders, type MockRoute } from '../../test/utils';
import { ImpactPreview } from './ImpactPreview';

const POLICY = '01900000-0000-7000-8000-000000000001';
const path = `/api/v1/orgs/${ORG_A}/policies/${POLICY}/impact-preview`;

function api(withEndpoint: boolean, body: unknown): MockRoute[] {
  return [
    {
      method: 'GET',
      path: '/api/v1/auth/me',
      body: adminMe([orgScope(ORG_A, ['policy:preview'])]),
    },
    {
      method: 'GET',
      path: '/api/v1/openapi.json',
      body: {
        paths: withEndpoint
          ? { '/api/v1/orgs/{orgId}/policies/{id}/impact-preview': { post: {} } }
          : {},
      },
    },
    { method: 'POST', path, body },
  ];
}

const COLUMNS = [
  {
    adapter: 'openwifi-uspot-uam',
    fields: [
      { field: 'download_rate_kbps', status: 'REQUIRES_DEVICE_TEST' },
      { field: 'quota_daily_bytes', status: 'ECLOUD_SIDE_ONLY' },
    ],
  },
  {
    adapter: 'coovachilli-uam',
    fields: [{ field: 'download_rate_kbps', status: 'REQUIRES_DEVICE_TEST' }],
  },
];

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ImpactPreview', () => {
  it('posts the draft changes and shows "N sessions affected; strategy next_reauth; … at most 30 min" with amber flags', async () => {
    const calls = mockFetch(
      api(true, {
        policy_id: POLICY,
        evaluated_sessions: 4,
        affected_sessions: 3,
        by_strategy: { coa_change: 0, disconnect_reauth: 0, next_reauth: 3, none: 0 },
        max_apply_latency_s: null,
        session_timeout_cap_s: 1800,
        sessions: [
          {
            session_id: 's1',
            site_id: null,
            nas_client_id: 'n1',
            adapter_key: 'openwifi-uspot-uam',
            strategy: 'next_reauth',
            state: 'pending',
            reason: 'x',
            expected_apply_by: null,
          },
        ],
        truncated: false,
        message: 'server wording',
      }),
    );
    const user = userEvent.setup();
    withProviders(
      <ImpactPreview
        orgId={ORG_A}
        policyId={POLICY}
        changes={{ download_rate_kbps: 10_000, quota_daily_bytes: '500000000', name: 'x' }}
        columns={COLUMNS}
        allowed
      />,
    );
    await user.click(await screen.findByRole('button', { name: 'Preview impact' }));
    expect(await screen.findByTestId('impact-summary')).toHaveTextContent(
      '3 sessions affected; strategy next_reauth; applies at next login, at most 30 min',
    );
    const post = calls.find((c) => c.method === 'POST');
    expect(post?.body).toEqual({
      download_rate_kbps: 10_000,
      quota_daily_bytes: '500000000',
      name: 'x',
    });
    // flags only for adapters of the affected sessions (uspot), not coovachilli
    const flags = [...document.querySelectorAll('[data-amber-flag]')].map((e) =>
      e.getAttribute('data-amber-flag'),
    );
    expect(flags).toEqual(['REQUIRES_DEVICE_TEST', 'ECLOUD_SIDE_ONLY']);
    expect(
      screen.getByText(/keep their current limits until they\s+re-authenticate/),
    ).toBeInTheDocument();
  });

  it('is disabled without changes and explicit when the API lacks the endpoint', async () => {
    mockFetch(api(true, {}));
    const { unmount } = withProviders(
      <ImpactPreview orgId={ORG_A} policyId={POLICY} changes={{}} columns={[]} allowed />,
    );
    expect(await screen.findByRole('button', { name: 'Preview impact' })).toBeDisabled();
    unmount();
    vi.unstubAllGlobals();

    const calls = mockFetch(api(false, {}));
    withProviders(
      <ImpactPreview
        orgId={ORG_A}
        policyId={POLICY}
        changes={{ download_rate_kbps: 1 }}
        columns={[]}
        allowed
      />,
    );
    expect(await screen.findByText('Not available in this API version')).toBeInTheDocument();
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(false));
  });
});
