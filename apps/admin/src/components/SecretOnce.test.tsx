import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { VoucherCodes } from '../features/vouchers/VoucherCodes';
import { SecretOnce } from './SecretOnce';

describe('SecretOnce', () => {
  it('shows the secret, copies it, and drops it for good after acknowledgement', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const onDone = vi.fn();
    render(<SecretOnce title="RADIUS shared secret" value="s3cr3t-value-123" onDone={onDone} />);

    expect(screen.getByTestId('secret-value')).toHaveTextContent('s3cr3t-value-123');
    await user.click(screen.getByRole('button', { name: 'Copy' }));
    expect(writeText).toHaveBeenCalledWith('s3cr3t-value-123');
    expect(await screen.findByText('Copied to clipboard.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /stored it/i }));
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('secret-value')).not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent('s3cr3t-value-123');
    expect(screen.getByText(/cannot be retrieved again/i)).toBeInTheDocument();
  });

  it('renders lists (recovery codes) one per item', () => {
    render(<SecretOnce title="Recovery codes" value={['aaaa-bbbb', 'cccc-dddd']} />);
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });

  it('voucher codes are printable and discarded on Done', async () => {
    const user = userEvent.setup();
    const onDone = vi.fn();
    const print = vi.fn();
    vi.stubGlobal('print', print);
    render(
      <VoucherCodes
        batch={{ id: 'b', name: 'Lobby', codes: ['ABCD1234', 'EFGH5678'], duration_s: 3600 }}
        onDone={onDone}
      />,
    );
    expect(screen.getByTestId('voucher-codes').querySelectorAll('li')).toHaveLength(2);
    await user.click(screen.getByRole('button', { name: 'Print' }));
    expect(print).toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: /discard codes/i }));
    expect(onDone).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
