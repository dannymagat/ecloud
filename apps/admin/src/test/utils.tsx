import { QueryClientProvider } from '@tanstack/react-query';
import { render, type RenderResult } from '@testing-library/react';
import type { ReactNode } from 'react';
import { createMemoryRouter, RouterProvider, type RouteObject } from 'react-router';
import { vi } from 'vitest';
import { createQueryClient } from '../App';
import { AuthProvider } from '../lib/auth';

export interface MockRoute {
  method: string;
  path: string | RegExp;
  status?: number;
  body?: unknown;
}

export interface RecordedCall {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

/** Installs a fetch mock answering from `routes` (first match, in order; consumed when `once`). */
export function mockFetch(routes: (MockRoute & { once?: boolean })[]): RecordedCall[] {
  const calls: RecordedCall[] = [];
  const pending = [...routes];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string, init: RequestInit = {}) => {
      const method = (init.method ?? 'GET').toUpperCase();
      const url = String(input);
      const headers = Object.fromEntries(
        Object.entries((init.headers ?? {}) as Record<string, string>),
      );
      calls.push({
        method,
        url,
        headers,
        body: typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
      });
      const index = pending.findIndex(
        (r) =>
          r.method === method &&
          (typeof r.path === 'string' ? url.split('?')[0] === r.path : r.path.test(url)),
      );
      if (index < 0) {
        return Promise.resolve(
          new Response(JSON.stringify({ type: 'about:blank', title: 'Not Found', status: 404 }), {
            status: 404,
            headers: { 'Content-Type': 'application/problem+json' },
          }),
        );
      }
      const route = pending[index]!;
      if (route.once) pending.splice(index, 1);
      const status = route.status ?? 200;
      return Promise.resolve(
        new Response(status === 204 ? null : JSON.stringify(route.body ?? {}), {
          status,
          headers: {
            'Content-Type': status >= 400 ? 'application/problem+json' : 'application/json',
          },
        }),
      );
    }),
  );
  return calls;
}

export function renderRoutes(routes: RouteObject[], initialPath: string): RenderResult {
  const router = createMemoryRouter(routes, { initialEntries: [initialPath] });
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <AuthProvider>
        <RouterProvider router={router} />
      </AuthProvider>
    </QueryClientProvider>,
  );
}

export function withProviders(node: ReactNode): RenderResult {
  return renderRoutes([{ path: '*', element: node }], '/');
}
