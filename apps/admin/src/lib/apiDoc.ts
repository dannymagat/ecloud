/**
 * Live OpenAPI document (public `GET /api/v1/openapi.json`). Used for feature detection where
 * the API is still evolving (endpoints planned but not yet deployed, D-035 field rename), so
 * the UI degrades to an explicit "not available" state instead of failing requests.
 */
import { useQuery } from '@tanstack/react-query';
import { request } from '../api/client';

interface OpenApiDoc {
  paths: Record<
    string,
    Record<
      string,
      {
        parameters?: { name?: string; in?: string; schema?: { enum?: string[] } }[];
        requestBody?: { content?: Record<string, { schema?: unknown }> };
      }
    >
  >;
}

export function useApiDocument() {
  return useQuery({
    queryKey: ['openapi'],
    staleTime: Infinity,
    retry: 1,
    queryFn: ({ signal }) => request<OpenApiDoc>('get', '/api/v1/openapi.json', { signal }),
  });
}

export function hasOperation(doc: OpenApiDoc | undefined, method: string, path: string): boolean {
  return doc?.paths[path]?.[method] !== undefined;
}

/** True when the operation declares query parameter `name` (filters the API may not have yet). */
export function hasParameter(
  doc: OpenApiDoc | undefined,
  method: string,
  path: string,
  name: string,
): boolean {
  const params = doc?.paths[path]?.[method]?.parameters ?? [];
  return params.some((p) => p.name === name && (p.in === undefined || p.in === 'query'));
}

export function bodyProperties(
  doc: OpenApiDoc | undefined,
  method: string,
  path: string,
): string[] {
  const schema = doc?.paths[path]?.[method]?.requestBody?.content?.['application/json']?.schema as
    { properties?: Record<string, unknown> } | undefined;
  return Object.keys(schema?.properties ?? {});
}
