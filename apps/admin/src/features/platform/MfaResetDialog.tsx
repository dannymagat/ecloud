/**
 * D-038: reset a lost MFA device. Platform-only, reason required; the API revokes the target's
 * sessions, forces re-enrolment and audits the action.
 */
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { api, newIdempotencyKey } from '../../api/client';
import { Dialog } from '../../components/Dialog';
import { ProblemAlert } from '../../components/ProblemAlert';
import { Button, Notice, TextAreaField } from '../../components/ui';

export const MFA_RESET_PATH = '/api/v1/platform/administrators/{id}/mfa/reset' as const;
/** Mirrors the API (`reason: z.string().trim().min(5)`). */
export const MIN_REASON_LENGTH = 5;

export function MfaResetDialog({
  administrator,
  onClose,
  onDone,
}: {
  administrator: { id: string; email: string };
  onClose: () => void;
  onDone: () => void;
}) {
  const [reason, setReason] = useState('');
  const [key] = useState(newIdempotencyKey);
  const reset = useMutation({
    mutationFn: () =>
      api('post', MFA_RESET_PATH, {
        params: { id: administrator.id },
        body: { reason: reason.trim() },
        idempotencyKey: key,
      }),
    onSuccess: onDone,
  });
  const valid = reason.trim().length >= MIN_REASON_LENGTH;
  return (
    <Dialog open title={`Reset MFA for ${administrator.email}`} onClose={onClose}>
      {reset.isSuccess ? (
        <div className="space-y-3">
          <Notice tone="success">
            MFA was reset. The administrator’s sessions were revoked; they must enrol a new
            authenticator at next sign-in.
          </Notice>
          <div className="flex justify-end">
            <Button variant="primary" onClick={onClose}>
              Close
            </Button>
          </div>
        </div>
      ) : (
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid) reset.mutate();
          }}
        >
          <Notice tone="warning">
            Verify the administrator’s identity out of band first. This removes their authenticator
            and recovery codes and signs them out everywhere.
          </Notice>
          <TextAreaField
            label="Reason"
            required
            rows={3}
            minLength={MIN_REASON_LENGTH}
            hint={`At least ${MIN_REASON_LENGTH} characters; recorded in the audit log.`}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <ProblemAlert error={reset.error} />
          <div className="flex justify-end gap-2">
            <Button onClick={onClose}>Cancel</Button>
            <Button type="submit" variant="danger" busy={reset.isPending} disabled={!valid}>
              Reset MFA
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
