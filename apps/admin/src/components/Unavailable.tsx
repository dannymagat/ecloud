import type { ReactNode } from 'react';
import { Notice } from './ui';

/** Explicit state for screens whose API endpoint is not deployed yet (reported as an API gap). */
export function Unavailable({ endpoint, children }: { endpoint: string; children?: ReactNode }) {
  return (
    <Notice tone="warning" title="Not available in this API version">
      <p>
        This screen needs <code className="font-mono">{endpoint}</code>, which the connected API
        does not provide yet.
      </p>
      {children}
    </Notice>
  );
}
