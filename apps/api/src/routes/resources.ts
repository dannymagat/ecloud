/**
 * Tenant resources built on the generic CRUD factory: sites, network devices, NAS clients,
 * subscribers, user groups, client devices, schedules.
 */
import { hashPassword } from '@ecloud/db';
import { ScheduleRuleSchema, isValidTimeZone } from '@ecloud/policy-engine';
import {
  NAS_ADDRESS_RULE,
  NotFoundError,
  ValidationError,
  canonicalNasAddress,
} from '@ecloud/shared';
import type { DbTransaction } from '@ecloud/db';
import { sql } from 'kysely';
import { z } from 'zod';
import { writeAudit } from '../audit.js';
import { requestIsImpersonating } from '../auth/middleware.js';
import type { AppDeps } from '../context.js';
import { Envelope, NAS_SECRET_PURPOSE, randomToken, sealSecretRef } from '../crypto.js';
import { OrgIdParams, ResourceSchema, problemResponses } from '../http/common.js';
import { ImpersonationForbiddenError } from '../http/errors.js';
import { defineRoute, type AnyRouteSpec } from '../http/route.js';
import { assertRef, inTenant, requireOnSite } from '../tenant.js';
import { VENDOR_API_ADAPTER_KEYS } from '@ecloud/vendor-api';
import { resetNasInventoryTrust } from '../vendor-api/trust.js';
import { NAS_ADAPTER_KEYS } from '../nas-adapter.js';
import { releaseGlobalSlots } from '../global-slots.js';
import { softDeleteAccessPointsOf } from './access-points.js';
import { assertControllerFor, resolveDeploymentMode } from './controllers.js';
import { crudRoutes, loose, type Row } from './crud.js';

const MAC_RE = /^([0-9A-Fa-f]{2}[:-]?){5}[0-9A-Fa-f]{2}$/;

/** `aa:bb:cc:dd:ee:ff` (API_ARCHITECTURE.md §3.2 client-devices). */
export function canonicalMac(value: string): string {
  const hex = value.toLowerCase().replace(/[^0-9a-f]/g, '');
  return hex.match(/.{2}/g)?.join(':') ?? hex;
}

const mac = z.string().trim().regex(MAC_RE, 'MAC address').transform(canonicalMac);
const timezone = z
  .string()
  .trim()
  .min(1)
  .refine((tz) => isValidTimeZone(tz), 'IANA time zone');
const slug = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/);
const name = z.string().trim().min(1).max(200);
const optionalText = z.string().trim().max(500).nullable().optional();
const instant = z.iso.datetime({ offset: true }).transform((v) => new Date(v));

// ---------------------------------------------------------------------------------------------

const SiteCreate = z.strictObject({
  slug,
  name,
  timezone: timezone.default('UTC'),
  address: optionalText,
  settings: z.record(z.string(), z.unknown()).optional(),
});
const SiteUpdate = z.strictObject({
  name: name.optional(),
  timezone: timezone.optional(),
  address: optionalText,
  status: z.enum(['active', 'suspended', 'archived']).optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
});

const DEPLOYMENT_MODES = ['native', 'gateway'] as const;

const NetworkDeviceCreate = z.strictObject({
  site_id: z.uuid(),
  serial: z.string().trim().min(1).max(128),
  mac: mac.nullable().optional(),
  model: optionalText,
  firmware: optionalText,
  mode: z.enum(['bridge', 'routed', 'unknown']).optional(),
  adapter_type_key: z
    .string()
    .regex(/^[a-z][a-z0-9_-]{1,63}$/)
    .nullable()
    .optional(),
  /** Migration 019: compatibility-registry references and the managing controller. */
  hardware_model_id: z.uuid().nullable().optional(),
  firmware_version_id: z.uuid().nullable().optional(),
  controller_id: z.uuid().nullable().optional(),
  /** false for third-party APs behind a gateway that ECLOUD does not configure. */
  managed: z.boolean().optional(),
});
const NetworkDeviceUpdate = NetworkDeviceCreate.partial().omit({ serial: true });

