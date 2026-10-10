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

/**
 * Cycle A (D-044, migration 028): HKDF purpose of the Envelope that seals
 * `vendor_api_credentials.secret_ref` (data key). A label, not a secret.
 */
export const VENDOR_API_SECRET_PURPOSE = 'ecloud:vendor-api:secret:v1'; // check-no-secrets: allow

/** Controller APIs ECLOUD will call in Cycles D/E (research §2 F5–F8, D-044 Meraki). */
export const VENDOR_API_KINDS = [
  'unifi-network',
  'omada-controller',
  'mist',
  'ruckus-nbi',
  'ruckus-one',
  'meraki-dashboard',
] as const;
export type VendorApiKind = (typeof VENDOR_API_KINDS)[number];

/** The registry vendor a controller must have for each API kind (registry/vendors.ts keys). */
export const VENDOR_API_KIND_VENDOR: Readonly<Record<VendorApiKind, string>> = Object.freeze({
  'unifi-network': 'ubiquiti-unifi',
  'omada-controller': 'tplink-omada',
  mist: 'juniper-mist',
  'ruckus-nbi': 'ruckus',
  'ruckus-one': 'ruckus',
  'meraki-dashboard': 'cisco-meraki',
});

/**
 * Kinds whose documented login needs a user / client id next to the secret (research §3.7:
 * Omada operator name + password). The others authenticate with the secret alone (UniFi API
 * key, Mist token / WLAN API secret, Meraki API key) or are REQUIRES_CLARIFICATION (Ruckus NBI
 * user name), so `username` stays optional for them.
 */
export const VENDOR_API_USERNAME_REQUIRED: readonly VendorApiKind[] = ['omada-controller'];

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
      if (typeof body.vendor_key === 'string' && body.vendor_key !== before.vendor_key) {
        const cred = await trx
          .selectFrom('vendor_api_credentials')
          .select('api_kind')
          .where('controller_id', '=', before.id as string)
          .executeTakeFirst();
        if (cred !== undefined && VENDOR_API_KIND_VENDOR[cred.api_kind] !== body.vendor_key) {
          throw new ConflictError({
            detail: `The controller's API credential (${cred.api_kind}) belongs to another vendor; remove it first.`,
          });
        }
      }
      if (body.kind !== undefined && body.kind !== before.kind) {
        // The credential base_url was validated for the old kind (cloud = public host only).
        const cred = await trx
          .selectFrom('vendor_api_credentials')
          .select('base_url')
          .where('controller_id', '=', before.id as string)
          .executeTakeFirst();
        if (
          cred !== undefined &&
          baseUrlIssue(cred.base_url, body.kind as ControllerKind) !== null
        ) {
          throw new ConflictError({
            detail: 'The API credential base_url is not allowed for the new controller kind.',
          });
        }
      }
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
      // Cycle A: the sealed API credential goes with its controller (hard delete).
      await trx
        .deleteFrom('vendor_api_credentials')
        .where('controller_id', '=', before.id as string)
        .execute();
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

  return [...crud, rotate, ...vendorApiCredentialRoutes(deps)];
}

// ---------------------------------------------------------------------------------------------
// Vendor API credentials (Cycle A, D-044, migration 028)
// ---------------------------------------------------------------------------------------------

const externalId = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9._:-]{1,128}$/, '1-128 of A-Z a-z 0-9 . _ : -')
  .nullable()
  .optional();

/** Write-only set / rotate body: the whole credential is replaced, the secret is required. */
export const VendorApiCredentialBody = z
  .strictObject({
    api_kind: z.enum(VENDOR_API_KINDS),
    base_url: baseUrl,
    /** User / client id / operator name; not secret, returned in metadata. */
    username: z.string().trim().min(1).max(256).nullable().optional(),
    /** Write-only: sealed at rest, never returned, never audited. */
    secret: z.string().min(1).max(4096),
    external_org_id: externalId,
    external_site_id: externalId,
  })
  .superRefine((value, ctx) => {
    if (
      VENDOR_API_USERNAME_REQUIRED.includes(value.api_kind) &&
      (value.username === undefined || value.username === null)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['username'],
        message: `${value.api_kind} needs a username (operator / client id)`,
      });
    }
  });

