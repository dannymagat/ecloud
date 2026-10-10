/**
 * Copies one non-secret value (portal URL, RADIUS address, port, walled-garden host) to the
 * clipboard. The result is announced to screen readers; a failure tells the operator to select
 * the value manually. Never used for secrets (those are shown once by `SecretOnce`).
 */
import { Check, Copy } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from './ui';

export function CopyButton({ value, label }: { value: string; label: string }) {
  const [state, setState] = useState<'idle' | 'ok' | 'failed'>('idle');

  useEffect(() => {
    if (state === 'idle') return;
    const t = setTimeout(() => setState('idle'), 2000);
    return () => clearTimeout(t);
  }, [state]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setState('ok');
    } catch {
      setState('failed');
    }
  };

  return (
    <>
      <Button
        size="sm"
        variant="secondary"
        aria-label={`Copy ${label}`}
        title={`Copy ${label}`}
        onClick={() => void copy()}
        className="shrink-0"
      >
        {state === 'ok' ? (
          <Check aria-hidden="true" className="h-3.5 w-3.5 text-success" />
        ) : (
          <Copy aria-hidden="true" className="h-3.5 w-3.5" />
        )}
        <span>{state === 'ok' ? 'Copied' : 'Copy'}</span>
      </Button>
      <span role="status" aria-live="polite" className="sr-only">
        {state === 'ok'
          ? `${label} copied to the clipboard.`
          : state === 'failed'
            ? `Copy failed; select the ${label} manually.`
            : ''}
      </span>
    </>
  );
}
