/**
 * Amber flag (Q67): marks a policy field whose status is REQUIRES_DEVICE_TEST or
 * ECLOUD_SIDE_ONLY — sent or tracked, but NOT proven on a device. Renders nothing otherwise.
 */
import { amberReason, isAmberStatus } from '../lib/enforcement';
import { Badge } from './ui';

export function AmberFlag({ status }: { status: unknown }) {
  if (!isAmberStatus(status)) return null;
  const reason = amberReason(status);
  const label = status === 'ECLOUD_SIDE_ONLY' ? 'ECLOUD side only' : 'Not device-verified';
  return (
    <span data-amber-flag={typeof status === 'string' ? status : 'UNKNOWN'}>
      <Badge tone="warning" title={reason}>
        <span aria-hidden="true">⚑</span>
        {label}
        <span className="sr-only">: {reason}</span>
      </Badge>
    </span>
  );
}