const VendorApiCredentialSchema = z
  .object({
    controller_id: z.string(),
    api_kind: z.enum(VENDOR_API_KINDS),
    base_url: z.string(),
    username: z.string().nullable(),
    external_org_id: z.string().nullable(),
    external_site_id: z.string().nullable(),
    has_secret: z.literal(true),
    rotated_at: z.string(),
    updated_at: z.string(),
  })
  .meta({
    id: 'VendorApiCredential',
    description: 'Controller API credential metadata; the secret is write-only (never returned).',
  });

interface CredentialRow {
  controller_id: string;
  api_kind: VendorApiKind;
  base_url: string;
  username: string | null;
  external_org_id: string | null;
  external_site_id: string | null;
  rotated_at: Date;
  updated_at: Date;
}

/** Metadata only: `secret_ref` never leaves the server. */
export function serializeVendorApiCredential(row: CredentialRow): Record<string, unknown> {
  return {
    controller_id: row.controller_id,
    api_kind: row.api_kind,
    base_url: row.base_url,
    username: row.username,
    external_org_id: row.external_org_id,
    external_site_id: row.external_site_id,
    has_secret: true,
    rotated_at: row.rotated_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

const CREDENTIAL_COLUMNS = [
  'controller_id',
  'api_kind',
  'base_url',
  'username',
  'external_org_id',
  'external_site_id',
  'rotated_at',
  'updated_at',
] as const;

function vendorApiCredentialRoutes(deps: AppDeps): AnyRouteSpec[] {
  const envelope = new Envelope(deps.config.dataEncryptionKey, VENDOR_API_SECRET_PURPOSE);
  const path = '/api/v1/orgs/:orgId/controllers/:id/api-credential';

  async function lockController(
    trx: DbTransaction,
    id: string,
  ): Promise<{ id: string; site_id: string | null; vendor_key: string; kind: ControllerKind }> {
    const row = await trx
      .selectFrom('controllers')
      .select(['id', 'site_id', 'vendor_key', 'kind'])
      .where('id', '=', id)
      .where('deleted_at', 'is', null)
      .forUpdate()
      .executeTakeFirst();
    if (row === undefined) throw new NotFoundError('controller', id);
    return row;
  }

  const get = defineRoute({
    method: 'get',
    path,
    summary: 'Controller API credential metadata (the secret is never returned)',
    tags: ['controllers'],
    auth: 'principal',
    permission: 'controller:read',
    scope: 'any-site',
    params: OrgIdParams,
    responses: {
      200: { description: 'Credential metadata', schema: VendorApiCredentialSchema },
      ...problemResponses,
    },
    handler: async ({ params, ctx }) => {
      const row = await inTenant(deps, params.orgId, async (trx) => {
        const controller = await trx
          .selectFrom('controllers')
          .select(['id', 'site_id'])
          .where('id', '=', params.id)
          .where('deleted_at', 'is', null)
          .executeTakeFirst();
        if (controller === undefined) throw new NotFoundError('controller', params.id);
        requireOnSite(ctx, 'controller:read', params.orgId, controller.site_id, 'controller');
        return trx
          .selectFrom('vendor_api_credentials')
          .select([...CREDENTIAL_COLUMNS])
          .where('controller_id', '=', params.id)
          .executeTakeFirst();
      });
      if (row === undefined) throw new NotFoundError('vendor_api_credential', params.id);
      return { status: 200, body: serializeVendorApiCredential(row) };
    },
  });

  const set = defineRoute({
    method: 'post',
    path,
    summary:
      'Set or rotate the controller API credential (write-only secret; refused while impersonating, D-027)',
    tags: ['controllers'],
    auth: 'principal',
    permission: 'controller:secret:rotate',
    scope: 'any-site',
    params: OrgIdParams,
    body: VendorApiCredentialBody,
    idempotency: 'required',
    responses: {
      200: { description: 'Credential stored (metadata only)', schema: VendorApiCredentialSchema },
      ...problemResponses,
    },
    handler: async ({ params, body, req, ctx }) => {
      if (requestIsImpersonating(req)) {
        throw new ImpersonationForbiddenError('controller:secret:rotate');
      }
      const row = await inTenant(deps, params.orgId, async (trx) => {
        const controller = await lockController(trx, params.id);
        requireOnSite(
          ctx,
          'controller:secret:rotate',
          params.orgId,
          controller.site_id,
          'controller',
          'controller:read',
        );
        const expectedVendor = VENDOR_API_KIND_VENDOR[body.api_kind];
        if (controller.vendor_key !== expectedVendor) {
          throw new ValidationError([
            {
              path: 'body.api_kind',
              message: `${body.api_kind} needs a controller of vendor ${expectedVendor} (this one is ${controller.vendor_key})`,
            },
          ]);
        }
        let normalizedUrl: string;
        try {
          // Same SSRF guard as the controller URL: cloud = public host only; on-prem / embedded
          // = private-network or public; loopback, link-local, metadata, `localhost.` refused.
          normalizedUrl = normalizeControllerBaseUrl(body.base_url, controller.kind);
        } catch (error) {
          throw new ValidationError([
            {
              path: 'body.base_url',
              message: error instanceof Error ? error.message : 'invalid base_url',
            },
          ]);
        }
        const values = {
          api_kind: body.api_kind,
          base_url: normalizedUrl,
          username: body.username ?? null,
          external_org_id: body.external_org_id ?? null,
          external_site_id: body.external_site_id ?? null,
          secret_ref: sealSecretRef(envelope, body.secret),
          rotated_at: new Date(),
        };
        const existed = await trx
          .selectFrom('vendor_api_credentials')
          .select('id')
          .where('controller_id', '=', params.id)
          .forUpdate()
          .executeTakeFirst();
        const stored =
          existed === undefined
            ? await trx
                .insertInto('vendor_api_credentials')
                .values({ ...values, organization_id: params.orgId, controller_id: params.id })
                .returning([...CREDENTIAL_COLUMNS])
                .executeTakeFirstOrThrow()
            : await trx
                .updateTable('vendor_api_credentials')
                .set(values)
                .where('id', '=', existed.id)
                .returning([...CREDENTIAL_COLUMNS])
                .executeTakeFirstOrThrow();
        // Audit without values: no secret, no username, no external ids.
        await writeAudit(trx, ctx, {
          organizationId: params.orgId,
          action: 'controller:secret:rotate',
          targetType: 'controller',
          targetId: params.id,
          after: {
            api_credential: existed === undefined ? 'set' : 'rotated',
            api_kind: body.api_kind,
            base_url_host: new URL(normalizedUrl).host,
            has_username: values.username !== null,
          },
        });
        return stored;
      });
      return { status: 200, body: serializeVendorApiCredential(row) };
    },
  });

  const remove = defineRoute({
    method: 'delete',
    path,
    summary: 'Remove the controller API credential (refused while impersonating, D-027)',
    tags: ['controllers'],
    auth: 'principal',
    permission: 'controller:secret:rotate',
    scope: 'any-site',
    params: OrgIdParams,
    responses: { 204: { description: 'Removed' }, ...problemResponses },
    handler: async ({ params, req, ctx }) => {
      if (requestIsImpersonating(req)) {
        throw new ImpersonationForbiddenError('controller:secret:rotate');
      }
      await inTenant(deps, params.orgId, async (trx) => {
        const controller = await lockController(trx, params.id);
        requireOnSite(
          ctx,
          'controller:secret:rotate',
          params.orgId,
          controller.site_id,
          'controller',
          'controller:read',
        );
        const deleted = await trx
          .deleteFrom('vendor_api_credentials')
          .where('controller_id', '=', params.id)
          .executeTakeFirst();
        if (Number(deleted.numDeletedRows) === 0) {
          throw new NotFoundError('vendor_api_credential', params.id);
        }
        await writeAudit(trx, ctx, {
          organizationId: params.orgId,
          action: 'controller:secret:rotate',
          targetType: 'controller',
          targetId: params.id,
          after: { api_credential: 'removed' },
        });
      });
      return { status: 204 };
    },
  });

  return [get, set, remove];
}