const NasCreate = z.strictObject({
  site_id: z.uuid(),
  name,
  /** F-P10-07 review: a single unicast host (no mapped / loopback / link-local / multicast). */
  nas_ip: z
    .union([z.ipv4(), z.ipv6()])
    .refine((ip) => canonicalNasAddress(ip) !== null, { message: NAS_ADDRESS_RULE }),
  nas_identifier: z.string().trim().min(1).max(253).nullable().optional(),
  /** D-035: the @ecloud/adapters key; `adapter_type_key` is derived from it. */
  /**
   * Cycle D: the controller-API / signed-grant keys (UniFi, Omada API mode, Mist) are NAS rows
   * too (AP MAC identity, tenant, site) but are never RADIUS engine adapters (no reply
   * attributes, no CoA; `nasAdapter()` returns null for them).
   */
  adapter_key: z.enum([...NAS_ADAPTER_KEYS, ...VENDOR_API_ADAPTER_KEYS]),
  network_device_id: z.uuid().nullable().optional(),
  coa_port: z.number().int().min(1).max(65535).nullable().optional(),
  coa_supported: z.boolean().nullable().optional(),
  require_message_authenticator: z.boolean().optional(),
  /** Migration 019: defaults from the compatibility registry rows of `adapter_key`. */
  deployment_mode: z.enum(DEPLOYMENT_MODES).optional(),
  /** Migration 019: a controller of the same organization (and of the NAS site when site-bound). */
  controller_id: z.uuid().nullable().optional(),
});
const NasUpdate = NasCreate.partial().extend({ status: z.enum(['active', 'disabled']).optional() });

const AUTH_METHODS = ['password', 'mac', 'voucher', 'idp'] as const;
export const UserCreate = z.strictObject({
  username: z.string().trim().min(1).max(253).regex(/^\S+$/, 'no whitespace'),
  password: z.string().min(8).max(256).optional(),
  site_id: z.uuid().nullable().optional(),
  user_group_id: z.uuid().nullable().optional(),
  display_name: optionalText,
  email: z.email().nullable().optional(),
  phone: z.string().trim().max(32).nullable().optional(),
  status: z.enum(['active', 'suspended', 'expired', 'disabled']).optional(),
  valid_from: instant.nullable().optional(),
  valid_until: instant.nullable().optional(),
  max_devices: z.number().int().positive().nullable().optional(),
  auth_methods: z.array(z.enum(AUTH_METHODS)).min(1).optional(),
});
const UserUpdate = UserCreate.partial().omit({ username: true });

const UserGroupCreate = z.strictObject({
  name,
  description: z.string().trim().max(500).optional(),
  site_id: z.uuid().nullable().optional(),
  is_default: z.boolean().optional(),
});
const UserGroupUpdate = UserGroupCreate.partial();

const ClientDeviceCreate = z.strictObject({
  mac,
  user_id: z.uuid().nullable().optional(),
  name: optionalText,
  device_type: optionalText,
  mac_auth_enabled: z.boolean().optional(),
  blocked: z.boolean().optional(),
});
const ClientDeviceUpdate = ClientDeviceCreate.partial().omit({ mac: true });

const ScheduleCreate = z.strictObject({
  name,
  timezone,
  rules: z.array(ScheduleRuleSchema).min(1).max(50),
});
const ScheduleUpdate = ScheduleCreate.partial();

// ---------------------------------------------------------------------------------------------

/** Effective value of a PATCHed column: the body's when present (null clears), else the row's. */
function patched(body: Row, before: Row, key: string): unknown {
  return body[key] !== undefined ? body[key] : before[key];
}

/** controller_id on PATCH: re-check when the controller or the site changes (G9 + site rule). */
async function assertControllerOnPatch(trx: DbTransaction, body: Row, before: Row): Promise<void> {
  const controllerId = patched(body, before, 'controller_id');
  if (typeof controllerId !== 'string') return;
  if (body.controller_id === undefined && body.site_id === undefined) return;
  await assertControllerFor(
    trx,
    controllerId,
    patched(body, before, 'site_id') as string,
    'body.controller_id',
  );
}

/**
 * Registry references of a network device (019): the model / firmware must exist in the
 * platform mirror and agree with each other; the controller must belong to the organization.
 */
