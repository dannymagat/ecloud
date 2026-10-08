/**
 * Session state from `GET /auth/me` (cookie session, D-029). `me === null` means signed out.
 */
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useMemo, type ReactNode } from 'react';
import { api } from '../api/client';
import { ApiError } from '../api/problem';
import type { Me } from '../api/types';

export const ME_KEY = ['auth', 'me'] as const;

/**
 * Marks the session as gone and drops every cached API response. The `me` query is updated in
 * place (not removed) so the mounted observer sees `null` immediately.
 */
export function signedOut(qc: QueryClient): void {
  qc.setQueryData(ME_KEY, null);
  qc.removeQueries({ predicate: (q) => q.queryKey[0] !== ME_KEY[0] });
}

export async function fetchMe(signal?: AbortSignal): Promise<Me | null> {
  try {
    return (await api('get', '/api/v1/auth/me', { signal })) as unknown as Me;
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return null;
    throw error;
  }
}

interface AuthState {
  me: Me | null;
  loading: boolean;
  error: unknown;
  refresh: () => Promise<Me | null>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: ME_KEY,
    queryFn: ({ signal }) => fetchMe(signal),
    retry: false,
    staleTime: 60_000,
  });

  const refresh = useCallback(async () => {
    const me = await fetchMe();
    qc.setQueryData(ME_KEY, me);
    return me;
  }, [qc]);

  const logout = useCallback(async () => {
    try {
      await api('post', '/api/v1/auth/logout', {});
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 401)) throw error;
    } finally {
      signedOut(qc);
    }
  }, [qc]);

  const value = useMemo<AuthState>(
    () => ({
      me: query.data ?? null,
      loading: query.isPending,
      error: query.error,
      refresh,
      logout,
    }),
    [query.data, query.isPending, query.error, refresh, logout],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}

/** True when the session must (re-)enrol TOTP before it holds any permission. */
export function needsMfaEnrolment(me: Me | null): boolean {
  return !!me && me.kind === 'admin' && (me.mfa.pending || (me.mfa.required && !me.mfa.enrolled));
}
