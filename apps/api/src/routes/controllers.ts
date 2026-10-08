/**
 * Vendor hotspot controllers (MULTI_VENDOR_INTEGRATION_PLAN.md §8.2, migration 019):
 * `/api/v1/orgs/{orgId}/controllers` CRUD + `rotate-credential`.
 *
 *  - `credential` is write-only: sealed with `Envelope('ecloud:controller:credential:v1')` into
 *    `credential_secret_ref`; responses only carry `has_credential` (never the ref or the value);
 *    the audit snapshot drops both keys (audit.ts SECRET_KEYS).
 *  - `base_url`: https, no userinfo, no fragment; `cloud` controllers must name a public host
 *    (the webhook rule, shared code in @ecloud/shared); `on_premises` / `embedded` controllers
 *    may live on RFC 1918 / CGNAT-WireGuard / ULA addresses. Loopback, link-local (cloud
 *    metadata), multicast and reserved literals are always refused. The URL is NEVER fetched in
 *    M11 (plan OQ-17), so no DNS resolution happens here.
 *  - `site_id` must be a site of the same organization (assertRef + composite FK in 019).
 *  - rotate-credential is refused while impersonating (D-027) and audited.
 */
import { deploymentModesForAdapter, type DeploymentMode } from '@ecloud/adapters';
import type { DbTransaction } from '@ecloud/db';
import {
  ConflictError,
  NotFoundError,
  ValidationError,
  WebhookTargetError,
  bareHost,
  isLocalhostName,
  isPrivateNetworkAddress,
  isPublicWebhookAddress,
  webhookTarget,
} from '@ecloud/shared';
import { isIP } from 'node:net';
import { sql } from 'kysely';
import { z } from 'zod';
import { writeAudit } from '../audit.js';
import { requestIsImpersonating } from '../auth/middleware.js';
import type { AppDeps } from '../context.js';
import { Envelope, sealSecretRef } from '../crypto.js';
import { OrgIdParams, problemResponses } from '../http/common.js';
import { ImpersonationForbiddenError } from '../http/errors.js';
import { defineRoute, type AnyRouteSpec } from '../http/route.js';
import { assertRef, inTenant, requireOnSite } from '../tenant.js';
import { crudRoutes, loose, type Row } from './crud.js';

export const CONTROLLER_KINDS = ['cloud', 'on_premises', 'embedded'] as const;
export type ControllerKind = (typeof CONTROLLER_KINDS)[number];

export const CONTROLLER_CREDENTIAL_PURPOSE = 'ecloud:controller:credential:v1';

const MAX_BASE_URL = 2048;

/**
 * Validates a controller `base_url` for `kind` and returns its normalised form (`URL.href`).
 * Throws a message string via `Error` on refusal (callers map it to a 400 field error).
 */
export function normalizeControllerBaseUrl(raw: string, kind: ControllerKind): string {
  if (raw.length > MAX_BASE_URL) throw new Error(`base_url is longer than ${String(MAX_BASE_URL)}`);
  if (raw.includes('#')) throw new Error('base_url must not carry a fragment');
  if (kind === 'cloud') {
    try {
      return webhookTarget(raw).href;
    } catch (error) {
      const message = error instanceof WebhookTargetError ? error.message : 'invalid base_url';
      throw new Error(`cloud controller ${message.replace(/^webhook /, '')}`);
    }
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('base_url is not a valid URL');
  }
  if (url.protocol !== 'https:') throw new Error('base_url must use https');
  if (url.username !== '' || url.password !== '') {
    throw new Error('base_url must not carry credentials');
  }
  const host = bareHost(url);
  if (isLocalhostName(host)) {
    throw new Error('base_url host is not allowed');
  }
  if (isIP(host) !== 0 && !isPublicWebhookAddress(host) && !isPrivateNetworkAddress(host)) {
    // loopback, link-local / metadata, multicast, reserved, documentation ranges
    throw new Error('base_url address is neither public nor a private-network address');
  }
  if (url.href.length > MAX_BASE_URL) throw new Error('base_url is too long');
  return url.href;
}

function baseUrlIssue(raw: string, kind: ControllerKind): string | null {
  try {
    normalizeControllerBaseUrl(raw, kind);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : 'invalid base_url';
  }
}

const name = z.string().trim().min(1).max(200);
const vendorKey = z
  .string()
  .regex(/^[a-z][a-z0-9-]{1,63}$/, 'vendor key (see GET /api/v1/vendors)');
const kind = z.enum(CONTROLLER_KINDS);
const baseUrl = z.string().trim().min(1).max(MAX_BASE_URL);
const credential = z.string().min(1).max(4096);

