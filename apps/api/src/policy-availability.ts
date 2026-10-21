/**
 * "Could a policy resolve at this site?" — the NAS-level approximation behind the Pending list's
 * `NO_POLICY` reason (docs/NAS_PENDING_GAP_ANALYSIS.md, settled 2026-10-15).
 *
 * WHY THIS LIVES HERE AND NOT IN THE PENDING LIST. Policy resolution is per SUBJECT: the engine
 * answers for a user, voucher or device, and `no_policy` is what a subject gets when nothing
 * applies to it. A NAS has no policy of its own. So the Pending list needs a different question
 * answered — "is this NAS unusable for everyone" — and the only safe place to answer it is beside
 * the resolution data, because a second implementation of "would a policy resolve" is a second
 * resolution engine, which §2 of the requirement forbids and which is how four portal pickers
 * came to disagree.
 *
 * WHAT IT IS NOT. This is an approximation and the gap analysis says so in the UI copy, not only
 * here: it can report `assigned` while a particular user still gets `no_policy`, because their
 * group has no assignment. That is a subject problem, not a NAS problem, and a NAS-level warning
 * that fired on per-user gaps would be noise inside a week.
 */
import type { DbTransaction } from '@ecloud/db';

/** In precedence order: anything configured wins, then the platform fallback, then nothing. */
export type PolicyAvailability = 'assigned' | 'platform_default' | 'missing';

/**
 * One query for the whole list, so a Pending page costs a constant number of round trips.
 *
 * `assigned` covers BOTH ways a policy reaches a subject here, which is the part a caller writing
 * its own version gets wrong: an applicable `policy_assignments` row, OR an organization default
 * (`policies.is_default`), which `rankCandidates` injects as a synthetic candidate at the
 * `organization_default` layer when no assignment matched. The EZELINK tenant resolves purely by
 * the second route — zero assignments, one default — so testing for assignments alone would
 * report `missing` for a tenant that works.
 *
 * A user-, group- or device-targeted assignment counts, even though it only makes the site usable
 * for THAT subject. The question is whether the NAS is unusable for everyone, and one working
 * subject answers it.
 */
export async function policyAvailabilityForSites(
  trx: DbTransaction,
  siteIds: readonly string[],
  now: Date = new Date(),
): Promise<Map<string, PolicyAvailability>> {
  const out = new Map<string, PolicyAvailability>();
  if (siteIds.length === 0) return out;
  const ids = [...new Set(siteIds)];

  const sites = await trx
    .selectFrom('sites')
    .select(['id', 'organization_id'])
    .where('id', 'in', ids)
    .execute();
  if (sites.length === 0) return out;
  const orgIds = [...new Set(sites.map((s) => s.organization_id))];

  // An assignment counts only while it is live: the engine filters the same window, so an
  // expired assignment that still sat in the table would otherwise read as a working policy.
  const assignments = await trx
    .selectFrom('policy_assignments as a')
    .innerJoin('policies as p', 'p.id', 'a.policy_id')
    .select(['a.organization_id', 'a.site_id', 'a.target_type'])
    .where('a.organization_id', 'in', orgIds)
    .where('p.status', '=', 'active')
    .where('p.deleted_at', 'is', null)
    .where('a.effective_from', '<=', now)
    .where((eb) => eb.or([eb('a.effective_until', 'is', null), eb('a.effective_until', '>', now)]))
    .execute();

  const defaults = await trx
    .selectFrom('policies')
    .select(['organization_id'])
    .where('organization_id', 'in', orgIds)
    .where('is_default', '=', true)
    .where('status', '=', 'active')
    .where('deleted_at', 'is', null)
    .where((eb) => eb.or([eb('valid_from', 'is', null), eb('valid_from', '<=', now)]))
    .where((eb) => eb.or([eb('valid_until', 'is', null), eb('valid_until', '>', now)]))
    .execute();
  const orgHasDefault = new Set(defaults.map((d) => d.organization_id));

  // Absent row means disabled, never an error: the migration deliberately creates no row, so
  // "not configured yet" and "switched off" are the same state and must behave the same.
  const platform = await trx
    .selectFrom('platform_default_policy')
    .select(['enabled'])
    .executeTakeFirst();
  const platformEnabled = platform?.enabled === true;

  // A site-targeted assignment reaches only its own site; every other target type follows the
  // subject, so it can apply at any site in the organization.
  const sitesWithOwnAssignment = new Set(
    assignments.filter((a) => a.target_type === 'site' && a.site_id !== null).map((a) => a.site_id),
  );
  const orgsWithSubjectAssignment = new Set(
    assignments.filter((a) => a.target_type !== 'site').map((a) => a.organization_id),
  );

  for (const site of sites) {
    const assigned =
      sitesWithOwnAssignment.has(site.id) ||
      orgsWithSubjectAssignment.has(site.organization_id) ||
      orgHasDefault.has(site.organization_id);
    out.set(site.id, assigned ? 'assigned' : platformEnabled ? 'platform_default' : 'missing');
  }
  return out;
}