async function assertDeviceRefs(trx: DbTransaction, body: Row, before: Row): Promise<void> {
  const modelId = patched(body, before, 'hardware_model_id');
  const firmwareId = patched(body, before, 'firmware_version_id');
  if (typeof body.hardware_model_id === 'string') {
    const model = await trx
      .selectFrom('hardware_models')
      .select('id')
      .where('id', '=', body.hardware_model_id)
      .executeTakeFirst();
    if (model === undefined) {
      throw new ValidationError([
        { path: 'body.hardware_model_id', message: 'unknown hardware model' },
      ]);
    }
  }
  if (
    typeof firmwareId === 'string' &&
    (body.firmware_version_id !== undefined || body.hardware_model_id !== undefined)
  ) {
    const firmware = await sql<{ hardware_model_id: string | null }>`
      SELECT hardware_model_id FROM firmware_versions WHERE id = ${firmwareId}
    `.execute(trx);
    const row = firmware.rows[0];
    if (row === undefined) {
      throw new ValidationError([
        { path: 'body.firmware_version_id', message: 'unknown firmware version' },
      ]);
    }
    if (row.hardware_model_id !== null && row.hardware_model_id !== modelId) {
      throw new ValidationError([
        {
          path: 'body.firmware_version_id',
          message: 'the firmware version belongs to another hardware model',
        },
      ]);
    }
  }
  await assertControllerOnPatch(trx, body, before);
}

function withoutKeys(row: Row, keys: readonly string[]): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries(row)) if (!keys.includes(k)) out[k] = v;
  return out;
}

