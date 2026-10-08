import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { adminMe, orgScope, ORG_A } from '../../test/fixtures';
import { mockFetch, renderRoutes } from '../../test/utils';
import { LoginPage } from './LoginPage';

const routes = [
  { path: '/login', element: <LoginPage /> },
  { path: '/', element: <p>Home screen</p> },
  { path: '/mfa/enrol', element: <p>Enrol screen</p> },
];

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('LoginPage', () => {
  it('signs in with password then TOTP and sends CSRF + JSON headers', async () => {
    const calls = mockFetch([
      {
        method: 'GET',
        path: '/api/v1/auth/me',
        status: 401,
        body: { type: 'x', title: 'Unauthorized', status: 401 },
        once: true,
      },
      {
        method: 'POST',
        path: '/api/v1/auth/login',
        body: { mfa_required: true, mfa_token: 't'.repeat(40) },
      },
      {
        method: 'POST',
        path: '/api/v1/auth/mfa/verify',
        body: { mfa_required: false, administrator: { id: 'a', email: 'operator@example.test' } },
      },
      { method: 'GET', path: '/api/v1/auth/me', body: adminMe([orgScope(ORG_A, ['site:read'])]) },
    ]);
    const user = userEvent.setup();
    renderRoutes(routes, '/login');

    await user.type(await screen.findByLabelText(/email/i), 'operator@example.test');
    await user.type(screen.getByLabelText(/password/i), 'correct horse battery');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    const code = await screen.findByLabelText(/authentication code/i);
    await user.type(code, '123456');
    await user.click(screen.getByRole('button', { name: /verify/i }));

    expect(await screen.findByText('Home screen')).toBeInTheDocument();
    const login = calls.find((c) => c.url === '/api/v1/auth/login');
    expect(login?.headers['X-Requested-With']).toBe('XMLHttpRequest');
    expect(login?.headers['Idempotency-Key']).toMatch(/[0-9a-f-]{36}/);
    expect(login?.body).toEqual({
      email: 'operator@example.test',
      password: 'correct horse battery',
    });
    const verify = calls.find((c) => c.url === '/api/v1/auth/mfa/verify');
    expect(verify?.body).toEqual({ mfa_token: 't'.repeat(40), code: '123456' });
  });

  it('shows the problem+json detail on invalid credentials', async () => {
    mockFetch([
      {
        method: 'GET',
        path: '/api/v1/auth/me',
        status: 401,
        body: { type: 'x', title: 'Unauthorized', status: 401 },
      },
      {
        method: 'POST',
        path: '/api/v1/auth/login',
        status: 401,
        body: {
          type: 'urn:problem:unauthorized',
          title: 'Unauthorized',
          status: 401,
          detail: 'Invalid email or password.',
          request_id: 'req-12345678',
        },
      },
    ]);
    const user = userEvent.setup();
    renderRoutes(routes, '/login');
    await user.type(await screen.findByLabelText(/email/i), 'x@example.test');
    await user.type(screen.getByLabelText(/password/i), 'nope');
    await user.click(screen.getByRole('button', { name: /sign in/i }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Invalid email or password.');
    expect(alert).toHaveTextContent('req-12345678');
    expect(screen.queryByText('Home screen')).not.toBeInTheDocument();
  });

  it('routes accounts that must enrol MFA to the enrolment screen', async () => {
    mockFetch([
      {
        method: 'GET',
        path: '/api/v1/auth/me',
        status: 401,
        body: { type: 'x', title: 'Unauthorized', status: 401 },
        once: true,
      },
      {
        method: 'POST',
        path: '/api/v1/auth/login',
        body: {
          mfa_required: false,
          mfa_enrolment_required: true,
          administrator: { id: 'a', email: 'p@example.test' },
        },
      },
      {
        method: 'GET',
        path: '/api/v1/auth/me',
        body: adminMe([], { mfa: { enrolled: false, required: true, pending: true } }),
      },
    ]);
    const user = userEvent.setup();
    renderRoutes(routes, '/login');
    await user.type(await screen.findByLabelText(/email/i), 'p@example.test');
    await user.type(screen.getByLabelText(/password/i), 'long enough password');
    await user.click(screen.getByRole('button', { name: /sign in/i }));
    expect(await screen.findByText('Enrol screen')).toBeInTheDocument();
  });

  it('explains an expired session and only follows same-app next paths', async () => {
    mockFetch([
      {
        method: 'GET',
        path: '/api/v1/auth/me',
        status: 401,
        body: { type: 'x', title: 'Unauthorized', status: 401 },
        once: true,
      },
      {
        method: 'POST',
        path: '/api/v1/auth/login',
        body: { mfa_required: false, administrator: { id: 'a', email: 'e@example.test' } },
      },
      { method: 'GET', path: '/api/v1/auth/me', body: adminMe([]) },
    ]);
    const user = userEvent.setup();
    renderRoutes(routes, '/login?expired=1&next=//evil.example');
    expect(await screen.findByText(/session has expired/i)).toBeInTheDocument();
    await user.type(screen.getByLabelText(/email/i), 'e@example.test');
    await user.type(screen.getByLabelText(/password/i), 'pw');
    await user.click(screen.getByRole('button', { name: /sign in/i }));
    await waitFor(() => expect(screen.getByText('Home screen')).toBeInTheDocument());
  });
});
