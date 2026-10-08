/**
 * Freshly generated voucher codes: shown once (the API stores only hashes), copyable and
 * printable as a card grid. Dismissing drops them from memory.
 */
import { useState } from 'react';
import { Button, Notice } from '../../components/ui';
import { formatDateTime, formatDuration } from '../../lib/format';

export interface CreatedBatch {
  id: string;
  name: string;
  codes: string[];
  valid_until?: string | null;
  duration_s?: number | null;
  max_uses?: number | null;
}

export function VoucherCodes({ batch, onDone }: { batch: CreatedBatch; onDone: () => void }) {
  const [copied, setCopied] = useState('');
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(batch.codes.join('\n'));
      setCopied('Copied to clipboard.');
    } catch {
      setCopied('Copy failed; select the codes manually.');
    }
  };
  return (
    <section aria-label="Voucher codes" className="space-y-4">
      <div className="space-y-3 print:hidden">
        <Notice tone="warning" title={`${batch.codes.length} voucher codes for “${batch.name}”`}>
          These codes are shown only now; ECLOUD keeps only a hash of each code. Print or copy them
          before leaving this view.
        </Notice>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="primary" onClick={() => window.print()}>
            Print
          </Button>
          <Button onClick={() => void copy()}>Copy all</Button>
          <Button onClick={onDone}>Done — discard codes</Button>
          <span aria-live="polite" className="text-xs text-subtle">
            {copied}
          </span>
        </div>
      </div>
      <ol
        data-testid="voucher-codes"
        className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 print:grid-cols-3 print:gap-2"
      >
        {batch.codes.map((code) => (
          <li
            key={code}
            className="break-inside-avoid rounded-md border border-dashed border-border p-3 text-center print:border-black"
          >
            <p className="text-xs uppercase tracking-wide text-subtle print:text-black">
              Wi-Fi voucher
            </p>
            <p className="mt-1 select-all font-mono text-lg font-semibold tracking-widest">
              {code}
            </p>
            <p className="mt-1 text-xs text-subtle print:text-black">
              {batch.duration_s ? `Duration ${formatDuration(batch.duration_s)}` : null}
              {batch.duration_s && batch.valid_until ? ' · ' : null}
              {batch.valid_until ? `Valid until ${formatDateTime(batch.valid_until)}` : null}
            </p>
          </li>
        ))}
      </ol>
    </section>
  );
}
