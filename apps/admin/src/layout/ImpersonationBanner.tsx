/**
 * D-027: impersonation is always visibly indicated — persistent banner with the target
 * organization, the reason, a live countdown to expiry and a Stop button.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { api } from '../api/client';
import type { Impersonation } from '../api/types';
import { ProblemAlert } from '../components/ProblemAlert';
import { Button } from '../components/ui';
import { useAuth } from '../lib/auth';
import { mmss, useCountdown } from '../lib/useCountdown';

export function ImpersonationBanner({
  impersonation,
  organizationName,
}: {
  impersonation: Impersonation;
  organizationName?: string;
}) {
  const left = useCountdown(impersonation.expires_at);
  const { refresh } = useAuth();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const stop = useMutation({
    mutationFn: () => api('delete', '/api/v1/platform/support/impersonate', {}),
    onSuccess: async () => {
      qc.removeQueries({ predicate: (q) => q.queryKey[0] !== 'auth' });
      await refresh();
      void navigate('/');
    },
  });
  return (
    <div
      role="region"
      aria-label="Impersonation active"
      className="border-b-2 border-warning bg-warning/15 px-4 py-2 text-sm print:hidden"
    >
      <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-4 gap-y-2">
        <p className="font-semibold text-warning">
          Impersonating {organizationName ?? impersonation.organization_id}
        </p>
        <p className="text-fg">
          Reason: <span className="italic">{impersonation.reason || '—'}</span>
        </p>
        <p className="text-fg" aria-live="off">
          {left > 0 ? (
            <>
              Ends in <time dateTime={impersonation.expires_at}>{mmss(left)}</time>
            </>
          ) : (
            'Expired: reload to return to your own session'
          )}
        </p>
        <Button size="sm" variant="danger" busy={stop.isPending} onClick={() => stop.mutate()}>
          Stop impersonation
        </Button>
      </div>
      {stop.error ? (
        <div className="mx-auto mt-2 max-w-7xl">
          <ProblemAlert error={stop.error} />
        </div>
      ) : null}
    </div>
  );
}