const ControllerCreate = z
  .strictObject({
    site_id: z.uuid().nullable().optional(),
    vendor_key: vendorKey,
    name,
    kind,
    base_url: baseUrl,
    /** Write-only: sealed at rest, never returned. */
    credential: credential.optional(),
    status: z.enum(['active', 'disabled']).optional(),
  })
  .superRefine((value, ctx) => {
    const issue = baseUrlIssue(value.base_url, value.kind);
    if (issue !== null) ctx.addIssue({ code: 'custom', path: ['base_url'], message: issue });
  });

/** Credentials change only through rotate-credential. */
const ControllerUpdate = z.strictObject({
  site_id: z.uuid().nullable().optional(),
  vendor_key: vendorKey.optional(),
  name: name.optional(),
  kind: kind.optional(),
  base_url: baseUrl.optional(),
  status: z.enum(['active', 'disabled']).optional(),
});

const RotateCredentialBody = z.strictObject({ credential });

const ControllerSchema = z
  .looseObject({
    id: z.string(),
    organization_id: z.string(),
    site_id: z.string().nullable(),
    vendor_key: z.string(),
    name: z.string(),
    kind: kind,
    base_url: z.string(),
    has_credential: z.boolean(),
    status: z.string(),
  })
  .meta({
    id: 'Controller',
    description: 'Vendor hotspot controller; the credential is write-only (has_credential only).',
  });

async function assertVendor(trx: DbTransaction, key: string): Promise<void> {
  const vendor = await trx
    .selectFrom('vendors')
    .select('key')
    .where('key', '=', key)
    .executeTakeFirst();
  if (vendor === undefined) {
    throw new ValidationError([
      { path: 'body.vendor_key', message: `unknown vendor ${key} (see GET /api/v1/vendors)` },
    ]);
  }
}

/** Response shape: the sealed credential never leaves the server. */
export function serializeController(row: Row): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries(row)) if (k !== 'credential_secret_ref') out[k] = v;
  out.has_credential = typeof row.credential_secret_ref === 'string';
  return out;
}

/**
 * G9 + site rule shared by NAS and network devices: the controller must exist in this
 * organization (RLS + explicit check) and, when it is bound to a site, to `siteId`.
 */
export async function assertControllerFor(
  trx: DbTransaction,
  controllerId: string,
  siteId: string | null,
  path: string,
): Promise<void> {
  const ref = await assertRef(trx, 'controllers', controllerId, 'controller');
  if (ref.site_id !== null && ref.site_id !== siteId) {
    throw new ValidationError([
      { path, message: 'the controller is bound to another site of this organization' },
    ]);
  }
}

/**
 * Deployment mode of a NAS (migration 019), checked against the registry rows of its engine
 * adapter (`deploymentModes`): defaults to the adapter's only mode, else `native`.
 */
export function resolveDeploymentMode(
  adapterKey: string,
  requested: DeploymentMode | undefined,
): DeploymentMode {
  const allowed = deploymentModesForAdapter(adapterKey);
  if (requested === undefined) return allowed.length === 1 && allowed[0] ? allowed[0] : 'native';
  if (allowed.length > 0 && !allowed.includes(requested)) {
    throw new ValidationError([
      {
        path: 'body.deployment_mode',
        message: `adapter ${adapterKey} supports deployment modes: ${allowed.join(', ')} (compatibility registry)`,
      },
    ]);
  }
  return requested;
}

