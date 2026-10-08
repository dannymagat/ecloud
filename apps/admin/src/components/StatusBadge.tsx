/**
 * Four-state enforceability badge (D-028). The visual "Verified" state is reachable ONLY for
 * the exact value VERIFIED_SUPPORTED; anything else renders as not enforced.
 */
import { presentStatus } from '../lib/adapterStatus';
import { Badge } from './ui';

export function StatusBadge({
  status,
  evidence,
  legend = false,
}: {
  status: unknown;
  evidence?: string;
  /** Legend sample: not a capability claim, excluded from data-status queries. */
  legend?: boolean;
}) {
  const p = presentStatus(status);
  const title = evidence ? `${p.description}\nEvidence: ${evidence}` : p.description;
  return (
    <span
      data-status={legend ? undefined : p.status}
      data-legend-status={legend ? p.status : undefined}
      data-device-enforced={legend ? undefined : p.deviceEnforced ? 'true' : 'false'}
    >
      <Badge tone={p.tone} title={title}>
        <span aria-hidden="true">{p.deviceEnforced ? '✓' : p.tone === 'danger' ? '✕' : '!'}</span>
        {p.label}
        <span className="sr-only">: {p.description}</span>
      </Badge>
    </span>
  );
}

export function StatusLegend() {
  return (
    <ul className="flex flex-wrap gap-2 text-xs" aria-label="Status legend">
      {(
        ['VERIFIED_SUPPORTED', 'REQUIRES_DEVICE_TEST', 'ECLOUD_SIDE_ONLY', 'UNSUPPORTED'] as const
      ).map((s) => (
        <li key={s} className="flex items-center gap-1">
          <StatusBadge status={s} legend />
          <span className="text-subtle">{presentStatus(s).description}</span>
        </li>
      ))}
    </ul>
  );
}
