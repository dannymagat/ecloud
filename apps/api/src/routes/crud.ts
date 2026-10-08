/**
 * Generic tenant CRUD for `/api/v1/orgs/{orgId}/<resource>`: zod-validated bodies, cursor
 * pagination, site-scoped authorization (list = filter, object = 404 when unreadable),
 * If-Match on PATCH, Idempotency-Key on POST, soft delete where the table has `deleted_at`,
 * and one audit row per mutation in the same tenant transaction.
 */
import type { DbTransaction } from '@ecloud/db';
import { NotFoundError, newId, type PermissionKey } from '@ecloud/shared';
import type { Request } from 'express';
import type { Transaction } from 'kysely';
import { z } from 'zod';
import { writeAudit } from '../audit.js';
import { permittedSites } from '../auth/authorize.js';
import type { AppDeps, RequestContext } from '../context.js';
import {
  OrgIdParams,
  OrgParams,
  PageSchema,
  PaginationQuery,
  ResourceSchema,
  checkIfMatch,
  decodeCursor,
  definedOnly,
  etagOf,
  problemResponses,
  toPage,
} from '../http/common.js';
import { defineRoute, type AnyRouteSpec } from '../http/route.js';
import { inTenant, requireOnSite } from '../tenant.js';

/** Untyped view of the schema for the generic factory (tables are fixed per resource). */
type LooseDb = Record<string, Record<string, unknown>>;
export type LooseTrx = Transaction<LooseDb>;
export type Row = Record<string, unknown>;

export function loose(trx: DbTransaction): LooseTrx {
  return trx as unknown as LooseTrx;
}

export type SiteMode =
  /** the row IS a site (`sites`) */
  | 'self'
  /** `site_id` column, nullable = organization-wide object */
  | 'column'
  /** organization-level object: no site */
  | 'none';

export interface CrudHookContext {
  trx: DbTransaction;
  ctx: RequestContext;
  orgId: string;
  req: Request;
  /** Per-request scratch space shared by prepare/after hooks (e.g. a one-time secret). */
  scratch: Record<string, unknown>;
}

export interface CrudConfig {
  table: string;
  /** Path below `/api/v1/orgs/:orgId`, e.g. `/sites`. */
  path: string;
  resource: string;
  tag: string;
  permissions: {
    read: PermissionKey;
    create?: PermissionKey;
    update?: PermissionKey;
    delete?: PermissionKey;
  };
  siteMode: SiteMode;
  softDelete: boolean;
  createSchema?: z.ZodType<Row>;
  updateSchema?: z.ZodType<Row>;
  /** Extra list filters (validated query keys → column equality). */
  filters?: Record<string, z.ZodType>;
  /** Builds the INSERT values (without id / organization_id). May re-check references (G9). */
  prepareCreate?: (body: Row, hook: CrudHookContext) => Promise<Row>;
  /** Builds the UPDATE set. `before` is the locked current row. */
  preparePatch?: (body: Row, before: Row, hook: CrudHookContext) => Promise<Row>;
  /** Extra permission for some PATCH bodies (e.g. `user:suspend` for a status change). */
  patchPermission?: (body: Row, before: Row) => PermissionKey | undefined;
  /** Response shape (drop secrets). */
  serialize?: (row: Row) => Row;
  /** Response fields that are shown once (not stored for idempotent replay). */
  secretFields?: readonly string[];
  /** Post-create hook to add once-only data to the response. */
  afterCreate?: (row: Row, hook: CrudHookContext) => Promise<Row>;
  idempotency?: 'required' | 'optional';
  /** Runs on the locked row before a delete; throw (e.g. 409) to refuse it. */
  beforeDelete?: (before: Row, hook: CrudHookContext) => Promise<void>;
}

function etagHeader(row: Row): Record<string, string> {
  return row.updated_at instanceof Date ? { ETag: etagOf(row.updated_at) } : {};
}

function siteOf(row: Row, mode: SiteMode): string | null {
  if (mode === 'self') return row.id as string;
  if (mode === 'column') return (row.site_id as string | null | undefined) ?? null;
  return null;
}

