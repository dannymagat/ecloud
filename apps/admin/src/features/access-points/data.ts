import type {
  NasAdvisory,
  NasPendingReason,
  NasState,
} from '@ecloud/shared/nas-eligibility';
/**
 * Access Points page data (D-045): the overview payload (`GET …/access-points/overview`), the
 * secret reveal call and the MikroTik downloads. The revealed secret is NEVER put in the
 * TanStack cache: the reveal is a plain mutation (gcTime 0) whose result lives only in the
 * dialog's component state.
 */
import { useQuery } from '@tanstack/react-query';
import { buildUrl, request } from '../../api/client';

export type Activity = 'active' | 'quiet' | 'silent' | 'never';

export interface SetupStep {
  key: 'nas_added' | 'radius_secret' | 'ap_registered' | 'radius_seen' | 'guest_login';
  label: string;
  done: boolean;
}

export interface OverviewNas {
  id: string;
  name: string;
  site_id: string;
  site_name: string;
  adapter_key: string | null;
  vendor_key: string | null;
  vendor_name: string | null;
  nas_ip: string | null;
  status: string;
  has_secret: boolean;
  activity: Activity;
  last_activity_at: string | null;
  access_points: number;
  /** Migration 046 / §5: derived per request; only `active` is eligible for new access. */
  state: NasState;
  pending_reasons: NasPendingReason[];
  primary_reason: NasPendingReason | null;
  advisories: NasAdvisory[];
  /** False while the policy dimension was not evaluated; see nas-eligibility. */
  policy_evaluated: boolean;
  is_adopted: boolean;
  block_reason: string | null;
}

export interface OverviewAccessPoint {
  id: string;
  mac: string;
  name: string | null;
  status: string;
  site_id: string;
  nas_client_id: string;
  nas_name: string;
  adapter_key: string | null;
  vendor_key: string | null;
  vendor_name: string | null;
  verified: boolean;
  verified_at: string | null;
  verification_source: string | null;
  activity: Activity;
  created_at: string;
}

export interface Overview {
  progress: { steps: SetupStep[]; completed: number; total: number };
  support_email: string | null;
  activity_definition: string;
  nas: OverviewNas[];
  access_points: OverviewAccessPoint[];
  truncated: boolean;
}

export const OVERVIEW_PATH = '/api/v1/orgs/{orgId}/access-points/overview';
export const REVEAL_PATH = '/api/v1/orgs/{orgId}/nas/{id}/secret/reveal';
export const SCRIPT_PATH = '/api/v1/orgs/{orgId}/nas/{id}/mikrotik-script';
export const LOGIN_HTML_PATH = '/api/v1/orgs/{orgId}/nas/{id}/mikrotik-login-html';
export const MIKROTIK_ADAPTER = 'mikrotik-hotspot';
export const ADOPT_PATH = '/api/v1/orgs/{orgId}/nas/{id}/adopt';
export const POLICIES_PATH = '/api/v1/orgs/{orgId}/policies';

/** Overview of the organization, or of one site (`?site_id=`). Under ['org', orgId] so CRUD
 * mutations elsewhere (invalidating ['org', orgId]) refresh it. */
export function useOverview(orgId: string, siteId: string | null) {
  return useQuery({
    queryKey: ['org', orgId, 'access-points-overview', siteId],
    retry: false,
    queryFn: ({ signal }) =>
      request<Overview>(
        'get',
        buildUrl(OVERVIEW_PATH, { orgId }, siteId === null ? undefined : { site_id: siteId }),
        { signal, pathTemplate: OVERVIEW_PATH },
      ),
  });
}

/** POST the reveal (`code` only with ADMIN_MFA_MODE=required, D-046); the caller keeps the value in component state only. */
export function revealSecret(orgId: string, nasId: string, code: string | null): Promise<string> {
  return request<{ secret: string }>(
    'post',
    buildUrl(REVEAL_PATH, { orgId, id: nasId }, undefined),
    { body: code === null ? {} : { code }, pathTemplate: REVEAL_PATH },
  ).then((r) => r.secret);
}

/**
 * What `POST …/nas/{id}/adopt` answers with (§7). `state` is DERIVED from the row the call just
 * wrote, so it is not a success flag: an adopt that closes `NOT_ADOPTED` and leaves another
 * reason open comes back `pending` with that reason named.
 */
export interface AdoptResult {
  id: string;
  is_adopted: boolean;
  state: NasState;
  pending_reasons: NasPendingReason[];
  primary_reason: NasPendingReason | null;
  advisories: NasAdvisory[];
  policy_source: 'assigned' | 'platform_default' | 'missing';
  /** Set when this call created a site assignment; names the site it affects. */
  assigned_site_id: string | null;
}

/**
 * Adopt a NAS, optionally creating a policy assignment. `expect_site_id` is the site the caller
 * BELIEVES the NAS is on (§7 step 2): the server refuses if the row disagrees, so a stale list
 * cannot adopt a NAS into a site the operator was not looking at.
 */
export function adoptNas(
  orgId: string,
  nasId: string,
  body: { policy_id?: string; expect_site_id?: string },
): Promise<AdoptResult> {
  return request<AdoptResult>('post', buildUrl(ADOPT_PATH, { orgId, id: nasId }, undefined), {
    body,
    pathTemplate: ADOPT_PATH,
  });
}

/** The fields of a policy row this selector reads; the endpoint returns the whole row. */
interface PolicyOption {
  id: string;
  name: string;
  version: number | null;
  site_id: string | null;
}

/**
 * Policies the adopt endpoint will actually accept for this NAS (§7 step 5): active, and either
 * organization-wide or scoped to this NAS's own site. The list endpoint is org-scoped and
 * returns site policies for every site, and `POST …/adopt` refuses one belonging to another
 * site — so offering those would put guaranteed failures in the dropdown.
 */
export function useAssignablePolicies(orgId: string, siteId: string, enabled: boolean) {
  return useQuery({
    queryKey: ['org', orgId, 'assignable-policies', siteId],
    enabled,
    staleTime: 30_000,
    queryFn: async ({ signal }) => {
      const page = await request<{ data: PolicyOption[] }>(
        'get',
        buildUrl(POLICIES_PATH, { orgId }, { limit: 200, status: 'active' }),
        { signal, pathTemplate: POLICIES_PATH },
      );
      return page.data
        .filter((r) => r.site_id === null || r.site_id === siteId)
        .map((r) => ({
          value: r.id,
          label: `${r.name} (v${String(r.version ?? 1)})${
            r.site_id === null ? '' : ' · this site'
          }`,
        }));
    },
  });
}

export const ACTIVITY_LABEL: Readonly<Record<Activity, string>> = {
  active: 'Active',
  quiet: 'Quiet',
  silent: 'Silent',
  never: 'Never seen',
};

export const ACTIVITY_TONE = {
  active: 'success',
  quiet: 'info',
  silent: 'warning',
  never: 'neutral',
} as const satisfies Record<Activity, 'success' | 'info' | 'warning' | 'neutral'>;
