import { api } from '../../api/client';
import type { Page, Row } from '../../api/types';
import { useCursorList } from '../../lib/queries';

export function usePlatformOrganizations(status?: 'active' | 'suspended' | 'archived') {
  return useCursorList<Row>(
    ['platform', 'organizations', status],
    (cursor, signal) =>
      api('get', '/api/v1/platform/organizations', {
        query: { limit: 100, cursor, status },
        signal,
      }) as Promise<Page<Row>>,
  );
}
