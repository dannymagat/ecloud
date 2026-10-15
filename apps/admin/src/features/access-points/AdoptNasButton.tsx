/**
 * Adopt & Assign Policy (NAS_PENDING_ADOPTION_REQUIREMENTS.md §7): the action that takes an
 * unadopted NAS and makes it able to serve.
 *
 * Two things this surface deliberately does NOT say.
 *
 * It does not report success. The endpoint answers with the eligibility it derived from the row
 * it just wrote (§7 step 9), so an adopt that closes `NOT_ADOPTED` and leaves `NO_POLICY` open
 * comes back `pending`, and this component repeats the reason that remains instead of showing a
 * tick. "Adopted" and "serving" are different claims and an operator acts on the second.
 *
 * It does not describe the policy as applying to this NAS. `policy_assignments` has no NAS
 * target, so the assignment is SITE-scoped and reaches every NAS at that site. Calling it
 * "assign a policy to this access point" would be a lie with a blast radius.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { BadgeCheck } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { NAS_PENDING_REASON_LABEL } from '@ecloud/shared/nas-eligibility';
import { Dialog } from '../../components/Dialog';
import { ProblemAlert } from '../../components/ProblemAlert';
import { Button, Notice, SelectField } from '../../components/ui';
import { useAuth } from '../../lib/auth';
import { can } from '../../lib/permissions';
import { adoptNas, useAssignablePolicies, type AdoptResult, type OverviewNas } from './data';

/** What the operator is told after the write, from the DERIVED state rather than from HTTP 200. */
function outcomeText(r: AdoptResult): string {
  if (r.state === 'active') {
    return r.policy_source === 'platform_default'
      ? 'Adopted and serving, on the platform default policy — assign your own when you have one.'
      : 'Adopted and serving.';
  }
  const reason = r.primary_reason === null ? null : NAS_PENDING_REASON_LABEL[r.primary_reason];
  return reason === null
    ? `Adopted, but still ${r.state} and not serving new connections.`
    : `Adopted, but still not serving: ${reason}`;
}

export function AdoptNasButton({ orgId, nas }: { orgId: string; nas: OverviewNas }) {
  const { me } = useAuth();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [policyId, setPolicyId] = useState('');
  /** The derived outcome of the last adopt, kept so the operator reads it after the dialog shuts. */
  const [outcome, setOutcome] = useState<string | null>(null);

  const policies = useAssignablePolicies(orgId, nas.site_id, open);

  const adopt = useMutation({
    mutationFn: () =>
      adoptNas(orgId, nas.id, {
        ...(policyId === '' ? {} : { policy_id: policyId }),
        expect_site_id: nas.site_id,
      }),
    onSuccess: (result) => {
      setOutcome(outcomeText(result));
      setOpen(false);
      setPolicyId('');
      // The row's state, reasons and advisories are all server-derived, so the list has to be
      // refetched rather than patched: this component cannot compute the new badge itself.
      void qc.invalidateQueries({ queryKey: ['org', orgId] });
    },
  });

  if (!can(me, 'nas:adopt', { organizationId: orgId, siteId: nas.site_id })) {
    return outcome === null ? null : <span className="text-xs text-subtle">{outcome}</span>;
  }

  const submit = (e: FormEvent) => {
    e.preventDefault();
    adopt.mutate();
  };

  return (
    <>
      <Button
        size="sm"
        variant="primary"
        onClick={() => {
          adopt.reset();
          setOutcome(null);
          setOpen(true);
        }}
      >
        <BadgeCheck aria-hidden="true" className="h-3.5 w-3.5" />
        Adopt
      </Button>
      {outcome === null ? null : (
        <span aria-live="polite" className="text-xs text-subtle">
          {outcome}
        </span>
      )}
      {open ? (
        <Dialog open title={`Adopt ${nas.name}`} onClose={() => setOpen(false)}>
          <form onSubmit={submit} className="space-y-3 text-sm">
            <p>
              Adopting <span className="font-medium">{nas.name}</span> at{' '}
              <span className="font-medium">{nas.site_name}</span> records it as managed by your
              organization and is written to the audit log. It starts serving only once a policy
              also resolves for it.
            </p>
            <SelectField
              label="Policy"
              placeholder={
                policies.isPending ? 'Loading policies…' : 'Use the policy the site already has'
              }
              value={policyId}
              onChange={(e) => setPolicyId(e.target.value)}
              options={policies.data ?? []}
              hint="Leave this alone if the site already has a policy; adoption does not need one here."
            />
            {policyId === '' ? null : (
              <Notice tone="warning" title="This policy applies to the whole site">
                A policy is assigned to a site, never to a single NAS, so this reaches every NAS at{' '}
                {nas.site_name} — not only {nas.name}. Assign it from the Policies page instead if
                that is not what you want.
              </Notice>
            )}
            <ProblemAlert error={adopt.isError ? adopt.error : null} />
            <div className="flex justify-end gap-2">
              <Button onClick={() => setOpen(false)}>Cancel</Button>
              <Button type="submit" variant="primary" busy={adopt.isPending}>
                Adopt
              </Button>
            </div>
          </form>
        </Dialog>
      ) : null}
    </>
  );
}
