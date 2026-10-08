import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockFetch, withProviders } from '../../test/utils';
import { MfaResetDialog } from './MfaResetDialog';

afterEach(() => vi.unstubAllGlobals());

describe('MFA reset (D-038)', () => {
  it('requires a reason, posts it and confirms the revocation', async () => {
    const calls = mockFetch([
      {
        method: 'GET',
        path: '/api/v1/auth/me',
        status: 401,
        body: { type: 't', title: 'Unauthorized', status: 401 },
      },
      {
        method: 'POST',
        path: '/api/v1/platform/administrators/adm-1/mfa/reset',
        body: {
          administrator_id: 'adm-1',
          credentials_removed: 1,
          mfa_reenrol_required: true,
          sessions_revoked: 2,
        },
      },
    ]);
    const user = userEvent.setup();
    withProviders(
      <MfaResetDialog
        administrator={{ id: 'adm-1', email: 'lost@example.test' }}
        onClose={() => undefined}
        onDone={() => undefined}
      />,
    );
    const submit = await screen.findByRole('button', { name: 'Reset MFA' });
    expect(submit).toBeDisabled();
    await user.type(screen.getByLabelText(/reason/i), 'abc');
    expect(submit).toBeDisabled();
    await user.type(screen.getByLabelText(/reason/i), ' ticket 77 verified by phone');
    expect(submit).toBeEnabled();
    await user.click(submit);
    expect(await screen.findByText(/sessions were revoked/i)).toBeInTheDocument();
    const post = calls.find((c) => c.method === 'POST');
    expect(post?.body).toEqual({ reason: 'abc ticket 77 verified by phone' });
    expect(post?.headers['X-Requested-With']).toBe('XMLHttpRequest');
  });
});
