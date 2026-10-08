/**
 * Displays a secret exactly once (NAS shared secret, API key, invitation token, recovery
 * codes, voucher codes). The value lives only in component state; after the operator
 * acknowledges, it is dropped and cannot be shown again (the API never returns it twice).
 */
import { useState, type ReactNode } from 'react';
import { Button, Notice } from './ui';

export interface SecretOnceProps {
  title: string;
  /** One secret or a list (e.g. recovery codes). */
  value: string | readonly string[];
  description?: ReactNode;
  onDone?: () => void;
  doneLabel?: string;
  extraActions?: ReactNode;
}

export function SecretOnce({
  title,
  value,
  description,
  onDone,
  doneLabel = 'I have stored it',
  extraActions,
}: SecretOnceProps) {
  const [dismissed, setDismissed] = useState(false);
  const [copied, setCopied] = useState<'idle' | 'ok' | 'failed'>('idle');
  const text = typeof value === 'string' ? value : value.join('\n');

  if (dismissed) {
    return (
      <Notice tone="neutral" title={title}>
        The value is no longer displayed and cannot be retrieved again.
      </Notice>
    );
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied('ok');
    } catch {
      setCopied('failed');
    }
  };

  return (
    <section
      aria-label={title}
      className="space-y-3 rounded-md border border-warning/50 bg-warning/5 p-4"
    >
      <div>
        <h3 className="text-sm font-semibold">{title}</h3>
        <p className="mt-0.5 text-xs text-subtle">
          {description ?? 'Shown once. Copy it now; ECLOUD stores only a protected form.'}
        </p>
      </div>
      {typeof value === 'string' ? (
        <code
          data-testid="secret-value"
          className="block select-all break-all rounded bg-muted px-3 py-2 font-mono text-sm"
        >
          {value}
        </code>
      ) : (
        <ol
          data-testid="secret-value"
          className="grid select-all grid-cols-1 gap-1 rounded bg-muted px-3 py-2 font-mono text-sm sm:grid-cols-2"
        >
          {value.map((v) => (
            <li key={v}>{v}</li>
          ))}
        </ol>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={() => void copy()}>
          Copy
        </Button>
        {extraActions}
        <Button
          size="sm"
          variant="primary"
          onClick={() => {
            setDismissed(true);
            onDone?.();
          }}
        >
          {doneLabel}
        </Button>
        <span aria-live="polite" className="text-xs text-subtle">
          {copied === 'ok'
            ? 'Copied to clipboard.'
            : copied === 'failed'
              ? 'Copy failed; select and copy manually.'
              : ''}
        </span>
      </div>
    </section>
  );
}
