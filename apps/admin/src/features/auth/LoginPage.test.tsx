import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { adminMe, orgScope, ORG_A } from '../../test/fixtures';
import { mockFetch, renderRoutes } from '../../test/utils';
import { LoginPage, REMEMBER_EMAIL_KEY } from './LoginPage';

const routes = [
  { path: '/login', element: <LoginPage /> },
  { path: '/', element: <p>Home screen</p> },
  { path: '/mfa/enrol', element: <p>Enrol screen</p> },
];

const anonymous = {
  method: 'GET',
  path: '/api/v1/auth/me',
  status: 401,
  body: { type: 'x', title: 'Unauthorized', status: 401 },
};

beforeEach(() => localStorage.clear());

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
    await user.type(screen.getByLabelText('Password'), 'correct horse battery');
    await user.click(screen.getByRole('button', { name: /^log in$/i }));

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
    await user.type(screen.getByLabelText('Password'), 'nope');
    await user.click(screen.getByRole('button', { name: /^log in$/i }));
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
    await user.type(screen.getByLabelText('Password'), 'long enough password');
    await user.click(screen.getByRole('button', { name: /^log in$/i }));
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
    await user.type(screen.getByLabelText('Password'), 'pw');
    await user.click(screen.getByRole('button', { name: /^log in$/i }));
    await waitFor(() => expect(screen.getByText('Home screen')).toBeInTheDocument());
  });

  it('renders the sign-in card with labelled fields and no SSO options', async () => {
    mockFetch([anonymous]);
    renderRoutes(routes, '/login');
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.getByText('Please sign in to continue.')).toBeInTheDocument();
    const email = screen.getByLabelText('Email');
    expect(email).toHaveAttribute('type', 'email');
    expect(email).toHaveAttribute('autocomplete', 'username');
    expect(email).toHaveAttribute('placeholder', 'you@company.com');
    expect(screen.getByLabelText('Password')).toHaveAttribute('autocomplete', 'current-password');
    expect(screen.queryByText(/or login with/i)).not.toBeInTheDocument();
  });

  it('toggles password visibility with an accessible eye button', async () => {
    mockFetch([anonymous]);
    const user = userEvent.setup();
    renderRoutes(routes, '/login');
    const password = await screen.findByLabelText('Password');
    await user.type(password, 'secret');
    expect(password).toHaveAttribute('type', 'password');
    const show = screen.getByRole('button', { name: 'Show password' });
    expect(show).toHaveAttribute('aria-pressed', 'false');
    await user.click(show);
    expect(password).toHaveAttribute('type', 'text');
    const hide = screen.getByRole('button', { name: 'Hide password' });
    expect(hide).toHaveAttribute('aria-pressed', 'true');
    await user.click(hide);
    expect(password).toHaveAttribute('type', 'password');
  });

  it('flags empty fields, associates the errors and focuses the first invalid field', async () => {
    const calls = mockFetch([anonymous]);
    const user = userEvent.setup();
    renderRoutes(routes, '/login');
    await user.click(await screen.findByRole('button', { name: /^log in$/i }));
    const email = screen.getByLabelText('Email');
    expect(email).toHaveAttribute('aria-invalid', 'true');
    expect(email).toHaveAccessibleDescription('Enter your email address.');
    expect(screen.getByLabelText('Password')).toHaveAccessibleDescription('Enter your password.');
    expect(email).toHaveFocus();

    await user.type(email, 'ops@example.test');
    await user.click(screen.getByRole('button', { name: /^log in$/i }));
    expect(screen.getByLabelText('Password')).toHaveFocus();
    expect(email).not.toHaveAttribute('aria-invalid');
    expect(calls.find((c) => c.url === '/api/v1/auth/login')).toBeUndefined();
  });

  it('remembers only the email after a successful sign-in, never after a failed one, and forgets it when unchecked', async () => {
    const failed = {
      method: 'POST',
      path: '/api/v1/auth/login',
      status: 401,
      body: { type: 'x', title: 'Unauthorized', status: 401, detail: 'Invalid email or password.' },
    };
    const accepted = {
      method: 'POST',
      path: '/api/v1/auth/login',
      body: { mfa_required: true, mfa_token: 't'.repeat(40) },
    };
    const user = userEvent.setup();

    // 1. Failed sign-in with "Remember me": nothing is stored (a mistyped address is not kept).
    mockFetch([anonymous, failed]);
    const first = renderRoutes(routes, '/login');
    await user.type(await screen.findByLabelText('Email'), 'typo@example.test');
    await user.type(screen.getByLabelText('Password'), 'pw-not-stored');
    await user.click(screen.getByRole('checkbox', { name: 'Remember me' }));
    await user.click(screen.getByRole('button', { name: /^log in$/i }));
    await screen.findByRole('alert');
    expect(localStorage.getItem(REMEMBER_EMAIL_KEY)).toBeNull();
    first.unmount();

    // 2. Accepted password: only the email is stored.
    mockFetch([anonymous, accepted]);
    const second = renderRoutes(routes, '/login');
    await user.type(await screen.findByLabelText('Email'), 'keep@example.test');
    await user.type(screen.getByLabelText('Password'), 'pw-not-stored');
    await user.click(screen.getByRole('checkbox', { name: 'Remember me' }));
    await user.click(screen.getByRole('button', { name: /^log in$/i }));
    await waitFor(() => expect(localStorage.getItem(REMEMBER_EMAIL_KEY)).toBe('keep@example.test'));
    expect(localStorage.length).toBe(1);
    expect(JSON.stringify({ ...localStorage })).not.toContain('pw-not-stored');
    second.unmount();

    // 3. Pre-filled next time; unchecking and signing in again forgets it.
    mockFetch([anonymous, accepted]);
    renderRoutes(routes, '/login');
    expect(await screen.findByLabelText('Email')).toHaveValue('keep@example.test');
    const box = screen.getByRole('checkbox', { name: 'Remember me' });
    expect(box).toBeChecked();
    await user.click(box);
    await user.type(screen.getByLabelText('Password'), 'pw');
    await user.click(screen.getByRole('button', { name: /^log in$/i }));
    await waitFor(() => expect(localStorage.getItem(REMEMBER_EMAIL_KEY)).toBeNull());
  });

  it('still signs in when storage is unavailable', async () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    });
    mockFetch([
      { ...anonymous, once: true },
      {
        method: 'POST',
        path: '/api/v1/auth/login',
        body: { mfa_required: false, administrator: { id: 'a', email: 'e@example.test' } },
      },
      { method: 'GET', path: '/api/v1/auth/me', body: adminMe([]) },
    ]);
    const user = userEvent.setup();
    renderRoutes(routes, '/login');
    await user.type(await screen.findByLabelText('Email'), 'e@example.test');
    await user.type(screen.getByLabelText('Password'), 'pw');
    await user.click(screen.getByRole('checkbox', { name: 'Remember me' }));
    await user.click(screen.getByRole('button', { name: /^log in$/i }));
    expect(await screen.findByText('Home screen')).toBeInTheDocument();
  });

  it('explains how passwords are reset in an accessible disclosure', async () => {
    mockFetch([anonymous]);
    const user = userEvent.setup();
    renderRoutes(routes, '/login');
    const forgot = await screen.findByRole('button', { name: 'Forgot your password?' });
    expect(forgot).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText(/reset by your platform administrator/i)).not.toBeInTheDocument();
    await user.click(forgot);
    expect(forgot).toHaveAttribute('aria-expanded', 'true');
    const note = screen.getByRole('note');
    expect(note).toHaveTextContent(
      'Passwords are reset by your platform administrator. Ask them to reset it from Platform › Administrators.',
    );
    expect(note.parentElement).toHaveAttribute('id', forgot.getAttribute('aria-controls'));
  });
});
