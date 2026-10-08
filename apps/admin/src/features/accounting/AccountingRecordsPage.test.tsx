import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ScopedPermissions } from '../../api/types';
import { adminMe, orgScope, ORG_A } from '../../test/fixtures';
import { mockFetch, renderRoutes, type MockRoute } from '../../test/utils';
import { AccountingRecordsPage } from './AccountingRecordsPage';

const base = `/api/v1/orgs/${ORG_A}`;
const routes = [{ path: '/orgs/:orgId/accounting', element: <AccountingRecordsPage /> }];

const openapi = (available: boolean) => ({
  openapi: '3.1.0',
  paths: available
    ? {
        '/api/v1/orgs/{orgId}/accounting/records': {
          get: {
            parameters: [
              { name: 'from', in: 'query' },
              { name: 'to', in: 'query' },
              { name: 'username', in: 'query' },
              { name: 'calling_station_id', in: 'query' },
            ],
          },
        },
        '/api/v1/orgs/{orgId}/accounting/export': { post: {} },
      }
    : {},
});

const RECORD = {
  id: '42',
  received_at: '2026-10-08T09:10:00Z',
  event_time: '2026-10-08T09:10:00Z',
  status_type: 'interim',
  acct_session_id: 'A1',
  nas_ip: '100.64.0.2',
  username: 'alice',
  calling_station_id: 'AA-BB-CC-DD-EE-FF',
  input_octets: 1048576,
  output_octets: 2097152,
  session_time_s: 600,
};

function mocks(scopes: ScopedPermissions[], available = true, impersonating = false): MockRoute[] {
  return [
    {
      method: 'GET',
      path: '/api/v1/auth/me',
      body: adminMe(
        scopes,
        impersonating
          ? {
              impersonation: { organization_id: ORG_A, reason: 'ticket', expires_at: '2099-01-01' },
            }
          : {},
      ),
    },
    { method: 'GET', path: '/api/v1/openapi.json', body: openapi(available) },
    {
      method: 'GET',
      path: `${base}/accounting/records`,
      body: { data: [RECORD], next_cursor: null, measured_at: '2026-10-08T09:11:00Z' },
    },
  ];
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('AccountingRecordsPage', () => {
  it('queries a bounded window and the declared filters; export hidden for read-only', async () => {
    const calls = mockFetch(mocks([orgScope(ORG_A, ['accounting:read', 'report:read'])]));
    renderRoutes(routes, `/orgs/${ORG_A}/accounting`);

    const table = await screen.findByRole('table', { name: 'Accounting records' });
    expect(within(table).getByText('alice')).toBeInTheDocument();
    const first = new URL(
      calls.find((c) => c.url.includes('/accounting/records'))!.url,
      'http://x',
    );
    const from = Date.parse(first.searchParams.get('from')!);
    const to = Date.parse(first.searchParams.get('to')!);
    expect(to - from).toBe(24 * 3600 * 1000);
    // only filters the API declares are offered
    expect(screen.getByLabelText('Client MAC')).toBeInTheDocument();
    expect(screen.queryByLabelText('NAS IP')).toBeNull();
    fireEvent.change(screen.getByLabelText('User name'), { target: { value: 'alice' } });
    await waitFor(() => {
      const last = calls.filter((c) => c.url.includes('/accounting/records')).at(-1)!;
      expect(new URL(last.url, 'http://x').searchParams.get('username')).toBe('alice');
    });
    expect(screen.queryByRole('button', { name: 'Export CSV' })).toBeNull();
  });

  it('refuses a window over 31 days without querying', async () => {
    const calls = mockFetch(mocks([orgScope(ORG_A, ['accounting:read'])]));
    renderRoutes(routes, `/orgs/${ORG_A}/accounting`);
    await screen.findByRole('table', { name: 'Accounting records' });
    const before = calls.length;
    fireEvent.change(screen.getByLabelText(/^From/), { target: { value: '2026-08-01T00:00' } });
    fireEvent.change(screen.getByLabelText(/^To/), { target: { value: '2026-10-01T00:00' } });
    expect(
      await screen.findByText('The time window may span at most 31 days.'),
    ).toBeInTheDocument();
    expect(calls.slice(before).some((c) => c.url.includes('/accounting/records'))).toBe(false);
  });

  it('exports CSV with accounting:export (POST, filters in the body)', async () => {
    const calls = mockFetch(mocks([orgScope(ORG_A, ['accounting:read', 'accounting:export'])]));
    const jsonFetch = globalThis.fetch;
    const exports: { url: string; headers: Record<string, string>; body: unknown }[] = [];
    vi.stubGlobal('fetch', (input: string, init: RequestInit = {}) => {
      if (!input.includes('/accounting/export')) return jsonFetch(input, init);
      exports.push({
        url: input,
        headers: init.headers as Record<string, string>,
        body: JSON.parse(init.body as string) as unknown,
      });
      return Promise.resolve(
        new Response('received_at,username\n', {
          status: 200,
          headers: {
            'Content-Type': 'text/csv',
            'Content-Disposition': 'attachment; filename="accounting.csv"',
          },
        }),
      );
    });
    const createObjectURL = vi.fn(() => 'blob:x');
    Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() });
    renderRoutes(routes, `/orgs/${ORG_A}/accounting`);
    const button = await screen.findByRole('button', { name: 'Export CSV' });
    fireEvent.click(button);
    expect(await screen.findByText('Export downloaded.')).toBeInTheDocument();
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(exports).toHaveLength(1);
    expect(Object.keys(exports[0]!.body as object)).toEqual(expect.arrayContaining(['from', 'to']));
    expect(exports[0]!.headers['X-Requested-With']).toBe('XMLHttpRequest');
    expect(exports[0]!.headers['Idempotency-Key']).toBeTruthy();
    expect(calls.some((c) => c.url.includes('/accounting/records'))).toBe(true);
  });

  it('hides export while impersonating', async () => {
    mockFetch(mocks([orgScope(ORG_A, ['accounting:read', 'accounting:export'])], true, true));
    renderRoutes(routes, `/orgs/${ORG_A}/accounting`);
    await screen.findByRole('table', { name: 'Accounting records' });
    expect(screen.queryByRole('button', { name: 'Export CSV' })).toBeNull();
    expect(screen.getByText('Exports are not available while impersonating.')).toBeInTheDocument();
  });

  it('says the endpoint is not available against an API without it', async () => {
    const calls = mockFetch(mocks([orgScope(ORG_A, ['accounting:read'])], false));
    renderRoutes(routes, `/orgs/${ORG_A}/accounting`);
    expect(await screen.findByText('Not available in this API version')).toBeInTheDocument();
    expect(calls.some((c) => c.url.includes('/accounting/records'))).toBe(false);
  });
});
