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
