import { useQuery } from '@tanstack/react-query';
import { buildUrl, request } from '../../api/client';
import type { Page, Row } from '../../api/types';
import type { OptionSource } from './form';

/** Loads up to 200 rows of an org collection as select options. */
export function useOptions(orgId: string, source: OptionSource | undefined) {
  return useQuery({
    queryKey: ['org', orgId, 'options', source?.path, source?.query],
    enabled: source !== undefined,
    staleTime: 30_000,
    queryFn: async ({ signal }) => {
      const page = await request<Page<Row>>(
        'get',
        buildUrl(source!.path, { orgId }, { limit: 200, ...(source!.query ?? {}) }),
        { signal, pathTemplate: source!.path },
      );
      return page.data.map((row) => ({ value: row.id, label: source!.label(row) }));
    },
  });
}
