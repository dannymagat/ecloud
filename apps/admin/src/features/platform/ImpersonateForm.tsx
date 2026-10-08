/**
 * Start support impersonation (D-027): explicit reason, TTL capped at 60 minutes, audited by
 * the API. While active the banner in the shell shows the countdown and a Stop button.
 */
import { useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { api } from '../../api/client';
import { fieldErrors, problemOf, type Problem } from '../../api/problem';
import { ProblemAlert } from '../../components/ProblemAlert';
import { Button, SelectField, TextAreaField, TextField } from '../../components/ui';
import { useAuth } from '../../lib/auth';

export const MAX_IMPERSONATION_MINUTES = 60;
/** Mirrors the API (`reason: z.string().trim().min(5)`). */
export const MIN_REASON_LENGTH = 5;

export function ImpersonateForm({
  organizations,
  initialOrganizationId = '',
  onCancel,
}: {
  organizations: readonly { id: string; name: string }[];
  initialOrganizationId?: string;
  onCancel?: () => void;
}) {
  const { refresh } = useAuth();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [organizationId, setOrganizationId] = useState(initialOrganizationId);
  const [reason, setReason] = useState('');
  const [ttl, setTtl] = useState('30');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const ttlNumber = Number(ttl);
  const ttlValid =
    Number.isInteger(ttlNumber) && ttlNumber >= 1 && ttlNumber <= MAX_IMPERSONATION_MINUTES;
  const errors = fieldErrors(problem);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!ttlValid || !organizationId || reason.trim().length < MIN_REASON_LENGTH) return;
    setBusy(true);
    setProblem(null);
    try {
      await api('post', '/api/v1/platform/support/impersonate', {
        body: { organizationId, reason: reason.trim(), ttlMinutes: ttlNumber },
      });
      qc.removeQueries({ predicate: (q) => q.queryKey[0] !== 'auth' });
      await refresh();
      void navigate(`/orgs/${organizationId}/dashboard`);
    } catch (error) {
      setProblem(problemOf(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(e) => void submit(e)} className="space-y-4">
      <SelectField
        label="Organization"
        required
        placeholder="Select…"
        options={organizations.map((o) => ({ value: o.id, label: o.name }))}
        value={organizationId}
        error={errors.organizationId}
        onChange={(e) => setOrganizationId(e.target.value)}
      />
      <TextAreaField
        label="Reason"
        required
        rows={3}
        hint={`At least ${MIN_REASON_LENGTH} characters; recorded in the platform and organization audit logs.`}
        value={reason}
        error={errors.reason}
        onChange={(e) => setReason(e.target.value)}
      />
      <TextField
        label="Duration (minutes)"
        type="number"
        min={1}
        max={MAX_IMPERSONATION_MINUTES}
        required
        value={ttl}
        error={ttlValid ? errors.ttlMinutes : `Between 1 and ${MAX_IMPERSONATION_MINUTES} minutes.`}
        onChange={(e) => setTtl(e.target.value)}
      />
      <p className="text-xs text-subtle">
        While impersonating you cannot create API keys, rotate secrets or change privileged role
        bindings (D-027).
      </p>
      <ProblemAlert problem={problem} />
      <div className="flex justify-end gap-2">
        {onCancel ? <Button onClick={onCancel}>Cancel</Button> : null}
        <Button
          type="submit"
          variant="primary"
          busy={busy}
          disabled={!ttlValid || !organizationId || reason.trim().length < MIN_REASON_LENGTH}
        >
          Start impersonation
        </Button>
      </div>
    </form>
  );
}
