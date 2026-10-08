/**
 * Disconnect / Re-authorize buttons (D-006, V12). Always visible; disabled with the registry
 * reason (from the API's per-session `operations` evidence) unless the operation is available
 * AND the adapter capability is lab-validated. A sent request is reported as "queued" with its
 * session-action id, never as applied on the device. Idempotency key per confirmation dialog.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { buildUrl, newIdempotencyKey, request } from '../../api/client';
import { ApiError } from '../../api/problem';
import { Dialog } from '../../components/Dialog';
import { ProblemAlert } from '../../components/ProblemAlert';
import { Button, Notice, TextAreaField } from '../../components/ui';
import {
  OPERATION_LABEL,
  queuedMessage,
  SESSION_DISCONNECT_PATH,
  SESSION_REAUTHORIZE_PATH,
  TOO_MANY_ATTEMPTS,
  type OperationGate,
  type SessionOperationAccepted,
  type SessionOperation,
} from '../../lib/accounting';

/** Mirrors the API body (`reason ≤ 500`). */
export const MAX_REASON_LENGTH = 500;

export const OPERATION_PATH: Record<SessionOperation, string> = {
  disconnect: SESSION_DISCONNECT_PATH,
  reauthorize: SESSION_REAUTHORIZE_PATH,
};

function ConfirmDialog({
  operation,
  orgId,
  sessionId,
  label,
  onClose,
}: {
  operation: SessionOperation;
  orgId: string;
  sessionId: string;
  label: string;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [key] = useState(newIdempotencyKey);
  const [reason, setReason] = useState('');
  const send = useMutation({
    mutationFn: () =>
      request<SessionOperationAccepted>(
        'post',
        buildUrl(OPERATION_PATH[operation], { orgId, id: sessionId }, undefined),
        {
          body: reason.trim() ? { reason: reason.trim() } : {},
          idempotencyKey: key,
          pathTemplate: OPERATION_PATH[operation],
        },
      ),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['org', orgId, 'sessions'] }),
  });
  const name = OPERATION_LABEL[operation];
  return (
    <Dialog open title={`${name} session`} onClose={onClose}>
      {send.isSuccess ? (
        <div className="space-y-3">
          <Notice tone="info" title="Request queued">
            {queuedMessage(operation, send.data ?? {})}
          </Notice>
          <div className="flex justify-end">
            <Button onClick={onClose}>Close</Button>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-sm">
            {operation === 'disconnect'
              ? `Ask the NAS to end the session of ${label}. The client may reconnect and authenticate again.`
              : `Ask the NAS to apply the currently resolved policy to the session of ${label} (RADIUS CoA).`}
          </p>
          <p className="text-xs text-subtle">
            The outcome is recorded as a session action (sent, acknowledged, rejected or timed out)
            as reported by the NAS.
          </p>
          <TextAreaField
            label="Reason (optional, recorded in the audit log)"
            maxLength={MAX_REASON_LENGTH}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          {send.error instanceof ApiError && send.error.status === 429 ? (
            <Notice tone="warning">{TOO_MANY_ATTEMPTS}</Notice>
          ) : send.error ? (
            <ProblemAlert error={send.error} />
          ) : null}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant={operation === 'disconnect' ? 'danger' : 'primary'}
              busy={send.isPending}
              onClick={() => send.mutate()}
            >
              Send {name.toLowerCase()} request
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}

export function OperationButton({
  operation,
  gate,
  orgId,
  sessionId,
  label,
}: {
  operation: SessionOperation;
  gate: OperationGate;
  orgId: string;
  sessionId: string;
  label: string;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  return (
    <span
      className="inline-flex items-center gap-1"
      title={gate.reason}
      data-operation={operation}
      data-enabled={gate.enabled ? 'true' : 'false'}
    >
      <Button
        size="sm"
        variant={operation === 'disconnect' ? 'danger' : 'secondary'}
        disabled={!gate.enabled}
        aria-describedby={id}
        onClick={() => setOpen(true)}
      >
        {OPERATION_LABEL[operation]}
      </Button>
      <span id={id} role="tooltip" className="sr-only">
        {gate.reason}
      </span>
      {open && gate.enabled ? (
        <ConfirmDialog
          operation={operation}
          orgId={orgId}
          sessionId={sessionId}
          label={label}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </span>
  );
}
