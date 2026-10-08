/**
 * Declarative routes: every public endpoint is defined once with its zod schemas, permission
 * and responses. The same definition mounts the Express handler and feeds the OpenAPI 3.1
 * document (openapi.ts), so an undocumented public route cannot exist.
 */
import { UnauthorizedError, ForbiddenError, type PermissionKey } from '@ecloud/shared';
import express, { type Request, type RequestHandler, type Response, type Router } from 'express';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { type z } from 'zod';
import { assertPermissionKey, evaluate, type AuthzTarget } from '../auth/authorize.js';
import type { AppDeps, RequestContext } from '../context.js';
import { zodToValidationError } from './errors.js';
import { withIdempotency } from './idempotency.js';

export type HttpMethod = 'get' | 'post' | 'patch' | 'delete';

export interface HandlerResult {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
  /** Non-JSON body (e.g. `text/csv`): `body` must then be a string or Buffer, sent verbatim. */
  contentType?: string;
  /**
   * Streamed body (P8-A CSV exports): chunks are written with back-pressure as they are produced.
   * The handler must finish every check (authorization, validation, audit) before returning; an
   * error while streaming can no longer become a problem+json, so the connection is aborted and
   * the error logged (a truncated download fails visibly instead of looking complete).
   */
  stream?: AsyncIterable<string>;
}

export interface HandlerInput<P, Q, B> {
  params: P;
  query: Q;
  body: B;
  req: Request;
  res: Response;
  ctx: RequestContext;
  deps: AppDeps;
}

/** How the route-level authorization pre-check derives its target. */
export type ScopeResolver =
  | 'platform'
  | 'organization'
  | 'any-site'
  /** any binding of the principal that holds the permission (organization-independent reads) */
  | 'any-binding'
  | ((req: Request, params: Record<string, string>) => AuthzTarget);

export interface ResponseSpec {
  description: string;
  schema?: z.ZodType;
  /** Media type of `schema` (default `application/json`). */
  contentType?: string;
}

export interface RouteSpec<
  PS extends z.ZodType = z.ZodType,
  QS extends z.ZodType = z.ZodType,
  BS extends z.ZodType = z.ZodType,
> {
  method: HttpMethod;
  /** Express path with `:param` segments, e.g. `/api/v1/orgs/:orgId/sites/:id`. */
  path: string;
  summary: string;
  tags: string[];
  /** `public`: no principal needed; `principal`: session or API key; `session`: admin cookie only. */
  auth: 'public' | 'principal' | 'session';
  permission?: PermissionKey;
  scope?: ScopeResolver;
  params?: PS;
  query?: QS;
  body?: BS;
  /**
   * Binary request body instead of JSON (e.g. branding uploads): the handler receives the bytes
   * as `req.body` (Buffer). The body is capped at `limitBytes` before the handler runs (413);
   * other content types leave `req.body` undefined and the handler answers 415.
   */
  rawBody?: { contentTypes: readonly string[]; limitBytes: number; description: string };
  /** `required` for non-idempotent POSTs (API_ARCHITECTURE.md §3.1); `optional` otherwise. */
  idempotency?: 'required' | 'optional';
  /** Response fields that are shown once and must not be kept for idempotent replay. */
  secretFields?: readonly string[];
  /** Mutations must write an audit row; set false for self-service endpoints audited elsewhere. */
  audit?: boolean;
  responses: Record<number, ResponseSpec>;
  handler: (
    input: HandlerInput<z.output<PS>, z.output<QS>, z.output<BS>>,
  ) => Promise<HandlerResult>;
}

// The registry stores heterogeneous specs; handlers are invoked with parsed input only.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyRouteSpec = RouteSpec<any, any, any>;

export function defineRoute<PS extends z.ZodType, QS extends z.ZodType, BS extends z.ZodType>(
  spec: RouteSpec<PS, QS, BS>,
): RouteSpec<PS, QS, BS> {
  if (spec.permission !== undefined) assertPermissionKey(spec.permission);
  if (spec.permission !== undefined && spec.scope === undefined) {
    throw new Error(
      `route ${spec.method.toUpperCase()} ${spec.path} has a permission but no scope`,
    );
  }
  return spec;
}

export const isMutation = (method: HttpMethod): boolean => method !== 'get';

