import { useInfiniteQuery, type QueryKey } from '@tanstack/react-query';
import type { Page } from '../api/types';

/** Cursor pagination over the API's `{ data, next_cursor }` list envelope. */
export function useCursorList<T>(
  key: QueryKey,
  fetchPage: (cursor: string | undefined, signal: AbortSignal) => Promise<Page<T>>,
  enabled = true,
  options: { refetchInterval?: number | false } = {},
) {
  const query = useInfiniteQuery({
    queryKey: key,
    enabled,
    // Stop polling while the query is in error (403/5xx); a user action or remount retries it.
    refetchInterval: (q: { state: { status: string } }) =>
      q.state.status === 'error' ? false : (options.refetchInterval ?? false),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) => fetchPage(pageParam, signal),
    getNextPageParam: (last) => last.next_cursor ?? undefined,
  });
  const rows = query.data?.pages.flatMap((p) => p.data) ?? [];
  return { ...query, rows };
}
