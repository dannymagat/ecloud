/**
 * "Configure Access Points" card (D-045): setup progress computed by the API from real data
 * (NAS added → RADIUS secret configured → AP MAC registered → first RADIUS request seen → first
 * successful guest login), help text with "Invite a member" (the administrator invitation flow
 * with a limited role preselected) and "contact us" (PUBLIC_SUPPORT_EMAIL; hidden when unset).
 */
import { CheckCircle2, Circle, Plus, UserPlus } from 'lucide-react';
import { Link } from 'react-router';
import { Button, cx } from '../../components/ui';
import type { Overview } from './data';

/**
 * The role the IT-staff invitation preselects. No role template is limited to network setup:
 * `read_only` is the closest existing template (reads NAS, access points and setup guides; it
 * cannot reveal or rotate secrets). The inviter can change it in the form.
 */
export const IT_STAFF_ROLE_TEMPLATE = 'read_only';

export function inviteHref(orgId: string): string {
  return `/orgs/${encodeURIComponent(orgId)}/administrators?invite=1&invite_role=${IT_STAFF_ROLE_TEMPLATE}`;
}

export function SetupProgressCard({
  orgId,
  overview,
  canInvite,
  canAdd,
  onAdd,
}: {
  orgId: string;
  overview: Overview;
  canInvite: boolean;
  canAdd: boolean;
  onAdd: () => void;
}) {
  const { steps, completed, total } = overview.progress;
  const pct = total === 0 ? 0 : Math.round((completed / total) * 100);
  const next = steps.find((s) => !s.done);
  return (
    <section
      aria-labelledby="configure-ap-heading"
      className="rounded-lg border-2 border-danger/70 bg-surface p-4 shadow-sm sm:p-5"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id="configure-ap-heading" className="text-lg font-semibold tracking-tight">
            Configure Access Points
          </h2>
          <p className="mt-0.5 text-sm text-subtle">
            {completed === total
              ? 'Setup complete: guests have logged in through ECLOUD.'
              : `Next: ${next?.label ?? ''}`}
          </p>
        </div>
        <p className="text-sm font-semibold" data-testid="setup-count">
          {completed} of {total}
        </p>
      </div>

      <div
        role="progressbar"
        aria-label="Setup progress"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={completed}
        aria-valuetext={`${String(completed)} of ${String(total)} steps done`}
        className="mt-3 h-2.5 w-full overflow-hidden rounded-full bg-muted"
      >
        <div
          className="h-full rounded-full bg-danger transition-[width] motion-reduce:transition-none"
          style={{ width: `${String(pct)}%` }}
        />
      </div>

      <ol
        aria-label="Setup steps"
        className="mt-3 grid grid-cols-1 gap-x-4 gap-y-1.5 text-sm sm:grid-cols-2 xl:grid-cols-5"
      >
        {steps.map((s) => (
          <li key={s.key} data-done={s.done} className="flex items-start gap-1.5">
            {s.done ? (
              <CheckCircle2 aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-success" />
            ) : (
              <Circle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-subtle" />
            )}
            <span className={cx(s.done ? 'text-fg' : 'text-subtle')}>
              {s.label}
              <span className="sr-only">{s.done ? ' (done)' : ' (not done yet)'}</span>
            </span>
          </li>
        ))}
      </ol>

      <p className="mt-4 max-w-3xl text-sm">
        To use ECLOUD at your venue, adjust your network settings. Not sure how?{' '}
        {canInvite ? (
          <Link
            to={inviteHref(orgId)}
            className="font-medium text-primary underline underline-offset-2 hover:no-underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
          >
            Invite a member
          </Link>
        ) : (
          'Invite a member'
        )}{' '}
        of your technical team
        {overview.support_email !== null ? (
          <>
            {' '}
            or{' '}
            <a
              href={`mailto:${overview.support_email}`}
              className="font-medium text-primary underline underline-offset-2 hover:no-underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
            >
              contact us
            </a>
          </>
        ) : null}
        .
      </p>

      <div className="mt-4 flex flex-wrap gap-2">
        {canInvite ? (
          <Link
            to={inviteHref(orgId)}
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface px-3.5 py-2 text-sm font-medium text-fg hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          >
            <UserPlus aria-hidden="true" className="h-4 w-4" />
            Invite IT Staff
          </Link>
        ) : null}
        {canAdd ? (
          <Button variant="primary" onClick={onAdd}>
            <Plus aria-hidden="true" className="h-4 w-4" />
            Add Access Point
          </Button>
        ) : null}
      </div>
    </section>
  );
}