export function resourceRoutes(deps: AppDeps): AnyRouteSpec[] {
  const dataEnvelope = new Envelope(deps.config.dataEncryptionKey, NAS_SECRET_PURPOSE);
  const argonMemory = deps.config.base.argon2.memoryKib;

  const sites = crudRoutes(deps, {
    table: 'sites',
    path: '/sites',
    resource: 'site',
    tag: 'sites',
    permissions: {
      read: 'site:read',
      create: 'site:create',
      update: 'site:update',
      delete: 'site:delete',
    },
    siteMode: 'self',
    softDelete: true,
    createSchema: SiteCreate,
    updateSchema: SiteUpdate,
    serialize: (row) => withoutKeys(row, ['geo']),
    prepareCreate: (body) => Promise.resolve({ ...body, settings: body.settings ?? {} }),
    // Review M2: a deleted site frees its globally unique slots (AP MACs, NAS IPs, devices).
    beforeDelete: async (before, { trx, orgId }) => {
      await releaseGlobalSlots(trx, { organizationId: orgId, siteId: before.id as string });
    },
  });

  const networkDevices = crudRoutes(deps, {
    table: 'network_devices',
    path: '/network-devices',
    resource: 'network_device',
    tag: 'network-devices',
    permissions: {
      read: 'network_device:read',
      create: 'network_device:create',
      update: 'network_device:update',
      delete: 'network_device:delete',
    },
    siteMode: 'column',
    softDelete: true,
    createSchema: NetworkDeviceCreate,
    updateSchema: NetworkDeviceUpdate,
    prepareCreate: async (body, { trx }) => {
      await assertRef(trx, 'sites', body.site_id as string, 'site');
      await assertDeviceRefs(trx, body, {});
      return body;
    },
    preparePatch: async (body, before, { trx }) => {
      if (typeof body.site_id === 'string') await assertRef(trx, 'sites', body.site_id, 'site');
      await assertDeviceRefs(trx, body, before);
      return body;
    },
  });

  const nas = crudRoutes(deps, {
    table: 'nas_clients',
    path: '/nas',
    resource: 'nas_client',
    tag: 'nas',
    permissions: {
      read: 'nas:read',
      create: 'nas:create',
      update: 'nas:update',
      delete: 'nas:delete',
    },
    siteMode: 'column',
    softDelete: true,
    createSchema: NasCreate,
    updateSchema: NasUpdate,
    filters: { status: z.enum(['active', 'disabled']).optional() },
    idempotency: 'optional',
    secretFields: ['secret'],
    serialize: (row) => withoutKeys(row, ['secret_ref']),
    prepareCreate: async (body, hook) => {
      await assertRef(hook.trx, 'sites', body.site_id as string, 'site');
      if (typeof body.network_device_id === 'string') {
        await assertRef(hook.trx, 'network_devices', body.network_device_id, 'network_device');
      }
      if (typeof body.controller_id === 'string') {
        await assertControllerFor(
          hook.trx,
          body.controller_id,
          body.site_id as string,
          'body.controller_id',
        );
      }
      const deploymentMode = resolveDeploymentMode(
        body.adapter_key as string,
        body.deployment_mode as 'native' | 'gateway' | undefined,
      );
      // 32 random bytes → 43 base64url chars; RADIUS shared secrets ≤ 128 octets.
      const secret = randomToken(32);
      hook.scratch.secret = secret;
      return {
        ...body,
        deployment_mode: deploymentMode,
        adapter_type_key: body.adapter_key,
        secret_ref: sealSecretRef(dataEnvelope, secret),
      };
    },
    afterCreate: (row, hook) => Promise.resolve({ ...row, secret: hook.scratch.secret }),
    // Cycle A (migration 028): a deleted NAS takes its access points along (frees their MACs).
    beforeDelete: (before, { trx }) => softDeleteAccessPointsOf(trx, before.id as string),
    preparePatch: async (body, before, { trx }) => {
      if (typeof body.site_id === 'string') await assertRef(trx, 'sites', body.site_id, 'site');
      if (typeof body.network_device_id === 'string') {
        await assertRef(trx, 'network_devices', body.network_device_id, 'network_device');
      }
      await assertControllerOnPatch(trx, body, before);
      // Cycle D review F1: APs of a NAS that changes controller lose inventory-based trust.
      if (body.controller_id !== undefined && body.controller_id !== before.controller_id) {
        await resetNasInventoryTrust(trx, before.id as string);
      }
      const next: Row =
        typeof body.adapter_key === 'string'
          ? { ...body, adapter_type_key: body.adapter_key }
          : { ...body };
      if (body.deployment_mode !== undefined || typeof body.adapter_key === 'string') {
        const adapterKey = (body.adapter_key ?? before.adapter_key) as string | null;
        if (adapterKey !== null) {
          if (body.deployment_mode !== undefined) {
            next.deployment_mode = resolveDeploymentMode(
              adapterKey,
              body.deployment_mode as 'native' | 'gateway',
            );
          } else {
            // adapter changed without a mode: keep the current mode when the new adapter allows
            // it, else fall back to the new adapter's default
            try {
              next.deployment_mode = resolveDeploymentMode(
                adapterKey,
                before.deployment_mode as 'native' | 'gateway',
              );
            } catch {
              next.deployment_mode = resolveDeploymentMode(adapterKey, undefined);
            }
          }
        }
      }
      return next;
    },
  });

  const rotateNasSecret = defineRoute({
    method: 'post',
    path: '/api/v1/orgs/:orgId/nas/:id/rotate-secret',
    summary: 'Rotate the RADIUS shared secret of a NAS (returned once)',
    tags: ['nas'],
    auth: 'principal',
    permission: 'nas:secret:rotate',
    scope: 'any-site',
    params: OrgIdParams,
    idempotency: 'required',
    secretFields: ['secret'],
    responses: { 200: { description: 'New secret', schema: ResourceSchema }, ...problemResponses },
    handler: async ({ params, req, ctx }) => {
      if (requestIsImpersonating(req)) throw new ImpersonationForbiddenError('nas:secret:rotate');
      const secret = randomToken(32);
      const row = await inTenant(deps, params.orgId, async (trx) => {
        const before = await loose(trx)
          .selectFrom('nas_clients')
          .select(['id', 'site_id', 'name'])
          .where('id', '=', params.id)
          .where('deleted_at', 'is', null)
          .forUpdate()
          .executeTakeFirst();
        if (before === undefined) throw new NotFoundError('nas_client', params.id);
        requireOnSite(
          ctx,
          'nas:secret:rotate',
          params.orgId,
          before.site_id as string,
          'nas_client',
          'nas:read',
        );
        await trx
          .updateTable('nas_clients')
          .set({ secret_ref: sealSecretRef(dataEnvelope, secret) })
          .where('id', '=', params.id)
          .execute();
        await writeAudit(trx, ctx, {
          organizationId: params.orgId,
          action: 'nas:secret:rotate',
          targetType: 'nas_client',
          targetId: params.id,
          after: { rotated: true },
        });
        return before;
      });
      return { status: 200, body: { id: row.id, secret } };
    },
  });

  const users = crudRoutes(deps, {
    table: 'users',
    path: '/users',
    resource: 'user',
    tag: 'users',
    permissions: {
      read: 'user:read',
      create: 'user:create',
      update: 'user:update',
      delete: 'user:delete',
    },
    siteMode: 'column',
    softDelete: true,
    createSchema: UserCreate,
    updateSchema: UserUpdate,
    filters: {
      status: z.enum(['active', 'suspended', 'expired', 'disabled']).optional(),
      user_group_id: z.uuid().optional(),
    },
    serialize: (row) => withoutKeys(row, ['password_hash']),
    patchPermission: (body, before) => {
      if (body.password !== undefined) return 'user:password:reset';
      if (body.status !== undefined && body.status !== before.status) return 'user:suspend';
      return undefined;
    },
    prepareCreate: async (body, { trx }) => {
      if (typeof body.site_id === 'string') await assertRef(trx, 'sites', body.site_id, 'site');
      if (typeof body.user_group_id === 'string') {
        await assertRef(trx, 'user_groups', body.user_group_id, 'user_group');
      }
      const { password, auth_methods, ...rest } = body;
      return {
        ...rest,
        auth_methods: auth_methods ?? ['password'],
        password_hash:
          typeof password === 'string'
            ? await hashPassword(password, { memoryKib: argonMemory })
            : null,
      };
    },
    preparePatch: async (body, _before, { trx }) => {
      if (typeof body.site_id === 'string') await assertRef(trx, 'sites', body.site_id, 'site');
      if (typeof body.user_group_id === 'string') {
        await assertRef(trx, 'user_groups', body.user_group_id, 'user_group');
      }
      const { password, ...rest } = body;
      return typeof password === 'string'
        ? { ...rest, password_hash: await hashPassword(password, { memoryKib: argonMemory }) }
        : rest;
    },
  });

  const userGroups = crudRoutes(deps, {
    table: 'user_groups',
    path: '/user-groups',
    resource: 'user_group',
    tag: 'user-groups',
    permissions: {
      read: 'user_group:read',
      create: 'user_group:create',
      update: 'user_group:update',
      delete: 'user_group:delete',
    },
    siteMode: 'column',
    softDelete: false,
    createSchema: UserGroupCreate,
    updateSchema: UserGroupUpdate,
    prepareCreate: async (body, { trx }) => {
      if (typeof body.site_id === 'string') await assertRef(trx, 'sites', body.site_id, 'site');
      return body;
    },
    preparePatch: async (body, _before, { trx }) => {
      if (typeof body.site_id === 'string') await assertRef(trx, 'sites', body.site_id, 'site');
      return body;
    },
  });

  const clientDevices = crudRoutes(deps, {
    table: 'client_devices',
    path: '/client-devices',
    resource: 'client_device',
    tag: 'client-devices',
    permissions: {
      read: 'client_device:read',
      create: 'client_device:create',
      update: 'client_device:update',
      delete: 'client_device:delete',
    },
    siteMode: 'none',
    softDelete: true,
    createSchema: ClientDeviceCreate,
    updateSchema: ClientDeviceUpdate,
    filters: { user_id: z.uuid().optional(), mac: mac.optional() },
    patchPermission: (body, before) =>
      body.blocked !== undefined && body.blocked !== before.blocked
        ? 'client_device:block'
        : undefined,
    prepareCreate: async (body, { trx }) => {
      if (typeof body.user_id === 'string') await assertRef(trx, 'users', body.user_id, 'user');
      return body;
    },
    preparePatch: async (body, _before, { trx }) => {
      if (typeof body.user_id === 'string') await assertRef(trx, 'users', body.user_id, 'user');
      return body;
    },
  });

  const schedules = crudRoutes(deps, {
    table: 'schedules',
    path: '/schedules',
    resource: 'schedule',
    tag: 'policies',
    permissions: {
      read: 'policy:read',
      create: 'policy:create',
      update: 'policy:update',
      delete: 'policy:delete',
    },
    siteMode: 'none',
    softDelete: false,
    createSchema: ScheduleCreate,
    updateSchema: ScheduleUpdate,
    prepareCreate: (body) => Promise.resolve({ ...body, rules: JSON.stringify(body.rules) }),
    preparePatch: (body) =>
      Promise.resolve(
        body.rules === undefined ? body : { ...body, rules: JSON.stringify(body.rules) },
      ),
  });

  return [
    ...sites,
    ...networkDevices,
    ...nas,
    rotateNasSecret,
    ...users,
    ...userGroups,
    ...clientDevices,
    ...schedules,
  ];
}