export function controllerRoutes(deps: AppDeps): AnyRouteSpec[] {
  const envelope = new Envelope(deps.config.dataEncryptionKey, CONTROLLER_CREDENTIAL_PURPOSE);

  const crud = crudRoutes(deps, {
    table: 'controllers',
    path: '/controllers',
    resource: 'controller',
    tag: 'controllers',
    permissions: {
      read: 'controller:read',
      create: 'controller:create',
      update: 'controller:update',
      delete: 'controller:delete',
    },
    siteMode: 'column',
    softDelete: true,
    createSchema: ControllerCreate,
    updateSchema: ControllerUpdate,
    filters: {
      vendor_key: vendorKey.optional(),
      kind: kind.optional(),
      status: z.enum(['active', 'disabled']).optional(),
    },
    serialize: serializeController,
    prepareCreate: async (body, { trx, req }) => {
      // D-027: secret material is never set while impersonating (same rule as rotate).
      if (body.credential !== undefined && requestIsImpersonating(req)) {
        throw new ImpersonationForbiddenError('controller:secret:rotate');
      }
      if (typeof body.site_id === 'string') await assertRef(trx, 'sites', body.site_id, 'site');
      await assertVendor(trx, body.vendor_key as string);
      const { credential: secret, ...rest } = body;
      return {
        ...rest,
        base_url: normalizeControllerBaseUrl(body.base_url as string, body.kind as ControllerKind),
        credential_secret_ref: typeof secret === 'string' ? sealSecretRef(envelope, secret) : null,
      };
    },
    preparePatch: async (body, before, { trx }) => {
      if (typeof body.site_id === 'string') await assertRef(trx, 'sites', body.site_id, 'site');
      if (typeof body.vendor_key === 'string') await assertVendor(trx, body.vendor_key);
      const next: Row = { ...body };
      if (body.base_url !== undefined || body.kind !== undefined) {
        const effectiveKind = (body.kind ?? before.kind) as ControllerKind;
        const effectiveUrl = (body.base_url ?? before.base_url) as string;
        try {
          next.base_url = normalizeControllerBaseUrl(effectiveUrl, effectiveKind);
        } catch (error) {
          throw new ValidationError([
            {
              path: 'body.base_url',
              message: error instanceof Error ? error.message : 'invalid base_url',
            },
          ]);
        }
      }
      // A site-bound controller must stay on the site of every NAS / device that uses it.
      if (body.site_id !== undefined && body.site_id !== null && body.site_id !== before.site_id) {
        const users = await sql<{ n: number }>`
          SELECT (SELECT count(*) FROM nas_clients
                   WHERE controller_id = ${before.id} AND deleted_at IS NULL
                     AND site_id <> ${body.site_id})
               + (SELECT count(*) FROM network_devices
                   WHERE controller_id = ${before.id} AND deleted_at IS NULL
                     AND site_id <> ${body.site_id}) AS n
        `.execute(trx);
        if (Number(users.rows[0]?.n ?? 0) > 0) {
          throw new ConflictError({
            detail: 'NAS clients or network devices of other sites use this controller.',
          });
        }
      }
      return next;
    },
    beforeDelete: async (before, { trx }) => {
      const users = await sql<{ n: number }>`
        SELECT (SELECT count(*) FROM nas_clients
                 WHERE controller_id = ${before.id} AND deleted_at IS NULL)
             + (SELECT count(*) FROM network_devices
                 WHERE controller_id = ${before.id} AND deleted_at IS NULL) AS n
      `.execute(trx);
      if (Number(users.rows[0]?.n ?? 0) > 0) {
        throw new ConflictError({
          detail: 'The controller is still referenced by NAS clients or network devices.',
        });
      }
    },
  });

  // OpenAPI: document the real (credential-free) response shape on the single-item routes.
  for (const route of crud) {
    const status = route.method === 'post' ? 201 : 200;
    const spec = route.responses[status];
    const single = route.method !== 'get' || route.path.endsWith('/:id');
    if (single && spec?.schema !== undefined) {
      route.responses[status] = { ...spec, schema: ControllerSchema };
    }
  }

  const rotate = defineRoute({
    method: 'post',
    path: '/api/v1/orgs/:orgId/controllers/:id/rotate-credential',
    summary:
      'Replace the stored controller credential (write-only; refused while impersonating, D-027)',
    tags: ['controllers'],
    auth: 'principal',
    permission: 'controller:secret:rotate',
    scope: 'any-site',
    params: OrgIdParams,
    body: RotateCredentialBody,
    idempotency: 'required',
    responses: {
      200: {
        description: 'Credential replaced (the value is never returned)',
        schema: z.object({ id: z.string(), has_credential: z.literal(true) }),
      },
      ...problemResponses,
    },
    handler: async ({ params, body, req, ctx }) => {
      if (requestIsImpersonating(req)) {
        throw new ImpersonationForbiddenError('controller:secret:rotate');
      }
      const row = await inTenant(deps, params.orgId, async (trx) => {
        const before = await loose(trx)
          .selectFrom('controllers')
          .select(['id', 'site_id', 'name'])
          .where('id', '=', params.id)
          .where('deleted_at', 'is', null)
          .forUpdate()
          .executeTakeFirst();
        if (before === undefined) throw new NotFoundError('controller', params.id);
        requireOnSite(
          ctx,
          'controller:secret:rotate',
          params.orgId,
          (before.site_id as string | null) ?? null,
          'controller',
          'controller:read',
        );
        await trx
          .updateTable('controllers')
          .set({ credential_secret_ref: sealSecretRef(envelope, body.credential) })
          .where('id', '=', params.id)
          .execute();
        await writeAudit(trx, ctx, {
          organizationId: params.orgId,
          action: 'controller:secret:rotate',
          targetType: 'controller',
          targetId: params.id,
          after: { rotated: true },
        });
        return before;
      });
      return { status: 200, body: { id: row.id, has_credential: true } };
    },
  });

  return [...crud, rotate];
}
