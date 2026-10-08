import { useQueries, useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router';
import { api } from '../api/client';
import type { Me, Row } from '../api/types';
import { canPlatform, organizationIdsOf } from './permissions';

export function useOrgId(): string {
  const { orgId } = useParams();
  if (!orgId) throw new Error('route has no :orgId');
  return orgId;
}

export interface OrgOption {
  id: string;
  name: string;
}

/**
 * Organizations for the switcher: ids from /auth/me bindings (names fetched per org), plus the
 * platform list when the principal holds `tenant:list`.
 */
export function useOrganizations(me: Me | null): { options: OrgOption[]; loading: boolean } {
  const ids = organizationIdsOf(me);
  const platform = useQuery({
    queryKey: ['platform', 'organizations', 'switcher'],
    enabled: canPlatform(me, 'tenant:list'),
    queryFn: ({ signal }) =>
      api('get', '/api/v1/platform/organizations', { query: { limit: 200 }, signal }),
  });
  const named = useQueries({
    queries: ids.map((id) => ({
      queryKey: ['org', id, 'self'],
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        api('get', '/api/v1/orgs/{orgId}', { params: { orgId: id }, signal }),
      retry: false,
      staleTime: 300_000,
    })),
  });
  const map = new Map<string, string>();
  for (const row of (platform.data?.data ?? []) as Row[]) {
    map.set(row.id, typeof row.name === 'string' ? row.name : row.id);
  }
  ids.forEach((id, i) => {
    const data = named[i]?.data;
    map.set(id, typeof data?.name === 'string' ? data.name : (map.get(id) ?? id));
  });
  return {
    options: [...map.entries()]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    loading: platform.isLoading || named.some((q) => q.isLoading),
  };
}
