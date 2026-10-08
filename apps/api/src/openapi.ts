/**
 * OpenAPI 3.1 document generated from the route definitions' zod schemas (zod-openapi).
 */
import {
  createDocument,
  type ZodOpenApiOperationObject,
  type ZodOpenApiPathsObject,
} from 'zod-openapi';
import { z } from 'zod';
import { toOpenApiPath, type AnyRouteSpec } from './http/route.js';

export const OPENAPI_PATH = '/api/v1/openapi.json';

const ProblemSchema = z
  .looseObject({
    type: z.string(),
    title: z.string(),
    status: z.number().int(),
    detail: z.string().optional(),
    instance: z.string().optional(),
    request_id: z.string().optional(),
  })
  .meta({ id: 'Problem', description: 'RFC 9457 problem details' });

/** Routes outside the registry that are still part of the public listener. */
export const STATIC_PUBLIC_ROUTES: readonly { method: string; path: string; summary: string }[] = [
  { method: 'get', path: '/healthz', summary: 'Liveness probe' },
  { method: 'get', path: '/readyz', summary: 'Readiness probe (database, Redis, object storage)' },
  { method: 'get', path: OPENAPI_PATH, summary: 'This OpenAPI document' },
];

function paramsSchema(path: string): z.ZodObject | undefined {
  const names = [...path.matchAll(/:([A-Za-z0-9_]+)/g)].map((m) => m[1] as string);
  if (names.length === 0) return undefined;
  return z.object(Object.fromEntries(names.map((n) => [n, z.string()])));
}

export function buildOpenApiDocument(routes: readonly AnyRouteSpec[], version: string): unknown {
  const paths: ZodOpenApiPathsObject = {};
  for (const route of routes) {
    const path = toOpenApiPath(route.path);
    const pathItem = (paths[path] ??= {});
    const responses: Record<string, object> = {};
    for (const [status, spec] of Object.entries(route.responses)) {
      const isError = Number(status) >= 400;
      responses[status] = {
        description: spec.description,
        ...(spec.schema !== undefined
          ? { content: { [spec.contentType ?? 'application/json']: { schema: spec.schema } } }
          : isError
            ? { content: { 'application/problem+json': { schema: ProblemSchema } } }
            : {}),
      };
    }
    const pathParams = (route.params as z.ZodObject | undefined) ?? paramsSchema(route.path);
    const operation: ZodOpenApiOperationObject = {
      operationId: `${route.method}_${route.path.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '')}`,
      summary: route.summary,
      tags: route.tags,
      ...(route.permission ? { description: `Permission: \`${route.permission}\`` } : {}),
      ...(route.auth === 'public' ? { security: [] } : {}),
      requestParams: {
        ...(pathParams ? { path: pathParams } : {}),
        ...(route.query ? { query: route.query as z.ZodObject } : {}),
        ...(route.method === 'post' && route.idempotency
          ? {
              header: z.object({
                'Idempotency-Key':
                  route.idempotency === 'required' ? z.uuid() : z.uuid().optional(),
              }),
            }
          : {}),
      },
      ...(route.body
        ? { requestBody: { content: { 'application/json': { schema: route.body as z.ZodType } } } }
        : {}),
      ...(route.rawBody
        ? {
            requestBody: {
              required: true,
              description: route.rawBody.description,
              content: Object.fromEntries(
                route.rawBody.contentTypes.map((type) => [
                  type,
                  { schema: { type: 'string', format: 'binary' } },
                ]),
              ),
            },
          }
        : {}),
      responses: responses as ZodOpenApiOperationObject['responses'],
    };
    pathItem[route.method] = operation;
  }
  for (const r of STATIC_PUBLIC_ROUTES) {
    const pathItem = (paths[r.path] ??= {});
    pathItem[r.method as 'get'] = {
      summary: r.summary,
      tags: ['meta'],
      security: [],
      responses: { '200': { description: 'OK' } },
    };
  }
  return createDocument({
    openapi: '3.1.0',
    info: {
      title: 'ECLOUD API',
      version,
      description:
        'ECLOUD admin/integration API. Errors are RFC 9457 application/problem+json. ' +
        'Cookie sessions require Origin + X-Requested-With on mutations; API keys use Bearer.',
    },
    components: {
      securitySchemes: {
        session: { type: 'apiKey', in: 'cookie', name: 'ecloud_sid' },
        apiKey: { type: 'http', scheme: 'bearer', bearerFormat: 'eck_<id>_<secret>' },
      },
    },
    security: [{ session: [] }, { apiKey: [] }],
    paths,
  });
}