function parsePart<S extends z.ZodType>(
  schema: S | undefined,
  value: unknown,
  prefix: string,
): z.output<S> | undefined {
  if (schema === undefined) return undefined;
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw zodToValidationError(parsed.error, prefix);
  return parsed.data;
}

function resolveTarget(
  scope: ScopeResolver,
  req: Request,
  params: Record<string, string>,
): AuthzTarget {
  if (scope === 'platform') return {};
  if (scope === 'organization') return { organizationId: params.orgId ?? null };
  if (scope === 'any-site') return { organizationId: params.orgId ?? null, anySite: true };
  if (scope === 'any-binding') return { anyBinding: true };
  return scope(req, params);
}

/** Authentication and the route-level permission pre-check (runs before any body is read). */
function checkRouteAccess(spec: AnyRouteSpec, req: Request): void {
  const ctx = req.ctx;
  if (spec.auth !== 'public') {
    if (ctx.principal === null) throw new UnauthorizedError();
    if (spec.auth === 'session' && ctx.principal.kind !== 'admin') {
      throw new ForbiddenError({ detail: 'This endpoint requires an administrator session.' });
    }
  }
  if (spec.permission !== undefined && spec.scope !== undefined) {
    const target = resolveTarget(spec.scope, req, req.params as Record<string, string>);
    const memoKey = `${spec.permission}|${target.organizationId ?? ''}|${target.siteId ?? ''}|${String(target.anySite ?? false)}|${String(target.anyBinding ?? false)}`;
    let allowed = ctx.decisions.get(memoKey);
    if (allowed === undefined) {
      allowed = evaluate(ctx.principal, spec.permission, target);
      ctx.decisions.set(memoKey, allowed);
    }
    if (!allowed) {
      throw new ForbiddenError();
    }
  }
}

export function mountRoute(router: Router, deps: AppDeps, spec: AnyRouteSpec): void {
  // Binary bodies are only read once the caller is known to be allowed (no 5 MB buffering for
  // anonymous or unauthorised requests).
  const pre: RequestHandler[] =
    spec.rawBody === undefined
      ? []
      : [
          (req, _res, next) => {
            checkRouteAccess(spec, req);
            next();
          },
          express.raw({ type: [...spec.rawBody.contentTypes], limit: spec.rawBody.limitBytes }),
        ];
  router[spec.method](spec.path, ...pre, async (req: Request, res: Response) => {
    const ctx = req.ctx;
    if (spec.rawBody === undefined) checkRouteAccess(spec, req);
    const rawParams = req.params as Record<string, string>;
    const params: unknown = parsePart(spec.params, rawParams, 'path');
    const query: unknown = parsePart(spec.query, req.query, 'query');
    const body: unknown =
      spec.rawBody === undefined ? parsePart(spec.body, req.body ?? {}, 'body') : undefined;

    const run = () => spec.handler({ params, query, body, req, res, ctx, deps });
    const result =
      spec.method === 'post' && spec.idempotency !== undefined
        ? await withIdempotency(deps, req, spec, run)
        : await run();

    if (isMutation(spec.method) && spec.audit !== false && !ctx.audited && result.status < 300) {
      // A mutation that committed without an audit row is a bug; make it loud in logs/tests.
      req.log.error({ route: `${spec.method.toUpperCase()} ${spec.path}` }, 'mutation not audited');
    }
    for (const [name, value] of Object.entries(result.headers ?? {})) res.setHeader(name, value);
    if (result.stream !== undefined) {
      res.status(result.status);
      if (result.contentType !== undefined) res.type(result.contentType);
      try {
        await pipeline(Readable.from(result.stream), res);
      } catch (err) {
        req.log.error(
          { err, route: `${spec.method.toUpperCase()} ${spec.path}` },
          'stream aborted',
        );
        if (!res.destroyed) res.destroy(err instanceof Error ? err : undefined);
      }
      return;
    }
    if (result.body === undefined) {
      res.status(result.status).end();
    } else if (
      result.contentType !== undefined &&
      (typeof result.body === 'string' || Buffer.isBuffer(result.body))
    ) {
      res.status(result.status).type(result.contentType).send(result.body);
    } else {
      res.status(result.status).json(result.body);
    }
  });
}

/** Converts `/a/:id/b` to the OpenAPI form `/a/{id}/b`. */
export function toOpenApiPath(path: string): string {
  return path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}
