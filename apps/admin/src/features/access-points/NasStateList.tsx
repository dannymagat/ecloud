/**
 * The NAS list with its eligibility state (NAS_PENDING_ADOPTION_REQUIREMENTS.md §5, §6).
 *
 * The access-points page listed AP MAC addresses but never the NAS rows themselves, so a NAS that
 * was unadopted, blocked or missing a policy was invisible — the Pending state had nowhere to
 * appear. This is that surface.
 *
 * Every NAS is listed, not only the Pending ones. A Pending-only panel was considered and
 * rejected: the platform-default advisory belongs on an **Active** row (a NAS working because a
 * fallback caught it, rather than because anyone configured it), and a panel that appears only
 * when something is Pending cannot show it. At the fallback's configured limits no guest
 * complains, so this badge is the only thing between a forgotten access point and months of
 * anonymous access.
 */
import { AlertTriangle } from 'lucide-react';
import {
  NAS_ADVISORY_LABEL,
  NAS_PENDING_REASON_LABEL,
  type NasAdvisory,
  type NasPendingReason,
  type NasState,
} from '@ecloud/shared/nas-eligibility';
import { Badge, type Tone } from '../../components/ui';
import { AdoptNasButton } from './AdoptNasButton';
import type { OverviewNas } from './data';

/**
 * Only `active` is eligible for new access (§5). `pending` is amber rather than red because it is
 * a configuration gap an operator can close, while `blocked` is a decision someone made.
 */
const STATE_TONE: Readonly<Record<NasState, Tone>> = {
  active: 'success',
  pending: 'warning',
  disabled: 'neutral',
  blocked: 'danger',
};

const STATE_LABEL: Readonly<Record<NasState, string>> = {
  active: 'Active',
  pending: 'Pending',
  disabled: 'Disabled',
  blocked: 'Blocked',
};

function reasonText(reason: NasPendingReason | null, blockReason: string | null): string | null {
  if (blockReason !== null) return blockReason;
  return reason === null ? null : NAS_PENDING_REASON_LABEL[reason];
}

export function NasStateList({
  orgId,
  rows,
}: {
  orgId: string;
  rows: readonly OverviewNas[];
}) {
  if (rows.length === 0) return null;
  const pending = rows.filter((n) => n.state !== 'active').length;
  // §6 wants "which of my access points are not serving" answerable by glancing. The count in the
  // heading is that glance; the rows are the detail.
  return (
    <section aria-labelledby="nas-state-heading" className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="nas-state-heading" className="text-base font-semibold">
          Network access servers
        </h2>
        {pending > 0 ? (
          <span className="text-sm text-subtle">
            {pending} of {rows.length} not serving new connections
          </span>
        ) : null}
      </div>
      <ul className="divide-y divide-border rounded-md border border-border" aria-label="NAS state">
        {rows.map((n) => {
          const detail = reasonText(n.primary_reason, n.block_reason);
          return (
            <li key={n.id} className="flex flex-wrap items-center justify-between gap-2 p-2.5">
              <span className="min-w-0">
                <span className="font-medium">{n.name}</span>
                <span className="block text-xs text-subtle">
                  {n.site_name}
                  {detail === null ? '' : ` — ${detail}`}
                </span>
              </span>
              <span className="flex flex-wrap items-center gap-2">
                <Badge tone={STATE_TONE[n.state]}>{STATE_LABEL[n.state]}</Badge>
                {n.advisories.map((a: NasAdvisory) => (
                  // Amber on a green row on purpose: this NAS works, and that is the problem
                  // worth noticing.
                  <Badge key={a} tone="warning" title={NAS_ADVISORY_LABEL[a]}>
                    <AlertTriangle aria-hidden="true" className="mr-1 inline h-3 w-3" />
                    {a === 'ON_PLATFORM_DEFAULT_PORTAL' ? 'Default portal' : 'Default policy'}
                  </Badge>
                ))}
                {/* An `active` row whose policy was never evaluated is "nothing else is wrong",
                    not "fine". Saying so is cheaper than letting someone read it as a clean bill. */}
                {!n.policy_evaluated ? (
                  <Badge title="The policy for this NAS was not evaluated in this response">
                    Policy not checked
                  </Badge>
                ) : null}
                {/* §7: the adopt action belongs on the row that needs it. Mounted only for an
                    unadopted NAS, so an adopted one carries no button to press by mistake —
                    and never on a BLOCKED one: §5 prohibits adopting those, the endpoint
                    refuses with 409, and offering a button that cannot succeed would read as
                    "try again" when the answer is "someone blocked this on purpose". */}
                {!n.is_adopted && n.state !== 'blocked' ? (
                  <AdoptNasButton orgId={orgId} nas={n} />
                ) : null}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