export function crudRoutes(deps: AppDeps, config: CrudConfig): AnyRouteSpec[] {
  const base = `/api/v1/orgs/:orgId${config.path}`;
  const serialize = config.serialize ?? ((row: Row) => row);
  const tags = [config.tag];
  const routes: AnyRouteSpec[] = [];

  const filterShape: Record<string, z.ZodType> = { ...(config.filters ?? {}) };
  if (config.siteMode === 'column') filterShape.site_id = z.uuid().optional();

  routes.push(
    defineRoute({
      method: 'get',
      path: base,
      summary: `List ${config.resource}s`,
      tags,
      auth: 'principal',
      permission: config.permissions.read,
      scope: config.siteMode === 'none' ? 'organization' : 'any-site',
      params: OrgParams,
      query: PaginationQuery.extend(filterShape),
      responses: {
        200: { description: `${config.resource} page`, schema: PageSchema },
        ...problemResponses,
      },
      handler: async ({ params, query, ctx }) => {
        const q = query as Record<string, unknown> & { limit: number; cursor?: string };
        const sites =
          config.siteMode === 'none'
            ? 'all'
            : permittedSites(ctx.principal, config.permissions.read, params.orgId);
        const cursor = decodeCursor(q.cursor);
        const rows = await inTenant(deps, params.orgId, (trx) => {
          let sel = loose(trx).selectFrom(config.table).selectAll();
          if (config.softDelete) sel = sel.where('deleted_at', 'is', null);
          if (sites !== 'all') {
            if (sites.length === 0) return Promise.resolve([] as Row[]);
            sel = sel.where(config.siteMode === 'self' ? 'id' : 'site_id', 'in', sites);
          }
          for (const key of Object.keys(filterShape)) {
            const value = q[key];
            if (value !== undefined) sel = sel.where(key, '=', value);
          }
          if (typeof cursor === 'string') sel = sel.where('id', '>', cursor);
          return sel
            .orderBy('id')
            .limit(q.limit + 1)
            .execute();
        });
        const page = toPage(rows, q.limit, (r) => r.id as string);
        return { status: 200, body: { ...page, data: page.data.map(serialize) } };
      },
    }),
  );

  routes.push(
    defineRoute({
      method: 'get',
      path: `${base}/:id`,
      summary: `Get a ${config.resource}`,
      tags,
      auth: 'principal',
      permission: config.permissions.read,
      scope: config.siteMode === 'none' ? 'organization' : 'any-site',
      params: OrgIdParams,
      responses: {
        200: { description: config.resource, schema: ResourceSchema },
        ...problemResponses,
      },
      handler: async ({ params, ctx }) => {
        const row = await inTenant(deps, params.orgId, async (trx) => {
          let sel = loose(trx).selectFrom(config.table).selectAll().where('id', '=', params.id);
          if (config.softDelete) sel = sel.where('deleted_at', 'is', null);
          return sel.executeTakeFirst();
        });
        if (row === undefined) throw new NotFoundError(config.resource, params.id);
        requireOnSite(
          ctx,
          config.permissions.read,
          params.orgId,
          siteOf(row, config.siteMode),
          config.resource,
        );
        return {
          status: 200,
          body: serialize(row),
          headers: etagHeader(row),
        };
      },
    }),
  );

  if (config.permissions.create !== undefined && config.createSchema !== undefined) {
    const permission = config.permissions.create;
    routes.push(
      defineRoute({
        method: 'post',
        path: base,
        summary: `Create a ${config.resource}`,
        tags,
        auth: 'principal',
        permission,
        scope: config.siteMode === 'column' ? 'any-site' : 'organization',
        params: OrgParams,
        body: config.createSchema,
        idempotency: config.idempotency ?? 'optional',
        ...(config.secretFields ? { secretFields: config.secretFields } : {}),
        responses: { 201: { description: 'Created', schema: ResourceSchema }, ...problemResponses },
        handler: async ({ params, body, req, ctx }) => {
          const row = await inTenant(deps, params.orgId, async (trx) => {
            const hook: CrudHookContext = { trx, ctx, orgId: params.orgId, req, scratch: {} };
            const values = config.prepareCreate
              ? await config.prepareCreate(body, hook)
              : { ...body };
            if (config.siteMode === 'column') {
              requireOnSite(
                ctx,
                permission,
                params.orgId,
                (values.site_id as string | null | undefined) ?? null,
                config.resource,
              );
            }
            const created = await loose(trx)
              .insertInto(config.table)
              .values({ ...values, id: newId(), organization_id: params.orgId })
              .returningAll()
              .executeTakeFirstOrThrow();
            await writeAudit(trx, ctx, {
              organizationId: params.orgId,
              action: permission,
              targetType: config.resource,
              targetId: created.id as string,
              after: created,
            });
            return config.afterCreate ? config.afterCreate(created, hook) : created;
          });
          return {
            status: 201,
            body: serialize(row),
            headers: etagHeader(row),
          };
        },
      }),
    );
  }

  if (config.permissions.update !== undefined && config.updateSchema !== undefined) {
    const permission = config.permissions.update;
    routes.push(
      defineRoute({
        method: 'patch',
        path: `${base}/:id`,
        summary: `Update a ${config.resource} (If-Match supported)`,
        tags,
        auth: 'principal',
        permission,
        scope: config.siteMode === 'none' ? 'organization' : 'any-site',
        params: OrgIdParams,
        body: config.updateSchema,
        responses: {
          200: { description: 'Updated', schema: ResourceSchema },
          412: { description: 'If-Match mismatch' },
          ...problemResponses,
        },
        handler: async ({ params, body, req, ctx }) => {
          const row = await inTenant(deps, params.orgId, async (trx) => {
            let sel = loose(trx)
              .selectFrom(config.table)
              .selectAll()
              .where('id', '=', params.id)
              .forUpdate();
            if (config.softDelete) sel = sel.where('deleted_at', 'is', null);
            const before = await sel.executeTakeFirst();
            if (before === undefined) throw new NotFoundError(config.resource, params.id);
            const site = siteOf(before, config.siteMode);
            const effective = config.patchPermission?.(body, before) ?? permission;
            requireOnSite(
              ctx,
              effective,
              params.orgId,
              site,
              config.resource,
              config.permissions.read,
            );
            if (effective !== permission) {
              requireOnSite(
                ctx,
                permission,
                params.orgId,
                site,
                config.resource,
                config.permissions.read,
              );
            }
            if (before.updated_at instanceof Date) checkIfMatch(req, before.updated_at);
            const hook: CrudHookContext = { trx, ctx, orgId: params.orgId, req, scratch: {} };
            const set = definedOnly(
              config.preparePatch ? await config.preparePatch(body, before, hook) : { ...body },
            );
            if (config.siteMode === 'column' && 'site_id' in set) {
              requireOnSite(
                ctx,
                permission,
                params.orgId,
                (set.site_id as string | null) ?? null,
                config.resource,
                config.permissions.read,
              );
            }
            const after =
              Object.keys(set).length === 0
                ? before
                : await loose(trx)
                    .updateTable(config.table)
                    .set(set)
                    .where('id', '=', params.id)
                    .returningAll()
                    .executeTakeFirstOrThrow();
            await writeAudit(trx, ctx, {
              organizationId: params.orgId,
              action: effective,
              targetType: config.resource,
              targetId: params.id,
              before,
              after,
            });
            return after;
          });
          return {
            status: 200,
            body: serialize(row),
            headers: etagHeader(row),
          };
        },
      }),
    );
  }

  if (config.permissions.delete !== undefined) {
    const permission = config.permissions.delete;
    routes.push(
      defineRoute({
        method: 'delete',
        path: `${base}/:id`,
        summary: `Delete a ${config.resource}`,
        tags,
        auth: 'principal',
        permission,
        scope:
          config.siteMode === 'none' || config.siteMode === 'self' ? 'organization' : 'any-site',
        params: OrgIdParams,
        responses: { 204: { description: 'Deleted' }, ...problemResponses },
        handler: async ({ params, req, ctx }) => {
          await inTenant(deps, params.orgId, async (trx) => {
            let sel = loose(trx)
              .selectFrom(config.table)
              .selectAll()
              .where('id', '=', params.id)
              .forUpdate();
            if (config.softDelete) sel = sel.where('deleted_at', 'is', null);
            const before = await sel.executeTakeFirst();
            if (before === undefined) throw new NotFoundError(config.resource, params.id);
            requireOnSite(
              ctx,
              permission,
              params.orgId,
              config.siteMode === 'self' ? null : siteOf(before, config.siteMode),
              config.resource,
              config.permissions.read,
            );
            if (config.beforeDelete) {
              await config.beforeDelete(before, {
                trx,
                ctx,
                orgId: params.orgId,
                req,
                scratch: {},
              });
            }
            if (config.softDelete) {
              await loose(trx)
                .updateTable(config.table)
                .set({ deleted_at: new Date() })
                .where('id', '=', params.id)
                .execute();
            } else {
              await loose(trx).deleteFrom(config.table).where('id', '=', params.id).execute();
            }
            await writeAudit(trx, ctx, {
              organizationId: params.orgId,
              action: permission,
              targetType: config.resource,
              targetId: params.id,
              before,
            });
          });
          return { status: 204 };
        },
      }),
    );
  }

  return routes;
}
